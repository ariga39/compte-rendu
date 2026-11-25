import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Option, Schema } from 'effect';
import {
  SandboxCreateError,
  type JobSandbox,
  type OrphanReconcileResult,
  type RunnerDiagnostic,
  type RunnerProcessOptions,
  type RunnerProcessResult,
  type SandboxBackend,
  type SandboxBackendContext,
  type SandboxCleanupConfirmation,
  type SandboxExecPort,
  type SandboxHealth,
  type SandboxJobSpec,
  type SandboxRecoveryFailure,
} from './sandbox-runtime.js';
import {
  SANDBOX_RESOURCE_MAX_AGE_MS,
  sandboxResourceIdentity,
  sweepableSandboxResource,
} from './sandbox-resource-name.js';

type MsbCommand = (
  args: readonly string[],
  diagnostic?: RunnerDiagnostic,
  options?: RunnerProcessOptions,
) => Promise<RunnerProcessResult>;

const evidenceRoot = '/tmp/compte-rendu-evidence';
const inspectedSandbox = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.String,
    created_at: Schema.optional(Schema.String),
  }),
);

// msb launches a local host process. Pass only local runtime settings, and
// explicitly select local execution even on hosts with a saved cloud profile.
const localEnvironment = (): NodeJS.ProcessEnv => ({
  HOME: process.env.HOME,
  PATH: process.env.PATH,
  LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH,
  MSB_HOME: process.env.MSB_HOME,
  XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
  MSB_BACKEND: 'local',
});

const msbOptions = (options?: RunnerProcessOptions): RunnerProcessOptions => ({
  ...options,
  env: { ...localEnvironment(), ...options?.env },
});

const complete = (result: RunnerProcessResult) =>
  !result.timedOut &&
  !result.truncated &&
  !result.stderrTruncated &&
  !result.streamError &&
  !result.processError;

// A fresh local catalog also reports "not found". Bind absence to the file
// used at creation so an instance move or replacement cannot release a job.
export const microsandboxCatalogIdentity = async () => {
  const path = join(process.env.MSB_HOME || join(homedir(), '.microsandbox'), 'db', 'msb.db');
  const file = await stat(path);
  if (!file.isFile()) throw new Error('Microsandbox catalog missing');
  return createHash('sha256')
    .update(JSON.stringify([path, file.dev, file.ino, file.birthtimeMs]))
    .digest('hex');
};

const inspect = async (command: MsbCommand, name: string, catalog: string | undefined) => {
  if (!catalog || catalog !== (await microsandboxCatalogIdentity()))
    throw new Error('Microsandbox catalog changed');
  const result = await command(
    ['inspect', '--format', 'json', name],
    { stage: 'cleanup', command: 'inspect-sandbox' },
    { env: localEnvironment(), captureStdout: true, captureStderr: true, maxBytes: 256 * 1024 },
  );
  if (catalog !== (await microsandboxCatalogIdentity()) || !complete(result))
    throw new Error('Incomplete microsandbox inspection');
  if (result.exitCode === 1 && result.stderr?.trim() === `error: sandbox not found: ${name}`)
    return undefined;
  if (result.exitCode !== 0) throw new Error('Microsandbox inspection failed');
  const entry = Schema.decodeUnknownSync(inspectedSandbox)(result.stdout);
  if (entry.name !== name) throw new Error('Microsandbox identity mismatch');
  return entry;
};

const confirmMicrosandboxAbsent = async (
  command: MsbCommand,
  name: string,
  catalog: string | undefined,
) => {
  if ((await inspect(command, name, catalog)) !== undefined)
    throw new Error('Microsandbox still present');
};

