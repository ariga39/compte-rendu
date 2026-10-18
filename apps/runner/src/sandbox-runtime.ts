import type { ChildProcess } from 'node:child_process';
import { Option, Schema } from 'effect';

export const SandboxRuntimeKind = Schema.Literals(['sbx', 'openshell']);
export type SandboxRuntimeKind = Schema.Schema.Type<typeof SandboxRuntimeKind>;

export interface OpenShellRuntimeConfig {
  readonly gateway?: string;
  readonly gatewayEndpoint?: string;
  readonly modelProvider: string;
  readonly image: string;
  readonly githubProfile: string;
  readonly insecure: boolean;
}

export interface SandboxRuntimeConfig {
  readonly kind: SandboxRuntimeKind;
  readonly cliPath: string;
  readonly openshell?: OpenShellRuntimeConfig;
}

export interface SandboxRuntimeConfigInput {
  readonly kind?: string | undefined;
  readonly cliPath?: string | undefined;
  readonly openshellGateway?: string | undefined;
  readonly openshellEndpoint?: string | undefined;
  readonly openshellModelProvider?: string | undefined;
  readonly openshellImage?: string | undefined;
  readonly openshellGithubProfile?: string | undefined;
  readonly openshellInsecure?: string | boolean | undefined;
}

const nonEmpty = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
};

const isEnabled = (value: string | boolean | undefined): boolean =>
  value === true ||
  (typeof value === 'string' && ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase()));

export const resolveSandboxRuntimeConfig = (
  input: SandboxRuntimeConfigInput,
): SandboxRuntimeConfig => {
  const requested = nonEmpty(input.kind) ?? 'sbx';
  const decoded = Schema.decodeUnknownOption(SandboxRuntimeKind)(requested);
  if (Option.isNone(decoded)) {
    throw new Error(
      `RUNNER_SANDBOX_RUNTIME must be one of 'sbx' or 'openshell', received '${requested}'`,
    );
  }
  const kind = decoded.value;
  const cliPath = nonEmpty(input.cliPath) ?? (kind === 'openshell' ? 'openshell' : 'sbx');
  if (kind === 'sbx') return { kind, cliPath };

  const gateway = nonEmpty(input.openshellGateway);
  const gatewayEndpoint = nonEmpty(input.openshellEndpoint);
  if (gateway === undefined && gatewayEndpoint === undefined) {
    throw new Error(
      'OpenShell sandbox runtime requires a named gateway (OPENSHELL_GATEWAY) or an explicit endpoint (OPENSHELL_GATEWAY_ENDPOINT)',
    );
  }
  const modelProvider = nonEmpty(input.openshellModelProvider);
  if (modelProvider === undefined) {
    throw new Error(
      'OpenShell sandbox runtime requires OPENSHELL_MODEL_PROVIDER (or openshell.modelProvider)',
    );
  }
  const image = nonEmpty(input.openshellImage);
  if (image === undefined) {
    throw new Error(
      'OpenShell sandbox runtime requires OPENSHELL_IMAGE (or openshell.image); the sbx template reference is never reused',
    );
  }
  return {
    kind,
    cliPath,
    openshell: {
      ...(gateway === undefined ? {} : { gateway }),
      ...(gatewayEndpoint === undefined ? {} : { gatewayEndpoint }),
      modelProvider,
      image,
      githubProfile: nonEmpty(input.openshellGithubProfile) ?? 'cr-github',
      insecure: isEnabled(input.openshellInsecure),
    },
  };
};

export type RunnerProcessResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr?: string;
  readonly stderrTruncated?: boolean;
  readonly streamError?: boolean;
  readonly timedOut: boolean;
  readonly truncated: boolean;
};

export type RunnerProcessOptions = {
  readonly captureStdout?: boolean;
  readonly captureStderr?: boolean;
  readonly stderrRedactions?: readonly string[];
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdoutFilePath?: string;
  readonly stderrFilePath?: string;
  readonly fileAppend?: boolean;
  readonly onChild?: (child: ChildProcess) => void;
};

