import { createD1ReviewStateStore } from '../apps/core/src/index';
import { expect, it } from 'vitest';
import { createApplication } from '../apps/dashboard/src/lib/server/application';
import { SqliteD1Database } from './support/d1-database';

it('serves public data in-process without exposing trusted Core endpoints', async () => {
  const database = new SqliteD1Database();
  const application = createApplication({
    REVIEW_DB: database,
    GITHUB_APP_ID: '1',
    GITHUB_APP_PRIVATE_KEY: 'test-private-key',
    WEBHOOK_SECRET: 'test-webhook-secret',
    ALLOWED_INSTALLATION_IDS: '[7]',
    RUNNER_CALLBACK_TOKEN: 'test-callback-token',
  });
  try {
    const overview = await application.fetch(new Request('https://reviews.test/api/dashboard'));
    expect(overview.status).toBe(200);
    expect(await overview.json()).toMatchObject({ counts: { queued: 0, claimed: 0 } });
    const forged = await application.fetch(
      new Request('https://reviews.test/runner-results', {
        method: 'POST',
        headers: { 'x-compte-rendu-runner-callback': 'verified' },
        body: '{}',
      }),
    );
    expect(forged.status).toBe(404);
    const callback = await application.fetch(
      new Request('https://reviews.test/runner-callback', {
        method: 'POST',
        headers: { 'x-compte-rendu-runner-callback': 'verified' },
        body: '{}',
      }),
    );
    expect(callback.status).toBe(401);
    const recovery = await application.fetch(
      new Request('https://reviews.test/runner-cleanup-recovery', {
        method: 'POST',
        headers: { 'x-compte-rendu-runner-cleanup-recovery': 'verified' },
        body: '{}',
      }),
    );
    expect(recovery.status).toBe(401);
    const configuration = await application.fetch(
      new Request('https://reviews.test/api/review-configuration'),
    );
    expect(configuration.status).toBe(401);
  } finally {
    database.close();
  }
});

it('issues a relay grant only to the Runner owning the frozen review routes', async () => {
  const database = new SqliteD1Database();
  const store = createD1ReviewStateStore(database, 'provider/original');
  const application = createApplication({
    REVIEW_DB: database,
    GITHUB_APP_ID: '1',
    GITHUB_APP_PRIVATE_KEY: 'test-private-key',
    WEBHOOK_SECRET: 'test-webhook-secret',
    ALLOWED_INSTALLATION_IDS: '[7]',
    RUNNER_CALLBACK_TOKEN: 'test-callback-token',
    INFERENCE_RELAY: {
      issue: async () => ({
        kind: 'issued' as const,
        token: 'test-grant',
        expiresAt: '2030-01-01T00:00:00Z',
      }),
      revoke: async () => ({ kind: 'revoked' as const }),
      usage: async () => null,
    },
  });
  try {
    await store.claimReview({
      deliveryId: 'issue-grant',
      occurredAt: '2026-11-18T00:00:00Z',
      job: {
        repositoryId: 1,
        installationId: 7,
        pullRequestNumber: 1,
        baseSha: 'a'.repeat(40),
        headSha: 'b'.repeat(40),
        trigger: 'automatic',
      },
    });
    const claim = await store.claimNextJob?.({
      jobId: 'job',
      attempt: 1,
      occurredAt: '2026-11-18T00:01:00Z',
    });
    if (claim?.kind !== 'claimed') throw new Error('expected a claim');
    const payload = { runId: claim.runId, jobId: 'job', attempt: 1, routes: ['provider/original'] };
    const issue = (overrides = {}, token = 'test-callback-token') =>
      application.fetch(
        new Request('https://reviews.test/runner-llm/issue', {
          method: 'POST',
          headers: { authorization: 'Bearer ' + token, 'x-compte-rendu-runner-llm': 'verified' },
          body: JSON.stringify({ ...payload, ...overrides }),
        }),
      );
    expect((await issue({}, 'wrong')).status).toBe(401);
    for (const overrides of [
      { attempt: 2 },
      { jobId: 'foreign' },
      { runId: 'foreign' },
      { routes: ['extra'] },
    ]) {
      expect((await issue(overrides)).status).toBe(409);
    }
    expect((await issue({ routes: ['x'.repeat(16 * 1024)] })).status).toBe(413);
    const issued = await issue();
    expect(issued.status).toBe(201);
    expect(await issued.json()).toEqual({ token: 'test-grant', expiresAt: '2030-01-01T00:00:00Z' });
  } finally {
    database.close();
  }
});

it('allows authenticated recovery and usage reads after a claim has cleared', async () => {
  const database = new SqliteD1Database();
  const application = createApplication({
    REVIEW_DB: database,
    GITHUB_APP_ID: '1',
    GITHUB_APP_PRIVATE_KEY: 'unused',
    WEBHOOK_SECRET: 'unused',
    ALLOWED_INSTALLATION_IDS: '[7]',
    RUNNER_CALLBACK_TOKEN: 'runner',
    INFERENCE_RELAY: {
      issue: async () => ({ kind: 'invalid' as const }),
      revoke: async () => ({ kind: 'revoked' as const }),
      usage: async ({ jobId }) => (jobId === 'retired' ? null : { version: 1, models: [] }),
    },
  });
  const post = (operation: string, jobId: string, token: string) =>
    application.fetch(
      new Request('https://reviews.example/runner-llm/' + operation, {
        method: 'POST',
        headers: { authorization: 'Bearer ' + token },
        body: JSON.stringify({ jobId }),
      }),
    );
  try {
    for (const operation of ['revoke', 'usage'])
      expect((await post(operation, 'job', 'foreign')).status).toBe(401);
    expect((await post('revoke', 'job', 'runner')).status).toBe(204);
    expect(await (await post('usage', 'job', 'runner')).json()).toEqual({ version: 1, models: [] });
    expect((await post('usage', 'retired', 'runner')).status).toBe(404);
  } finally {
    database.close();
  }
});