const createMicrosandboxJobSandbox = (
  program: string,
  image: string,
  allowFakeIp: boolean,
  backendCommand: MsbCommand,
  spec: SandboxJobSpec,
): JobSandbox => {
  const { name } = spec;
  let catalog: string | undefined;
  let created = false;
  let closed = false;
  let githubToken = spec.githubReadToken;
  let creating: Promise<void> | undefined;
  let rotation: Promise<RunnerProcessResult> | undefined;
  const commandFor = (exec: SandboxExecPort): MsbCommand => {
    return (args, diagnostic, options) => exec.run(program, args, msbOptions(options), diagnostic);
  };
  const create = async (command: MsbCommand) => {
    const host = spec.modelResource.split(':')[0]!;
    if (
      !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/i.test(host) ||
      host === 'api.github.com' ||
      spec.modelResource !== host + ':443'
    )
      throw new Error('Microsandbox requires a dedicated HTTPS grant endpoint on port 443');
    const model = await readFile(spec.modelTokenFile, 'utf8');
    const env = [
      ...spec.env,
      'NODE_EXTRA_CA_CERTS=/.msb/tls/ca.pem',
      `XDG_CONFIG_HOME=${spec.configRoot}`,
      `XDG_DATA_HOME=${evidenceRoot}/data`,
      `XDG_STATE_HOME=${evidenceRoot}/state`,
    ];
    catalog = await microsandboxCatalogIdentity();
    const result = await command(
      [
        'create',
        '--name',
        name,
        '--pull',
        'never',
        '--security',
        'restricted',
        '--deployment-profile',
        allowFakeIp ? 'single-tenant' : 'multi-tenant',
        ...(allowFakeIp ? ['--no-dns-rebind-protection'] : []),
        '--max-tcp-connections',
        '1024',
        '--max-udp-connections',
        '1024',
        '--max-duration',
        '2h',
        '--cpus',
        spec.cpu,
        '--memory',
        `${spec.memoryGib}G`,
        '--mount-dir',
        `${spec.checkoutRoot}:${spec.checkoutRoot}:ro,uid=1000,gid=1000`,
        '--mount-dir',
        `${spec.configRoot}:${spec.configRoot}:ro,uid=1000,gid=1000`,
        '--net-default',
        'deny',
        '--net-rule',
        `allow@${host}:tcp:443,allow@api.github.com:tcp:443`,
        '--tls-intercept',
        '--secret',
        `OPENCODE_API_KEY:headers=authorization@${host}`,
        '--secret',
        'GH_TOKEN:headers=authorization@api.github.com',
        ...env.flatMap((pair) => ['--env', pair]),
        image,
      ],
      { stage: 'sandbox', command: 'create' },
      { env: { ...localEnvironment(), OPENCODE_API_KEY: model, GH_TOKEN: githubToken } },
    );
    if (result.exitCode !== 0 || !complete(result)) throw new SandboxCreateError(result.timedOut);
    created = true;
  };
  return {
    metadata: {
      runtime: 'microsandbox',
      name,
      id: name,
      imageRef: image,
      evidenceRoot,
      get recoveryProof() {
        return catalog === undefined ? undefined : { catalogIdentity: catalog };
      },
      get created() {
        return created;
      },
      hostCleanupConfirmed: true,
    },
    setup(exec) {
      creating = create(commandFor(exec));
      return creating;
    },
    exec(args, exec, options, diagnostic) {
      return commandFor(exec)(
        [
          'exec',
          '--no-tty',
          '--no-stdin',
          '--user',
          '1000',
          '--workdir',
          spec.checkoutRoot,
          name,
          '--',
          ...args,
        ],
        diagnostic,
        options,
      );
    },
    copyOut(path, destination, exec, diagnostic, options) {
      return commandFor(exec)(['cp', `${name}:${path}`, destination], diagnostic, options);
    },
    async updateGithubReadToken(token) {
      githubToken = token;
      if (!creating) return;
      await creating;
      if (closed) throw new Error('Microsandbox is closing');
      rotation = backendCommand(
        ['modify', name, '--secret', 'GH_TOKEN@api.github.com'],
        undefined,
        { env: { GH_TOKEN: token }, timeoutMs: 30_000 },
      );
      const result = await rotation;
      if (result.exitCode !== 0 || !complete(result))
        throw new Error('Microsandbox token update failed');
    },
    async destroy(exec) {
      const command = commandFor(exec);
      closed = true;
      await rotation?.catch(() => undefined);
      if (catalog === undefined) return;
      const existing = await inspect(command, name, catalog);
      if (!existing) return;
      const removed = await command(['rm', '-f', name], {
        stage: 'cleanup',
        command: 'remove-sandbox',
      });
      if (removed.exitCode !== 0 || !complete(removed))
        throw new Error('Microsandbox removal failed');
      await confirmMicrosandboxAbsent(command, name, catalog);
    },
  };
};

