import type { ReviewRunStatus, RunnerCleanupStatus } from './review-records';
import type { D1DatabaseLike } from './review-store-support';

export interface ReviewCancellationState {
  readonly runId: string;
  readonly requestedAt: string;
  readonly requestedByUid: number;
  readonly runnerJobId: string | null;
  readonly runnerAttempt: number | null;
  readonly cleanup: RunnerCleanupStatus | null;
  readonly checkRunId: number | null;
}

export type ReviewCancellationResult =
  | { readonly kind: 'cancelled'; readonly cancellation: ReviewCancellationState }
  | { readonly kind: 'already_cancelled'; readonly cancellation: ReviewCancellationState }
  | {
      readonly kind: 'conflict';
      readonly runId: string;
      readonly status: ReviewRunStatus;
      readonly publicationClaimed: boolean;
    }
  | { readonly kind: 'not_found'; readonly runId: string };

export interface ReviewCancellationWorkItem {
  readonly runId: string;
  readonly cancelledAt: string;
  readonly claimedAt: string | null;
  readonly runnerJobId: string | null;
  readonly runnerAttempt: number | null;
  readonly runnerCleanupStatus: RunnerCleanupStatus | null;
  readonly runnerStopAttemptedAt: string | null;
  readonly checkRunId: number | null;
  readonly checkCancelAttemptedAt: string | null;
  readonly needsRunnerStop: boolean;
  readonly needsCheckReconciliation: boolean;
  readonly cleanupBlocked: boolean;
  readonly recoveryRequired: boolean;
}

export interface CancellationRow {
  run_id: string;
  status: ReviewRunStatus;
  publication_claimed_at: string | null;
  cancelled_at: string | null;
  cancelled_by_uid: number | null;
  runner_job_id: string | null;
  runner_attempt: number | null;
  runner_cleanup_status: RunnerCleanupStatus | null;
  check_run_id: number | null;
}

export interface CancellationWorkRow {
  run_id: string;
  cancelled_at: string;
  claimed_at: string | null;
  runner_job_id: string | null;
  runner_attempt: number | null;
  runner_cleanup_status: RunnerCleanupStatus | null;
  runner_stop_attempted_at: string | null;
  check_run_id: number | null;
  check_cancel_attempted_at: string | null;
  check_cancel_reconciled_at: string | null;
}

export const cancellationFromRow = (row: CancellationRow): ReviewCancellationState => ({
  runId: row.run_id,
  requestedAt: row.cancelled_at as string,
  requestedByUid: row.cancelled_by_uid as number,
  runnerJobId: row.runner_job_id,
  runnerAttempt: row.runner_attempt,
  cleanup: row.runner_cleanup_status,
  checkRunId: row.check_run_id,
});

export const cancellationColumns = `run_id, status, publication_claimed_at, cancelled_at,
  cancelled_by_uid, runner_job_id, runner_attempt, runner_cleanup_status, check_run_id`;

export interface CancellationStore {
  cancelRun(input: {
    runId: string;
    requestedByUid: number;
    occurredAt: string;
  }): Promise<ReviewCancellationResult>;
  listCancellationWork(input: {
    runId?: string;
    retryBefore: string;
    recoveryBefore: string;
    limit: number;
  }): Promise<readonly ReviewCancellationWorkItem[]>;
  recordRunnerStopAttempt(input: {
    runId: string;
    jobId: string;
    attempt: number;
    occurredAt: string;
    expectedLastAttempt: string | null;
  }): Promise<boolean>;
  confirmRunnerDestroyed(input: {
    expectedStatus?: import('./review-records').ReviewOutcome['status'];
    runId: string;
    jobId: string;
    attempt: number;
    occurredAt: string;
  }): Promise<boolean>;
  recordCheckCancellationAttempt(input: {
    runId: string;
    checkRunId: number;
    occurredAt: string;
    expectedLastAttempt: string | null;
  }): Promise<boolean>;
  confirmCheckCancelled(input: {
    runId: string;
    checkRunId: number;
    occurredAt: string;
  }): Promise<boolean>;
  reopenCheckCancellation(input: { runId: string; checkRunId: number }): Promise<boolean>;
}

