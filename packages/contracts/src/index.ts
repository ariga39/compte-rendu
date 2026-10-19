import { Schema } from 'effect';
import { ModelUsageSummary } from './model-usage.ts';
export { ModelUsageSummary } from './model-usage.ts';

export const DEFAULT_REVIEW_NAME = 'Compte-rendu review';
export const PublicDashboardConfig = Schema.Struct({ name: Schema.String });

export const REVIEW_ATTEMPT_BUDGET_MS = 30 * 60 * 1000;

const ModelRouteId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._:-]{1,128}$/));
export const ReviewModelSelection = Schema.Struct({
  reviewers: Schema.Array(ModelRouteId).check(
    Schema.isMinLength(1),
    Schema.makeFilter((routes) => new Set(routes).size === routes.length, {
      expected: 'distinct reviewer routes',
    }),
  ),
  synthesis: ModelRouteId,
});
export type ReviewModelSelection = typeof ReviewModelSelection.Type;
export const ReviewConfiguration = Schema.Struct({
  revision: Schema.Natural,
  selection: Schema.NullOr(ReviewModelSelection),
});
export type ReviewConfiguration = typeof ReviewConfiguration.Type;

export interface WorkerEntrypoint<Env = unknown> {
  fetch(
    request: Request,
    env?: Env,
    context?: { waitUntil(task: Promise<unknown>): void },
  ): Response | Promise<Response>;
}

export interface CoreServiceBinding {
  fetch(request: Request): Response | Promise<Response>;
}

export const GitHubSha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/i));

export const MAX_REVIEW_RESULT_BYTES = 8 * 1024 * 1024;
export const MAX_RUNNER_CALLBACK_BYTES = 32 * 1024 * 1024;

export const ReviewResult = Schema.String.check(
  Schema.makeFilter((markdown) => markdown.trim().length > 0, {
    expected: 'non-empty review Markdown',
  }),
  Schema.makeFilter(
    (markdown) => new TextEncoder().encode(markdown).byteLength <= MAX_REVIEW_RESULT_BYTES,
    { expected: `review Markdown no larger than ${MAX_REVIEW_RESULT_BYTES} bytes` },
  ),
);

export type ReviewResult = typeof ReviewResult.Type;

export const ReviewDecision = Schema.Literals(['approve', 'request_changes', 'comment']);
export type ReviewDecision = typeof ReviewDecision.Type;
export const StructuredReviewResult = Schema.Struct({
  version: Schema.Literal(2),
  decision: ReviewDecision,
  markdown: ReviewResult,
});
export type StructuredReviewResult = typeof StructuredReviewResult.Type;
export const RunnerReviewResult = Schema.Union([ReviewResult, StructuredReviewResult]);
export type RunnerReviewResult = typeof RunnerReviewResult.Type;

export const RunnerFailureCause = Schema.Literals([
  'process-exit',
  'timeout',
  'output-truncated',
  'malformed-jsonl',
  'agent-error',
  'zero-results',
  'multiple-results',
  'result-schema-failure',
  'missing-terminal-message',
  'empty-final-text',
]);

export const RunnerJobInput = Schema.Struct({
  reviewConfiguration: Schema.optional(ReviewConfiguration),
  id: Schema.NonEmptyString,
  runId: Schema.NonEmptyString,
  attempt: Schema.Int,
  repositoryUrl: Schema.NonEmptyString,
  repositoryName: Schema.NonEmptyString,
  pullRequestNumber: Schema.Int,
  baseSha: GitHubSha,
  headSha: GitHubSha,
  repositoryReadToken: Schema.NonEmptyString,
});

