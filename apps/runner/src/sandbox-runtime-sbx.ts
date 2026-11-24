import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
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

type SbxCommand = (
  args: readonly string[],
  diagnostic?: RunnerDiagnostic,
  options?: RunnerProcessOptions,
) => Promise<RunnerProcessResult>;

const MAX_POLICY_JSON_BYTES = 256 * 1024;
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

// Mirrors the `sbx inspect --json` view in the pinned sbx 0.48.0 CLI.
const SbxInspectWorkspace = Schema.Struct({
  dir: Schema.NonEmptyString,
  read_only: Schema.optional(Schema.Boolean),
});
const SbxInspectView = Schema.Struct({
  name: Schema.NonEmptyString,
  workspace: Schema.optional(Schema.String),
  additional_workspaces: Schema.optional(Schema.Array(SbxInspectWorkspace)),
});
type SbxInspectView = typeof SbxInspectView.Type;

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

const SbxOwnershipRecord = Schema.Struct({
  version: Schema.Literal(1),
  jobId: Schema.NonEmptyString,
  sandboxName: Schema.NonEmptyString,
  workspacePath: Schema.NonEmptyString,
  configPath: Schema.NonEmptyString,
  modelResource: Schema.NonEmptyString,
  githubResource: Schema.NonEmptyString,
  modelSecretAttempted: Schema.Boolean,
  githubSecretAttempted: Schema.Boolean,
  createAttempted: Schema.Boolean,
  policyAttempted: Schema.Boolean,
});
type SbxOwnershipRecord = typeof SbxOwnershipRecord.Type;

type SandboxRecoveryFailureDetail = Omit<SandboxRecoveryFailure, 'jobId' | 'sandboxName'>;

const commandFailure = (
  record: SbxOwnershipRecord | undefined,
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

const ownershipMarkerName = (jobId: string) =>
  `${createHash('sha256').update(jobId).digest('hex')}.json`;

const saveOwnershipRecord = async (root: string, record: SbxOwnershipRecord) => {
  const path = join(root, ownershipMarkerName(record.jobId));
  const temporary = `${path}.tmp`;
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
};

const removeOwnershipRecord = async (root: string, jobId: string) => {
  await rm(join(root, ownershipMarkerName(jobId)), { force: true });
};

const readOwnershipRecord = async (
  root: string,
  name: string,
): Promise<SbxOwnershipRecord | undefined> => {
  let text: string;
  try {
    text = await readFile(join(root, name), 'utf8');
  } catch {
    return undefined;
  }
  const record = Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.fromJsonString(SbxOwnershipRecord), {
      onExcessProperty: 'error',
    })(text),
  );
  if (
    record === undefined ||
    basename(name) !== ownershipMarkerName(record.jobId) ||
    record.sandboxName !== `compte-rendu-${record.jobId}` ||
    (record.githubSecretAttempted && !record.modelSecretAttempted) ||
    (record.createAttempted && !record.githubSecretAttempted) ||
    (record.policyAttempted && !record.createAttempted)
  )
    return undefined;
  return record;
};

const inspectViewFrom = (stdout: string): SbxInspectView | undefined =>
  Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(SbxInspectView))(stdout));

const ownsSbxSandbox = (view: SbxInspectView, record: SbxOwnershipRecord): boolean =>
  view.name === record.sandboxName &&
  (view.workspace === record.workspacePath ||
    view.additional_workspaces?.some((mount) => mount.dir === record.configPath) === true);

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

const attemptedPolicyResources = (record: SbxOwnershipRecord): ReadonlySet<string> =>
  new Set([record.modelResource, record.githubResource]);

const ownedPolicyRule = (record: SbxOwnershipRecord, rule: NetworkPolicyRuleValue): boolean => {
  if (rule.sandbox_id !== record.sandboxName || !rule.editable || rule.resources.length === 0)
    return false;
  const attempted = attemptedPolicyResources(record);
  return rule.resources.every((resource) => attempted.has(resource));
};

