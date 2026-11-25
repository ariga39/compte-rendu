import type { ChildProcess } from 'node:child_process';
import { SandboxRuntimeKind, type RunnerProcessErrorCode } from '@compte-rendu/contracts';
import { createMicrosandboxSandboxBackend } from './sandbox-runtime-microsandbox.js';
import { createSbxSandboxBackend } from './sandbox-runtime-sbx.js';

export { SandboxRuntimeKind };

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
 * Instance-level host process port supplied to a backend once at construction.
 * Backends own their executable path and minimal environment; the Runner owns
 * byte bounds, abort wiring, redaction and diagnostics.
 */
export type HostRun = (
  program: string,
  args: readonly string[],
  options?: RunnerProcessOptions,
  diagnostic?: RunnerDiagnostic,
) => Promise<RunnerProcessResult>;

/**
 * Per-stage sandbox command port. It carries the current phase's deadline,
 * abort signal, credential observation and diagnostic logging.
 */
export interface SandboxExecPort {
  run: HostRun;
}

/**
 * The identity and host paths a per-job sandbox needs. Backend command paths,
 * images, secret placeholders, network rules and cleanup bookkeeping stay
 * inside each backend; the Runner only supplies job facts.
 */
export interface SandboxJobSpec {
  /** Immutable Runner Job id/attempt identity used to derive unique resource names. */
  readonly id: string;
  readonly name: string;
  readonly cpu: string;
  /** Memory limit in GiB; each backend formats the required unit. */
  readonly memoryGib: number;
  /** Environment pairs (KEY=VALUE) applied to every process in the sandbox. */
  readonly env: readonly string[];
  /** Host checkout directory to stage into the sandbox. */
  readonly checkoutRoot: string;
  /** Host configuration directory to stage into the sandbox. */
  readonly configRoot: string;
  /**
   * Runner-owned, host-only scratch root for this job. It must not be mounted
   * into the sandbox and must not be inside `checkoutRoot` or `configRoot`.
   * Backends place host-only credential files here and leave recursive removal
   * to the Runner's bounded job-scratch cleanup.
   */
  readonly hostScratchRoot: string;
  readonly modelResource: string;
  /**
   * Absolute host path to a private mode-0600 file holding the job's model
   * grant token. Backends that proxy credentials on the host keep it out of the
   * guest, command line, configuration and evidence.
   */
  readonly modelTokenFile?: string;
  readonly githubResource: string;
  /** Per-job GitHub read token; backends pass it via child env, never argv. */
  readonly githubReadToken: string;
}

/** Backend-private proof needed to confirm an already recorded cleanup. */
export type SandboxRecoveryProof = Readonly<Record<string, string>>;

export interface SandboxRuntimeMetadata {
  /** True as soon as the sandbox resource exists, even if later setup steps fail. */
  readonly created: boolean;
  readonly hostCleanupConfirmed?: boolean;
  /** Backend sandbox identity (sbx uses the requested name). */
  readonly id: string;
  readonly name: string;
  readonly runtime: SandboxRuntimeKind;
  readonly imageRef: string;
  /** In-sandbox evidence path for this backend. */
  readonly evidenceRoot: string;
  /** Opaque backend evidence used later by the same backend to prove absence. */
  readonly recoveryProof?: SandboxRecoveryProof | undefined;
}

/**
 * A per-job sandbox. It is created before `setup` so a throw during partial
 * setup still has cleanup state, and it owns all backend-specific naming,
 * credentials and host resources.
 */
export interface JobSandbox {
  readonly metadata: SandboxRuntimeMetadata;
  setup(exec: SandboxExecPort): Promise<void>;
  exec(
    args: readonly string[],
    exec: SandboxExecPort,
    options?: RunnerProcessOptions,
    diagnostic?: RunnerDiagnostic,
  ): Promise<RunnerProcessResult>;
  copyOut(
    sandboxPath: string,
    localPath: string,
    exec: SandboxExecPort,
    diagnostic?: RunnerDiagnostic,
    options?: RunnerProcessOptions,
  ): Promise<RunnerProcessResult>;
  /**
   * Replaces the active GitHub read credential at the same sandbox-scoped
   * destination. Backends without an atomically updateable destination omit
   * this, and the Runner keeps the initial credential's hard expiry cap.
   */
  updateGithubReadToken?(token: string): Promise<void>;
  /** Removes every owned resource and confirms the sandbox identity is gone; rejects otherwise. */
  destroy(exec: SandboxExecPort): Promise<void>;
}

export type SandboxHealth = 'ready' | 'unready' | 'outage';

/**
 * A backend-defined recovery step used only in diagnostics. Keeping this open
 * lets a TTL-based backend report its own short labels without implementing
 * every backend-specific sub-step that exists in another adapter.
 */
