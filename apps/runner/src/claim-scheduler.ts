import { randomUUID } from 'node:crypto';
import { Schema } from 'effect';
import {
  REVIEW_ATTEMPT_BUDGET_MS,
  RunnerJobInput,
  sanitizeOperationalLogEvent,
  type OperationalLog,
  type OperationalLogEvent,
} from '@compte-rendu/contracts';
import type { SandboxBackend } from './sandbox-runtime.js';
import type { GrantLedger } from './grant-ledger.js';
import type { JobRegistry } from './job-registry.js';
import type { CleanupReconciler } from './cleanup-reconciler.js';
import type { JobExecutionInput } from './job-executor.js';

const MAX_REQUEST_BYTES = 64 * 1024;

export interface ClaimSchedulerDependencies {
  readonly backend: SandboxBackend;
  readonly registry: JobRegistry;
  readonly grants: GrantLedger;
  readonly cleanup: CleanupReconciler;
  readonly claimUrl?: string | undefined;
  readonly claimFetch: typeof fetch;
  readonly claimTimeoutMs: number;
  readonly claimIntervalMs: number;
  readonly authToken?: string | undefined;
  readonly callbackUrl?: string | undefined;
  readonly callbackToken?: string | undefined;
  readonly modelConfig?: unknown;
  readonly concurrency: () => number;
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
  const recordClaimGateFailure = async (
    reason: 'grant-recovery-failed' | 'sandbox-recovery-failed' | 'runtime-preflight-failed',
    pollingHalted = true,
  ) => {
    if (claimGateFailureLogged) return;
    claimGateFailureLogged = true;
    await recordLog({ phase: 'runner', outcome: 'claim', reason, pollingHalted });
  };
  const startClaim = () => {
    if (deps.isClosed() || claimInFlight !== undefined) return;
    if (claimTimer !== undefined) {
      clearTimeout(claimTimer);
      claimTimer = undefined;
    }
    const run = claimNextJob();
    claimInFlight = run;
    void run.finally(() => {
      if (claimInFlight === run) claimInFlight = undefined;
    });
  };
  const scheduleClaim = () => {
    if (deps.isClosed()) return;
    claimTimer = setTimeout(() => {
      claimTimer = undefined;
      startClaim();
    }, deps.claimIntervalMs);
    if (typeof claimTimer === 'object' && claimTimer !== null) claimTimer.unref?.();
  };
  const claimNextJob = async () => {
    if (deps.isClosed()) return;
    const grantRecovery = deps.grants.recovery();
    if (grantRecovery !== undefined && !(await grantRecovery)) {
      await recordClaimGateFailure('grant-recovery-failed');
      return;
    }
    await deps.cleanup.startup.catch(() => undefined);
    if (deps.isClosed()) return;
    let needsCleanupRecovery = deps.cleanup.pendingCount() > 0;
    if (deps.backend.health() === 'outage') {
      const ready = await deps.backend.checkReady();
      if (ready !== 'ready') {
        scheduleClaim();
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
      deps.modelConfig === undefined ||
      !hasCapacity()
    ) {
      return;
    }
    const readiness = await deps.backend.checkReady();
    if (readiness !== 'ready') {
      await recordClaimGateFailure('runtime-preflight-failed', false);
      scheduleClaim();
      return;
    }
    if (deps.isClosed()) return;
    if (
      claiming ||
      claimPollingHalted ||
      (draining && claimRequestId === undefined) ||
      !hasCapacity()
    )
      return;

    claiming = true;
    claimRequestId ??= randomUUID();
    let continuePolling = true;
    let admittedJob = false;
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
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      const response = await Promise.race([
        deps.claimFetch(deps.claimUrl, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${deps.callbackToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ requestId: claimRequestId }),
          signal: controller.signal,
        }),
        new Promise<Response>((_, reject) => {
          timeout = setTimeout(() => {
            timedOut = true;
            controller.abort();
            reject(new Error('Runner claim request timed out'));
          }, deps.claimTimeoutMs);
        }),
      ]);
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
        if (deps.backend.health() === 'outage') {
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
      } else if (response.status === 204) {
        claimRequestId = undefined;
      } else {
        claimFailure = { reason: 'http-error', status: response.status };
      }
    } catch {
      claimFailure ??= { reason: timedOut ? 'timeout' : 'transport-error' };
    } finally {
      if (claimInFlightController === controller) claimInFlightController = undefined;
      if (timeout !== undefined) clearTimeout(timeout);
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
      if ((continuePolling || admittedJob) && hasCapacity()) scheduleClaim();
    }
  };

  return {
    start: startClaim,
    request: startClaim,
    schedule: scheduleClaim,
    drain() {
      draining = true;
      if (claimRequestId !== undefined) startClaim();
    },
    resume() {
      if (!draining) return;
      draining = false;
      startClaim();
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
      if (claimTimer !== undefined) clearTimeout(claimTimer);
      claimTimer = undefined;
      claimInFlightController?.abort();
      forgetStops();
    },
  };
};