export const RunnerJobResponse = Schema.Struct({
  id: Schema.NonEmptyString,
  runId: Schema.NonEmptyString,
  attempt: Schema.Int,
  evidenceId: Schema.optional(Schema.NonEmptyString),
  evidence: Schema.Struct({
    id: Schema.NonEmptyString,
    status: Schema.Literals(['pending', 'complete', 'incomplete']),
  }),
  status: Schema.Literals(['queued', 'running', 'succeeded', 'failed', 'aborted']),
  stage: Schema.Literals(['admission', 'checkout', 'sandbox', 'agent', 'cleanup']),
  sandbox: Schema.Struct({
    cleanup: Schema.Literals(['pending', 'destroyed', 'failed']),
  }),
  result: Schema.optional(RunnerReviewResult),
  failure: Schema.optional(
    Schema.Struct({
      reason: Schema.Literals([
        'checkout',
        'agent',
        'timeout',
        'invalid-output',
        'evidence',
        'cleanup',
      ]),
      cause: Schema.optional(RunnerFailureCause),
    }),
  ),
});

const EvidenceSize = Schema.Int.check(
  Schema.makeFilter((size) => size >= 0, { expected: 'non-negative evidence size' }),
);
const EvidenceSha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/i));
export const RunnerEvidenceField = Schema.Struct({
  content: Schema.String,
  size: EvidenceSize,
  sha256: EvidenceSha256,
});
const RequiredRunnerEvidenceField = Schema.Struct({
  content: Schema.NonEmptyString,
  size: EvidenceSize,
  sha256: EvidenceSha256,
});
const RunnerEvidenceExport = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  content: RequiredRunnerEvidenceField,
});
const IncompleteRunnerEvidence = Schema.Struct({
  id: Schema.NonEmptyString,
  status: Schema.Literals(['complete', 'incomplete']),
  manifest: RunnerEvidenceField,
  opencodeJsonl: RunnerEvidenceField,
  opencodeStderr: RunnerEvidenceField,
  validatedReview: Schema.optional(RunnerEvidenceField),
  opencodeSessionList: Schema.optional(RunnerEvidenceField),
  opencodeExport: Schema.optional(RunnerEvidenceExport),
});
const CompleteRunnerEvidence = Schema.Struct({
  id: Schema.NonEmptyString,
  status: Schema.Literal('complete'),
  manifest: RequiredRunnerEvidenceField,
  opencodeJsonl: RequiredRunnerEvidenceField,
  opencodeStderr: RunnerEvidenceField,
  validatedReview: RequiredRunnerEvidenceField,
  opencodeSessionList: RequiredRunnerEvidenceField,
  opencodeExport: RunnerEvidenceExport,
});
const CallbackTimestamps = Schema.Struct({
  executionStartedAt: Schema.NonEmptyString,
  submissionCompletedAt: Schema.NonEmptyString,
  cleanupCompletedAt: Schema.NonEmptyString,
});
const PartialCallbackTimestamps = Schema.Struct({
  executionStartedAt: Schema.optional(Schema.NonEmptyString),
  submissionCompletedAt: Schema.optional(Schema.NonEmptyString),
  cleanupCompletedAt: Schema.optional(Schema.NonEmptyString),
});
const CallbackFailure = Schema.Struct({
  reason: Schema.Literals([
    'checkout',
    'agent',
    'timeout',
    'invalid-output',
    'evidence',
    'cleanup',
  ]),
  cause: Schema.optional(RunnerFailureCause),
});
const CallbackIdentity = {
  usage: Schema.optionalKey(ModelUsageSummary),
  id: Schema.NonEmptyString,
  runId: Schema.NonEmptyString,
  attempt: Schema.Int,
  stage: Schema.Literals(['admission', 'checkout', 'sandbox', 'agent', 'cleanup']),
};
const CallbackSandbox = Schema.Struct({
  cleanup: Schema.Literals(['pending', 'destroyed', 'failed']),
});

export const RunnerProgressStage = Schema.Literals([
  'checkout',
  'sandbox',
  'agent',
  'evidence',
  'cleanup',
]);
export type RunnerProgressStage = typeof RunnerProgressStage.Type;

export const RunnerProgressMilestone = Schema.Struct({
  stage: RunnerProgressStage,
  startedAt: Schema.NonEmptyString,
});
export type RunnerProgressMilestone = typeof RunnerProgressMilestone.Type;

export const RunnerProgressMilestones = Schema.Array(RunnerProgressMilestone).pipe(
  Schema.check(Schema.isMaxLength(5)),
);

