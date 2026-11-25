import {
  sandboxBackendCheckReady,
  sandboxBackendHealth,
  sandboxBackendReconcileOrphans,
  type SandboxBackend,
  type SandboxRecoveryProof,
} from './sandbox-runtime.js';
import { sandboxResourceIdentity } from './sandbox-resource-name.js';
import type { GrantRevoker } from './grant-revoker.js';
import type { JobRegistry } from './job-registry.js';
import {
  cleanupConfirmedCallbackBody,
  recoverCallback,
  CleanupRecoveryRequest,
} from './callback-recovery.js';
import { deliveryStatusRetryable, type BoundedDelivery } from './evidence-store.js';
import { currentIso } from './runner-clock.js';
import {
  sanitizeOperationalLogEvent,
  type OperationalLog,
  type OperationalLogEvent,
} from '@compte-rendu/contracts';

const CLEANUP_RECOVERY_RETRY_INTERVAL_MS = 30_000;
/** Cheap inventory sweep cadence; age, not this interval, decides removal. */
const SANDBOX_SWEEP_INTERVAL_MS = 10 * 60_000;

type CleanupRecoveryResult = {
  readonly accepted: boolean;
  readonly status: 202 | 409 | 502;
  readonly retryable?: boolean;
  readonly verificationFailed?: boolean;
  readonly sandboxName?: string;
  readonly recoveryProof?: SandboxRecoveryProof;
  readonly error?: string;
};

export interface CleanupReconcilerDependencies {
  readonly backend: SandboxBackend;
  readonly registry: JobRegistry;
  readonly grants: GrantRevoker;
  readonly llmServiceClient: { revoke(jobId: string): Promise<void> } | undefined;
  readonly evidenceRoot: string;
  readonly callbackUrl?: string | undefined;
  readonly callbackToken?: string | undefined;
  readonly postBounded: (url: string, body: string) => Promise<BoundedDelivery>;
  readonly log?: OperationalLog | undefined;
  readonly requestNext: () => void;
  readonly isClosed: () => boolean;
  readonly claimIntervalMs: number;
  readonly onBackendRecovered?: (() => void) | undefined;
  readonly onRetry?: (() => void) | undefined;
}

