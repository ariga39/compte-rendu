import { describe, expect, it } from 'vitest';
import { createReviewCoordinator, type ReviewJob } from '../apps/core/src/index';
import type { ReviewEvent } from '../packages/contracts/src';

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
  it('schedules an eligible private PR at its exact base and head SHAs', async () => {
    const scheduled: ReviewJob[] = [];
    const coordinator = createReviewCoordinator({
      github: {},
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

  it('schedules a public same-repository PR automatically', async () => {
    const scheduled: ReviewJob[] = [];
    const coordinator = createReviewCoordinator({
      github: {},
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
