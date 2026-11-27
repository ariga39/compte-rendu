export { canonicalDashboardOrigin } from './dashboard-origin.ts';
export {
  readBoundedBody,
  readBoundedRequestBytes,
  readBoundedRequestBody,
} from './read-request-body.ts';
import { Schema } from 'effect';
import { ModelUsageSummary } from './model-usage.ts';
import { EffortName, FrozenRouteEffort, ModelRouteId } from './effort.ts';
export { MODEL_USAGE_ROW_LIMIT, ModelUsageSummary } from './model-usage.ts';
export * from './effort.ts';
export * from './stream.ts';
export * from './usage.ts';

export const RETRY_REVIEW_ACTION = 'retry_review';
export const DEFAULT_REVIEW_NAME = 'Compte-rendu review';
export const PublicDashboardConfig = Schema.Struct({ name: Schema.String });

export const RUNNER_LLM_CONTROL_TIMEOUT_MS = 5000;
export const REVIEW_ATTEMPT_BUDGET_MS = 90 * 60 * 1000;

/**
 * Claim and HEAD responses carry the deployment's desired Runner concurrency here,
 * or RUNNER_CONCURRENCY_DEFAULT for an explicit D1 clear. A missing header
 * means the read was unavailable, so a Runner must keep its current target.
 */
export const RUNNER_CONCURRENCY_HEADER = 'x-compte-rendu-concurrency';
/**
 * An explicit D1 clear returns this sentinel so a Runner can distinguish it
 * from a transient missing header, which must leave the current target alone.
 */
export const RUNNER_CONCURRENCY_DEFAULT = 'default';
export const RunnerDeadline = Schema.Literals(['claim', 'credential']);
export type RunnerDeadline = typeof RunnerDeadline.Type;

export const ModelProfile = Schema.Literals(['chat', 'responses']);
export type ModelProfile = typeof ModelProfile.Type;
export const ModelRouteLimit = Schema.Struct({
  context: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  output: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
}).check(
  Schema.makeFilter((limit) => limit.context !== undefined || limit.output !== undefined, {
    expected: 'at least one model limit',
  }),
);
export type ModelRouteLimit = typeof ModelRouteLimit.Type;

const ModelMetadataText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
const ModelMetadataList = Schema.Array(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
).check(Schema.isMaxLength(64));
const ModelMetadataCostValue = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
export const ModelRouteMetadata = Schema.Struct({
  name: Schema.optionalKey(ModelMetadataText),
  family: Schema.optionalKey(ModelMetadataText),
  type: Schema.optionalKey(Schema.Literal('chat')),
  releaseDate: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}(-\d{2})?$/))),
  capabilities: Schema.optionalKey(
    Schema.Struct({
      tools: Schema.optionalKey(Schema.Boolean),
      freeform: Schema.optionalKey(ModelMetadataList),
      input: Schema.optionalKey(ModelMetadataList),
      output: Schema.optionalKey(ModelMetadataList),
      reasoning: Schema.optionalKey(
        Schema.Struct({
          supported: Schema.optionalKey(Schema.Boolean),
          toggle: Schema.optionalKey(Schema.Boolean),
          effort: Schema.optionalKey(ModelMetadataList),
          budget: Schema.optionalKey(
            Schema.Struct({
              min: Schema.optionalKey(ModelMetadataCostValue),
              max: Schema.optionalKey(ModelMetadataCostValue),
            }),
          ),
        }),
      ),
      temperature: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  cost: Schema.optionalKey(
    Schema.Struct({
      input: Schema.optionalKey(ModelMetadataCostValue),
      output: Schema.optionalKey(ModelMetadataCostValue),
      cache: Schema.optionalKey(
        Schema.Struct({
          read: Schema.optionalKey(ModelMetadataCostValue),
          write: Schema.optionalKey(ModelMetadataCostValue),
        }),
      ),
    }),
  ),
});
export type ModelRouteMetadata = typeof ModelRouteMetadata.Type;

export const ModelRouteDescriptor = Schema.Struct({
  routeId: ModelRouteId,
  profile: ModelProfile,
  limit: Schema.optionalKey(ModelRouteLimit),
  metadata: Schema.optionalKey(ModelRouteMetadata),
});
export type ModelRouteDescriptor = typeof ModelRouteDescriptor.Type;

export const ReviewModelSelection = Schema.Struct({
  reviewers: Schema.Array(ModelRouteId).check(
    Schema.isMinLength(1),
    Schema.makeFilter((routes) => new Set(routes).size === routes.length, {
      expected: 'distinct reviewer routes',
    }),
  ),
  synthesis: ModelRouteId,
  // Operator-facing names only. Parameters live in the internal effort snapshot.
  efforts: Schema.optionalKey(Schema.Record(ModelRouteId, EffortName)),
});
export type ReviewModelSelection = typeof ReviewModelSelection.Type;
export const ReviewConfiguration = Schema.Struct({
  revision: Schema.Natural,
  selection: Schema.NullOr(ReviewModelSelection),
  // Frozen at admission from the trusted catalog; omitted for legacy runs.
  efforts: Schema.optionalKey(Schema.Array(FrozenRouteEffort)),
});
export type ReviewConfiguration = typeof ReviewConfiguration.Type;

export const GitHubSha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/i));

