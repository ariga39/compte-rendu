import { randomUUID } from 'node:crypto';
import { basename, join, posix } from 'node:path';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import {
  ConnectionConfig,
  Sandbox,
  SandboxApiException,
  SandboxManager,
  type ReadBytesStream,
} from '@alibaba-group/opensandbox';
import { Option, Schema } from 'effect';
import { executeOpenSandboxCommand } from './opensandbox-execution.js';
import {
  SandboxCreateError,
  type SandboxCommand,
  type SandboxOperation,
  type SandboxRuntimeFactory,
  type RunnerProcessResult,
} from './sandbox-runtime.js';

export interface OpenSandboxRuntimeOptions {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly image: string;
  readonly lifetimeSeconds: number;
}

const success = (): RunnerProcessResult => ({
  exitCode: 0,
  stdout: '',
  timedOut: false,
  truncated: false,
});
const failure = (): RunnerProcessResult => ({
  exitCode: 1,
  stdout: '',
  timedOut: false,
  truncated: false,
});
const EVIDENCE_ROOT = '/tmp/compte-rendu-evidence';
const isMissingSandbox = (error: unknown): boolean =>
  error instanceof SandboxApiException && error.statusCode === 404;
const EvidenceEntry = Schema.Struct({
  path: Schema.NonEmptyString,
  type: Schema.Literals(['file', 'directory']),
});
const IdentityPage = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      id: Schema.NonEmptyString,
      metadata: Schema.Record(Schema.String, Schema.String),
    }),
  ),
  pagination: Schema.Struct({ hasNextPage: Schema.Boolean }),
});

