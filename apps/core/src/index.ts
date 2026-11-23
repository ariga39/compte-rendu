import type { ModelUsageSummary } from '@compte-rendu/contracts';
import type { PublicTaskFailure } from '@compte-rendu/contracts';
import { DateTime, Effect, Option, Schema } from 'effect';
import {
  REVIEW_ATTEMPT_BUDGET_MS,
  PullRequestFacts,
  ReviewConfiguration,
  ReviewEvent,
  RunnerReviewResult,
  type ReviewDecision,
  type RunnerProgressMilestone,
  GitHubSha,
  type PullRequestFacts as PullRequestFactsType,
  type OperationalLog,
  type OperationalLogEvent,
  sanitizeOperationalLogEvent,
} from '@compte-rendu/contracts';
import type { RunnerJobBinding } from './runner-job-client';
import {
  formatReviewFailureComment,
  formatReviewPublicationMarker,
  formatReviewPublicationPayload,
} from './review-publication-format.ts';

export { createRunnerJobClient, type RunnerJobBinding } from './runner-job-client';
export { createGitHubPublicationAdapter } from './github-review-adapter';
export type { GitHubPublicationAdapterOptions } from './github-review-adapter';
export { createGitHubAppTokenProvider } from './github-app-token';
export type { GitHubAppTokenProvider, GitHubAppTokenProviderOptions } from './github-app-token';

type GitHubShaValue = typeof GitHubSha.Type;

export {
  createD1ReviewStateStore,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
  type D1ResultLike,
  type D1ReviewStateStore,
} from './review-state-store';

const ReviewTrigger = Schema.Literals(['automatic', 'manual']);

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
const CoreLifecycleIdentifier = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9._:-]{1,128}$/)),
);
const CoreLifecycleMilliseconds = Schema.Natural;
export const CoreLifecycleFailureReason = Schema.Literals([
  'upstream',
  'checkout',
  'sandbox',
  'agent',
  'timeout',
  'invalid_output',
  'evidence',
  'cleanup',
  'callback',
  'marker_lookup_failed',
  'publication_uncertain',
  'completion_failed',
  'review_reset_failed',
  'configuration',
  'unknown',
]);
export type CoreLifecycleFailureReason = typeof CoreLifecycleFailureReason.Type;
const CoreLifecycleCommon = {
  runId: CoreLifecycleIdentifier,
  trigger: ReviewTrigger,
} as const;
const CoreLifecycleFinishedCommon = {
  event: Schema.Literal('review finished'),
  ...CoreLifecycleCommon,
  totalDurationMs: CoreLifecycleMilliseconds,
  queueWaitMs: Schema.optional(CoreLifecycleMilliseconds),
  cleanupStatus: Schema.Literals(['destroyed', 'failed', 'unknown']),
  evidenceStatus: Schema.Literals(['complete', 'incomplete', 'unknown']),
} as const;
const CoreLifecycleFailurePhase = Schema.Literals([
  'admission',
  'scheduling',
  'checkout',
  'sandbox',
  'agent',
  'output_validation',
  'evidence',
  'callback',
  'publication',
  'cleanup',
  'unknown',
]);
export const CoreLifecycleEvent = Schema.Union([
  Schema.Struct({
    event: Schema.Literal('review scheduled'),
    ...CoreLifecycleCommon,
  }),
  Schema.Struct({
    event: Schema.Literal('review claimed'),
    ...CoreLifecycleCommon,
    queueWaitMs: CoreLifecycleMilliseconds,
  }),
  Schema.Struct({
    ...CoreLifecycleFinishedCommon,
    outcome: Schema.Literal('completed'),
    published: Schema.Literal(true),
  }),
  Schema.Struct({
    ...CoreLifecycleFinishedCommon,
    outcome: Schema.Literal('superseded'),
    published: Schema.Literal(false),
  }),
  Schema.Struct({
    ...CoreLifecycleFinishedCommon,
    outcome: Schema.Literal('cancelled'),
    published: Schema.Literal(false),
  }),
  Schema.Struct({
    ...CoreLifecycleFinishedCommon,
    outcome: Schema.Literal('failed'),
    published: Schema.Literal(false),
    failurePhase: CoreLifecycleFailurePhase,
    failureReason: CoreLifecycleFailureReason,
  }),
]);
export type CoreLifecycleEvent = typeof CoreLifecycleEvent.Type;

export interface CoreLifecycleLog {
  readonly record: (event: CoreLifecycleEvent) => void;
}
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

export type RepositoryVisibility = 'public' | 'private' | 'unknown';
export interface ReviewCleanupRecovery {
  readonly runId: string;
  readonly jobId: string;
  readonly attempt: number;
  readonly evidenceId: string;
  readonly baseSha: GitHubShaValue;
  readonly headSha: GitHubShaValue;
  readonly sandboxName: string;
  readonly confirmedAt: string;
}

export type ReviewCleanupRecoveryResult =
  | { readonly kind: 'recovered'; readonly cleanupCompletedAt: string }
  | { readonly kind: 'already'; readonly cleanupCompletedAt: string }
  | { readonly kind: 'rejected' };

export interface RepositoryMetadataRow {
  installationId: number;
  repositoryId: number;
  fullName: string | null;
  visibility: RepositoryVisibility;
  verifiedAt: string | null;
  identityExpiresAt: string | null;
  nextRefreshAt: string | null;
  revision: number;
  updatedAt: string;
}

export type PublicRunStatusValue =
  | 'scheduled'
  | 'completed'
  | 'failed'
  | 'superseded'
  | 'cancelled';

export interface PublicRunRow {
  modelUsage?: string | null;
  decision: ReviewDecision | null;
  runId: string;
  status: PublicRunStatusValue;
  installationId: number;
  repositoryId: number;
  pullRequestNumber: number;
  baseSha: GitHubShaValue | null;
  headSha: GitHubShaValue | null;
  baseRef: string | null;
  headRef: string | null;
  createdAt: string;
  claimedAt: string | null;
  terminalAt: string | null;
  executionStartedAt: string | null;
  submissionCompletedAt: string | null;
  cleanupCompletedAt: string | null;

  resultReceivedAt: string | null;
  publicationStartedAt: string | null;
  failurePhase: string | null;
  failureReason: string | null;
  failureHttpStatus: number | null;
  runnerJobId: string | null;
  runnerCleanupStatus: 'pending' | 'destroyed' | 'failed' | null;
  queueBlockReason: 'cleanup' | null;
  progressStage: 'checkout' | 'sandbox' | 'agent' | 'evidence' | 'cleanup' | null;
  lastProgressAt: string | null;
  progressMilestones: string | null;
  repositoryVisibilitySnapshot: 'private' | 'public' | null;
  legacyPublicVerifiedAt: string | null;
  repositoryFullName: string | null;
  repositoryVisibility: RepositoryVisibility;
  identityExpiresAt: string | null;
}

export interface PublicOverviewCounts {
  queued: number;
  claimed: number;
  publishedLast24h: number;
  failedLast24h: number;
  cancelledLast24h: number;
  cleanupAttention: number;
}

export interface PublicRunCursor {
  priority: number;
  createdAt: string;
  runId: string;
}

export interface PublicRunFilter {
  status:
    | 'all'
    | 'active'
    | 'queued'
    | 'in_progress'
    | 'published'
    | 'failed'
    | 'superseded'
    | 'cancelled';
  cleanup: 'all' | 'pending' | 'destroyed' | 'failed' | 'unknown';
  from?: string;
  to?: string;
}

export type PublicRunView = 'history' | 'current' | 'cleanup';

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

export interface ReviewCancellationState {
  readonly runId: string;
  readonly requestedAt: string;
  readonly requestedByUid: number;
  readonly runnerJobId: string | null;
  readonly runnerAttempt: number | null;
  readonly cleanup: RunnerCleanupStatus | null;
  readonly checkRunId: number | null;
}

export type ReviewCancellationResult =
  | { readonly kind: 'cancelled'; readonly cancellation: ReviewCancellationState }
  | { readonly kind: 'already_cancelled'; readonly cancellation: ReviewCancellationState }
  | {
      readonly kind: 'conflict';
      readonly runId: string;
      readonly status: ReviewRunStatus;
      readonly publicationClaimed: boolean;
    }
  | { readonly kind: 'not_found'; readonly runId: string };

export interface ReviewCheckDeliveryWorkItem {
  readonly runId: string;
  readonly checkRunId: number;
}