interface MicrosandboxSandboxBackendOptions extends SandboxBackendContext {
  /** Overrides are for tests and explicit embedding; production reads the environment. */
  readonly image?: string | undefined;
  readonly allowFakeIp?: boolean | undefined;
}

const nonEmpty = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
};

export const createMicrosandboxSandboxBackend = (
  options: MicrosandboxSandboxBackendOptions,
): SandboxBackend => {
  const image = nonEmpty(options.image) ?? nonEmpty(process.env.MICROSANDBOX_IMAGE);
  if (image === undefined) throw new Error('Microsandbox requires MICROSANDBOX_IMAGE');
  const program = nonEmpty(process.env.RUNNER_SANDBOX_CLI) ?? 'msb';
  const allowFakeIp = options.allowFakeIp ?? process.env.MICROSANDBOX_ALLOW_FAKE_IP === '1';
  let health: SandboxHealth = 'unready';
  let retryAt = 0;
  const backendCommand: MsbCommand = (args, diagnostic, processOptions) =>
    options.hostRun(program, args, msbOptions(processOptions), diagnostic);
  const checkReady = async (): Promise<SandboxHealth> => {
    if (health === 'ready') return 'ready';
    if (Date.now() < retryAt) return 'unready';
    try {
      const host = await backendCommand(['doctor'], undefined, { timeoutMs: 30 * 1000 });
      if (host.exitCode !== 0 || !complete(host)) throw new Error('microsandbox doctor failed');
      const cached = await backendCommand(['image', 'inspect', image], undefined, {
        timeoutMs: 30 * 1000,
      });
      if (cached.exitCode !== 0 || !complete(cached)) throw new Error('microsandbox image missing');
      health = 'ready';
      retryAt = 0;
      return 'ready';
    } catch {
      health = 'unready';
      retryAt = Date.now() + 30_000;
      return 'unready';
    }
  };
  return {
    kind: 'microsandbox',
    health: () => health,
    checkReady,
    async reconcileOrphans({ isLiveJob, only }): Promise<OrphanReconcileResult> {
      return reconcileMicrosandboxResources(backendCommand, isLiveJob, only);
    },
    async confirmCleanupAbsent(input: SandboxCleanupConfirmation): Promise<void> {
      await confirmMicrosandboxAbsent(
        backendCommand,
        input.sandboxName,
        input.recoveryProof?.catalogIdentity,
      );
    },
    createJob(spec: SandboxJobSpec): JobSandbox {
      return createMicrosandboxJobSandbox(program, image, allowFakeIp, backendCommand, spec);
    },
  };
};

const MAX_LISTING_BYTES = 256 * 1024;
const SandboxListing = Schema.Array(
  Schema.Struct({
    name: Schema.NonEmptyString,
    created_at: Schema.optional(Schema.String),
  }),
);

const listMicrosandboxNames = async (
  command: MsbCommand,
): Promise<
  | { readonly ok: true; readonly names: readonly string[] }
  | { readonly ok: false; readonly result: RunnerProcessResult }
> => {
  const listed = await command(
    ['ls', '--format', 'json'],
    { stage: 'cleanup', command: 'list-sandboxes' },
    {
      env: localEnvironment(),
      captureStdout: true,
      captureStderr: true,
      maxBytes: MAX_LISTING_BYTES,
    },
  );
  if (!complete(listed) || listed.exitCode !== 0) return { ok: false, result: listed };
  const entries = Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.fromJsonString(SandboxListing))(listed.stdout),
  );
  return entries === undefined
    ? { ok: false, result: listed }
    : { ok: true, names: entries.map((entry) => entry.name) };
};

