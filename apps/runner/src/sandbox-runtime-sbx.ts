import { chmod, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Effect, Option, Schema } from 'effect';
import type {
  JobSandbox,
  OrphanReconcileResult,
  RunnerDiagnostic,
  RunnerProcessOptions,
  RunnerProcessResult,
  SandboxBackend,
  SandboxBackendContext,
  SandboxCleanupConfirmation,
  SandboxExecPort,
  SandboxHealth,
  SandboxJobSpec,
  SandboxRecoveryFailure,
  SandboxRecoveryStep,
} from './sandbox-runtime.js';
import { SandboxCreateError } from './sandbox-runtime.js';
import { sandboxResourceIdentity, sweepableSandboxResource } from './sandbox-resource-name.js';

type SbxCommand = (
  args: readonly string[],
  diagnostic?: RunnerDiagnostic,
  options?: RunnerProcessOptions,
) => Promise<RunnerProcessResult>;

const MAX_POLICY_JSON_BYTES = 256 * 1024;
const nonEmpty = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
};
const SBX_MODEL_ENV = 'OPENCODE_API_KEY';
const SBX_LAUNCHER = 'shell';
const SBX_EVIDENCE_ROOT = '/tmp/petit-chiba-opencode-evidence';
const SBX_IMAGE = 'ghcr.io/ariga39/petit-chiba-opencode:2.4.1-gh2.98.0';

const NetworkPolicyRule = Schema.Struct({
  id: Schema.NonEmptyString,
  resources: Schema.Array(Schema.NonEmptyString),
  sandbox_id: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
  editable: Schema.Boolean,
});
const NetworkPolicyList = Schema.Struct({ rules: Schema.Array(NetworkPolicyRule) });
type NetworkPolicyRuleValue = Schema.Schema.Type<typeof NetworkPolicyRule>;

const networkPolicyRulesFrom = (stdout: string): readonly NetworkPolicyRuleValue[] | undefined => {
  try {
    return Option.getOrUndefined(Schema.decodeUnknownOption(NetworkPolicyList)(JSON.parse(stdout)))
      ?.rules;
  } catch {
    return undefined;
  }
};

const SbxSecretList = Schema.Struct({
  secrets: Schema.Array(
    Schema.Struct({
      scope: Schema.NonEmptyString,
      type: Schema.NonEmptyString,
      name: Schema.NonEmptyString,
    }),
  ),
  custom_secrets: Schema.Array(
    Schema.Struct({
      scope: Schema.NonEmptyString,
      placeholder: Schema.NonEmptyString,
    }),
  ),
});

type SandboxRecoveryFailureDetail = Omit<SandboxRecoveryFailure, 'jobId' | 'sandboxName'>;

const commandFailure = (
  step: SandboxRecoveryStep,
  command: string | undefined,
  result: RunnerProcessResult | undefined,
): SandboxRecoveryFailureDetail => {
  return {
    step,
    ...(command === undefined ? {} : { command }),
    ...(result === undefined
      ? {}
      : {
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          truncated: result.truncated,
          stderrTruncated: result.stderrTruncated === true,
          streamError: result.streamError === true,
          processError: result.processError === true,
          ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
        }),
  };
};

const sandboxAbsent = (result: RunnerProcessResult, sandboxName: string): boolean =>
  result.exitCode === 1 &&
  !result.timedOut &&
  !result.truncated &&
  !result.stderrTruncated &&
  !result.streamError &&
  !result.processError &&
  result.stdout.trim() === '' &&
  result.stderr?.split('\n').includes(`error: sandbox '${sandboxName}' not found`) === true;

type SbxPolicyListResult =
  | {
      readonly ok: true;
      readonly rules: readonly NetworkPolicyRuleValue[];
      readonly result: RunnerProcessResult;
    }
  | { readonly ok: false; readonly result: RunnerProcessResult };