export interface ReviewCancellationWorkItem {
  readonly runId: string;
  readonly cancelledAt: string;
  readonly claimedAt: string | null;
  readonly runnerJobId: string | null;
  readonly runnerAttempt: number | null;
  readonly runnerCleanupStatus: RunnerCleanupStatus | null;
  readonly runnerStopAttemptedAt: string | null;
  readonly checkRunId: number | null;
  readonly checkCancelAttemptedAt: string | null;
  readonly needsRunnerStop: boolean;
  readonly needsCheckReconciliation: boolean;
  readonly cleanupBlocked: boolean;
  readonly recoveryRequired: boolean;
}

export interface ReviewStateStore {
  claimReview(input: {
    deliveryId: string;
    job: ReviewJob;
    occurredAt: string;
    approval?: ReviewApproval;
  }): Promise<
    | {
        kind: 'claimed';
        runId: string;
        activeRunnerJob?: ActiveRunnerJob;
        supersededRunIds?: readonly string[];
      }
    | {
        kind: 'replay';
        disposition: ReviewDisposition;
        runId?: string;
        checkSetupStatus?: ReviewCheckSetupStatus;
        activeRunnerJob?: ActiveRunnerJob;
      }
    | {
        kind: 'existing';
        disposition: ReviewDisposition;
        runId?: string;
        checkSetupStatus?: ReviewCheckSetupStatus;
        activeRunnerJob?: ActiveRunnerJob;
      }
  >;
  claimNextJob(input: {
    jobId: string;
    requestId?: string;
    attempt: number;
    occurredAt: string;
  }): Promise<
    | {
        kind: 'claimed';
        replay?: true;
        runId: string;
        jobId: string;
        attempt: number;
        claimedAt: string;
        job: ReviewJob;
      }
    | { kind: 'empty' }
    | { kind: 'preparing'; runId: string; jobId: string; claimedAt: string }
  >;
  expireClaimHandoff?(
    runId: string,
    jobId: string,
    attempt: number,
    occurredAt: string,
  ): Promise<boolean>;
  markClaimPrepared?(runId: string, jobId: string, attempt: number): Promise<boolean>;
  markSchedulingFailed(input: {
    failure?: PublicTaskFailure;
    runId: string;
    occurredAt: string;
    releaseRunnerClaim?: { jobId: string; attempt: number };
  }): Promise<boolean>;
  recordDelivery: (input: ReviewDeliveryRecord) => Promise<void>;
}

export interface ReviewStateQueries {
  claimStalledPublications?(before: string, now: string, limit: number): Promise<readonly string[]>;
  listPriorReviewRunIds?(runId: string): Promise<readonly string[]>;
  recordEvidence(input: {
    runId: string;
    evidence: ReviewEvidenceMetadata;
    sandboxCleanup?: RunnerCleanupStatus;
  }): Promise<boolean>;
  validateRunnerCleanupRecovery?(
    input: ReviewCleanupRecovery,
  ): Promise<
    | { readonly kind: 'recoverable' }
    | { readonly kind: 'already'; readonly cleanupCompletedAt: string }
    | { readonly kind: 'rejected' }
  >;
  recoverRunnerCleanup?(input: ReviewCleanupRecovery): Promise<ReviewCleanupRecoveryResult>;
  clearRunnerJob?(input: { runId: string; jobId: string }): Promise<boolean>;
  claimCheckSetup?(input: {
    runId: string;
    claimedAt: string;
    staleBefore: string;
  }): Promise<boolean>;
  recordCheckRun?(input: {
    runId: string;
    checkRunId: number;
    setupClaim?: string;
  }): Promise<boolean>;
  markCheckSetupFailed?(input: { runId: string; setupClaim?: string }): Promise<boolean>;
  claimCheckDelivery?(input: {
    runId: string;
    checkRunId: number;
    occurredAt: string;
    reopen?: boolean;
  }): Promise<boolean>;
  confirmCheckDelivery?(input: {
    runId: string;
    checkRunId: number;
    occurredAt: string;
  }): Promise<boolean>;
  listPendingCheckDeliveries?(input: {
    limit: number;
  }): Promise<readonly ReviewCheckDeliveryWorkItem[]>;
  markRunCompleted(input: { runId: string; occurredAt: string }): Promise<boolean>;
  markRunSuperseded(input: {
    runId: string;
    occurredAt: string;
    releaseRunnerClaim?: { jobId: string; attempt: number };
  }): Promise<boolean>;
  cancelRun(input: {
    runId: string;
    requestedByUid: number;
    occurredAt: string;
  }): Promise<ReviewCancellationResult>;
  listCancellationWork?(input: {
    runId?: string;
    retryBefore: string;
    recoveryBefore: string;
    limit: number;
  }): Promise<readonly ReviewCancellationWorkItem[]>;
  recordRunnerStopAttempt?(input: {
    runId: string;
    jobId: string;
    attempt: number;
    occurredAt: string;
    expectedLastAttempt: string | null;
  }): Promise<boolean>;
  confirmRunnerDestroyed?(input: {
    expectedStatus?: ReviewOutcome['status'];
    runId: string;
    jobId: string;
    attempt: number;
    occurredAt: string;
  }): Promise<boolean>;
  recordCheckCancellationAttempt?(input: {
    runId: string;
    checkRunId: number;
    occurredAt: string;
    expectedLastAttempt: string | null;
  }): Promise<boolean>;
  confirmCheckCancelled?(input: {
    runId: string;
    checkRunId: number;
    occurredAt: string;
  }): Promise<boolean>;
  reopenCheckCancellation?(input: { runId: string; checkRunId: number }): Promise<boolean>;
  completeRunPublication(input: {
    runId: string;
    occurredAt: string;
    decision?: ReviewDecision;
  }): Promise<boolean>;
  recordResultReceived?(input: {
    runId: string;
    jobId: string;
    attempt: number;
    occurredAt: string;
  }): Promise<boolean>;
  claimRunPublication?(input: {
    runId: string;
    occurredAt: string;
    publishing?: boolean;
  }): Promise<boolean>;
  releaseRunPublicationClaim?(input: { runId: string; occurredAt: string }): Promise<boolean>;
  getDeliveryOutcome(deliveryId: string): Promise<ReviewOutcome | undefined>;
  getRunOutcome(runId: string): Promise<ReviewOutcome | undefined>;
  getPublicOverview?(input: {
    since: string;
    limit: number;
  }): Promise<{ counts: PublicOverviewCounts; rows: readonly PublicRunRow[] }>;
  listPublicRuns?(input: {
    limit: number;
    cursor?: PublicRunCursor;
    filter: PublicRunFilter;
    view: PublicRunView;
  }): Promise<readonly PublicRunRow[]>;
  getPublicRun?(runId: string): Promise<PublicRunRow | undefined>;
  recordProgress?(input: {
    runId: string;
    jobId: string;
    attempt: number;
    receivedAt: string;
    sequence: number;
    stage: 'checkout' | 'sandbox' | 'agent' | 'evidence' | 'cleanup';
    milestones: readonly RunnerProgressMilestone[];
  }): Promise<boolean>;
  recordModelUsage?(input: {
    runId: string;
    jobId: string;
    attempt: number;
    usage: ModelUsageSummary;
  }): Promise<boolean>;
  recordTerminalLifecycle?(input: {
    runId: string;
    jobId: string;
    attempt: number;
    receivedAt: string;
    sequence: number;
    stage: 'checkout' | 'sandbox' | 'agent' | 'evidence' | 'cleanup';
    milestones: readonly RunnerProgressMilestone[];
  }): Promise<boolean>;
  listDueRepositoryMetadata?(input: {
    now: string;
    limit: number;
  }): Promise<readonly RepositoryMetadataRow[]>;
  claimRepositoryRefresh?(input: {
    installationId: number;
    repositoryId: number;
    expectedRevision: number;
    claimedAt: string;
    staleBefore: string;
  }): Promise<boolean>;
  recordRepositoryRefresh?(input: {
    installationId: number;
    repositoryId: number;
    expectedRevision: number;
    claimedAt: string;
    fullName: string;
    visibility: 'public' | 'private';
    verifiedAt: string;
    identityExpiresAt: string | null;
    nextRefreshAt: string;
    updatedAt: string;
  }): Promise<boolean>;
  deferRepositoryRefresh?(input: {
    installationId: number;
    repositoryId: number;
    expectedRevision: number;
    claimedAt: string;
    nextRefreshAt: string;
    updatedAt: string;
  }): Promise<boolean>;
  invalidateRepositoryMetadata?(input: {
    installationId: number;
    repositoryId: number;
    visibility: 'private' | 'unknown';
    expectedRevision?: number;
    updatedAt: string;
    nextRefreshAt: string;
  }): Promise<boolean>;
  invalidateRepositoryMetadataBatch?(input: {
    installationId: number;
    repositoryIds: readonly number[];
    visibility: 'private' | 'unknown';
    updatedAt: string;
    nextRefreshAt: string;
  }): Promise<number>;
  getRepositoryRefreshBacklog?(input: {
    now: string;
  }): Promise<{ due: number; oldestDueAt: string | null }>;
  getRefreshCooldown?(): Promise<string | undefined>;
  setRefreshCooldown?(input: { nextAllowedAt: string }): Promise<void>;
}

