import { ReviewConfiguration, type ReviewDecision } from '@compte-rendu/contracts';
import { Schema } from 'effect';
import type {
  ActiveRunnerJob,
  ReviewApproval,
  ReviewCheckSetupStatus,
  ReviewDeliveryRecord,
  ReviewDisposition,
  ReviewEvidenceMetadata,
  ReviewJob,
  ReviewOutcome,
  ReviewRunStatus,
  ReviewStoredStatus,
  RunnerCleanupStatus,
} from './review-records';
import {
  claimExpiryCutoff,
  samePullRequestBlockingClause,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
} from './review-store-support';

interface RunRow {
  run_id: string;
  status: ReviewRunStatus;
}

interface ReplayRunRow {
  run_id: string;
  status: ReviewRunStatus;
  check_setup_status: ReviewCheckSetupStatus;
}

interface ClaimRow {
  claimed_at: string | null;
  review_configuration: string | null;
  run_id: string;
  installation_id: number;
  repository_id: number;
  pull_request_number: number;
  base_sha: string;
  head_sha: string;
  trigger: ReviewJob['trigger'];
  comment_id?: number | null;
  runner_job_id: string;
  runner_attempt: number;
  repository_visibility_snapshot?: 'private' | 'public' | null;
  base_ref?: string | null;
  head_ref?: string | null;
}

interface ActiveRunnerRow {
  claimed_at: string | null;
  run_id: string;
  runner_job_id: string;
}

interface SupersededRunRow {
  run_id: string;
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
    case 'cancelled':
      return 'cancelled' as const;
    case 'superseded':
    case 'claiming':
    case 'ignored':
    case 'rejected':
      return 'ignored' as const;
  }
};

export interface DeliveryRow {
  review_decision?: ReviewDecision | null;
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
  claimed_at?: string | null;
  publication_claimed_at?: string | null;
  runner_job_id?: string | null;
  runner_attempt?: number | null;
  comment_id?: number | null;
  check_run_id?: number | null;
  runner_cleanup_status?: RunnerCleanupStatus | null;
  result_received_at?: string | null;
  check_setup_status: 'pending' | 'ready' | 'failed';
  evidence_key?: string | null;
  evidence_status?: 'complete' | 'incomplete' | null;
  evidence_size?: number | null;
  evidence_sha256?: string | null;
  evidence_uploaded_at?: string | null;
  execution_started_at?: string | null;
  submission_completed_at?: string | null;
  cleanup_completed_at?: string | null;
}