const listAllNetworkPolicies = async (command: SbxCommand): Promise<SbxPolicyListResult> => {
  const listed = await command(
    ['policy', 'ls', '--json', '--include-inactive', '--type', 'network'],
    { stage: 'cleanup', command: 'inspect-restart-network-policy', includeStderr: true },
    { captureStdout: true, maxBytes: MAX_POLICY_JSON_BYTES },
  );
  if (listed.exitCode !== 0 || listed.timedOut || listed.truncated) {
    return { ok: false, result: listed };
  }
  const rules = networkPolicyRulesFrom(listed.stdout);
  return rules === undefined ? { ok: false, result: listed } : { ok: true, rules, result: listed };
};

interface SbxRuntimeOptions {
  /** Host command that resolves the model API key; runs only in the sbx adapter. */
  readonly modelSecretCommand?: string;
  /** Executable selected by the registration layer. */
  readonly program: string;
  /** Called after any destroy failure so the instance can refresh its health. */
  readonly onDestroyFailure?: () => Promise<void>;
}

const complete = (result: RunnerProcessResult) =>
  !result.timedOut &&
  !result.truncated &&
  !result.stderrTruncated &&
  !result.streamError &&
  !result.processError;

const listSandboxNames = async (
  command: SbxCommand,
): Promise<
  | { readonly ok: true; readonly names: readonly string[] }
  | { readonly ok: false; readonly result: RunnerProcessResult }
> => {
  const listed = await command(
    ['ls', '-q'],
    { stage: 'cleanup', command: 'inspect-sandbox-inventory', includeStderr: true },
    { captureStdout: true, captureStderr: true, maxBytes: MAX_POLICY_JSON_BYTES },
  );
  if (!complete(listed) || listed.exitCode !== 0) return { ok: false, result: listed };
  return {
    ok: true,
    names: listed.stdout
      .split('\n')
      .map((name) => name.trim())
      .filter((name) => name.length > 0),
  };
};

type ScopedSecrets = typeof SbxSecretList.Type;

const listScopedSecrets = async (
  command: SbxCommand,
  sandboxName?: string,
): Promise<
  | {
      readonly ok: true;
      readonly secrets: ScopedSecrets;
      readonly result: RunnerProcessResult;
    }
  | { readonly ok: false; readonly result: RunnerProcessResult }
> => {
  const listed = await command(
    ['secret', 'ls', '--json', ...(sandboxName === undefined ? [] : ['--sandbox', sandboxName])],
    { stage: 'cleanup', command: 'inspect-secret-inventory', includeStderr: true },
    { captureStdout: true, maxBytes: MAX_POLICY_JSON_BYTES },
  );
  if (!complete(listed) || listed.exitCode !== 0) return { ok: false, result: listed };
  const secrets = Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.fromJsonString(SbxSecretList))(listed.stdout),
  );
  return secrets === undefined
    ? { ok: false, result: listed }
    : { ok: true, secrets, result: listed };
};

const removeScopedSecrets = async (
  sandboxName: string,
  command: SbxCommand,
): Promise<SandboxRecoveryFailureDetail | undefined> => {
  // The global inventory remains readable after `rm` and also exposes a secret
  // registered before the VM was ever created.
  const listed = await listScopedSecrets(command);
  if (!listed.ok) return commandFailure('secret-list', 'secret ls', listed.result);
  for (const secret of listed.secrets.custom_secrets.filter(
    (candidate) => candidate.scope === sandboxName,
  )) {
    await command(
      ['secret', 'rm', '--placeholder', secret.placeholder, '--sandbox', sandboxName, '--force'],
      { stage: 'cleanup', command: 'remove-secret', includeStderr: true },
    );
  }
  for (const secret of listed.secrets.secrets.filter(
    (candidate) => candidate.scope === sandboxName,
  )) {
    await command(['secret', 'rm', secret.name, '--sandbox', sandboxName, '--force'], {
      stage: 'cleanup',
      command: 'remove-secret',
      includeStderr: true,
    });
  }
  const remaining = await listScopedSecrets(command);
  if (!remaining.ok) return commandFailure('secret-verify', 'secret ls', remaining.result);
  if (
    remaining.secrets.secrets.some((secret) => secret.scope === sandboxName) ||
    remaining.secrets.custom_secrets.some((secret) => secret.scope === sandboxName)
  )
    return commandFailure('secret-verify', 'secret ls', remaining.result);
  return undefined;
};