export type ReviewPublicationStateStore = ReviewStateStore & ReviewStateQueries;

export type CancelRunnerJob = (jobId: string, claimedAt?: string) => Promise<void | 'pending'>;

export type ReviewCheckSetupDefer = (task: Promise<void>) => void;

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
    verifyPublication?: boolean;
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

export interface ReviewCoordinator {
  handleReviewEvent(event: unknown): Promise<ReviewDisposition>;
  completeReview(input: {
    runId: string;
    output: unknown;
    reconcileClaimedAt?: string;
  }): Promise<ReviewDisposition>;
}

export interface CoreEnv {
  readonly RUNNER: RunnerJobBinding;
  readonly RUNNER_AUTH_TOKEN: string;
}

class InvalidReviewEvent extends Schema.TaggedError<InvalidReviewEvent>()('InvalidReviewEvent', {
  message: Schema.String,
}) {}

class SchedulingFailed extends Schema.TaggedError<SchedulingFailed>()('SchedulingFailed', {
  message: Schema.String,
}) {}

class ReviewResetFailed extends Schema.TaggedError<ReviewResetFailed>()('ReviewResetFailed', {}) {}

export const resetPreviousReviewVerdicts = Effect.fn('resetPreviousReviewVerdicts')(function* (
  github: GitHubAdapter,
  stateStore: ReviewCompletionStateStore,
  runId: string,
  job: ReviewJob,
) {
  if (github.dismissPreviousReviews === undefined) return;
  return yield* Effect.tryPromise({
    try: async () => {
      if (stateStore.listPriorReviewRunIds === undefined)
        throw new Error('Review history unavailable');
      const previousRunIds = await stateStore.listPriorReviewRunIds(runId);
      if (previousRunIds.length === 0) return;
      return await github.dismissPreviousReviews!({
        repositoryId: job.repositoryId,
        pullRequestNumber: job.pullRequestNumber,
        installationId: job.installationId,
        headSha: job.headSha,
        previousRunIds,
      });
    },
    catch: () => new ReviewResetFailed(),
  }).pipe(Effect.retry({ times: 1 }));
});

const CommenterPermission = Schema.Literals([
  'none',
  'read',
  'triage',
  'write',
  'maintain',
  'admin',
]);

const isAutomaticEligible = (event: Extract<ReviewEvent, { event: 'pull_request' }>) =>
  !event.draft &&
  (event.repositoryVisibility === 'private' ||
    (event.repositoryVisibility === 'public' && event.baseRepositoryId === event.headRepositoryId));

const jobForEvent = (
  event: Extract<ReviewEvent, { event: 'pull_request' }>,
  trigger: ReviewJob['trigger'],
): ReviewJob => ({
  repositoryId: event.repositoryId,
  pullRequestNumber: event.pullRequestNumber,
  installationId: event.installationId,
  baseSha: event.baseSha,
  headSha: event.headSha,
  trigger,
  repositoryVisibility: event.repositoryVisibility,
  baseRef: event.baseRef,
  headRef: event.headRef,
});

const currentIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

const recordOperationalLog = (log: OperationalLog | undefined, event: OperationalLogEvent) =>
  log === undefined
    ? Effect.succeed(undefined)
    : Effect.tryPromise({
        try: async () => {
          await log.record(sanitizeOperationalLogEvent(event));
        },
        catch: () => undefined,
      }).pipe(Effect.catch(() => Effect.succeed(undefined)));

const recordLifecycleLog = (log: CoreLifecycleLog | undefined, event: CoreLifecycleEvent) =>
  Effect.sync(() => {
    if (log === undefined) return;
    try {
      log.record(event);
    } catch {
      // Lifecycle capture is best effort and cannot affect product behavior.
    }
  });

const recordSupersededLifecycle = (
  log: CoreLifecycleLog | undefined,
  runId: string,
  outcome: ReviewOutcome,
  finishedAt: string,
  cleanupStatus: 'destroyed' | 'unknown',
) => {
  const created = DateTime.make(outcome.createdAt);
  const finished = DateTime.make(finishedAt);
  const totalDurationMs =
    Option.isSome(created) && Option.isSome(finished)
      ? Math.max(0, finished.value.epochMilliseconds - created.value.epochMilliseconds)
      : 0;
  return recordLifecycleLog(log, {
    event: 'review finished',
    runId,
    trigger: outcome.trigger,
    outcome: 'superseded',
    published: false,
    totalDurationMs,
    cleanupStatus,
    evidenceStatus: 'unknown',
  });
};

const ReviewPublicationTarget = Schema.Struct({
  headSha: GitHubSha,
});

const ReviewPublicationCreateResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('created'), review: Schema.Unknown }),
  Schema.Struct({ kind: Schema.Literal('stale'), currentHeadSha: GitHubSha }),
]);

type ReviewPublicationTarget = typeof ReviewPublicationTarget.Type;

export type ClaimHeadStatus = 'current' | 'stale' | 'unavailable';

export const claimHeadStatus = Effect.fn('claimHeadStatus')(function* (
  github: GitHubAdapter,
  job: ReviewJob,
) {
  // Without the lookup the claim cannot establish freshness, so it must fail
  // closed. The deployed adapter always provides it.
  if (github.loadReviewTarget === undefined) return 'unavailable' as const;
  return yield* Effect.tryPromise({
    try: async () => {
      const value = await github.loadReviewTarget!({
        repositoryId: job.repositoryId,
        pullRequestNumber: job.pullRequestNumber,
        installationId: job.installationId,
      });
      const target = Schema.decodeUnknownOption(ReviewPublicationTarget)(value);
      if (Option.isNone(target)) return 'unavailable' as const;
      return target.value.headSha === job.headSha ? ('current' as const) : ('stale' as const);
    },
    catch: () => 'unavailable' as const,
  }).pipe(Effect.catch(() => Effect.succeed('unavailable' as const)));
});

type ReviewCompletionStateStore = ReviewStateStore & Partial<ReviewStateQueries>;

type PublicationTerminal =
  | { readonly outcome: 'published' }
  | { readonly outcome: 'superseded' }
  | {
      readonly outcome: 'failed';
      readonly reason: Extract<
        OperationalLogEvent,
        { readonly phase: 'publication'; readonly outcome: 'failed' }
      >['reason'];
    };

const recordPublicationTerminal = (
  log: OperationalLog | undefined,
  runId: string,
  terminal: PublicationTerminal,
) =>
  terminal.outcome === 'failed'
    ? recordOperationalLog(log, {
        phase: 'publication',
        outcome: 'failed',
        runId,
        reason: terminal.reason,
      })
    : recordOperationalLog(log, { phase: 'publication', outcome: terminal.outcome, runId });

