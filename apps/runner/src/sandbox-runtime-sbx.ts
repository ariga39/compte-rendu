import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Option, Schema } from 'effect';
import type {
  JobSandboxRuntime,
  RunnerDiagnostic,
  RunnerProcessOptions,
  RunnerProcessResult,
  SandboxCommand,
  SandboxJobSpec,
  SandboxRuntimeFactory,
} from './sandbox-runtime.js';
import { SandboxCreateError } from './sandbox-runtime.js';

const MAX_POLICY_JSON_BYTES = 256 * 1024;
const SBX_MODEL_ENV = 'OPENCODE_API_KEY';
const SBX_LAUNCHER = 'shell';
const SBX_EVIDENCE_ROOT = '/tmp/petit-chiba-opencode-evidence';

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

export interface SbxRuntimeOptions {
  /** Host command that resolves the model API key; runs only in the sbx adapter. */
  readonly modelSecretCommand?: string;
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

export const createSbxRuntimeFactory = (options: SbxRuntimeOptions): SandboxRuntimeFactory => {
  return (spec: SandboxJobSpec): JobSandboxRuntime => {
    const placeholder = `cr-${spec.id}`;
    const modelHost = spec.modelResource.replace(/:\d+$/, '');
    const networkRules: Array<{ resource: string; id?: string }> = [];
    let githubServiceCleanupRequired = false;
    let tokenRoot: string | undefined;
    let created = false;
    const metadata = {
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
        return spec.imageRef;
      },
      get evidenceRoot() {
        return SBX_EVIDENCE_ROOT;
      },
    };

    const listPolicies = async (
      command: SandboxCommand,
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
      command: SandboxCommand,
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

    const setup = async (command: SandboxCommand) => {
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

      tokenRoot = await mkdtemp(join(tmpdir(), 'compte-rendu-sbx-token-'));
      const tokenPath = join(tokenRoot, 'github-read-token');
      await writeFile(tokenPath, spec.githubReadToken, { mode: 0o600 });
      githubServiceCleanupRequired = true;
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

      const create = await command(
        [
          'create',
          '--clone',
          '--no-share-skills',
          '--template',
          spec.imageRef,
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
      command: SandboxCommand,
      processOptions?: RunnerProcessOptions,
      diagnostic?: RunnerDiagnostic,
    ): Promise<RunnerProcessResult> =>
      command(['exec', spec.name, ...args], diagnostic, processOptions);

    const copyOut = (
      sandboxPath: string,
      localPath: string,
      command: SandboxCommand,
      diagnostic?: RunnerDiagnostic,
      processOptions?: RunnerProcessOptions,
    ): Promise<RunnerProcessResult> =>
      command(['cp', `${spec.name}:${sandboxPath}`, localPath], diagnostic, processOptions);

    const destroy = async (command: SandboxCommand) => {
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
      if (removed.exitCode !== 0 || removed.timedOut) clean = false;
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
          { stage: 'cleanup', command: 'remove-github-secret', includeStderr: true },
        );
        if (github.exitCode !== 0 || github.timedOut) clean = false;
      }
      if (tokenRoot !== undefined) {
        try {
          await rm(tokenRoot, { recursive: true, force: true });
        } catch {
          clean = false;
        }
      }
      if (!clean) throw new Error('sbx sandbox cleanup was not confirmed');
    };

    return { metadata, setup, exec, copyOut, destroy };
  };
};