export const MAX_REVIEW_RESULT_BYTES = 8 * 1024 * 1024;
export const MAX_WEBHOOK_BYTES = 256 * 1024;
export const MAX_RUNNER_CALLBACK_BYTES = 32 * 1024 * 1024;
export const MAX_RUNNER_EVIDENCE_BYTES = 32 * 1024 * 1024;

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
  'upstream-error',
]);

const RunnerHttpStatus = Schema.Int.check(Schema.isBetween({ minimum: 400, maximum: 599 }));

export const RunnerJobInput = Schema.Struct({
  claimDeadlineAt: Schema.optionalKey(Schema.Natural),
  repositoryReadTokenExpiresAt: Schema.optionalKey(Schema.Natural),
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
  result: Schema.optional(StructuredReviewResult),
  failure: Schema.optional(
    Schema.Struct({
      reason: Schema.Literals([
        'checkout',
        'agent',
        'upstream',
        'timeout',
        'invalid-output',
        'evidence',
        'cleanup',
        'configuration',
      ]),
      cause: Schema.optional(RunnerFailureCause),
      deadline: Schema.optional(RunnerDeadline),
      httpStatus: Schema.optional(RunnerHttpStatus),
    }),
  ),
});

const EvidenceSize = Schema.Int.check(
  Schema.makeFilter((size) => size >= 0, { expected: 'non-negative evidence size' }),
);
const EvidenceSha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/i));
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
    'upstream',
    'timeout',
    'invalid-output',
    'evidence',
    'cleanup',
    'configuration',
  ]),
  cause: Schema.optional(RunnerFailureCause),
  deadline: Schema.optional(RunnerDeadline),
  httpStatus: Schema.optional(RunnerHttpStatus),
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

export const REVIEW_PROGRESS_STAGES = [
  'checkout',
  'sandbox',
  'agent',
  'evidence',
  'cleanup',
] as const;

export const RunnerProgressStage = Schema.Literals(REVIEW_PROGRESS_STAGES);
export type RunnerProgressStage = typeof RunnerProgressStage.Type;

/**
 * A backend identifier recorded with a job. New backends can appear without a
 * contract change; Runner startup decides which identifiers it can execute.
 */
export const SandboxRuntimeKind = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,31}$/));
export type SandboxRuntimeKind = Schema.Schema.Type<typeof SandboxRuntimeKind>;

