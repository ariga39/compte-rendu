import {
  GitHubSha,
  REVIEW_PROGRESS_STAGES,
  type ModelUsageSummary,
  type ReviewDecision,
  type RunnerProgressMilestone,
} from '@compte-rendu/contracts';
import type { ReviewRunStatus } from './review-records';
import {
  claimExpiryCutoff,
  samePullRequestBlockingClause,
  type D1DatabaseLike,
} from './review-store-support';

type GitHubShaValue = typeof GitHubSha.Type;

export type RepositoryVisibility = 'public' | 'private' | 'unknown';

export type PublicRunStatusValue =
  | 'scheduled'
  | 'completed'
  | 'failed'
  | 'superseded'
  | 'cancelled';

export interface PublicRunRow {
  modelUsage?: string | null;
  reviewConfiguration?: string | null;
  decision: ReviewDecision | null;
  runId: string;
  status: PublicRunStatusValue;
  installationId: number;
  repositoryId: number;
  pullRequestNumber: number;
  baseSha: GitHubShaValue | null;
  headSha: GitHubShaValue | null;
  baseRef: string | null;
  headRef: string | null;
  createdAt: string;
  claimedAt: string | null;
  terminalAt: string | null;
  executionStartedAt: string | null;
  submissionCompletedAt: string | null;
  cleanupCompletedAt: string | null;
  resultReceivedAt: string | null;
  publicationStartedAt: string | null;
  failurePhase: string | null;
  failureReason: string | null;
  failureHttpStatus: number | null;
  runnerJobId: string | null;
  runnerCleanupStatus: 'pending' | 'destroyed' | 'failed' | null;
  queueBlockReason: 'cleanup' | null;
  progressStage: 'checkout' | 'sandbox' | 'agent' | 'evidence' | 'cleanup' | null;
  lastProgressAt: string | null;
  progressMilestones: string | null;
  repositoryVisibilitySnapshot: 'private' | 'public' | null;
  legacyPublicVerifiedAt: string | null;
  repositoryFullName: string | null;
  repositoryVisibility: RepositoryVisibility;
  identityExpiresAt: string | null;
}

export interface PublicOverviewCounts {
  queued: number;
  claimed: number;
  publishedLast24h: number;
  failedLast24h: number;
  cancelledLast24h: number;
  cleanupAttention: number;
}

export interface PublicRunCursor {
  priority: number;
  createdAt: string;
  runId: string;
}

export interface PublicRunFilter {
  status:
    | 'all'
    | 'active'
    | 'queued'
    | 'in_progress'
    | 'published'
    | 'failed'
    | 'superseded'
    | 'cancelled';
  cleanup: 'all' | 'pending' | 'destroyed' | 'failed' | 'unknown';
  from?: string;
  to?: string;
}

export type PublicRunView = 'history' | 'current' | 'cleanup';
export type PublicRunStatus = PublicRunStatusValue;

export interface RepositoryMetadataRow {
  installationId: number;
  repositoryId: number;
  fullName: string | null;
  visibility: RepositoryVisibility;
  verifiedAt: string | null;
  identityExpiresAt: string | null;
  nextRefreshAt: string | null;
  revision: number;
  updatedAt: string;
}

export type RecordProgressInput = {
  runId: string;
  jobId: string;
  attempt: number;
  receivedAt: string;
  sequence: number;
  stage: 'checkout' | 'sandbox' | 'agent' | 'evidence' | 'cleanup';
  milestones: readonly RunnerProgressMilestone[];
};

export interface ProgressRow {
  progress_sequence: number | null;
  progress_stage: string | null;
  progress_milestones: string | null;
}

export interface PublicRunDbRow {
  model_usage?: string | null;
  review_configuration?: string | null;
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
  failure_http_status: number | null;
  runner_job_id: string | null;
  runner_cleanup_status: 'pending' | 'destroyed' | 'failed' | null;
  queue_block_reason: 'cleanup' | null;
  progress_stage: 'checkout' | 'sandbox' | 'agent' | 'evidence' | 'cleanup' | null;
  progress_received_at: string | null;
  progress_milestones: string | null;
  repository_visibility_snapshot: 'private' | 'public' | null;
  legacy_public_verified_at: string | null;
  repository_full_name: string | null;
  repository_visibility: RepositoryVisibility;
  identity_expires_at: string | null;
}