export const outcomeFromRow = (row: DeliveryRow): ReviewOutcome => ({
  ...(row.review_decision == null ? {} : { decision: row.review_decision }),
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
  ...(row.claimed_at == null ? {} : { claimedAt: row.claimed_at }),
  ...(row.publication_claimed_at == null
    ? {}
    : { publicationClaimedAt: row.publication_claimed_at }),
  ...(row.runner_job_id == null ? {} : { runnerJobId: row.runner_job_id }),
  ...(row.runner_attempt == null ? {} : { runnerAttempt: row.runner_attempt }),
  ...(row.comment_id == null ? {} : { commentId: row.comment_id }),
  ...(row.check_run_id == null ? {} : { checkRunId: row.check_run_id }),
  ...(row.runner_cleanup_status == null ? {} : { cleanup: row.runner_cleanup_status }),
  ...(row.result_received_at == null ? {} : { resultReceivedAt: row.result_received_at }),
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

export const runOutcomeSelect = `
  SELECT d.delivery_id, d.installation_id, d.repository_id, d.pull_request_number,
    d.base_sha, d.head_sha, d.trigger, r.status,
    r.created_at, r.updated_at, r.claimed_at, r.publication_claimed_at,
    r.runner_job_id, r.runner_attempt, r.comment_id,
    r.check_run_id, r.runner_cleanup_status, r.result_received_at,
    r.check_setup_status, r.review_decision,
    r.evidence_key, r.evidence_status,
    r.evidence_size, r.evidence_sha256, r.evidence_uploaded_at,
    r.execution_started_at, r.submission_completed_at, r.cleanup_completed_at
  FROM review_runs r
  JOIN deliveries d ON d.delivery_id = r.delivery_id
  WHERE r.run_id = ?
`;

const deliverySelect = `
  SELECT delivery_id, installation_id, repository_id, pull_request_number,
    base_sha, head_sha, trigger, status, created_at, updated_at
  FROM deliveries WHERE delivery_id = ?
`;

const STALE_CLAIM_SWEEP_LIMIT = 64;
const staleScheduledRunPage = `SELECT run_id, delivery_id, check_run_id FROM review_runs
  WHERE status = 'scheduled' AND runner_job_id IS NOT NULL
    AND COALESCE(claimed_at, created_at) <= ?
    AND (result_received_at IS NULL OR result_received_at <= ?)
    AND publication_started_at IS NULL
    AND (publication_claimed_at IS NULL OR publication_claimed_at <= ?)
  ORDER BY COALESCE(claimed_at, created_at) ASC, run_id ASC
  LIMIT ?`;

// Expire at most one bounded page per admission or claim attempt. The terminal
// Check delivery is enqueued from the same page before the run transitions; the
// existing reconciliation publishes it even when the Runner never returns.
export const expireStaleScheduledClaims = async (database: D1DatabaseLike, occurredAt: string) => {
  const expiredBefore = claimExpiryCutoff(occurredAt);
  const expired = await database
    .prepare(`SELECT run_id FROM (${staleScheduledRunPage}) LIMIT 1`)
    .bind(expiredBefore, expiredBefore, expiredBefore, STALE_CLAIM_SWEEP_LIMIT)
    .first<{ run_id: string }>();
  if (expired === null) return;
  await database.batch([
    database
      .prepare(
        `INSERT INTO review_check_deliveries
           (run_id, check_run_id, status, created_at, attempted_at)
         SELECT run_id, check_run_id, 'pending', ?, ?
         FROM (${staleScheduledRunPage})
         WHERE check_run_id IS NOT NULL
         ON CONFLICT(run_id) DO UPDATE SET status = 'pending',
           attempted_at = excluded.attempted_at, confirmed_at = NULL
         WHERE review_check_deliveries.check_run_id = excluded.check_run_id
           AND review_check_deliveries.status = 'pending'`,
      )
      .bind(
        occurredAt,
        occurredAt,
        expiredBefore,
        expiredBefore,
        expiredBefore,
        STALE_CLAIM_SWEEP_LIMIT,
      ),
    database
      .prepare(
        `UPDATE deliveries SET status = 'failed', updated_at = ?
         WHERE status = 'scheduled' AND delivery_id IN (
           SELECT delivery_id FROM (${staleScheduledRunPage})
         )`,
      )
      .bind(occurredAt, expiredBefore, expiredBefore, expiredBefore, STALE_CLAIM_SWEEP_LIMIT),
    database
      .prepare(
        `UPDATE review_runs SET status = 'failed', updated_at = ?, terminal_at = COALESCE(terminal_at, ?),
           runner_job_id = CASE WHEN claim_prepared = 0 AND runner_claim_request_id IS NOT NULL THEN NULL ELSE runner_job_id END,
           runner_attempt = CASE WHEN claim_prepared = 0 AND runner_claim_request_id IS NOT NULL THEN NULL ELSE runner_attempt END,
           runner_cleanup_status = CASE WHEN claim_prepared = 0 AND runner_claim_request_id IS NOT NULL THEN NULL ELSE runner_cleanup_status END,
           failure_phase = 'scheduling', failure_reason = 'timeout'
         WHERE run_id IN (
           SELECT run_id FROM (${staleScheduledRunPage})
         )`,
      )
      .bind(
        occurredAt,
        occurredAt,
        expiredBefore,
        expiredBefore,
        expiredBefore,
        STALE_CLAIM_SWEEP_LIMIT,
      ),
  ]);
};

export const claimResultFromRow = (row: ClaimRow, replay: boolean, occurredAt: string) => ({
  ...(replay ? { replay: true as const } : {}),
  kind: 'claimed' as const,
  runId: row.run_id,
  jobId: row.runner_job_id,
  attempt: row.runner_attempt,
  claimedAt: row.claimed_at ?? occurredAt,
  job: {
    ...(row.review_configuration === null
      ? {}
      : {
          reviewConfiguration: Schema.decodeUnknownSync(Schema.fromJsonString(ReviewConfiguration))(
            row.review_configuration,
          ),
        }),
    repositoryId: row.repository_id,
    pullRequestNumber: row.pull_request_number,
    installationId: row.installation_id,
    baseSha: row.base_sha as ReviewJob['baseSha'],
    headSha: row.head_sha as ReviewJob['headSha'],
    trigger: row.trigger,
    ...(row.comment_id == null ? {} : { commentId: row.comment_id }),
    ...(row.repository_visibility_snapshot == null
      ? {}
      : { repositoryVisibility: row.repository_visibility_snapshot }),
    ...(row.base_ref == null ? {} : { baseRef: row.base_ref }),
    ...(row.head_ref == null ? {} : { headRef: row.head_ref }),
  },
});

export interface ReviewLifecycleStore {
  claimReview(input: {
    deliveryId: string;
    job: ReviewJob;
    occurredAt: string;
    approval?: ReviewApproval;
  }): Promise<
    | {
        kind: 'claimed';
        runId: string;
        blockingCleanupStatus?: 'pending' | 'failed';
        activeRunnerJob?: ActiveRunnerJob;
        supersededRunIds?: readonly string[];
      }
    | {
        kind: 'replay';
        disposition: ReviewDisposition;
        runId?: string;
        checkSetupStatus?: ReviewCheckSetupStatus;
        blockingCleanupStatus?: 'pending' | 'failed';
        activeRunnerJob?: ActiveRunnerJob;
      }
    | {
        kind: 'existing';
        disposition: ReviewDisposition;
        runId?: string;
        checkSetupStatus?: ReviewCheckSetupStatus;
        blockingCleanupStatus?: 'pending' | 'failed';
        activeRunnerJob?: ActiveRunnerJob;
      }
  >;
  claimNextJob(input: {
    jobId: string;
    requestId?: string;
    attempt: number;
    occurredAt: string;
  }): Promise<
    | {
        kind: 'claimed';
        replay?: true;
        runId: string;
        jobId: string;
        attempt: number;
        claimedAt: string;
        job: ReviewJob;
      }
    | { kind: 'empty' }
    | { kind: 'preparing'; runId: string; jobId: string; claimedAt: string }
  >;
  markClaimPrepared(runId: string, jobId: string, attempt: number): Promise<boolean>;
  markSchedulingFailed(input: {
    failure?: import('@compte-rendu/contracts').PublicTaskFailure;
    runId: string;
    occurredAt: string;
    /** Refuse to overwrite a publication that already started. */
    requireUnpublished?: boolean;
    releaseRunnerClaim?: {
      jobId: string;
      attempt: number;
      requireUnprepared?: boolean;
    };
  }): Promise<boolean>;
  recordDelivery: (input: ReviewDeliveryRecord) => Promise<void>;
  claimStalledPublications(before: string, now: string, limit: number): Promise<readonly string[]>;
  listPriorReviewRunIds(runId: string): Promise<readonly string[]>;
  recordEvidenceUpload(input: {
    runId: string;
    jobId: string;
    attempt: number;
    evidence: {
      key: string;
      status: 'complete' | 'incomplete';
      size: number;
      sha256: string;
      uploadedAt: string;
    };
  }): Promise<boolean>;
  recordRunnerTerminal(input: {
    runId: string;
    jobId: string;
    attempt: number;
    cleanup: import('./review-records').RunnerCleanupStatus;
    executionStartedAt?: string;
    submissionCompletedAt?: string;
    cleanupCompletedAt?: string;
  }): Promise<boolean>;
  clearRunnerJob(input: { runId: string; jobId: string }): Promise<boolean>;
  markRunCompleted(input: { runId: string; occurredAt: string }): Promise<boolean>;
  markRunSuperseded(input: {
    runId: string;
    occurredAt: string;
    releaseRunnerClaim?: { jobId: string; attempt: number };
  }): Promise<boolean>;
  completeRunPublication(input: {
    runId: string;
    occurredAt: string;
    decision?: import('@compte-rendu/contracts').ReviewDecision;
  }): Promise<boolean>;
  recordResultReceived(input: {
    runId: string;
    jobId: string;
    attempt: number;
    occurredAt: string;
  }): Promise<boolean>;
  claimRunPublication(input: {
    runId: string;
    occurredAt: string;
    publishing?: boolean;
  }): Promise<boolean>;
  releaseRunPublicationClaim(input: { runId: string; occurredAt: string }): Promise<boolean>;
  getDeliveryOutcome(deliveryId: string): Promise<ReviewOutcome | undefined>;
  getRunOutcome(runId: string): Promise<ReviewOutcome | undefined>;
}

export const createReviewLifecycleStore = (
  database: D1DatabaseLike,
  defaultSelection: string | null,
): ReviewLifecycleStore => ({
  listPriorReviewRunIds: async (runId) => {
    const current = await database
      .prepare('SELECT run_id FROM review_runs WHERE run_id = ?')
      .bind(runId)
      .first();
    if (current === null) throw new Error('Review run unavailable');
    const rows = await database
      .prepare(`SELECT previous.run_id FROM review_runs AS previous
      JOIN review_runs AS current ON current.run_id = ?
      WHERE previous.installation_id = current.installation_id
        AND previous.repository_id = current.repository_id
        AND previous.pull_request_number = current.pull_request_number
        AND previous.rowid < current.rowid`)
      .bind(runId)
      .all<{ run_id: string }>();
    return rows.results.map((row) => row.run_id);
  },
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
    const expiredBefore = claimExpiryCutoff(occurredAt);
    await expireStaleScheduledClaims(database, occurredAt);
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
             status, created_at, updated_at, comment_id, check_setup_status,
             repository_visibility_snapshot, base_ref, head_ref, review_configuration)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, 'pending', ?, ?, ?,
             (SELECT json_patch(
                json_object('revision', revision, 'selection', json(COALESCE(selection, ?))),
                CASE WHEN COALESCE(json_array_length(effort_snapshot), 0) > 0
                  THEN json_object('efforts', json(effort_snapshot))
                  ELSE json_object() END)
              FROM review_configuration WHERE id = 1 AND (selection IS NOT NULL OR ? IS NOT NULL))
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
                     AND (
                       status = 'failed'
                       OR (status = 'cancelled'
                         AND (
                           runner_job_id IS NULL
                           OR runner_cleanup_status = 'destroyed'
                           OR (
                             runner_job_id IS NOT NULL
                             AND COALESCE(claimed_at, created_at) <= ?
                           )
                         ))
                     )
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
          job.repositoryVisibility ?? null,
          job.baseRef ?? null,
          job.headRef ?? null,
          defaultSelection,
          defaultSelection,
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
          expiredBefore,
        ),
      database
        .prepare(
          `INSERT INTO repository_metadata
            (installation_id, repository_id, visibility, revision, updated_at)
           SELECT ?, ?, 'unknown', 0, ?
           WHERE EXISTS (SELECT 1 FROM review_runs WHERE run_id = ? AND status = 'scheduled')
           ON CONFLICT(installation_id, repository_id) DO NOTHING`,
        )
        .bind(job.installationId, job.repositoryId, occurredAt, runId),
      database
        .prepare(
          `UPDATE review_runs
           SET status = 'superseded', updated_at = ?, terminal_at = COALESCE(terminal_at, ?)
           WHERE installation_id = ? AND repository_id = ?
             AND pull_request_number = ? AND head_sha <> ?
             AND status = 'scheduled' AND runner_job_id IS NULL
             AND EXISTS (
               SELECT 1 FROM review_runs
               WHERE run_id = ? AND delivery_id = ? AND status = 'scheduled'
             )`,
        )
        .bind(
          occurredAt,
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
    const activeRunner = await database
      .prepare(
        `SELECT run_id, runner_job_id, claimed_at FROM review_runs
         WHERE installation_id = ? AND repository_id = ?
           AND pull_request_number = ? AND head_sha <> ?
           AND status = 'scheduled' AND runner_job_id IS NOT NULL
         ORDER BY created_at ASC, rowid ASC LIMIT 1`,
      )
      .bind(job.installationId, job.repositoryId, job.pullRequestNumber, job.headSha)
      .first<ActiveRunnerRow>();
    const activeRunnerJob =
      activeRunner === null
        ? undefined
        : {
            runId: activeRunner.run_id,
            jobId: activeRunner.runner_job_id,
            claimedAt: activeRunner.claimed_at ?? undefined,
          };
    const supersededRun = await database
      .prepare(
        `SELECT run_id FROM review_runs
         WHERE installation_id = ? AND repository_id = ?
           AND pull_request_number = ? AND head_sha <> ?
           AND status = 'superseded' AND runner_job_id IS NULL
           AND updated_at = ?
         ORDER BY created_at ASC, rowid ASC LIMIT 1`,
      )
      .bind(job.installationId, job.repositoryId, job.pullRequestNumber, job.headSha, occurredAt)
      .first<SupersededRunRow>();
    const delivery = await database.prepare(deliverySelect).bind(deliveryId).first<DeliveryRow>();
    if (delivery === null) {
      throw new Error('D1 did not retain the claimed delivery');
    }
    // Admission feedback must use the state that actually blocks this retry,
    // not the cleanup status of whichever Check or comment started it. Only a
    // manual retry needs this additional lookup.
    const blockingCleanup =
      job.trigger === 'manual'
        ? await database
            .prepare(
              `SELECT blocker.runner_cleanup_status
               FROM review_runs AS blocker
               CROSS JOIN (
                 SELECT ? AS installation_id, ? AS repository_id, ? AS pull_request_number
               ) AS retry
               WHERE ${samePullRequestBlockingClause('blocker', 'retry', claimExpiryCutoff(occurredAt))}
                 AND blocker.status IN ('failed', 'superseded', 'cancelled')
               ORDER BY CASE blocker.runner_cleanup_status WHEN 'failed' THEN 0 ELSE 1 END
               LIMIT 1`,
            )
            .bind(job.installationId, job.repositoryId, job.pullRequestNumber)
            .first<{ runner_cleanup_status: 'pending' | 'failed' | null }>()
        : undefined;
    const blockingCleanupStatus =
      blockingCleanup === undefined || blockingCleanup === null
        ? undefined
        : (blockingCleanup.runner_cleanup_status ?? 'pending');
    const admission = blockingCleanupStatus === undefined ? {} : { blockingCleanupStatus };
    const disposition = dispositionForStatus(delivery.status);
    if ((results[0]?.meta.changes ?? 0) === 0) {
      const replayRun = await database
        .prepare(
          `SELECT run_id, status, check_setup_status FROM review_runs
           WHERE delivery_id = ? ORDER BY rowid DESC LIMIT 1`,
        )
        .bind(deliveryId)
        .first<ReplayRunRow>();
      return {
        kind: 'replay' as const,
        disposition,
        ...admission,
        ...(replayRun?.check_setup_status !== 'pending'
          ? {}
          : {
              runId: replayRun.run_id,
              checkSetupStatus: replayRun.check_setup_status,
            }),
        ...(activeRunnerJob ? { activeRunnerJob } : {}),
      };
    }

    const run = await database
      .prepare(
        `SELECT run_id, status FROM review_runs
         WHERE delivery_id = ? AND status = 'scheduled'`,
      )
      .bind(deliveryId)
      .first<RunRow>();
    if (run !== null) {
      return {
        kind: 'claimed' as const,
        runId: run.run_id,
        ...admission,
        ...(activeRunnerJob ? { activeRunnerJob } : {}),
        ...(supersededRun === null ? {} : { supersededRunIds: [supersededRun.run_id] }),
      };
    }

    const existingRun = await database
      .prepare(
        `SELECT run_id, status, check_setup_status FROM review_runs
         WHERE installation_id = ? AND repository_id = ?
           AND pull_request_number = ? AND head_sha = ?
           AND status IN ('scheduled', 'completed')
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .bind(job.installationId, job.repositoryId, job.pullRequestNumber, job.headSha)
      .first<ReplayRunRow>();
    return {
      kind: 'existing' as const,
      disposition,
      ...admission,
      ...(existingRun?.status !== 'scheduled' || existingRun.check_setup_status !== 'pending'
        ? {}
        : {
            runId: existingRun.run_id,
            checkSetupStatus: existingRun.check_setup_status,
          }),
      ...(activeRunnerJob ? { activeRunnerJob } : {}),
    };
  },

  claimNextJob: async ({ jobId, requestId, attempt, occurredAt }) => {
    const expiredBefore = claimExpiryCutoff(occurredAt);
    const selectClaim = () =>
      database
        .prepare(
          `UPDATE review_runs
           SET runner_job_id = ?, runner_attempt = ?, runner_claim_request_id = ?, runner_cleanup_status = 'pending',
             updated_at = ?, claimed_at = COALESCE(claimed_at, ?)
           WHERE NOT EXISTS (SELECT 1 FROM review_runs WHERE runner_claim_request_id = ?) AND run_id = (
             SELECT run_id FROM review_runs
             WHERE status = 'scheduled' AND runner_job_id IS NULL
               AND NOT EXISTS (
                 SELECT 1 FROM review_runs AS active
                 WHERE ${samePullRequestBlockingClause('active', 'review_runs', expiredBefore)}
               )
             ORDER BY created_at ASC, rowid ASC
             LIMIT 1
           )
           RETURNING run_id, installation_id, repository_id, pull_request_number,
             base_sha, head_sha, trigger, comment_id, runner_job_id, runner_attempt,
             repository_visibility_snapshot, base_ref, head_ref, review_configuration,
             claimed_at`,
        )
        .bind(jobId, attempt, requestId ?? null, occurredAt, occurredAt, requestId ?? null)
        .first<ClaimRow>();

    const existing =
      requestId === undefined
        ? null
        : await database
            .prepare(`SELECT run_id, installation_id, repository_id, pull_request_number,
               base_sha, head_sha, trigger, comment_id, runner_job_id, runner_attempt,
               repository_visibility_snapshot, base_ref, head_ref, review_configuration,
               claimed_at, claim_prepared FROM review_runs WHERE runner_claim_request_id = ? AND runner_job_id IS NOT NULL AND runner_attempt = ? AND status = 'scheduled'`)
            .bind(requestId, attempt)
            .first<ClaimRow & { claim_prepared: number }>();
    if (existing !== null) {
      if (!existing.claim_prepared)
        return {
          kind: 'preparing' as const,
          jobId: existing.runner_job_id,
          runId: existing.run_id,
          claimedAt: existing.claimed_at!,
        };
      return claimResultFromRow(existing, true, occurredAt);
    }

    // Sweep before fresh selection: unrelated eligible work must not starve a
    // pull request whose stale claim is past the execution budget.
    await expireStaleScheduledClaims(database, occurredAt);
    const row = await selectClaim();
    if (row === null) return { kind: 'empty' as const };
    return claimResultFromRow(row, false, occurredAt);
  },

  markClaimPrepared: async (runId, jobId, attempt) => {
    const result = await database
      .prepare(
        `UPDATE review_runs SET claim_prepared = 1 WHERE run_id = ? AND runner_job_id = ? AND runner_attempt = ? AND status = 'scheduled'`,
      )
      .bind(runId, jobId, attempt)
      .run();
    return result.meta.changes === 1;
  },

  markSchedulingFailed: async ({
    runId,
    occurredAt,
    releaseRunnerClaim,
    failure,
    requireUnpublished = false,
  }) => {
    const statements: D1PreparedStatementLike[] = [
      database
        .prepare(
          `UPDATE review_runs SET status = 'failed', updated_at = ?, terminal_at = COALESCE(terminal_at, ?), failure_phase = ?, failure_reason = ?, failure_http_status = ?
           WHERE run_id = ? AND status = 'scheduled'${
             requireUnpublished ? ' AND publication_started_at IS NULL' : ''
           }`,
        )
        .bind(
          occurredAt,
          occurredAt,
          failure?.phase ?? 'scheduling',
          failure?.reason ?? 'unknown',
          failure?.httpStatus ?? null,
          runId,
        ),
      ...(releaseRunnerClaim === undefined
        ? []
        : [
            database
              .prepare(
                `UPDATE review_runs
                 SET runner_job_id = NULL, runner_attempt = NULL, runner_cleanup_status = NULL
                 WHERE run_id = ? AND runner_job_id = ? AND runner_attempt = ?
                   AND status = 'failed'
                   AND (? = 0 OR (claim_prepared = 0 AND runner_claim_request_id IS NOT NULL))`,
              )
              .bind(
                runId,
                releaseRunnerClaim.jobId,
                releaseRunnerClaim.attempt,
                releaseRunnerClaim.requireUnprepared === true ? 1 : 0,
              ),
          ]),
      database
        .prepare(
          `UPDATE deliveries SET status = 'failed', updated_at = ?
           WHERE delivery_id = (
             SELECT delivery_id FROM review_runs WHERE run_id = ?
           ) AND status = 'scheduled'
             AND EXISTS (
               SELECT 1 FROM review_runs WHERE run_id = ? AND status = 'failed'
             )`,
        )
        .bind(occurredAt, runId, runId),
    ];
    const results = await database.batch(statements);
    return results[0]?.meta.changes === 1;
  },

  recordEvidenceUpload: async ({
    runId,
    jobId,
    attempt,
    evidence,
  }: {
    runId: string;
    jobId: string;
    attempt: number;
    evidence: {
      key: string;
      status: 'complete' | 'incomplete';
      size: number;
      sha256: string;
      uploadedAt: string;
    };
  }) => {
    const result = await database
      .prepare(
        `UPDATE review_runs SET
           evidence_key = ?, evidence_status = ?, evidence_size = ?,
           evidence_sha256 = ?, evidence_uploaded_at = ?
         WHERE run_id = ? AND runner_job_id = ? AND runner_attempt = ?`,
      )
      .bind(
        evidence.key,
        evidence.status,
        evidence.size,
        evidence.sha256,
        evidence.uploadedAt,
        runId,
        jobId,
        attempt,
      )
      .run();
    return result.meta.changes === 1;
  },

  recordRunnerTerminal: async ({
    runId,
    jobId,
    attempt,
    cleanup,
    executionStartedAt,
    submissionCompletedAt,
    cleanupCompletedAt,
  }: {
    runId: string;
    jobId: string;
    attempt: number;
    cleanup: import('./review-records').RunnerCleanupStatus;
    executionStartedAt?: string;
    submissionCompletedAt?: string;
    cleanupCompletedAt?: string;
  }) => {
    const result = await database
      .prepare(
        `UPDATE review_runs SET
           execution_started_at = COALESCE(execution_started_at, ?),
           submission_completed_at = COALESCE(submission_completed_at, ?),
           runner_cleanup_status = CASE
             WHEN runner_cleanup_status = 'destroyed' THEN 'destroyed'
             ELSE ?
           END,
           cleanup_completed_at = CASE
             WHEN runner_cleanup_status = 'destroyed' THEN
               CASE
                 WHEN cleanup_completed_at IS NOT NULL THEN cleanup_completed_at
                 WHEN ? = 'destroyed' THEN COALESCE(?, cleanup_completed_at)
                 ELSE cleanup_completed_at
               END
             WHEN ? = 'destroyed' THEN COALESCE(?, cleanup_completed_at)
             ELSE COALESCE(cleanup_completed_at, ?)
           END
         WHERE run_id = ? AND runner_job_id = ? AND runner_attempt = ?`,
      )
      .bind(
        executionStartedAt ?? null,
        submissionCompletedAt ?? null,
        cleanup,
        cleanup,
        cleanupCompletedAt ?? null,
        cleanup,
        cleanupCompletedAt ?? null,
        cleanupCompletedAt ?? null,
        runId,
        jobId,
        attempt,
      )
      .run();
    return result.meta.changes === 1;
  },

  clearRunnerJob: async ({ runId, jobId }) => {
    const result = await database
      .prepare(
        `UPDATE review_runs SET runner_job_id = NULL, runner_attempt = NULL
         WHERE run_id = ? AND runner_job_id = ? AND status = 'superseded'`,
      )
      .bind(runId, jobId)
      .run();
    return result.meta.changes === 1;
  },

  recordResultReceived: async ({ runId, jobId, attempt, occurredAt }) => {
    const result = await database
      .prepare(`UPDATE review_runs SET result_received_at = COALESCE(result_received_at, ?)
      WHERE run_id = ? AND runner_job_id = ? AND runner_attempt = ?`)
      .bind(occurredAt, runId, jobId, attempt)
      .run();
    return result.meta.changes === 1;
  },

  claimStalledPublications: async (before, now, limit) => {
    const result = await database
      .prepare(`UPDATE review_runs SET updated_at = ?
      WHERE run_id IN (SELECT run_id FROM review_runs
      WHERE status = 'scheduled' AND publication_started_at IS NOT NULL
        AND publication_claimed_at <= ? AND updated_at < ?
      ORDER BY updated_at, run_id LIMIT ?) RETURNING run_id`)
      .bind(now, before, now, limit)
      .all<{ run_id: string }>();
    return result.results.map((row) => row.run_id);
  },
  claimRunPublication: async ({ runId, occurredAt, publishing }) => {
    const result = await database
      .prepare(
        `UPDATE review_runs SET publication_claimed_at = ?, publication_started_at = CASE WHEN ? THEN COALESCE(publication_started_at, ?) ELSE publication_started_at END
         WHERE run_id = ? AND publication_claimed_at IS NULL
           AND (status = 'scheduled' OR (status = 'failed' AND ? = 0))`,
      )
      .bind(occurredAt, publishing ? 1 : 0, occurredAt, runId, publishing ? 1 : 0)
      .run();
    return result.meta.changes === 1;
  },

  releaseRunPublicationClaim: async ({ runId, occurredAt }) => {
    const result = await database
      .prepare(
        `UPDATE review_runs SET publication_claimed_at = NULL
         WHERE run_id = ? AND status = 'failed' AND publication_claimed_at = ?`,
      )
      .bind(runId, occurredAt)
      .run();
    return result.meta.changes === 1;
  },

  markRunCompleted: async ({ runId, occurredAt }) => {
    const results = await database.batch([
      database
        .prepare(
          `UPDATE review_runs SET status = 'completed', updated_at = ?, terminal_at = COALESCE(terminal_at, ?)
           WHERE run_id = ? AND status = 'scheduled'`,
        )
        .bind(occurredAt, occurredAt, runId),
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

  markRunSuperseded: async ({ runId, occurredAt, releaseRunnerClaim }) => {
    const update =
      releaseRunnerClaim === undefined
        ? database
            .prepare(
              `UPDATE review_runs SET status = 'superseded', updated_at = ?, terminal_at = COALESCE(terminal_at, ?)
           WHERE run_id = ? AND status = 'scheduled'`,
            )
            .bind(occurredAt, occurredAt, runId)
        : database
            .prepare(
              `UPDATE review_runs SET status = 'superseded', updated_at = ?, terminal_at = COALESCE(terminal_at, ?),
             runner_job_id = NULL, runner_attempt = NULL, runner_cleanup_status = NULL
           WHERE run_id = ? AND status IN ('scheduled', 'superseded')
             AND runner_job_id = ? AND runner_attempt = ?`,
            )
            .bind(
              occurredAt,
              occurredAt,
              runId,
              releaseRunnerClaim.jobId,
              releaseRunnerClaim.attempt,
            );
    const results = await database.batch([
      update,
      database
        .prepare(
          `UPDATE deliveries SET status = 'superseded', updated_at = ?
           WHERE delivery_id = (
             SELECT delivery_id FROM review_runs WHERE run_id = ? AND status = 'superseded'
           ) AND status = 'scheduled'`,
        )
        .bind(occurredAt, runId),
    ]);
    return results[0]?.meta.changes === 1;
  },

  completeRunPublication: async ({ runId, occurredAt, decision }) => {
    const results = await database.batch([
      database
        .prepare(
          `UPDATE review_runs SET status = 'completed', updated_at = ?, terminal_at = COALESCE(terminal_at, ?), review_decision = COALESCE(review_decision, ?)
           WHERE run_id = ? AND status = 'scheduled'`,
        )
        .bind(occurredAt, occurredAt, decision ?? null, runId),
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

  getDeliveryOutcome: async (deliveryId) => {
    const row = await database.prepare(deliverySelect).bind(deliveryId).first<DeliveryRow>();
    return row === null ? undefined : outcomeFromRow(row);
  },

  getRunOutcome: async (runId) => {
    const row = await database.prepare(runOutcomeSelect).bind(runId).first<DeliveryRow>();
    return row === null ? undefined : outcomeFromRow(row);
  },
});