export const RunnerProgressMilestone = Schema.Struct({
  stage: RunnerProgressStage,
  runtime: Schema.optionalKey(SandboxRuntimeKind),
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

export type RunnerJobInput = typeof RunnerJobInput.Type;
export type RunnerJobResponse = typeof RunnerJobResponse.Type;

const OptionalProgressSnapshot = { lifecycle: Schema.optional(RunnerProgressSnapshot) };
const RunnerEvidenceReference = Schema.Struct({
  id: Schema.NonEmptyString,
  status: Schema.Literals(['complete', 'incomplete']),
});
const CompleteRunnerEvidenceReference = Schema.Struct({
  id: Schema.NonEmptyString,
  status: Schema.Literal('complete'),
});
const V2CallbackIdentity = {
  version: Schema.Literal(2),
  ...CallbackIdentity,
  baseSha: GitHubSha,
  headSha: GitHubSha,
};
const SuccessfulRunnerResultCallbackV2 = Schema.Struct({
  ...V2CallbackIdentity,
  status: Schema.Literal('succeeded'),
  evidence: CompleteRunnerEvidenceReference,
  timestamps: CallbackTimestamps,
  sandbox: Schema.Struct({ cleanup: Schema.Literal('destroyed') }),
  result: StructuredReviewResult,
  ...OptionalProgressSnapshot,
});
const FailedRunnerResultCallbackV2 = Schema.Struct({
  ...V2CallbackIdentity,
  status: Schema.Literal('failed'),
  evidence: RunnerEvidenceReference,
  timestamps: PartialCallbackTimestamps,
  sandbox: CallbackSandbox,
  failure: CallbackFailure,
  ...OptionalProgressSnapshot,
});
const AbortedRunnerResultCallbackV2 = Schema.Struct({
  ...V2CallbackIdentity,
  status: Schema.Literal('aborted'),
  evidence: RunnerEvidenceReference,
  timestamps: PartialCallbackTimestamps,
  sandbox: CallbackSandbox,
  ...OptionalProgressSnapshot,
});

/**
 * The slim terminal callback. It is the publication authority; diagnostic
 * artifacts travel separately through `RunnerEvidenceUpload`.
 */
export const RunnerResultCallbackV2 = Schema.Union([
  SuccessfulRunnerResultCallbackV2,
  FailedRunnerResultCallbackV2,
  AbortedRunnerResultCallbackV2,
]);

/** The only terminal callback identity Core accepts after the v1 cleanup. */
export const RunnerTerminalCallback = RunnerResultCallbackV2;

export type RunnerResultCallbackV2 = typeof RunnerResultCallbackV2.Type;
export type RunnerTerminalCallback = typeof RunnerTerminalCallback.Type;

const UploadedEvidenceField = Schema.Struct({
  content: Schema.String,
  size: EvidenceSize,
  sha256: EvidenceSha256,
  truncated: Schema.optionalKey(Schema.Boolean),
});
const UploadedEvidenceExport = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  content: UploadedEvidenceField,
});

/**
 * Best-effort private diagnostic upload. Truncation is per artifact and never
 * changes the review result or terminal callback.
 */
export const RunnerEvidenceUpload = Schema.Struct({
  version: Schema.Literal(2),
  id: Schema.NonEmptyString,
  runId: Schema.NonEmptyString,
  attempt: Schema.Int,
  evidenceId: Schema.NonEmptyString,
  evidence: Schema.Struct({
    id: Schema.optionalKey(Schema.NonEmptyString),
    status: Schema.Literals(['complete', 'incomplete']),
    manifest: UploadedEvidenceField,
    opencodeJsonl: UploadedEvidenceField,
    opencodeStderr: UploadedEvidenceField,
    validatedReview: Schema.optionalKey(UploadedEvidenceField),
    opencodeSessionList: Schema.optionalKey(UploadedEvidenceField),
    opencodeExport: Schema.optionalKey(UploadedEvidenceExport),
  }),
  timestamps: Schema.optionalKey(PartialCallbackTimestamps),
});
export type RunnerEvidenceUpload = typeof RunnerEvidenceUpload.Type;

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