const completeReviewEffect = Effect.fn('completeReview')(function* (
  input: { runId: string; output: unknown; reconcileClaimedAt?: string },
  github: GitHubAdapter,
  stateStore: ReviewCompletionStateStore,
  log: OperationalLog | undefined,
) {
  if (stateStore.getRunOutcome === undefined || stateStore.markRunCompleted === undefined) {
    yield* recordPublicationTerminal(log, input.runId, {
      outcome: 'failed',
      reason: 'completion_failed',
    });
    return 'failed' as const;
  }

  let occurredAt = yield* currentIso;
  const getRunOutcome = stateStore.getRunOutcome;
  const markRunCompleted = stateStore.markRunCompleted;
  if (getRunOutcome === undefined || markRunCompleted === undefined) {
    yield* recordPublicationTerminal(log, input.runId, {
      outcome: 'failed',
      reason: 'completion_failed',
    });
    return 'failed' as const;
  }
  let decision: ReviewDecision | undefined;
  const completeRun = Effect.fn('completeRun')(function* () {
    const completedAt = yield* currentIso;
    return yield* Effect.tryPromise({
      try: () =>
        stateStore.completeRunPublication === undefined
          ? markRunCompleted({ runId: input.runId, occurredAt: completedAt })
          : stateStore.completeRunPublication({
              runId: input.runId,
              occurredAt: completedAt,
              decision,
            }),
      catch: () => undefined,
    }).pipe(Effect.catch(() => Effect.succeed(false)));
  });
  const outcome = yield* Effect.tryPromise({
    try: () => getRunOutcome(input.runId),
    catch: () => undefined,
  }).pipe(Effect.catch(() => Effect.succeed(undefined)));

  if (outcome === undefined) {
    yield* recordPublicationTerminal(log, input.runId, {
      outcome: 'failed',
      reason: 'completion_failed',
    });
    return 'failed' as const;
  }
  if (
    input.reconcileClaimedAt !== undefined &&
    (outcome.status !== 'scheduled' || outcome.publicationClaimedAt !== input.reconcileClaimedAt)
  )
    return 'ignored' as const;
  if (outcome.status === 'cancelled') return 'cancelled' as const;
  const updateCheck = Effect.fn('updateReviewCheck')(function* () {
    if (outcome.checkRunId === undefined || github.updateCheckRun === undefined) return;
    const checkOccurredAt = yield* currentIso;
    yield* Effect.tryPromise({
      try: () =>
        publishTerminalCheck({
          github,
          stateStore,
          runId: input.runId,
          occurredAt: checkOccurredAt,
        }),
      catch: () => undefined,
    }).pipe(Effect.catch(() => Effect.succeed(undefined)));
  });
  const claimFailureNotification = Effect.fn('claimFailureNotification')(function* () {
    if (stateStore.claimRunPublication === undefined) return false;
    return yield* Effect.tryPromise({
      try: () => stateStore.claimRunPublication!({ runId: input.runId, occurredAt }),
      catch: () => false,
    }).pipe(Effect.catch(() => Effect.succeed(false)));
  });
  const publishFailureNotification = Effect.fn('publishFailureNotification')(function* (
    claimed: boolean,
  ) {
    if (!claimed) return;
    yield* updateCheck();
    if (github.createIssueComment === undefined) return;
    const created = yield* Effect.tryPromise({
      try: async () => {
        await github.createIssueComment!({
          repositoryId: outcome.repositoryId,
          pullRequestNumber: outcome.pullRequestNumber,
          installationId: outcome.installationId,
          body: formatReviewFailureComment(input.runId),
        });
        return true;
      },
      catch: () => false,
    }).pipe(Effect.catch(() => Effect.succeed(false)));
    if (!created && stateStore.releaseRunPublicationClaim !== undefined) {
      yield* Effect.tryPromise({
        try: () => stateStore.releaseRunPublicationClaim!({ runId: input.runId, occurredAt }),
        catch: () => false,
      }).pipe(Effect.catch(() => Effect.succeed(false)));
    }
  });
  if (outcome.status === 'completed') {
    yield* recordPublicationTerminal(log, input.runId, { outcome: 'published' });
    return 'completed' as const;
  }
  if (outcome.status === 'superseded') {
    if (
      outcome.trigger === 'manual' &&
      outcome.commentId !== undefined &&
      github.addReaction !== undefined
    ) {
      yield* Effect.tryPromise({
        try: () =>
          github.addReaction!({
            repositoryId: outcome.repositoryId,
            installationId: outcome.installationId,
            commentId: outcome.commentId!,
            content: 'confused',
          }),
        catch: () => undefined,
      }).pipe(Effect.catch(() => Effect.succeed(undefined)));
    }
    yield* updateCheck();
    yield* recordPublicationTerminal(log, input.runId, { outcome: 'superseded' });
    return 'ignored' as const;
  }
  if (outcome.status === 'failed') {
    if (
      outcome.trigger === 'manual' &&
      outcome.commentId !== undefined &&
      github.addReaction !== undefined
    ) {
      yield* Effect.tryPromise({
        try: () =>
          github.addReaction!({
            repositoryId: outcome.repositoryId,
            installationId: outcome.installationId,
            commentId: outcome.commentId!,
            content: '-1',
          }),
        catch: () => undefined,
      }).pipe(Effect.catch(() => Effect.succeed(undefined)));
    }
    const notificationClaimed = yield* claimFailureNotification();
    yield* publishFailureNotification(notificationClaimed);
    yield* recordPublicationTerminal(log, input.runId, {
      outcome: 'failed',
      reason: 'completion_failed',
    });
    return 'failed' as const;
  }
  if (outcome.status !== 'scheduled') {
    yield* recordPublicationTerminal(log, input.runId, {
      outcome: 'failed',
      reason: 'completion_failed',
    });
    return 'failed' as const;
  }

  let ownsPublication = false;

  const manualReaction = (content: '-1' | 'confused') =>
    outcome.trigger !== 'manual' ||
    outcome.commentId === undefined ||
    github.addReaction === undefined
      ? Effect.succeed(undefined)
      : Effect.tryPromise({
          try: () =>
            github.addReaction!({
              repositoryId: outcome.repositoryId,
              installationId: outcome.installationId,
              commentId: outcome.commentId!,
              content,
            }),
          catch: () => undefined,
        }).pipe(Effect.catch(() => Effect.succeed(undefined)));
  const latestOutcome = Effect.tryPromise({
    try: () => getRunOutcome(input.runId),
    catch: () => undefined,
  }).pipe(Effect.catch(() => Effect.succeed(undefined)));
  const cancellationWon = latestOutcome.pipe(
    Effect.map((latest) => latest?.status === 'cancelled'),
  );
  const markCompletionFailed = Effect.fn('markCompletionFailed')(function* (
    reason: PublicTaskFailure['reason'] = 'completion_failed',
  ) {
    if (yield* cancellationWon) return { result: 'cancelled' as const, settled: false };
    const failedAt = yield* currentIso;
    if (!ownsPublication && stateStore.claimRunPublication !== undefined) {
      ownsPublication = yield* claimFailureNotification();
    }
    const statusWriteSucceeded = yield* Effect.tryPromise({
      try: () =>
        stateStore.markSchedulingFailed({
          runId: input.runId,
          occurredAt: failedAt,
          failure: {
            phase: reason === 'invalid_output' ? 'output_validation' : 'publication',
            reason,
          },
        }),
      catch: () => false,
    }).pipe(Effect.catch(() => Effect.succeed(false)));
    // Cancellation can overtake the pre-check and win before the claim and
    // status CAS. The durable outcome is the winner; only a failed winner may
    // emit failure feedback, a failure Check or comment, or failed telemetry.
    const settled = yield* latestOutcome;
    // A failed post-write read must not hide failure feedback once this attempt
    // provably owns publication and wrote the failed status.
    const fallbackFailed = settled === undefined && ownsPublication && statusWriteSucceeded;
    if (settled?.status !== 'failed' && !fallbackFailed) {
      return {
        result: settled?.status === 'cancelled' ? ('cancelled' as const) : ('failed' as const),
        settled: false,
      };
    }
    yield* manualReaction('-1');
    yield* publishFailureNotification(ownsPublication);
    return { result: 'failed' as const, settled: true };
  });

  const completionFailed = Effect.fn('completionFailed')(function* (
    reason: Extract<PublicationTerminal, { outcome: 'failed' }>['reason'],
  ) {
    const { result, settled } = yield* markCompletionFailed(reason);
    if (result === 'cancelled') return 'cancelled' as const;
    if (settled) yield* recordPublicationTerminal(log, input.runId, { outcome: 'failed', reason });
    return 'failed' as const;
  });

  const decodedOutput = yield* Schema.decodeUnknownEffect(RunnerReviewResult)(input.output).pipe(
    Effect.catch(() => Effect.succeed(undefined)),
  );
  if (decodedOutput === undefined) {
    return yield* completionFailed('invalid_output');
  }

  decision = typeof decodedOutput === 'string' ? undefined : decodedOutput.decision;

  if (
    github.loadReviewTarget === undefined ||
    github.createReview === undefined ||
    outcome.baseSha === null ||
    outcome.headSha === null
  ) {
    return yield* completionFailed('publication_uncertain');
  }

  if (outcome.publicationClaimedAt === undefined) {
    const target = yield* Effect.tryPromise({
      try: () =>
        github.loadReviewTarget!({
          repositoryId: outcome.repositoryId,
          pullRequestNumber: outcome.pullRequestNumber,
          installationId: outcome.installationId,
        }),
      catch: () => undefined,
    }).pipe(
      Effect.flatMap((value) =>
        value === undefined
          ? Effect.succeed(undefined)
          : Schema.decodeUnknownEffect(ReviewPublicationTarget)(value).pipe(
              Effect.catch(() => Effect.succeed(undefined)),
            ),
      ),
      Effect.catch(() => Effect.succeed(undefined)),
    );

    if (target !== undefined && target.headSha !== outcome.headSha) {
      if (stateStore.markRunSuperseded === undefined) {
        yield* recordPublicationTerminal(log, input.runId, {
          outcome: 'failed',
          reason: 'completion_failed',
        });
        return 'failed' as const;
      }
      const superseded = yield* Effect.tryPromise({
        try: async () =>
          stateStore.markRunSuperseded!({
            runId: input.runId,
            occurredAt: await Effect.runPromise(currentIso),
          }),
        catch: () => undefined,
      }).pipe(Effect.catch(() => Effect.succeed(false)));
      if (!superseded) {
        if (yield* cancellationWon) return 'cancelled' as const;
        yield* recordPublicationTerminal(log, input.runId, {
          outcome: 'failed',
          reason: 'completion_failed',
        });
        return 'failed' as const;
      }
      yield* manualReaction('confused');
      yield* updateCheck();
      yield* recordPublicationTerminal(log, input.runId, { outcome: 'superseded' });
      return 'ignored' as const;
    }

    if (target === undefined) {
      return yield* completionFailed('publication_uncertain');
    }
  }

  const payload: ReviewPublicationPayload = formatReviewPublicationPayload({
    runId: input.runId,
    headSha: outcome.headSha,
    markdown: typeof decodedOutput === 'string' ? decodedOutput : decodedOutput.markdown,
    decision: typeof decodedOutput === 'string' ? 'comment' : decodedOutput.decision,
  });

  const marker = formatReviewPublicationMarker(input.runId);
  const lookupMarker = () =>
    github.findReviewByMarker === undefined
      ? Effect.succeed({ ok: true as const, review: undefined })
      : Effect.tryPromise({
          try: () =>
            github.findReviewByMarker!({
              repositoryId: outcome.repositoryId,
              pullRequestNumber: outcome.pullRequestNumber,
              installationId: outcome.installationId,
              marker,
              expected: { headSha: outcome.headSha!, event: payload.event },
            }),
          catch: () => undefined,
        }).pipe(
          Effect.map((review) => ({ ok: true as const, review })),
          Effect.catch(() => Effect.succeed({ ok: false as const })),
        );

  const markerLookup = yield* lookupMarker();
  if (!markerLookup.ok) {
    if (outcome.publicationClaimedAt !== undefined) return 'ignored' as const;
    return yield* completionFailed('marker_lookup_failed');
  }

  if (markerLookup.review !== undefined) {
    const completed = yield* completeRun();
    if (!completed) {
      return yield* completionFailed('completion_failed');
    }
    yield* recordPublicationTerminal(log, input.runId, { outcome: 'published' });
    return 'completed' as const;
  }

  if (outcome.publicationClaimedAt !== undefined) {
    // A successful marker lookup found no matching post. The prior Worker may
    // still be publishing. Never issue another POST for this run.
    const reconciledAt = yield* currentIso;
    const age = Date.parse(reconciledAt) - Date.parse(outcome.publicationClaimedAt);
    if (github.findReviewByMarker !== undefined && age >= REVIEW_ATTEMPT_BUDGET_MS) {
      const failed = yield* Effect.tryPromise(() =>
        stateStore.markSchedulingFailed({
          runId: input.runId,
          occurredAt: reconciledAt,
          failure: { phase: 'publication', reason: 'publication_uncertain' },
        }),
      );
      if (failed) {
        yield* updateCheck();
        yield* recordPublicationTerminal(log, input.runId, {
          outcome: 'failed',
          reason: 'publication_uncertain',
        });
        return 'failed' as const;
      }
    }
    return 'ignored' as const;
  }
  if (stateStore.claimRunPublication !== undefined) {
    occurredAt = yield* currentIso;
    const publicationClaimed = yield* Effect.tryPromise({
      try: () =>
        stateStore.claimRunPublication!({
          runId: input.runId,
          occurredAt,
          publishing: true,
        }),
      catch: () => false,
    }).pipe(Effect.catch(() => Effect.succeed(false)));
    if (!publicationClaimed) {
      const latest = yield* Effect.tryPromise(() => getRunOutcome(input.runId)).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      );
      return latest?.status === 'cancelled' ? ('cancelled' as const) : ('completed' as const);
    }
    ownsPublication = true;
  }

  const publication = yield* Effect.tryPromise({
    try: () =>
      github.createReview!({
        repositoryId: outcome.repositoryId,
        pullRequestNumber: outcome.pullRequestNumber,
        installationId: outcome.installationId,
        payload,
        ...(typeof decodedOutput === 'string' ? {} : { verifyPublication: true }),
      }),
    catch: () => undefined,
  }).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(ReviewPublicationCreateResult)(value).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      ),
    ),
    Effect.catch(() => Effect.succeed(false)),
  );
  if (typeof publication === 'object' && publication !== null && publication.kind === 'stale') {
    if (stateStore.markRunSuperseded === undefined) {
      yield* recordPublicationTerminal(log, input.runId, {
        outcome: 'failed',
        reason: 'completion_failed',
      });
      return 'failed' as const;
    }
    const superseded = yield* Effect.tryPromise({
      try: async () =>
        stateStore.markRunSuperseded!({
          runId: input.runId,
          occurredAt: await Effect.runPromise(currentIso),
        }),
      catch: () => undefined,
    }).pipe(Effect.catch(() => Effect.succeed(false)));
    if (!superseded) {
      if (yield* cancellationWon) return 'cancelled' as const;
      yield* recordPublicationTerminal(log, input.runId, {
        outcome: 'failed',
        reason: 'completion_failed',
      });
      return 'failed' as const;
    }
    yield* manualReaction('confused');
    yield* updateCheck();
    yield* recordPublicationTerminal(log, input.runId, { outcome: 'superseded' });
    return 'ignored' as const;
  }
  if (publication === false || publication === undefined) {
    const recoveredLookup = yield* lookupMarker();
    if (recoveredLookup.ok && recoveredLookup.review !== undefined) {
      const completed = yield* completeRun();
      if (!completed) {
        return yield* completionFailed('completion_failed');
      }
      yield* recordPublicationTerminal(log, input.runId, { outcome: 'published' });
      return 'completed' as const;
    }
    return yield* completionFailed(
      recoveredLookup.ok ? 'publication_uncertain' : 'marker_lookup_failed',
    );
  }
  const completed = yield* completeRun();
  if (!completed) {
    return yield* completionFailed('completion_failed');
  }
  yield* recordPublicationTerminal(log, input.runId, { outcome: 'published' });
  return 'completed' as const;
});