export const mapPublicRun = (row: PublicRunDbRow): PublicRunRow => ({
  modelUsage: row.model_usage,
  reviewConfiguration: row.review_configuration ?? null,
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
  failureHttpStatus: row.failure_http_status,
  runnerJobId: row.runner_job_id,
  runnerCleanupStatus: row.runner_cleanup_status,
  queueBlockReason: row.queue_block_reason,
  progressStage: row.progress_stage,
  lastProgressAt: row.progress_received_at,
  progressMilestones: row.progress_milestones,
  repositoryVisibilitySnapshot: row.repository_visibility_snapshot,
  legacyPublicVerifiedAt: row.legacy_public_verified_at,
  repositoryFullName: row.repository_full_name,
  repositoryVisibility: row.repository_visibility,
  identityExpiresAt: row.identity_expires_at,
});

export interface MetadataDbRow {
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

export const mapMetadataRow = (row: MetadataDbRow): RepositoryMetadataRow => ({
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

export const queueBlockReasonColumn = (
  expiredBefore: string,
) => `CASE WHEN r.status = 'scheduled' AND r.runner_job_id IS NULL
  AND EXISTS (
    SELECT 1 FROM review_runs AS blocker
    WHERE ${samePullRequestBlockingClause('blocker', 'r', expiredBefore)}
      AND blocker.rowid <> r.rowid
      AND blocker.status IN ('failed', 'superseded', 'cancelled')
      AND blocker.runner_cleanup_status IN ('pending', 'failed')
  ) THEN 'cleanup' ELSE NULL END AS queue_block_reason`;

export const publicRunColumns = (expiredBefore: string) => `
  r.run_id, r.status, r.installation_id, r.repository_id, r.pull_request_number,
  r.base_sha, r.head_sha, r.base_ref, r.head_ref, r.review_decision,
  r.review_configuration,
  r.created_at, r.claimed_at, r.terminal_at, r.result_received_at, r.publication_started_at, r.runner_job_id, r.failure_phase, r.failure_reason, r.failure_http_status,
  r.runner_cleanup_status, ${queueBlockReasonColumn(expiredBefore)},
  r.progress_stage, r.progress_received_at, r.progress_milestones,
  r.execution_started_at, r.submission_completed_at, r.cleanup_completed_at,
  r.repository_visibility_snapshot, r.legacy_public_verified_at,
  m.full_name AS repository_full_name,
  COALESCE(m.visibility, 'unknown') AS repository_visibility,
  m.identity_expires_at
`;

export const dispatchPriority = `(CASE WHEN r.runner_job_id IS NOT NULL THEN 0 ELSE 1 END)`;

export const publicRunFrom = `
  FROM review_runs r
  LEFT JOIN repository_metadata m
    ON m.installation_id = r.installation_id AND m.repository_id = r.repository_id
`;

type ProgressStage = (typeof REVIEW_PROGRESS_STAGES)[number];
type ProgressMilestone = RunnerProgressMilestone;

export const parseMilestones = (raw: string | null): ProgressMilestone[] => {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is ProgressMilestone =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as { stage?: unknown }).stage === 'string' &&
        (REVIEW_PROGRESS_STAGES as readonly string[]).includes(
          (entry as { stage: string }).stage,
        ) &&
        typeof (entry as { startedAt?: unknown }).startedAt === 'string',
    );
  } catch {
    return [];
  }
};

export const mergeMilestones = (
  existing: string | null,
  incoming: readonly ProgressMilestone[],
): string => {
  const byStage = new Map<ProgressStage, ProgressMilestone>();
  for (const milestone of parseMilestones(existing)) byStage.set(milestone.stage, milestone);
  for (const milestone of incoming) {
    if (!byStage.has(milestone.stage)) byStage.set(milestone.stage, milestone);
  }
  return JSON.stringify(REVIEW_PROGRESS_STAGES.flatMap((stage) => byStage.get(stage) ?? []));
};

export const progressStageIndex = (stage: string | null): number =>
  stage === null ? -1 : (REVIEW_PROGRESS_STAGES as readonly string[]).indexOf(stage);