const scopedSecretsAbsent = async (
  record: SbxOwnershipRecord,
  command: SbxCommand,
): Promise<SandboxRecoveryFailureDetail | undefined> => {
  if (!record.modelSecretAttempted && !record.githubSecretAttempted) return undefined;
  const commandName = 'secret ls';
  const listed = await command(
    ['secret', 'ls', '--json', '--sandbox', record.sandboxName],
    { stage: 'cleanup', command: 'confirm-restart-secrets-absent', includeStderr: true },
    { captureStdout: true, maxBytes: MAX_POLICY_JSON_BYTES },
  );
  if (
    listed.exitCode !== 0 ||
    listed.timedOut ||
    listed.truncated ||
    listed.stderrTruncated === true ||
    listed.streamError === true ||
    listed.processError === true
  )
    return commandFailure(record, 'secret-verify', commandName, listed);
  const secrets = Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.fromJsonString(SbxSecretList))(listed.stdout),
  );
  if (secrets === undefined) return commandFailure(record, 'secret-verify', commandName, listed);
  if (
    record.modelSecretAttempted &&
    secrets.custom_secrets.some((secret) => secret.placeholder === `cr-${record.jobId}`)
  )
    return commandFailure(record, 'secret-verify', commandName, listed);
  if (
    record.githubSecretAttempted &&
    secrets.secrets.some((secret) => secret.name === 'github' || secret.type === 'github')
  )
    return commandFailure(record, 'secret-verify', commandName, listed);
  return undefined;
};

interface SbxRuntimeOptions {
  /** Host command that resolves the model API key; runs only in the sbx adapter. */
  readonly modelSecretCommand?: string;
  /** Private per-instance directory for retained Sandbox ownership records. */
  readonly ownershipRoot?: string;
  /** Executable selected by the registration layer. */
  readonly program: string;
  /** Called after any destroy failure so the instance can refresh its health. */
  readonly onDestroyFailure?: () => Promise<void>;
}

