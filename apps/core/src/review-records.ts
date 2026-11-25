import { Schema, type Effect } from 'effect';
import { GitHubSha, ReviewConfiguration, type ReviewDecision } from '@compte-rendu/contracts';

type GitHubShaValue = typeof GitHubSha.Type;

export const ReviewTrigger = Schema.Literals(['automatic', 'manual']);

export const ReviewJob = Schema.Struct({
  reviewConfiguration: Schema.optional(ReviewConfiguration),
  repositoryId: Schema.Int,
  pullRequestNumber: Schema.Int,
  installationId: Schema.Int,
  baseSha: GitHubSha,
  headSha: GitHubSha,
  trigger: ReviewTrigger,
  commentId: Schema.optional(Schema.Int),
  repositoryVisibility: Schema.optional(Schema.Literals(['private', 'public'])),
  baseRef: Schema.optional(Schema.NonEmptyString),
  headRef: Schema.optional(Schema.NonEmptyString),
});

export type ReviewJob = typeof ReviewJob.Type;
export type ReviewDisposition =
  | 'rejected'
  | 'ignored'
  | 'awaiting approval'
  | 'scheduled'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type ReviewRunStatus = 'scheduled' | 'failed' | 'completed' | 'superseded' | 'cancelled';
export type ReviewStoredStatus = ReviewDisposition | ReviewRunStatus | 'claiming';
export type ReviewCheckSetupStatus = 'pending' | 'ready' | 'failed';
export type RunnerCleanupStatus = 'pending' | 'destroyed' | 'failed';

export interface ReviewOutcome {
  decision?: ReviewDecision;
  deliveryId: string;
  installationId: number;
  repositoryId: number;
  pullRequestNumber: number;
  baseSha: GitHubShaValue | null;
  headSha: GitHubShaValue | null;
  trigger: ReviewJob['trigger'];
  status: ReviewStoredStatus;
  createdAt: string;
  updatedAt: string;
  claimedAt?: string;
  publicationClaimedAt?: string;
  runnerJobId?: string;
  runnerAttempt?: number;
  commentId?: number;
  checkRunId?: number;
  resultReceivedAt?: string;
  cleanup?: RunnerCleanupStatus;
  evidence?: ReviewEvidenceMetadata;
}

export interface ReviewEvidenceMetadata {
  readonly key: string;
  readonly status: 'complete' | 'incomplete';
  readonly size: number;
  readonly sha256: string;
  readonly uploadedAt: string;
  readonly executionStartedAt?: string;
  readonly submissionCompletedAt?: string;
  readonly cleanupCompletedAt?: string;
}

export interface ReviewDeliveryRecord {
  deliveryId: string;
  installationId: number;
  repositoryId: number;
  pullRequestNumber: number;
  baseSha: GitHubShaValue | null;
  headSha: GitHubShaValue | null;
  trigger: ReviewJob['trigger'];
  status: ReviewDisposition;
  occurredAt: string;
}

export interface ReviewApproval {
  installationId: number;
  repositoryId: number;
  pullRequestNumber: number;
  baseSha: GitHubShaValue;
  headSha: GitHubShaValue;
}

export interface ActiveRunnerJob {
  readonly claimedAt?: string;
  readonly runId: string;
  readonly jobId: string;
}

export type CancelRunnerJob = (jobId: string, claimedAt?: string) => Promise<void | 'pending'>;

export type ReviewCheckSetupDefer = (task: Effect.Effect<void>) => void;
