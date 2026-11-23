import { afterEach, expect, it, vi } from 'vitest';
import { createApplication } from '../apps/dashboard/src/lib/server/application';
import { createD1ReviewStateStore } from '../apps/core/src/index';
import type { RunnerJobInput } from '../packages/contracts/src';
import { SqliteD1Database } from './support/d1-database';

afterEach(() => {
  vi.useRealTimers();
});

it('renews a claimed run through the public unified application path', async () => {
  const database = new SqliteD1Database();
  const store = createD1ReviewStateStore(database);
  const review = await store.claimReview({
    deliveryId: 'application-read-renewal',
    occurredAt: new Date().toISOString(),
    job: {
      repositoryId: 11,
      pullRequestNumber: 42,
      installationId: 7,
      baseSha: '1'.repeat(40),
      headSha: '2'.repeat(40),
      trigger: 'automatic',
    },
  });
  if (review.kind !== 'claimed') throw new Error('not admitted');

  let mintCount = 0;
  const app = createApplication(
    {
      REVIEW_DB: database,
      WEBHOOK_SECRET: 'test-webhook-secret',
      GITHUB_APP_ID: '1',
      GITHUB_APP_PRIVATE_KEY: 'test-key',
      ALLOWED_INSTALLATION_IDS: '[7]',
      RUNNER_CALLBACK_TOKEN: 'callback-token',
    },
    {
      github: {
        getRepositoryUrl: async () => 'https://github.com/acme/reviewed.git',
        loadReviewTarget: async () => ({ headSha: '2'.repeat(40) }),
      },
      getReadInstallationToken: async () => {
        mintCount += 1;
        return {
          token: mintCount === 1 ? 'claim-read-token' : 'renewed-read-token',
          expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        };
      },
    },
  );

  try {
    const claim = await app.fetch(
      new Request('https://reviews.test/runner-claim', {
        method: 'POST',
        headers: { authorization: 'Bearer callback-token' },
      }),
    );
    expect(claim.status).toBe(200);
    const input = (await claim.json()) as RunnerJobInput;

    const renewal = await app.fetch(
      new Request('https://reviews.test/runner-read-token', {
        method: 'POST',
        headers: {
          authorization: 'Bearer callback-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ runId: input.runId, jobId: input.id, attempt: input.attempt }),
      }),
    );

    expect(renewal.status).toBe(200);
    expect(renewal.headers.get('cache-control')).toBe('no-store');
    expect(await renewal.json()).toMatchObject({
      token: 'renewed-read-token',
      expiresAt: expect.any(String),
    });
    expect(mintCount).toBe(2);
  } finally {
    database.close();
  }
});

it('keeps unauthenticated read-token renewal closed on the public application path', async () => {
  const database = new SqliteD1Database();
  const app = createApplication({
    REVIEW_DB: database,
    WEBHOOK_SECRET: 'test-webhook-secret',
    GITHUB_APP_ID: '1',
    GITHUB_APP_PRIVATE_KEY: 'test-key',
    ALLOWED_INSTALLATION_IDS: '[7]',
    RUNNER_CALLBACK_TOKEN: 'callback-token',
  });
  try {
    const response = await app.fetch(
      new Request('https://reviews.test/runner-read-token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runId: 'run', jobId: 'job', attempt: 1 }),
      }),
    );
    expect(response.status).toBe(401);
  } finally {
    database.close();
  }
});
