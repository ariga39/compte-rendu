import { expect, it } from 'vitest';
import { createCoreWorker } from '../apps/core/src/core-worker';
import { SqliteD1Database } from './support/d1-database';
import { createIngressWorker } from '../apps/ingress/src/index';
import { createD1ReviewStateStore } from '../apps/core/src/index';

const selection = {
  reviewers: ['deepseek-review', 'step-review'],
  synthesis: 'deepseek-review',
};
const environment = (database: SqliteD1Database) => ({
  REVIEW_DB: database,
  GITHUB_APP_ID: '1',
  GITHUB_APP_PRIVATE_KEY: 'test-private-key',
  REVIEW_CONFIGURATION_TOKEN: 'operator-token',
});

it('freezes model selection at admission even when a queued job is claimed after an update', async () => {
  const database = new SqliteD1Database();
  try {
    const dependencies = {
      github: { getRepositoryUrl: async () => 'https://github.com/acme/reviewed.git' },
      getReadInstallationToken: async () => ({
        token: 'read-token',
        expiresAt: '2099-01-01T00:00:00Z',
      }),
    };
    const core = createCoreWorker(environment(database), dependencies);
    const store = createD1ReviewStateStore(database);
    const admit = (number: number) =>
      store.claimReview({
        deliveryId: `delivery-${number}`,
        occurredAt: '2026-10-19T00:00:00Z',
        job: {
          repositoryId: 11,
          installationId: 7,
          pullRequestNumber: number,
          baseSha: '1'.repeat(40),
          headSha: '2'.repeat(40),
          trigger: 'automatic',
        },
      });
    const claim = async () => {
      const worker = createCoreWorker(environment(database), dependencies);
      const response = await worker.fetch(
        new Request('https://core.internal/runner-claims', {
          method: 'POST',
          headers: { 'x-compte-rendu-runner-claim': 'verified' },
        }),
      );
      expect(response.status).toBe(200);
      return response.json();
    };
    await core.fetch(settingsRequest('PUT', { revision: 0, selection }));
    await admit(42);
    const running = await claim();
    expect(running.reviewConfiguration).toEqual({ revision: 1, selection });
    await admit(43);
    const replacement = { reviewers: ['step-review', 'another-review'], synthesis: 'step-review' };
    expect(
      (await core.fetch(settingsRequest('PUT', { revision: 1, selection: replacement }))).status,
    ).toBe(200);
    await admit(44);
    const queued = await claim();
    expect(queued.pullRequestNumber).toBe(43);
    expect(queued.reviewConfiguration).toEqual({ revision: 1, selection });
    const next = await claim();
    expect(next.pullRequestNumber).toBe(44);
    expect(next.reviewConfiguration).toEqual({ revision: 2, selection: replacement });
    expect(running.reviewConfiguration).toEqual({ revision: 1, selection });
  } finally {
    database.close();
  }
});
const settingsRequest = (method: string, body?: unknown, token = 'operator-token') =>
  new Request('https://core.internal/review-configuration', {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

it('persists operator-selected review models across fresh Core workers', async () => {
  const database = new SqliteD1Database();
  try {
    const worker = createCoreWorker(environment(database));
    const initial = await worker.fetch(settingsRequest('GET'));
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({ revision: 0, selection: null });
    const saved = await worker.fetch(settingsRequest('PUT', { revision: 0, selection }));
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ revision: 1, selection });
    const restored = await createCoreWorker(environment(database)).fetch(settingsRequest('GET'));
    expect(restored.status).toBe(200);
    expect(await restored.json()).toEqual({ revision: 1, selection });
  } finally {
    database.close();
  }
});

it('protects settings through ingress and preserves valid settings on invalid or stale updates', async () => {
  const database = new SqliteD1Database();
  try {
    const core = createCoreWorker(environment(database));
    const ingress = createIngressWorker({
      secret: 'webhook-secret',
      allowedInstallationIds: '[7]',
      crypto: globalThis.crypto,
      core,
    });
    const request = (method: string, body?: unknown, token?: string) => {
      const input = settingsRequest(method, body, token);
      return ingress.fetch(new Request('https://reviews.example/api/review-configuration', input));
    };
    expect((await request('PUT', { revision: 0, selection }, '')).status).toBe(401);
    expect((await request('GET', undefined, 'runner-token')).status).toBe(401);
    expect((await request('PUT', { revision: 0, selection })).status).toBe(200);
    for (const invalid of [
      { reviewers: [], synthesis: 'deepseek-review' },
      { reviewers: ['deepseek-review', 'deepseek-review'], synthesis: 'deepseek-review' },
      { reviewers: ['deepseek-review', 'step-review'] },
      { ...selection, baseUrl: 'https://arbitrary.example' },
    ]) {
      expect((await request('PUT', { revision: 1, selection: invalid })).status).toBe(400);
    }
    expect((await request('PUT', { revision: 0, selection: null })).status).toBe(409);
    const current = await request('GET');
    expect(current.headers.get('cache-control')).toBe('no-store');
    expect(await current.json()).toEqual({ revision: 1, selection });
  } finally {
    database.close();
  }
});

it('accepts one reviewer as a persisted review configuration', async () => {
  const database = new SqliteD1Database();
  try {
    const chosen = { reviewers: ['deepseek-review'], synthesis: 'deepseek-review' };
    const core = createCoreWorker(environment(database));
    const response = await core.fetch(settingsRequest('PUT', { revision: 0, selection: chosen }));
    expect(response.status).toBe(200);
    const restored = await createCoreWorker(environment(database)).fetch(settingsRequest('GET'));
    expect(await restored.json()).toEqual({ revision: 1, selection: chosen });
  } finally {
    database.close();
  }
});

it('persists native provider/model catalog IDs without renaming the selected models', async () => {
  const database = new SqliteD1Database();
  try {
    const chosen = {
      reviewers: ['review-provider/deepseek-v4.1-flash', 'review-provider/mimo-v2.6-flash'],
      synthesis: 'review-provider/deepseek-v4.1-flash',
    };
    const core = createCoreWorker(environment(database));
    const response = await core.fetch(settingsRequest('PUT', { revision: 0, selection: chosen }));
    expect(response.status).toBe(200);
    const restored = await createCoreWorker(environment(database)).fetch(settingsRequest('GET'));
    expect(await restored.json()).toEqual({ revision: 1, selection: chosen });
  } finally {
    database.close();
  }
});