export const RunnerProgressSnapshot = Schema.Struct({
  sequence: Schema.Int.check(Schema.isGreaterThan(0)),
  stage: RunnerProgressStage,
  milestones: RunnerProgressMilestones,
});
export type RunnerProgressSnapshot = typeof RunnerProgressSnapshot.Type;

export const RunnerProgressReport = Schema.Struct({
  runId: Schema.NonEmptyString,
  id: Schema.NonEmptyString,
  attempt: Schema.Int,
  sequence: Schema.Int.check(Schema.isGreaterThan(0)),
  stage: RunnerProgressStage,
  milestones: RunnerProgressMilestones,
});
export type RunnerProgressReport = typeof RunnerProgressReport.Type;

const SuccessfulRunnerResultCallback = Schema.Struct({
  ...CallbackIdentity,
  status: Schema.Literal('succeeded'),
  evidence: CompleteRunnerEvidence,
  timestamps: CallbackTimestamps,
  sandbox: Schema.Struct({ cleanup: Schema.Literal('destroyed') }),
  result: RunnerReviewResult,
  lifecycle: Schema.optional(RunnerProgressSnapshot),
});
const FailedRunnerResultCallback = Schema.Struct({
  ...CallbackIdentity,
  status: Schema.Literal('failed'),
  evidence: IncompleteRunnerEvidence,
  timestamps: PartialCallbackTimestamps,
  sandbox: CallbackSandbox,
  failure: CallbackFailure,
  lifecycle: Schema.optional(RunnerProgressSnapshot),
});
const AbortedRunnerResultCallback = Schema.Struct({
  ...CallbackIdentity,
  status: Schema.Literal('aborted'),
  evidence: IncompleteRunnerEvidence,
  timestamps: PartialCallbackTimestamps,
  sandbox: CallbackSandbox,
  lifecycle: Schema.optional(RunnerProgressSnapshot),
});

export const RunnerResultCallback = Schema.Union([
  SuccessfulRunnerResultCallback,
  FailedRunnerResultCallback,
  AbortedRunnerResultCallback,
]);

export type RunnerJobInput = typeof RunnerJobInput.Type;
export type RunnerJobResponse = typeof RunnerJobResponse.Type;
export type RunnerResultCallback = typeof RunnerResultCallback.Type;

const PullRequestAction = Schema.Literals([
  'opened',
  'reopened',
  'synchronize',
  'ready_for_review',
]);

export const PullRequestFacts = Schema.Struct({
  repositoryVisibility: Schema.Literals(['private', 'public']),
  baseRepositoryId: Schema.Int,
  headRepositoryId: Schema.Int,
  draft: Schema.Boolean,
  baseSha: GitHubSha,
  headSha: GitHubSha,
  baseRef: Schema.optional(Schema.NonEmptyString),
  headRef: Schema.optional(Schema.NonEmptyString),
});

const PullRequestReviewEvent = Schema.Struct({
  deliveryId: Schema.String,
  event: Schema.Literal('pull_request'),
  action: PullRequestAction,
  repositoryId: Schema.Int,
  pullRequestNumber: Schema.Int,
  installationId: Schema.Int,
  repositoryVisibility: Schema.Literals(['private', 'public']),
  baseRepositoryId: Schema.Int,
  headRepositoryId: Schema.Int,
  draft: Schema.Boolean,
  baseSha: GitHubSha,
  headSha: GitHubSha,
  baseRef: Schema.optional(Schema.NonEmptyString),
  headRef: Schema.optional(Schema.NonEmptyString),
});

const IssueCommentReviewEvent = Schema.Struct({
  deliveryId: Schema.String,
  event: Schema.Literal('issue_comment'),
  action: Schema.Literal('created'),
  repositoryId: Schema.Int,
  pullRequestNumber: Schema.Int,
  installationId: Schema.Int,
  commentId: Schema.Int,
  commenterLogin: Schema.NonEmptyString,
  command: Schema.Literal('/ai-review'),
});

