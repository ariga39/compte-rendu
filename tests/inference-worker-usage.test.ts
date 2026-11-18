import { describe, expect, it } from 'vitest';
import { readUsage } from '../apps/inference-worker/src/ledger';
import { SqliteD1Database } from './support/d1-database';

const setup = () => {
  const database = new SqliteD1Database(
    ['0001_grants.sql', '0002_requests.sql'],
    '../../apps/inference-worker/migrations',
  );
  return database;
};

const insertGrant = (database: SqliteD1Database, jobId: string, tokenHash: string | null) => {
  const now = Date.now();
  database.database
    .prepare(
      `INSERT INTO grants (
        job_id, token_hash, snapshot, route_mapping, issued_at, expires_at,
        latest_issue_deadline, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      jobId,
      tokenHash,
      JSON.stringify({ routes: ['review'] }),
      tokenHash === null ? null : JSON.stringify([]),
      now,
      now + 60_000,
      now,
      null,
    );
};

type RequestRow = {
  requestId: string;
  jobId: string;
  route: string;
  model: string | null;
  status: 'pending' | 'complete' | 'incomplete';
  input?: number | null;
  uncached?: number | null;
  cacheRead?: number | null;
  cacheWrite?: number | null;
  output?: number | null;
  reasoning?: number | null;
  createdAt: number;
};

const insertRequest = (database: SqliteD1Database, row: RequestRow) => {
  database.database
    .prepare(
      `INSERT INTO inference_requests (
        request_id, job_id, route, model, status, input_tokens, uncached_input_tokens,
        cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens,
        created_at, finalized_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .run(
      row.requestId,
      row.jobId,
      row.route,
      row.model,
      row.status,
      row.input ?? null,
      row.uncached ?? null,
      row.cacheRead ?? null,
      row.cacheWrite ?? null,
      row.output ?? null,
      row.reasoning ?? null,
      row.createdAt,
    );
};

describe('Inference Worker usage aggregation', () => {
  it('groups by route and model while preserving null, zero and reported denominators', async () => {
    const database = setup();
    try {
      insertGrant(database, 'job-group', 'hash-group');
      insertRequest(database, {
        requestId: 'request-1',
        jobId: 'job-group',
        route: 'review',
        model: 'native-review',
        status: 'complete',
        input: 0,
        uncached: 0,
        cacheRead: null,
        output: 0,
        reasoning: 0,
        createdAt: 1,
      });
      insertRequest(database, {
        requestId: 'request-2',
        jobId: 'job-group',
        route: 'review',
        model: 'native-review',
        status: 'pending',
        input: null,
        cacheRead: 2,
        createdAt: 2,
      });
      insertRequest(database, {
        requestId: 'request-3',
        jobId: 'job-group',
        route: 'review',
        model: 'native-review',
        status: 'incomplete',
        input: 4,
        uncached: 3,
        cacheRead: 1,
        output: 5,
        createdAt: 3,
      });

      await expect(readUsage(database, 'job-group')).resolves.toEqual({
        version: 1,
        models: [
          {
            route: 'review',
            model: 'native-review',
            requests: 3,
            incompleteRequests: 2,
            inputTokens: { total: 4, reportedRequests: 2 },
            uncachedInputTokens: { total: 3, reportedRequests: 2 },
            cacheReadTokens: { total: 3, reportedRequests: 2 },
            cacheWriteTokens: null,
            outputTokens: { total: 5, reportedRequests: 2 },
            reasoningTokens: { total: 0, reportedRequests: 1 },
          },
        ],
      });
    } finally {
      database.close();
    }
  });

  it('fetches at most 33 groups and reports truncation for the 32-row summary', async () => {
    const database = setup();
    try {
      insertGrant(database, 'job-groups', 'hash-groups');
      for (let index = 0; index < 33; index += 1) {
        insertRequest(database, {
          requestId: `request-${String(index).padStart(2, '0')}`,
          jobId: 'job-groups',
          route: 'review',
          model: `model-${String(index).padStart(2, '0')}`,
          status: 'complete',
          input: index,
          createdAt: index,
        });
      }

      const summary = await readUsage(database, 'job-groups');
      expect(summary?.models).toHaveLength(32);
      expect(summary?.truncated).toBe(true);
      expect(summary?.models[0]).toMatchObject({ model: 'model-00' });
      expect(summary?.models[31]).toMatchObject({ model: 'model-31' });
      expect(summary?.models.some((row) => row.model === 'model-32')).toBe(false);
    } finally {
      database.close();
    }
  });

  it('returns null for unknown and retired jobs regardless of leftover request rows', async () => {
    const database = setup();
    try {
      await expect(readUsage(database, 'job-unknown')).resolves.toBeNull();

      insertGrant(database, 'job-retired', null);
      insertRequest(database, {
        requestId: 'request-retired',
        jobId: 'job-retired',
        route: 'review',
        model: 'native-review',
        status: 'incomplete',
        input: 1,
        createdAt: 1,
      });
      await expect(readUsage(database, 'job-retired')).resolves.toBeNull();
    } finally {
      database.close();
    }
  });
});
