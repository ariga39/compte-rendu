import { describe, expect, it } from 'vitest';
import {
  createInMemoryReviewStateStore,
  createReviewCoordinator,
  type GitHubAdapter,
} from '../apps/core/src/index';
import type { ReviewEvent } from '../packages/contracts/src';
import { createGitHubPublicationShim } from './support/github-publication-shim';

const eligiblePullRequest: ReviewEvent = {
  deliveryId: 'delivery-shim-1',
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

describe('GitHub publication shim', () => {
  it('delegates read behavior and captures the exact review publication without writing to GitHub', async () => {
    let runId = '';
    const upstreamReviewCalls: unknown[] = [];
    const upstreamReactionCalls: unknown[] = [];
    const upstream: GitHubAdapter = {
      loadReviewTarget: async () => ({ headSha: eligiblePullRequest.headSha }),
      addReaction: async (input) => {
        upstreamReactionCalls.push(input);
        throw new Error('upstream reaction write must not be called');
      },
      createReview: async (input) => {
        upstreamReviewCalls.push(input);
        throw new Error('upstream review write must not be called');
      },
    };
    const shim = createGitHubPublicationShim(upstream);
    const coordinator = createReviewCoordinator({
      github: shim,
      stateStore: createInMemoryReviewStateStore(),
      scheduler: {
        schedule: async (_job, scheduledRunId) => {
          runId = scheduledRunId;
        },
      },
    });
    const body = '## Review:\n\nThe exact probe body.\n';

    expect(await coordinator.handleReviewEvent(eligiblePullRequest)).toBe('scheduled');
    expect(
      await coordinator.completeReview({
        runId,
        output: body,
      }),
    ).toBe('completed');

    expect(shim.capturedReviews).toEqual([
      {
        repositoryId: eligiblePullRequest.repositoryId,
        pullRequestNumber: eligiblePullRequest.pullRequestNumber,
        installationId: eligiblePullRequest.installationId,
        payload: {
          event: 'COMMENT',
          commit_id: eligiblePullRequest.headSha,
          body: `<!-- compte-rendu:run:${runId} -->\n${body}`,
        },
      },
    ]);
    expect(upstreamReviewCalls).toEqual([]);
    expect(upstreamReactionCalls).toEqual([]);
  });

  it('captures coordinator reactions locally', async () => {
    const upstreamReviewCalls: unknown[] = [];
    const upstreamReactionCalls: unknown[] = [];
    const upstream: GitHubAdapter = {
      getPullRequest: async () => ({
        repositoryVisibility: 'public',
        baseRepositoryId: 11,
        headRepositoryId: 99,
        draft: false,
        baseSha: eligiblePullRequest.baseSha,
        headSha: eligiblePullRequest.headSha,
      }),
      getCommenterPermission: async () => 'maintain',
      addReaction: async (input) => {
        upstreamReactionCalls.push(input);
        throw new Error('upstream reaction write must not be called');
      },
      createReview: async (input) => {
        upstreamReviewCalls.push(input);
        throw new Error('upstream review write must not be called');
      },
    };
    const shim = createGitHubPublicationShim(upstream);
    const coordinator = createReviewCoordinator({
      github: shim,
      stateStore: createInMemoryReviewStateStore(),
      scheduler: { schedule: async () => {} },
    });

    expect(
      await coordinator.handleReviewEvent({
        deliveryId: 'delivery-shim-manual',
        event: 'issue_comment',
        action: 'created',
        repositoryId: 11,
        pullRequestNumber: 42,
        installationId: 7,
        commentId: 123,
        commenterLogin: 'maintainer',
        command: '/ai-review',
      }),
    ).toBe('scheduled');

    expect(shim.capturedReactions).toEqual([
      {
        repositoryId: 11,
        installationId: 7,
        commentId: 123,
        content: 'eyes',
      },
    ]);
    expect(upstreamReviewCalls).toEqual([]);
    expect(upstreamReactionCalls).toEqual([]);
  });
});
