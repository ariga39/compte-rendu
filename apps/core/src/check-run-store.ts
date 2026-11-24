import type { D1DatabaseLike } from './review-store-support';

export interface ReviewCheckDeliveryWorkItem {
  readonly runId: string;
  readonly checkRunId: number;
}

export interface CheckRunStore {
  claimCheckSetup(input: {
    runId: string;
    claimedAt: string;
    staleBefore: string;
  }): Promise<boolean>;
  recordCheckRun(input: {
    runId: string;
    checkRunId: number;
    setupClaim?: string;
  }): Promise<boolean>;
  markCheckSetupFailed(input: { runId: string; setupClaim?: string }): Promise<boolean>;
  claimCheckDelivery(input: {
    runId: string;
    checkRunId: number;
    occurredAt: string;
    reopen?: boolean;
  }): Promise<boolean>;
  confirmCheckDelivery(input: {
    runId: string;
    checkRunId: number;
    occurredAt: string;
  }): Promise<boolean>;
  listPendingCheckDeliveries(input: {
    limit: number;
  }): Promise<readonly ReviewCheckDeliveryWorkItem[]>;
}

export const createCheckRunStore = (database: D1DatabaseLike): CheckRunStore => ({
  claimCheckSetup: async ({ runId, claimedAt, staleBefore }) => {
    const result = await database
      .prepare(
        `UPDATE review_runs SET check_setup_claimed_at = ?
         WHERE run_id = ? AND status != 'cancelled' AND check_run_id IS NULL AND check_setup_status = 'pending'
           AND (check_setup_claimed_at IS NULL OR check_setup_claimed_at <= ?)`,
      )
      .bind(claimedAt, runId, staleBefore)
      .run();
    return result.meta.changes === 1;
  },

  recordCheckRun: async ({ runId, checkRunId, setupClaim }) => {
    const result = await database
      .prepare(
        `UPDATE review_runs SET check_run_id = ?, check_setup_status = 'ready',
           check_setup_claimed_at = NULL
         WHERE run_id = ? AND check_run_id IS NULL AND check_setup_status = 'pending'
           AND (? IS NULL OR check_setup_claimed_at = ?)`,
      )
      .bind(checkRunId, runId, setupClaim ?? null, setupClaim ?? null)
      .run();
    return result.meta.changes === 1;
  },

  markCheckSetupFailed: async ({ runId, setupClaim }) => {
    const result = await database
      .prepare(
        `UPDATE review_runs SET check_setup_status = 'failed', check_setup_claimed_at = NULL
         WHERE run_id = ? AND check_setup_status = 'pending'
           AND (? IS NULL OR check_setup_claimed_at = ?)`,
      )
      .bind(runId, setupClaim ?? null, setupClaim ?? null)
      .run();
    return result.meta.changes === 1;
  },

  claimCheckDelivery: async ({ runId, checkRunId, occurredAt, reopen }) => {
    const result = await database
      .prepare(
        `INSERT INTO review_check_deliveries
           (run_id, check_run_id, status, created_at, attempted_at)
         VALUES (?, ?, 'pending', ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET status = 'pending',
           attempted_at = excluded.attempted_at, confirmed_at = NULL
           WHERE review_check_deliveries.check_run_id = excluded.check_run_id
             AND (review_check_deliveries.status = 'pending' OR ? = 1)`,
      )
      .bind(runId, checkRunId, occurredAt, occurredAt, reopen === true ? 1 : 0)
      .run();
    return result.meta.changes === 1;
  },

  confirmCheckDelivery: async ({ runId, checkRunId, occurredAt }) => {
    const result = await database
      .prepare(
        `UPDATE review_check_deliveries
         SET status = 'confirmed', confirmed_at = COALESCE(confirmed_at, ?)
         WHERE run_id = ? AND check_run_id = ? AND status = 'pending'`,
      )
      .bind(occurredAt, runId, checkRunId)
      .run();
    return result.meta.changes === 1;
  },

  listPendingCheckDeliveries: async ({ limit }) => {
    const rows = await database
      .prepare(
        `SELECT delivery.run_id, delivery.check_run_id
         FROM review_check_deliveries AS delivery
         JOIN review_runs AS run ON run.run_id = delivery.run_id
         WHERE delivery.status = 'pending'
           AND run.status IN ('completed', 'failed', 'superseded')
           AND run.check_run_id = delivery.check_run_id
         ORDER BY delivery.attempted_at ASC, delivery.created_at ASC, delivery.run_id ASC
         LIMIT ?`,
      )
      .bind(limit)
      .all<{ run_id: string; check_run_id: number }>();
    return rows.results.map((row) => ({ runId: row.run_id, checkRunId: row.check_run_id }));
  },
});
