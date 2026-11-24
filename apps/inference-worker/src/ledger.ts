import { Option, Schema } from 'effect';
import {
  MODEL_USAGE_ROW_LIMIT,
  EffortAttemptDetail,
  type EffortJobDetail,
  type EffortOutcomeKind,
  type EffortRequestDetail,
  type EffortRouteState,
  type EffortRouteSummary,
  type ModelUsageSummary,
  type UpstreamUsage,
} from '@compte-rendu/contracts';

type UsageSummaryRow = ModelUsageSummary['models'][number];
type TokenCounter = NonNullable<UsageSummaryRow['inputTokens']>;
import { sha256Hex, type D1DatabaseLike, type D1PreparedStatementLike } from './grants.ts';
import { parseFrozenMapping, type FrozenRoute } from './routes.ts';

const NOW_MS = "CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER)";

export const GRANT_RETENTION_MS = 24 * 60 * 60 * 1000;
export const SWEEP_BATCH_SIZE = 100;

const BEARER = /^[A-Za-z0-9_-]{20,256}$/;

export interface AuthenticatedGrant {
  readonly jobId: string;
  readonly tokenHash: string;
  readonly routes: readonly FrozenRoute[];
  readonly expiresAt: number;
}

interface GrantRow {
  readonly job_id: string;
  readonly token_hash: string;
  readonly route_mapping: string | null;
  readonly expires_at: number;
}

export const authenticateGrant = async (
  database: D1DatabaseLike,
  authorization: string | null,
): Promise<AuthenticatedGrant | null> => {
  const match = authorization === null ? null : /^Bearer\s+(\S+)$/i.exec(authorization);
  if (match === null || match[1] === undefined || !BEARER.test(match[1])) return null;
  const tokenHash = await sha256Hex(match[1]);
  const row = await database
    .prepare(
      `SELECT job_id, token_hash, route_mapping, expires_at
      FROM grants
      WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ${NOW_MS}`,
    )
    .bind(tokenHash)
    .first<GrantRow>();
  if (row === null) return null;
  const routes = parseFrozenMapping(row.route_mapping);
  if (routes === null) return null;
  return {
    jobId: row.job_id,
    tokenHash: row.token_hash,
    routes,
    expiresAt: row.expires_at,
  };
};

export interface RequestAdmission {
  readonly admitted: boolean;
  readonly fallbackAt: number | null;
  readonly fallbackReason: string | null;
}

export const admitRequest = async (
  database: D1DatabaseLike,
  requestId: string,
  grant: AuthenticatedGrant,
  route: FrozenRoute,
): Promise<RequestAdmission> => {
  // One statement both admits the request and reads the shared fallback state
  // that was committed before admission. Normal requests add no D1 round trip.
  const admitted = await database
    .prepare(
      `WITH clock(now) AS (SELECT ${NOW_MS})
      INSERT INTO inference_requests (
        request_id, job_id, route, model, status,
        input_tokens, uncached_input_tokens, cache_read_tokens, cache_write_tokens,
        output_tokens, reasoning_tokens, created_at, finalized_at,
        effort_name, effort_generation, effort_fallback_at, effort_fallback_reason
      )
      SELECT ?, g.job_id, ?, NULL, 'pending', NULL, NULL, NULL, NULL, NULL, NULL, now, NULL,
        json_extract(route.value, '$.effort.name'),
        json_extract(route.value, '$.effortGeneration'),
        s.fallback_at,
        s.reason
      FROM grants g, clock, json_each(g.route_mapping) route
      LEFT JOIN route_effort_state s
        ON s.route_id = ?
        AND coalesce(json_extract(route.value, '$.effortGeneration'), 0) <= s.generation
      WHERE g.token_hash = ?
        AND g.revoked_at IS NULL
        AND g.expires_at > clock.now
        AND json_extract(route.value, '$.routeId') = ?
      LIMIT 1
      RETURNING effort_fallback_at AS fallbackAt, effort_fallback_reason AS fallbackReason`,
    )
    .bind(requestId, route.routeId, route.routeId, grant.tokenHash, route.routeId)
    .first<{ readonly fallbackAt: number | null; readonly fallbackReason: string | null }>();
  return admitted === null
    ? { admitted: false, fallbackAt: null, fallbackReason: null }
    : {
        admitted: true,
        fallbackAt: admitted.fallbackAt,
        fallbackReason: admitted.fallbackReason,
      };
};