const checkStatusForOutcome = (
  outcome: ReviewOutcome | undefined,
): 'in_progress' | 'success' | 'failure' | 'cancelled' | undefined =>
  outcome?.status === 'completed'
    ? 'success'
    : outcome?.status === 'failed'
      ? 'failure'
      : outcome?.status === 'superseded' || outcome?.status === 'cancelled'
        ? 'cancelled'
        : outcome?.status === 'scheduled' && outcome.runnerJobId !== undefined
          ? 'in_progress'
          : undefined;

export const publishTerminalCheck = async (input: {
  github: GitHubAdapter;
  stateStore: ReviewCompletionStateStore;
  runId: string;
  occurredAt: string;
  reopen?: boolean;
}): Promise<boolean> => {
  const { github, stateStore, runId, occurredAt, reopen } = input;
  if (github.updateCheckRun === undefined || stateStore.getRunOutcome === undefined) return false;
  const getRunOutcome = stateStore.getRunOutcome;
  const outcome = await getRunOutcome(runId);
  const status = checkStatusForOutcome(outcome);
  if (
    outcome === undefined ||
    outcome.checkRunId === undefined ||
    status === undefined ||
    status === 'in_progress' ||
    outcome.status === 'cancelled'
  ) {
    return false;
  }
  const checkRunId = outcome.checkRunId;
  // Manual cancellation keeps its independent reconciliation timestamps.
  if (
    stateStore.claimCheckDelivery !== undefined &&
    !(await stateStore.claimCheckDelivery({
      runId,
      checkRunId,
      occurredAt,
      ...(reopen === undefined ? {} : { reopen }),
    }))
  ) {
    return false;
  }
  const current = await getRunOutcome(runId);
  const currentStatus = checkStatusForOutcome(current);
  if (
    current === undefined ||
    current.checkRunId !== checkRunId ||
    currentStatus !== status ||
    current.status === 'cancelled'
  ) {
    return false;
  }
  await github.updateCheckRun({
    runId,
    repositoryId: current.repositoryId,
    installationId: current.installationId,
    checkRunId,
    status,
    ...(status === 'success' && current.decision !== undefined
      ? { decision: current.decision }
      : {}),
  });
  await stateStore.confirmCheckDelivery?.({ runId, checkRunId, occurredAt });
  return true;
};

