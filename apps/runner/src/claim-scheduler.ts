import { randomUUID } from 'node:crypto';
import { Schema } from 'effect';
import {
  REVIEW_ATTEMPT_BUDGET_MS,
  RUNNER_CONCURRENCY_DEFAULT,
  RUNNER_CONCURRENCY_HEADER,
  RunnerJobInput,
  sanitizeOperationalLogEvent,
  type OperationalLog,
  type OperationalLogEvent,
} from '@compte-rendu/contracts';
import {
  sandboxBackendCheckReady,
  sandboxBackendHealth,
  type SandboxBackend,
} from './sandbox-runtime.js';
import type { JobRegistry } from './job-registry.js';
import type { CleanupReconciler } from './cleanup-reconciler.js';
import type { JobExecutionInput } from './job-executor.js';
import { HostRequestAbortError, runWithHostDeadline } from './host-request.js';

const MAX_REQUEST_BYTES = 64 * 1024;

export interface ClaimSchedulerDependencies {
  readonly backend: SandboxBackend;
  readonly registry: JobRegistry;
  readonly cleanup: CleanupReconciler;
  readonly claimUrl?: string | undefined;
  readonly claimFetch: typeof fetch;
  readonly claimTimeoutMs: number;
  readonly claimIntervalMs: number;
  /** Gentle cadence for non-claiming probes while the Runner is full. */
  readonly probeIntervalMs: number;
  readonly authToken?: string | undefined;
  readonly callbackUrl?: string | undefined;
  readonly callbackToken?: string | undefined;
  readonly modelConfig?: unknown;
  readonly concurrency: () => number;
  /** Applies a deployment value, or null for the Runner startup fallback. */
  readonly applyConcurrency: (value: number | null) => void;
  readonly admit: (input: JobExecutionInput, claimed: boolean) => Promise<Response>;
  readonly log?: OperationalLog | undefined;
  readonly isClosed: () => boolean;
}

export interface ClaimSchedulerStatus {
  readonly claiming: boolean;
  readonly claimRequestId?: string | undefined;
  readonly claimPollingHalted: boolean;
  readonly draining: boolean;
}

export interface ClaimScheduler {
  start(): void;
  request(): void;
  schedule(): void;
  drain(): void;
  resume(): void;
  stageStop(jobId: string, deadline: number): void;
  takeStop(jobId: string): { readonly deadline: number } | undefined;
  hasCapacity(): boolean;
  status(): ClaimSchedulerStatus;
  close(): void;
  noteBackendRecovered(): void;
  resetClaimGateFailure(): void;
}

/**
 * undefined: no trustworthy header (transient failure or an older Core), so
 * keep the current target. null: the operator explicitly cleared the D1
 * override, so return to the startup fallback. number: a new target.
 */
const desiredFromResponse = (response: Response): number | null | undefined => {
  const raw = response.headers.get(RUNNER_CONCURRENCY_HEADER);
  if (raw === null) return undefined;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === RUNNER_CONCURRENCY_DEFAULT) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
};