const CheckRunRerequestedEvent = Schema.Struct({
  deliveryId: Schema.String,
  event: Schema.Literal('check_run'),
  action: Schema.Literal('rerequested'),
  repositoryId: Schema.Int,
  installationId: Schema.Int,
  checkRunId: Schema.Int,
  externalRunId: Schema.NullOr(Schema.NonEmptyString),
  senderLogin: Schema.NonEmptyString,
});

const CheckSuiteRerequestedEvent = Schema.Struct({
  deliveryId: Schema.String,
  event: Schema.Literal('check_suite'),
  action: Schema.Literal('rerequested'),
  repositoryId: Schema.Int,
  installationId: Schema.Int,
  checkSuiteId: Schema.Int,
  senderLogin: Schema.NonEmptyString,
});

export const ReviewEvent = Schema.Union([
  PullRequestReviewEvent,
  IssueCommentReviewEvent,
  CheckRunRerequestedEvent,
  CheckSuiteRerequestedEvent,
]);

export const MetadataInvalidationReasons = [
  'repository_private',
  'repository_removed',
  'installation_removed',
] as const;

export const MetadataInvalidationEvent = Schema.Struct({
  deliveryId: Schema.String,
  event: Schema.Literal('metadata'),
  reason: Schema.Literals(MetadataInvalidationReasons),
  installationId: Schema.Int,
  repositoryIds: Schema.Array(Schema.Int),
  visibility: Schema.Literals(['private', 'unknown']),
});

export type MetadataInvalidationEvent = typeof MetadataInvalidationEvent.Type;

export type ReviewEventName = ReviewEvent['event'];

export type ReviewEvent = typeof ReviewEvent.Type;
export type PullRequestFacts = typeof PullRequestFacts.Type;

// Fixed allowlist of Node process spawn error codes that Runner diagnostics may
// report. Codes are decoded with Schema and never carry the raw error message.
export const RunnerProcessErrorCode = Schema.Literals(['ENOENT', 'EACCES', 'EPERM']);
export type RunnerProcessErrorCode = typeof RunnerProcessErrorCode.Type;

export type OperationalLogEvent =
  | {
      readonly phase: 'ingress';
      readonly outcome: 'accepted';
      readonly deliveryId: string;
      readonly event: ReviewEventName | 'metadata';
    }
  | {
      readonly phase: 'ingress';
      readonly outcome: 'rejected';
      readonly reason: 'invalid_signature' | 'invalid_webhook';
    }
  | {
      readonly phase: 'ingress';
      readonly outcome: 'ignored';
      readonly deliveryId?: string;
      readonly event?: ReviewEventName | 'metadata';
      readonly reason:
        | 'unsupported_event'
        | 'unsupported_action'
        | 'non_pull_request_issue'
        | 'bot_pull_request'
        | 'unapproved_installation';
    }
  | {
      readonly phase: 'ingress';
      readonly outcome: 'retryable';
      readonly deliveryId?: string;
      readonly event?: ReviewEventName | 'metadata';
      readonly reason: 'core_unavailable';
    }
  | {
      readonly phase: 'core';
      readonly outcome: 'scheduled';
      readonly deliveryId: string;
      readonly runId: string;
    }
  | {
      readonly phase: 'core';
      readonly outcome: 'metadata_refresh';
      readonly dispatched: number;
      readonly failed: number;
      readonly skipped: 'unavailable' | 'cooldown' | '';
    }
  | {
      readonly phase: 'core';
      readonly outcome: 'retryable';
      readonly deliveryId: string;
      readonly reason:
        | 'pull_request_facts_uncertain'
        | 'commenter_permission_uncertain'
        | 'check_lookup_uncertain'
        | 'state_failure'
        | 'scheduling_failure';
    }
  | {
      readonly phase: 'publication';
      readonly outcome: 'published';
      readonly runId: string;
    }
  | {
      readonly phase: 'publication';
      readonly outcome: 'superseded';
      readonly runId: string;
    }
  | {
      readonly phase: 'publication';
      readonly outcome: 'failed';
      readonly runId: string;
      readonly reason:
        | 'invalid_output'
        | 'marker_lookup_failed'
        | 'publication_uncertain'
        | 'completion_failed';
    }
  | {
      readonly phase: 'runner';
      readonly outcome: 'command';
      readonly runId: string;
      readonly stage: 'checkout' | 'sandbox' | 'cleanup';
      readonly command: string;
      readonly exitCode: number;
      readonly timedOut: boolean;
      readonly truncated: boolean;
      readonly stderrTruncated: boolean;
      readonly streamError: boolean;
      readonly abortRequested: boolean;
      // True when the process failed to spawn or its promise threw rather than
      // returning an exit status; errorCode is a fixed allowlisted Node code,
      // never a raw message.
      readonly processError: boolean;
      readonly errorCode?: RunnerProcessErrorCode;
      readonly stderr?: string;
    }
  | {
      readonly phase: 'runner';
      readonly outcome: 'callback';
      readonly runId: string;
      readonly jobId: string;
      readonly attempt: number;
      readonly result: 'accepted' | 'http-error' | 'timeout' | 'transport-error';
      readonly status?: number;
    }
  | {
      readonly phase: 'runner';
      readonly outcome: 'callback-delivery-failed';
      readonly runId: string;
      readonly jobId: string;
    }
  | {
      readonly phase: 'runner';
      readonly outcome: 'claim';
      readonly reason:
        | 'http-error'
        | 'timeout'
        | 'transport-error'
        | 'invalid-response'
        | 'oversized-response'
        | 'malformed-response'
        | 'admission-rejected'
        | 'grant-recovery-failed'
        | 'runtime-preflight-failed';
      readonly status?: number;
      readonly pollingHalted: boolean;
    }
  | {
      readonly phase: 'runner';
      readonly outcome: 'terminal';
      readonly runId: string;
      readonly jobId: string;
      readonly status: 'succeeded' | 'failed' | 'aborted';
      readonly cleanup: 'pending' | 'destroyed' | 'failed';
    };