const checkSetupLeaseDuration = { minutes: 1 } as const;

const setupCheck = Effect.fn('setupCheck')(function* (
  github: GitHubAdapter,
  stateStore: ReviewCompletionStateStore,
  runId: string,
  job: ReviewJob,
) {
  let setupClaim: string | undefined;
  if (stateStore.claimCheckSetup !== undefined) {
    const now = yield* DateTime.now;
    setupClaim = DateTime.formatIso(now);
    const staleBefore = DateTime.formatIso(DateTime.subtract(now, checkSetupLeaseDuration));
    const claimed = yield* Effect.tryPromise({
      try: () => stateStore.claimCheckSetup!({ runId, claimedAt: setupClaim!, staleBefore }),
      catch: () => false,
    }).pipe(Effect.catch(() => Effect.succeed(false)));
    if (!claimed) return;
  }
  if (github.createCheckRun !== undefined && stateStore.recordCheckRun !== undefined) {
    const checkRun = yield* Effect.tryPromise({
      try: () =>
        github.createCheckRun!({
          repositoryId: job.repositoryId,
          installationId: job.installationId,
          headSha: job.headSha,
          runId,
        }),
      catch: () => undefined,
    }).pipe(Effect.catch(() => Effect.succeed(undefined)));
    if (checkRun !== undefined) {
      const recorded = yield* Effect.tryPromise({
        try: () =>
          stateStore.recordCheckRun!({
            runId,
            checkRunId: checkRun.id,
            ...(setupClaim === undefined ? {} : { setupClaim }),
          }),
        catch: () => false,
      }).pipe(Effect.catch(() => Effect.succeed(false)));
      const getRunOutcome = stateStore.getRunOutcome;
      if (recorded && getRunOutcome !== undefined) {
        const current = yield* Effect.tryPromise({
          try: () => getRunOutcome(runId),
          catch: () => undefined,
        }).pipe(Effect.catch(() => Effect.succeed(undefined)));
        const status = checkStatusForOutcome(current);
        const occurredAt = DateTime.formatIso(yield* DateTime.now);
        const deliverTerminal = (outcome: ReviewOutcome, reopen = false) =>
          Effect.tryPromise({
            try: () =>
              publishTerminalCheck({
                github,
                stateStore,
                runId,
                occurredAt,
                ...(reopen ? { reopen: true } : {}),
              }).then(() => outcome),
            catch: () => undefined,
          }).pipe(Effect.catch(() => Effect.succeed(undefined)));
        const endCancelled = (outcome: ReviewOutcome) =>
          Effect.tryPromise({
            try: () =>
              github.updateCheckRun!({
                runId,
                repositoryId: outcome.repositoryId,
                installationId: outcome.installationId,
                checkRunId: checkRun.id,
                status: 'cancelled',
                cancellationReason: 'manual',
              }).then(() =>
                stateStore.confirmCheckCancelled?.({
                  runId,
                  checkRunId: checkRun.id,
                  occurredAt,
                }),
              ),
            catch: () => undefined,
          }).pipe(Effect.catch(() => Effect.succeed(undefined)));
        if (current !== undefined && status !== undefined && github.updateCheckRun !== undefined) {
          if (current.status === 'cancelled') {
            yield* endCancelled(current);
          } else if (status !== 'in_progress') {
            yield* deliverTerminal(current);
          } else {
            yield* Effect.tryPromise({
              try: () =>
                github.updateCheckRun!({
                  runId,
                  repositoryId: current.repositoryId,
                  installationId: current.installationId,
                  checkRunId: checkRun.id,
                  status,
                }),
              catch: () => undefined,
            }).pipe(Effect.catch(() => Effect.succeed(undefined)));
            const latest = yield* Effect.tryPromise({
              try: () => getRunOutcome(runId),
              catch: () => undefined,
            }).pipe(Effect.catch(() => Effect.succeed(undefined)));
            const latestStatus = checkStatusForOutcome(latest);
            if (
              latest !== undefined &&
              latestStatus !== undefined &&
              latestStatus !== 'in_progress'
            ) {
              if (latest.status === 'cancelled') yield* endCancelled(latest);
              else yield* deliverTerminal(latest, true);
            }
          }
        }
      }
      if (!recorded && stateStore.markCheckSetupFailed !== undefined) {
        yield* Effect.tryPromise({
          try: () =>
            stateStore.markCheckSetupFailed!({
              runId,
              ...(setupClaim === undefined ? {} : { setupClaim }),
            }),
          catch: () => false,
        }).pipe(Effect.catch(() => Effect.succeed(false)));
      }
    } else if (stateStore.markCheckSetupFailed !== undefined) {
      yield* Effect.tryPromise({
        try: () =>
          stateStore.markCheckSetupFailed!({
            runId,
            ...(setupClaim === undefined ? {} : { setupClaim }),
          }),
        catch: () => false,
      }).pipe(Effect.catch(() => Effect.succeed(false)));
    }
  } else if (stateStore.markCheckSetupFailed !== undefined) {
    yield* Effect.tryPromise({
      try: () =>
        stateStore.markCheckSetupFailed!({
          runId,
          ...(setupClaim === undefined ? {} : { setupClaim }),
        }),
      catch: () => false,
    }).pipe(Effect.catch(() => Effect.succeed(false)));
  }
});

const startCheckSetup = Effect.fn('startCheckSetup')(function* (
  github: GitHubAdapter,
  stateStore: ReviewCompletionStateStore,
  runId: string,
  job: ReviewJob,
  defer?: ReviewCheckSetupDefer,
) {
  const task = setupCheck(github, stateStore, runId, job);
  if (defer === undefined) return yield* task;
  yield* Effect.sync(() => defer(Effect.runPromise(task)));
});

interface AdmissionDependencies {
  readonly github: GitHubAdapter;
  readonly stateStore: ReviewCompletionStateStore;
  readonly cancelRunnerJob?: CancelRunnerJob;
  readonly log?: OperationalLog;
  readonly deferCheckSetup?: ReviewCheckSetupDefer;
  readonly lifecycleLog?: CoreLifecycleLog;
}

