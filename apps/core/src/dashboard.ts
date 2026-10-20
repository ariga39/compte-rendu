import { DateTime, Effect, Option, Schema } from 'effect';
import {
  ModelUsageSummary,
  PublicTaskFailure,
  type PublicTaskState,
} from '@compte-rendu/contracts';
import { GitHubRequestError } from './github-review-adapter';
import type {
  GitHubAdapter,
  PublicRunCursor,
  PublicRunFilter,
  PublicRunRow,
  PublicRunView,
  RepositoryMetadataRow,
  ReviewPublicationStateStore,
} from './index';

const IDENTITY_LIFETIME_MS = 5 * 60 * 1000;
const REFRESH_INTERVAL_MS = 2 * 60 * 1000;
const CLAIM_WINDOW_MS = 30 * 1000;
const DEFAULT_BATCH = 8;
const DEFAULT_CONCURRENCY = 3;
const THROTTLE_COOLDOWN_MS = 60 * 1000;
const REFRESH_TIMEOUT_MS = 2000;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

const nowIso = () => Effect.runPromise(DateTime.now.pipe(Effect.map(DateTime.formatIso)));
const isoFromMs = (ms: number) =>
  Effect.runPromise(
    DateTime.now.pipe(
      Effect.map(() => DateTime.makeUnsafe(ms)),
      Effect.map(DateTime.formatIso),
    ),
  );

const withTimeout = <A>(promise: Promise<A>, ms: number, onTimeout: () => void): Promise<A> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new Error('repository lookup timed out'));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
};

export const IsoTimestamp = Schema.String.check(
  Schema.makeFilter((value) => Option.isSome(DateTime.make(value)), { expected: 'ISO timestamp' }),
);

const PublicExecutionStageValue = Schema.Literals([
  'checkout',
  'sandbox',
  'agent',
  'evidence',
  'cleanup',
]);
const PublicMilestoneSchema = Schema.Struct({
  stage: PublicExecutionStageValue,
  startedAt: IsoTimestamp,
});
const PublicMilestonesSchema = Schema.fromJsonString(Schema.Array(PublicMilestoneSchema));

const durationMs = (from: string | null, to: string | null): number | null => {
  if (from === null || to === null) return null;
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  return end - start;
};

const publicObservationTime = (value: string | null): string | null => {
  const decoded = Schema.decodeUnknownOption(IsoTimestamp)(value);
  return Option.isSome(decoded) ? DateTime.formatIso(DateTime.makeUnsafe(decoded.value)) : null;
};

export const projectPublicTask = (row: PublicRunRow, now: string): PublicTaskState => {
  const eligible =
    row.repositoryVisibility === 'public' &&
    row.repositoryFullName !== null &&
    row.identityExpiresAt !== null &&
    row.identityExpiresAt > now &&
    (row.repositoryVisibilitySnapshot === 'public' ||
      (row.repositoryVisibilitySnapshot === null && row.legacyPublicVerifiedAt !== null));
  const identity: PublicTaskState['identity'] = eligible
    ? {
        kind: 'public',
        repositoryFullName: row.repositoryFullName as string,
        pullRequestNumber: row.pullRequestNumber,
        pullRequestUrl: `https://github.com/${row.repositoryFullName}/pull/${row.pullRequestNumber}`,
        expiresAt: row.identityExpiresAt as string,
        baseRef: row.baseRef,
        headRef: row.headRef,
        baseSha: row.baseSha,
        headSha: row.headSha,
      }
    : { kind: 'anonymous' };
  return {
    runId: row.runId,
    status: row.status,
    dispatch: row.status === 'scheduled' ? (row.runnerJobId !== null ? 'claimed' : 'queued') : null,
    stage: row.progressStage,
    processing:
      row.status !== 'scheduled'
        ? null
        : row.publicationStartedAt !== null
          ? 'publishing'
          : row.resultReceivedAt !== null
            ? 'received'
            : null,
    identity,
    decision: row.decision,
    receivedAt: row.createdAt,
    claimedAt: row.claimedAt,
    terminalAt: row.terminalAt,
    executionStartedAt: publicObservationTime(row.executionStartedAt),
    submissionCompletedAt: publicObservationTime(row.submissionCompletedAt),
    cleanupCompletedAt: publicObservationTime(row.cleanupCompletedAt),

    resultReceivedAt: row.resultReceivedAt,
    publicationStartedAt: row.publicationStartedAt,
    lastProgressAt: row.lastProgressAt,
    queueWaitMs: durationMs(row.createdAt, row.claimedAt),
    totalDurationMs: durationMs(row.createdAt, row.terminalAt),
    cleanup: row.runnerCleanupStatus ?? 'unknown',
    failure: Option.getOrNull(
      Schema.decodeUnknownOption(PublicTaskFailure)({
        phase: row.failurePhase,
        reason: row.failureReason,
      }),
    ),
  };
};

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