/**
 * Remove the exact named Sandbox plus every policy and secret scoped to that
 * exact name. The caller supplies the name from a trusted retained manifest.
 * Inventory failures never authorize a removal, and the final postconditions
 * verify the native absence instead of trusting exit codes or age.
 */
const removeExactSbxResources = async (
  sandboxName: string,
  command: SbxCommand,
): Promise<SandboxRecoveryFailureDetail | undefined> => {
  const policies = await listAllNetworkPolicies(command);
  if (!policies.ok) return commandFailure('policy-list', 'policy ls', policies.result);
  for (const rule of policies.rules.filter(
    (candidate) => candidate.sandbox_id === sandboxName && candidate.editable,
  )) {
    await command(
      ['policy', 'rm', 'network', '--id', rule.id, '--sandbox', sandboxName, '--force'],
      { stage: 'cleanup', command: 'remove-network-policy', includeStderr: true },
    );
  }

  const inspect = await command(
    ['inspect', sandboxName, '--json'],
    { stage: 'cleanup', command: 'inspect-sandbox', includeStderr: true },
    { captureStdout: true, captureStderr: true },
  );
  const present =
    inspect.exitCode === 0 && complete(inspect)
      ? true
      : sandboxAbsent(inspect, sandboxName)
        ? false
        : undefined;
  if (present === undefined) return commandFailure('inspect', 'inspect', inspect);
  if (present) {
    // A normal sbx create installs sandbox-scoped non-editable rules. `rm`
    // cascades them; never require editing every scoped rule before removal.
    const removed = await command(['rm', '--force', sandboxName], {
      stage: 'cleanup',
      command: 'remove-sandbox',
      includeStderr: true,
    });
    const inspected = await command(
      ['inspect', sandboxName, '--json'],
      { stage: 'cleanup', command: 'confirm-sandbox-absent', includeStderr: true },
      { captureStdout: true, captureStderr: true },
    );
    if (!sandboxAbsent(inspected, sandboxName))
      return commandFailure('sandbox-remove', 'rm', removed);
  }

  const secretFailure = await removeScopedSecrets(sandboxName, command);

  // Inspect surviving policies after the VM is gone and only remove an editable
  // orphan. An unremovable survivor stays fail-closed.
  const afterRemoval = await listAllNetworkPolicies(command);
  if (!afterRemoval.ok) return commandFailure('policy-list', 'policy ls', afterRemoval.result);
  for (const rule of afterRemoval.rules.filter(
    (candidate) => candidate.sandbox_id === sandboxName && candidate.editable,
  )) {
    await command(
      ['policy', 'rm', 'network', '--id', rule.id, '--sandbox', sandboxName, '--force'],
      { stage: 'cleanup', command: 'remove-network-policy', includeStderr: true },
    );
  }
  const remainingPolicies = await listAllNetworkPolicies(command);
  if (
    !remainingPolicies.ok ||
    remainingPolicies.rules.some((rule) => rule.sandbox_id === sandboxName)
  )
    return commandFailure('policy-verify', 'policy ls', remainingPolicies.result);
  if (secretFailure !== undefined) return secretFailure;

  const finalInspect = await command(
    ['inspect', sandboxName, '--json'],
    { stage: 'cleanup', command: 'confirm-sandbox-absent', includeStderr: true },
    { captureStdout: true, captureStderr: true },
  );
  return sandboxAbsent(finalInspect, sandboxName)
    ? undefined
    : commandFailure('sandbox-verify', 'inspect', finalInspect);
};

/**
 * Confirm the exact Sandbox is already absent, then remove only policies and
 * secrets scoped to that exact name. Recovery never deletes a present Sandbox.
 */