export const createOpenSandboxRuntimeFactory =
  (options: OpenSandboxRuntimeOptions): SandboxRuntimeFactory =>
  (spec) => {
    const owner = randomUUID();
    const connection = new ConnectionConfig({
      domain: options.endpoint,
      apiKey: options.apiKey,
      disableMetrics: true,
    });
    let sandbox: Sandbox | undefined;
    let identity: string | undefined;
    let createAttempted = false;
    let created = false;
    let hostCleanupConfirmed = false;
    const metadata = {
      get created() {
        return created;
      },
      get hostCleanupConfirmed() {
        return hostCleanupConfirmed;
      },
      get id() {
        return identity ?? spec.name;
      },
      name: spec.name,
      runtime: 'opensandbox' as const,
      imageRef: options.image,
      evidenceRoot: EVIDENCE_ROOT,
    };
    const execute = async (
      command: SandboxCommand,
      operation: SandboxOperation,
      label: string,
      stage: 'sandbox' | 'cleanup' = 'sandbox',
    ) => {
      if (command.execute === undefined)
        throw new Error('OpenSandbox requires an SDK execution port');
      return command.execute(operation, { stage, command: label });
    };
    return {
      metadata,
      async setup(command) {
        const result = await execute(
          command,
          async (context) => {
            if (spec.modelTokenFile === undefined)
              throw new Error('OpenSandbox requires LLM service grants');
            const model = new URL(`http://${spec.modelResource}`);
            const port = model.port || '80';
            if (!['80', '443'].includes(port))
              throw new Error('OpenSandbox credential endpoint requires port 80 or 443');
            const modelToken = await readFile(spec.modelTokenFile, 'utf8');
            const environment = Object.fromEntries(
              spec.env.map((pair) => {
                const separator = pair.indexOf('=');
                return [pair.slice(0, separator), pair.slice(separator + 1)];
              }),
            );
            createAttempted = true;
            try {
              sandbox = await Sandbox.create({
                connectionConfig: connection,
                image: options.image,
                timeoutSeconds: options.lifetimeSeconds,
                signal: context.signal,
                skipHealthCheck: true,
                entrypoint: ['sleep', 'infinity'],
                resource: { cpu: spec.cpu, memory: `${spec.memoryGib}Gi` },
                metadata: { 'cr-job-owner': owner, 'cr-job-id': spec.id },
                env: {
                  ...environment,
                  OPENCODE_API_KEY: `cr-${spec.id}`,
                  GH_TOKEN: `cr-${spec.id}`,
                  XDG_CONFIG_HOME: spec.configRoot,
                  XDG_DATA_HOME: `${EVIDENCE_ROOT}/data`,
                  XDG_STATE_HOME: `${EVIDENCE_ROOT}/state`,
                },
                volumes: [
                  {
                    name: 'checkout',
                    host: { path: spec.checkoutRoot },
                    mountPath: spec.checkoutRoot,
                    readOnly: true,
                  },
                  {
                    name: 'config',
                    host: { path: spec.configRoot },
                    mountPath: spec.configRoot,
                    readOnly: true,
                  },
                ],
                networkPolicy: {
                  defaultAction: 'deny',
                  egress: [
                    { action: 'allow', target: model.hostname },
                    { action: 'allow', target: 'api.github.com' },
                  ],
                },
                credentialProxy: { enabled: true },
              });
            } catch {
              throw new SandboxCreateError(false);
            }
            identity = sandbox.id;
            created = true;
            await sandbox.waitUntilReady({
              readyTimeoutSeconds: Math.max(1, (context.timeoutMs ?? 120_000) / 1000),
              pollingIntervalMillis: 250,
              signal: context.signal,
            });
            await sandbox.credentialVault.create({
              credentials: [
                { name: 'model', source: { value: modelToken } },
                { name: 'github', source: { value: spec.githubReadToken } },
              ],
              bindings: [
                {
                  name: 'model',
                  match: {
                    schemes: [port === '443' ? 'https' : 'http'],
                    hosts: [model.hostname],
                    methods: ['GET', 'POST'],
                    paths: ['/v1/*'],
                  },
                  auth: { type: 'bearer', credential: 'model' },
                },
                {
                  name: 'github',
                  match: {
                    schemes: ['https'],
                    hosts: ['api.github.com'],
                    methods: ['GET', 'POST'],
                    paths: ['/*'],
                  },
                  auth: { type: 'bearer', credential: 'github' },
                },
              ],
            });
            return success();
          },
          'create',
        );
        if (result.exitCode !== 0 || result.timedOut) throw new SandboxCreateError(result.timedOut);
      },
      async exec(args, command, processOptions, diagnostic) {
        if (sandbox === undefined || command.execute === undefined) return failure();
        const active = sandbox;
        return command.execute(
          (context) =>
            executeOpenSandboxCommand(active, args, {
              ...context,
              workingDirectory: spec.checkoutRoot,
            }),
          diagnostic,
          processOptions,
        );
      },
      async copyOut(path, destination, command) {
        return execute(
          command,
          async (context) => {
            if (sandbox === undefined) return failure();
            const temporary = `${destination}.${randomUUID()}.tmp`;
            let download: ReadBytesStream | undefined;
            let aborted = context.signal?.aborted === true;
            const closeDownload = async () => {
              try {
                await download?.close();
              } catch {}
            };
            const onAbort = () => {
              aborted = true;
              void closeDownload();
            };
            const cancelled = (): boolean => aborted || context.signal?.aborted === true;
            context.signal?.addEventListener('abort', onAbort, { once: true });
            const active = sandbox;
            try {
              const copy = async (source: string, target: string): Promise<void> => {
                if (cancelled()) throw new Error('copy cancelled');
                const info = Schema.decodeUnknownSync(EvidenceEntry)(
                  (await active.files.getFileInfo([source]))[source],
                );
                if (info.path !== source) throw new Error('invalid evidence identity');
                if (info.type === 'directory') {
                  await mkdir(target, { mode: 0o700 });
                  const entries = Schema.decodeUnknownSync(Schema.Array(EvidenceEntry))(
                    await active.files.listDirectory({ path: source, depth: 1 }),
                  );
                  for (const entry of entries) {
                    if (
                      posix.normalize(entry.path) !== entry.path ||
                      posix.dirname(entry.path) !== source
                    )
                      throw new Error('invalid evidence path');
                    await copy(entry.path, join(target, basename(entry.path)));
                  }
                  return;
                }
                await writeFile(target, '', { mode: 0o600, flag: 'wx' });
                download = (await active.files.readBytesStreamDetailed!(source)).body;
                try {
                  if (cancelled()) throw new Error('copy cancelled');
                  for await (const chunk of download) {
                    if (cancelled()) throw new Error('copy cancelled');
                    await writeFile(target, chunk, { flag: 'a' });
                  }
                } finally {
                  await closeDownload();
                  download = undefined;
                }
              };
              await copy(path, temporary);
              if (cancelled()) return failure();
              await rename(temporary, destination);
              return success();
            } catch {
              return failure();
            } finally {
              context.signal?.removeEventListener('abort', onAbort);
              await closeDownload();
              await rm(temporary, { recursive: true, force: true });
            }
          },
          'copy-evidence',
        );
      },
      async destroy(command) {
        let manager: SandboxManager | undefined;
        try {
          if (!createAttempted && identity === undefined) {
            hostCleanupConfirmed = true;
            return;
          }
          const activeManager = SandboxManager.create({ connectionConfig: connection });
          manager = activeManager;
          const identities = new Set<string>();
          if (identity !== undefined) identities.add(identity);
          const result = await execute(
            command,
            async () => {
              let complete = false;
              for (let page = 1; page <= 20; page += 1) {
                const raw = await activeManager.listSandboxInfos({
                  metadata: { 'cr-job-owner': owner },
                  page,
                  pageSize: 100,
                });
                const decoded = Schema.decodeUnknownOption(IdentityPage)(raw);
                if (Option.isNone(decoded)) return failure();
                for (const found of decoded.value.items) {
                  if (found.metadata['cr-job-owner'] !== owner) return failure();
                  identities.add(found.id);
                }
                if (!decoded.value.pagination.hasNextPage) {
                  complete = true;
                  break;
                }
              }
              if (!complete || (createAttempted && identities.size === 0)) return failure();
              for (const id of identities) {
                let current;
                try {
                  current = await activeManager.getSandboxInfo(id);
                } catch (error) {
                  if (isMissingSandbox(error)) continue;
                  throw error;
                }
                if (current.id !== id || current.metadata?.['cr-job-owner'] !== owner)
                  return failure();
                await activeManager.killSandbox(id);
              }
              return success();
            },
            'remove-sandbox',
            'cleanup',
          );
          if (result.exitCode !== 0 || result.timedOut)
            throw new Error('OpenSandbox cleanup unresolved');
          for (const id of identities) {
            for (const args of [
              ['ps', '-aq', '--filter', `label=opensandbox.io/id=${id}`],
              ['ps', '-aq', '--filter', `label=opensandbox.io/egress-sidecar-for=${id}`],
              ['volume', 'ls', '-q', '--filter', `name=opensandbox-runtime-${id}`],
            ]) {
              const observed = await command(
                args,
                { stage: 'cleanup', command: 'confirm-sandbox-absent' },
                { captureStdout: true, maxBytes: 65536 },
              );
              if (
                observed.exitCode !== 0 ||
                observed.timedOut ||
                observed.truncated ||
                observed.streamError ||
                observed.stdout.trim() !== ''
              )
                throw new Error('OpenSandbox resources remain');
            }
          }
          hostCleanupConfirmed = true;
        } finally {
          await Promise.all([manager?.close(), sandbox?.close(), connection.closeTransport()]);
        }
      },
    };
  };
