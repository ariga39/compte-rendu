import type { GitHubSha, ReviewDecision, ReviewResetOperation } from '@compte-rendu/contracts';

type GitHubShaValue = typeof GitHubSha.Type;

export class GitHubReviewResetError extends Error {
  constructor(
    readonly operation: ReviewResetOperation,
    readonly status?: number,
  ) {
    super(`GitHub review reset failed during ${operation}`);
  }
}

export interface GitHubAdapter {
  getPullRequest?(input: {
    repositoryId: number;
    pullRequestNumber: number;
    installationId: number;
  }): Promise<unknown>;
  getCommenterPermission?(input: {
    repositoryId: number;
    pullRequestNumber: number;
    installationId: number;
    commenterLogin: string;
  }): Promise<unknown>;
  addReaction?(input: {
    repositoryId: number;
    installationId: number;
    commentId: number;
    content: 'eyes' | 'confused' | '-1';
  }): Promise<void>;
  createIssueComment?(input: {
    repositoryId: number;
    pullRequestNumber: number;
    installationId: number;
    body: string;
  }): Promise<unknown>;
  createCheckRun?(input: {
    repositoryId: number;
    installationId: number;
    headSha: GitHubShaValue;
    runId: string;
  }): Promise<{ readonly id: number }>;
  updateCheckRun?(input: {
    runId: string;
    repositoryId: number;
    installationId: number;
    checkRunId: number;
    status: 'in_progress' | 'success' | 'failure' | 'cancelled';
    decision?: ReviewDecision;
    cancellationReason?: 'manual';
    retryBlocked?: 'cleanup-pending' | 'cleanup-failed';
    retryQueued?: boolean;
  }): Promise<void>;
  findCheckRunForSuite?(input: {
    repositoryId: number;
    installationId: number;
    checkSuiteId: number;
  }): Promise<unknown>;
  getRepositoryUrl?(input: { repositoryId: number; installationId: number }): Promise<unknown>;
  getRepositoryMetadata?(input: {
    repositoryId: number;
    installationId: number;
    signal?: AbortSignal;
  }): Promise<unknown>;
  loadReviewTarget?(input: {
    repositoryId: number;
    pullRequestNumber: number;
    installationId: number;
  }): Promise<unknown>;
  findReviewByMarker?(input: {
    repositoryId: number;
    pullRequestNumber: number;
    installationId: number;
    marker: string;
    expected: { headSha: GitHubShaValue; event: ReviewPublicationPayload['event'] };
  }): Promise<unknown>;
  dismissPreviousReviews?(input: {
    repositoryId: number;
    pullRequestNumber: number;
    installationId: number;
    headSha: GitHubShaValue;
    previousRunIds: readonly string[];
  }): Promise<void | { readonly kind: 'stale'; readonly currentHeadSha: GitHubShaValue }>;
  createReview?(input: {
    repositoryId: number;
    pullRequestNumber: number;
    installationId: number;
    payload: ReviewPublicationPayload;
  }): Promise<ReviewPublicationCreateResult>;
}

export interface ReviewPublicationPayload {
  readonly event: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';
  readonly commit_id: GitHubShaValue;
  readonly body: string;
}

export type ReviewPublicationCreateResult =
  | { readonly kind: 'created'; readonly review: unknown }
  | { readonly kind: 'stale'; readonly currentHeadSha: GitHubShaValue };