export type SandboxRecoveryStep = string;

export interface SandboxRecoveryFailure {
  readonly jobId: string;
  readonly sandboxName: string;
  readonly step: SandboxRecoveryStep;
  readonly command?: string;
  readonly exitCode?: number;
  readonly timedOut?: boolean;
  readonly truncated?: boolean;
  readonly stderrTruncated?: boolean;
  readonly streamError?: boolean;
  readonly processError?: boolean;
  readonly errorCode?: RunnerProcessResult['errorCode'];
}

export interface OrphanReconcileResult {
  readonly ok: boolean;
  readonly recovered: number;
  readonly recoveredJobIds: readonly string[];
  readonly failures: readonly SandboxRecoveryFailure[];
}

export interface OrphanReconcileInput {
  readonly isLiveJob: (jobId: string) => boolean;
  /** Restrict this scan to one retained job; other ownership records are skipped. */
  readonly onlyJobId?: string;
}

export interface SandboxCleanupConfirmation {
  readonly jobId: string;
  readonly sandboxName: string;
  readonly recoveryProof?: SandboxRecoveryProof | undefined;
}

/**
 * A process-lifetime sandbox backend. It owns configuration validation,
 * readiness/outage state, ownership records and orphan reconciliation. A new
 * backend only implements this interface and adds one registry entry below.
 * Readiness and recovery hooks are optional so a backend with native expiry
 * does not need no-op plumbing.
 */
export interface SandboxBackend {
  readonly kind: string;
  /** Synchronous, no-I/O view used by maintenance and claim-race checks. */
  health?(): SandboxHealth;
  /** Bounded readiness check used before claim and by cleanup retries. */
  checkReady?(): Promise<SandboxHealth>;
  reconcileOrphans?(input: OrphanReconcileInput): Promise<OrphanReconcileResult>;
  /** Proves a recorded sandbox and its scoped host resources are absent. */
  confirmCleanupAbsent?(input: SandboxCleanupConfirmation): Promise<void>;
  createJob(spec: SandboxJobSpec): JobSandbox;
}

const idleOrphanReconcileResult: OrphanReconcileResult = {
  ok: true,
  recovered: 0,
  recoveredJobIds: [],
  failures: [],
};

/** A backend without a readiness hook is always ready. */
export const sandboxBackendHealth = (backend: SandboxBackend): SandboxHealth =>
  backend.health?.() ?? 'ready';

/** A backend without a readiness check needs no pre-claim probe. */
export const sandboxBackendCheckReady = async (backend: SandboxBackend): Promise<SandboxHealth> =>
  backend.checkReady === undefined ? 'ready' : backend.checkReady();

/** A backend without ownership records has nothing to reconcile. */
export const sandboxBackendReconcileOrphans = async (
  backend: SandboxBackend,
  input: OrphanReconcileInput,
): Promise<OrphanReconcileResult> =>
  backend.reconcileOrphans === undefined
    ? idleOrphanReconcileResult
    : backend.reconcileOrphans(input);

export interface SandboxBackendContext {
  readonly hostRun: HostRun;
  readonly ownershipRoot: string;
  readonly relayEnabled: boolean;
}

export interface SandboxBackendRegistration {
  readonly kind: string;
  readonly create: (context: SandboxBackendContext) => SandboxBackend;
}

const SANDBOX_BACKEND_REGISTRATIONS: readonly SandboxBackendRegistration[] = [
  { kind: 'sbx', create: createSbxSandboxBackend },
  { kind: 'microsandbox', create: createMicrosandboxSandboxBackend },
];

export interface SandboxBackendSelection {
  readonly kind?: string | undefined;
}

const nonEmpty = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
};

/**
 * Plugin registration. Configuration and backend-specific requirements fail
 * inside the selected backend before the Runner claims or admits work.
 */
export const createSandboxBackend = (
  selection: SandboxBackendSelection,
  context: SandboxBackendContext,
): SandboxBackend => {
  const requested = nonEmpty(selection.kind) ?? SANDBOX_BACKEND_REGISTRATIONS[0]!.kind;
  const registration = SANDBOX_BACKEND_REGISTRATIONS.find(
    (candidate) => candidate.kind === requested,
  );
  if (registration === undefined) {
    const supported = SANDBOX_BACKEND_REGISTRATIONS.map((candidate) => `'${candidate.kind}'`).join(
      ', ',
    );
    throw new Error(`RUNNER_SANDBOX_RUNTIME must be one of ${supported}, received '${requested}'`);
  }
  return registration.create(context);
};

/** Carries the create invocation's terminal cause so the Runner can report it. */
export class SandboxCreateError extends Error {
  constructor(readonly timedOut: boolean) {
    super('sandbox create failed');
    this.name = 'SandboxCreateError';
  }
}