const removeOwnedSbxResources = async (
  record: SbxOwnershipRecord,
  command: SbxCommand,
): Promise<SandboxRecoveryFailureDetail | undefined> => {
  const inspect = await command(
    ['inspect', record.sandboxName, '--json'],
    { stage: 'cleanup', command: 'inspect-restart-sandbox', includeStderr: true },
    { captureStdout: true, captureStderr: true },
  );
  let removeSandbox = false;
  if (inspect.exitCode === 0 && !inspect.timedOut && !inspect.truncated) {
    if (!record.createAttempted) return commandFailure(record, 'ownership', 'inspect', inspect);
    const view = inspectViewFrom(inspect.stdout);
    if (view === undefined || !ownsSbxSandbox(view, record))
      return commandFailure(record, 'ownership', 'inspect', inspect);
    removeSandbox = true;
  } else if (!sandboxAbsent(inspect, record.sandboxName)) {
    return commandFailure(record, 'inspect', 'inspect', inspect);
  }

  let firstFailure: SandboxRecoveryFailureDetail | undefined;
  const remember = (failure: SandboxRecoveryFailureDetail) => {
    firstFailure ??= failure;
  };

  if (record.policyAttempted) {
    const policies = await listAllNetworkPolicies(command);
    if (!policies.ok) return commandFailure(record, 'policy-list', 'policy ls', policies.result);
    for (const rule of policies.rules.filter((candidate) => ownedPolicyRule(record, candidate))) {
      const removed = await command(
        ['policy', 'rm', 'network', '--id', rule.id, '--sandbox', record.sandboxName, '--force'],
        { stage: 'cleanup', command: 'remove-restart-network-policy', includeStderr: true },
      );
      if (removed.exitCode !== 0 || removed.timedOut)
        remember(commandFailure(record, 'policy-remove', 'policy rm', removed));
    }
  }

  if (removeSandbox) {
    const removed = await command(['rm', '--force', record.sandboxName], {
      stage: 'cleanup',
      command: 'remove-restart-sandbox',
      includeStderr: true,
    });
    if (removed.exitCode !== 0 || removed.timedOut) {
      const inspected = await command(
        ['inspect', record.sandboxName, '--json'],
        { stage: 'cleanup', command: 'confirm-restart-sandbox-absent', includeStderr: true },
        { captureStdout: true, captureStderr: true },
      );
      if (!sandboxAbsent(inspected, record.sandboxName))
        remember(commandFailure(record, 'sandbox-remove', 'rm', removed));
    }
  }

  if (record.policyAttempted) {
    const remaining = await listAllNetworkPolicies(command);
    if (!remaining.ok || remaining.rules.some((rule) => rule.sandbox_id === record.sandboxName))
      remember(commandFailure(record, 'policy-verify', 'policy ls', remaining.result));
  }

  if (record.modelSecretAttempted) {
    const removed = await command(
      [
        'secret',
        'rm',
        '--placeholder',
        `cr-${record.jobId}`,
        '--sandbox',
        record.sandboxName,
        '--force',
      ],
      { stage: 'cleanup', command: 'remove-restart-secret', includeStderr: true },
    );
    if (removed.exitCode !== 0 || removed.timedOut)
      remember(commandFailure(record, 'secret-remove', 'secret rm', removed));
  }
  if (record.githubSecretAttempted) {
    const removed = await command(
      ['secret', 'rm', 'github', '--sandbox', record.sandboxName, '--force'],
      { stage: 'cleanup', command: 'remove-restart-github-secret', includeStderr: true },
    );
    if (removed.exitCode !== 0 || removed.timedOut)
      remember(commandFailure(record, 'secret-remove', 'secret rm', removed));
  }
  const secretFailure = await scopedSecretsAbsent(record, command);
  if (secretFailure !== undefined) remember(secretFailure);

  if (removeSandbox) {
    const inspected = await command(
      ['inspect', record.sandboxName, '--json'],
      { stage: 'cleanup', command: 'confirm-restart-sandbox-absent', includeStderr: true },
      { captureStdout: true, captureStderr: true },
    );
    if (!sandboxAbsent(inspected, record.sandboxName))
      remember(commandFailure(record, 'sandbox-verify', 'inspect', inspected));
  }
  return firstFailure;
};