const confirmExactSbxResourcesAbsent = async (
  sandboxName: string,
  command: SbxCommand,
): Promise<SandboxRecoveryFailureDetail | undefined> => {
  const inspect = await command(
    ['inspect', sandboxName, '--json'],
    { stage: 'cleanup', command: 'confirm-sandbox-absent', includeStderr: true },
    { captureStdout: true, captureStderr: true },
  );
  if (!sandboxAbsent(inspect, sandboxName))
    return commandFailure('sandbox-present', 'inspect', inspect);

  const policies = await listAllNetworkPolicies(command);
  if (!policies.ok) return commandFailure('policy-list', 'policy ls', policies.result);
  for (const rule of policies.rules.filter(
    (candidate) => candidate.sandbox_id === sandboxName && candidate.editable,
  )) {
    await command(
      ['policy', 'rm', 'network', '--id', rule.id, '--sandbox', sandboxName, '--force'],
      { stage: 'cleanup', command: 'remove-network-policy', includeStderr: true },
    );
  }
  const remaining = await listAllNetworkPolicies(command);
  if (!remaining.ok || remaining.rules.some((rule) => rule.sandbox_id === sandboxName))
    return commandFailure('policy-verify', 'policy ls', remaining.result);

  const secretFailure = await removeScopedSecrets(sandboxName, command);
  if (secretFailure !== undefined) return secretFailure;

  const finalInspect = await command(
    ['inspect', sandboxName, '--json'],
    { stage: 'cleanup', command: 'confirm-sandbox-absent', includeStderr: true },
    { captureStdout: true, captureStderr: true },
  );
  return sandboxAbsent(finalInspect, sandboxName)
    ? undefined
    : commandFailure('sandbox-verify', 'inspect', finalInspect);
};

const reconcileSbxResources = async (
  command: SbxCommand,
  isLive: (jobId: string) => boolean = () => false,
  only?: { readonly jobId: string; readonly sandboxName: string },
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
    const failure = await removeExactSbxResources(only.sandboxName, command);
    return failure === undefined
      ? { ok: true, recovered: 1, recoveredJobIds: [only.jobId], failures: [] }
      : {
          ok: false,
          recovered: 0,
          recoveredJobIds: [],
          failures: [{ jobId: only.jobId, sandboxName: only.sandboxName, ...failure }],
        };
  }

  const names = await listSandboxNames(command);
  if (!names.ok)
    return {
      ok: false,
      recovered: 0,
      recoveredJobIds: [],
      failures: [{ jobId: 'redacted', sandboxName: 'redacted', step: 'sandbox-list' }],
    };
  const policies = await listAllNetworkPolicies(command);
  if (!policies.ok)
    return {
      ok: false,
      recovered: 0,
      recoveredJobIds: [],
      failures: [{ jobId: 'redacted', sandboxName: 'redacted', step: 'policy-list' }],
    };
  const secrets = await listScopedSecrets(command);
  if (!secrets.ok)
    return {
      ok: false,
      recovered: 0,
      recoveredJobIds: [],
      failures: [{ jobId: 'redacted', sandboxName: 'redacted', step: 'secret-list' }],
    };

  const candidates = new Set<string>(names.names);
  for (const rule of policies.rules) {
    if (rule.sandbox_id !== null && rule.sandbox_id !== undefined) candidates.add(rule.sandbox_id);
  }
  for (const secret of secrets.secrets.secrets) candidates.add(secret.scope);
  for (const secret of secrets.secrets.custom_secrets) candidates.add(secret.scope);

  const now = Date.now();
  let recovered = 0;
  const recoveredJobIds: string[] = [];
  const failures: SandboxRecoveryFailure[] = [];
  for (const sandboxName of candidates) {
    const identity = sandboxResourceIdentity(sandboxName);
    if (identity === undefined || !sweepableSandboxResource(sandboxName, now)) continue;
    if (isLive(identity.jobId)) continue;
    const failure = await removeExactSbxResources(sandboxName, command);
    if (failure !== undefined) {
      failures.push({ jobId: identity.jobId, sandboxName, ...failure });
      continue;
    }
    recovered += 1;
    recoveredJobIds.push(identity.jobId);
  }
  return { ok: failures.length === 0, recovered, recoveredJobIds, failures };
};

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

