import type { ReviewDecision } from '@compte-rendu/contracts';
import type {
  ReviewDeliveryRecord,
  ReviewJob,
  ReviewOutcome,
  ReviewCheckSetupStatus,
  ReviewRunStatus,
  ReviewStateQueries,
  ReviewStateStore,
  ReviewStoredStatus,
  PublicRunCursor,
  PublicRunFilter,
  PublicRunRow,
  PublicRunView,
  RepositoryMetadataRow,
  RepositoryVisibility,
} from './index';
import type { ReviewEvidenceMetadata, RunnerCleanupStatus } from './index';

export interface D1ResultLike {
  readonly meta: {
    readonly changes: number;
  };
}

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  run(): Promise<D1ResultLike>;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ readonly results: readonly T[] }>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
  batch(statements: readonly D1PreparedStatementLike[]): Promise<readonly D1ResultLike[]>;
}

export type D1ReviewStateStore = ReviewStateStore & ReviewStateQueries;

interface DeliveryRow {
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
  runner_job_id?: string | null;
  runner_attempt?: number | null;
  comment_id?: number | null;
  check_run_id?: number | null;
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
  run_id: string;
  runner_job_id: string;
}

interface ProgressRow {
  progress_sequence: number | null;
  progress_stage: string | null;
  progress_milestones: string | null;
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
    case 'superseded':
    case 'claiming':
    case 'ignored':
    case 'rejected':
      return 'ignored' as const;
  }
};