const reconcileSbxRestartResources = async (
  root: string,
  command: SbxCommand,
  isLive: (jobId: string) => boolean = () => false,
): Promise<OrphanReconcileResult> => {
  let names: string[];
  try {
    names = await readdir(root);
  } catch (error) {
    if (Schema.is(Schema.Struct({ code: Schema.Literal('ENOENT') }))(error))
      return { ok: true, recovered: 0, recoveredJobIds: [], failures: [] };
    return {
      ok: false,
      recovered: 0,
      recoveredJobIds: [],
      failures: [{ jobId: 'redacted', sandboxName: 'redacted', step: 'record' }],
    };
  }
  let recovered = 0;
  const recoveredJobIds: string[] = [];
  const failures: SandboxRecoveryFailure[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const record = await readOwnershipRecord(root, name);
    if (record === undefined) {
      failures.push({ jobId: 'redacted', sandboxName: 'redacted', step: 'record' });
      continue;
    }
    if (isLive(record.jobId)) continue;
    const failure = await removeOwnedSbxResources(record, command);
    if (failure !== undefined) {
      failures.push({ jobId: record.jobId, sandboxName: record.sandboxName, ...failure });
      continue;
    }
    try {
      await removeOwnershipRecord(root, record.jobId);
      recovered += 1;
      recoveredJobIds.push(record.jobId);
    } catch {
      failures.push({
        jobId: record.jobId,
        sandboxName: record.sandboxName,
        step: 'record-remove',
      });
    }
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
  if (options.modelSecretCommand === undefined || result.stderr === undefined) return result;
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
  const networkRules: Array<{ resource: string; id?: string }> = [];
  let githubServiceCleanupRequired = false;
  let tokenRoot: string | undefined;
  let tokenPath: string | undefined;
  let activeGithubReadToken = spec.githubReadToken;
  let tokenWriteChain: Promise<void> = Promise.resolve();
  let destroyed = false;
  let created = false;
  let hostCleanupConfirmed = false;
  let ownership: SbxOwnershipRecord | undefined;
  const markOwnership = async (patch: Partial<SbxOwnershipRecord>) => {
    if (ownership === undefined) return;
    ownership = { ...ownership, ...patch };
    if (options.ownershipRoot !== undefined)
      await saveOwnershipRecord(options.ownershipRoot, ownership);
  };
  const metadata = {
    get hostCleanupConfirmed() {
      return hostCleanupConfirmed;
    },
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

  const listPolicies = async (
    command: SbxCommand,
    includeSource: boolean,
    diagnostic: RunnerDiagnostic,
  ) => {
    const listed = await command(
      [
        'policy',
        'ls',
        '--json',
        ...(includeSource ? ['--source', 'local'] : []),
        ...(!includeSource ? ['--include-inactive'] : []),
        '--type',
        'network',
      ],
      diagnostic,
      { captureStdout: true, maxBytes: MAX_POLICY_JSON_BYTES },
    );
    if (listed.exitCode !== 0 || listed.timedOut || listed.truncated) return undefined;
    return networkPolicyRulesFrom(listed.stdout);
  };

  const findRule = async (
    command: SbxCommand,
    expected: { resource: string; id?: string },
  ): Promise<NetworkPolicyRuleValue | undefined> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const rules = await listPolicies(command, true, {
        stage: 'cleanup',
        command: 'inspect-network-policy',
        includeStderr: true,
      });
      if (rules === undefined) continue;
      if (expected.id !== undefined) {
        const exact = rules.find(
          (rule) => rule.id === expected.id && rule.sandbox_id === spec.name,
        );
        if (exact !== undefined) return exact;
        continue;
      }
      const candidates = rules.filter(
        (rule) =>
          rule.editable &&
          rule.sandbox_id === spec.name &&
          rule.resources.includes(expected.resource),
      );
      if (candidates.length === 1) return candidates[0];
    }
    return undefined;
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
    if (options.ownershipRoot !== undefined) {
      ownership = {
        version: 1,
        jobId: spec.id,
        sandboxName: spec.name,
        workspacePath: spec.checkoutRoot,
        configPath: spec.configRoot,
        modelResource: spec.modelResource,
        githubResource: spec.githubResource,
        modelSecretAttempted: false,
        githubSecretAttempted: false,
        createAttempted: false,
        policyAttempted: false,
      };
      await saveOwnershipRecord(options.ownershipRoot, ownership);
    }
    const modelSecretSource =
      spec.modelTokenFile === undefined
        ? (options.modelSecretCommand ?? '')
        : `/usr/bin/cat ${shellQuote(spec.modelTokenFile)}`;
    await markOwnership({ modelSecretAttempted: true });
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

    tokenRoot = await mkdtemp(join(tmpdir(), 'compte-rendu-sbx-token-'));
    tokenPath = join(tokenRoot, 'github-read-token');
    githubServiceCleanupRequired = true;
    await writeActiveGithubToken(activeGithubReadToken);
    await markOwnership({ githubSecretAttempted: true });
    const githubSecret = await command(
      [
        'secret',
        'set',
        'github',
        '--sandbox',
        spec.name,
        '--command',
        `cat ${tokenPath}`,
        '--refresh',
        'on-demand',
      ],
      { stage: 'sandbox', command: 'set-github-service' },
    );
    if (githubSecret.exitCode !== 0 || githubSecret.timedOut) {
      throw new Error('sandbox github secret setup failed');
    }

    await markOwnership({ createAttempted: true });
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

    await markOwnership({ policyAttempted: true });
    for (const [resource, commandName, inspectName] of [
      [spec.modelResource, 'allow-network', 'inspect-network-policy'],
      [spec.githubResource, 'allow-github-network', 'inspect-github-network-policy'],
    ] as const) {
      const rule: { resource: string; id?: string } = { resource };
      networkRules.push(rule);
      const allowed = await command(
        ['policy', 'allow', 'network', '--sandbox', spec.name, resource],
        { stage: 'sandbox', command: commandName, includeStderr: true },
      );
      if (allowed.timedOut) throw new Error('sandbox policy setup timed out');
      if (allowed.exitCode !== 0) {
        networkRules.pop();
        throw new Error('sandbox policy setup failed');
      }
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
      rule.id = matches[0].id;
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
      let clean = true;
      for (const expected of networkRules) {
        const matching = await findRule(command, expected);
        if (matching === undefined) {
          clean = false;
          continue;
        }
        const removed = await command(
          ['policy', 'rm', 'network', '--id', matching.id, '--sandbox', spec.name, '--force'],
          { stage: 'cleanup', command: 'remove-network-policy', includeStderr: true },
        );
        if (removed.exitCode !== 0 || removed.timedOut) clean = false;
      }
      const removed = await command(['rm', '--force', spec.name], {
        stage: 'cleanup',
        command: 'remove-sandbox',
        includeStderr: true,
      });
      if (removed.exitCode !== 0 || removed.timedOut) {
        const inspected = await command(
          ['inspect', spec.name, '--json'],
          { stage: 'cleanup', command: 'confirm-sandbox-absent', includeStderr: true },
          { captureStdout: true, captureStderr: true },
        );
        if (!sandboxAbsent(inspected, spec.name)) clean = false;
      }
      const remaining = await listPolicies(command, false, {
        stage: 'cleanup',
        command: 'inspect-network-policy',
        includeStderr: true,
      });
      if (remaining === undefined || remaining.some((rule) => rule.sandbox_id === spec.name)) {
        clean = false;
      }
      const secret = await command(
        ['secret', 'rm', '--placeholder', placeholder, '--sandbox', spec.name, '--force'],
        { stage: 'cleanup', command: 'remove-secret', includeStderr: true },
      );
      if (secret.exitCode !== 0 || secret.timedOut) clean = false;
      if (githubServiceCleanupRequired) {
        const github = await command(
          ['secret', 'rm', 'github', '--sandbox', spec.name, '--force'],
          {
            stage: 'cleanup',
            command: 'remove-github-secret',
            includeStderr: true,
          },
        );
        if (github.exitCode !== 0 || github.timedOut) clean = false;
      }
      hostCleanupConfirmed = tokenRoot === undefined;
      if (tokenRoot !== undefined) {
        try {
          await rm(tokenRoot, { recursive: true, force: true });
          tokenRoot = undefined;
          tokenPath = undefined;
          hostCleanupConfirmed = true;
        } catch {
          clean = false;
        }
      }
      if (!clean) throw new Error('sbx sandbox cleanup was not confirmed');
      if (ownership !== undefined && options.ownershipRoot !== undefined) {
        try {
          await removeOwnershipRecord(options.ownershipRoot, ownership.jobId);
          ownership = undefined;
        } catch {
          throw new Error('sbx sandbox cleanup was not confirmed');
        }
      }
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

const Policies = Schema.Struct({
  rules: Schema.Array(
    Schema.Struct({
      id: Schema.NonEmptyString,
      sandbox_id: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
      editable: Schema.Boolean,
    }),
  ),
});

const complete = (result: RunnerProcessResult) =>
  !result.timedOut &&
  !result.truncated &&
  !result.stderrTruncated &&
  !result.streamError &&
  !result.processError;

class CleanupRecoveryError extends Schema.TaggedError<CleanupRecoveryError>()(
  'CleanupRecoveryError',
  {},
) {}

/** Recovery never removes a sandbox whose ownership cannot be reconstructed. */
const confirmSbxCleanup = Effect.fn('confirmSbxCleanup')(function* (
  sandboxName: string,
  jobId: string,
  command: SbxCommand,
) {
  const run = (args: readonly string[]) =>
    Effect.tryPromise({
      try: () => command(args, undefined, { captureStdout: true, captureStderr: true }),
      catch: () => new CleanupRecoveryError(),
    });
  const inspect = yield* run(['inspect', sandboxName, '--json']);
  if (!sandboxAbsent(inspect, sandboxName)) {
    return yield* new CleanupRecoveryError();
  }
  const list = Effect.fn('listRecoveryPolicies')(function* () {
    const result = yield* run([
      'policy',
      'ls',
      '--json',
      '--include-inactive',
      '--type',
      'network',
    ]);
    if (!complete(result) || result.exitCode !== 0) return yield* new CleanupRecoveryError();
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Policies))(result.stdout).pipe(
      Effect.mapError(() => new CleanupRecoveryError()),
    );
  });
  const policies = yield* list();
  for (const rule of policies.rules.filter((rule) => rule.sandbox_id === sandboxName)) {
    if (!rule.editable) return yield* new CleanupRecoveryError();
    const removed = yield* run([
      'policy',
      'rm',
      'network',
      '--id',
      rule.id,
      '--sandbox',
      sandboxName,
      '--force',
    ]);
    if (!complete(removed) || removed.exitCode !== 0) return yield* new CleanupRecoveryError();
  }
  if ((yield* list()).rules.some((rule) => rule.sandbox_id === sandboxName))
    return yield* new CleanupRecoveryError();
  for (const args of [
    ['secret', 'rm', '--placeholder', `cr-${jobId}`, '--sandbox', sandboxName, '--force'],
    ['secret', 'rm', 'github', '--sandbox', sandboxName, '--force'],
  ]) {
    const result = yield* run(args);
    if (!complete(result) || result.exitCode !== 0) return yield* new CleanupRecoveryError();
  }
});

export const createSbxSandboxBackend = (context: SandboxBackendContext): SandboxBackend => {
  const program = process.env.RUNNER_SANDBOX_CLI ?? process.env.SBX_BIN ?? 'sbx';
  const modelSecretCommand = context.relayEnabled ? undefined : process.env.MODEL_SECRET_COMMAND;
  if (!context.relayEnabled && modelSecretCommand === undefined) {
    throw new Error(
      'sbx direct mode requires MODEL_SECRET_COMMAND to resolve the model credential',
    );
  }
  const runtimeOptions: SbxRuntimeOptions = {
    program,
    ...(modelSecretCommand === undefined ? {} : { modelSecretCommand }),
    ownershipRoot: context.ownershipRoot,
    onDestroyFailure: async () => {
      if (!(await probeAccess())) health = 'outage';
    },
  };
  let health: SandboxHealth = 'ready';
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
      if (health !== 'outage') return health;
      if (!(await probeAccess())) return 'outage';
      health = 'ready';
      return 'ready';
    },
    async reconcileOrphans({ isLiveJob, onlyJobId }): Promise<OrphanReconcileResult> {
      const result = await reconcileSbxRestartResources(context.ownershipRoot, command, (jobId) =>
        onlyJobId === undefined ? isLiveJob(jobId) : jobId !== onlyJobId || isLiveJob(jobId),
      );
      if (!result.ok && !(await probeAccess())) health = 'outage';
      return result;
    },
    async confirmCleanupAbsent(input: SandboxCleanupConfirmation): Promise<void> {
      await Effect.runPromise(confirmSbxCleanup(input.sandboxName, input.jobId, command));
    },
    createJob(spec: SandboxJobSpec): JobSandbox {
      return createSbxJobSandbox(runtimeOptions, spec);
    },
  };
};
