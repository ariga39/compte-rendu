import { createTestReviewStore } from './support/review-store';
import { describe, expect, it } from 'vitest';
import type { GitHubAdapter } from '../apps/core/src/index';
import { createReviewCoordinator } from './support/review-coordinator';
import type { ReviewEvent } from '../packages/contracts/src';
import { createGitHubPublicationShim } from './support/github-publication-shim';
import { REVIEW_PUBLICATION_FOOTER } from './support/review-publication';

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
    const stateStore = createTestReviewStore();
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
      stateStore,
    });
    const body = '## Review:\n\nThe exact probe body.\n';

    expect(await coordinator.handleReviewEvent(eligiblePullRequest)).toBe('scheduled');
    const runId = await stateStore.runIdForDelivery(eligiblePullRequest.deliveryId);
    if (runId === undefined) throw new Error('run was not persisted');
    expect(
      await coordinator.completeReview({
        runId,
        output: { version: 2, decision: 'comment', markdown: body },
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
          body: `<!-- compte-rendu:run:${runId} -->\n${body}${REVIEW_PUBLICATION_FOOTER}`,
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
      stateStore: createTestReviewStore(),
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
