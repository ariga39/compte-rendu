/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { expect, it } from 'vitest';
import { SELF } from 'cloudflare:test';

it('lets an invalid history link return to the first page without retrying the bad cursor', async () => {
  const response = await SELF.fetch('https://reviews.test/history?cursor=garbage');
  expect(response.status).toBe(400);
  const html = await response.text();
  expect(html).toContain('Invalid history link');
  expect(html).toContain('href="/history"');
  expect(html).toContain('Back to history');
  expect(html).not.toContain('Try again');
  expect((await SELF.fetch('https://reviews.test/history')).status).toBe(200);
});

it('renders a branded missing-review page with a route back to history', async () => {
  const response = await SELF.fetch('https://reviews.test/jobs/does-not-exist');
  expect(response.status).toBe(404);
  const html = await response.text();
  expect(html).toContain('SSR Review');
  expect(html).toContain('Review not found');
  expect(html).toContain('Back to history');
  expect(html).toContain('href="/history"');
});

it('offers a full-page retry when the database is unavailable during SSR', async () => {
  const { env } = await import('cloudflare:test');
  await env.REVIEW_DB.exec('ALTER TABLE review_runs RENAME TO unavailable_review_runs');
  try {
    const response = await SELF.fetch('https://reviews.test/history');
    expect(response.status).toBe(503);
    const html = await response.text();
    expect(html).toContain('Reviews are temporarily unavailable');
    expect(html).toContain('Try again');
    expect(html).toContain('data-sveltekit-reload');
    expect(html).not.toContain('no such table');
  } finally {
    await env.REVIEW_DB.exec('ALTER TABLE unavailable_review_runs RENAME TO review_runs');
  }
  expect((await SELF.fetch('https://reviews.test/history')).status).toBe(200);
});

it('returns usable overview and help HTML without executing JavaScript', async () => {
  const response = await SELF.fetch('https://reviews.test/');
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const html = await response.text();
  expect(html).toContain('SSR Review');
  expect(html).toContain('Overview');
  expect(html).toContain('No reviews in progress or waiting.');
  const help = await SELF.fetch('https://reviews.test/help');
  expect(help.status).toBe(200);
  expect(await help.text()).toContain('Review decisions');
  const assetPath = html.match(/href="([^"]+\/_app\/immutable\/[^"]+\.css)"/)?.[1];
  expect(assetPath).toBeDefined();
  const asset = await SELF.fetch(new URL(assetPath!, 'https://reviews.test/').href);
  expect(asset.status).toBe(200);
  expect(asset.headers.get('cache-control')).toContain('immutable');
});

it('enforces webhook and Runner authentication at the built SvelteKit entry', async () => {
  for (const path of ['/runner-claim', '/runner-callback', '/runner-progress']) {
    const response = await SELF.fetch(`https://reviews.test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(401);
  }
  for (const path of ['/review-configuration', '/review', '/jobs']) {
    const response = await SELF.fetch(`https://reviews.test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(404);
  }
  const body = JSON.stringify({
    action: 'opened',
    number: 42,
    installation: { id: 7 },
    repository: { id: 11, visibility: 'public' },
    pull_request: {
      draft: true,
      user: { login: 'maintainer', type: 'User' },
      base: { sha: '1'.repeat(40), repo: { id: 11 } },
      head: { sha: '2'.repeat(40), repo: { id: 11 } },
    },
  });
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode('test-webhook-secret'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = Array.from(
    new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
  for (const path of ['/', '/webhooks/github']) {
    for (const [digest, expected] of [
      ['0'.repeat(64), 400],
      [signature, 202],
    ] as const) {
      const response = await SELF.fetch(`https://reviews.test${path}`, {
        method: 'POST',
        body,
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'pull_request',
          'x-github-delivery': 'ssr-auth-check',
          'x-hub-signature-256': `sha256=${digest}`,
        },
      });
      expect(response.status).toBe(expected);
    }
  }
});

it('renders persisted public review details and tokens while keeping private review identity out of HTML', async () => {
  const { env } = await import('cloudflare:test');
  const { createD1ReviewStateStore } = await import('../../apps/core/src/review-state-store');
  const store = createD1ReviewStateStore(env.REVIEW_DB);
  const now = new Date().toISOString();
  for (const [repositoryId, visibility] of [
    [101, 'public'],
    [102, 'private'],
  ] as const) {
    const run = await store.claimReview({
      deliveryId: `ssr-${visibility}`,
      occurredAt: now,
      job: {
        repositoryId,
        pullRequestNumber: 42,
        installationId: 7,
        trigger: 'automatic',
        repositoryVisibility: visibility,
        baseSha: '1'.repeat(40),
        headSha: '2'.repeat(40),
        baseRef: 'main',
        headRef: visibility === 'public' ? 'feature/public-branch' : 'secret-branch-canary',
      },
    });
    if (run.kind !== 'claimed') throw new Error('not admitted');
    await store.recordRunnerJob({ runId: run.runId, jobId: `ssr-job-${visibility}`, attempt: 1 });
    await store.recordModelUsage!({
      runId: run.runId,
      jobId: `ssr-job-${visibility}`,
      attempt: 1,
      usage: {
        version: 1,
        models: [
          {
            route: 'review',
            model: 'deepseek-flash',
            requests: 1,
            incompleteRequests: 0,
            inputTokens: { total: 1234, reportedRequests: 1 },
            uncachedInputTokens: null,
            cacheReadTokens: null,
            cacheWriteTokens: null,
            outputTokens: { total: 56, reportedRequests: 1 },
            reasoningTokens: null,
          },
        ],
      },
    });
    const due = (await store.listDueRepositoryMetadata!({ now, limit: 50 })).find(
      (row) => row.repositoryId === repositoryId,
    )!;
    await store.claimRepositoryRefresh!({
      installationId: 7,
      repositoryId,
      expectedRevision: due.revision,
      claimedAt: now,
      staleBefore: now,
    });
    await store.recordRepositoryRefresh!({
      installationId: 7,
      repositoryId,
      expectedRevision: due.revision,
      claimedAt: now,
      fullName: visibility === 'public' ? 'acme/public-review' : 'acme/secret-repo-canary',
      visibility,
      verifiedAt: now,
      identityExpiresAt: new Date(Date.now() + 300000).toISOString(),
      nextRefreshAt: new Date(Date.now() + 60000).toISOString(),
      updatedAt: now,
    });
    await store.completeRunPublication({
      runId: run.runId,
      occurredAt: now,
      fingerprints: [],
      decision: 'request_changes',
    });
    const response = await SELF.fetch(`https://reviews.test/jobs/${run.runId}`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('deepseek-flash');
    expect(html).toContain('1,234');
    expect(html).toContain('Request changes');
    expect(html).toContain('UTC</time>');
    if (visibility === 'public') {
      expect(html).toContain('acme/public-review');
      expect(html).toContain('feature/public-branch');
    } else {
      expect(html).toContain('Anonymous review');
      expect(html).not.toContain('secret-repo-canary');
      expect(html).not.toContain('secret-branch-canary');
    }
  }
  const history = await SELF.fetch('https://reviews.test/history');
  const html = await history.text();
  expect(html).toContain('acme/public-review');
  expect(html).toContain('Anonymous review');
  expect(html).not.toContain('secret-repo-canary');
});
