import type { ModelUsageSummary, UpstreamUsage } from '@compte-rendu/contracts';

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

export const admitRequest = async (
  database: D1DatabaseLike,
  requestId: string,
  grant: AuthenticatedGrant,
  route: FrozenRoute,
): Promise<boolean> => {
  const inserted = await database
    .prepare(
      `WITH clock(now) AS (SELECT ${NOW_MS})
      INSERT INTO inference_requests (
        request_id, job_id, route, model, status,
        input_tokens, uncached_input_tokens, cache_read_tokens, cache_write_tokens,
        output_tokens, reasoning_tokens, created_at, finalized_at
      )
      SELECT ?, g.job_id, ?, NULL, 'pending', NULL, NULL, NULL, NULL, NULL, NULL, now, NULL
      FROM grants g, clock, json_each(g.route_mapping) route
      WHERE g.token_hash = ?
        AND g.revoked_at IS NULL
        AND g.expires_at > clock.now
        AND json_extract(route.value, '$.routeId') = ?
      LIMIT 1`,
    )
    .bind(requestId, route.routeId, grant.tokenHash, route.routeId)
    .run();
  return inserted.meta.changes === 1;
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

export const finalizeComplete = async (
  database: D1DatabaseLike,
  requestId: string,
  usage: UpstreamUsage,
): Promise<boolean> => {
  const result = await database
    .prepare(
      `UPDATE inference_requests
      SET status = 'complete', model = ?, input_tokens = ?, uncached_input_tokens = ?,
        cache_read_tokens = ?, cache_write_tokens = ?, output_tokens = ?,
        reasoning_tokens = ?, finalized_at = ${NOW_MS}
      WHERE request_id = ? AND status = 'pending'`,
    )
    .bind(...usageBindings(usage), requestId)
    .run();
  return result.meta.changes === 1;
};

export const savePartial = async (
  database: D1DatabaseLike,
  requestId: string,
  usage: UpstreamUsage,
): Promise<void> => {
  await database
    .prepare(
      `UPDATE inference_requests
      SET model = ?, input_tokens = ?, uncached_input_tokens = ?, cache_read_tokens = ?,
        cache_write_tokens = ?, output_tokens = ?, reasoning_tokens = ?
      WHERE request_id = ? AND status = 'pending'`,
    )
    .bind(...usageBindings(usage), requestId)
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

const USAGE_GROUP_LIMIT = 33;
const USAGE_ROW_LIMIT = 32;

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
  const models: UsageSummaryRow[] = rows.results.slice(0, USAGE_ROW_LIMIT).map((row) => ({
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
  return {
    version: 1,
    models,
    ...(rows.results.length > USAGE_ROW_LIMIT ? { truncated: true } : {}),
  };
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
