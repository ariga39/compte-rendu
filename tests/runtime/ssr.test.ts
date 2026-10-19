/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { expect, it } from 'vitest';
import { SELF } from 'cloudflare:test';

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