export type RunnerProcess = (
  command: string,
  args: readonly string[],
  options?: RunnerProcessOptions,
) => Promise<RunnerProcessResult>;

export type RunnerDiagnostic = {
  readonly stage: 'checkout' | 'sandbox' | 'cleanup';
  readonly command: string;
  readonly includeStderr?: boolean;
};

/**
 * One runtime CLI invocation, owned by the Runner so that deadlines, abort
 * wiring, environment stripping, redaction and diagnostics stay in one place.
 * Adapters build argv and interpret results; they never manage budgets.
 */
export type SandboxCommand = (
  args: readonly string[],
  diagnostic?: RunnerDiagnostic,
  options?: RunnerProcessOptions,
) => Promise<RunnerProcessResult>;

/**
 * The identity and host paths a per-job runtime needs. Provider names, secret
 * placeholders, network-rule state and cleanup bookkeeping stay inside the
 * runtime's own closure; the Runner only knows this metadata.
 */
export interface SandboxJobSpec {
  /** Immutable Runner Job id/attempt identity used to derive unique resource names. */
  readonly id: string;
  readonly name: string;
  readonly imageRef: string;
  readonly cpu: string;
  /** Memory limit in GiB; each adapter formats the backend-required unit. */
  readonly memoryGib: number;
  /** Environment pairs (KEY=VALUE) applied to every process in the sandbox. */
  readonly env: readonly string[];
  /** Host checkout directory to stage into the sandbox. */
  readonly checkoutRoot: string;
  /** Host configuration directory to stage into the sandbox. */
  readonly configRoot: string;
  readonly modelResource: string;
  /**
   * Absolute host path to a private mode-0600 file holding the job's model
   * grant token. When set, the sbx adapter resolves the model secret with
   * `/usr/bin/cat <path>` instead of a host secret resolver. The token itself
   * never appears in argv, environment, configuration or evidence.
   */
  readonly modelTokenFile?: string;
  readonly githubResource: string;
  /** Per-job GitHub read token; adapters pass it via child env, never argv. */
  readonly githubReadToken: string;
}

export interface SandboxRuntimeMetadata {
  /** True as soon as the sandbox resource exists, even if later setup steps fail. */
  readonly created: boolean;
  /** Backend sandbox identity (sbx uses the requested name; OpenShell the real id). */
  readonly id: string;
  readonly name: string;
  readonly runtime: SandboxRuntimeKind;
  readonly imageRef: string;
  /** In-sandbox evidence path for this backend. */
  readonly evidenceRoot: string;
}

/**
 * A per-job runtime object. It is created before `setup` so a throw during
 * partial setup still has cleanup state, and it owns all runtime-specific
 * naming and resources. `command` is the Runner-owned CLI port that carries
 * deadlines, abort wiring, redaction and diagnostics.
 */
export interface JobSandboxRuntime {
  readonly metadata: SandboxRuntimeMetadata;
  setup(command: SandboxCommand): Promise<void>;
  exec(
    args: readonly string[],
    command: SandboxCommand,
    options?: RunnerProcessOptions,
    diagnostic?: RunnerDiagnostic,
  ): Promise<RunnerProcessResult>;
  copyOut(
    sandboxPath: string,
    localPath: string,
    command: SandboxCommand,
    diagnostic?: RunnerDiagnostic,
    options?: RunnerProcessOptions,
  ): Promise<RunnerProcessResult>;
  /** Removes every owned resource and confirms the sandbox identity is gone; rejects otherwise. */
  destroy(command: SandboxCommand): Promise<void>;
}

export type SandboxRuntimeFactory = (spec: SandboxJobSpec) => JobSandboxRuntime;

/** Carries the create invocation's terminal cause so the Runner can report it. */
export class SandboxCreateError extends Error {
  constructor(readonly timedOut: boolean) {
    super('sandbox create failed');
    this.name = 'SandboxCreateError';
  }
}