const sbxEnvironment = (): NodeJS.ProcessEnv => ({
  ...process.env,
  SSH_AUTH_SOCK: undefined,
  SSH_AGENT_PID: undefined,
  GH_TOKEN: undefined,
  GITHUB_TOKEN: undefined,
});

const sbxOptions = (
  options: SbxRuntimeOptions,
  processOptions?: RunnerProcessOptions,
): RunnerProcessOptions => ({
  ...processOptions,
  env: processOptions?.env ?? sbxEnvironment(),
  stderrRedactions: [
    ...(options.modelSecretCommand === undefined ? [] : [options.modelSecretCommand]),
    ...(processOptions?.stderrRedactions ?? []),
  ],
});

const redactSbxStderr = (
  options: SbxRuntimeOptions,
  result: RunnerProcessResult,
): RunnerProcessResult => {
  if (
    options.modelSecretCommand === undefined ||
    options.modelSecretCommand.length === 0 ||
    result.stderr === undefined
  )
    return result;
  const stderr = result.stderr.replaceAll(options.modelSecretCommand, '[redacted]');
  return stderr === result.stderr ? result : { ...result, stderr };
};

const commandFor = (options: SbxRuntimeOptions, exec: SandboxExecPort): SbxCommand => {
  return async (args, diagnostic, processOptions) =>
    redactSbxStderr(
      options,
      await exec.run(options.program, args, sbxOptions(options, processOptions), diagnostic),
    );
};