export const retryStillAllowed = async (
  database: D1DatabaseLike,
  requestId: string,
  grant: AuthenticatedGrant,
  route: FrozenRoute,
): Promise<boolean> => {
  const row = await database
    .prepare(
      `SELECT 1 AS allowed
      FROM grants g
      JOIN inference_requests r ON r.job_id = g.job_id
      WHERE g.token_hash = ?
        AND g.revoked_at IS NULL
        AND g.expires_at > ${NOW_MS}
        AND r.request_id = ?
        AND r.status = 'pending'
        AND EXISTS (
          SELECT 1 FROM json_each(g.route_mapping) route
          WHERE json_extract(route.value, '$.routeId') = ?
        )
      LIMIT 1`,
    )
    .bind(grant.tokenHash, requestId, route.routeId)
    .first<{ readonly allowed: number }>();
  return row !== null;
};

const usageBindings = (usage: UpstreamUsage): readonly unknown[] => {
  const uncached =
    usage.inputTokens !== null &&
    usage.cacheReadTokens !== null &&
    usage.inputTokens >= usage.cacheReadTokens
      ? usage.inputTokens - usage.cacheReadTokens
      : null;
  return [
    usage.model,
    usage.inputTokens,
    uncached,
    usage.cacheReadTokens,
    usage.cacheWriteTokens,
    usage.outputTokens,
    usage.reasoningTokens,
  ];
};

export interface EffortFinalization {
  readonly routeId: string;
  readonly generation: number | null;
  readonly fallback: EffortOutcomeKind | null;
  readonly reason: string | null;
  readonly attempts: readonly EffortAttemptDetail[];
}

const attemptBindings = (attempts: readonly EffortAttemptDetail[]): readonly unknown[] => [
  attempts[0] === undefined ? null : JSON.stringify(attempts[0]),
  attempts[1] === undefined ? null : JSON.stringify(attempts[1]),
];

export interface CompletionResult {
  readonly completed: boolean;
  readonly switched: boolean;
}

export const finalizeComplete = async (
  database: D1DatabaseLike,
  requestId: string,
  usage: UpstreamUsage,
  effort?: EffortFinalization,
  grantTokenHash?: string,
): Promise<CompletionResult> => {
  const switched = effort?.fallback === 'switched';
  const complete = database
    .prepare(
      `UPDATE inference_requests
      SET status = 'complete', model = ?, input_tokens = ?, uncached_input_tokens = ?,
        cache_read_tokens = ?, cache_write_tokens = ?, output_tokens = ?,
        reasoning_tokens = ?, finalized_at = ${NOW_MS},
        attempt_one = ?, attempt_two = ?, fallback = ?, fallback_reason = ?
      WHERE request_id = ? AND status = 'pending'
        ${
          switched
            ? `AND EXISTS (
          SELECT 1 FROM grants g
          WHERE g.token_hash = ? AND g.revoked_at IS NULL AND g.expires_at > ${NOW_MS}
        )`
            : ''
        }`,
    )
    .bind(
      ...usageBindings(usage),
      ...attemptBindings(effort?.attempts ?? []),
      effort?.fallback ?? null,
      effort?.reason ?? null,
      requestId,
      ...(switched && grantTokenHash !== undefined ? [grantTokenHash] : []),
    );
  if (!switched || effort.generation === null || effort.routeId.length === 0) {
    const result = await complete.run();
    return { completed: result.meta.changes === 1, switched: false };
  }

  // The shared marker is committed atomically with this request's completion.
  // A newer generation is never closed by an older in-flight response, and an
  // already-tripped generation keeps the first observed time.
  const results = await database.batch([
    complete,
    database
      .prepare(
        `WITH clock(now) AS (SELECT ${NOW_MS})
        INSERT INTO route_effort_state (route_id, generation, fallback_at, reason)
        SELECT ?, ?, clock.now, ?
        FROM clock
        WHERE EXISTS (
          SELECT 1 FROM inference_requests WHERE request_id = ? AND status = 'complete'
        )
        ON CONFLICT(route_id) DO UPDATE SET
          generation = excluded.generation,
          fallback_at = excluded.fallback_at,
          reason = excluded.reason
        WHERE route_effort_state.generation < excluded.generation`,
      )
      .bind(effort.routeId, effort.generation, effort.reason ?? '', requestId),
  ]);
  return {
    completed: results[0]?.meta.changes === 1,
    switched: results[1]?.meta.changes === 1,
  };
};