export const sanitizeOperationalLogIdentifier = (value: string | undefined) => {
  if (value === undefined) return undefined;
  return value.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(value) ? value : 'redacted';
};

export const sanitizeOperationalLogEvent = (event: OperationalLogEvent): OperationalLogEvent => {
  if (event.phase === 'ingress') {
    return 'deliveryId' in event && event.deliveryId !== undefined
      ? { ...event, deliveryId: sanitizeOperationalLogIdentifier(event.deliveryId) ?? 'redacted' }
      : event;
  }

  if (event.phase === 'core') {
    if (event.outcome === 'metadata_refresh') return event;
    return event.outcome === 'scheduled'
      ? {
          ...event,
          deliveryId: sanitizeOperationalLogIdentifier(event.deliveryId) ?? 'redacted',
          runId: sanitizeOperationalLogIdentifier(event.runId) ?? 'redacted',
        }
      : {
          ...event,
          deliveryId: sanitizeOperationalLogIdentifier(event.deliveryId) ?? 'redacted',
        };
  }

  if (event.phase === 'publication') {
    return { ...event, runId: sanitizeOperationalLogIdentifier(event.runId) ?? 'redacted' };
  }

  if (event.phase === 'runner') {
    if (event.outcome === 'claim') return event;
    return {
      ...event,
      runId: sanitizeOperationalLogIdentifier(event.runId) ?? 'redacted',
      ...('jobId' in event
        ? { jobId: sanitizeOperationalLogIdentifier(event.jobId) ?? 'redacted' }
        : {}),
    };
  }

  return event;
};

export interface OperationalLog {
  readonly record: (event: OperationalLogEvent) => void | Promise<void>;
}

export const PublicExecutionStage = Schema.Literals([
  'checkout',
  'sandbox',
  'agent',
  'evidence',
  'cleanup',
]);
export type PublicExecutionStage = typeof PublicExecutionStage.Type;

export const PublicCleanupStatus = Schema.Literals(['pending', 'destroyed', 'failed', 'unknown']);
export type PublicCleanupStatus = typeof PublicCleanupStatus.Type;

export const PublicTaskStatus = Schema.Literals(['scheduled', 'completed', 'failed', 'superseded']);
export type PublicTaskStatus = typeof PublicTaskStatus.Type;

