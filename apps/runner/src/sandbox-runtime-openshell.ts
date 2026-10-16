import { createHash, randomUUID } from 'node:crypto';
import { Option, Schema } from 'effect';
import type {
  JobSandboxRuntime,
  OpenShellRuntimeConfig,
  RunnerDiagnostic,
  RunnerProcessOptions,
  RunnerProcessResult,
  SandboxCommand,
  SandboxJobSpec,
  SandboxRuntimeFactory,
} from './sandbox-runtime.js';
import { SandboxCreateError } from './sandbox-runtime.js';

const OS_ROOT = '/workspace';
const OS_CHECKOUT = `${OS_ROOT}/checkout`;
const OS_CONFIG = `${OS_ROOT}/config`;
const OS_EVIDENCE = `${OS_ROOT}/evidence`;
const DELETE_TIMEOUT_MS_DEFAULT = 60 * 1000;
const POLL_INTERVAL_MS = 250;
const MAX_SANDBOX_JSON_BYTES = 256 * 1024;

const resolveDeleteTimeoutMs = (): number => {
  const raw = Number.parseInt(process.env.OPENSHELL_DELETE_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DELETE_TIMEOUT_MS_DEFAULT;
};

const OpenShellSandboxIdentity = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

const OpenShellProviderPage = Schema.Struct({
  providers: Schema.Array(
    Schema.Struct({
      id: Schema.NonEmptyString,
      name: Schema.NonEmptyString,
      labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    }),
  ),
  next_page_token: Schema.String,
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const identityFromStdout = (
  stdout: string,
): { readonly id: string; readonly name: string; readonly owner?: string } | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const decoded = Option.getOrUndefined(
    Schema.decodeUnknownOption(OpenShellSandboxIdentity)(parsed),
  );
  if (decoded === undefined) return undefined;
  return {
    id: decoded.id,
    name: decoded.name,
    ...(decoded.labels?.['cr-job-owner'] === undefined
      ? {}
      : { owner: decoded.labels['cr-job-owner'] }),
  };
};

type SandboxLookup =
  | {
      readonly kind: 'present';
      readonly id: string;
      readonly name: string;
      readonly owner?: string;
    }
  | { readonly kind: 'gone' }
  | { readonly kind: 'error' };

const buildGatewayFlags = (config: OpenShellRuntimeConfig): string[] => {
  const flags: string[] = [];
  if (config.gateway !== undefined) flags.push('--gateway', config.gateway);
  else if (config.gatewayEndpoint !== undefined) {
    flags.push('--gateway-endpoint', config.gatewayEndpoint);
  }
  if (config.insecure) flags.push('--gateway-insecure');
  return flags;
};

const listProviders = async (
  command: SandboxCommand,
  gatewayFlags: readonly string[],
  stage: RunnerDiagnostic['stage'],
): Promise<
  Array<{ readonly id: string; readonly name: string; readonly owner?: string }> | undefined
> => {
  const entries: Array<{ id: string; name: string; owner?: string }> = [];
  let token = '';
  for (let page = 0; page < 20; page += 1) {
    const listed = await command(
      [
        ...gatewayFlags,
        'provider',
        'list',
        '--output',
        'json',
        ...(token.length === 0 ? [] : ['--page-token', token]),
      ],
      { stage, command: 'list-providers', includeStderr: true },
      { captureStdout: true, maxBytes: MAX_SANDBOX_JSON_BYTES },
    );
    if (
      listed.exitCode !== 0 ||
      listed.timedOut ||
      listed.truncated ||
      listed.stderrTruncated === true ||
      listed.streamError === true
    ) {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(listed.stdout);
    } catch {
      return undefined;
    }
    const decoded = Option.getOrUndefined(
      Schema.decodeUnknownOption(OpenShellProviderPage)(parsed),
    );
    if (decoded === undefined) return undefined;
    for (const provider of decoded.providers) {
      entries.push({
        id: provider.id,
        name: provider.name,
        ...(provider.labels?.['cr-job-owner'] === undefined
          ? {}
          : { owner: provider.labels['cr-job-owner'] }),
      });
    }
    token = decoded.next_page_token;
    if (token.length === 0) return entries;
  }
  return undefined;
};

export const createOpenShellPreflight =
  (config: OpenShellRuntimeConfig) =>
  async (command: SandboxCommand): Promise<boolean> => {
    const gatewayFlags = buildGatewayFlags(config);
    const providers = await listProviders(command, gatewayFlags, 'cleanup');
    if (providers === undefined) return false;
    if (!providers.some((provider) => provider.name === config.modelProvider)) return false;
    const described = await command(
      [...gatewayFlags, 'profile', 'describe', config.githubProfile],
      { stage: 'cleanup', command: 'describe-github-profile', includeStderr: true },
    );
    return described.exitCode === 0 && !described.timedOut;
  };

export const createOpenShellRuntimeFactory =
  (config: OpenShellRuntimeConfig): SandboxRuntimeFactory =>
  (spec: SandboxJobSpec): JobSandboxRuntime => {
    const gatewayFlags = buildGatewayFlags(config);

    const sandboxName = `cr-${createHash('sha256').update(spec.id).digest('hex').slice(0, 16)}`;
    const githubProvider = `cr-${spec.id}-github`;
    const jobOwnerNonce = randomUUID();
    let created = false;
    let providerOwnership: 'none' | 'owned' | 'ambiguous' = 'none';
    let sandboxId: string | undefined;
    let providerId: string | undefined;
    const metadata = {
      get created() {
        return created;
      },
      get id() {
        return sandboxId ?? sandboxName;
      },
      get name() {
        return sandboxName;
      },
      get runtime() {
        return 'openshell' as const;
      },
      get imageRef() {
        return config.image;
      },
      get evidenceRoot() {
        return OS_EVIDENCE;
      },
    };

    const lookupSandbox = async (
      command: SandboxCommand,
      stage: RunnerDiagnostic['stage'],
    ): Promise<SandboxLookup> => {
      const result = await command(
        [...gatewayFlags, 'sandbox', 'get', '--output', 'json', sandboxName],
        { stage, command: 'inspect-sandbox', includeStderr: true },
        { captureStdout: true, maxBytes: MAX_SANDBOX_JSON_BYTES },
      );
      if (
        result.timedOut ||
        result.truncated ||
        result.stderrTruncated === true ||
        result.streamError === true
      ) {
        return { kind: 'error' };
      }
      if (result.exitCode === 0) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(result.stdout);
        } catch {
          return { kind: 'error' };
        }
        const decoded = Option.getOrUndefined(
          Schema.decodeUnknownOption(OpenShellSandboxIdentity)(parsed),
        );
        return decoded === undefined
          ? { kind: 'error' }
          : {
              kind: 'present',
              id: decoded.id,
              name: decoded.name,
              ...(decoded.labels?.['cr-job-owner'] === undefined
                ? {}
                : { owner: decoded.labels['cr-job-owner'] }),
            };
      }
      return /sandbox not found/i.test(`${result.stdout}\n${result.stderr ?? ''}`)
        ? { kind: 'gone' }
        : { kind: 'error' };
    };

    const setup = async (command: SandboxCommand) => {
      const jobOwner = jobOwnerNonce;
      const listed = await listProviders(command, gatewayFlags, 'sandbox');
      if (listed === undefined) throw new Error('openshell provider list failed');
      const existing = listed.find((entry) => entry.name === githubProvider);
      if (existing !== undefined) {
        if (existing.owner !== jobOwner) {
          throw new Error('openshell github provider name already exists; refusing to reuse it');
        }
        providerOwnership = 'owned';
        providerId = existing.id;
      } else {
        providerOwnership = 'ambiguous';
        const provider = await command(
          [
            ...gatewayFlags,
            'provider',
            'create',
            '--name',
            githubProvider,
            '--type',
            config.githubProfile,
            '--credential',
            'GITHUB_TOKEN',
            '--label',
            `cr-job-owner=${jobOwner}`,
          ],
          { stage: 'sandbox', command: 'create-github-provider', includeStderr: true },
          { env: { GITHUB_TOKEN: spec.githubReadToken } },
        );
        if (provider.exitCode === 0 && !provider.timedOut && provider.streamError !== true) {
          providerOwnership = 'owned';
          const captured = await listProviders(command, gatewayFlags, 'sandbox');
          providerId = captured?.find(
            (entry) => entry.name === githubProvider && entry.owner === jobOwner,
          )?.id;
        } else {
          const reconciled = await listProviders(command, gatewayFlags, 'sandbox');
          if (reconciled === undefined) {
            throw new Error('openshell provider ownership could not be resolved');
          }
          if (
            reconciled.some((entry) => entry.name === githubProvider && entry.owner === jobOwner)
          ) {
            providerOwnership = 'owned';
          } else if (reconciled.some((entry) => entry.name === githubProvider)) {
            throw new Error('openshell provider ownership conflict');
          } else {
            providerOwnership = 'none';
            throw new Error('openshell github provider setup failed');
          }
        }
      }

      const create = await command(
        [
          ...gatewayFlags,
          'sandbox',
          'create',
          '--name',
          sandboxName,
          '--from',
          config.image,
          '--cpu',
          spec.cpu,
          '--memory',
          `${spec.memoryGib}Gi`,
          '--detach',
          '--restart-policy',
          'never',
          '--no-auto-providers',
          '--provider',
          config.modelProvider,
          '--provider',
          githubProvider,
          ...spec.env.flatMap((pair) => ['--env', pair]),
          '--env',
          `XDG_CONFIG_HOME=${OS_CONFIG}`,
          '--env',
          `XDG_DATA_HOME=${OS_EVIDENCE}/data`,
          '--env',
          `XDG_STATE_HOME=${OS_EVIDENCE}/state`,
          '--label',
          `cr-job-owner=${jobOwnerNonce}`,
          '--output',
          'json',
          '--',
          '/bin/sleep',
          'infinity',
        ],
        { stage: 'sandbox', command: 'create', includeStderr: true },
        { captureStdout: true, maxBytes: MAX_SANDBOX_JSON_BYTES },
      );
      if (create.exitCode !== 0 || create.timedOut) {
        const reconciled = await lookupSandbox(command, 'sandbox');
        if (
          reconciled.kind === 'present' &&
          reconciled.name === sandboxName &&
          reconciled.owner === jobOwnerNonce
        ) {
          created = true;
          sandboxId = reconciled.id;
        }
        throw new SandboxCreateError(create.timedOut);
      }

      const createdIdentity = identityFromStdout(create.stdout);
      if (
        createdIdentity !== undefined &&
        createdIdentity.name === sandboxName &&
        createdIdentity.owner === jobOwnerNonce
      ) {
        created = true;
        sandboxId = createdIdentity.id;
      } else {
        const identity = await lookupSandbox(command, 'sandbox');
        if (
          identity.kind !== 'present' ||
          identity.name !== sandboxName ||
          identity.owner !== jobOwnerNonce
        ) {
          throw new Error('openshell sandbox identity could not be verified after create');
        }
        created = true;
        sandboxId = identity.id;
      }

      const checkoutUpload = await command(
        [
          ...gatewayFlags,
          'sandbox',
          'upload',
          '--no-git-ignore',
          sandboxName,
          spec.checkoutRoot,
          OS_ROOT,
        ],
        { stage: 'sandbox', command: 'upload-checkout', includeStderr: true },
      );
      if (checkoutUpload.exitCode !== 0 || checkoutUpload.timedOut) {
        throw new Error('openshell checkout upload failed');
      }

      const configBase = spec.configRoot
        .split('/')
        .filter((part) => part.length > 0)
        .pop();
      const configUpload = await command(
        [
          ...gatewayFlags,
          'sandbox',
          'upload',
          '--no-git-ignore',
          sandboxName,
          spec.configRoot,
          OS_ROOT,
        ],
        { stage: 'sandbox', command: 'upload-config', includeStderr: true },
      );
      if (configUpload.exitCode !== 0 || configUpload.timedOut || configBase === undefined) {
        throw new Error('openshell config upload failed');
      }
      const relocate = await command(
        [
          ...gatewayFlags,
          'sandbox',
          'exec',
          sandboxName,
          '--workdir',
          OS_CHECKOUT,
          '--no-tty',
          '--no-login-shell',
          '--',
          'mv',
          `${OS_ROOT}/${configBase}`,
          OS_CONFIG,
        ],
        { stage: 'sandbox', command: 'stage-config', includeStderr: true },
      );
      if (relocate.exitCode !== 0 || relocate.timedOut) {
        throw new Error('openshell config staging failed');
      }
    };

    const exec = (
      args: readonly string[],
      command: SandboxCommand,
      processOptions?: RunnerProcessOptions,
      diagnostic?: RunnerDiagnostic,
    ): Promise<RunnerProcessResult> =>
      command(
        [
          ...gatewayFlags,
          'sandbox',
          'exec',
          sandboxName,
          '--workdir',
          OS_CHECKOUT,
          '--no-tty',
          '--no-login-shell',
          '--',
          ...args,
        ],
        diagnostic,
        processOptions,
      );

    const copyOut = (
      sandboxPath: string,
      localPath: string,
      command: SandboxCommand,
      diagnostic?: RunnerDiagnostic,
      processOptions?: RunnerProcessOptions,
    ): Promise<RunnerProcessResult> =>
      command(
        [...gatewayFlags, 'sandbox', 'download', sandboxName, sandboxPath, localPath],
        diagnostic,
        processOptions,
      );

    const destroy = async (command: SandboxCommand) => {
      let sandboxClean = false;
      let sandboxError: string | undefined;

      const before = await lookupSandbox(command, 'cleanup');
      if (before.kind === 'error') {
        sandboxError = 'openshell sandbox identity check failed before delete';
      } else if (before.kind === 'present') {
        if (
          before.name !== sandboxName ||
          before.owner !== jobOwnerNonce ||
          (sandboxId !== undefined && before.id !== sandboxId)
        ) {
          sandboxError = 'openshell sandbox identity mismatch; refusing to delete';
        } else {
          await command([...gatewayFlags, 'sandbox', 'delete', sandboxName], {
            stage: 'cleanup',
            command: 'remove-sandbox',
            includeStderr: true,
          });
          const deadline = Date.now() + resolveDeleteTimeoutMs();
          let confirmed = false;
          while (Date.now() < deadline) {
            const after = await lookupSandbox(command, 'cleanup');
            if (after.kind === 'error') {
              sandboxError = 'openshell sandbox deletion check failed';
              break;
            }
            if (after.kind === 'gone') {
              confirmed = true;
              break;
            }
            if (sandboxId !== undefined && after.kind === 'present' && after.id !== sandboxId) {
              confirmed = true;
              break;
            }
            await sleep(POLL_INTERVAL_MS);
          }
          sandboxClean = confirmed;
          if (!confirmed && sandboxError === undefined) {
            sandboxError = 'openshell sandbox deletion was not confirmed';
          }
        }
      } else {
        sandboxClean = true;
      }

      let providerClean = true;
      let providerError: string | undefined;
      if (providerOwnership === 'ambiguous') {
        providerClean = false;
        providerError = 'openshell provider ownership unresolved; refusing to delete';
      } else if (providerOwnership === 'owned') {
        const current = await listProviders(command, gatewayFlags, 'cleanup');
        const entry = current?.find((candidate) => candidate.name === githubProvider);
        if (
          entry === undefined ||
          entry.owner !== jobOwnerNonce ||
          (providerId !== undefined && entry.id !== providerId)
        ) {
          providerClean = false;
          providerError =
            'openshell provider replacement or unverified identity; refusing to delete';
        } else {
          const providerDelete = await command(
            [...gatewayFlags, 'provider', 'delete', githubProvider],
            { stage: 'cleanup', command: 'remove-github-provider', includeStderr: true },
          );
          if (providerDelete.exitCode !== 0 || providerDelete.timedOut) {
            providerClean = false;
            providerError = 'openshell provider cleanup failed';
          }
        }
      }

      if (!sandboxClean || !providerClean) {
        throw new Error(
          [sandboxError, providerError].filter((value) => value !== undefined).join('; ') ||
            'openshell cleanup was not confirmed',
        );
      }
    };

    return { metadata, setup, exec, copyOut, destroy };
  };