export const savePartial = async (
  database: D1DatabaseLike,
  requestId: string,
  usage: UpstreamUsage,
  effort?: EffortFinalization,
): Promise<void> => {
  await database
    .prepare(
      `UPDATE inference_requests
      SET model = ?, input_tokens = ?, uncached_input_tokens = ?, cache_read_tokens = ?,
        cache_write_tokens = ?, output_tokens = ?, reasoning_tokens = ?,
        attempt_one = ?, attempt_two = ?, fallback = ?, fallback_reason = ?
      WHERE request_id = ? AND status = 'pending'`,
    )
    .bind(
      ...usageBindings(usage),
      ...attemptBindings(effort?.attempts ?? []),
      effort?.fallback ?? null,
      effort?.reason ?? null,
      requestId,
    )
    .run();
};

interface UsageGroupRow {
  readonly route: string;
  readonly model: string | null;
  readonly requests: number;
  readonly incomplete_requests: number;
  readonly input_total: number | null;
  readonly input_reported: number;
  readonly uncached_input_total: number | null;
  readonly uncached_input_reported: number;
  readonly cache_read_total: number | null;
  readonly cache_read_reported: number;
  readonly cache_write_total: number | null;
  readonly cache_write_reported: number;
  readonly output_total: number | null;
  readonly output_reported: number;
  readonly reasoning_total: number | null;
  readonly reasoning_reported: number;
}

const USAGE_GROUP_LIMIT = MODEL_USAGE_ROW_LIMIT + 1;

interface RequestEffortRow {
  readonly request_id: string;
  readonly route: string;
  readonly effort_name: string | null;
  readonly effort_generation: number | null;
  readonly fallback: EffortOutcomeKind | null;
  readonly fallback_reason: string | null;
  readonly attempt_one: string | null;
  readonly attempt_two: string | null;
  readonly created_at: number;
}

const DETAIL_PAGE_SIZE = 20;

interface DetailCursor {
  readonly createdAt: number;
  readonly requestId: string;
}

const encodeCursor = (row: RequestEffortRow): string =>
  btoa(JSON.stringify({ t: row.created_at, r: row.request_id }))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');

const decodeCursor = (cursor: string | undefined): DetailCursor | null => {
  if (cursor === undefined) return null;
  try {
    const padded = cursor.replaceAll('-', '+').replaceAll('_', '/');
    const parsed = JSON.parse(atob(padded)) as unknown;
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      !('t' in parsed) ||
      !('r' in parsed) ||
      typeof parsed.t !== 'number' ||
      typeof parsed.r !== 'string'
    )
      return null;
    return { createdAt: parsed.t, requestId: parsed.r };
  } catch {
    return null;
  }
};

const decodeAttempt = Schema.decodeUnknownOption(Schema.fromJsonString(EffortAttemptDetail));

const parseAttempts = (row: RequestEffortRow): EffortAttemptDetail[] => {
  const attempts: EffortAttemptDetail[] = [];
  for (const value of [row.attempt_one, row.attempt_two]) {
    if (value === null) continue;
    const decoded = decodeAttempt(value);
    if (Option.isSome(decoded)) attempts.push(decoded.value);
  }
  return attempts;
};

const readEffortRows = async (
  database: D1DatabaseLike,
  jobId: string,
  cursor?: DetailCursor | null,
  limit = DETAIL_PAGE_SIZE + 1,
): Promise<readonly RequestEffortRow[]> => {
  const rows = await database
    .prepare(
      `SELECT request_id, route, effort_name, effort_generation, fallback,
        fallback_reason, attempt_one, attempt_two, created_at
      FROM inference_requests
      WHERE job_id = ?
        ${cursor === null || cursor === undefined ? '' : 'AND (created_at > ? OR (created_at = ? AND request_id > ?))'}
      ORDER BY created_at, request_id
      LIMIT ?`,
    )
    .bind(
      jobId,
      ...(cursor === null || cursor === undefined
        ? []
        : [cursor.createdAt, cursor.createdAt, cursor.requestId]),
      limit,
    )
    .all<RequestEffortRow>();
  return rows.results;
};

