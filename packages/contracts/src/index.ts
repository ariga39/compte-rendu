import { Schema } from 'effect';

export const REVIEW_ATTEMPT_BUDGET_MS = 30 * 60 * 1000;
export const REVIEW_MAX_ATTEMPTS = 1;
export const REVIEW_CORE_DEADLINE_MS = 35 * 60 * 1000;
export const REVIEW_WORKFLOW_TIMEOUT = '40 minutes' as const;

export interface WorkerEntrypoint<Env = unknown> {
  fetch(request: Request, env?: Env): Response | Promise<Response>;
}

export interface CoreServiceBinding {
  fetch(request: Request): Response | Promise<Response>;
}

export const GitHubSha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/i));

export const ReviewResult = Schema.Struct({
  findings: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      line: Schema.Int,
      message: Schema.String,
    }),
  ),
  summary: Schema.String,
});

export type ReviewResult = typeof ReviewResult.Type;

export const RunnerFailureCause = Schema.Literals([
  'process-exit',
  'timeout',
  'output-truncated',
  'malformed-jsonl',
  'agent-error',
  'zero-results',
  'multiple-results',
  'result-schema-failure',
]);

export const RunnerJobInput = Schema.Struct({
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
  result: Schema.optional(ReviewResult),
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

export type RunnerJobInput = typeof RunnerJobInput.Type;
export type RunnerJobResponse = typeof RunnerJobResponse.Type;

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

export const ReviewEvent = Schema.Union([PullRequestReviewEvent, IssueCommentReviewEvent]);

export type ReviewEvent = typeof ReviewEvent.Type;
export type PullRequestFacts = typeof PullRequestFacts.Type;

export type OperationalLogEvent =
  | {
      readonly phase: 'ingress';
      readonly outcome: 'accepted';
      readonly deliveryId: string;
      readonly event: 'pull_request' | 'issue_comment';
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
      readonly event?: 'pull_request' | 'issue_comment';
      readonly reason:
        | 'unsupported_event'
        | 'unsupported_action'
        | 'non_pull_request_issue'
        | 'unapproved_installation';
    }
  | {
      readonly phase: 'ingress';
      readonly outcome: 'retryable';
      readonly deliveryId?: string;
      readonly event?: 'pull_request' | 'issue_comment';
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
      readonly outcome: 'retryable';
      readonly deliveryId: string;
      readonly reason:
        | 'pull_request_facts_uncertain'
        | 'commenter_permission_uncertain'
        | 'state_failure'
        | 'scheduling_failure';
    }
  | {
      readonly phase: 'workflow';
      readonly outcome: 'completed';
      readonly runId: string;
    }
  | {
      readonly phase: 'workflow';
      readonly outcome: 'failed';
      readonly runId: string;
      readonly reason: 'runner_failed' | 'publication_failed' | 'execution_failed' | 'step_failed';
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
      readonly stderr?: string;
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

  if (event.phase === 'workflow' || event.phase === 'publication') {
    return { ...event, runId: sanitizeOperationalLogIdentifier(event.runId) ?? 'redacted' };
  }

  if (event.phase === 'runner') {
    return { ...event, runId: sanitizeOperationalLogIdentifier(event.runId) ?? 'redacted' };
  }

  return event;
};

export interface OperationalLog {
  readonly record: (event: OperationalLogEvent) => void | Promise<void>;
}