export const PublicTaskDispatch = Schema.NullOr(Schema.Literals(['queued', 'claimed']));
export type PublicTaskDispatch = typeof PublicTaskDispatch.Type;

export const PublicTaskIdentity = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('public'),
    repositoryFullName: Schema.NonEmptyString,
    pullRequestNumber: Schema.Int,
    pullRequestUrl: Schema.NonEmptyString,
    expiresAt: Schema.NonEmptyString,
    baseRef: Schema.NullOr(Schema.NonEmptyString),
    headRef: Schema.NullOr(Schema.NonEmptyString),
    baseSha: Schema.NullOr(GitHubSha),
    headSha: Schema.NullOr(GitHubSha),
  }),
  Schema.Struct({ kind: Schema.Literal('anonymous') }),
]);
export type PublicTaskIdentity = typeof PublicTaskIdentity.Type;

export const PublicTaskFailure = Schema.Struct({
  phase: Schema.Literals([
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
  ]),
  reason: Schema.Literals([
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
    'unknown',
  ]),
});
export type PublicTaskFailure = typeof PublicTaskFailure.Type;

export const PublicProcessing = Schema.NullOr(Schema.Literals(['received', 'publishing']));
export type PublicProcessing = typeof PublicProcessing.Type;

export const PublicTaskState = Schema.Struct({
  decision: Schema.NullOr(ReviewDecision),
  runId: Schema.NonEmptyString,
  status: PublicTaskStatus,
  dispatch: PublicTaskDispatch,
  stage: Schema.NullOr(PublicExecutionStage),
  processing: PublicProcessing,
  identity: PublicTaskIdentity,
  receivedAt: Schema.NonEmptyString,
  claimedAt: Schema.NullOr(Schema.NonEmptyString),
  terminalAt: Schema.NullOr(Schema.NonEmptyString),
  executionStartedAt: Schema.NullOr(Schema.NonEmptyString),
  submissionCompletedAt: Schema.NullOr(Schema.NonEmptyString),
  cleanupCompletedAt: Schema.NullOr(Schema.NonEmptyString),

  resultReceivedAt: Schema.NullOr(Schema.NonEmptyString),
  publicationStartedAt: Schema.NullOr(Schema.NonEmptyString),
  lastProgressAt: Schema.NullOr(Schema.NonEmptyString),
  queueWaitMs: Schema.NullOr(Schema.Int),
  totalDurationMs: Schema.NullOr(Schema.Int),
  cleanup: PublicCleanupStatus,
  failure: Schema.NullOr(PublicTaskFailure),
});
export type PublicTaskState = typeof PublicTaskState.Type;

export const PublicOverview = Schema.Struct({
  generatedAt: Schema.NonEmptyString,
  counts: Schema.Struct({
    queued: Schema.Int,
    claimed: Schema.Int,
    publishedLast24h: Schema.Int,
    failedLast24h: Schema.Int,
  }),
  cleanupAttention: Schema.Int,
});
export type PublicOverview = typeof PublicOverview.Type;

export const PublicHistoryPage = Schema.Struct({
  generatedAt: Schema.NonEmptyString,
  tasks: Schema.Array(PublicTaskState),
  nextCursor: Schema.NullOr(Schema.NonEmptyString),
});
export type PublicHistoryPage = typeof PublicHistoryPage.Type;

export const PublicMilestone = Schema.Struct({
  stage: PublicExecutionStage,
  startedAt: Schema.NonEmptyString,
});
export type PublicMilestone = typeof PublicMilestone.Type;

export const PublicTaskDetail = Schema.Struct({
  usage: Schema.optionalKey(Schema.NullOr(ModelUsageSummary)),
  generatedAt: Schema.NonEmptyString,
  task: PublicTaskState,
  milestones: Schema.Array(PublicMilestone),
  processingMilestones: Schema.Array(
    Schema.Struct({
      stage: Schema.Literals(['received', 'publishing']),
      startedAt: Schema.NonEmptyString,
    }),
  ),
});
export type PublicTaskDetail = typeof PublicTaskDetail.Type;
