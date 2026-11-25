import type { D1DatabaseLike } from './review-store-support';

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
});