export const createCancellationStore = (database: D1DatabaseLike): CancellationStore => ({
  cancelRun: async ({ runId, requestedByUid, occurredAt }) => {
    const results = await database.batch([
      database
        .prepare(
          `UPDATE review_runs
           SET status = 'cancelled', updated_at = ?, terminal_at = COALESCE(terminal_at, ?),
             cancelled_at = ?, cancelled_by_uid = ?
           WHERE run_id = ? AND status = 'scheduled' AND publication_claimed_at IS NULL`,
        )
        .bind(occurredAt, occurredAt, occurredAt, requestedByUid, runId),
      database
        .prepare(
          `UPDATE deliveries SET status = 'cancelled', updated_at = ?
           WHERE delivery_id = (
             SELECT delivery_id FROM review_runs
             WHERE run_id = ? AND status = 'cancelled'
           ) AND status = 'scheduled'`,
        )
        .bind(occurredAt, runId),
    ]);
    const row = await database
      .prepare(`SELECT ${cancellationColumns} FROM review_runs WHERE run_id = ?`)
      .bind(runId)
      .first<CancellationRow>();
    if (row === null) return { kind: 'not_found' as const, runId };
    if ((results[0]?.meta.changes ?? 0) === 1) {
      return { kind: 'cancelled' as const, cancellation: cancellationFromRow(row) };
    }
    if (row.status === 'cancelled') {
      return { kind: 'already_cancelled' as const, cancellation: cancellationFromRow(row) };
    }
    return {
      kind: 'conflict' as const,
      runId,
      status: row.status,
      publicationClaimed: row.publication_claimed_at !== null,
    };
  },

  listCancellationWork: async ({ runId, retryBefore, recoveryBefore, limit }) => {
    const rows = await database
      .prepare(
        `SELECT run_id, cancelled_at, claimed_at, runner_job_id, runner_attempt,
           runner_cleanup_status, runner_stop_attempted_at, check_run_id,
           check_cancel_attempted_at, check_cancel_reconciled_at
         FROM review_runs
         WHERE status = 'cancelled' AND (? IS NULL OR run_id = ?) AND (
           (runner_job_id IS NOT NULL AND runner_cleanup_status IS NOT 'destroyed'
             AND cancelled_at >= ?
             AND (runner_stop_attempted_at IS NULL OR runner_stop_attempted_at <= ?))
           OR (check_run_id IS NOT NULL AND check_cancel_reconciled_at IS NULL
             AND (check_cancel_attempted_at IS NULL OR check_cancel_attempted_at <= ?))
           OR (runner_job_id IS NOT NULL AND runner_cleanup_status IS NOT 'destroyed'
             AND cancelled_at < ?)
         )
         ORDER BY CASE WHEN
           (runner_job_id IS NOT NULL AND runner_cleanup_status IS NOT 'destroyed'
             AND cancelled_at >= ?
             AND (runner_stop_attempted_at IS NULL OR runner_stop_attempted_at <= ?))
           OR (check_run_id IS NOT NULL AND check_cancel_reconciled_at IS NULL
             AND (check_cancel_attempted_at IS NULL OR check_cancel_attempted_at <= ?))
         THEN 0 ELSE 1 END,
         cancelled_at ASC, rowid ASC
         LIMIT ?`,
      )
      .bind(
        runId ?? null,
        runId ?? null,
        recoveryBefore,
        retryBefore,
        retryBefore,
        recoveryBefore,
        recoveryBefore,
        retryBefore,
        retryBefore,
        limit,
      )
      .all<CancellationWorkRow>();
    const due = (attemptedAt: string | null) => attemptedAt === null || attemptedAt <= retryBefore;
    return rows.results.map((row): ReviewCancellationWorkItem => {
      const cleanupBlocked =
        row.runner_job_id !== null && row.runner_cleanup_status !== 'destroyed';
      const recoveryRequired = cleanupBlocked && row.cancelled_at < recoveryBefore;
      return {
        runId: row.run_id,
        cancelledAt: row.cancelled_at,
        claimedAt: row.claimed_at,
        runnerJobId: row.runner_job_id,
        runnerAttempt: row.runner_attempt,
        runnerCleanupStatus: row.runner_cleanup_status,
        runnerStopAttemptedAt: row.runner_stop_attempted_at,
        checkRunId: row.check_run_id,
        checkCancelAttemptedAt: row.check_cancel_attempted_at,
        needsRunnerStop: cleanupBlocked && !recoveryRequired && due(row.runner_stop_attempted_at),
        needsCheckReconciliation:
          row.check_run_id !== null &&
          row.check_cancel_reconciled_at === null &&
          due(row.check_cancel_attempted_at),
        cleanupBlocked,
        recoveryRequired,
      };
    });
  },

  recordRunnerStopAttempt: async ({ runId, jobId, attempt, occurredAt, expectedLastAttempt }) => {
    const result = await database
      .prepare(
        `UPDATE review_runs SET runner_stop_attempted_at = ?
         WHERE run_id = ? AND status = 'cancelled' AND runner_job_id = ? AND runner_attempt = ?
           AND runner_cleanup_status IS NOT 'destroyed'
           AND runner_stop_attempted_at IS ?`,
      )
      .bind(occurredAt, runId, jobId, attempt, expectedLastAttempt)
      .run();
    return result.meta.changes === 1;
  },

  confirmRunnerDestroyed: async ({
    runId,
    jobId,
    attempt,
    occurredAt,
    expectedStatus = 'cancelled',
  }) => {
    const result = await database
      .prepare(
        `UPDATE review_runs SET runner_cleanup_status = 'destroyed',
           cleanup_completed_at = COALESCE(cleanup_completed_at, ?)
         WHERE run_id = ? AND status = ? AND runner_job_id = ? AND runner_attempt = ?`,
      )
      .bind(occurredAt, runId, expectedStatus, jobId, attempt)
      .run();
    return result.meta.changes === 1;
  },

  recordCheckCancellationAttempt: async ({
    runId,
    checkRunId,
    occurredAt,
    expectedLastAttempt,
  }) => {
    const result = await database
      .prepare(
        `UPDATE review_runs SET check_cancel_attempted_at = ?
         WHERE run_id = ? AND status = 'cancelled' AND check_run_id = ?
           AND check_cancel_reconciled_at IS NULL
           AND check_cancel_attempted_at IS ?`,
      )
      .bind(occurredAt, runId, checkRunId, expectedLastAttempt)
      .run();
    return result.meta.changes === 1;
  },

  confirmCheckCancelled: async ({ runId, checkRunId, occurredAt }) => {
    const result = await database
      .prepare(
        `UPDATE review_runs SET check_cancel_reconciled_at = COALESCE(check_cancel_reconciled_at, ?)
         WHERE run_id = ? AND status = 'cancelled' AND check_run_id = ?
           AND check_cancel_reconciled_at IS NULL`,
      )
      .bind(occurredAt, runId, checkRunId)
      .run();
    return result.meta.changes === 1;
  },

  reopenCheckCancellation: async ({ runId, checkRunId }) => {
    const result = await database
      .prepare(
        `UPDATE review_runs SET check_cancel_reconciled_at = NULL, check_cancel_attempted_at = NULL
         WHERE run_id = ? AND status = 'cancelled' AND check_run_id = ?`,
      )
      .bind(runId, checkRunId)
      .run();
    return result.meta.changes === 1;
  },
});