const claimAndSchedule = (
  dependencies: AdmissionDependencies,
  deliveryId: string,
  job: ReviewJob,
  approval?: ReviewApproval,
) =>
  Effect.gen(function* () {
    const { github, stateStore, cancelRunnerJob, log, deferCheckSetup, lifecycleLog } =
      dependencies;
    const occurredAt = yield* currentIso;
    const validatedJob = yield* Schema.decodeUnknownEffect(ReviewJob)(job).pipe(
      Effect.mapError(() => new SchedulingFailed({ message: 'Review job is invalid' })),
    );
    const claim = yield* Effect.tryPromise({
      try: () =>
        stateStore.claimReview({
          deliveryId,
          job: validatedJob,
          occurredAt,
          approval,
        }),
      catch: () => new SchedulingFailed({ message: 'Review state could not be claimed' }),
    }).pipe(
      Effect.catchTag('SchedulingFailed', (error) =>
        Effect.gen(function* () {
          yield* recordOperationalLog(log, {
            phase: 'core',
            outcome: 'retryable',
            deliveryId,
            reason: 'state_failure',
          });
          return yield* Effect.fail(error);
        }),
      ),
    );

    if (claim.kind !== 'claimed') {
      if (claim.runId !== undefined && claim.checkSetupStatus === 'pending') {
        yield* startCheckSetup(github, stateStore, claim.runId, job, deferCheckSetup);
      }
      return claim.disposition;
    }

    yield* recordLifecycleLog(lifecycleLog, {
      event: 'review scheduled',
      runId: claim.runId,
      trigger: job.trigger,
    });

    if (claim.supersededRunIds !== undefined && stateStore.getRunOutcome !== undefined) {
      for (const supersededRunId of claim.supersededRunIds) {
        const supersededOutcome = yield* Effect.tryPromise({
          try: () => stateStore.getRunOutcome!(supersededRunId),
          catch: () => undefined,
        }).pipe(Effect.catch(() => Effect.succeed(undefined)));
        if (supersededOutcome?.checkRunId !== undefined && github.updateCheckRun !== undefined) {
          yield* Effect.tryPromise({
            try: () =>
              publishTerminalCheck({
                github,
                stateStore,
                runId: supersededRunId,
                occurredAt,
              }),
            catch: () => undefined,
          }).pipe(Effect.catch(() => Effect.succeed(undefined)));
        }
        if (supersededOutcome?.status === 'superseded') {
          yield* recordSupersededLifecycle(
            lifecycleLog,
            supersededRunId,
            supersededOutcome,
            occurredAt,
            'unknown',
          );
        }
      }
    }

    yield* startCheckSetup(github, stateStore, claim.runId, job, deferCheckSetup);

    // Eager cleanup is retried by the claim path. A late failure here must not
    // overwrite a run whose Runner already confirmed the reset and started.
    yield* resetPreviousReviewVerdicts(github, stateStore, claim.runId, job).pipe(
      Effect.catch(() =>
        recordOperationalLog(log, {
          phase: 'core',
          outcome: 'retryable',
          deliveryId,
          reason: 'review_reset_failed',
        }),
      ),
    );

    if (claim.activeRunnerJob !== undefined) {
      if (cancelRunnerJob === undefined || stateStore.markRunSuperseded === undefined) {
        return 'scheduled' as const;
      }
      const getRunOutcome = stateStore.getRunOutcome;
      const supersededOutcome =
        getRunOutcome === undefined
          ? undefined
          : yield* Effect.tryPromise({
              try: () => getRunOutcome(claim.activeRunnerJob!.runId),
              catch: () => undefined,
            }).pipe(Effect.catch(() => Effect.succeed(undefined)));
      const superseded = yield* Effect.tryPromise({
        try: () =>
          stateStore.markRunSuperseded!({ runId: claim.activeRunnerJob!.runId, occurredAt }),
        catch: () => false,
      }).pipe(Effect.catch(() => Effect.succeed(false)));
      if (!superseded) return 'scheduled' as const;
      if (supersededOutcome?.checkRunId !== undefined && github.updateCheckRun !== undefined) {
        yield* Effect.tryPromise({
          try: () =>
            publishTerminalCheck({
              github,
              stateStore,
              runId: claim.activeRunnerJob!.runId,
              occurredAt,
            }),
          catch: () => undefined,
        }).pipe(Effect.catch(() => Effect.succeed(undefined)));
      }
      const canceled = yield* Effect.tryPromise({
        try: () => cancelRunnerJob(claim.activeRunnerJob!.jobId, claim.activeRunnerJob!.claimedAt),
        catch: () => undefined,
      }).pipe(
        Effect.map((ack) => ack !== 'pending'),
        Effect.catch(() => Effect.succeed(false)),
      );
      if (!canceled) return 'scheduled' as const;
      if (stateStore.clearRunnerJob !== undefined) {
        const cleared = yield* Effect.tryPromise({
          try: () =>
            stateStore.clearRunnerJob!({
              runId: claim.activeRunnerJob!.runId,
              jobId: claim.activeRunnerJob!.jobId,
            }),
          catch: () => false,
        }).pipe(Effect.catch(() => Effect.succeed(false)));
        if (!cleared) return 'scheduled' as const;
      }
      if (supersededOutcome !== undefined) {
        yield* recordSupersededLifecycle(
          lifecycleLog,
          claim.activeRunnerJob.runId,
          supersededOutcome,
          yield* currentIso,
          'destroyed',
        );
      }
    }

    yield* recordOperationalLog(log, {
      phase: 'core',
      outcome: 'scheduled',
      deliveryId,
      runId: claim.runId,
    });
    return 'scheduled' as const;
  });

const recordDelivery = (stateStore: ReviewStateStore, input: ReviewDeliveryRecord) => {
  return Effect.tryPromise({
    try: () => stateStore.recordDelivery(input),
    catch: () => new SchedulingFailed({ message: 'Review outcome could not be recorded' }),
  });
};

type ManualRead<T> =
  | { readonly kind: 'value'; readonly value: T }
  | { readonly kind: 'missing' }
  | { readonly kind: 'uncertain' };

const readManualPolicyWithRetry = async <T>(
  read: () => Promise<unknown>,
  schema: Schema.ConstraintDecoder<T>,
): Promise<ManualRead<T>> => {
  const readOnce = async (): Promise<ManualRead<T>> => {
    let value: unknown;
    try {
      value = await read();
    } catch {
      return { kind: 'uncertain' };
    }

    if (value === undefined) return { kind: 'missing' };

    try {
      return { kind: 'value', value: await Schema.decodeUnknownPromise(schema)(value) };
    } catch {
      return { kind: 'uncertain' };
    }
  };

  const first = await readOnce();
  return first.kind === 'uncertain' ? readOnce() : first;
};

interface ManualIntent {
  readonly deliveryId: string;
  readonly repositoryId: number;
  readonly pullRequestNumber: number;
  readonly installationId: number;
  readonly senderLogin: string;
  readonly commentId?: number;
}

const loadPullRequestWithRetry = (github: GitHubAdapter, intent: ManualIntent) =>
  readManualPolicyWithRetry(async () => {
    if (github.getPullRequest === undefined) {
      throw new Error('Pull request facts adapter is unavailable');
    }
    return github.getPullRequest({
      repositoryId: intent.repositoryId,
      pullRequestNumber: intent.pullRequestNumber,
      installationId: intent.installationId,
    });
  }, PullRequestFacts);

const loadPermissionWithRetry = (github: GitHubAdapter, intent: ManualIntent) =>
  readManualPolicyWithRetry(async () => {
    if (github.getCommenterPermission === undefined) {
      throw new Error('Commenter permission adapter is unavailable');
    }
    return github.getCommenterPermission({
      repositoryId: intent.repositoryId,
      pullRequestNumber: intent.pullRequestNumber,
      installationId: intent.installationId,
      commenterLogin: intent.senderLogin,
    });
  }, CommenterPermission);

const writeManualReaction = (
  github: GitHubAdapter,
  intent: ManualIntent,
  content: 'eyes' | 'confused' | '-1',
) =>
  intent.commentId === undefined || github.addReaction === undefined
    ? Effect.succeed(undefined)
    : Effect.tryPromise({
        try: () =>
          github.addReaction!({
            repositoryId: intent.repositoryId,
            installationId: intent.installationId,
            commentId: intent.commentId!,
            content,
          }),
        catch: () => new SchedulingFailed({ message: 'Manual review feedback failed' }),
      });

const jobForManualFacts = (intent: ManualIntent, facts: PullRequestFactsType): ReviewJob => ({
  repositoryId: intent.repositoryId,
  pullRequestNumber: intent.pullRequestNumber,
  installationId: intent.installationId,
  baseSha: facts.baseSha,
  headSha: facts.headSha,
  trigger: 'manual',
  ...(intent.commentId === undefined ? {} : { commentId: intent.commentId }),
  repositoryVisibility: facts.repositoryVisibility,
  baseRef: facts.baseRef,
  headRef: facts.headRef,
});

const SuiteCheckRunCandidates = Schema.Struct({
  candidates: Schema.Array(
    Schema.Struct({
      id: Schema.Int,
      externalId: Schema.NullOr(Schema.NonEmptyString),
    }),
  ),
});

const lookupSuiteCheckCandidates = Effect.fn('lookupSuiteCheckCandidates')(function* (
  github: GitHubAdapter,
  input: {
    readonly repositoryId: number;
    readonly installationId: number;
    readonly checkSuiteId: number;
  },
) {
  if (github.findCheckRunForSuite === undefined) {
    return yield* new SchedulingFailed({ message: 'Check suite lookup is uncertain' });
  }
  return yield* Effect.tryPromise({
    try: async () =>
      Schema.decodeUnknownPromise(SuiteCheckRunCandidates)(
        await github.findCheckRunForSuite!({
          repositoryId: input.repositoryId,
          installationId: input.installationId,
          checkSuiteId: input.checkSuiteId,
        }),
      ),
    catch: () => new SchedulingFailed({ message: 'Check suite lookup is uncertain' }),
  });
});