export const createCleanupReconciler = (deps: CleanupReconcilerDependencies) => {
  const {
    backend: sandboxBackend,
    registry: jobRegistry,
    grants: grantRevoker,
    llmServiceClient,
    evidenceRoot,
    callbackUrl,
    callbackToken,
    postBounded,
    log,
    requestNext,
    isClosed,
    claimIntervalMs,
    onBackendRecovered = () => undefined,
    onRetry = () => undefined,
  } = deps;
  const recoveringCleanup = new Set<string>();
  let reconcilingCleanups = false;
  const recordLog = async (event: OperationalLogEvent) => {
    if (log === undefined) return;
    try {
      await log.record(sanitizeOperationalLogEvent(event));
    } catch {
      // Diagnostics must not change the recovery outcome.
    }
  };
  const recoverRetainedCleanup = async (
    input: CleanupRecoveryRequest,
  ): Promise<CleanupRecoveryResult> => {
    if (callbackUrl === undefined || callbackToken === undefined)
      return {
        accepted: false,
        status: 502,
        retryable: true,
        error: 'cleanup recovery not confirmed',
      };
    if (
      recoveringCleanup.has(input.jobId) ||
      [...jobRegistry.values()].some(
        (job) =>
          (job.state.status === 'queued' || job.state.status === 'running') &&
          (job.id === input.jobId ||
            job.runId === input.runId ||
            job.state.evidenceId === input.evidenceId),
      )
    ) {
      return { accepted: false, status: 409, retryable: true, error: 'job is active' };
    }
    recoveringCleanup.add(input.jobId);
    let verificationFailed = false;
    let sandboxName: string | undefined;
    let recoveryProof: SandboxRecoveryProof | undefined;
    try {
      const recovered = await recoverCallback(evidenceRoot, input, sandboxBackend.kind).catch(
        () => undefined,
      );
      if (recovered === undefined)
        return { accepted: false, status: 409, error: 'cleanup recovery rejected' };
      const manifest = recovered.manifest;
      const exactSandboxName = manifest.sandboxName;
      const identity =
        exactSandboxName === undefined ? undefined : sandboxResourceIdentity(exactSandboxName);
      if (
        exactSandboxName === undefined ||
        identity === undefined ||
        identity.jobId !== input.jobId
      )
        return { accepted: false, status: 409, error: 'cleanup recovery rejected' };
      sandboxName = exactSandboxName;
      recoveryProof = recovered.recoveryProof;
      if (sandboxBackend.confirmCleanupAbsent === undefined)
        return { accepted: false, status: 409, error: 'cleanup recovery rejected' };
      try {
        await sandboxBackend.confirmCleanupAbsent({
          jobId: input.jobId,
          sandboxName,
          recoveryProof,
        });
      } catch (error) {
        verificationFailed = true;
        throw error;
      }
      if (llmServiceClient !== undefined && !(await grantRevoker.revoke(input.jobId, true)))
        throw new Error('grant revocation not confirmed');
      const confirmedAt = currentIso();
      const body = cleanupConfirmedCallbackBody(recovered, confirmedAt);
      if (body === undefined)
        return { accepted: false, status: 502, error: 'cleanup recovery not confirmed' };
      // One real v2 failed callback. Core owns the terminal state and retry
      // semantics; Runner never sends a second cleanup report or replays the
      // original failed callback here.
      const delivery = await postBounded(callbackUrl, body);
      if (delivery.ok) {
        const job = jobRegistry.get(input.jobId);
        if (job !== undefined) {
          Object.assign(job.state, { sandbox: { cleanup: 'destroyed' } });
          if (job.state.status === 'failed' || job.state.status === 'aborted')
            jobRegistry.retireDestroyed(job);
        }
        return { accepted: true, status: 202 };
      }
      const retryable =
        delivery.reason !== 'http-error' || deliveryStatusRetryable(delivery.status);
      if (!retryable) {
        await recordLog({
          phase: 'runner',
          outcome: 'callback',
          runId: input.runId,
          jobId: input.jobId,
          attempt: input.attempt,
          result: 'http-error',
          status: delivery.status ?? 0,
        });
        return {
          accepted: false,
          status: 502,
          error: 'cleanup recovery delivery rejected',
        };
      }
      return {
        accepted: false,
        status: 502,
        retryable: true,
        error: 'cleanup recovery delivery rejected',
      };
    } catch {
      return {
        accepted: false,
        status: 502,
        retryable: true,
        verificationFailed,
        ...(sandboxName === undefined ? {} : { sandboxName }),
        ...(recoveryProof === undefined ? {} : { recoveryProof }),
        error: 'cleanup recovery not confirmed',
      };
    } finally {
      recoveringCleanup.delete(input.jobId);
    }
  };
  // Remove only the exact retained Sandbox. Other resources are skipped, so a
  // foreign or unrelated name is never touched by an automatic retry.
  const removeSandboxForJob = async (
    jobId: string,
    sandboxName: string,
    recoveryProof: SandboxRecoveryProof | undefined,
  ): Promise<boolean> => {
    try {
      const result = await sandboxBackendReconcileOrphans(sandboxBackend, {
        isLiveJob: () => false,
        only: { jobId, sandboxName, ...(recoveryProof === undefined ? {} : { recoveryProof }) },
      });
      return result.ok;
    } catch {
      return false;
    }
  };
  const reconcileFailedCleanups = async (): Promise<boolean> => {
    if (reconcilingCleanups) return false;
    reconcilingCleanups = true;
    let acceptedAny = false;
    try {
      // Snapshot because a confirmed recovery retires its job from the map. A
      // job still cleaning up keeps its pending flag until its terminal evidence
      // and retained callback exist; concurrent polling must not clear it.
      const now = Date.now();
      const candidates = [...jobRegistry.values()].filter(
        (job) =>
          job.cleanupRecoveryPending &&
          job.state.status !== 'queued' &&
          job.state.status !== 'running' &&
          job.state.sandbox.cleanup !== 'destroyed' &&
          (job.cleanupRecoveryRetryAt ?? 0) <= now,
      );
      for (const job of candidates) {
        if (isClosed()) break;
        const result = await recoverRetainedCleanup({
          evidenceId: job.state.evidence.id,
          jobId: job.id,
          runId: job.runId,
          attempt: job.attempt,
          baseSha: job.baseSha,
          headSha: job.headSha,
        });
        if (result.accepted) {
          acceptedAny = true;
          job.cleanupRecoveryPending = false;
          job.cleanupRecoveryRetryAt = undefined;
        } else if (result.retryable !== true) {
          job.cleanupRecoveryPending = false;
          job.cleanupRecoveryRetryAt = undefined;
        } else {
          if (result.verificationFailed === true && result.sandboxName !== undefined && !isClosed())
            await removeSandboxForJob(job.id, result.sandboxName, result.recoveryProof);
          job.cleanupRecoveryRetryAt = Date.now() + CLEANUP_RECOVERY_RETRY_INTERVAL_MS;
        }
      }
      return acceptedAny;
    } finally {
      reconcilingCleanups = false;
    }
  };
  let sandboxRecoveryTimer: ReturnType<typeof setTimeout> | undefined;
  let retrySandboxRecovery = () => {};
  const recordRecoveryLog = async (event: OperationalLogEvent) => {
    if (log === undefined) return;
    try {
      await log.record(sanitizeOperationalLogEvent(event));
    } catch {
      // Diagnostics must not change the recovery outcome.
    }
  };
  const idleRecovery = {
    ok: true,
    recovered: 0,
    recoveredJobIds: [] as readonly string[],
    failures: [] as readonly {
      readonly jobId: string;
      readonly sandboxName: string;
      readonly step: string;
    }[],
  };
  let sandboxRecovered: boolean | undefined;
  const scheduleSandboxRecoveryRetry = () => {
    if (isClosed() || sandboxRecoveryTimer !== undefined) return;
    sandboxRecoveryTimer = setTimeout(() => {
      sandboxRecoveryTimer = undefined;
      retrySandboxRecovery();
    }, CLEANUP_RECOVERY_RETRY_INTERVAL_MS);
    if (typeof sandboxRecoveryTimer === 'object' && sandboxRecoveryTimer !== null)
      sandboxRecoveryTimer.unref?.();
  };
  const isLiveCleanupOwner = (jobId: string) => jobRegistry.isLive(jobId, isClosed());
  const runSandboxRecovery = () => {
    sandboxRecovered = undefined;
    const recovery =
      sandboxBackend.reconcileOrphans === undefined
        ? Promise.resolve(idleRecovery)
        : sandboxBackendReconcileOrphans(sandboxBackend, { isLiveJob: isLiveCleanupOwner });
    return recovery
      .then(async (result) => {
        sandboxRecovered = result.ok;
        for (const jobId of result.recoveredJobIds) {
          const job = jobRegistry.get(jobId);
          if (job === undefined) continue;
          const recovered = await recoverRetainedCleanup({
            evidenceId: job.state.evidence.id,
            jobId: job.id,
            runId: job.runId,
            attempt: job.attempt,
            baseSha: job.baseSha,
            headSha: job.headSha,
          });
          if (recovered.accepted || recovered.retryable !== true) {
            job.cleanupRecoveryPending = false;
            job.cleanupRecoveryRetryAt = undefined;
          } else {
            job.cleanupRecoveryPending = true;
            job.cleanupRecoveryRetryAt = Date.now() + CLEANUP_RECOVERY_RETRY_INTERVAL_MS;
            scheduleDeferredCleanupRecovery();
          }
        }
        if (!result.ok) {
          void recordRecoveryLog({
            phase: 'runner',
            outcome: 'sandbox-recovery',
            recovered: result.recovered,
            blocked: result.failures.length,
            failures: result.failures.slice(0, 10),
          });
          scheduleSandboxRecoveryRetry();
        } else if (sandboxRecoveryTimer !== undefined) {
          clearTimeout(sandboxRecoveryTimer);
          sandboxRecoveryTimer = undefined;
        }
        return result.ok;
      })
      .catch(() => {
        sandboxRecovered = false;
        void recordRecoveryLog({
          phase: 'runner',
          outcome: 'sandbox-recovery',
          recovered: 0,
          blocked: 1,
          failures: [{ jobId: 'redacted', sandboxName: 'redacted', step: 'record' }],
        });
        scheduleSandboxRecoveryRetry();
        return false;
      });
  };
  let sandboxRecoveryInFlight: Promise<boolean> | undefined;
  let sandboxRecoveryAgain = false;
  const startSandboxRecovery = (): Promise<boolean> => {
    if (sandboxRecoveryInFlight !== undefined) {
      sandboxRecoveryAgain = true;
      return sandboxRecoveryInFlight;
    }
    const run = runSandboxRecovery();
    sandboxRecoveryInFlight = run;
    void run.finally(() => {
      if (sandboxRecoveryInFlight !== run) return;
      sandboxRecoveryInFlight = undefined;
      if (sandboxRecoveryAgain) {
        sandboxRecoveryAgain = false;
        if (!isClosed()) void startSandboxRecovery();
      }
    });
    return run;
  };
  void startSandboxRecovery();
  let sandboxSweepTimer: ReturnType<typeof setTimeout> | undefined;
  const schedulePeriodicSandboxSweep = () => {
    if (isClosed()) return;
    sandboxSweepTimer = setTimeout(() => {
      sandboxSweepTimer = undefined;
      if (isClosed()) return;
      void startSandboxRecovery().finally(schedulePeriodicSandboxSweep);
    }, SANDBOX_SWEEP_INTERVAL_MS);
    if (typeof sandboxSweepTimer === 'object' && sandboxSweepTimer !== null)
      sandboxSweepTimer.unref?.();
  };
  schedulePeriodicSandboxSweep();
  retrySandboxRecovery = () => {
    if (isClosed() || sandboxRecovered !== false) return;
    onRetry();
    const run = startSandboxRecovery();
    void run.then((recovered) => {
      if (recovered) requestNext();
    });
  };
  let deferredCleanupRecoveryTimer: ReturnType<typeof setTimeout> | undefined;
  const makePendingCleanupRecoveryEligible = () => {
    const now = Date.now();
    for (const job of jobRegistry.values()) {
      if (job.cleanupRecoveryPending) job.cleanupRecoveryRetryAt = now;
    }
  };
  const scheduleDeferredCleanupRecovery = () => {
    if (isClosed() || deferredCleanupRecoveryTimer !== undefined) return;
    const timer = setTimeout(() => {
      deferredCleanupRecoveryTimer = undefined;
      void runDeferredCleanupRecovery();
    }, claimIntervalMs);
    if (typeof timer === 'object' && timer !== null) timer.unref?.();
    deferredCleanupRecoveryTimer = timer;
  };
  const runDeferredCleanupRecovery = async () => {
    if (isClosed()) return;
    if (reconcilingCleanups) {
      scheduleDeferredCleanupRecovery();
      return;
    }
    let needsRecovery = [...jobRegistry.values()].some((job) => job.cleanupRecoveryPending);
    if (sandboxBackendHealth(sandboxBackend) === 'outage') {
      const ready = await sandboxBackendCheckReady(sandboxBackend);
      if (ready !== 'ready') {
        scheduleDeferredCleanupRecovery();
        return;
      }
      onBackendRecovered();
      makePendingCleanupRecoveryEligible();
      needsRecovery = true;
    }
    if (!needsRecovery) return;
    const accepted = await reconcileFailedCleanups();
    if (accepted) requestNext();
    if (
      sandboxBackendHealth(sandboxBackend) === 'outage' ||
      [...jobRegistry.values()].some((job) => job.cleanupRecoveryPending)
    )
      scheduleDeferredCleanupRecovery();
  };

  return {
    recover: recoverRetainedCleanup,
    reconcileFailed: reconcileFailedCleanups,
    scheduleDeferred: scheduleDeferredCleanupRecovery,
    makeEligible: makePendingCleanupRecoveryEligible,
    retry: retrySandboxRecovery,
    recovered: () => sandboxRecovered,
    recoveringCount: () => recoveringCleanup.size,
    pendingCount: () =>
      [...jobRegistry.values()].filter((job) => job.cleanupRecoveryPending).length,
    async close() {
      if (sandboxRecoveryTimer !== undefined) {
        clearTimeout(sandboxRecoveryTimer);
        sandboxRecoveryTimer = undefined;
      }
      if (sandboxSweepTimer !== undefined) {
        clearTimeout(sandboxSweepTimer);
        sandboxSweepTimer = undefined;
      }
      if (deferredCleanupRecoveryTimer !== undefined) {
        clearTimeout(deferredCleanupRecoveryTimer);
        deferredCleanupRecoveryTimer = undefined;
      }
      await sandboxRecoveryInFlight?.catch(() => undefined);
    },
  };
};

export type CleanupReconciler = ReturnType<typeof createCleanupReconciler>;
