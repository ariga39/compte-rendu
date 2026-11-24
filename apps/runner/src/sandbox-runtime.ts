import type { ChildProcess } from 'node:child_process';
import { Option, Schema } from 'effect';
import { SandboxRuntimeKind, type RunnerProcessErrorCode } from '@compte-rendu/contracts';

export { SandboxRuntimeKind };

/** Backends this Runner build can construct. The public contract stays open. */
export const ActiveSandboxRuntimeKind = Schema.Literals(['sbx', 'microsandbox']);
export type ActiveSandboxRuntimeKind = Schema.Schema.Type<typeof ActiveSandboxRuntimeKind>;

export interface SandboxRuntimeConfig {
  readonly kind: ActiveSandboxRuntimeKind;
  readonly cliPath: string;
  readonly microsandboxImage?: string;
}

export interface SandboxRuntimeConfigInput {
  readonly kind?: string | undefined;
  readonly cliPath?: string | undefined;
  readonly microsandboxImage?: string | undefined;
}

const nonEmpty = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
};

export const resolveSandboxRuntimeConfig = (
  input: SandboxRuntimeConfigInput,
): SandboxRuntimeConfig => {
  const requested = nonEmpty(input.kind) ?? 'sbx';
  const decoded = Schema.decodeUnknownOption(ActiveSandboxRuntimeKind)(requested);
  if (Option.isNone(decoded)) {
    throw new Error(
      `RUNNER_SANDBOX_RUNTIME must be 'sbx' or 'microsandbox', received '${requested}'`,
    );
  }
  const kind = decoded.value;
  if (kind === 'microsandbox') {
    const image = nonEmpty(input.microsandboxImage);
    if (!image) throw new Error('Microsandbox requires MICROSANDBOX_IMAGE');
    return { kind, cliPath: nonEmpty(input.cliPath) ?? 'msb', microsandboxImage: image };
  }
  return { kind, cliPath: nonEmpty(input.cliPath) ?? 'sbx' };
};

export type RunnerProcessResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr?: string;
  readonly stderrTruncated?: boolean;
  /** A real job credential was observed before output redaction. */
  readonly credentialObserved?: boolean;
  readonly streamError?: boolean;
  readonly timedOut: boolean;
  readonly truncated: boolean;
  /**
   * True when the process could not be spawned or its invocation threw, as
   * opposed to running and returning an exit status. Diagnostics report this
   * plus an optional allowlisted errorCode; never the raw error message.
   */
  readonly processError?: boolean;
  readonly errorCode?: RunnerProcessErrorCode;
};

export type RunnerProcessOptions = {
  readonly signal?: AbortSignal;
  readonly captureStdout?: boolean;
  readonly captureStderr?: boolean;
  readonly stderrRedactions?: readonly string[];
  /** Real job credentials to detect in raw output before redaction. */
  readonly credentialValues?: readonly string[];
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
 * A runtime invocation, owned by the Runner so that deadlines, abort
 * wiring, environment stripping, redaction and diagnostics stay in one place.
 * CLI adapters build argv; the Runner owns the command port.
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
   * `/usr/bin/cat <path>` instead of a host secret resolver. microsandbox supplies this value
   * to the host CLI environment for TLS injection. Keep it out of the guest,
   * command line, configuration and evidence.
   */
  readonly modelTokenFile?: string;
  readonly githubResource: string;
  /** Per-job GitHub read token; adapters pass it via child env, never argv. */
  readonly githubReadToken: string;
}

export interface SandboxRuntimeMetadata {
  /** True as soon as the sandbox resource exists, even if later setup steps fail. */
  readonly created: boolean;
  readonly catalogIdentity?: string | undefined;
  readonly hostCleanupConfirmed?: boolean;
  /** Backend sandbox identity (sbx uses the requested name). */
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
  /**
   * Replaces the active GitHub read credential at the same sandbox-scoped
   * destination. Backends without an atomically updateable destination omit
   * this, and the Runner keeps the initial credential's hard expiry cap.
   */
  rotateGithubReadToken?(token: string): Promise<void>;
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
