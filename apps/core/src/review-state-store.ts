import type {
  ReviewDeliveryRecord,
  ReviewJob,
  ReviewOutcome,
  ReviewRunStatus,
  ReviewStateQueries,
  ReviewStateStore,
  ReviewStoredStatus,
} from './index';
import type { ReviewEvidenceMetadata } from './index';

export interface D1ResultLike {
  readonly meta: {
    readonly changes: number;
  };
}

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  run(): Promise<D1ResultLike>;
  first<T>(): Promise<T | null>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
  batch(statements: readonly D1PreparedStatementLike[]): Promise<readonly D1ResultLike[]>;
}

export type D1ReviewStateStore = ReviewStateStore & ReviewStateQueries;

interface DeliveryRow {
  delivery_id: string;
  installation_id: number;
  repository_id: number;
  pull_request_number: number;
  base_sha: string | null;
  head_sha: string | null;
  trigger: ReviewJob['trigger'];
  status: ReviewStoredStatus;
  created_at: string;
  updated_at: string;
  runner_job_id?: string | null;
  runner_attempt?: number | null;
  comment_id?: number | null;
  evidence_key?: string | null;
  evidence_status?: 'complete' | 'incomplete' | null;
  evidence_size?: number | null;
  evidence_sha256?: string | null;
  evidence_uploaded_at?: string | null;
  execution_started_at?: string | null;
  submission_completed_at?: string | null;
  cleanup_completed_at?: string | null;
}

interface RunRow {
  run_id: string;
  status: ReviewRunStatus;
}

const dispositionForStatus = (status: ReviewStoredStatus) => {
  switch (status) {
    case 'failed':
      return 'failed' as const;
    case 'completed':
      return 'completed' as const;
    case 'scheduled':
      return 'scheduled' as const;
    case 'awaiting approval':
      return 'awaiting approval' as const;
    case 'superseded':
    case 'claiming':
    case 'ignored':
    case 'rejected':
      return 'ignored' as const;
  }
};

const outcomeFromRow = (row: DeliveryRow): ReviewOutcome => ({
  deliveryId: row.delivery_id,
  installationId: row.installation_id,
  repositoryId: row.repository_id,
  pullRequestNumber: row.pull_request_number,
  baseSha: row.base_sha,
  headSha: row.head_sha,
  trigger: row.trigger,
  status: row.status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  ...(row.runner_job_id == null ? {} : { runnerJobId: row.runner_job_id }),
  ...(row.runner_attempt == null ? {} : { runnerAttempt: row.runner_attempt }),
  ...(row.comment_id == null ? {} : { commentId: row.comment_id }),
  ...(row.evidence_key == null ||
  row.evidence_status == null ||
  row.evidence_size == null ||
  row.evidence_sha256 == null ||
  row.evidence_uploaded_at == null
    ? {}
    : {
        evidence: {
          key: row.evidence_key,
          status: row.evidence_status,
          size: row.evidence_size,
          sha256: row.evidence_sha256,
          uploadedAt: row.evidence_uploaded_at,
          ...(row.execution_started_at == null
            ? {}
            : { executionStartedAt: row.execution_started_at }),
          ...(row.submission_completed_at == null
            ? {}
            : { submissionCompletedAt: row.submission_completed_at }),
          ...(row.cleanup_completed_at == null
            ? {}
            : { cleanupCompletedAt: row.cleanup_completed_at }),
        } satisfies ReviewEvidenceMetadata,
      }),
});

const deliverySelect = `
  SELECT delivery_id, installation_id, repository_id, pull_request_number,
    base_sha, head_sha, trigger, status, created_at, updated_at
  FROM deliveries WHERE delivery_id = ?
`;

const runOutcomeSelect = `
  SELECT d.delivery_id, d.installation_id, d.repository_id, d.pull_request_number,
    d.base_sha, d.head_sha, d.trigger, r.status,
    r.created_at, r.updated_at, r.runner_job_id, r.runner_attempt, r.comment_id,
    r.evidence_key, r.evidence_status,
    r.evidence_size, r.evidence_sha256, r.evidence_uploaded_at,
    r.execution_started_at, r.submission_completed_at, r.cleanup_completed_at
  FROM review_runs r
  JOIN deliveries d ON d.delivery_id = r.delivery_id
  WHERE r.run_id = ?
`;