const removeMicrosandbox = async (
  command: MsbCommand,
  sandboxName: string,
  catalog: string,
): Promise<void> => {
  // Another Runner may remove the same expired VM between our inspect and rm.
  // The removal command's exit status is not absence proof; the final exact
  // inspection in the same catalog decides. A present VM or an invalid,
  // truncated or unavailable inspection still fails.
  await command(
    ['rm', '-f', sandboxName],
    { stage: 'cleanup', command: 'remove-sandbox' },
    { env: localEnvironment() },
  ).catch(() => undefined);
  await confirmMicrosandboxAbsent(command, sandboxName, catalog);
};

const removeExactMicrosandbox = async (
  command: MsbCommand,
  sandboxName: string,
  catalog: string,
): Promise<void> => {
  if ((await inspect(command, sandboxName, catalog)) === undefined) return;
  await removeMicrosandbox(command, sandboxName, catalog);
};

const reconcileMicrosandboxResources = async (
  command: MsbCommand,
  isLive: (jobId: string) => boolean = () => false,
  only?: {
    readonly jobId: string;
    readonly sandboxName: string;
    readonly recoveryProof?: Readonly<Record<string, string>> | undefined;
  },
): Promise<OrphanReconcileResult> => {
  if (only !== undefined) {
    const identity = sandboxResourceIdentity(only.sandboxName);
    if (identity === undefined || identity.jobId !== only.jobId)
      return {
        ok: false,
        recovered: 0,
        recoveredJobIds: [],
        failures: [{ jobId: only.jobId, sandboxName: only.sandboxName, step: 'identity' }],
      };
    const catalog = only.recoveryProof?.catalogIdentity;
    if (catalog === undefined)
      return {
        ok: false,
        recovered: 0,
        recoveredJobIds: [],
        failures: [{ jobId: only.jobId, sandboxName: only.sandboxName, step: 'catalog' }],
      };
    try {
      if ((await microsandboxCatalogIdentity()) !== catalog)
        throw new Error('Microsandbox catalog changed');
      await removeExactMicrosandbox(command, only.sandboxName, catalog);
      return { ok: true, recovered: 1, recoveredJobIds: [only.jobId], failures: [] };
    } catch (error) {
      return {
        ok: false,
        recovered: 0,
        recoveredJobIds: [],
        failures: [
          {
            jobId: only.jobId,
            sandboxName: only.sandboxName,
            step:
              error instanceof Error && error.message === 'Microsandbox still present'
                ? 'sandbox-present'
                : 'remove',
          },
        ],
      };
    }
  }

  const names = await listMicrosandboxNames(command);
  if (!names.ok)
    return {
      ok: false,
      recovered: 0,
      recoveredJobIds: [],
      failures: [{ jobId: 'redacted', sandboxName: 'redacted', step: 'list' }],
    };
  let catalog: string;
  try {
    catalog = await microsandboxCatalogIdentity();
  } catch {
    return {
      ok: false,
      recovered: 0,
      recoveredJobIds: [],
      failures: [{ jobId: 'redacted', sandboxName: 'redacted', step: 'catalog' }],
    };
  }
  const now = Date.now();
  let recovered = 0;
  const recoveredJobIds: string[] = [];
  const failures: SandboxRecoveryFailure[] = [];
  for (const sandboxName of names.names) {
    const identity = sandboxResourceIdentity(sandboxName);
    if (identity === undefined || !sweepableSandboxResource(sandboxName, now)) continue;
    if (isLive(identity.jobId)) continue;
    try {
      const existing = await inspect(command, sandboxName, catalog);
      if (existing === undefined) continue;
      if (existing.created_at !== undefined) {
        const createdAt = Date.parse(existing.created_at);
        if (!Number.isFinite(createdAt) || now - createdAt < SANDBOX_RESOURCE_MAX_AGE_MS) continue;
      }
      await removeMicrosandbox(command, sandboxName, catalog);
      recovered += 1;
      recoveredJobIds.push(identity.jobId);
    } catch (error) {
      failures.push({
        jobId: identity.jobId,
        sandboxName,
        step:
          error instanceof Error && error.message === 'Microsandbox still present'
            ? 'sandbox-present'
            : 'remove',
      });
    }
  }
  return { ok: failures.length === 0, recovered, recoveredJobIds, failures };
};
