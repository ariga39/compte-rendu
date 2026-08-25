import { describe, expect, it } from 'vitest';
import {
  createReviewCoordinator,
  createD1ReviewStateStore,
  createInMemoryReviewStateStore,
  type ReviewJob,
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
      commenterLogin: 'maintainer',
      command: '/ai-review',
    });

    expect(disposition).toBe('scheduled');
    expect(scheduled).toEqual([
      {
        repositoryId: 11,
        pullRequestNumber: 42,
        installationId: 7,
        baseSha: '3333333333333333333333333333333333333333',
        headSha: '4444444444444444444444444444444444444444',
        trigger: 'manual',
      },
    ]);
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

  it('does not schedule when current pull request facts contain an invalid SHA', async () => {
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
        commenterLogin: 'maintainer',
        command: '/ai-review',
      });

      expect(disposition).toBe('awaiting approval');
      expect(scheduled).toEqual([]);
    }
  });
});
