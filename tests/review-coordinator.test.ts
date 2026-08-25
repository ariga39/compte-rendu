import { describe, expect, it } from 'vitest';
import {
  createReviewCoordinator,
  createD1ReviewStateStore,
  createGitHubPublicationAdapter,
  createInMemoryReviewStateStore,
  type ReviewJob,
  type ReviewPublicationCreateResult,
  type ReviewPublicationPayload,
  type ReviewStateStore,
} from '../apps/core/src/index';
import type { ReviewEvent } from '../packages/contracts/src';
import { SqliteD1Database } from './support/d1-database';

const eligiblePrivatePullRequest: ReviewEvent = {
  deliveryId: 'delivery-private-1',
  event: 'pull_request',
  action: 'opened',
  repositoryId: 11,
  pullRequestNumber: 42,
  installationId: 7,
  repositoryVisibility: 'private',
  baseRepositoryId: 11,
  headRepositoryId: 99,
  draft: false,
  baseSha: '1111111111111111111111111111111111111111',
  headSha: '2222222222222222222222222222222222222222',
};

describe('Review coordinator', () => {
  it('records publication success after completeReview publishes', async () => {
    const stateStore = createInMemoryReviewStateStore();
    const events: unknown[] = [];
    let runId = '';
    const coordinator = createReviewCoordinator({
      github: {
        loadReviewTarget: async () => ({
          headSha: eligiblePrivatePullRequest.headSha,
          files: [],
        }),
        findReviewByMarker: async () => undefined,
        createReview: async ({ payload }) => ({ kind: 'created', review: payload }),
      },
      stateStore,
      scheduler: {
        schedule: async (_job, scheduledRunId) => {
          runId = scheduledRunId;
        },
      },
      log: {
        record: async (event) => {
          events.push(event);
        },
      },
    });

    expect(await coordinator.handleReviewEvent(eligiblePrivatePullRequest)).toBe('scheduled');
    expect(
      await coordinator.completeReview({
        runId,
        output: { findings: [], summary: 'Published review' },
      }),
    ).toBe('completed');
    expect(events).toContainEqual({
      phase: 'publication',
      outcome: 'published',
      runId,
    });
  });

  it('records invalid output when completeReview rejects the agent result', async () => {
    const stateStore = createInMemoryReviewStateStore();
    const events: unknown[] = [];
    let runId = '';
    const coordinator = createReviewCoordinator({
      github: {},
      stateStore,
      scheduler: {
        schedule: async (_job, scheduledRunId) => {
          runId = scheduledRunId;
        },
      },
      log: {
        record: async (event) => {
          events.push(event);
        },
      },
    });

    expect(await coordinator.handleReviewEvent(eligiblePrivatePullRequest)).toBe('scheduled');
    expect(
      await coordinator.completeReview({
        runId,
        output: { summary: 'missing findings' },
      }),
    ).toBe('failed');
    expect(events).toContainEqual({
      phase: 'publication',
      outcome: 'failed',
      runId,
      reason: 'invalid_output',
    });
  });

  it('marks a review superseded when the head changes at the POST edge', async () => {
    const stateStore = createInMemoryReviewStateStore();
    const reviews: ReviewPublicationPayload[] = [];
    const events: unknown[] = [];
    let runId = '';
    let headChanged = false;
    const coordinator = createReviewCoordinator({
      github: {
        loadReviewTarget: async () => ({
          headSha: eligiblePrivatePullRequest.headSha,
          files: [],
        }),
        findReviewByMarker: async () => {
          headChanged = true;
          return undefined;
        },
        createReview: async ({ payload }): Promise<ReviewPublicationCreateResult> => {
          if (headChanged) {
            return {
              kind: 'stale',
              currentHeadSha: '3333333333333333333333333333333333333333',
            };
          }
          reviews.push(payload);
          return { kind: 'created', review: payload };
        },
      },
      stateStore,
      scheduler: {
        schedule: async (_job, scheduledRunId) => {
          runId = scheduledRunId;
        },
      },
      log: {
        record: async (event) => {
          events.push(event);
        },
      },
    });

    expect(await coordinator.handleReviewEvent(eligiblePrivatePullRequest)).toBe('scheduled');

    expect(
      await coordinator.completeReview({
        runId,
        output: { findings: [], summary: 'TOCTOU review' },
      }),
    ).toBe('ignored');
    expect(reviews).toEqual([]);
    expect(await coordinator.handleReviewEvent(eligiblePrivatePullRequest)).toBe('ignored');
    expect(events).toContainEqual({
      phase: 'publication',
      outcome: 'superseded',
      runId,
    });
  });

  it('retries one transient GitHub POST and exposes one completed review', async () => {
    const stateStore = createInMemoryReviewStateStore();
    const postedReviews: unknown[] = [];
    let transientFailure = true;
    let runId = '';
    const fetcher: typeof fetch = async (input, init) => {
      const inputUrl =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(inputUrl);
      const method = init?.method ?? 'GET';
      if (new Headers(init?.headers).get('user-agent') !== 'compte-rendu-core') {
        return new Response('{}', { status: 403 });
      }
      if (url.pathname === '/repositories/11') {
        return new Response(JSON.stringify({ full_name: 'acme/reviewed' }));
      }
      if (url.pathname === '/repos/acme/reviewed/pulls/42') {
        return new Response(JSON.stringify({ head: { sha: eligiblePrivatePullRequest.headSha } }));
      }
      if (url.pathname === '/repos/acme/reviewed/pulls/42/files') {
        return new Response(JSON.stringify([]));
      }
      if (url.pathname === '/repos/acme/reviewed/pulls/42/reviews' && method === 'GET') {
        return new Response(JSON.stringify([]));
      }
      if (url.pathname === '/repos/acme/reviewed/pulls/42/reviews' && method === 'POST') {
        if (transientFailure) {
          transientFailure = false;
          return new Response('{}', { status: 503 });
        }
        postedReviews.push(init?.body ?? null);
        return new Response(JSON.stringify({ id: 1, body: '<!-- compte-rendu:run:run-1 -->' }));
      }
      return new Response('{}', { status: 404 });
    };
    const coordinator = createReviewCoordinator({
      github: createGitHubPublicationAdapter({ token: 'installation-token', fetch: fetcher }),
      stateStore,
      scheduler: {
        schedule: async (_job, scheduledRunId) => {
          runId = scheduledRunId;
        },
      },
    });

    expect(await coordinator.handleReviewEvent(eligiblePrivatePullRequest)).toBe('scheduled');
    expect(
      await coordinator.completeReview({
        runId,
        output: { findings: [], summary: 'Retryable publication' },
      }),
    ).toBe('completed');
    expect(postedReviews).toHaveLength(1);
    expect(await coordinator.handleReviewEvent(eligiblePrivatePullRequest)).toBe('completed');
  });

  it('fails closed when marker recovery is exhausted after an uncertain POST', async () => {
    const stateStore = createInMemoryReviewStateStore();
    let runId = '';
    const remoteReviews: string[] = [];
    const events: unknown[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const inputUrl =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(inputUrl);
      const method = init?.method ?? 'GET';
      if (url.pathname === '/repositories/11') {
        return new Response(JSON.stringify({ full_name: 'acme/reviewed' }));
      }
      if (url.pathname === '/repos/acme/reviewed/pulls/42') {
        return new Response(JSON.stringify({ head: { sha: eligiblePrivatePullRequest.headSha } }));
      }
      if (url.pathname === '/repos/acme/reviewed/pulls/42/files') {
        return new Response(JSON.stringify([]));
      }
      if (url.pathname === '/repos/acme/reviewed/pulls/42/reviews' && method === 'GET') {
        return remoteReviews.length === 0
          ? new Response(JSON.stringify([]))
          : new Response('{}', { status: 503 });
      }
      if (url.pathname === '/repos/acme/reviewed/pulls/42/reviews' && method === 'POST') {
        if (typeof init?.body === 'string') remoteReviews.push(init.body);
        return new Response('{}', { status: 503 });
      }
      return new Response('{}', { status: 404 });
    };
    const coordinator = createReviewCoordinator({
      github: createGitHubPublicationAdapter({ token: 'installation-token', fetch: fetcher }),
      stateStore,
      scheduler: {
        schedule: async (_job, scheduledRunId) => {
          runId = scheduledRunId;
        },
      },
      log: {
        record: async (event) => {
          events.push(event);
        },
      },
    });

    expect(await coordinator.handleReviewEvent(eligiblePrivatePullRequest)).toBe('scheduled');
    expect(
      await coordinator.completeReview({
        runId,
        output: { findings: [], summary: 'Uncertain publication' },
      }),
    ).toBe('failed');
    expect(remoteReviews).toHaveLength(1);
    expect(await coordinator.handleReviewEvent(eligiblePrivatePullRequest)).toBe('failed');
    expect(events).toContainEqual({
      phase: 'publication',
      outcome: 'failed',
      runId,
      reason: 'marker_lookup_failed',
    });
  });

  it('publishes the 101st changed file and recognizes the 101st existing marker', async () => {
    const stateStore = createInMemoryReviewStateStore();
    const postedPayloads: string[] = [];
    const pageOneFiles = Array.from({ length: 100 }, (_, index) => ({
      filename: `src/unchanged-${index}.ts`,
      patch: '@@ -1,1 +1,1 @@\n context\n',
    }));
    const pageOneReviews = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      body: null,
    }));
    let firstRunId = '';
    let secondRunId = '';
    const fetcher: typeof fetch = async (input, init) => {
      const inputUrl =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(inputUrl);
      const method = init?.method ?? 'GET';
      const pullRequestMatch = /^\/repos\/acme\/reviewed\/pulls\/(\d+)(?:\/|$)/.exec(url.pathname);
      const pullRequestNumber = pullRequestMatch?.[1];

      if (url.pathname === '/repositories/11') {
        return new Response(JSON.stringify({ full_name: 'acme/reviewed' }));
      }
      if (pullRequestNumber !== undefined && url.pathname.endsWith(`/pulls/${pullRequestNumber}`)) {
        return new Response(JSON.stringify({ head: { sha: eligiblePrivatePullRequest.headSha } }));
      }
      if (pullRequestNumber !== undefined && url.pathname.endsWith('/files')) {
        const page = url.searchParams.get('page');
        if (pullRequestNumber === '42' && page === '1') {
          return new Response(JSON.stringify(pageOneFiles));
        }
        if (pullRequestNumber === '42' && page === '2') {
          return new Response(
            JSON.stringify([
              {
                filename: 'src/target.ts',
                patch: '@@ -1,0 +2,1 @@\n+target\n',
              },
            ]),
          );
        }
        return new Response(JSON.stringify([]));
      }
      if (
        pullRequestNumber !== undefined &&
        url.pathname.endsWith('/reviews') &&
        method === 'GET'
      ) {
        if (pullRequestNumber === '43' && url.searchParams.get('page') === '2') {
          return new Response(
            JSON.stringify([{ id: 101, body: `<!-- compte-rendu:run:${secondRunId} -->` }]),
          );
        }
        if (pullRequestNumber === '42' && url.searchParams.get('page') === '2') {
          return new Response(JSON.stringify([]));
        }
        return new Response(JSON.stringify(pageOneReviews));
      }
      if (
        pullRequestNumber !== undefined &&
        url.pathname.endsWith('/reviews') &&
        method === 'POST'
      ) {
        if (typeof init?.body === 'string') postedPayloads.push(init.body);
        return new Response(JSON.stringify({ id: 200, body: '<!-- published -->' }));
      }
      return new Response('{}', { status: 404 });
    };
    const coordinator = createReviewCoordinator({
      github: createGitHubPublicationAdapter({ token: 'installation-token', fetch: fetcher }),
      stateStore,
      scheduler: {
        schedule: async (_job, scheduledRunId) => {
          if (firstRunId === '') firstRunId = scheduledRunId;
          else secondRunId = scheduledRunId;
        },
      },
    });

    expect(await coordinator.handleReviewEvent(eligiblePrivatePullRequest)).toBe('scheduled');
    expect(
      await coordinator.completeReview({
        runId: firstRunId,
        output: {
          findings: [{ path: 'src/target.ts', line: 2, message: '101st file finding' }],
          summary: 'Paged file review',
        },
      }),
    ).toBe('completed');
    expect(postedPayloads).toHaveLength(1);
    expect(JSON.parse(postedPayloads[0])).toMatchObject({
      comments: [{ path: 'src/target.ts', line: 2, side: 'RIGHT' }],
    });

    const secondEvent = {
      ...eligiblePrivatePullRequest,
      deliveryId: 'delivery-page-marker',
      pullRequestNumber: 43,
    };
    expect(await coordinator.handleReviewEvent(secondEvent)).toBe('scheduled');
    expect(
      await coordinator.completeReview({
        runId: secondRunId,
        output: { findings: [], summary: 'Existing marker review' },
      }),
    ).toBe('completed');
    expect(postedPayloads).toHaveLength(1);
    expect(await coordinator.handleReviewEvent(secondEvent)).toBe('completed');
  });

  it('publishes capped valid right-side findings for the current head and completes the run', async () => {
    const stateStore = createInMemoryReviewStateStore();
    const reviews: ReviewPublicationPayload[] = [];
    let runId = '';
    const coordinator = createReviewCoordinator({
      github: {
        loadReviewTarget: async () => ({
          headSha: eligiblePrivatePullRequest.headSha,
          files: [
            {
              path: 'src/review.ts',
              patch: '@@ -1,0 +2,6 @@\n+one\n+two\n+three\n+four\n+five\n+six\n',
            },
          ],
        }),
        findReviewByMarker: async () => undefined,
        createReview: async ({ payload }): Promise<ReviewPublicationCreateResult> => {
          reviews.push(payload);
          return { kind: 'created', review: payload };
        },
      },
      stateStore,
      scheduler: {
        schedule: async (_job, scheduledRunId) => {
          runId = scheduledRunId;
        },
      },
    });

    expect(await coordinator.handleReviewEvent(eligiblePrivatePullRequest)).toBe('scheduled');

    const disposition = await coordinator.completeReview({
      runId,
      output: {
        findings: [
          { path: 'src/review.ts', line: 2, message: 'one finding' },
          { path: 'README.md', line: 2, message: 'wrong path' },
          { path: 'src/review.ts', line: 3, message: 'two finding' },
          { path: 'src/review.ts', line: 1, message: 'left side' },
          { path: 'src/review.ts', line: 4, message: 'three finding' },
          { path: 'src/review.ts', line: 5, message: 'four finding' },
          { path: 'src/review.ts', line: 6, message: 'five finding' },
          { path: 'src/review.ts', line: 7, message: 'six finding' },
          { path: 'src/review.ts', line: 2, message: 'one finding' },
        ],
        summary: 'Review summary',
      },
    });

    expect(disposition).toBe('completed');
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      event: 'COMMENT',
      commit_id: eligiblePrivatePullRequest.headSha,
      body: expect.stringContaining('Review summary'),
      comments: [
        { path: 'src/review.ts', line: 2, side: 'RIGHT', body: 'one finding' },
        { path: 'src/review.ts', line: 3, side: 'RIGHT', body: 'two finding' },
        { path: 'src/review.ts', line: 4, side: 'RIGHT', body: 'three finding' },
        { path: 'src/review.ts', line: 5, side: 'RIGHT', body: 'four finding' },
        { path: 'src/review.ts', line: 6, side: 'RIGHT', body: 'five finding' },
      ],
    });
    expect(await coordinator.handleReviewEvent(eligiblePrivatePullRequest)).toBe('completed');
  });

  it('treats added content beginning with plus signs as a right-side line', async () => {
    const stateStore = createInMemoryReviewStateStore();
    const reviews: ReviewPublicationPayload[] = [];
    let runId = '';
    const coordinator = createReviewCoordinator({
      github: {
        loadReviewTarget: async () => ({
          headSha: eligiblePrivatePullRequest.headSha,
          files: [{ path: 'src/plus.ts', patch: '@@ -1,0 +2,1 @@\n+++added\n' }],
        }),
        findReviewByMarker: async () => undefined,
        createReview: async ({ payload }): Promise<ReviewPublicationCreateResult> => {
          reviews.push(payload);
          return { kind: 'created', review: payload };
        },
      },
      stateStore,
      scheduler: {
        schedule: async (_job, scheduledRunId) => {
          runId = scheduledRunId;
        },
      },
    });

    expect(await coordinator.handleReviewEvent(eligiblePrivatePullRequest)).toBe('scheduled');
    expect(
      await coordinator.completeReview({
        runId,
        output: {
          findings: [{ path: 'src/plus.ts', line: 2, message: 'plus content' }],
          summary: 'Plus',
        },
      }),
    ).toBe('completed');
    expect(reviews[0]?.comments).toEqual([
      { path: 'src/plus.ts', line: 2, side: 'RIGHT', body: 'plus content' },
    ]);
  });

  it('persists completion in D1 so the coordinator replay is terminal', async () => {
    const database = new SqliteD1Database();
    const stateStore = createD1ReviewStateStore(database);
    let runId = '';
    const event = { ...eligiblePrivatePullRequest, deliveryId: 'delivery-sqlite-complete' };
    const coordinator = createReviewCoordinator({
      github: {
        loadReviewTarget: async () => ({
          headSha: event.headSha,
          files: [],
        }),
        createReview: async ({ payload }): Promise<ReviewPublicationCreateResult> => ({
          kind: 'created',
          review: payload,
        }),
      },
      stateStore,
      scheduler: {
        schedule: async (_job, scheduledRunId) => {
          runId = scheduledRunId;
        },
      },
    });

    try {
      expect(await coordinator.handleReviewEvent(event)).toBe('scheduled');
      expect(
        await coordinator.completeReview({
          runId,
          output: { findings: [], summary: 'D1 completion' },
        }),
      ).toBe('completed');
      expect(await coordinator.handleReviewEvent(event)).toBe('completed');
    } finally {
      database.close();
    }
  });

  it('claims a fresh manual run after a failed run for the same head', async () => {
    const database = new SqliteD1Database();
    const stateStore = createD1ReviewStateStore(database);
    const job: ReviewJob = {
      repositoryId: 11,
      pullRequestNumber: 42,
      installationId: 7,
      baseSha: eligiblePrivatePullRequest.baseSha,
      headSha: eligiblePrivatePullRequest.headSha,
      trigger: 'manual',
      commentId: 987654,
    };

    try {
      const first = await stateStore.claimReview({
        deliveryId: 'manual-delivery-failed',
        job,
        occurredAt: '2026-08-25T00:00:00.000Z',
      });
      expect(first.kind).toBe('claimed');
      if (first.kind !== 'claimed') throw new Error('first claim was not scheduled');

      await stateStore.markSchedulingFailed({
        runId: first.runId,
        occurredAt: '2026-08-25T00:01:00.000Z',
      });

      const second = await stateStore.claimReview({
        deliveryId: 'manual-delivery-retry',
        job: { ...job, commentId: 987655 },
        occurredAt: '2026-08-25T00:02:00.000Z',
      });
      expect(second.kind).toBe('claimed');
      if (second.kind !== 'claimed') throw new Error('manual retry was not scheduled');
      expect(second.runId).not.toBe(first.runId);
      expect(await stateStore.getRunOutcome(first.runId)).toMatchObject({
        deliveryId: 'manual-delivery-failed',
        repositoryId: 11,
        pullRequestNumber: 42,
        headSha: eligiblePrivatePullRequest.headSha,
        status: 'failed',
      });
      expect(await stateStore.getRunOutcome(second.runId)).toMatchObject({
        deliveryId: 'manual-delivery-retry',
        headSha: eligiblePrivatePullRequest.headSha,
        status: 'scheduled',
      });
    } finally {
      database.close();
    }
  });

  it('deduplicates distinct deliveries while a same-head run is scheduled or completed', async () => {
    const database = new SqliteD1Database();
    const stateStore = createD1ReviewStateStore(database);
    const job: ReviewJob = {
      repositoryId: 11,
      pullRequestNumber: 42,
      installationId: 7,
      baseSha: eligiblePrivatePullRequest.baseSha,
      headSha: eligiblePrivatePullRequest.headSha,
      trigger: 'manual',
      commentId: 987654,
    };

    try {
      const first = await stateStore.claimReview({
        deliveryId: 'manual-delivery-scheduled',
        job,
        occurredAt: '2026-08-25T00:00:00.000Z',
      });
      expect(first).toMatchObject({ kind: 'claimed' });
      if (first.kind !== 'claimed') throw new Error('first claim was not scheduled');

      expect(
        await stateStore.claimReview({
          deliveryId: 'manual-delivery-scheduled-duplicate',
          job: { ...job, commentId: 987655 },
          occurredAt: '2026-08-25T00:01:00.000Z',
        }),
      ).toEqual({ kind: 'existing', disposition: 'scheduled' });

      expect(
        await stateStore.markRunCompleted({
          runId: first.runId,
          occurredAt: '2026-08-25T00:02:00.000Z',
        }),
      ).toBe(true);
      expect(
        await stateStore.claimReview({
          deliveryId: 'manual-delivery-completed-duplicate',
          job: { ...job, commentId: 987656 },
          occurredAt: '2026-08-25T00:03:00.000Z',
        }),
      ).toEqual({ kind: 'existing', disposition: 'completed' });
    } finally {
      database.close();
    }
  });

  it('atomically admits only one concurrent same-head manual claim', async () => {
    const database = new SqliteD1Database();
    const stateStore = createD1ReviewStateStore(database);
    const failedJob: ReviewJob = {
      repositoryId: 11,
      pullRequestNumber: 42,
      installationId: 7,
      baseSha: eligiblePrivatePullRequest.baseSha,
      headSha: eligiblePrivatePullRequest.headSha,
      trigger: 'manual',
      commentId: 987654,
    };

    try {
      const first = await stateStore.claimReview({
        deliveryId: 'manual-delivery-concurrent-seed',
        job: failedJob,
        occurredAt: '2026-08-25T00:00:00.000Z',
      });
      if (first.kind !== 'claimed') throw new Error('seed claim was not scheduled');
      await stateStore.markSchedulingFailed({
        runId: first.runId,
        occurredAt: '2026-08-25T00:01:00.000Z',
      });

      const results = await Promise.all([
        stateStore.claimReview({
          deliveryId: 'manual-delivery-concurrent-a',
          job: { ...failedJob, commentId: 987655 },
          occurredAt: '2026-08-25T00:02:00.000Z',
        }),
        stateStore.claimReview({
          deliveryId: 'manual-delivery-concurrent-b',
          job: { ...failedJob, commentId: 987656 },
          occurredAt: '2026-08-25T00:02:00.000Z',
        }),
      ]);

      expect(results.filter((result) => result.kind === 'claimed')).toHaveLength(1);
      expect(results.filter((result) => result.kind === 'existing')).toEqual([
        { kind: 'existing', disposition: 'scheduled' },
      ]);
    } finally {
      database.close();
    }
  });

  it('preserves failed run history when the retry migration is applied forward', async () => {
    const database = new SqliteD1Database(['0001_review_state.sql']);
    const stateStore = createD1ReviewStateStore(database);
    const job: ReviewJob = {
      repositoryId: 11,
      pullRequestNumber: 42,
      installationId: 7,
      baseSha: eligiblePrivatePullRequest.baseSha,
      headSha: eligiblePrivatePullRequest.headSha,
      trigger: 'manual',
      commentId: 987654,
    };

    try {
      const first = await stateStore.claimReview({
        deliveryId: 'manual-delivery-before-migration',
        job,
        occurredAt: '2026-08-25T00:00:00.000Z',
      });
      if (first.kind !== 'claimed') throw new Error('seed claim was not scheduled');
      await stateStore.markSchedulingFailed({
        runId: first.runId,
        occurredAt: '2026-08-25T00:01:00.000Z',
      });

      database.applyMigrations(['0002_allow_manual_retry.sql']);

      const retry = await createD1ReviewStateStore(database).claimReview({
        deliveryId: 'manual-delivery-after-migration',
        job: { ...job, commentId: 987655 },
        occurredAt: '2026-08-25T00:02:00.000Z',
      });
      expect(retry.kind).toBe('claimed');
      if (retry.kind !== 'claimed') throw new Error('migrated retry was not scheduled');
      expect(retry.runId).not.toBe(first.runId);
      expect(await createD1ReviewStateStore(database).getRunOutcome(first.runId)).toMatchObject({
        deliveryId: 'manual-delivery-before-migration',
        status: 'failed',
      });
    } finally {
      database.close();
    }
  });

  it('supersedes without publishing when the current head has changed', async () => {
    const stateStore = createInMemoryReviewStateStore();
    const reviews: ReviewPublicationPayload[] = [];
    let runId = '';
    const coordinator = createReviewCoordinator({
      github: {
        loadReviewTarget: async () => ({
          headSha: '3333333333333333333333333333333333333333',
          files: [],
        }),
        createReview: async ({ payload }): Promise<ReviewPublicationCreateResult> => {
          reviews.push(payload);
          return { kind: 'created', review: payload };
        },
      },
      stateStore,
      scheduler: {
        schedule: async (_job, scheduledRunId) => {
          runId = scheduledRunId;
        },
      },
    });

    expect(await coordinator.handleReviewEvent(eligiblePrivatePullRequest)).toBe('scheduled');

    const disposition = await coordinator.completeReview({
      runId,
      output: { findings: [], summary: 'Stale review' },
    });

    expect(disposition).toBe('ignored');
    expect(reviews).toEqual([]);
    expect(await coordinator.handleReviewEvent(eligiblePrivatePullRequest)).toBe('ignored');
  });

  it('converges an uncertain publication and repeated completion to one review', async () => {
    const stateStore = createInMemoryReviewStateStore();
    const reviews: ReviewPublicationPayload[] = [];
    let existingReview: ReviewPublicationPayload | undefined;
    let runId = '';
    let uncertain = true;
    const coordinator = createReviewCoordinator({
      github: {
        loadReviewTarget: async () => ({
          headSha: eligiblePrivatePullRequest.headSha,
          files: [],
        }),
        findReviewByMarker: async () => existingReview,
        createReview: async ({ payload }): Promise<ReviewPublicationCreateResult> => {
          reviews.push(payload);
          existingReview = payload;
          if (uncertain) {
            uncertain = false;
            throw new Error('network result uncertain');
          }
          return { kind: 'created', review: payload };
        },
      },
      stateStore,
      scheduler: {
        schedule: async (_job, scheduledRunId) => {
          runId = scheduledRunId;
        },
      },
    });

    expect(await coordinator.handleReviewEvent(eligiblePrivatePullRequest)).toBe('scheduled');

    const output = { findings: [], summary: 'Repeatable summary' };
    expect(await coordinator.completeReview({ runId, output })).toBe('completed');
    expect(await coordinator.completeReview({ runId, output })).toBe('completed');
    expect(reviews).toHaveLength(1);
    expect(await coordinator.handleReviewEvent(eligiblePrivatePullRequest)).toBe('completed');
  });

  it('publishes a summary-only COMMENT when no finding is valid for the diff', async () => {
    const stateStore = createInMemoryReviewStateStore();
    const reviews: ReviewPublicationPayload[] = [];
    let runId = '';
    const coordinator = createReviewCoordinator({
      github: {
        loadReviewTarget: async () => ({
          headSha: eligiblePrivatePullRequest.headSha,
          files: [{ path: 'src/review.ts', patch: '@@ -1,0 +2,1 @@\n+changed\n' }],
        }),
        createReview: async ({ payload }): Promise<ReviewPublicationCreateResult> => {
          reviews.push(payload);
          return { kind: 'created', review: payload };
        },
      },
      stateStore,
      scheduler: {
        schedule: async (_job, scheduledRunId) => {
          runId = scheduledRunId;
        },
      },
    });

    expect(await coordinator.handleReviewEvent(eligiblePrivatePullRequest)).toBe('scheduled');

    expect(
      await coordinator.completeReview({
        runId,
        output: {
          findings: [{ path: 'src/review.ts', line: 100, message: 'not in patch' }],
          summary: 'No actionable findings',
        },
      }),
    ).toBe('completed');

    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      event: 'COMMENT',
      body: expect.stringContaining('No actionable findings'),
      comments: [],
    });
  });

  it('passes the claimed run id to the scheduler through the public seam', async () => {
    const scheduled: Array<{ job: ReviewJob; runId: string }> = [];
    const coordinator = createReviewCoordinator({
      github: {},
      stateStore: createInMemoryReviewStateStore(),
      scheduler: {
        schedule: async (job, runId) => {
          scheduled.push({ job, runId });
        },
      },
    });

    const disposition = await coordinator.handleReviewEvent(eligiblePrivatePullRequest);

    expect(disposition).toBe('scheduled');
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].runId).toBe('run-1');
  });

  it('does not let a late old-head delivery supersede the newer active run', async () => {
    const database = new SqliteD1Database();
    const stateStore = createD1ReviewStateStore(database);
    const scheduled: Array<{ job: ReviewJob; runId: string }> = [];
    const coordinator = createReviewCoordinator({
      github: {},
      stateStore,
      scheduler: {
        schedule: async (job, runId) => {
          scheduled.push({ job, runId });
        },
      },
    });

    try {
      expect(await coordinator.handleReviewEvent(eligiblePrivatePullRequest)).toBe('scheduled');
      expect(
        await coordinator.handleReviewEvent({
          ...eligiblePrivatePullRequest,
          deliveryId: 'delivery-newer-head',
          action: 'synchronize',
          headSha: '3333333333333333333333333333333333333333',
        }),
      ).toBe('scheduled');

      expect(
        await coordinator.handleReviewEvent({
          ...eligiblePrivatePullRequest,
          deliveryId: 'delivery-late-old-head',
          action: 'synchronize',
        }),
      ).toBe('ignored');

      expect(await stateStore.getDeliveryOutcome('delivery-newer-head')).toMatchObject({
        status: 'scheduled',
      });
      expect(await stateStore.getRunOutcome(scheduled[1].runId)).toMatchObject({
        deliveryId: 'delivery-newer-head',
        status: 'scheduled',
      });
      const originalOldOutcome = await stateStore.getDeliveryOutcome(
        eligiblePrivatePullRequest.deliveryId,
      );
      expect(await coordinator.handleReviewEvent(eligiblePrivatePullRequest)).toBe('ignored');
      expect(await stateStore.getDeliveryOutcome(eligiblePrivatePullRequest.deliveryId)).toEqual(
        originalOldOutcome,
      );
      expect(await stateStore.getDeliveryOutcome('delivery-late-old-head')).toMatchObject({
        status: 'superseded',
      });
      expect(scheduled).toHaveLength(2);
    } finally {
      database.close();
    }
  });

  it('keeps a superseded delivery terminal when its old scheduler fails after a newer claim', async () => {
    const database = new SqliteD1Database();
    const stateStore = createD1ReviewStateStore(database);
    const newerEvent: ReviewEvent = {
      ...eligiblePrivatePullRequest,
      deliveryId: 'delivery-race-newer',
      action: 'synchronize',
      headSha: '3333333333333333333333333333333333333333',
    };
    let coordinator!: ReturnType<typeof createReviewCoordinator>;
    let oldRunId = '';
    let raced = false;

    coordinator = createReviewCoordinator({
      github: {},
      stateStore,
      scheduler: {
        schedule: async (job, runId) => {
          if (job.headSha === eligiblePrivatePullRequest.headSha && !raced) {
            oldRunId = runId;
            raced = true;
            expect(await coordinator.handleReviewEvent(newerEvent)).toBe('scheduled');
            throw new Error('old scheduler failed late');
          }
        },
      },
    });

    try {
      expect(await coordinator.handleReviewEvent(eligiblePrivatePullRequest)).toBe('failed');
      expect(
        await stateStore.getDeliveryOutcome(eligiblePrivatePullRequest.deliveryId),
      ).toMatchObject({
        status: 'superseded',
      });

      await stateStore.markRunCompleted({
        runId: oldRunId,
        occurredAt: '2026-01-01T00:00:00.000Z',
      });

      expect(
        await stateStore.getDeliveryOutcome(eligiblePrivatePullRequest.deliveryId),
      ).toMatchObject({
        status: 'superseded',
      });
      expect(await stateStore.getDeliveryOutcome(newerEvent.deliveryId)).toMatchObject({
        status: 'scheduled',
      });
    } finally {
      database.close();
    }
  });

  it('does not schedule the same delivery twice when GitHub replays it', async () => {
    const scheduled: ReviewJob[] = [];
    let claimCount = 0;
    const recordedDeliveries = new Map<string, string>();
    const stateStore: ReviewStateStore = {
      recordDelivery: async ({ deliveryId, status }) => {
        recordedDeliveries.set(deliveryId, status);
      },
      claimReview: async () => {
        claimCount += 1;
        return claimCount === 1
          ? { kind: 'claimed', runId: 'run-1' }
          : { kind: 'replay', disposition: 'scheduled' };
      },
      markSchedulingFailed: async () => {},
    };
    const coordinator = createReviewCoordinator({
      github: {},
      stateStore,
      scheduler: {
        schedule: async (job) => {
          scheduled.push(job);
        },
      },
    });

    const first = await coordinator.handleReviewEvent(eligiblePrivatePullRequest);
    const replay = await coordinator.handleReviewEvent(eligiblePrivatePullRequest);

    expect(first).toBe('scheduled');
    expect(replay).toBe('scheduled');
    expect(scheduled).toHaveLength(1);
  });

  it('does not schedule the same PR head twice across different deliveries', async () => {
    const scheduled: ReviewJob[] = [];
    const coordinator = createReviewCoordinator({
      github: {},
      stateStore: createInMemoryReviewStateStore(),
      scheduler: {
        schedule: async (job) => {
          scheduled.push(job);
        },
      },
    });

    const first = await coordinator.handleReviewEvent(eligiblePrivatePullRequest);
    const duplicateHead = await coordinator.handleReviewEvent({
      ...eligiblePrivatePullRequest,
      deliveryId: 'delivery-private-duplicate-head',
      action: 'synchronize',
    });

    expect(first).toBe('scheduled');
    expect(duplicateHead).toBe('scheduled');
    expect(scheduled).toHaveLength(1);
  });

  it('leaves a failed scheduling outcome that blocks another delivery for the same head', async () => {
    const scheduled: ReviewJob[] = [];
    const coordinator = createReviewCoordinator({
      github: {},
      stateStore: createInMemoryReviewStateStore(),
      scheduler: {
        schedule: async (job) => {
          scheduled.push(job);
          throw new Error('queue unavailable');
        },
      },
    });

    const first = await coordinator.handleReviewEvent(eligiblePrivatePullRequest);
    const retryDelivery = await coordinator.handleReviewEvent({
      ...eligiblePrivatePullRequest,
      deliveryId: 'delivery-private-failed-retry',
    });

    expect(first).toBe('failed');
    expect(retryDelivery).toBe('failed');
    expect(scheduled).toHaveLength(1);
  });

  it('supersedes an active older head when a newer head is claimed', async () => {
    const scheduled: ReviewJob[] = [];
    const coordinator = createReviewCoordinator({
      github: {},
      stateStore: createInMemoryReviewStateStore(),
      scheduler: {
        schedule: async (job) => {
          scheduled.push(job);
        },
      },
    });

    const first = await coordinator.handleReviewEvent(eligiblePrivatePullRequest);
    const newer = await coordinator.handleReviewEvent({
      ...eligiblePrivatePullRequest,
      deliveryId: 'delivery-private-newer-head',
      action: 'synchronize',
      headSha: '3333333333333333333333333333333333333333',
    });
    const oldHead = await coordinator.handleReviewEvent(eligiblePrivatePullRequest);

    expect(first).toBe('scheduled');
    expect(newer).toBe('scheduled');
    expect(oldHead).toBe('ignored');
    expect(scheduled).toHaveLength(2);
  });

  it('schedules an eligible private PR at its exact base and head SHAs', async () => {
    const scheduled: ReviewJob[] = [];
    const coordinator = createReviewCoordinator({
      github: {},
      stateStore: createInMemoryReviewStateStore(),
      scheduler: {
        schedule: async (job) => {
          scheduled.push(job);
        },
      },
    });

    const disposition = await coordinator.handleReviewEvent(eligiblePrivatePullRequest);

    expect(disposition).toBe('scheduled');
    expect(scheduled).toEqual([
      {
        repositoryId: 11,
        pullRequestNumber: 42,
        installationId: 7,
        baseSha: '1111111111111111111111111111111111111111',
        headSha: '2222222222222222222222222222222222222222',
        trigger: 'automatic',
      },
    ]);
  });

  it('schedules the current PR revision when a maintainer issues /ai-review', async () => {
    const scheduled: ReviewJob[] = [];
    const reactions: unknown[] = [];
    const coordinator = createReviewCoordinator({
      github: {
        getPullRequest: async () => ({
          repositoryVisibility: 'public',
          baseRepositoryId: 11,
          headRepositoryId: 99,
          draft: false,
          baseSha: '3333333333333333333333333333333333333333',
          headSha: '4444444444444444444444444444444444444444',
        }),
        getCommenterPermission: async () => 'maintain',
        addReaction: async (input) => {
          reactions.push(input);
        },
      },
      stateStore: createInMemoryReviewStateStore(),
      scheduler: {
        schedule: async (job) => {
          scheduled.push(job);
        },
      },
    });

    const disposition = await coordinator.handleReviewEvent({
      deliveryId: 'delivery-comment-1',
      event: 'issue_comment',
      action: 'created',
      repositoryId: 11,
      pullRequestNumber: 42,
      installationId: 7,
      commentId: 987654,
      commenterLogin: 'maintainer',
      command: '/ai-review',
    });

    expect(disposition).toBe('scheduled');
    expect(scheduled).toEqual([
      {
        repositoryId: 11,
        pullRequestNumber: 42,
        installationId: 7,
        commentId: 987654,
        baseSha: '3333333333333333333333333333333333333333',
        headSha: '4444444444444444444444444444444444444444',
        trigger: 'manual',
      },
    ]);
    expect(reactions).toEqual([
      {
        repositoryId: 11,
        installationId: 7,
        commentId: 987654,
        content: 'eyes',
      },
    ]);
  });

  it('schedules a fresh manual delivery after its same-head run failed', async () => {
    const stateStore = createInMemoryReviewStateStore();
    const scheduled: Array<{ job: ReviewJob; runId: string }> = [];
    let attempts = 0;
    let failedRunId = '';
    const coordinator = createReviewCoordinator({
      github: {
        getPullRequest: async () => ({
          repositoryVisibility: 'public',
          baseRepositoryId: 11,
          headRepositoryId: 99,
          draft: false,
          baseSha: '3333333333333333333333333333333333333333',
          headSha: '4444444444444444444444444444444444444444',
        }),
        getCommenterPermission: async () => 'maintain',
      },
      stateStore,
      scheduler: {
        schedule: async (job, runId) => {
          attempts += 1;
          if (attempts === 1) {
            failedRunId = runId;
            throw new Error('workflow unavailable');
          }
          scheduled.push({ job, runId });
        },
      },
    });

    const first = await coordinator.handleReviewEvent({
      deliveryId: 'delivery-manual-failed',
      event: 'issue_comment',
      action: 'created',
      repositoryId: 11,
      pullRequestNumber: 42,
      installationId: 7,
      commentId: 987654,
      commenterLogin: 'maintainer',
      command: '/ai-review',
    });
    const second = await coordinator.handleReviewEvent({
      deliveryId: 'delivery-manual-retry',
      event: 'issue_comment',
      action: 'created',
      repositoryId: 11,
      pullRequestNumber: 42,
      installationId: 7,
      commentId: 987655,
      commenterLogin: 'maintainer',
      command: '/ai-review',
    });

    expect(first).toBe('failed');
    expect(second).toBe('scheduled');
    expect(scheduled).toHaveLength(1);
    expect(await stateStore.getDeliveryOutcome('delivery-manual-failed')).toMatchObject({
      status: 'failed',
      headSha: '4444444444444444444444444444444444444444',
    });
    expect(await stateStore.getDeliveryOutcome('delivery-manual-retry')).toMatchObject({
      status: 'scheduled',
      headSha: '4444444444444444444444444444444444444444',
    });
    expect(scheduled[0]?.runId).not.toBe(failedRunId);
  });

  it('schedules once when a transient manual facts read recovers', async () => {
    const scheduled: ReviewJob[] = [];
    let transient = true;
    const coordinator = createReviewCoordinator({
      github: {
        getPullRequest: async () => {
          if (transient) {
            transient = false;
            throw new Error('temporary GitHub read failure');
          }
          return {
            repositoryVisibility: 'public',
            baseRepositoryId: 11,
            headRepositoryId: 99,
            draft: false,
            baseSha: '3333333333333333333333333333333333333333',
            headSha: '4444444444444444444444444444444444444444',
          };
        },
        getCommenterPermission: async () => 'maintain',
      },
      stateStore: createInMemoryReviewStateStore(),
      scheduler: {
        schedule: async (job) => {
          scheduled.push(job);
        },
      },
    });

    const disposition = await coordinator.handleReviewEvent({
      deliveryId: 'delivery-manual-transient-facts',
      event: 'issue_comment',
      action: 'created',
      repositoryId: 11,
      pullRequestNumber: 42,
      installationId: 7,
      commentId: 987658,
      commenterLogin: 'maintainer',
      command: '/ai-review',
    });

    expect(disposition).toBe('scheduled');
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toMatchObject({
      baseSha: '3333333333333333333333333333333333333333',
      headSha: '4444444444444444444444444444444444444444',
      trigger: 'manual',
    });
  });

  it('marks a conclusive missing manual PR with a confused reaction without scheduling', async () => {
    const reactions: unknown[] = [];
    const scheduled: ReviewJob[] = [];
    const coordinator = createReviewCoordinator({
      github: {
        getPullRequest: async () => undefined,
        addReaction: async (input) => {
          reactions.push(input);
        },
      },
      stateStore: createInMemoryReviewStateStore(),
      scheduler: {
        schedule: async (job) => {
          scheduled.push(job);
        },
      },
    });

    const disposition = await coordinator.handleReviewEvent({
      deliveryId: 'delivery-comment-missing',
      event: 'issue_comment',
      action: 'created',
      repositoryId: 11,
      pullRequestNumber: 42,
      installationId: 7,
      commentId: 987663,
      commenterLogin: 'maintainer',
      command: '/ai-review',
    });

    expect(disposition).toBe('awaiting approval');
    expect(scheduled).toEqual([]);
    expect(reactions).toEqual([
      {
        repositoryId: 11,
        installationId: 7,
        commentId: 987663,
        content: 'confused',
      },
    ]);
  });

  it('keeps a scheduled manual run when its eyes reaction is temporarily unavailable', async () => {
    const stateStore = createInMemoryReviewStateStore();
    const scheduled: Array<{ job: ReviewJob; runId: string }> = [];
    const coordinator = createReviewCoordinator({
      github: {
        getPullRequest: async () => ({
          repositoryVisibility: 'public',
          baseRepositoryId: 11,
          headRepositoryId: 99,
          draft: false,
          baseSha: '3333333333333333333333333333333333333333',
          headSha: '4444444444444444444444444444444444444444',
        }),
        getCommenterPermission: async () => 'write',
        addReaction: async () => {
          throw new Error('GitHub feedback unavailable');
        },
      },
      stateStore,
      scheduler: {
        schedule: async (job, runId) => {
          scheduled.push({ job, runId });
        },
      },
    });

    const disposition = await coordinator.handleReviewEvent({
      deliveryId: 'delivery-comment-feedback-retry',
      event: 'issue_comment',
      action: 'created',
      repositoryId: 11,
      pullRequestNumber: 42,
      installationId: 7,
      commentId: 987664,
      commenterLogin: 'maintainer',
      command: '/ai-review',
    });

    expect(disposition).toBe('failed');
    expect(scheduled).toHaveLength(1);
    expect(await stateStore.getRunOutcome(scheduled[0].runId)).toMatchObject({
      status: 'scheduled',
    });
  });

  it('claims a manual review only with approval bound to the current head SHA', async () => {
    const scheduled: ReviewJob[] = [];
    const recordedDeliveries = new Map<string, string>();
    const stateStore: ReviewStateStore = {
      recordDelivery: async ({ deliveryId, status }) => {
        recordedDeliveries.set(deliveryId, status);
      },
      claimReview: async ({ approval }) =>
        approval?.headSha === '4444444444444444444444444444444444444444'
          ? { kind: 'claimed', runId: 'manual-run-1' }
          : { kind: 'existing', disposition: 'awaiting approval' },
      markSchedulingFailed: async () => {},
    };
    const coordinator = createReviewCoordinator({
      github: {
        getPullRequest: async () => ({
          repositoryVisibility: 'public',
          baseRepositoryId: 11,
          headRepositoryId: 99,
          draft: false,
          baseSha: '3333333333333333333333333333333333333333',
          headSha: '4444444444444444444444444444444444444444',
        }),
        getCommenterPermission: async () => 'maintain',
      },
      stateStore,
      scheduler: {
        schedule: async (job) => {
          scheduled.push(job);
        },
      },
    });

    const disposition = await coordinator.handleReviewEvent({
      deliveryId: 'delivery-manual-approval-bound',
      event: 'issue_comment',
      action: 'created',
      repositoryId: 11,
      pullRequestNumber: 42,
      installationId: 7,
      commentId: 987659,
      commenterLogin: 'maintainer',
      command: '/ai-review',
    });

    expect(disposition).toBe('scheduled');
    expect(scheduled).toHaveLength(1);
  });

  it('schedules a public same-repository PR automatically', async () => {
    const scheduled: ReviewJob[] = [];
    const coordinator = createReviewCoordinator({
      github: {},
      stateStore: createInMemoryReviewStateStore(),
      scheduler: {
        schedule: async (job) => {
          scheduled.push(job);
        },
      },
    });

    const disposition = await coordinator.handleReviewEvent({
      ...eligiblePrivatePullRequest,
      deliveryId: 'delivery-public-same-repo',
      repositoryVisibility: 'public',
      baseRepositoryId: 11,
      headRepositoryId: 11,
      baseSha: '7777777777777777777777777777777777777777',
      headSha: '8888888888888888888888888888888888888888',
    });

    expect(disposition).toBe('scheduled');
    expect(scheduled[0]).toMatchObject({
      baseSha: '7777777777777777777777777777777777777777',
      headSha: '8888888888888888888888888888888888888888',
      trigger: 'automatic',
    });
  });

  it('awaits approval for a public fork without scheduling work', async () => {
    const scheduled: ReviewJob[] = [];
    const coordinator = createReviewCoordinator({
      github: {},
      stateStore: createInMemoryReviewStateStore(),
      scheduler: {
        schedule: async (job) => {
          scheduled.push(job);
        },
      },
    });

    const disposition = await coordinator.handleReviewEvent({
      ...eligiblePrivatePullRequest,
      deliveryId: 'delivery-public-fork',
      repositoryVisibility: 'public',
      baseRepositoryId: 11,
      headRepositoryId: 99,
    });

    expect(disposition).toBe('awaiting approval');
    expect(scheduled).toEqual([]);
  });

  it('persists an awaiting-approval outcome before replaying the delivery', async () => {
    const scheduled: ReviewJob[] = [];
    const stateStore = createInMemoryReviewStateStore();
    const coordinator = createReviewCoordinator({
      github: {},
      stateStore,
      scheduler: {
        schedule: async (job) => {
          scheduled.push(job);
        },
      },
    });
    const event = {
      ...eligiblePrivatePullRequest,
      deliveryId: 'delivery-awaiting-replay',
      repositoryVisibility: 'public' as const,
      baseRepositoryId: 11,
      headRepositoryId: 99,
    };

    const first = await coordinator.handleReviewEvent(event);
    const replay = await coordinator.handleReviewEvent({ ...event, headRepositoryId: 11 });

    expect(first).toBe('awaiting approval');
    expect(replay).toBe('awaiting approval');
    expect(scheduled).toEqual([]);
  });

  it('does not schedule when approval facts are denied, missing, or uncertain', async () => {
    for (const permission of ['read', undefined, 'triage']) {
      const scheduled: ReviewJob[] = [];
      const coordinator = createReviewCoordinator({
        github: {
          getPullRequest: async () => ({
            repositoryVisibility: 'public',
            baseRepositoryId: 11,
            headRepositoryId: 99,
            draft: false,
            baseSha: '3333333333333333333333333333333333333333',
            headSha: '4444444444444444444444444444444444444444',
          }),
          getCommenterPermission: async () => permission,
        },
        stateStore: createInMemoryReviewStateStore(),
        scheduler: {
          schedule: async (job) => {
            scheduled.push(job);
          },
        },
      });

      const disposition = await coordinator.handleReviewEvent({
        deliveryId: 'delivery-permission',
        event: 'issue_comment',
        action: 'created',
        repositoryId: 11,
        pullRequestNumber: 42,
        installationId: 7,
        commentId: 987660,
        commenterLogin: 'contributor',
        command: '/ai-review',
      });

      expect(disposition).toBe('awaiting approval');
      expect(scheduled).toEqual([]);
    }
  });

  it('does not reuse an external approval after synchronize', async () => {
    const scheduled: ReviewJob[] = [];
    const coordinator = createReviewCoordinator({
      github: {
        getPullRequest: async () => ({
          repositoryVisibility: 'public',
          baseRepositoryId: 11,
          headRepositoryId: 99,
          draft: false,
          baseSha: '3333333333333333333333333333333333333333',
          headSha: '5555555555555555555555555555555555555555',
        }),
        getCommenterPermission: async () => 'write',
      },
      stateStore: createInMemoryReviewStateStore(),
      scheduler: {
        schedule: async (job) => {
          scheduled.push(job);
        },
      },
    });

    const approval = await coordinator.handleReviewEvent({
      deliveryId: 'delivery-approval',
      event: 'issue_comment',
      action: 'created',
      repositoryId: 11,
      pullRequestNumber: 42,
      installationId: 7,
      commentId: 987661,
      commenterLogin: 'maintainer',
      command: '/ai-review',
    });
    const update = await coordinator.handleReviewEvent({
      ...eligiblePrivatePullRequest,
      deliveryId: 'delivery-synchronize',
      action: 'synchronize',
      repositoryVisibility: 'public',
      baseRepositoryId: 11,
      headRepositoryId: 99,
      headSha: '6666666666666666666666666666666666666666',
    });

    expect(approval).toBe('scheduled');
    expect(update).toBe('awaiting approval');
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].headSha).toBe('5555555555555555555555555555555555555555');
  });

  it('does not schedule a pull request with an empty or malformed SHA', async () => {
    for (const baseSha of ['', 'not-a-github-sha']) {
      const scheduled: ReviewJob[] = [];
      const coordinator = createReviewCoordinator({
        github: {},
        stateStore: createInMemoryReviewStateStore(),
        scheduler: {
          schedule: async (job) => {
            scheduled.push(job);
          },
        },
      });

      const disposition = await coordinator.handleReviewEvent({
        ...eligiblePrivatePullRequest,
        deliveryId: 'delivery-invalid-sha',
        baseSha,
      });

      expect(disposition).toBe('ignored');
      expect(scheduled).toEqual([]);
    }
  });

  it('fails closed when current pull request facts contain an invalid SHA', async () => {
    for (const headSha of ['', 'not-a-github-sha']) {
      const scheduled: ReviewJob[] = [];
      const coordinator = createReviewCoordinator({
        github: {
          getPullRequest: async () => ({
            repositoryVisibility: 'public',
            baseRepositoryId: 11,
            headRepositoryId: 99,
            draft: false,
            baseSha: '3333333333333333333333333333333333333333',
            headSha,
          }),
          getCommenterPermission: async () => 'maintain',
        },
        stateStore: createInMemoryReviewStateStore(),
        scheduler: {
          schedule: async (job) => {
            scheduled.push(job);
          },
        },
      });

      const disposition = await coordinator.handleReviewEvent({
        deliveryId: 'delivery-invalid-facts-sha',
        event: 'issue_comment',
        action: 'created',
        repositoryId: 11,
        pullRequestNumber: 42,
        installationId: 7,
        commentId: 987662,
        commenterLogin: 'maintainer',
        command: '/ai-review',
      });

      expect(disposition).toBe('failed');
      expect(scheduled).toEqual([]);
    }
  });
});