export const createD1ReviewStateStore = (database: D1DatabaseLike): D1ReviewStateStore => ({
  recordDelivery: async ({
    deliveryId,
    installationId,
    repositoryId,
    pullRequestNumber,
    baseSha,
    headSha,
    trigger,
    status,
    occurredAt,
  }: ReviewDeliveryRecord) => {
    await database
      .prepare(
        `INSERT INTO deliveries
          (delivery_id, installation_id, repository_id, pull_request_number,
           base_sha, head_sha, trigger, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(delivery_id) DO NOTHING`,
      )
      .bind(
        deliveryId,
        installationId,
        repositoryId,
        pullRequestNumber,
        baseSha,
        headSha,
        trigger,
        status,
        occurredAt,
        occurredAt,
      )
      .run();
  },

  claimReview: async ({ deliveryId, job, occurredAt, approval }) => {
    const runId = crypto.randomUUID();
    const statements: D1PreparedStatementLike[] = [
      database
        .prepare(
          `INSERT INTO deliveries
            (delivery_id, installation_id, repository_id, pull_request_number,
             base_sha, head_sha, trigger, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'claiming', ?, ?)
           ON CONFLICT(delivery_id) DO NOTHING`,
        )
        .bind(
          deliveryId,
          job.installationId,
          job.repositoryId,
          job.pullRequestNumber,
          job.baseSha,
          job.headSha,
          job.trigger,
          occurredAt,
          occurredAt,
        ),
      approval
        ? database
            .prepare(
              `INSERT INTO approvals
                (installation_id, repository_id, pull_request_number,
                 base_sha, head_sha, approved_at)
               SELECT ?, ?, ?, ?, ?, ?
               WHERE EXISTS (
                 SELECT 1 FROM deliveries
                 WHERE delivery_id = ? AND status = 'claiming'
               )
               ON CONFLICT(installation_id, repository_id, pull_request_number, head_sha)
               DO UPDATE SET base_sha = excluded.base_sha, approved_at = excluded.approved_at`,
            )
            .bind(
              approval.installationId,
              approval.repositoryId,
              approval.pullRequestNumber,
              approval.baseSha,
              approval.headSha,
              occurredAt,
              deliveryId,
            )
        : database.prepare('SELECT 1 WHERE 0').bind(),
      database
        .prepare(
          `INSERT INTO review_runs
            (run_id, delivery_id, installation_id, repository_id,
             pull_request_number, base_sha, head_sha, trigger,
             status, created_at, updated_at, comment_id)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM deliveries
             WHERE delivery_id = ? AND status = 'claiming'
           )
             AND NOT EXISTS (
               SELECT 1 FROM review_runs
               WHERE repository_id = ? AND pull_request_number = ? AND head_sha = ?
                 AND status IN ('scheduled', 'completed')
             )
             AND (
               NOT EXISTS (
                 SELECT 1 FROM review_runs
                 WHERE repository_id = ? AND pull_request_number = ? AND head_sha = ?
               )
               OR (
                 ? = 'manual'
                 AND EXISTS (
                   SELECT 1 FROM review_runs
                   WHERE repository_id = ? AND pull_request_number = ? AND head_sha = ?
                     AND status = 'failed'
                 )
               )
             )
           ON CONFLICT(repository_id, pull_request_number, head_sha)
             WHERE status IN ('scheduled', 'completed') DO NOTHING`,
        )
        .bind(
          runId,
          deliveryId,
          job.installationId,
          job.repositoryId,
          job.pullRequestNumber,
          job.baseSha,
          job.headSha,
          job.trigger,
          occurredAt,
          occurredAt,
          job.commentId ?? null,
          deliveryId,
          job.repositoryId,
          job.pullRequestNumber,
          job.headSha,
          job.repositoryId,
          job.pullRequestNumber,
          job.headSha,
          job.trigger,
          job.repositoryId,
          job.pullRequestNumber,
          job.headSha,
        ),
      database
        .prepare(
          `UPDATE review_runs
           SET status = 'superseded', updated_at = ?
           WHERE installation_id = ? AND repository_id = ?
             AND pull_request_number = ? AND head_sha <> ?
             AND status = 'scheduled'
             AND EXISTS (
               SELECT 1 FROM review_runs
               WHERE run_id = ? AND delivery_id = ? AND status = 'scheduled'
             )`,
        )
        .bind(
          occurredAt,
          job.installationId,
          job.repositoryId,
          job.pullRequestNumber,
          job.headSha,
          runId,
          deliveryId,
        ),
      database
        .prepare(
          `UPDATE deliveries SET status = 'superseded', updated_at = ?
           WHERE delivery_id IN (
             SELECT delivery_id FROM review_runs
             WHERE installation_id = ? AND repository_id = ?
               AND pull_request_number = ? AND status = 'superseded'
               AND head_sha <> ?
           ) AND status = 'scheduled' AND delivery_id <> ?
             AND EXISTS (
               SELECT 1 FROM review_runs
               WHERE run_id = ? AND delivery_id = ? AND status = 'scheduled'
             )`,
        )
        .bind(
          occurredAt,
          job.installationId,
          job.repositoryId,
          job.pullRequestNumber,
          job.headSha,
          deliveryId,
          runId,
          deliveryId,
        ),
      database
        .prepare(
          `UPDATE deliveries SET
             status = COALESCE(
               (SELECT status FROM review_runs WHERE delivery_id = ?),
               (SELECT status FROM review_runs
                WHERE repository_id = ? AND pull_request_number = ? AND head_sha = ?
                  AND status IN ('scheduled', 'completed')
                ORDER BY created_at DESC LIMIT 1),
               (SELECT status FROM review_runs
                WHERE repository_id = ? AND pull_request_number = ? AND head_sha = ?
                ORDER BY created_at DESC LIMIT 1),
               'ignored'
             ), updated_at = ?
           WHERE delivery_id = ? AND status = 'claiming'`,
        )
        .bind(
          deliveryId,
          job.repositoryId,
          job.pullRequestNumber,
          job.headSha,
          job.repositoryId,
          job.pullRequestNumber,
          job.headSha,
          occurredAt,
          deliveryId,
        ),
    ];

    const results = await database.batch(statements);
    const delivery = await database.prepare(deliverySelect).bind(deliveryId).first<DeliveryRow>();
    if (delivery === null) {
      throw new Error('D1 did not retain the claimed delivery');
    }

    const disposition = dispositionForStatus(delivery.status);
    if ((results[0]?.meta.changes ?? 0) === 0) {
      return { kind: 'replay' as const, disposition };
    }

    const run = await database
      .prepare(
        `SELECT run_id, status FROM review_runs
         WHERE delivery_id = ? AND status = 'scheduled'`,
      )
      .bind(deliveryId)
      .first<RunRow>();
    if (run !== null) {
      return { kind: 'claimed' as const, runId: run.run_id };
    }

    return { kind: 'existing' as const, disposition };
  },

  markSchedulingFailed: async ({ runId, occurredAt }) => {
    await database.batch([
      database
        .prepare(
          `UPDATE review_runs SET status = 'failed', updated_at = ?
           WHERE run_id = ? AND status = 'scheduled'`,
        )
        .bind(occurredAt, runId),
      database
        .prepare(
          `UPDATE deliveries SET status = 'failed', updated_at = ?
           WHERE delivery_id = (
             SELECT delivery_id FROM review_runs WHERE run_id = ?
           ) AND status = 'scheduled'`,
        )
        .bind(occurredAt, runId),
    ]);
  },

  recordEvidence: async ({ runId, evidence }) => {
    const result = await database
      .prepare(
        `UPDATE review_runs SET
           evidence_key = ?, evidence_status = ?, evidence_size = ?,
           evidence_sha256 = ?, evidence_uploaded_at = ?,
           execution_started_at = ?, submission_completed_at = ?,
           cleanup_completed_at = ?
         WHERE run_id = ? AND (
           evidence_key IS NULL OR evidence_key = ?
         )`,
      )
      .bind(
        evidence.key,
        evidence.status,
        evidence.size,
        evidence.sha256,
        evidence.uploadedAt,
        evidence.executionStartedAt ?? null,
        evidence.submissionCompletedAt ?? null,
        evidence.cleanupCompletedAt ?? null,
        runId,
        evidence.key,
      )
      .run();
    return result.meta.changes === 1;
  },

  recordRunnerJob: async ({ runId, jobId, attempt }) => {
    const result = await database
      .prepare(
        `UPDATE review_runs SET runner_job_id = ?, runner_attempt = ?
         WHERE run_id = ? AND status = 'scheduled'
           AND (runner_job_id IS NULL OR runner_job_id = ?)
           AND (runner_attempt IS NULL OR runner_attempt = ?)`,
      )
      .bind(jobId, attempt, runId, jobId, attempt)
      .run();
    return result.meta.changes === 1;
  },

  claimRunPublication: async ({ runId, occurredAt }) => {
    const result = await database
      .prepare(
        `UPDATE review_runs SET publication_claimed_at = ?
         WHERE run_id = ? AND status = 'scheduled' AND publication_claimed_at IS NULL`,
      )
      .bind(occurredAt, runId)
      .run();
    return result.meta.changes === 1;
  },

  markRunCompleted: async ({ runId, occurredAt }) => {
    const results = await database.batch([
      database
        .prepare(
          `UPDATE review_runs SET status = 'completed', updated_at = ?
           WHERE run_id = ? AND status = 'scheduled'`,
        )
        .bind(occurredAt, runId),
      database
        .prepare(
          `UPDATE deliveries SET status = 'completed', updated_at = ?
           WHERE delivery_id = (
             SELECT delivery_id FROM review_runs WHERE run_id = ?
           ) AND status = 'scheduled'`,
        )
        .bind(occurredAt, runId),
    ]);
    return results.every((result) => result.meta.changes === 1);
  },

  markRunSuperseded: async ({ runId, occurredAt }) => {
    const results = await database.batch([
      database
        .prepare(
          `UPDATE review_runs SET status = 'superseded', updated_at = ?
           WHERE run_id = ? AND status = 'scheduled'`,
        )
        .bind(occurredAt, runId),
      database
        .prepare(
          `UPDATE deliveries SET status = 'superseded', updated_at = ?
           WHERE delivery_id = (
             SELECT delivery_id FROM review_runs WHERE run_id = ?
           ) AND status = 'scheduled'`,
        )
        .bind(occurredAt, runId),
    ]);
    return results.every((result) => result.meta.changes === 1);
  },

  completeRunPublication: async ({ runId, occurredAt, fingerprints }) => {
    const results = await database.batch([
      ...fingerprints.map((fingerprint) =>
        database
          .prepare(
            `INSERT OR IGNORE INTO finding_fingerprints
              (repository_id, pull_request_number, head_sha, fingerprint, created_at)
             SELECT repository_id, pull_request_number, head_sha, ?, ?
             FROM review_runs WHERE run_id = ? AND status = 'scheduled'`,
          )
          .bind(fingerprint, occurredAt, runId),
      ),
      database
        .prepare(
          `UPDATE review_runs SET status = 'completed', updated_at = ?
           WHERE run_id = ? AND status = 'scheduled'`,
        )
        .bind(occurredAt, runId),
      database
        .prepare(
          `UPDATE deliveries SET status = 'completed', updated_at = ?
           WHERE delivery_id = (
             SELECT delivery_id FROM review_runs WHERE run_id = ?
           ) AND status = 'scheduled'`,
        )
        .bind(occurredAt, runId),
    ]);
    const transitionResults = results.slice(-2);
    return transitionResults.every((result) => result.meta.changes === 1);
  },

  getDeliveryOutcome: async (deliveryId) => {
    const row = await database.prepare(deliverySelect).bind(deliveryId).first<DeliveryRow>();
    return row === null ? undefined : outcomeFromRow(row);
  },

  getRunOutcome: async (runId) => {
    const row = await database.prepare(runOutcomeSelect).bind(runId).first<DeliveryRow>();
    return row === null ? undefined : outcomeFromRow(row);
  },
});