const notFound = () =>
  new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } });
const badRequest = () =>
  new Response(null, { status: 400, headers: { 'cache-control': 'no-store' } });
const unavailable = () =>
  new Response(null, { status: 503, headers: { 'cache-control': 'no-store' } });

const StatusValue = Schema.Literals([
  'all',
  'active',
  'queued',
  'in_progress',
  'published',
  'failed',
  'superseded',
]);
const CleanupValue = Schema.Literals(['all', 'pending', 'destroyed', 'failed', 'unknown']);
const ViewValue = Schema.Literals(['history', 'current', 'cleanup']);

const CursorSchema = Schema.Struct({
  p: Schema.Int,
  c: Schema.NonEmptyString,
  r: Schema.NonEmptyString,
  v: ViewValue,
  s: StatusValue,
  f: CleanupValue,
  from: Schema.optional(IsoTimestamp),
  to: Schema.optional(IsoTimestamp),
});
type Cursor = typeof CursorSchema.Type;

const JobsQuerySchema = Schema.Struct({
  status: Schema.optional(StatusValue),
  cleanup: Schema.optional(CleanupValue),
  view: Schema.optional(ViewValue),
  from: Schema.optional(IsoTimestamp),
  to: Schema.optional(IsoTimestamp),
  limit: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
});

const base64UrlEncode = (value: string) =>
  globalThis.btoa(value).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const base64UrlDecode = (value: string) => {
  try {
    return globalThis.atob(value.replaceAll('-', '+').replaceAll('_', '/'));
  } catch {
    return undefined;
  }
};

const encodeCursor = (view: PublicRunView, filter: PublicRunFilter, row: PublicRunRow): string => {
  const priority = view === 'current' ? (row.runnerJobId !== null ? 0 : 1) : 0;
  return base64UrlEncode(
    JSON.stringify({
      p: priority,
      c: row.createdAt,
      r: row.runId,
      v: view,
      s: filter.status,
      f: filter.cleanup,
      ...(filter.from === undefined ? {} : { from: filter.from }),
      ...(filter.to === undefined ? {} : { to: filter.to }),
    }),
  );
};

const decodeCursor = (value: string): Cursor | undefined => {
  const decoded = base64UrlDecode(value);
  if (decoded === undefined) return undefined;
  const parsed = Schema.decodeUnknownOption(Schema.fromJsonString(CursorSchema))(decoded);
  return Option.isSome(parsed) ? parsed.value : undefined;
};

const cursorMatchesScope = (cursor: Cursor, view: PublicRunView, filter: PublicRunFilter) =>
  cursor.v === view &&
  cursor.s === filter.status &&
  cursor.f === filter.cleanup &&
  (cursor.from ?? undefined) === filter.from &&
  (cursor.to ?? undefined) === filter.to;

const cursorToRunCursor = (cursor: Cursor): PublicRunCursor => ({
  priority: cursor.p,
  createdAt: cursor.c,
  runId: cursor.r,
});

export interface DashboardDependencies {
  readonly stateStore: ReviewPublicationStateStore;
}