interface EffortAggregateRow {
  readonly route: string;
  readonly effort_name: string | null;
  readonly effort_generation: number | null;
  readonly fallback: EffortOutcomeKind | null;
  readonly fallback_reason: string | null;
  readonly requests: number;
}

const readEffortAggregates = async (
  database: D1DatabaseLike,
  jobId: string,
): Promise<readonly EffortAggregateRow[]> => {
  const rows = await database
    .prepare(
      `SELECT route, effort_name, effort_generation, fallback, fallback_reason,
        COUNT(*) AS requests
      FROM inference_requests
      WHERE job_id = ?
        AND (effort_name IS NOT NULL OR effort_generation IS NOT NULL OR fallback IS NOT NULL)
      GROUP BY route, effort_name, effort_generation, fallback, fallback_reason
      ORDER BY MIN(created_at), MIN(request_id)
      LIMIT 2048`,
    )
    .bind(jobId)
    .all<EffortAggregateRow>();
  return rows.results;
};

const summarizeEfforts = (
  rows: readonly EffortAggregateRow[],
): { readonly efforts: EffortRouteSummary[]; readonly truncated: boolean } => {
  const routes = new Map<
    string,
    {
      selected: string | null;
      generation: number | null;
      outcomes: Map<
        string,
        { kind: EffortOutcomeKind | null; reason: string | null; requests: number }
      >;
    }
  >();
  for (const row of rows) {
    const entry = routes.get(row.route) ?? {
      selected: null,
      generation: null,
      outcomes: new Map(),
    };
    entry.selected ??= row.effort_name;
    entry.generation ??= row.effort_generation;
    const key = JSON.stringify([row.fallback, row.fallback_reason]);
    const outcome = entry.outcomes.get(key) ?? {
      kind: row.fallback,
      reason: row.fallback_reason,
      requests: 0,
    };
    outcome.requests += row.requests;
    entry.outcomes.set(key, outcome);
    routes.set(row.route, entry);
  }
  return {
    efforts: [...routes.entries()].slice(0, MODEL_USAGE_ROW_LIMIT).map(([route, entry]) => ({
      route,
      selected: entry.selected,
      generation: entry.generation,
      outcomes: [...entry.outcomes.values()].slice(0, 4),
    })),
    truncated:
      routes.size > MODEL_USAGE_ROW_LIMIT ||
      rows.length >= 2048 ||
      [...routes.values()].some((entry) => entry.outcomes.size > 4),
  };
};

const tokenCount = (total: number | null, reported: number): TokenCounter | null =>
  reported === 0 || total === null ? null : { total, reportedRequests: reported };

