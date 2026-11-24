import { describe, expect, it, vi } from 'vitest';
import { createCoreWorker } from '../apps/core/src/core-worker';
import { createD1ReviewStateStore } from '../apps/core/src/index';
import { createGitHubPublicationAdapter } from '../apps/core/src/github-review-adapter';
import type { OperationalLogEvent } from '../packages/contracts/src';
import { SqliteD1Database } from './support/d1-database';
import { claimRunnerJob } from './support/runner-claim';
import {
  eligibleEvent,
  runnerResponse,
  coreEnv,
  successfulCallback,
  failedCallback,
  abortedCallback,
  claimGithub,
} from './support/core-worker-harness';

describe('Core callbacks and publication', () => {
  it('keeps duplicate success callbacks retryable until publication completes', async () => {
    const database = new SqliteD1Database();
    const stateStore = createD1ReviewStateStore(database);
    const claimed = await stateStore.claimReview({
      deliveryId: 'delivery-duplicate-success',
      job: {
        repositoryId: 11,
        pullRequestNumber: 42,
        installationId: 7,
        baseSha: eligibleEvent.baseSha,
        headSha: eligibleEvent.headSha,
        trigger: 'automatic',
      },
      occurredAt: '2026-09-01T00:00:00.000Z',
    });
    if (claimed.kind !== 'claimed') throw new Error('duplicate callback run was not claimed');
    await claimRunnerJob(stateStore, { runId: claimed.runId, jobId: 'runner-job-1' });
    await stateStore.recordCheckRun({ runId: claimed.runId, checkRunId: 321 });
    let signalPublicationStarted!: () => void;
    const publicationStarted = new Promise<void>((resolve) => {
      signalPublicationStarted = resolve;
    });
    let finishPublication!: () => void;
    const publicationFinished = new Promise<void>((resolve) => {
      finishPublication = resolve;
    });
    const checkUpdates: Array<{ status: string }> = [];
    let firstPublication = true;
    const worker = createCoreWorker(
      {
        REVIEW_DB: database,
        GITHUB_APP_ID: '1234567',
        GITHUB_APP_PRIVATE_KEY: 'test-private-key',
        EVIDENCE_BUCKET: { put: async () => undefined },
      },
      {
        stateStore,
        github: {
          loadReviewTarget: async () => ({ headSha: eligibleEvent.headSha }),
          findReviewByMarker: async () => undefined,
          createReview: async ({ payload }) => {
            if (firstPublication) {
              firstPublication = false;
              signalPublicationStarted();
              await publicationFinished;
            }
            return { kind: 'created', review: payload };
          },
          updateCheckRun: async ({ status }) => {
            checkUpdates.push({ status });
          },
        },
      },
    );
    const callback = async () =>
      new Request('https://core.internal/runner-results', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-compte-rendu-runner-callback': 'verified',
        },
        body: await successfulCallback(claimed.runId),
      });

    try {
      const winner = worker.fetch(await callback());
      await publicationStarted;
      const duplicate = await worker.fetch(await callback());
      expect(duplicate.status).toBe(503);
      expect(checkUpdates).toEqual([]);
      finishPublication();
      expect((await winner).status).toBe(202);
      expect(checkUpdates).toEqual([{ status: 'success' }]);
    } finally {
      database.close();
    }
  });

  it('does not publish a successful callback after a sweep wins the publication claim', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-01T00:00:00Z'));
    const database = new SqliteD1Database();
    const stateStore = createD1ReviewStateStore(database);
    const claimed = await stateStore.claimReview({
      deliveryId: 'delivery-publish-after-expiry',
      job: {
        repositoryId: 11,
        pullRequestNumber: 42,
        installationId: 7,
        baseSha: eligibleEvent.baseSha,
        headSha: eligibleEvent.headSha,
        trigger: 'automatic',
      },
      occurredAt: '2026-09-01T00:00:00.000Z',
    });
    if (claimed.kind !== 'claimed') throw new Error('publish race run was not scheduled');
    await claimRunnerJob(stateStore, { runId: claimed.runId, jobId: 'runner-job-1' });
    const racingStore: typeof stateStore = {
      ...stateStore,
      claimRunPublication: async (input) => {
        if (input.publishing === true) {
          vi.setSystemTime(new Date('2026-09-01T03:10:00Z'));
          await stateStore.claimNextJob({
            jobId: 'sweep-before-publication',
            attempt: 1,
            occurredAt: '2026-09-01T03:10:00.000Z',
          });
        }
        return stateStore.claimRunPublication(input);
      },
    };
    let reviews = 0;
    const worker = createCoreWorker(
      {
        ...coreEnv(database),
        EVIDENCE_BUCKET: { put: async () => undefined },
      },
      {
        stateStore: racingStore,
        github: {
          loadReviewTarget: async () => ({ headSha: eligibleEvent.headSha }),
          findReviewByMarker: async () => undefined,
          createReview: async ({ payload }) => {
            reviews += 1;
            return { kind: 'created', review: payload };
          },
        },
      },
    );

    try {
      vi.setSystemTime(new Date('2026-09-01T01:31:00Z'));
      const response = await worker.fetch(
        new Request('https://core.internal/runner-results', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-compte-rendu-runner-callback': 'verified',
          },
          body: await successfulCallback(claimed.runId, 'runner-job-1'),
        }),
      );
      expect(response.status).toBe(503);
      expect(reviews).toBe(0);
      await expect(stateStore.getRunOutcome(claimed.runId)).resolves.toMatchObject({
        status: 'failed',
      });
    } finally {
      database.close();
      vi.useRealTimers();
    }
  });

  it('retries failure feedback for a succeeded callback after publication fails', async () => {
    const database = new SqliteD1Database();
    const stateStore = createD1ReviewStateStore(database);
    const claimed = await stateStore.claimReview({
      deliveryId: 'delivery-succeeded-callback-failure-retry',
      job: {
        repositoryId: 11,
        pullRequestNumber: 42,
        installationId: 7,
        baseSha: eligibleEvent.baseSha,
        headSha: eligibleEvent.headSha,
        trigger: 'automatic',
      },
      occurredAt: '2026-09-01T00:00:00.000Z',
    });
    if (claimed.kind !== 'claimed') throw new Error('failure retry run was not claimed');
    await claimRunnerJob(stateStore, { runId: claimed.runId, jobId: 'runner-job-1' });
    await stateStore.recordCheckRun({ runId: claimed.runId, checkRunId: 321 });
    const comments: string[] = [];
    const checkUpdates: string[] = [];
    let firstComment = true;
    const worker = createCoreWorker(
      {
        REVIEW_DB: database,
        GITHUB_APP_ID: '1234567',
        GITHUB_APP_PRIVATE_KEY: 'test-private-key',
        EVIDENCE_BUCKET: { put: async () => undefined },
      },
      {
        stateStore,
        github: {
          loadReviewTarget: async () => ({ headSha: eligibleEvent.headSha }),
          createReview: async () => {
            throw new Error('review publication unavailable');
          },
          createIssueComment: async ({ body }) => {
            if (firstComment) {
              firstComment = false;
              throw new Error('failure comment unavailable');
            }
            comments.push(body);
            return { id: 123, body };
          },
          updateCheckRun: async ({ status }) => {
            checkUpdates.push(status);
          },
        },
      },
    );
    const callbackBody = await successfulCallback(claimed.runId);
    const request = () =>
      new Request('https://core.internal/runner-results', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-compte-rendu-runner-callback': 'verified',
        },
        body: callbackBody,
      });

    try {
      expect((await worker.fetch(request())).status).toBe(503);
      expect((await worker.fetch(request())).status).toBe(202);
      expect(comments).toEqual([
        `Review job failed. Check the reviews on this commit before retrying with \`/ai-review\`.\n\n<!-- compte-rendu:failure:run:${claimed.runId} -->`,
      ]);
      expect(checkUpdates.at(-1)).toBe('failure');
      expect(await stateStore.getRunOutcome(claimed.runId)).toMatchObject({ status: 'failed' });
    } finally {
      database.close();
    }
  });

  it('does not publish callbacks for unknown, failed, or superseded runs', async () => {
    const database = new SqliteD1Database();
    const stateStore = createD1ReviewStateStore(database);
    const failed = await stateStore.claimReview({
      deliveryId: 'delivery-callback-failed',
      job: {
        repositoryId: 11,
        pullRequestNumber: 42,
        installationId: 7,
        baseSha: eligibleEvent.baseSha,
        headSha: eligibleEvent.headSha,
        trigger: 'automatic',
      },
      occurredAt: '2026-09-01T00:00:00.000Z',
    });
    if (failed.kind !== 'claimed') throw new Error('failed test run was not claimed');
    await claimRunnerJob(stateStore, { runId: failed.runId, jobId: 'failed-job' });
    await stateStore.markSchedulingFailed({
      runId: failed.runId,
      occurredAt: '2026-09-01T00:00:01.000Z',
    });
    const superseded = await stateStore.claimReview({
      deliveryId: 'delivery-callback-superseded-old',
      job: {
        repositoryId: 11,
        pullRequestNumber: 43,
        installationId: 7,
        baseSha: eligibleEvent.baseSha,
        headSha: eligibleEvent.headSha,
        trigger: 'automatic',
      },
      occurredAt: '2026-09-01T00:00:00.000Z',
    });
    if (superseded.kind !== 'claimed') throw new Error('superseded test run was not claimed');
    await claimRunnerJob(stateStore, { runId: superseded.runId, jobId: 'superseded-job' });
    const replacement = await stateStore.claimReview({
      deliveryId: 'delivery-callback-superseded-new',
      job: {
        repositoryId: 11,
        pullRequestNumber: 43,
        installationId: 7,
        baseSha: eligibleEvent.baseSha,
        headSha: '3333333333333333333333333333333333333333',
        trigger: 'automatic',
      },
      occurredAt: '2026-09-01T00:00:02.000Z',
    });
    if (replacement.kind !== 'claimed') throw new Error('replacement test run was not claimed');
    await stateStore.markRunSuperseded({
      runId: superseded.runId,
      occurredAt: '2026-09-01T00:00:03.000Z',
    });
    const stored: unknown[] = [];
    const published: unknown[] = [];
    const worker = createCoreWorker(
      {
        REVIEW_DB: database,
        GITHUB_APP_ID: '1234567',
        GITHUB_APP_PRIVATE_KEY: 'test-private-key',
        EVIDENCE_BUCKET: {
          put: async (...args) => {
            stored.push(args);
          },
        },
      },
      {
        stateStore,
        github: {
          loadReviewTarget: async () => ({ headSha: eligibleEvent.headSha }),
          createReview: async (input) => {
            published.push(input);
            return { kind: 'created', review: input };
          },
        },
      },
    );
    const callback = async (runId: string, id = 'runner-job-1') =>
      new Request('https://core.internal/runner-results', {
        method: 'POST',
        headers: {
          'x-compte-rendu-runner-callback': 'verified',
          'content-type': 'application/json',
        },
        body: await successfulCallback(runId, id),
      });
    try {
      expect((await worker.fetch(await callback('unknown-run'))).status).toBe(404);
      expect((await worker.fetch(await callback(failed.runId, 'failed-job'))).status).toBe(202);
      expect((await worker.fetch(await callback(superseded.runId, 'superseded-job'))).status).toBe(
        202,
      );
      expect(stored).toHaveLength(2);
      expect(published).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  it('publishes one concurrent duplicate success callback', async () => {
    const database = new SqliteD1Database();
    const stateStore = createD1ReviewStateStore(database);
    const claimed = await stateStore.claimReview({
      deliveryId: 'delivery-callback-concurrent',
      job: {
        repositoryId: 11,
        pullRequestNumber: 42,
        installationId: 7,
        baseSha: eligibleEvent.baseSha,
        headSha: eligibleEvent.headSha,
        trigger: 'automatic',
      },
      occurredAt: '2026-09-01T00:00:00.000Z',
    });
    if (claimed.kind !== 'claimed') throw new Error('concurrent run was not claimed');
    await claimRunnerJob(stateStore, { runId: claimed.runId, jobId: 'runner-job-1' });
    const published: unknown[] = [];
    let releasePublication!: () => void;
    const publicationGate = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });
    let publicationStarted!: () => void;
    const publicationStartedPromise = new Promise<void>((resolve) => {
      publicationStarted = resolve;
    });
    const worker = createCoreWorker(
      {
        REVIEW_DB: database,
        GITHUB_APP_ID: '1234567',
        GITHUB_APP_PRIVATE_KEY: 'test-private-key',
        EVIDENCE_BUCKET: { put: async () => undefined },
      },
      {
        stateStore,
        github: {
          loadReviewTarget: async () => ({ headSha: eligibleEvent.headSha }),
          createReview: async (input) => {
            published.push(input);
            publicationStarted();
            await publicationGate;
            return { kind: 'created', review: input };
          },
        },
      },
    );
    const callbackBody = await successfulCallback(claimed.runId);
    const callbackRequest = () =>
      new Request('https://core.internal/runner-results', {
        method: 'POST',
        headers: {
          'x-compte-rendu-runner-callback': 'verified',
          'content-type': 'application/json',
        },
        body: callbackBody,
      });
    try {
      const first = worker.fetch(callbackRequest());
      await publicationStartedPromise;
      const second = worker.fetch(callbackRequest());
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(published).toHaveLength(1);
      releasePublication();
      await expect(Promise.all([first, second])).resolves.toHaveLength(2);
      await expect(stateStore.getRunOutcome(claimed.runId)).resolves.toMatchObject({
        status: 'completed',
      });
    } finally {
      database.close();
    }
  });

  it('publishes one failure comment for duplicate failed callbacks', async () => {
    const database = new SqliteD1Database();
    const stateStore = createD1ReviewStateStore(database);
    const claimed = await stateStore.claimReview({
      deliveryId: 'delivery-callback-manual-failure',
      job: {
        repositoryId: 11,
        pullRequestNumber: 42,
        installationId: 7,
        baseSha: eligibleEvent.baseSha,
        headSha: eligibleEvent.headSha,
        trigger: 'manual',
        commentId: 987654,
      },
      occurredAt: '2026-09-01T00:00:00.000Z',
    });
    if (claimed.kind !== 'claimed') throw new Error('manual test run was not claimed');
    await claimRunnerJob(stateStore, { runId: claimed.runId, jobId: 'runner-job-1' });
    await stateStore.recordCheckRun({ runId: claimed.runId, checkRunId: 321 });
    const reactions: unknown[] = [];
    const comments: Array<{ body: string; [key: string]: unknown }> = [];
    const checkUpdates: unknown[] = [];
    const worker = createCoreWorker(
      {
        REVIEW_DB: database,
        GITHUB_APP_ID: '1234567',
        GITHUB_APP_PRIVATE_KEY: 'test-private-key',
        EVIDENCE_BUCKET: { put: async () => undefined },
      },
      {
        stateStore,
        github: {
          addReaction: async (input) => {
            reactions.push(input);
          },
          createIssueComment: async (input) => {
            comments.push(input);
            return input;
          },
          updateCheckRun: async (input) => {
            checkUpdates.push(input);
          },
        },
      },
    );
    try {
      const callbackBody = await failedCallback(claimed.runId);
      const callback = () =>
        new Request('https://core.internal/runner-results', {
          method: 'POST',
          headers: {
            'x-compte-rendu-runner-callback': 'verified',
            'content-type': 'application/json',
          },
          body: callbackBody,
        });
      expect((await worker.fetch(callback())).status).toBe(202);
      expect((await worker.fetch(callback())).status).toBe(202);
      await expect(stateStore.getRunOutcome(claimed.runId)).resolves.toMatchObject({
        status: 'failed',
        commentId: 987654,
      });
      expect(reactions).toEqual([
        { repositoryId: 11, installationId: 7, commentId: 987654, content: '-1' },
      ]);
      expect(comments).toEqual([
        {
          repositoryId: 11,
          pullRequestNumber: 42,
          installationId: 7,
          body: `Review job failed. Check the reviews on this commit before retrying with \`/ai-review\`.\n\n<!-- compte-rendu:failure:run:${claimed.runId} -->`,
        },
      ]);
      expect(checkUpdates).toEqual([
        {
          runId: claimed.runId,
          repositoryId: 11,
          installationId: 7,
          checkRunId: 321,
          status: 'failure',
        },
      ]);
    } finally {
      database.close();
    }
  });

  it('keeps manual supersession feedback when an aborted callback arrives late', async () => {
    const database = new SqliteD1Database();
    const stateStore = createD1ReviewStateStore(database);
    const claimed = await stateStore.claimReview({
      deliveryId: 'delivery-callback-manual-superseded',
      job: {
        repositoryId: 11,
        pullRequestNumber: 42,
        installationId: 7,
        baseSha: eligibleEvent.baseSha,
        headSha: eligibleEvent.headSha,
        trigger: 'manual',
        commentId: 987654,
      },
      occurredAt: '2026-09-01T00:00:00.000Z',
    });
    if (claimed.kind !== 'claimed') throw new Error('manual superseded run was not claimed');
    await claimRunnerJob(stateStore, { runId: claimed.runId, jobId: 'runner-job-1' });
    await stateStore.markRunSuperseded({
      runId: claimed.runId,
      occurredAt: '2026-09-01T00:00:01.000Z',
    });
    const reactions: unknown[] = [];
    const worker = createCoreWorker(
      {
        REVIEW_DB: database,
        GITHUB_APP_ID: '1234567',
        GITHUB_APP_PRIVATE_KEY: 'test-private-key',
        EVIDENCE_BUCKET: { put: async () => undefined },
      },
      {
        stateStore,
        github: {
          addReaction: async (input) => {
            reactions.push(input);
          },
        },
      },
    );

    try {
      const response = await worker.fetch(
        new Request('https://core.internal/runner-results', {
          method: 'POST',
          headers: {
            'x-compte-rendu-runner-callback': 'verified',
            'content-type': 'application/json',
          },
          body: await abortedCallback(claimed.runId, 'runner-job-1'),
        }),
      );

      expect(response.status).toBe(202);
      expect(reactions).toEqual([
        { repositoryId: 11, installationId: 7, commentId: 987654, content: 'confused' },
      ]);
    } finally {
      database.close();
    }
  });

  it('publishes failure feedback when the manual reaction fails', async () => {
    const database = new SqliteD1Database();
    const stateStore = createD1ReviewStateStore(database);
    const claimed = await stateStore.claimReview({
      deliveryId: 'delivery-reaction-fails',
      job: {
        repositoryId: 11,
        pullRequestNumber: 42,
        installationId: 7,
        baseSha: eligibleEvent.baseSha,
        headSha: eligibleEvent.headSha,
        trigger: 'manual',
        commentId: 987654,
      },
      occurredAt: '2026-09-01T00:00:00.000Z',
    });
    if (claimed.kind !== 'claimed') throw new Error('reaction failure run was not claimed');
    await claimRunnerJob(stateStore, { runId: claimed.runId, jobId: 'runner-job-1' });
    await stateStore.recordCheckRun({ runId: claimed.runId, checkRunId: 321 });
    const comments: string[] = [];
    const checkUpdates: string[] = [];
    const worker = createCoreWorker(
      {
        REVIEW_DB: database,
        GITHUB_APP_ID: '1234567',
        GITHUB_APP_PRIVATE_KEY: 'test-private-key',
        EVIDENCE_BUCKET: { put: async () => undefined },
      },
      {
        stateStore,
        github: {
          addReaction: async () => {
            throw new Error('reaction unavailable');
          },
          createIssueComment: async ({ body }) => {
            comments.push(body);
            return { id: 123, body };
          },
          updateCheckRun: async ({ status }) => {
            checkUpdates.push(status);
          },
        },
      },
    );

    try {
      expect(
        (
          await worker.fetch(
            new Request('https://core.internal/runner-results', {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'x-compte-rendu-runner-callback': 'verified',
              },
              body: await failedCallback(claimed.runId),
            }),
          )
        ).status,
      ).toBe(202);
      expect(comments).toEqual([
        `Review job failed. Check the reviews on this commit before retrying with \`/ai-review\`.\n\n<!-- compte-rendu:failure:run:${claimed.runId} -->`,
      ]);
      expect(checkUpdates).toEqual(['failure']);
    } finally {
      database.close();
    }
  });

  it('retries a failed callback when the failure comment was not created', async () => {
    const database = new SqliteD1Database();
    const stateStore = createD1ReviewStateStore(database);
    const claimed = await stateStore.claimReview({
      deliveryId: 'delivery-callback-failure-comment-retry',
      job: {
        repositoryId: 11,
        pullRequestNumber: 42,
        installationId: 7,
        baseSha: eligibleEvent.baseSha,
        headSha: eligibleEvent.headSha,
        trigger: 'automatic',
      },
      occurredAt: '2026-09-01T00:00:00.000Z',
    });
    if (claimed.kind !== 'claimed') throw new Error('failure retry run was not claimed');
    await claimRunnerJob(stateStore, { runId: claimed.runId, jobId: 'runner-job-1' });
    const comments: string[] = [];
    let first = true;
    const worker = createCoreWorker(
      {
        REVIEW_DB: database,
        GITHUB_APP_ID: '1234567',
        GITHUB_APP_PRIVATE_KEY: 'test-private-key',
        EVIDENCE_BUCKET: { put: async () => undefined },
      },
      {
        stateStore,
        github: {
          createIssueComment: async ({ body }) => {
            if (first) {
              first = false;
              throw new Error('GitHub unavailable before create');
            }
            comments.push(body);
            return { id: 123, body };
          },
        },
      },
    );
    const callbackBody = await failedCallback(claimed.runId);
    const request = () =>
      new Request('https://core.internal/runner-results', {
        method: 'POST',
        headers: {
          'x-compte-rendu-runner-callback': 'verified',
          'content-type': 'application/json',
        },
        body: callbackBody,
      });

    try {
      expect((await worker.fetch(request())).status).toBe(503);
      expect((await worker.fetch(request())).status).toBe(202);
      expect(comments).toEqual([
        `Review job failed. Check the reviews on this commit before retrying with \`/ai-review\`.\n\n<!-- compte-rendu:failure:run:${claimed.runId} -->`,
      ]);
    } finally {
      database.close();
    }
  });

  it('recovers a failure comment when GitHub creates it but loses the response', async () => {
    const remoteComments: Array<{ id: number; body: string }> = [];
    let posts = 0;
    const fetcher: typeof fetch = async (input, init) => {
      const inputUrl =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(inputUrl);
      const method = init?.method ?? 'GET';
      if (url.pathname === '/repositories/11') {
        return Response.json({ full_name: 'acme/reviewed' });
      }
      if (url.pathname === '/repos/acme/reviewed/issues/42/comments' && method === 'GET') {
        return Response.json(remoteComments);
      }
      if (url.pathname === '/repos/acme/reviewed/issues/42/comments' && method === 'POST') {
        posts += 1;
        const { body } = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
          body: string;
        };
        remoteComments.push({ id: 123, body });
        return new Response('{}', { status: 503 });
      }
      return new Response('{}', { status: 404 });
    };
    const github = createGitHubPublicationAdapter({
      token: 'installation-token',
      fetch: fetcher,
    });
    const input = {
      repositoryId: 11,
      pullRequestNumber: 42,
      installationId: 7,
      body: 'Review failed.\n\n<!-- compte-rendu:failure:run:run-1 -->',
    };

    await expect(github.createIssueComment?.(input)).resolves.toEqual({
      id: 123,
      body: input.body,
    });
    await expect(github.createIssueComment?.(input)).resolves.toEqual({
      id: 123,
      body: input.body,
    });
    expect(posts).toBe(1);
  });

  it('creates and updates a GitHub Check without duplicating a lost create response', async () => {
    const remoteChecks: Array<{ id: number; external_id: string }> = [];
    const requests: Array<{ method: string; path: string; body: unknown }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const inputUrl =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(inputUrl);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      if (url.pathname === '/repositories/11') {
        return Response.json({ full_name: 'acme/reviewed' });
      }
      if (url.pathname.endsWith('/commits/2222222222222222222222222222222222222222/check-runs')) {
        return Response.json({ total_count: remoteChecks.length, check_runs: remoteChecks });
      }
      if (url.pathname === '/repos/acme/reviewed/check-runs' && method === 'POST') {
        requests.push({ method, path: url.pathname, body });
        remoteChecks.push({ id: 321, external_id: 'run-1' });
        return new Response('{}', { status: 503 });
      }
      if (url.pathname === '/repos/acme/reviewed/check-runs/321' && method === 'PATCH') {
        requests.push({ method, path: url.pathname, body });
        return Response.json({ id: 321 });
      }
      return new Response('{}', { status: 404 });
    };
    const github = createGitHubPublicationAdapter({
      token: 'installation-token',
      fetch: fetcher,
    });
    const createInput = {
      repositoryId: 11,
      installationId: 7,
      headSha: eligibleEvent.headSha,
      runId: 'run-1',
    };

    await expect(github.createCheckRun?.(createInput)).resolves.toEqual({ id: 321 });
    await expect(github.createCheckRun?.(createInput)).resolves.toEqual({ id: 321 });
    for (const status of ['in_progress', 'success', 'failure', 'cancelled'] as const) {
      await github.updateCheckRun?.({
        runId: 'run-1',
        repositoryId: 11,
        installationId: 7,
        checkRunId: 321,
        status,
      });
    }

    expect(requests).toEqual([
      {
        method: 'POST',
        path: '/repos/acme/reviewed/check-runs',
        body: {
          name: 'Compte-rendu review',
          head_sha: eligibleEvent.headSha,
          status: 'queued',
          external_id: 'run-1',
          output: {
            title: 'Review queued',
            summary: 'Waiting for an available review runner.',
          },
        },
      },
      {
        method: 'PATCH',
        path: '/repos/acme/reviewed/check-runs/321',
        body: {
          status: 'in_progress',
          output: { title: 'Review in progress', summary: 'The review agent is running.' },
        },
      },
      {
        method: 'PATCH',
        path: '/repos/acme/reviewed/check-runs/321',
        body: {
          status: 'completed',
          conclusion: 'success',
          output: { title: 'Review completed', summary: 'The Review was published.' },
        },
      },
      {
        method: 'PATCH',
        path: '/repos/acme/reviewed/check-runs/321',
        body: {
          status: 'completed',
          conclusion: 'failure',
          output: {
            title: 'Review failed',
            summary: 'Open the job details for the recorded failure.',
          },
        },
      },
      {
        method: 'PATCH',
        path: '/repos/acme/reviewed/check-runs/321',
        body: {
          status: 'completed',
          conclusion: 'cancelled',
          output: {
            title: 'Review cancelled',
            summary: 'A newer pull request revision replaced this run.',
          },
        },
      },
    ]);
  });

  it('fails a correlated successful callback with invalid evidence and gives manual feedback', async () => {
    const database = new SqliteD1Database();
    const stateStore = createD1ReviewStateStore(database);
    const claimed = await stateStore.claimReview({
      deliveryId: 'delivery-callback-invalid-evidence',
      job: {
        repositoryId: 11,
        pullRequestNumber: 42,
        installationId: 7,
        baseSha: eligibleEvent.baseSha,
        headSha: eligibleEvent.headSha,
        trigger: 'manual',
        commentId: 987654,
      },
      occurredAt: '2026-09-01T00:00:00.000Z',
    });
    if (claimed.kind !== 'claimed') throw new Error('invalid evidence run was not claimed');
    await stateStore.claimNextJob({
      jobId: 'runner-job-1',
      attempt: 1,
      occurredAt: '2026-09-01T00:01:00.000Z',
    });

    const stored: unknown[] = [];
    const reactions: unknown[] = [];
    const worker = createCoreWorker(
      {
        REVIEW_DB: database,
        GITHUB_APP_ID: '1234567',
        GITHUB_APP_PRIVATE_KEY: 'test-private-key',
        EVIDENCE_BUCKET: { put: async (...args) => stored.push(args) },
      },
      {
        stateStore,
        github: {
          addReaction: async (input) => {
            reactions.push(input);
          },
        },
      },
    );
    try {
      const callback = JSON.parse(await successfulCallback(claimed.runId)) as {
        evidence: { manifest: { sha256: string } };
      };
      callback.evidence.manifest.sha256 = '0'.repeat(64);
      const response = await worker.fetch(
        new Request('https://core.internal/runner-results', {
          method: 'POST',
          headers: {
            'x-compte-rendu-runner-callback': 'verified',
            'content-type': 'application/json',
          },
          body: JSON.stringify(callback),
        }),
      );
      expect(response.status).toBe(202);
      await expect(stateStore.getRunOutcome(claimed.runId)).resolves.toMatchObject({
        status: 'failed',
      });
      const replacement = await stateStore.claimReview({
        deliveryId: 'delivery-after-rejected-evidence',
        job: { ...eligibleEvent, trigger: 'manual', commentId: 23 },
        occurredAt: '2026-09-01T01:00:00.000Z',
      });
      if (replacement.kind !== 'claimed') throw new Error('replacement was not queued');
      await expect(
        stateStore.claimNextJob({
          jobId: 'replacement-job',
          attempt: 1,
          occurredAt: '2026-09-01T01:01:00.000Z',
        }),
      ).resolves.toMatchObject({ kind: 'claimed', runId: replacement.runId });
      expect(stored).toHaveLength(0);
      expect(reactions).toEqual([
        { repositoryId: 11, installationId: 7, commentId: 987654, content: '-1' },
      ]);
    } finally {
      database.close();
    }
  });

  it('keeps an eligible submission when core operational logging fails', async () => {
    const database = new SqliteD1Database();
    const runnerRequests: Request[] = [];
    const worker = createCoreWorker(
      coreEnv(database, async (request) => {
        runnerRequests.push(request.clone());
        return runnerResponse(request);
      }),
      {
        github: claimGithub(),
        log: {
          record: () => {
            throw new Error('log sink unavailable');
          },
        },
        getReadInstallationToken: async () => ({
          token: 'read-token',
          expiresAt: '2026-09-01T01:00:00.000Z',
        }),
      },
    );
    try {
      expect(
        await worker.fetch(
          new Request('https://core.internal/review-events', {
            method: 'POST',
            body: JSON.stringify(eligibleEvent),
          }),
        ),
      ).toMatchObject({ status: 202 });
      expect(runnerRequests).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  it('redacts unsafe delivery identifiers in core operational logs', async () => {
    const database = new SqliteD1Database();
    const events: OperationalLogEvent[] = [];
    const worker = createCoreWorker(coreEnv(database), {
      github: claimGithub(),
      getReadInstallationToken: async () => ({
        token: 'read-token',
        expiresAt: '2026-09-01T01:00:00.000Z',
      }),
      log: {
        record: async (event) => {
          events.push(event);
        },
      },
    });
    try {
      expect(
        await worker.fetch(
          new Request('https://core.internal/review-events', {
            method: 'POST',
            body: JSON.stringify({ ...eligibleEvent, deliveryId: 'delivery\nunsafe' }),
          }),
        ),
      ).toMatchObject({ status: 202 });
      expect(events).toEqual([
        { phase: 'core', outcome: 'scheduled', deliveryId: 'redacted', runId: expect.any(String) },
      ]);
    } finally {
      database.close();
    }
  });

  it('accepts a manual review after production GitHub policy reads', async () => {
    const database = new SqliteD1Database();
    const reactions: unknown[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const inputUrl =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(inputUrl);
      if (url.pathname === '/repositories/11')
        return new Response(
          JSON.stringify({
            full_name: 'acme/reviewed',
            clone_url: 'https://github.com/acme/reviewed.git',
          }),
        );
      if (url.pathname === '/repos/acme/reviewed/pulls/42')
        return new Response(
          JSON.stringify({
            draft: false,
            base: { sha: eligibleEvent.baseSha, repo: { id: 11, visibility: 'public' } },
            head: { sha: eligibleEvent.headSha, repo: { id: 99 } },
          }),
        );
      if (url.pathname === '/repos/acme/reviewed/collaborators/alice/permission')
        return new Response(JSON.stringify({ permission: 'write' }));
      if (url.pathname.endsWith('/reactions')) {
        reactions.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}'));
        return new Response(JSON.stringify({ id: 1 }), { status: 201 });
      }
      return new Response('{}', { status: 404 });
    };
    const worker = createCoreWorker(coreEnv(database), {
      github: createGitHubPublicationAdapter({ token: 'installation-token', fetch: fetcher }),
      getReadInstallationToken: async () => ({
        token: 'read-token',
        expiresAt: '2026-09-01T01:00:00.000Z',
      }),
    });
    try {
      const response = await worker.fetch(
        new Request('https://core.internal/review-events', {
          method: 'POST',
          body: JSON.stringify({
            deliveryId: 'delivery-core-worker-manual',
            event: 'issue_comment',
            action: 'created',
            repositoryId: 11,
            pullRequestNumber: 42,
            installationId: 7,
            commentId: 987654,
            commenterLogin: 'alice',
            command: '/ai-review',
          }),
        }),
      );
      expect(response.status).toBe(202);
      expect(reactions).toEqual([{ content: 'eyes' }]);
    } finally {
      database.close();
    }
  });

  it('treats a production GitHub 404 for the manual PR as confirmed missing', async () => {
    const database = new SqliteD1Database();
    let submitted = false;
    const fetcher: typeof fetch = async (input) => {
      const inputUrl =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(inputUrl);
      if (url.pathname === '/repositories/11')
        return new Response(JSON.stringify({ full_name: 'acme/reviewed' }));
      if (url.pathname === '/repos/acme/reviewed/pulls/42')
        return new Response('{}', { status: 404 });
      if (url.pathname.endsWith('/reactions'))
        return new Response(JSON.stringify({ id: 1 }), { status: 201 });
      return new Response('{}', { status: 404 });
    };
    const worker = createCoreWorker(
      coreEnv(database, async (request) => {
        submitted = true;
        return runnerResponse(request);
      }),
      { github: createGitHubPublicationAdapter({ token: 'installation-token', fetch: fetcher }) },
    );
    try {
      expect(
        await worker.fetch(
          new Request('https://core.internal/review-events', {
            method: 'POST',
            body: JSON.stringify({
              deliveryId: 'delivery-core-worker-manual-missing',
              event: 'issue_comment',
              action: 'created',
              repositoryId: 11,
              pullRequestNumber: 42,
              installationId: 7,
              commentId: 987655,
              commenterLogin: 'alice',
              command: '/ai-review',
            }),
          }),
        ),
      ).toMatchObject({ status: 202 });
      expect(submitted).toBe(false);
    } finally {
      database.close();
    }
  });

  it('treats production collaborator permission none as confirmed denial', async () => {
    const database = new SqliteD1Database();
    let submitted = false;
    const fetcher: typeof fetch = async (input) => {
      const inputUrl =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(inputUrl);
      if (url.pathname === '/repositories/11')
        return new Response(JSON.stringify({ full_name: 'acme/reviewed' }));
      if (url.pathname === '/repos/acme/reviewed/pulls/42')
        return new Response(
          JSON.stringify({
            draft: false,
            base: { sha: eligibleEvent.baseSha, repo: { id: 11, visibility: 'public' } },
            head: { sha: eligibleEvent.headSha, repo: { id: 99 } },
          }),
        );
      if (url.pathname.endsWith('/permission'))
        return new Response(JSON.stringify({ permission: 'none' }));
      if (url.pathname.endsWith('/reactions'))
        return new Response(JSON.stringify({ id: 1 }), { status: 201 });
      return new Response('{}', { status: 404 });
    };
    const worker = createCoreWorker(
      coreEnv(database, async (request) => {
        submitted = true;
        return runnerResponse(request);
      }),
      { github: createGitHubPublicationAdapter({ token: 'installation-token', fetch: fetcher }) },
    );
    try {
      expect(
        await worker.fetch(
          new Request('https://core.internal/review-events', {
            method: 'POST',
            body: JSON.stringify({
              deliveryId: 'delivery-core-worker-permission-none',
              event: 'issue_comment',
              action: 'created',
              repositoryId: 11,
              pullRequestNumber: 42,
              installationId: 7,
              commentId: 987656,
              commenterLogin: 'alice',
              command: '/ai-review',
            }),
          }),
        ),
      ).toMatchObject({ status: 202 });
      expect(submitted).toBe(false);
    } finally {
      database.close();
    }
  });

  it('returns 503 when manual GitHub facts remain uncertain', async () => {
    const database = new SqliteD1Database();
    const events: OperationalLogEvent[] = [];
    const worker = createCoreWorker(coreEnv(database), {
      github: {
        getPullRequest: async () => {
          throw new Error('GitHub facts unavailable');
        },
      },
      log: {
        record: async (event) => {
          events.push(event);
        },
      },
    });
    try {
      expect(
        await worker.fetch(
          new Request('https://core.internal/review-events', {
            method: 'POST',
            body: JSON.stringify({
              deliveryId: 'delivery-core-worker-manual-uncertain',
              event: 'issue_comment',
              action: 'created',
              repositoryId: 11,
              pullRequestNumber: 42,
              installationId: 7,
              commentId: 987657,
              commenterLogin: 'alice',
              command: '/ai-review',
            }),
          }),
        ),
      ).toMatchObject({ status: 503 });
      expect(events).toEqual([
        {
          phase: 'core',
          outcome: 'retryable',
          deliveryId: 'delivery-core-worker-manual-uncertain',
          reason: 'pull_request_facts_uncertain',
        },
      ]);
    } finally {
      database.close();
    }
  });

  it('returns 503 when manual commenter permission remains uncertain', async () => {
    const database = new SqliteD1Database();
    const events: OperationalLogEvent[] = [];
    const worker = createCoreWorker(coreEnv(database), {
      github: {
        getPullRequest: async () => ({
          repositoryVisibility: 'public',
          baseRepositoryId: 11,
          headRepositoryId: 99,
          draft: false,
          baseSha: eligibleEvent.baseSha,
          headSha: eligibleEvent.headSha,
        }),
        getCommenterPermission: async () => {
          throw new Error('GitHub permission unavailable');
        },
      },
      log: {
        record: async (event) => {
          events.push(event);
        },
      },
    });
    try {
      expect(
        await worker.fetch(
          new Request('https://core.internal/review-events', {
            method: 'POST',
            body: JSON.stringify({
              deliveryId: 'delivery-core-worker-permission-uncertain',
              event: 'issue_comment',
              action: 'created',
              repositoryId: 11,
              pullRequestNumber: 42,
              installationId: 7,
              commentId: 987658,
              commenterLogin: 'alice',
              command: '/ai-review',
            }),
          }),
        ),
      ).toMatchObject({ status: 503 });
      expect(events).toEqual([
        {
          phase: 'core',
          outcome: 'retryable',
          deliveryId: 'delivery-core-worker-permission-uncertain',
          reason: 'commenter_permission_uncertain',
        },
      ]);
    } finally {
      database.close();
    }
  });

  it('accepts a queued review without requiring Runner admission', async () => {
    const database = new SqliteD1Database();
    const events: OperationalLogEvent[] = [];
    const worker = createCoreWorker(
      coreEnv(database, async () => {
        throw new Error('runner admission failed');
      }),
      {
        github: claimGithub(),
        getReadInstallationToken: async () => ({
          token: 'read-token',
          expiresAt: '2026-09-01T01:00:00.000Z',
        }),
        log: {
          record: async (event) => {
            events.push(event);
          },
        },
      },
    );
    try {
      expect(
        await worker.fetch(
          new Request('https://core.internal/review-events', {
            method: 'POST',
            body: JSON.stringify({
              ...eligibleEvent,
              deliveryId: 'delivery-core-worker-schedule-failed',
            }),
          }),
        ),
      ).toMatchObject({ status: 202 });
      expect(events).toEqual([
        {
          phase: 'core',
          outcome: 'scheduled',
          deliveryId: 'delivery-core-worker-schedule-failed',
          runId: expect.any(String),
        },
      ]);
    } finally {
      database.close();
    }
  });

  it('returns 503 and records a retryable state failure when claiming fails', async () => {
    const database = new SqliteD1Database();
    const events: OperationalLogEvent[] = [];
    const baseStateStore = createD1ReviewStateStore(database);
    const stateStore = {
      ...baseStateStore,
      claimReview: async () => {
        throw new Error('state unavailable');
      },
    };
    const worker = createCoreWorker(coreEnv(database), {
      stateStore,
      log: {
        record: async (event) => {
          events.push(event);
        },
      },
    });
    try {
      expect(
        await worker.fetch(
          new Request('https://core.internal/review-events', {
            method: 'POST',
            body: JSON.stringify(eligibleEvent),
          }),
        ),
      ).toMatchObject({ status: 503 });
      expect(events).toEqual([
        {
          phase: 'core',
          outcome: 'retryable',
          deliveryId: eligibleEvent.deliveryId,
          reason: 'state_failure',
        },
      ]);
    } finally {
      database.close();
    }
  });
});