const createSbxJobSandbox = (options: SbxRuntimeOptions, spec: SandboxJobSpec): JobSandbox => {
  const placeholder = `cr-${spec.id}`;
  const modelHost = spec.modelResource.replace(/:\d+$/, '');
  let tokenPath: string | undefined;
  let activeGithubReadToken = spec.githubReadToken;
  let tokenWriteChain: Promise<void> = Promise.resolve();
  let destroyed = false;
  let created = false;
  const metadata = {
    // The rotating GitHub token lives under the Runner-owned host scratch root,
    // outside the guest-mounted checkout/config paths. The Runner removes that
    // root; sbx owns no separate host-only resource.
    hostCleanupConfirmed: true,
    get created() {
      return created;
    },
    get id() {
      return spec.name;
    },
    get name() {
      return spec.name;
    },
    get runtime() {
      return 'sbx' as const;
    },
    get imageRef() {
      return SBX_IMAGE;
    },
    get evidenceRoot() {
      return SBX_EVIDENCE_ROOT;
    },
  };

  // The `--refresh on-demand` service source rereads this exact host file for
  // each credential use. Replacing its contents atomically keeps the same
  // sandbox-scoped registration and destination; no Sandbox reinstall is
  // needed. A destroyed runtime rejects queued or late writes.
  const writeActiveGithubToken = (token: string): Promise<void> => {
    const write = tokenWriteChain.then(async () => {
      if (destroyed || tokenPath === undefined) {
        throw new Error('sandbox github token destination unavailable');
      }
      const temporaryPath = `${tokenPath}.tmp`;
      try {
        await writeFile(temporaryPath, token, { mode: 0o600 });
        await chmod(temporaryPath, 0o600);
        if (destroyed) {
          await rm(temporaryPath, { force: true });
          throw new Error('sandbox github token destination unavailable');
        }
        await rename(temporaryPath, tokenPath);
      } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
      }
    });
    tokenWriteChain = write.catch(() => undefined);
    return write;
  };

  const setup = async (exec: SandboxExecPort) => {
    const command = commandFor(options, exec);
    const modelSecretSource =
      spec.modelTokenFile === undefined
        ? (options.modelSecretCommand ?? '')
        : `/usr/bin/cat ${shellQuote(spec.modelTokenFile)}`;
    const secret = await command(
      [
        'secret',
        'set-custom',
        '--sandbox',
        spec.name,
        '--host',
        modelHost,
        '--env',
        SBX_MODEL_ENV,
        '--placeholder',
        placeholder,
        '--command',
        modelSecretSource,
      ],
      { stage: 'sandbox', command: 'set-secret' },
    );
    if (secret.exitCode !== 0 || secret.timedOut) throw new Error('sandbox secret setup failed');

    const tokenFile = join(spec.hostScratchRoot, 'github-read-token');
    tokenPath = tokenFile;
    await writeActiveGithubToken(activeGithubReadToken);
    const githubSecret = await command(
      [
        'secret',
        'set',
        'github',
        '--sandbox',
        spec.name,
        '--command',
        `cat ${shellQuote(tokenFile)}`,
        '--refresh',
        'on-demand',
      ],
      { stage: 'sandbox', command: 'set-github-service' },
    );
    if (githubSecret.exitCode !== 0 || githubSecret.timedOut) {
      throw new Error('sandbox github secret setup failed');
    }

    const create = await command(
      [
        'create',
        '--clone',
        '--no-share-skills',
        '--template',
        SBX_IMAGE,
        '--name',
        spec.name,
        '--cpus',
        spec.cpu,
        '--memory',
        `${spec.memoryGib}g`,
        ...spec.env.flatMap((pair) => ['--env', pair]),
        '--env',
        `XDG_CONFIG_HOME=${spec.configRoot}`,
        '--env',
        `XDG_DATA_HOME=${SBX_EVIDENCE_ROOT}/data`,
        '--env',
        `XDG_STATE_HOME=${SBX_EVIDENCE_ROOT}/state`,
        SBX_LAUNCHER,
        spec.checkoutRoot,
        spec.configRoot,
      ],
      { stage: 'sandbox', command: 'create', includeStderr: true },
    );
    if (create.exitCode !== 0 || create.timedOut) throw new SandboxCreateError(create.timedOut);
    created = true;

    for (const [resource, commandName, inspectName] of [
      [spec.modelResource, 'allow-network', 'inspect-network-policy'],
      [spec.githubResource, 'allow-github-network', 'inspect-github-network-policy'],
    ] as const) {
      const allowed = await command(
        ['policy', 'allow', 'network', '--sandbox', spec.name, resource],
        { stage: 'sandbox', command: commandName, includeStderr: true },
      );
      if (allowed.timedOut) throw new Error('sandbox policy setup timed out');
      if (allowed.exitCode !== 0) throw new Error('sandbox policy setup failed');
      const policies = await command(
        ['policy', 'ls', spec.name, '--json', '--source', 'local', '--type', 'network'],
        { stage: 'sandbox', command: inspectName, includeStderr: true },
        { captureStdout: true, maxBytes: MAX_POLICY_JSON_BYTES },
      );
      const rules =
        policies.exitCode === 0 && !policies.timedOut && !policies.truncated
          ? networkPolicyRulesFrom(policies.stdout)
          : undefined;
      const matches =
        rules?.filter(
          (candidate) =>
            candidate.editable &&
            candidate.sandbox_id === spec.name &&
            candidate.resources.includes(resource),
        ) ?? [];
      if (matches.length !== 1) throw new Error('sandbox policy verification failed');
    }
  };

  const exec = (
    args: readonly string[],
    port: SandboxExecPort,
    processOptions?: RunnerProcessOptions,
    diagnostic?: RunnerDiagnostic,
  ): Promise<RunnerProcessResult> => {
    const command = commandFor(options, port);
    return command(['exec', spec.name, ...args], diagnostic, processOptions);
  };

  const copyOut = (
    sandboxPath: string,
    localPath: string,
    port: SandboxExecPort,
    diagnostic?: RunnerDiagnostic,
    processOptions?: RunnerProcessOptions,
  ): Promise<RunnerProcessResult> => {
    const command = commandFor(options, port);
    return command(['cp', `${spec.name}:${sandboxPath}`, localPath], diagnostic, processOptions);
  };

  const destroy = async (port: SandboxExecPort) => {
    const command = commandFor(options, port);
    destroyed = true;
    try {
      await tokenWriteChain.catch(() => undefined);
      const failure = await removeExactSbxResources(spec.name, command);
      if (failure !== undefined) throw new Error('sbx sandbox cleanup was not confirmed');
    } catch (error) {
      await options.onDestroyFailure?.();
      throw error;
    }
  };

  const updateGithubReadToken = async (token: string) => {
    if (destroyed) throw new Error('sandbox github token destination unavailable');
    activeGithubReadToken = token;
    // Setup may not have created the destination yet; its next write uses the
    // latest token. Once present, replace the same file atomically.
    if (tokenPath === undefined) return;
    await writeActiveGithubToken(token);
  };

  return { metadata, setup, exec, copyOut, updateGithubReadToken, destroy };
};