export const readUsage = async (
  database: D1DatabaseLike,
  jobId: string,
): Promise<ModelUsageSummary | null> => {
  const grant = await database
    .prepare('SELECT token_hash FROM grants WHERE job_id = ?')
    .bind(jobId)
    .first<{ readonly token_hash: string | null }>();
  if (grant === null || grant.token_hash === null) return null;
  const rows = await database
    .prepare(
      `SELECT route, model,
        COUNT(*) AS requests,
        SUM(CASE WHEN status = 'complete' THEN 0 ELSE 1 END) AS incomplete_requests,
        SUM(input_tokens) AS input_total,
        COUNT(input_tokens) AS input_reported,
        SUM(uncached_input_tokens) AS uncached_input_total,
        COUNT(uncached_input_tokens) AS uncached_input_reported,
        SUM(cache_read_tokens) AS cache_read_total,
        COUNT(cache_read_tokens) AS cache_read_reported,
        SUM(cache_write_tokens) AS cache_write_total,
        COUNT(cache_write_tokens) AS cache_write_reported,
        SUM(output_tokens) AS output_total,
        COUNT(output_tokens) AS output_reported,
        SUM(reasoning_tokens) AS reasoning_total,
        COUNT(reasoning_tokens) AS reasoning_reported
      FROM inference_requests
      WHERE job_id = ?
      GROUP BY route, model
      ORDER BY MIN(created_at), MIN(request_id)
      LIMIT ?`,
    )
    .bind(jobId, USAGE_GROUP_LIMIT)
    .all<UsageGroupRow>();
  const models: UsageSummaryRow[] = rows.results.slice(0, MODEL_USAGE_ROW_LIMIT).map((row) => ({
    route: row.route,
    model: row.model,
    requests: row.requests,
    incompleteRequests: row.incomplete_requests,
    inputTokens: tokenCount(row.input_total, row.input_reported),
    uncachedInputTokens: tokenCount(row.uncached_input_total, row.uncached_input_reported),
    cacheReadTokens: tokenCount(row.cache_read_total, row.cache_read_reported),
    cacheWriteTokens: tokenCount(row.cache_write_total, row.cache_write_reported),
    outputTokens: tokenCount(row.output_total, row.output_reported),
    reasoningTokens: tokenCount(row.reasoning_total, row.reasoning_reported),
  }));
  const effortSummary = summarizeEfforts(await readEffortAggregates(database, jobId));
  return {
    version: 1,
    models,
    ...(effortSummary.efforts.length === 0 ? {} : { efforts: effortSummary.efforts }),
    ...(rows.results.length > MODEL_USAGE_ROW_LIMIT || effortSummary.truncated
      ? { truncated: true }
      : {}),
  };
};

export const readEffortDetails = async (
  database: D1DatabaseLike,
  jobId: string,
  cursorValue?: string,
): Promise<EffortJobDetail | null> => {
  const grant = await database
    .prepare('SELECT token_hash FROM grants WHERE job_id = ?')
    .bind(jobId)
    .first<{ readonly token_hash: string | null }>();
  if (grant === null || grant.token_hash === null) return null;
  const cursor = cursorValue === undefined ? undefined : decodeCursor(cursorValue);
  if (cursorValue !== undefined && cursor === null)
    return { jobId, requests: [], nextCursor: null };
  const rows = await readEffortRows(database, jobId, cursor);
  const page = rows.slice(0, DETAIL_PAGE_SIZE);
  const last = page[page.length - 1];
  return {
    jobId,
    requests: page.map((row): EffortRequestDetail => ({
      requestId: row.request_id,
      route: row.route,
      selected: row.effort_name,
      generation: row.effort_generation,
      fallback: row.fallback,
      reason: row.fallback_reason,
      attempts: parseAttempts(row),
    })),
    nextCursor: rows.length > DETAIL_PAGE_SIZE && last !== undefined ? encodeCursor(last) : null,
  };
};

export const readRouteEffortStates = async (
  database: D1DatabaseLike,
): Promise<readonly EffortRouteState[]> => {
  const rows = await database
    .prepare(
      `SELECT route_id, generation, fallback_at, reason
      FROM route_effort_state
      ORDER BY route_id`,
    )
    .all<{
      readonly route_id: string;
      readonly generation: number;
      readonly fallback_at: number;
      readonly reason: string;
    }>();
  return rows.results.map((row) => ({
    routeId: row.route_id,
    generation: row.generation,
    fallbackAt: new Date(row.fallback_at).toISOString(),
    reason: row.reason,
  }));
};

export const sweep = async (
  database: D1DatabaseLike,
  retentionMs = GRANT_RETENTION_MS,
  limit = SWEEP_BATCH_SIZE,
): Promise<number> => {
  const expired = await database
    .prepare(
      `SELECT job_id FROM grants
      WHERE expires_at < (${NOW_MS}) - ?
      ORDER BY expires_at
      LIMIT ?`,
    )
    .bind(retentionMs, limit)
    .all<{ readonly job_id: string }>();
  if (expired.results.length === 0) return 0;
  const placeholders = expired.results.map(() => '?').join(', ');
  const ids = expired.results.map((row) => row.job_id);
  const statements: D1PreparedStatementLike[] = [
    database
      .prepare(`DELETE FROM inference_requests WHERE job_id IN (${placeholders})`)
      .bind(...ids),
    database.prepare(`DELETE FROM grants WHERE job_id IN (${placeholders})`).bind(...ids),
  ];
  await database.batch(statements);
  return ids.length;
};