export const ReviewResetOperation = Schema.Literals([
  'list_reviews',
  'read_pull_request',
  'dismiss_review',
  'confirm_dismissal',
]);
export type ReviewResetOperation = typeof ReviewResetOperation.Type;

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
      readonly outcome: 'retry_feedback_failed';
      readonly deliveryId: string;
    }
  | {
      readonly phase: 'core';
      readonly outcome: 'metadata_refresh';
      readonly dueAtStart: number | null;
      readonly oldestDueAgeMs: number | null;
      readonly durationMs: number;
      readonly budgetExhausted: boolean;
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
        | 'scheduling_failure'
        | 'review_reset_failed';
      readonly operation?: ReviewResetOperation;
      readonly status?: typeof RunnerHttpStatus.Type;
    }
  | {
      readonly phase: 'relay';
      readonly outcome: 'refresh_failed';
    }
  | {
      readonly phase: 'publication';
      readonly outcome: 'reconciliation_incomplete';
      readonly runId: string;
      readonly reason: 'state' | 'evidence' | 'publication' | 'check';
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
      readonly phase: 'cancellation';
      readonly outcome: 'delivery_failed';
      readonly runId: string;
      readonly kind: 'runner-stop' | 'check-cancel';
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
        | 'sandbox-recovery-failed'
        | 'runtime-preflight-failed'
        | 'backend-outage';
      readonly status?: number;
      readonly staged?: boolean;
      readonly pollingHalted: boolean;
    }
  | {
      readonly phase: 'runner';
      readonly outcome: 'grant';
      readonly runId: string;
      readonly jobId: string;
      readonly attempt: number;
      readonly reason: 'invalid-response' | 'http-error' | 'timeout' | 'transport-error';
      readonly status?: number;
    }
  | {
      readonly phase: 'runner';
      readonly outcome: 'sandbox-recovery';
      readonly recovered: number;
      readonly blocked: number;
      readonly failures: ReadonlyArray<{
        readonly jobId: string;
        readonly sandboxName: string;
        readonly step: string;
        readonly command?: string;
        readonly exitCode?: number;
        readonly timedOut?: boolean;
        readonly truncated?: boolean;
        readonly stderrTruncated?: boolean;
        readonly streamError?: boolean;
        readonly processError?: boolean;
        readonly errorCode?: RunnerProcessErrorCode;
      }>;
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

  if (event.phase === 'relay') return event;

  if (event.phase === 'publication') {
    return { ...event, runId: sanitizeOperationalLogIdentifier(event.runId) ?? 'redacted' };
  }

  if (event.phase === 'cancellation') {
    return { ...event, runId: sanitizeOperationalLogIdentifier(event.runId) ?? 'redacted' };
  }

  if (event.phase === 'runner') {
    if (event.outcome === 'claim') return event;
    if (event.outcome === 'sandbox-recovery') {
      return {
        ...event,
        failures: event.failures.map((failure) => ({
          ...failure,
          jobId: sanitizeOperationalLogIdentifier(failure.jobId) ?? 'redacted',
          sandboxName: sanitizeOperationalLogIdentifier(failure.sandboxName) ?? 'redacted',
        })),
      };
    }
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

export const createCloudflareOperationalLog = (
  sink: Pick<Console, 'log'> = console,
): OperationalLog => ({
  record: (event: OperationalLogEvent) => {
    sink.log(sanitizeOperationalLogEvent(event));
  },
});

export const PublicExecutionStage = Schema.Literals(REVIEW_PROGRESS_STAGES);
export type PublicExecutionStage = typeof PublicExecutionStage.Type;

export const PublicCleanupStatus = Schema.Literals(['pending', 'destroyed', 'failed', 'unknown']);
export type PublicCleanupStatus = typeof PublicCleanupStatus.Type;

export const PublicTaskStatus = Schema.Literals([
  'scheduled',
  'completed',
  'failed',
  'superseded',
  'cancelled',
]);
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
  ]),
  reason: Schema.Literals([
    'checkout',
    'sandbox',
    'agent',
    'upstream',
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
  ]),
  httpStatus: Schema.optional(RunnerHttpStatus),
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
  queueBlockReason: Schema.optionalKey(Schema.NullOr(Schema.Literal('cleanup'))),
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
    cancelledLast24h: Schema.Int,
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

export const PublicDashboardSnapshot = Schema.Struct({
  ...PublicOverview.fields,
  ...PublicHistoryPage.fields,
});
export type PublicDashboardSnapshot = typeof PublicDashboardSnapshot.Type;

export const PublicMilestone = Schema.Struct({
  stage: PublicExecutionStage,
  runtime: Schema.optionalKey(SandboxRuntimeKind),
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
