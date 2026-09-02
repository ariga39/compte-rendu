import type { GitHubAdapter, ReviewPublicationPayload } from '../../apps/core/src/index.ts';

export type GitHubReadAdapter = Pick<
  GitHubAdapter,
  | 'getPullRequest'
  | 'getCommenterPermission'
  | 'getRepositoryUrl'
  | 'loadReviewTarget'
  | 'findReviewByMarker'
>;

export interface CapturedGitHubReaction {
  readonly repositoryId: number;
  readonly installationId: number;
  readonly commentId: number;
  readonly content: 'eyes' | 'confused' | '-1';
}

export interface CapturedGitHubReview {
  readonly repositoryId: number;
  readonly pullRequestNumber: number;
  readonly installationId: number;
  readonly payload: ReviewPublicationPayload;
}

export interface GitHubPublicationShim extends GitHubAdapter {
  readonly capturedReviews: CapturedGitHubReview[];
  readonly capturedReactions: CapturedGitHubReaction[];
}

export const createGitHubPublicationShim = (
  readAdapter: GitHubReadAdapter,
): GitHubPublicationShim => {
  const capturedReviews: CapturedGitHubReview[] = [];
  const capturedReactions: CapturedGitHubReaction[] = [];

  return {
    ...(readAdapter.getPullRequest === undefined
      ? {}
      : { getPullRequest: readAdapter.getPullRequest }),
    ...(readAdapter.getCommenterPermission === undefined
      ? {}
      : { getCommenterPermission: readAdapter.getCommenterPermission }),
    ...(readAdapter.getRepositoryUrl === undefined
      ? {}
      : { getRepositoryUrl: readAdapter.getRepositoryUrl }),
    ...(readAdapter.loadReviewTarget === undefined
      ? {}
      : { loadReviewTarget: readAdapter.loadReviewTarget }),
    ...(readAdapter.findReviewByMarker === undefined
      ? {}
      : { findReviewByMarker: readAdapter.findReviewByMarker }),
    addReaction: async (input) => {
      capturedReactions.push({ ...input });
    },
    createReview: async ({ repositoryId, pullRequestNumber, installationId, payload }) => {
      const capturedReview: CapturedGitHubReview = {
        repositoryId,
        pullRequestNumber,
        installationId,
        payload: { ...payload },
      };
      capturedReviews.push(capturedReview);
      return { kind: 'created', review: capturedReview };
    },
    capturedReviews,
    capturedReactions,
  };
};