export const createClaimScheduler = (deps: ClaimSchedulerDependencies): ClaimScheduler => {
  let claiming = false;
  let stagedOutageLogged = false;
  let claimRequestId: string | undefined;
  let claimPollingHalted = false;
  let draining = false;
  let claimGateFailureLogged = false;
  let claimTimer: ReturnType<typeof setTimeout> | undefined;
  let claimInFlight: Promise<void> | undefined;
  let claimInFlightController: AbortController | undefined;
  let probeInFlight = false;
  const stopsDuringClaim = new Map<
    string,
    { deadline: number; timer: ReturnType<typeof setTimeout> }
  >();

  const recordLog = async (event: OperationalLogEvent) => {
    if (deps.log === undefined) return;
    try {
      await deps.log.record(sanitizeOperationalLogEvent(event));
    } catch {
      // Diagnostics must not change claim behavior.
    }
  };
  const forgetStops = () => {
    for (const stop of stopsDuringClaim.values()) clearTimeout(stop.timer);
    stopsDuringClaim.clear();
  };
  const hasCapacity = () => deps.registry.hasCapacity(deps.concurrency(), claiming);
  const prerequisitesReady = () =>
    deps.claimUrl !== undefined &&
    deps.claimUrl.length > 0 &&
    deps.authToken !== undefined &&
    deps.authToken.length > 0 &&
    deps.callbackUrl !== undefined &&
    deps.callbackUrl.length > 0 &&
    deps.callbackToken !== undefined &&
    deps.callbackToken.length > 0 &&
    deps.modelConfig !== undefined;
  const recordClaimGateFailure = async (
    reason: 'sandbox-recovery-failed' | 'runtime-preflight-failed',
    pollingHalted = true,
  ) => {
    if (claimGateFailureLogged) return;
    claimGateFailureLogged = true;
    await recordLog({ phase: 'runner', outcome: 'claim', reason, pollingHalted });
  };
  const clearClaimTimer = () => {
    if (claimTimer !== undefined) clearTimeout(claimTimer);
    claimTimer = undefined;
  };
  const scheduleNext = (delayMs: number) => {
    if (deps.isClosed()) return;
    clearClaimTimer();
    claimTimer = setTimeout(() => {
      claimTimer = undefined;
      startNext();
    }, delayMs);
    if (typeof claimTimer === 'object' && claimTimer !== null) claimTimer.unref?.();
  };
  const begin = (probeOnly: boolean) => {
    if (deps.isClosed() || claimInFlight !== undefined || claiming) return;
    clearClaimTimer();
    if (probeOnly) probeInFlight = true;
    const run = probeOnly ? probeNextJob() : claimNextJob();
    claimInFlight = run;
    void run.finally(() => {
      if (claimInFlight === run) claimInFlight = undefined;
    });
  };
  const startClaim = () => begin(false);
  const startProbe = () => begin(true);
  const startNext = () => {
    if (deps.isClosed() || claimInFlight !== undefined) return;
    if (claimRequestId !== undefined) {
      startClaim();
      return;
    }
    if (draining || claimPollingHalted) return;
    if (!prerequisitesReady()) return;
    if (!hasCapacity()) {
      startProbe();
      return;
    }
    startClaim();
  };
  const requestConcurrency = (response: Response | undefined): boolean => {
    if (response === undefined) return false;
    const desired = desiredFromResponse(response);
    if (desired === undefined) return false;
    const previous = deps.concurrency();
    if (desired === previous) return false;
    deps.applyConcurrency(desired);
    return deps.concurrency() > previous;
  };
  const postClaim = (body: unknown, controller: AbortController) =>
    runWithHostDeadline({ timeoutMs: deps.claimTimeoutMs, signal: controller.signal }, (signal) =>
      deps.claimFetch(deps.claimUrl!, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${deps.callbackToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal,
      }),
    );
  const probeNextJob = async () => {
    const controller = new AbortController();
    claimInFlightController = controller;
    try {
      // No requestId: a probe can never impersonate a pending claim.
      const response = await postClaim({ probeOnly: true }, controller);
      if (response.status === 204) requestConcurrency(response);
      else {
        // A probe never admits work even if a misconfigured peer returns a job.
        await response.body?.cancel().catch(() => undefined);
      }
    } catch {
      // Timeout, abort, or transient transport failure: keep the current
      // target and let the single claim timer try again.
    } finally {
      if (claimInFlightController === controller) claimInFlightController = undefined;
      probeInFlight = false;
      if (!deps.isClosed() && !draining && !claimPollingHalted) {
        if (hasCapacity() || claimRequestId !== undefined) scheduleNext(0);
        else scheduleNext(deps.probeIntervalMs);
      }
    }
  };
  const claimNextJob = async () => {
    if (deps.isClosed()) return;
    // The startup sweep protects only resources whose age already exceeds any
    // possible live use. A slow inventory must not hold a healthy claim loop;
    // drain still waits for the tracked sweep.
    let needsCleanupRecovery = deps.cleanup.pendingCount() > 0;
    if (sandboxBackendHealth(deps.backend) === 'outage') {
      const ready = await sandboxBackendCheckReady(deps.backend);
      if (ready !== 'ready') {
        scheduleNext(deps.claimIntervalMs);
        return;
      }
      stagedOutageLogged = false;
      deps.cleanup.makeEligible();
      needsCleanupRecovery = true;
    }
    if (needsCleanupRecovery) {
      void deps.cleanup
        .reconcileFailed()
        .then((accepted: boolean) => {
          if (accepted) startClaim();
        })
        .catch(() => undefined);
    }
    if (draining && claimRequestId === undefined) return;
    if (
      claiming ||
      claimPollingHalted ||
      deps.claimUrl === undefined ||
      deps.claimUrl.length === 0 ||
      deps.authToken === undefined ||
      deps.authToken.length === 0 ||
      deps.callbackUrl === undefined ||
      deps.callbackUrl.length === 0 ||
      deps.callbackToken === undefined ||
      deps.callbackToken.length === 0 ||
      deps.modelConfig === undefined
    ) {
      return;
    }
    if (!hasCapacity() && claimRequestId === undefined) {
      scheduleNext(deps.probeIntervalMs);
      return;
    }
    const readiness = await sandboxBackendCheckReady(deps.backend);
    if (readiness !== 'ready') {
      await recordClaimGateFailure('runtime-preflight-failed', false);
      scheduleNext(deps.claimIntervalMs);
      return;
    }
    if (deps.isClosed()) return;
    if (
      claiming ||
      claimPollingHalted ||
      (draining && claimRequestId === undefined) ||
      (!hasCapacity() && claimRequestId === undefined)
    ) {
      if (!hasCapacity() && claimRequestId === undefined) {
        scheduleNext(deps.probeIntervalMs);
      }
      return;
    }

    claiming = true;
    claimRequestId ??= randomUUID();
    let continuePolling = true;
    let admittedJob = false;
    let concurrencyIncreased = false;
    let claimFailure:
      | {
          readonly reason:
            | 'http-error'
            | 'timeout'
            | 'transport-error'
            | 'invalid-response'
            | 'oversized-response'
            | 'malformed-response'
            | 'admission-rejected';
          readonly status?: number;
        }
      | undefined;
    const controller = new AbortController();
    claimInFlightController = controller;
    try {
      const response = await postClaim({ requestId: claimRequestId }, controller);
      if (response.status === 200) {
        continuePolling = false;
        claimPollingHalted = true;
        const body = await response.arrayBuffer();
        if (body.byteLength > MAX_REQUEST_BYTES) {
          claimFailure = { reason: 'oversized-response' };
          throw new Error('Claimed Runner Job exceeded the request bound');
        }
        let payload: unknown;
        try {
          payload = JSON.parse(new TextDecoder().decode(body));
        } catch {
          claimFailure = { reason: 'malformed-response' };
          throw new Error('Claimed Runner Job was not JSON');
        }
        const input = await Schema.decodeUnknownPromise(RunnerJobInput)(payload).catch(
          () => undefined,
        );
        if (input === undefined) {
          claimFailure ??= { reason: 'invalid-response' };
          throw new Error('Claimed Runner Job failed schema validation');
        }
        if (sandboxBackendHealth(deps.backend) === 'outage') {
          if (!stagedOutageLogged) {
            stagedOutageLogged = true;
            await recordLog({
              phase: 'runner',
              outcome: 'claim',
              reason: 'backend-outage',
              staged: true,
              pollingHalted: true,
            });
          }
          continuePolling = true;
          claimPollingHalted = false;
          return;
        }
        if (deps.isClosed()) return;
        const admitted = await deps.admit(input, true);
        if (admitted.status !== 202) {
          claimFailure ??= { reason: 'admission-rejected' };
          throw new Error('Claimed Runner Job could not be admitted');
        }
        claimPollingHalted = false;
        admittedJob = true;
        claimRequestId = undefined;
        concurrencyIncreased = requestConcurrency(response);
      } else if (response.status === 204) {
        claimRequestId = undefined;
        concurrencyIncreased = requestConcurrency(response);
      } else {
        claimFailure = { reason: 'http-error', status: response.status };
      }
    } catch (error) {
      const timedOut = error instanceof HostRequestAbortError && error.reason === 'timeout';
      claimFailure ??= { reason: timedOut ? 'timeout' : 'transport-error' };
    } finally {
      if (claimInFlightController === controller) claimInFlightController = undefined;
      claiming = false;
      if (claimRequestId === undefined) forgetStops();
      if (claimFailure !== undefined) {
        await recordLog({
          phase: 'runner',
          outcome: 'claim',
          reason: claimFailure.reason,
          ...(claimFailure.status === undefined ? {} : { status: claimFailure.status }),
          pollingHalted: claimPollingHalted,
        });
      }
      if (continuePolling || admittedJob) {
        // A reserved request ID must replay even when every execution slot is
        // full. A delivered increase with an open slot wakes the claim loop
        // immediately; otherwise a full Runner probes on the gentle cadence.
        scheduleNext(
          concurrencyIncreased && hasCapacity()
            ? 0
            : claimRequestId !== undefined || hasCapacity()
              ? deps.claimIntervalMs
              : deps.probeIntervalMs,
        );
      }
    }
  };

  return {
    start: startNext,
    request: startNext,
    schedule: () => scheduleNext(deps.claimIntervalMs),
    drain() {
      draining = true;
      clearClaimTimer();
      if (probeInFlight) claimInFlightController?.abort();
      if (claimRequestId !== undefined) startClaim();
    },
    resume() {
      if (!draining) return;
      draining = false;
      startNext();
    },
    stageStop(jobId, deadline) {
      if (stopsDuringClaim.has(jobId)) return;
      const timer = setTimeout(
        () => stopsDuringClaim.delete(jobId),
        Math.min(deadline - Date.now(), REVIEW_ATTEMPT_BUDGET_MS),
      );
      if (typeof timer === 'object' && timer !== null) timer.unref?.();
      stopsDuringClaim.set(jobId, { deadline, timer });
    },
    takeStop(jobId) {
      const stop = stopsDuringClaim.get(jobId);
      if (stop === undefined) return undefined;
      clearTimeout(stop.timer);
      stopsDuringClaim.delete(jobId);
      return { deadline: stop.deadline };
    },
    hasCapacity,
    status() {
      return { claiming, claimRequestId, claimPollingHalted, draining };
    },
    noteBackendRecovered() {
      stagedOutageLogged = false;
    },
    resetClaimGateFailure() {
      claimGateFailureLogged = false;
    },
    close() {
      clearClaimTimer();
      claimInFlightController?.abort();
      forgetStops();
    },
  };
};
