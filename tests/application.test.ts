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
    const configuration = await application.fetch(
      new Request('https://reviews.test/api/review-configuration'),
    );
    expect(configuration.status).toBe(401);
  } finally {
    database.close();
  }
});