const createReviewEventHandler = (dependencies: AdmissionDependencies) => {
  const { github, stateStore, log } = dependencies;

  const handleAutomaticEvent = Effect.fn('handleAutomaticReviewEvent')(function* (
    event: Extract<ReviewEvent, { event: 'pull_request' }>,
  ) {
    if (event.draft) {
      const occurredAt = yield* currentIso;
      yield* recordDelivery(stateStore, {
        deliveryId: event.deliveryId,
        installationId: event.installationId,
        repositoryId: event.repositoryId,
        pullRequestNumber: event.pullRequestNumber,
        baseSha: event.baseSha,
        headSha: event.headSha,
        trigger: 'automatic',
        status: 'ignored',
        occurredAt,
      });
      return 'ignored' as const;
    }

    if (!isAutomaticEligible(event)) {
      const occurredAt = yield* currentIso;
      yield* recordDelivery(stateStore, {
        deliveryId: event.deliveryId,
        installationId: event.installationId,
        repositoryId: event.repositoryId,
        pullRequestNumber: event.pullRequestNumber,
        baseSha: event.baseSha,
        headSha: event.headSha,
        trigger: 'automatic',
        status: 'awaiting approval',
        occurredAt,
      });
      return 'awaiting approval' as const;
    }

    return yield* claimAndSchedule(dependencies, event.deliveryId, jobForEvent(event, 'automatic'));
  });

  const handleManualIntent = Effect.fn('handleManualIntent')(function* (intent: ManualIntent) {
    const factsRead = yield* Effect.tryPromise({
      try: () => loadPullRequestWithRetry(github, intent),
      catch: () => new SchedulingFailed({ message: 'Pull request facts are uncertain' }),
    });
    if (factsRead.kind === 'uncertain') {
      yield* recordOperationalLog(log, {
        phase: 'core',
        outcome: 'retryable',
        deliveryId: intent.deliveryId,
        reason: 'pull_request_facts_uncertain',
      });
      return yield* new SchedulingFailed({ message: 'Pull request facts are uncertain' });
    }

    const facts = factsRead.kind === 'value' ? factsRead.value : undefined;
    let permission: typeof CommenterPermission.Type | undefined;
    if (facts !== undefined && !facts.draft) {
      const permissionRead = yield* Effect.tryPromise({
        try: () => loadPermissionWithRetry(github, intent),
        catch: () => new SchedulingFailed({ message: 'Commenter permission is uncertain' }),
      });
      if (permissionRead.kind === 'uncertain') {
        yield* recordOperationalLog(log, {
          phase: 'core',
          outcome: 'retryable',
          deliveryId: intent.deliveryId,
          reason: 'commenter_permission_uncertain',
        });
        return yield* new SchedulingFailed({ message: 'Commenter permission is uncertain' });
      }
      permission = permissionRead.kind === 'value' ? permissionRead.value : undefined;
    }

    if (
      facts === undefined ||
      permission === undefined ||
      permission === 'none' ||
      permission === 'read' ||
      permission === 'triage' ||
      facts.draft
    ) {
      const occurredAt = yield* currentIso;
      yield* recordDelivery(stateStore, {
        deliveryId: intent.deliveryId,
        installationId: intent.installationId,
        repositoryId: intent.repositoryId,
        pullRequestNumber: intent.pullRequestNumber,
        baseSha: facts?.baseSha ?? null,
        headSha: facts?.headSha ?? null,
        trigger: 'manual',
        status: 'awaiting approval',
        occurredAt,
      });
      yield* writeManualReaction(github, intent, 'confused');
      return 'awaiting approval' as const;
    }

    const disposition = yield* claimAndSchedule(
      dependencies,
      intent.deliveryId,
      jobForManualFacts(intent, facts),
      {
        installationId: intent.installationId,
        repositoryId: intent.repositoryId,
        pullRequestNumber: intent.pullRequestNumber,
        baseSha: facts.baseSha,
        headSha: facts.headSha,
      },
    );

    if (disposition === 'scheduled') yield* writeManualReaction(github, intent, 'eyes');

    return disposition;
  });

  const handleCheckEvent = Effect.fn('handleCheckRerequest')(function* (
    event: Extract<ReviewEvent, { event: 'check_run' | 'check_suite' }>,
  ) {
    let checkRunId: number;
    let externalRunId: string;
    if (event.event === 'check_run') {
      if (event.externalRunId === null) return 'ignored' as const;
      checkRunId = event.checkRunId;
      externalRunId = event.externalRunId;
    } else {
      const resolved = yield* lookupSuiteCheckCandidates(github, {
        repositoryId: event.repositoryId,
        installationId: event.installationId,
        checkSuiteId: event.checkSuiteId,
      }).pipe(
        Effect.catchTag('SchedulingFailed', (error) =>
          Effect.gen(function* () {
            yield* recordOperationalLog(log, {
              phase: 'core',
              outcome: 'retryable',
              deliveryId: event.deliveryId,
              reason: 'check_lookup_uncertain',
            });
            return yield* Effect.fail(error);
          }),
        ),
      );
      const candidates = resolved.candidates.filter(
        (candidate): candidate is { id: number; externalId: string } =>
          candidate.externalId !== null,
      );
      if (candidates.length !== 1) return 'ignored' as const;
      checkRunId = candidates[0]!.id;
      externalRunId = candidates[0]!.externalId;
    }

    if (stateStore.getRunOutcome === undefined) {
      yield* recordOperationalLog(log, {
        phase: 'core',
        outcome: 'retryable',
        deliveryId: event.deliveryId,
        reason: 'state_failure',
      });
      return yield* new SchedulingFailed({ message: 'Check ownership is uncertain' });
    }
    const outcome = yield* Effect.tryPromise({
      try: () => stateStore.getRunOutcome!(externalRunId),
      catch: () => new SchedulingFailed({ message: 'Check ownership is uncertain' }),
    }).pipe(
      Effect.catchTag('SchedulingFailed', (error) =>
        Effect.gen(function* () {
          yield* recordOperationalLog(log, {
            phase: 'core',
            outcome: 'retryable',
            deliveryId: event.deliveryId,
            reason: 'state_failure',
          });
          return yield* Effect.fail(error);
        }),
      ),
    );
    if (
      outcome === undefined ||
      outcome.checkRunId !== checkRunId ||
      outcome.repositoryId !== event.repositoryId ||
      outcome.installationId !== event.installationId ||
      (outcome.status !== 'failed' && outcome.status !== 'cancelled')
    ) {
      return 'ignored' as const;
    }

    const disposition = yield* handleManualIntent({
      deliveryId: event.deliveryId,
      repositoryId: event.repositoryId,
      pullRequestNumber: outcome.pullRequestNumber,
      installationId: event.installationId,
      senderLogin: event.senderLogin,
    });
    const cleanupBlocked =
      outcome.cleanup === 'pending' ||
      outcome.cleanup === 'failed' ||
      (outcome.cleanup === undefined && outcome.runnerJobId !== undefined);
    if (disposition === 'cancelled' && cleanupBlocked && github.updateCheckRun !== undefined) {
      yield* Effect.tryPromise({
        try: () =>
          github.updateCheckRun!({
            runId: externalRunId,
            repositoryId: outcome.repositoryId,
            installationId: outcome.installationId,
            checkRunId,
            status: 'cancelled',
            cancellationReason: 'manual',
            retryBlocked: outcome.cleanup === 'failed' ? 'cleanup-failed' : 'cleanup-pending',
          }),
        catch: () => new SchedulingFailed({ message: 'Check retry feedback failed' }),
      }).pipe(Effect.catch(() => Effect.succeed(undefined)));
    }
    return disposition;
  });

  return Effect.fn('handleReviewEvent')(function* (event: unknown) {
    const decoded = yield* Schema.decodeUnknownEffect(ReviewEvent)(event).pipe(
      Effect.mapError(() => new InvalidReviewEvent({ message: 'Review event is invalid' })),
    );

    if (decoded.event === 'pull_request') {
      return yield* handleAutomaticEvent(decoded);
    }

    if (decoded.event === 'check_run' || decoded.event === 'check_suite') {
      return yield* handleCheckEvent(decoded);
    }

    return yield* handleManualIntent({
      deliveryId: decoded.deliveryId,
      repositoryId: decoded.repositoryId,
      pullRequestNumber: decoded.pullRequestNumber,
      installationId: decoded.installationId,
      senderLogin: decoded.commenterLogin,
      commentId: decoded.commentId,
    });
  });
};

export function createReviewCoordinator(dependencies: AdmissionDependencies): ReviewCoordinator {
  const handleReviewEvent = createReviewEventHandler(dependencies);
  return {
    handleReviewEvent: async (event) =>
      Effect.runPromise(handleReviewEvent(event)).catch((error) => {
        if (error instanceof InvalidReviewEvent) {
          return 'ignored' as const;
        }

        return 'failed' as const;
      }),
    completeReview: async (input) =>
      Effect.runPromise(
        completeReviewEffect(input, dependencies.github, dependencies.stateStore, dependencies.log),
      ).catch(() => 'failed' as const),
  };
}