export const handleDashboardRequest = async (
  request: Request,
  dependencies: DashboardDependencies,
): Promise<Response | undefined> => {
  if (request.method !== 'GET') return undefined;
  const url = new URL(request.url);
  const store = dependencies.stateStore;
  const now = await nowIso();

  if (url.pathname === '/api/dashboard' || url.pathname === '/dashboard') {
    if (store.getPublicOverview === undefined) return unavailable();
    const since = await isoFromMs(Date.parse(now) - DAY_MS);
    const { counts, rows } = await store.getPublicOverview({ since, limit: DEFAULT_LIMIT });
    const last = rows.at(-1);
    return json({
      generatedAt: now,
      counts: {
        queued: counts.queued,
        claimed: counts.claimed,
        publishedLast24h: counts.publishedLast24h,
        failedLast24h: counts.failedLast24h,
      },
      cleanupAttention: counts.cleanupAttention,
      tasks: rows.map((row) => projectPublicTask(row, now)),
      nextCursor:
        rows.length === DEFAULT_LIMIT && last !== undefined
          ? encodeCursor('current', { status: 'all', cleanup: 'all' }, last)
          : null,
    });
  }

  if (url.pathname === '/api/jobs' || url.pathname === '/jobs') {
    if (store.listPublicRuns === undefined) return unavailable();
    const raw = {
      ...(url.searchParams.has('status') ? { status: url.searchParams.get('status') } : {}),
      ...(url.searchParams.has('cleanup') ? { cleanup: url.searchParams.get('cleanup') } : {}),
      ...(url.searchParams.has('view') ? { view: url.searchParams.get('view') } : {}),
      ...(url.searchParams.has('from') ? { from: url.searchParams.get('from') } : {}),
      ...(url.searchParams.has('to') ? { to: url.searchParams.get('to') } : {}),
      ...(url.searchParams.has('limit') ? { limit: Number(url.searchParams.get('limit')) } : {}),
    };
    const decoded = Schema.decodeUnknownOption(JobsQuerySchema)(raw);
    if (Option.isNone(decoded)) return badRequest();
    const query = decoded.value;
    const filter: PublicRunFilter = {
      status: query.status ?? 'all',
      cleanup: query.cleanup ?? 'all',
      ...(query.from === undefined ? {} : { from: new Date(query.from).toISOString() }),
      ...(query.to === undefined ? {} : { to: new Date(query.to).toISOString() }),
    };
    const view = query.view ?? 'history';
    const limit = Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const rawCursor = url.searchParams.get('cursor');
    let cursor: PublicRunCursor | undefined;
    if (rawCursor !== null) {
      const parsed = decodeCursor(rawCursor);
      if (parsed === undefined || !cursorMatchesScope(parsed, view, filter)) return badRequest();
      cursor = cursorToRunCursor(parsed);
    }
    const rows = await store.listPublicRuns({
      limit,
      filter,
      view,
      ...(cursor === undefined ? {} : { cursor }),
    });
    const tasks = rows.map((row) => projectPublicTask(row, now));
    const last = rows.at(-1);
    return json({
      generatedAt: now,
      tasks,
      nextCursor:
        rows.length === limit && last !== undefined ? encodeCursor(view, filter, last) : null,
    });
  }

  const detailPrefix = '/api/jobs/';
  if (url.pathname.startsWith(detailPrefix) || url.pathname.startsWith('/jobs/')) {
    if (store.getPublicRun === undefined) return unavailable();
    const prefix = url.pathname.startsWith(detailPrefix) ? detailPrefix : '/jobs/';
    let runId: string;
    try {
      runId = decodeURIComponent(url.pathname.slice(prefix.length));
    } catch {
      return notFound();
    }
    if (runId.length === 0 || runId.includes('/')) return notFound();
    const row = await store.getPublicRun(runId);
    if (row === undefined) return notFound();
    const parsedMilestones =
      row.progressMilestones === null
        ? Option.none()
        : Schema.decodeUnknownOption(PublicMilestonesSchema)(row.progressMilestones);
    const milestones = Option.isSome(parsedMilestones) ? parsedMilestones.value : [];
    return json({
      generatedAt: now,
      task: projectPublicTask(row, now),
      usage:
        row.modelUsage == null
          ? null
          : Option.getOrNull(
              Schema.decodeUnknownOption(Schema.fromJsonString(ModelUsageSummary))(row.modelUsage),
            ),
      milestones,
      processingMilestones: [
        ...(row.resultReceivedAt === null
          ? []
          : [{ stage: 'received', startedAt: row.resultReceivedAt }]),
        ...(row.publicationStartedAt === null
          ? []
          : [{ stage: 'publishing', startedAt: row.publicationStartedAt }]),
      ],
    });
  }

  return undefined;
};

const RepositoryMetadata = Schema.Struct({
  full_name: Schema.String,
  visibility: Schema.Literals(['public', 'private']),
});

export interface RepositoryRefreshDependencies {
  readonly stateStore: ReviewPublicationStateStore;
  readonly github: GitHubAdapter;
  readonly batch?: number;
  readonly concurrency?: number;
  readonly now?: string;
  readonly timeoutMs?: number;
}

export interface RefreshSummary {
  readonly dispatched: number;
  readonly failed: number;
  readonly skipped: 'unavailable' | 'cooldown' | '';
}