class CleanupRecoveryError extends Schema.TaggedError<CleanupRecoveryError>()(
  'CleanupRecoveryError',
  {},
) {}

const confirmSbxCleanup = Effect.fn('confirmSbxCleanup')(function* (
  sandboxName: string,
  command: SbxCommand,
) {
  const failure = yield* Effect.tryPromise({
    try: () => confirmExactSbxResourcesAbsent(sandboxName, command),
    catch: () => new CleanupRecoveryError(),
  });
  if (failure !== undefined) {
    return yield* new CleanupRecoveryError();
  }
});

export const createSbxSandboxBackend = (context: SandboxBackendContext): SandboxBackend => {
  const program = process.env.RUNNER_SANDBOX_CLI ?? process.env.SBX_BIN ?? 'sbx';
  const modelSecretCommand = context.relayEnabled
    ? undefined
    : nonEmpty(process.env.MODEL_SECRET_COMMAND);
  if (!context.relayEnabled && modelSecretCommand === undefined) {
    throw new Error(
      'sbx direct mode requires MODEL_SECRET_COMMAND to resolve the model credential',
    );
  }
  const runtimeOptions: SbxRuntimeOptions = {
    program,
    ...(modelSecretCommand === undefined ? {} : { modelSecretCommand }),
    onDestroyFailure: async () => {
      if (!(await probeAccess())) health = 'outage';
    },
  };
  // A fresh process has not proved sbx access yet. The first claim readiness
  // probe establishes ready/outage without waiting for the broad age sweep.
  let health: SandboxHealth = 'unready';
  const command: SbxCommand = async (args, diagnostic, processOptions) =>
    redactSbxStderr(
      runtimeOptions,
      await context.hostRun(program, args, sbxOptions(runtimeOptions, processOptions), diagnostic),
    );
  const probeAccess = async (): Promise<boolean> => {
    try {
      const listed = await context.hostRun(program, ['ls'], {
        env: sbxEnvironment(),
        captureStdout: false,
        captureStderr: true,
        timeoutMs: 30 * 1000,
        maxBytes: 256 * 1024,
      });
      return (
        listed.exitCode === 0 &&
        !listed.timedOut &&
        listed.streamError !== true &&
        listed.processError !== true
      );
    } catch {
      return false;
    }
  };
  return {
    kind: 'sbx',
    health: () => health,
    async checkReady(): Promise<SandboxHealth> {
      if (health === 'ready') return 'ready';
      if (!(await probeAccess())) return health;
      health = 'ready';
      return 'ready';
    },
    async reconcileOrphans({ isLiveJob, only }): Promise<OrphanReconcileResult> {
      // Inventory or removal failures are retried on their own cadence. They
      // must not halt a healthy claim loop unless a destroy already established
      // a backend-wide access outage.
      return reconcileSbxResources(command, isLiveJob, only);
    },
    async confirmCleanupAbsent(input: SandboxCleanupConfirmation): Promise<void> {
      await Effect.runPromise(confirmSbxCleanup(input.sandboxName, command));
    },
    createJob(spec: SandboxJobSpec): JobSandbox {
      return createSbxJobSandbox(runtimeOptions, spec);
    },
  };
};
