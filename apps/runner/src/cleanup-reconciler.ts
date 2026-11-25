import { join } from 'node:path';
import { Option, Effect } from 'effect';
import type { SandboxBackend } from './sandbox-runtime.js';
import type { GrantRevoker } from './grant-revoker.js';
import type { JobRegistry } from './job-registry.js';
import { recoverCallback, ReplayCallbackRequest } from './callback-recovery.js';
import {
  deliveryStatusRetryable,
  writeManifestAtomically,
  type BoundedDelivery,
} from './evidence-store.js';
import { currentIso } from './runner-clock.js';
import {
  sanitizeOperationalLogEvent,
  type OperationalLog,
  type OperationalLogEvent,
} from '@compte-rendu/contracts';

const CLEANUP_RECOVERY_RETRY_INTERVAL_MS = 30_000;

type CleanupRecoveryResult = {
  readonly accepted: boolean;
  readonly status: 202 | 409 | 502;
  readonly retryable?: boolean;
  readonly verificationFailed?: boolean;
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
    input: ReplayCallbackRequest,
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
    try {
      const recovered = await Effect.runPromise(
        recoverCallback(evidenceRoot, input, { cleanupRuntime: sandboxBackend.kind }).pipe(
          Effect.option,
        ),
      );
      if (Option.isNone(recovered))
        return { accepted: false, status: 409, error: 'cleanup recovery rejected' };
      const manifest = recovered.value.manifest;
      const sandboxName = manifest.sandboxName ?? `compte-rendu-${input.jobId}`;
      if (sandboxBackend.confirmCleanupAbsent === undefined)
        return { accepted: false, status: 409, error: 'cleanup recovery rejected' };
      try {
        await sandboxBackend.confirmCleanupAbsent({
          jobId: input.jobId,
          sandboxName,
          recoveryProof: recovered.value.recoveryProof,
        });
      } catch (error) {
        verificationFailed = true;
        throw error;
      }
      if (llmServiceClient !== undefined && !(await grantRevoker.revoke(input.jobId, true)))
        throw new Error('grant revocation not confirmed');
      const report = { ...input, sandboxName, confirmedAt: currentIso() };
      await writeManifestAtomically(
        join(evidenceRoot, input.evidenceId, 'cleanup-recovery.json'),
        report,
      );
      const reportUrl = new URL('/runner-cleanup-recovery', callbackUrl).href;
      const reportBody = JSON.stringify(report);
      let delivery = await postBounded(reportUrl, reportBody);
      let deliveryKind: 'report' | 'callback' = 'report';
      if (!delivery.ok && delivery.reason === 'http-error' && delivery.status === 409) {
        deliveryKind = 'callback';
        delivery = await postBounded(callbackUrl, recovered.value.body);
        if (delivery.ok) {
          // Core accepted the original callback. Retry the report already built
          // above once; a repeated 409 is permanent.
          deliveryKind = 'report';
          delivery = await postBounded(reportUrl, reportBody);
        }
      }
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
        if (deliveryKind === 'callback') {
          await recordLog({
            phase: 'runner',
            outcome: 'callback',
            runId: input.runId,
            jobId: input.jobId,
            attempt: input.attempt,
            result: 'http-error',
            status: delivery.status ?? 0,
          });
        } else {
          await recordLog({
            phase: 'runner',
            outcome: 'cleanup-recovery',
            runId: input.runId,
            jobId: input.jobId,
            attempt: input.attempt,
            status: delivery.status ?? 0,
          });
        }
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
        error: 'cleanup recovery not confirmed',
      };
    } finally {
      recoveringCleanup.delete(input.jobId);
    }
  };
  // Remove only this job's owned Sandbox record. Other records are skipped, so
  // a foreign or unrelated marker is never touched by an automatic retry.
  const removeOwnedSandboxForJob = async (jobId: string): Promise<boolean> => {
    try {
      const result = await sandboxBackend.reconcileOrphans({
        isLiveJob: () => false,
        onlyJobId: jobId,
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
          if (result.verificationFailed === true && !isClosed())
            await removeOwnedSandboxForJob(job.id);
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
    const recovery = sandboxBackend.reconcileOrphans({ isLiveJob: isLiveCleanupOwner });
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
  let sandboxRecovery = startSandboxRecovery();
  retrySandboxRecovery = () => {
    if (isClosed() || sandboxRecovered !== false) return;
    onRetry();
    sandboxRecovery = startSandboxRecovery();
    void sandboxRecovery.then((recovered) => {
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
    if (sandboxBackend.health() === 'outage') {
      const ready = await sandboxBackend.checkReady();
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
      sandboxBackend.health() === 'outage' ||
      [...jobRegistry.values()].some((job) => job.cleanupRecoveryPending)
    )
      scheduleDeferredCleanupRecovery();
  };

  const startup = sandboxRecovery;
  return {
    startup,
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
      if (deferredCleanupRecoveryTimer !== undefined) {
        clearTimeout(deferredCleanupRecoveryTimer);
        deferredCleanupRecoveryTimer = undefined;
      }
      await sandboxRecoveryInFlight?.catch(() => undefined);
    },
  };
};

export type CleanupReconciler = ReturnType<typeof createCleanupReconciler>;
