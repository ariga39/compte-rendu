import { expect, it } from 'vitest';
import { createD1ReviewStateStore } from '../apps/core/src/index';
import { createCoreWorker } from './support/core-worker-runtime';
import { SqliteD1Database } from './support/d1-database';

const selection = {
  reviewers: ['deepseek-review'],
  synthesis: 'deepseek-review',
};
const environment = (database: SqliteD1Database) => ({
  REVIEW_DB: database,
  GITHUB_APP_ID: '1',
  GITHUB_APP_PRIVATE_KEY: 'test-private-key',
  REVIEW_CONFIGURATION_TOKEN: 'operator-token',
  INFERENCE_RELAY: {
    catalog: async () => ({
      routes: [...selection.reviewers],
      lastAttemptAt: null,
      lastSuccessAt: null,
      rejected: 0,
      lastRefreshError: null,
    }),
    refreshCatalog: async () => {},
    issue: async () => ({ kind: 'invalid' as const }),
    revoke: async () => ({ kind: 'revoked' as const }),
    usage: async () => null,
  },
});

const settingsRequest = (method: string, body?: unknown) =>
  new Request('https://reviews.test/api/review-configuration', {
    method,
    headers: { authorization: 'Bearer operator-token', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const claimRequest = (body?: unknown) =>
  new Request('https://reviews.test/runner-claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const admit = (store: ReturnType<typeof createD1ReviewStateStore>, pullRequestNumber: number) =>
  store.claimReview({
    deliveryId: `delivery-${pullRequestNumber}`,
    occurredAt: '2026-10-19T00:00:00Z',
    job: {
      repositoryId: 11,
      installationId: 7,
      pullRequestNumber,
      baseSha: '1'.repeat(40),
      headSha: '2'.repeat(40),
      trigger: 'automatic',
    },
  });

const dependencies = (calls: string[]) => ({
  github: {
    getRepositoryUrl: async () => {
      calls.push('repository');
      return 'https://github.com/acme/reviewed.git';
    },
    loadReviewTarget: async () => ({ headSha: '2'.repeat(40) }),
  },
  getReadInstallationToken: async () => {
    calls.push('read-token');
    return { token: 'read-token', expiresAt: '2099-01-01T00:00:00Z' };
  },
});

it('returns the deployment desired concurrency on claim responses and probes', async () => {
  const database = new SqliteD1Database();
  try {
    const calls: string[] = [];
    const worker = createCoreWorker(environment(database), dependencies(calls));
    expect(
      (
        await worker.handleReviewConfiguration(
          settingsRequest('PUT', { revision: 0, selection, concurrency: 3 }),
        )
      ).status,
    ).toBe(200);
    const store = createD1ReviewStateStore(database);
    await admit(store, 42);

    const probe = await worker.claimRunnerJob(claimRequest({ probeOnly: true }));
    expect(probe.status).toBe(204);
    expect(probe.headers.get('x-compte-rendu-concurrency')).toBe('3');
    expect(probe.headers.get('cache-control')).toBe('no-store');
    expect(calls).toEqual([]);
    const untouched = database.database
      .prepare('SELECT runner_job_id, runner_claim_request_id FROM review_runs')
      .all() as Array<{ runner_job_id: string | null; runner_claim_request_id: string | null }>;
    expect(untouched).toEqual([{ runner_job_id: null, runner_claim_request_id: null }]);

    const claim = await worker.claimRunnerJob(claimRequest({}));
    expect(claim.status).toBe(200);
    expect(claim.headers.get('x-compte-rendu-concurrency')).toBe('3');
    expect((await claim.json()) as { pullRequestNumber: number }).toMatchObject({
      pullRequestNumber: 42,
    });
    expect(calls).toEqual(['repository', 'read-token']);
  } finally {
    database.close();
  }
});

it('signals an explicit default so a Runner can distinguish it from a transient read failure', async () => {
  const database = new SqliteD1Database();
  try {
    const worker = createCoreWorker(environment(database));
    const probe = await worker.claimRunnerJob(claimRequest({ probeOnly: true }));
    expect(probe.status).toBe(204);
    expect(probe.headers.get('x-compte-rendu-concurrency')).toBe('default');

    const claim = await worker.claimRunnerJob(claimRequest({}));
    expect(claim.status).toBe(204);
    expect(claim.headers.get('x-compte-rendu-concurrency')).toBe('default');
  } finally {
    database.close();
  }
});

it('rejects a malformed probe request without touching queued work', async () => {
  const database = new SqliteD1Database();
  try {
    const worker = createCoreWorker(environment(database));
    const store = createD1ReviewStateStore(database);
    await admit(store, 43);
    const response = await worker.claimRunnerJob(claimRequest({ probeOnly: 'yes' }));
    expect(response.status).toBe(400);
    const row = database.database.prepare('SELECT runner_job_id FROM review_runs').all() as Array<{
      runner_job_id: string | null;
    }>;
    expect(row).toEqual([{ runner_job_id: null }]);
  } finally {
    database.close();
  }
});
