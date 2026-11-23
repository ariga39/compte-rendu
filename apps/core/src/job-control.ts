import {
  REVIEW_ATTEMPT_BUDGET_MS,
  sanitizeOperationalLogEvent,
  type OperationalLog,
} from '@compte-rendu/contracts';
import type {
  CoreLifecycleLog,
  GitHubAdapter,
  ReviewCancellationState,
  ReviewCancellationWorkItem,
  ReviewOutcome,
  ReviewStateQueries,
} from './index';
import type { RunnerJobSubmitter } from './runner-job-client';

type LifecycleContext = {
  readonly waitUntil: (task: Promise<unknown>) => void;
};

export function createJobControl(
  state: ReviewStateQueries,
  github: GitHubAdapter,
  runner?: RunnerJobSubmitter,
  log?: OperationalLog,
  lifecycleLog?: (context?: LifecycleContext) => CoreLifecycleLog,
) {
  const response = (status: number, pendingCleanup?: boolean) =>
    Response.json(pendingCleanup === undefined ? {} : { status: 'cancelled', pendingCleanup }, {
      status,
      headers: { 'cache-control': 'no-store' },
    });

  const recordDeliveryFailure = async (runId: string, kind: 'runner-stop' | 'check-cancel') => {
    if (log === undefined) return;
    try {
      await log.record(
        sanitizeOperationalLogEvent({
          phase: 'cancellation',
          outcome: 'delivery_failed',
          runId,
          kind,
        }),
      );
    } catch {
      // Operational logging is best effort.
    }
  };

  const deliver = async (
    runId: string,
    kind: 'runner-stop' | 'check-cancel',
    delivery: () => Promise<void>,
  ) => {
    try {
      await delivery();
    } catch (error) {
      await recordDeliveryFailure(runId, kind);
      throw error;
    }
  };

  async function stop(item: ReviewCancellationWorkItem, occurredAt: string) {
    if (
      !item.needsRunnerStop ||
      !runner ||
      !item.claimedAt ||
      !item.runnerJobId ||
      item.runnerAttempt === null
    )
      return;
    const identity = { runId: item.runId, jobId: item.runnerJobId, attempt: item.runnerAttempt };
    if (
      !(await state.recordRunnerStopAttempt?.({
        ...identity,
        occurredAt,
        expectedLastAttempt: item.runnerStopAttemptedAt,
      }))
    )
      return;
    const destroyed = await runner.requestStop({
      ...identity,
      claimDeadlineAt: Date.parse(item.claimedAt) + REVIEW_ATTEMPT_BUDGET_MS,
    });
    if (destroyed) await state.confirmRunnerDestroyed?.({ ...identity, occurredAt });
  }

  async function endCheck(item: ReviewCancellationWorkItem, occurredAt: string) {
    if (!item.needsCheckReconciliation || item.checkRunId === null || !github.updateCheckRun)
      return;
    const identity = { runId: item.runId, checkRunId: item.checkRunId };
    if (
      !(await state.recordCheckCancellationAttempt?.({
        ...identity,
        occurredAt,
        expectedLastAttempt: item.checkCancelAttemptedAt,
      }))
    )
      return;
    const outcome = await state.getRunOutcome(item.runId);
    if (outcome?.status !== 'cancelled') return;
    await github.updateCheckRun({
      ...identity,
      installationId: outcome.installationId,
      repositoryId: outcome.repositoryId,
      status: 'cancelled',
      cancellationReason: 'manual',
    });
    await state.confirmCheckCancelled?.({ ...identity, occurredAt });
  }

  const recordCancellation = async (
    cancellation: ReviewCancellationState,
    context?: LifecycleContext,
  ) => {
    try {
      const outcome: ReviewOutcome | undefined = await state.getRunOutcome(cancellation.runId);
      if (outcome === undefined) return;
      const created = Date.parse(outcome.createdAt);
      const requested = Date.parse(cancellation.requestedAt);
      const claimed = outcome.claimedAt === undefined ? undefined : Date.parse(outcome.claimedAt);
      const totalDurationMs =
        Number.isFinite(created) && Number.isFinite(requested)
          ? Math.max(0, requested - created)
          : 0;
      const queueWaitMs =
        Number.isFinite(created) && claimed !== undefined && Number.isFinite(claimed)
          ? Math.max(0, claimed - created)
          : undefined;
      lifecycleLog?.(context)?.record({
        event: 'review finished',
        runId: cancellation.runId,
        trigger: outcome.trigger,
        outcome: 'cancelled',
        published: false,
        totalDurationMs,
        ...(queueWaitMs === undefined ? {} : { queueWaitMs }),
        cleanupStatus:
          cancellation.cleanup === 'destroyed' || cancellation.cleanup === 'failed'
            ? cancellation.cleanup
            : 'unknown',
        evidenceStatus: outcome.evidence?.status ?? 'unknown',
      });
    } catch {
      // Cancellation telemetry is best effort and cannot affect the transition.
    }
  };

  return {
    async cancelReview(runId: string, requestedByUid: number, context?: LifecycleContext) {
      const result = await state.cancelRun({
        runId,
        requestedByUid,
        occurredAt: new Date().toISOString(),
      });
      if (result.kind === 'not_found') return response(404);
      if (result.kind === 'conflict') return response(409);
      if (result.kind === 'cancelled') await recordCancellation(result.cancellation, context);
      const { runnerJobId, cleanup } = result.cancellation;
      const pending = runnerJobId !== null && cleanup !== 'destroyed';
      return response(pending ? 202 : 200, pending);
    },
    async reconcileCancellations(now: number, runId?: string) {
      const occurredAt = new Date(now).toISOString();
      const work =
        (await state.listCancellationWork?.({
          retryBefore: new Date(now - 60_000).toISOString(),
          recoveryBefore: new Date(now - REVIEW_ATTEMPT_BUDGET_MS - 60_000).toISOString(),
          limit: runId ? 1 : 8,
          runId,
        })) ?? [];
      const outcomes = await Promise.allSettled(
        work.flatMap((item) => [
          deliver(item.runId, 'runner-stop', () => stop(item, occurredAt)),
          deliver(item.runId, 'check-cancel', () => endCheck(item, occurredAt)),
        ]),
      );
      if (outcomes.some((outcome) => outcome.status === 'rejected'))
        throw new Error('Review cancellation delivery failed');
    },
  };
}