const outcomeFromRow = (row: DeliveryRow): ReviewOutcome => ({
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
  ...(row.runner_job_id == null ? {} : { runnerJobId: row.runner_job_id }),
  ...(row.runner_attempt == null ? {} : { runnerAttempt: row.runner_attempt }),
  ...(row.comment_id == null ? {} : { commentId: row.comment_id }),
  ...(row.check_run_id == null ? {} : { checkRunId: row.check_run_id }),
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
    r.check_run_id,
    r.check_setup_status, r.review_decision,
    r.evidence_key, r.evidence_status,
    r.evidence_size, r.evidence_sha256, r.evidence_uploaded_at,
    r.execution_started_at, r.submission_completed_at, r.cleanup_completed_at
  FROM review_runs r
  JOIN deliveries d ON d.delivery_id = r.delivery_id
  WHERE r.run_id = ?
`;

interface PublicRunDbRow {
  review_decision: ReviewDecision | null;
  run_id: string;
  status: ReviewRunStatus;
  installation_id: number;
  repository_id: number;
  pull_request_number: number;
  base_sha: string | null;
  head_sha: string | null;
  base_ref: string | null;
  head_ref: string | null;
  created_at: string;
  claimed_at: string | null;
  terminal_at: string | null;
  execution_started_at: string | null;
  submission_completed_at: string | null;
  cleanup_completed_at: string | null;

  result_received_at: string | null;
  publication_started_at: string | null;
  failure_phase: string | null;
  failure_reason: string | null;
  runner_job_id: string | null;
  evidence_status: 'complete' | 'incomplete' | null;
  runner_cleanup_status: 'pending' | 'destroyed' | 'failed' | null;
  publication_claimed_at: string | null;
  progress_stage: 'checkout' | 'sandbox' | 'agent' | 'evidence' | 'cleanup' | null;
  progress_received_at: string | null;
  progress_milestones: string | null;
  repository_visibility_snapshot: 'private' | 'public' | null;
  legacy_public_verified_at: string | null;
  repository_full_name: string | null;
  repository_visibility: RepositoryVisibility;
  identity_expires_at: string | null;
}

const mapPublicRun = (row: PublicRunDbRow): PublicRunRow => ({
  decision: row.review_decision,
  runId: row.run_id,
  status: row.status,
  installationId: row.installation_id,
  repositoryId: row.repository_id,
  pullRequestNumber: row.pull_request_number,
  baseSha: row.base_sha,
  headSha: row.head_sha,
  baseRef: row.base_ref,
  headRef: row.head_ref,
  createdAt: row.created_at,
  claimedAt: row.claimed_at,
  terminalAt: row.terminal_at,
  executionStartedAt: row.execution_started_at,
  submissionCompletedAt: row.submission_completed_at,
  cleanupCompletedAt: row.cleanup_completed_at,

  resultReceivedAt: row.result_received_at,
  publicationStartedAt: row.publication_started_at,
  failurePhase: row.failure_phase,
  failureReason: row.failure_reason,
  runnerJobId: row.runner_job_id,
  evidenceStatus: row.evidence_status,
  runnerCleanupStatus: row.runner_cleanup_status,
  publicationClaimedAt: row.publication_claimed_at,
  progressStage: row.progress_stage,
  lastProgressAt: row.progress_received_at,
  progressMilestones: row.progress_milestones,
  repositoryVisibilitySnapshot: row.repository_visibility_snapshot,
  legacyPublicVerifiedAt: row.legacy_public_verified_at,
  repositoryFullName: row.repository_full_name,
  repositoryVisibility: row.repository_visibility,
  identityExpiresAt: row.identity_expires_at,
});

interface MetadataDbRow {
  installation_id: number;
  repository_id: number;
  full_name: string | null;
  visibility: RepositoryVisibility;
  verified_at: string | null;
  identity_expires_at: string | null;
  next_refresh_at: string | null;
  revision: number;
  updated_at: string;
}

const mapMetadataRow = (row: MetadataDbRow): RepositoryMetadataRow => ({
  installationId: row.installation_id,
  repositoryId: row.repository_id,
  fullName: row.full_name,
  visibility: row.visibility,
  verifiedAt: row.verified_at,
  identityExpiresAt: row.identity_expires_at,
  nextRefreshAt: row.next_refresh_at,
  revision: row.revision,
  updatedAt: row.updated_at,
});

const publicRunColumns = `
  r.run_id, r.status, r.installation_id, r.repository_id, r.pull_request_number,
  r.base_sha, r.head_sha, r.base_ref, r.head_ref, r.review_decision,
  r.created_at, r.claimed_at, r.terminal_at, r.result_received_at, r.publication_started_at, r.runner_job_id, r.failure_phase, r.failure_reason,
  r.evidence_status, r.runner_cleanup_status, r.publication_claimed_at,
  r.progress_stage, r.progress_received_at, r.progress_milestones,
  r.execution_started_at, r.submission_completed_at, r.cleanup_completed_at,
  r.repository_visibility_snapshot, r.legacy_public_verified_at,
  m.full_name AS repository_full_name,
  COALESCE(m.visibility, 'unknown') AS repository_visibility,
  m.identity_expires_at
`;

const dispatchPriority = `(CASE WHEN r.runner_job_id IS NOT NULL THEN 0 ELSE 1 END)`;

const publicRunFrom = `
  FROM review_runs r
  LEFT JOIN repository_metadata m
    ON m.installation_id = r.installation_id AND m.repository_id = r.repository_id
`;

const PROGRESS_STAGES = ['checkout', 'sandbox', 'agent', 'evidence', 'cleanup'] as const;
type ProgressStage = (typeof PROGRESS_STAGES)[number];
interface ProgressMilestone {
  stage: ProgressStage;
  startedAt: string;
}

const parseMilestones = (raw: string | null): ProgressMilestone[] => {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is ProgressMilestone =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as { stage?: unknown }).stage === 'string' &&
        (PROGRESS_STAGES as readonly string[]).includes((entry as { stage: string }).stage) &&
        typeof (entry as { startedAt?: unknown }).startedAt === 'string',
    );
  } catch {
    return [];
  }
};

const mergeMilestones = (
  existing: string | null,
  incoming: readonly ProgressMilestone[],
): string => {
  const byStage = new Map<ProgressStage, string>();
  for (const milestone of parseMilestones(existing))
    byStage.set(milestone.stage, milestone.startedAt);
  for (const milestone of incoming) {
    if (!byStage.has(milestone.stage)) byStage.set(milestone.stage, milestone.startedAt);
  }
  return JSON.stringify(
    PROGRESS_STAGES.filter((stage) => byStage.has(stage)).map((stage) => ({
      stage,
      startedAt: byStage.get(stage) as string,
    })),
  );
};

const progressStageIndex = (stage: string | null): number =>
  stage === null ? -1 : (PROGRESS_STAGES as readonly string[]).indexOf(stage);

const statusFilterValue = (status: PublicRunFilter['status']): ReviewRunStatus | undefined => {
  switch (status) {
    case 'active':
    case 'queued':
    case 'in_progress':
      return 'scheduled';
    case 'published':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'superseded':
      return 'superseded';
    case 'all':
      return undefined;
  }
};

const cleanupAttentionClause = `((r.runner_cleanup_status = 'failed') OR (r.status IN ('completed', 'failed', 'superseded') AND r.runner_cleanup_status = 'pending'))`;

const buildPublicRunWhere = (
  filter: PublicRunFilter,
  view: PublicRunView,
  cursor: PublicRunCursor | undefined,
): { clauses: string[]; params: unknown[] } => {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const status = statusFilterValue(filter.status);
  if (status !== undefined) {
    clauses.push('r.status = ?');
    params.push(status);
  }
  if (filter.status === 'queued') clauses.push('r.runner_job_id IS NULL');
  if (filter.status === 'in_progress') clauses.push('r.runner_job_id IS NOT NULL');
  if (view === 'current') {
    clauses.push(`r.status = 'scheduled'`);
  }
  if (filter.cleanup === 'unknown') {
    clauses.push('r.runner_cleanup_status IS NULL');
  } else if (filter.cleanup !== 'all') {
    clauses.push('r.runner_cleanup_status = ?');
    params.push(filter.cleanup);
  }
  if (view === 'cleanup') {
    clauses.push(cleanupAttentionClause);
  }
  if (filter.from !== undefined) {
    clauses.push('r.created_at >= ?');
    params.push(filter.from);
  }
  if (filter.to !== undefined) {
    clauses.push('r.created_at <= ?');
    params.push(filter.to);
  }
  if (cursor !== undefined) {
    if (view === 'current') {
      clauses.push(
        `(${dispatchPriority} > ? OR (${dispatchPriority} = ? AND (r.created_at > ? OR (r.created_at = ? AND r.run_id > ?))))`,
      );
      params.push(
        cursor.priority,
        cursor.priority,
        cursor.createdAt,
        cursor.createdAt,
        cursor.runId,
      );
    } else {
      clauses.push('(r.created_at < ? OR (r.created_at = ? AND r.run_id < ?))');
      params.push(cursor.createdAt, cursor.createdAt, cursor.runId);
    }
  }
  return { clauses, params };
};

const recordLifecycleSnapshot = async (
  database: D1DatabaseLike,
  input: Parameters<NonNullable<ReviewStateQueries['recordProgress']>>[0],
  terminal: boolean,
): Promise<boolean> => {
  const { runId, jobId, attempt, receivedAt, sequence, stage, milestones } = input;
  const statusGuard = terminal ? '' : " AND status = 'scheduled'";
  for (let retry = 0; retry < 5; retry += 1) {
    const current = await database
      .prepare(
        `SELECT progress_sequence, progress_stage, progress_milestones FROM review_runs
       WHERE run_id = ? AND runner_job_id = ? AND runner_attempt = ?${statusGuard}`,
      )
      .bind(runId, jobId, attempt)
      .first<ProgressRow>();
    if (current === null) return false;
    if (
      !terminal &&
      ((current.progress_sequence !== null && sequence <= current.progress_sequence) ||
        progressStageIndex(current.progress_stage) > progressStageIndex(stage))
    )
      return false;
    if (
      !terminal &&
      parseMilestones(current.progress_milestones).some((previous) =>
        milestones.some(
          (incoming) =>
            incoming.stage === previous.stage && incoming.startedAt !== previous.startedAt,
        ),
      )
    )
      return false;
    const nextStage =
      progressStageIndex(stage) >= progressStageIndex(current.progress_stage)
        ? stage
        : current.progress_stage;
    const nextSequence = Math.max(current.progress_sequence ?? 0, sequence);
    const merged = mergeMilestones(current.progress_milestones, milestones);
    if (
      nextSequence === current.progress_sequence &&
      nextStage === current.progress_stage &&
      merged === current.progress_milestones
    )
      return false;
    const result = await database
      .prepare(
        `UPDATE review_runs SET progress_sequence = ?, progress_stage = ?,
         progress_received_at = ?, progress_milestones = ?
       WHERE run_id = ? AND runner_job_id = ? AND runner_attempt = ?${statusGuard}
         AND progress_sequence IS ? AND progress_milestones IS ?`,
      )
      .bind(
        nextSequence,
        nextStage,
        receivedAt,
        merged,
        runId,
        jobId,
        attempt,
        current.progress_sequence,
        current.progress_milestones,
      )
      .run();
    if (result.meta.changes === 1) return true;
  }
  return false;
};

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
             status, created_at, updated_at, comment_id, check_setup_status,
             repository_visibility_snapshot, base_ref, head_ref)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, 'pending', ?, ?, ?
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
          job.repositoryVisibility ?? null,
          job.baseRef ?? null,
          job.headRef ?? null,
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
        `SELECT run_id, runner_job_id FROM review_runs
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
        : { runId: activeRunner.run_id, jobId: activeRunner.runner_job_id };
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
      ...(existingRun?.status !== 'scheduled' || existingRun.check_setup_status !== 'pending'
        ? {}
        : {
            runId: existingRun.run_id,
            checkSetupStatus: existingRun.check_setup_status,
          }),
      ...(activeRunnerJob ? { activeRunnerJob } : {}),
    };
  },

  claimNextJob: async ({ jobId, attempt, occurredAt }) => {
    const row = await database
      .prepare(
        `UPDATE review_runs
         SET runner_job_id = ?, runner_attempt = ?, runner_cleanup_status = 'pending',
           updated_at = ?, claimed_at = COALESCE(claimed_at, ?)
         WHERE run_id = (
           SELECT run_id FROM review_runs
           WHERE status = 'scheduled' AND runner_job_id IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM review_runs AS active
               WHERE active.installation_id = review_runs.installation_id
                 AND active.repository_id = review_runs.repository_id
                 AND active.pull_request_number = review_runs.pull_request_number
                 AND active.runner_job_id IS NOT NULL
                 AND (
                   active.status IN ('scheduled', 'superseded')
                   OR active.runner_cleanup_status IN ('pending', 'failed')
                 )
             )
           ORDER BY created_at ASC, rowid ASC
           LIMIT 1
         )
         RETURNING run_id, installation_id, repository_id, pull_request_number,
           base_sha, head_sha, trigger, comment_id, runner_job_id, runner_attempt,
           repository_visibility_snapshot, base_ref, head_ref`,
      )
      .bind(jobId, attempt, occurredAt, occurredAt)
      .first<ClaimRow>();

    if (row === null) return { kind: 'empty' as const };
    return {
      kind: 'claimed' as const,
      runId: row.run_id,
      jobId: row.runner_job_id,
      attempt: row.runner_attempt,
      job: {
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
    };
  },

  markSchedulingFailed: async ({ runId, occurredAt, releaseRunnerClaim, failure }) => {
    const statements: D1PreparedStatementLike[] = [
      database
        .prepare(
          `UPDATE review_runs SET status = 'failed', updated_at = ?, terminal_at = COALESCE(terminal_at, ?), failure_phase = ?, failure_reason = ?
           WHERE run_id = ? AND status = 'scheduled'`,
        )
        .bind(
          occurredAt,
          occurredAt,
          failure?.phase ?? 'scheduling',
          failure?.reason ?? 'unknown',
          runId,
        ),
      ...(releaseRunnerClaim === undefined
        ? []
        : [
            database
              .prepare(
                `UPDATE review_runs
                 SET runner_job_id = NULL, runner_attempt = NULL, runner_cleanup_status = NULL
                 WHERE run_id = ? AND runner_job_id = ? AND runner_attempt = ?`,
              )
              .bind(runId, releaseRunnerClaim.jobId, releaseRunnerClaim.attempt),
          ]),
      database
        .prepare(
          `UPDATE deliveries SET status = 'failed', updated_at = ?
           WHERE delivery_id = (
             SELECT delivery_id FROM review_runs WHERE run_id = ?
           ) AND status = 'scheduled'`,
        )
        .bind(occurredAt, runId),
    ];
    await database.batch(statements);
  },

  recordEvidence: async ({
    runId,
    evidence,
    sandboxCleanup,
    decision,
  }: {
    runId: string;
    evidence: ReviewEvidenceMetadata;
    sandboxCleanup?: RunnerCleanupStatus;
    decision?: ReviewDecision;
  }) => {
    const result = await database
      .prepare(
        `UPDATE review_runs SET
           evidence_key = ?, evidence_status = ?, evidence_size = ?,
           evidence_sha256 = ?, evidence_uploaded_at = ?,
           execution_started_at = ?, submission_completed_at = ?,
           cleanup_completed_at = ?,
           runner_cleanup_status = COALESCE(?, runner_cleanup_status),
           review_decision = COALESCE(review_decision, ?)
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
        sandboxCleanup ?? null,
        decision ?? null,
        runId,
        evidence.key,
      )
      .run();
    return result.meta.changes === 1;
  },

  recordRunnerJob: async ({ runId, jobId, attempt }) => {
    const result = await database
      .prepare(
        `UPDATE review_runs SET runner_job_id = ?, runner_attempt = ?, runner_cleanup_status = 'pending'
         WHERE run_id = ? AND status = 'scheduled'
           AND (runner_job_id IS NULL OR runner_job_id = ?)
           AND (runner_attempt IS NULL OR runner_attempt = ?)`,
      )
      .bind(jobId, attempt, runId, jobId, attempt)
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

  claimCheckSetup: async ({ runId, claimedAt, staleBefore }) => {
    const result = await database
      .prepare(
        `UPDATE review_runs SET check_setup_claimed_at = ?
         WHERE run_id = ? AND check_run_id IS NULL AND check_setup_status = 'pending'
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

  recordResultReceived: async ({ runId, jobId, attempt, occurredAt }) => {
    const result = await database
      .prepare(`UPDATE review_runs SET result_received_at = COALESCE(result_received_at, ?)
      WHERE run_id = ? AND runner_job_id = ? AND runner_attempt = ?`)
      .bind(occurredAt, runId, jobId, attempt)
      .run();
    return result.meta.changes === 1;
  },

  claimRunPublication: async ({ runId, occurredAt, publishing }) => {
    const result = await database
      .prepare(
        `UPDATE review_runs SET publication_claimed_at = ?, publication_started_at = CASE WHEN ? THEN COALESCE(publication_started_at, ?) ELSE publication_started_at END
         WHERE run_id = ? AND status IN ('scheduled', 'failed')
           AND publication_claimed_at IS NULL`,
      )
      .bind(occurredAt, publishing ? 1 : 0, occurredAt, runId)
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

  markRunSuperseded: async ({ runId, occurredAt }) => {
    const results = await database.batch([
      database
        .prepare(
          `UPDATE review_runs SET status = 'superseded', updated_at = ?, terminal_at = COALESCE(terminal_at, ?)
           WHERE run_id = ? AND status = 'scheduled'`,
        )
        .bind(occurredAt, occurredAt, runId),
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

  completeRunPublication: async ({ runId, occurredAt, fingerprints, decision }) => {
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
    const transitionResults = results.slice(-2);
    return transitionResults.every((result) => result.meta.changes === 1);
  },

  countPublicOverview: async ({ since }) => {
    const row = await database
      .prepare(`SELECT
      COUNT(CASE WHEN status = 'scheduled' AND runner_job_id IS NULL THEN 1 END) AS queued,
      COUNT(CASE WHEN status = 'scheduled' AND runner_job_id IS NOT NULL THEN 1 END) AS claimed,
      COUNT(CASE WHEN status = 'completed' AND created_at >= ? THEN 1 END) AS publishedLast24h,
      COUNT(CASE WHEN status = 'failed' AND created_at >= ? THEN 1 END) AS failedLast24h,
      COUNT(CASE WHEN ${cleanupAttentionClause} THEN 1 END) AS cleanupAttention
      FROM review_runs r`)
      .bind(since, since)
      .first<import('./index').PublicOverviewCounts>();
    if (row === null) throw new Error('dashboard overview unavailable');
    return row;
  },

  listPublicRuns: async ({ limit, cursor, filter, view }) => {
    const { clauses, params } = buildPublicRunWhere(filter, view, cursor);
    const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;
    const order =
      view === 'current'
        ? `ORDER BY ${dispatchPriority} ASC, r.created_at ASC, r.run_id ASC`
        : `ORDER BY r.created_at DESC, r.run_id DESC`;
    const rows = await database
      .prepare(`SELECT ${publicRunColumns} ${publicRunFrom} ${where} ${order} LIMIT ?`)
      .bind(...params, limit)
      .all<PublicRunDbRow>();
    return rows.results.map(mapPublicRun);
  },

  getPublicRun: async (runId) => {
    const row = await database
      .prepare(`SELECT ${publicRunColumns} ${publicRunFrom} WHERE r.run_id = ?`)
      .bind(runId)
      .first<PublicRunDbRow>();
    return row === null ? undefined : mapPublicRun(row);
  },

  recordProgress: (input) => recordLifecycleSnapshot(database, input, false),
  recordTerminalLifecycle: (input) => recordLifecycleSnapshot(database, input, true),

  listDueRepositoryMetadata: async ({ now, limit }) => {
    const rows = await database
      .prepare(
        `SELECT installation_id, repository_id, full_name, visibility, verified_at,
            identity_expires_at, next_refresh_at, revision, updated_at
         FROM repository_metadata
         WHERE (next_refresh_at IS NULL OR next_refresh_at <= ?)
         ORDER BY (next_refresh_at IS NULL) DESC, next_refresh_at ASC,
           installation_id ASC, repository_id ASC
         LIMIT ?`,
      )
      .bind(now, limit)
      .all<MetadataDbRow>();
    return rows.results.map(mapMetadataRow);
  },

  claimRepositoryRefresh: async ({
    installationId,
    repositoryId,
    expectedRevision,
    claimedAt,
    staleBefore,
  }) => {
    const result = await database
      .prepare(
        `UPDATE repository_metadata SET refresh_claimed_at = ?
         WHERE installation_id = ? AND repository_id = ? AND revision = ?
           AND (refresh_claimed_at IS NULL OR refresh_claimed_at <= ?)`,
      )
      .bind(claimedAt, installationId, repositoryId, expectedRevision, staleBefore)
      .run();
    return result.meta.changes === 1;
  },

  recordRepositoryRefresh: async ({
    installationId,
    repositoryId,
    expectedRevision,
    claimedAt,
    fullName,
    visibility,
    verifiedAt,
    identityExpiresAt,
    nextRefreshAt,
    updatedAt,
  }) => {
    const result = await database
      .prepare(
        `UPDATE repository_metadata SET
           full_name = ?, visibility = ?, verified_at = ?, identity_expires_at = ?,
           next_refresh_at = ?, refresh_claimed_at = NULL,
           revision = revision + 1, updated_at = ?
         WHERE installation_id = ? AND repository_id = ? AND revision = ?
           AND refresh_claimed_at = ?`,
      )
      .bind(
        fullName,
        visibility,
        verifiedAt,
        identityExpiresAt,
        nextRefreshAt,
        updatedAt,
        installationId,
        repositoryId,
        expectedRevision,
        claimedAt,
      )
      .run();
    return result.meta.changes === 1;
  },

  deferRepositoryRefresh: async ({
    installationId,
    repositoryId,
    expectedRevision,
    claimedAt,
    nextRefreshAt,
    updatedAt,
  }) => {
    const result = await database
      .prepare(
        `UPDATE repository_metadata SET
           next_refresh_at = ?, refresh_claimed_at = NULL, updated_at = ?
         WHERE installation_id = ? AND repository_id = ? AND revision = ?
           AND refresh_claimed_at = ?`,
      )
      .bind(nextRefreshAt, updatedAt, installationId, repositoryId, expectedRevision, claimedAt)
      .run();
    return result.meta.changes === 1;
  },

  invalidateRepositoryMetadata: async ({
    installationId,
    repositoryId,
    visibility,
    expectedRevision,
    updatedAt,
    nextRefreshAt,
  }) => {
    const revisionGuard = expectedRevision === undefined ? '' : ' AND revision = ?';
    const result = await database
      .prepare(
        `UPDATE repository_metadata SET
           visibility = ?, full_name = NULL, verified_at = NULL, identity_expires_at = NULL,
           refresh_claimed_at = NULL, next_refresh_at = ?,
           revision = revision + 1, updated_at = ?
         WHERE installation_id = ? AND repository_id = ?
           AND visibility != 'private'${revisionGuard}`,
      )
      .bind(
        visibility,
        nextRefreshAt,
        updatedAt,
        installationId,
        repositoryId,
        ...(expectedRevision === undefined ? [] : [expectedRevision]),
      )
      .run();
    return result.meta.changes === 1;
  },

  invalidateRepositoryMetadataBatch: async ({
    installationId,
    repositoryIds,
    visibility,
    updatedAt,
    nextRefreshAt,
  }) => {
    const scope =
      repositoryIds.length === 0
        ? ''
        : ` AND repository_id IN (${repositoryIds.map(() => '?').join(', ')})`;
    const guard = visibility === 'unknown' ? " AND visibility != 'private'" : '';
    const result = await database
      .prepare(
        `UPDATE repository_metadata SET
           visibility = ?, full_name = NULL, verified_at = NULL, identity_expires_at = NULL,
           refresh_claimed_at = NULL, next_refresh_at = ?,
           revision = revision + 1, updated_at = ?
         WHERE installation_id = ?${scope}${guard}`,
      )
      .bind(visibility, nextRefreshAt, updatedAt, installationId, ...repositoryIds)
      .run();
    return result.meta.changes;
  },

  getRefreshCooldown: async () => {
    const row = await database
      .prepare('SELECT next_allowed_at FROM dashboard_refresh_cooldown WHERE id = 1')
      .first<{ next_allowed_at: string }>();
    return row?.next_allowed_at;
  },

  setRefreshCooldown: async ({ nextAllowedAt }) => {
    await database
      .prepare(
        `INSERT INTO dashboard_refresh_cooldown (id, next_allowed_at) VALUES (1, ?)
         ON CONFLICT(id) DO UPDATE SET
           next_allowed_at = MAX(dashboard_refresh_cooldown.next_allowed_at, excluded.next_allowed_at)`,
      )
      .bind(nextAllowedAt)
      .run();
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
