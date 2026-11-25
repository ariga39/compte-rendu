import { REVIEW_ATTEMPT_BUDGET_MS } from '@compte-rendu/contracts';

export interface D1ResultLike {
  readonly meta: {
    readonly changes: number;
  };
  readonly results?: readonly unknown[];
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

export const claimExpiryCutoff = (occurredAt: string) => {
  const occurredMillis = Date.parse(occurredAt);
  return Number.isFinite(occurredMillis)
    ? new Date(occurredMillis - REVIEW_ATTEMPT_BUDGET_MS).toISOString()
    : '1970-01-01T00:00:00.000Z';
};

// A running claim blocks only for its execution budget. A known failed cleanup
// has no native TTL proof, so it blocks until destruction is confirmed and is
// never released by time. An unknown/unreported pending cleanup still expires
// with its durable claim budget so a lost Runner cannot deadlock the PR.
export const samePullRequestBlockingClause = (
  candidate: string,
  current: string,
  expiredBefore: string,
) =>
  `${candidate}.installation_id = ${current}.installation_id
    AND ${candidate}.repository_id = ${current}.repository_id
    AND ${candidate}.pull_request_number = ${current}.pull_request_number
    AND ${candidate}.runner_job_id IS NOT NULL
    AND (
      ${candidate}.status = 'scheduled'
      OR (
        ${candidate}.status IN ('failed', 'superseded', 'cancelled')
        AND ${candidate}.runner_cleanup_status = 'failed'
      )
      OR (
        ${candidate}.status IN ('failed', 'superseded', 'cancelled')
        AND ${candidate}.runner_cleanup_status = 'pending'
        AND (COALESCE(${candidate}.claimed_at, ${candidate}.created_at) > '${expiredBefore}')
      )
    )`;