export const statusFilterValue = (
  status: PublicRunFilter['status'],
): ReviewRunStatus | undefined => {
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
    case 'cancelled':
      return 'cancelled';
    case 'all':
      return undefined;
  }
};

export const cleanupAttentionClause = `((r.runner_cleanup_status = 'failed') OR (r.status IN ('completed', 'failed', 'superseded', 'cancelled') AND r.runner_cleanup_status = 'pending'))`;

export const buildPublicRunWhere = (
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

export const recordLifecycleSnapshot = async (
  database: D1DatabaseLike,
  input: RecordProgressInput,
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

export interface DashboardMetadataStore {
  getPublicOverview(input: {
    since: string;
    limit: number;
  }): Promise<{ counts: PublicOverviewCounts; rows: readonly PublicRunRow[] }>;
  listPublicRuns(input: {
    limit: number;
    cursor?: PublicRunCursor;
    filter: PublicRunFilter;
    view: PublicRunView;
  }): Promise<readonly PublicRunRow[]>;
  getPublicRun(runId: string): Promise<PublicRunRow | undefined>;
  recordProgress(input: RecordProgressInput): Promise<boolean>;
  recordModelUsage(input: {
    runId: string;
    jobId: string;
    attempt: number;
    usage: ModelUsageSummary;
  }): Promise<boolean>;
  recordTerminalLifecycle(input: RecordProgressInput): Promise<boolean>;
  listDueRepositoryMetadata(input: {
    now: string;
    limit: number;
  }): Promise<readonly RepositoryMetadataRow[]>;
  claimRepositoryRefresh(input: {
    installationId: number;
    repositoryId: number;
    expectedRevision: number;
    claimedAt: string;
    staleBefore: string;
  }): Promise<boolean>;
  recordRepositoryRefresh(input: {
    installationId: number;
    repositoryId: number;
    expectedRevision: number;
    claimedAt: string;
    fullName: string;
    visibility: 'public' | 'private';
    verifiedAt: string;
    identityExpiresAt: string | null;
    nextRefreshAt: string;
    updatedAt: string;
  }): Promise<boolean>;
  deferRepositoryRefresh(input: {
    installationId: number;
    repositoryId: number;
    expectedRevision: number;
    claimedAt: string;
    nextRefreshAt: string;
    updatedAt: string;
  }): Promise<boolean>;
  invalidateRepositoryMetadata(input: {
    installationId: number;
    repositoryId: number;
    visibility: 'private' | 'unknown';
    expectedRevision?: number;
    updatedAt: string;
    nextRefreshAt: string;
  }): Promise<boolean>;
  invalidateRepositoryMetadataBatch(input: {
    installationId: number;
    repositoryIds: readonly number[];
    visibility: 'private' | 'unknown';
    updatedAt: string;
    nextRefreshAt: string;
  }): Promise<number>;
  getRepositoryRefreshBacklog(input: {
    now: string;
  }): Promise<{ due: number; oldestDueAt: string | null }>;
  getRefreshCooldown(): Promise<string | undefined>;
  setRefreshCooldown(input: { nextAllowedAt: string }): Promise<void>;
}

export const createDashboardMetadataStore = (database: D1DatabaseLike): DashboardMetadataStore => ({
  getPublicOverview: async ({ since, limit }) => {
    const expiredBefore = claimExpiryCutoff(new Date().toISOString());
    const result = await database
      .prepare(`WITH totals AS (SELECT
        COUNT(CASE WHEN status = 'scheduled' AND runner_job_id IS NULL THEN 1 END) AS queued,
        COUNT(CASE WHEN status = 'scheduled' AND runner_job_id IS NOT NULL THEN 1 END) AS claimed,
        COUNT(CASE WHEN status = 'completed' AND created_at >= ? THEN 1 END) AS publishedLast24h,
        COUNT(CASE WHEN status = 'failed' AND created_at >= ? THEN 1 END) AS failedLast24h,
        COUNT(CASE WHEN status = 'cancelled' AND created_at >= ? THEN 1 END) AS cancelledLast24h,
        COUNT(CASE WHEN ${cleanupAttentionClause} THEN 1 END) AS cleanupAttention
        FROM review_runs r),
      current AS (SELECT ${publicRunColumns(expiredBefore)} ${publicRunFrom}
        WHERE r.status = 'scheduled'
        ORDER BY ${dispatchPriority} ASC, r.created_at ASC, r.run_id ASC LIMIT ?)
      SELECT totals.*, current.* FROM totals LEFT JOIN current ON TRUE
      ORDER BY CASE WHEN current.runner_job_id IS NOT NULL THEN 0 ELSE 1 END,
        current.created_at ASC, current.run_id ASC`)
      .bind(since, since, since, limit)
      .all<PublicRunDbRow & PublicOverviewCounts>();
    const first = result.results[0];
    if (first === undefined) throw new Error('dashboard overview unavailable');
    return {
      counts: {
        queued: first.queued,
        claimed: first.claimed,
        publishedLast24h: first.publishedLast24h,
        failedLast24h: first.failedLast24h,
        cancelledLast24h: first.cancelledLast24h,
        cleanupAttention: first.cleanupAttention,
      },
      rows: result.results.filter((row) => row.run_id !== null).map(mapPublicRun),
    };
  },

  listPublicRuns: async ({ limit, cursor, filter, view }) => {
    const expiredBefore = claimExpiryCutoff(new Date().toISOString());
    const { clauses, params } = buildPublicRunWhere(filter, view, cursor);
    const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;
    const order =
      view === 'current'
        ? `ORDER BY ${dispatchPriority} ASC, r.created_at ASC, r.run_id ASC`
        : `ORDER BY r.created_at DESC, r.run_id DESC`;
    const rows = await database
      .prepare(
        `SELECT ${publicRunColumns(expiredBefore)} ${publicRunFrom} ${where} ${order} LIMIT ?`,
      )
      .bind(...params, limit)
      .all<PublicRunDbRow>();
    return rows.results.map(mapPublicRun);
  },

  getPublicRun: async (runId) => {
    const expiredBefore = claimExpiryCutoff(new Date().toISOString());
    const row = await database
      .prepare(
        `SELECT ${publicRunColumns(expiredBefore)}, r.model_usage ${publicRunFrom} WHERE r.run_id = ?`,
      )
      .bind(runId)
      .first<PublicRunDbRow>();
    return row === null ? undefined : mapPublicRun(row);
  },

  recordModelUsage: async ({ runId, jobId, attempt, usage }) => {
    const result = await database
      .prepare(
        `UPDATE review_runs SET model_usage = ?
       WHERE run_id = ? AND runner_job_id = ? AND runner_attempt = ? AND model_usage IS NULL`,
      )
      .bind(JSON.stringify(usage), runId, jobId, attempt)
      .run();
    return result.meta.changes > 0;
  },
  recordProgress: (input) => recordLifecycleSnapshot(database, input, false),
  recordTerminalLifecycle: (input) => recordLifecycleSnapshot(database, input, true),
  getRepositoryRefreshBacklog: async ({ now }) => {
    const row = await database
      .prepare(`SELECT COUNT(*) AS due,
      MIN(COALESCE(next_refresh_at, updated_at)) AS oldestDueAt
      FROM repository_metadata WHERE next_refresh_at IS NULL OR next_refresh_at <= ?`)
      .bind(now)
      .first<{ due: number; oldestDueAt: string | null }>();
    if (row === null) throw new Error('metadata backlog unavailable');
    return row;
  },

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
      repositoryIds.length === 0 ? '' : ' AND repository_id IN (SELECT value FROM json_each(?))';
    const guard = visibility === 'unknown' ? " AND visibility != 'private'" : '';
    const result = await database
      .prepare(
        `UPDATE repository_metadata SET
           visibility = ?, full_name = NULL, verified_at = NULL, identity_expires_at = NULL,
           refresh_claimed_at = NULL, next_refresh_at = ?,
           revision = revision + 1, updated_at = ?
         WHERE installation_id = ?${scope}${guard}`,
      )
      .bind(
        visibility,
        nextRefreshAt,
        updatedAt,
        installationId,
        ...(repositoryIds.length ? [JSON.stringify(repositoryIds)] : []),
      )
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
});