export const refreshRepositoryMetadata = async (
  dependencies: RepositoryRefreshDependencies,
): Promise<RefreshSummary> => {
  const store = dependencies.stateStore;
  if (
    store.listDueRepositoryMetadata === undefined ||
    store.claimRepositoryRefresh === undefined ||
    store.recordRepositoryRefresh === undefined ||
    store.deferRepositoryRefresh === undefined
  ) {
    return { dispatched: 0, failed: 0, skipped: 'unavailable' };
  }
  const now = dependencies.now ?? (await nowIso());
  const cooldown = (await store.getRefreshCooldown?.()) ?? undefined;
  if (cooldown !== undefined && cooldown > now)
    return { dispatched: 0, failed: 0, skipped: 'cooldown' };
  const timeoutMs = dependencies.timeoutMs ?? REFRESH_TIMEOUT_MS;
  const batch = dependencies.batch ?? DEFAULT_BATCH;
  const concurrency = Math.max(1, dependencies.concurrency ?? DEFAULT_CONCURRENCY);
  const due = await store.listDueRepositoryMetadata({ now, limit: batch });
  const staleBefore = await isoFromMs(Date.parse(now) - CLAIM_WINDOW_MS);
  const nextRefreshAt = await isoFromMs(Date.parse(now) + REFRESH_INTERVAL_MS);
  let dispatched = 0;
  let failed = 0;
  let throttled = false;
  const processRow = async (row: RepositoryMetadataRow): Promise<void> => {
    if (throttled) return;
    const claimed = await store.claimRepositoryRefresh!({
      installationId: row.installationId,
      repositoryId: row.repositoryId,
      expectedRevision: row.revision,
      claimedAt: now,
      staleBefore,
    });
    if (!claimed) return;
    if (dependencies.github.getRepositoryMetadata === undefined) return;
    const controller = new AbortController();
    try {
      const metadata = await Schema.decodeUnknownPromise(RepositoryMetadata)(
        await withTimeout(
          dependencies.github.getRepositoryMetadata({
            repositoryId: row.repositoryId,
            installationId: row.installationId,
            signal: controller.signal,
          }),
          timeoutMs,
          () => controller.abort(),
        ),
      );
      const identityExpiresAt =
        metadata.visibility === 'public'
          ? await isoFromMs(Date.parse(now) + IDENTITY_LIFETIME_MS)
          : null;
      await store.recordRepositoryRefresh!({
        installationId: row.installationId,
        repositoryId: row.repositoryId,
        expectedRevision: row.revision,
        claimedAt: now,
        fullName: metadata.full_name,
        visibility: metadata.visibility,
        verifiedAt: now,
        identityExpiresAt,
        nextRefreshAt,
        updatedAt: now,
      });
      dispatched += 1;
    } catch (error) {
      if (error instanceof GitHubRequestError && (error.status === 429 || error.status === 403)) {
        throttled = true;
        failed += 1;
        await store.setRefreshCooldown?.({
          nextAllowedAt: await isoFromMs(
            Date.parse(now) + (error.retryAfterMs ?? THROTTLE_COOLDOWN_MS),
          ),
        });
        return;
      }
      if (error instanceof GitHubRequestError && error.status === 404) {
        const revoked = await store.invalidateRepositoryMetadata?.({
          installationId: row.installationId,
          repositoryId: row.repositoryId,
          visibility: 'unknown',
          expectedRevision: row.revision,
          updatedAt: now,
          nextRefreshAt,
        });
        if (revoked !== true) {
          await store.deferRepositoryRefresh!({
            installationId: row.installationId,
            repositoryId: row.repositoryId,
            expectedRevision: row.revision,
            claimedAt: now,
            nextRefreshAt,
            updatedAt: now,
          });
        }
        return;
      }
      failed += 1;
      await store.deferRepositoryRefresh!({
        installationId: row.installationId,
        repositoryId: row.repositoryId,
        expectedRevision: row.revision,
        claimedAt: now,
        nextRefreshAt,
        updatedAt: now,
      });
    }
  };
  for (let index = 0; index < due.length; index += concurrency) {
    await Promise.all(due.slice(index, index + concurrency).map(processRow));
  }
  return { dispatched, failed, skipped: '' };
};

export const validateProgressSnapshot = (snapshot: {
  stage: string;
  milestones: readonly { stage: string; startedAt: string }[];
}): boolean => {
  const stages = ['checkout', 'sandbox', 'agent', 'evidence', 'cleanup'] as const;
  if (snapshot.milestones.length === 0) return false;
  let lastIndex = -1;
  let previousStartedAt: string | undefined;
  for (const milestone of snapshot.milestones) {
    const index = stages.indexOf(milestone.stage as (typeof stages)[number]);
    if (index < 0 || index <= lastIndex) return false;
    const parsed = DateTime.make(milestone.startedAt);
    if (Option.isNone(parsed)) return false;
    if (DateTime.formatIso(parsed.value) !== milestone.startedAt) return false;
    if (previousStartedAt !== undefined && milestone.startedAt < previousStartedAt) return false;
    previousStartedAt = milestone.startedAt;
    lastIndex = index;
  }
  const stageIndex = stages.indexOf(snapshot.stage as (typeof stages)[number]);
  if (stageIndex < 0) return false;
  return stageIndex === lastIndex;
};
