import { Schema } from 'effect';

export interface WorkerEntrypoint<Env = unknown> {
  fetch(request: Request, env?: Env): Response | Promise<Response>;
}

export interface CoreServiceBinding {
  fetch(request: Request): Response | Promise<Response>;
}

export const GitHubSha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/i));

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
      readonly reason: 'unsupported_event' | 'unsupported_action' | 'non_pull_request_issue';
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
      readonly phase: 'runner';
      readonly outcome: 'succeeded';
      readonly runId: string;
      readonly attempt: number;
      readonly sandboxId: string;
      readonly cleanup: 'sandbox_destroyed_lease_cleared';
    }
  | {
      readonly phase: 'runner';
      readonly outcome: 'failed';
      readonly runId: string;
      readonly attempt: number;
      readonly sandboxId?: string;
      readonly reason: 'lease' | 'checkout' | 'agent' | 'timeout' | 'invalid-output' | 'cleanup';
      readonly retryable: boolean;
      readonly leaseRetained: boolean;
    }
  | {
      readonly phase: 'agent';
      readonly outcome: 'progress';
      readonly stage: 'server' | 'session' | 'prompt';
      readonly sandboxId: string;
    }
  | {
      readonly phase: 'agent';
      readonly outcome: 'completed';
      readonly stage: 'response';
      readonly sandboxId: string;
    }
  | {
      readonly phase: 'agent';
      readonly outcome: 'failed';
      readonly stage: 'server' | 'session' | 'prompt';
      readonly reason: 'session_error' | 'transport_failure';
      readonly sandboxId: string;
    }
  | {
      readonly phase: 'agent';
      readonly outcome: 'aborted';
      readonly stage: 'deadline';
      readonly reason: 'deadline';
      readonly sandboxId: string;
    }
  | {
      readonly phase: 'agent';
      readonly outcome: 'status';
      readonly stage: 'process';
      readonly state: 'running' | 'exited' | 'error';
      readonly sandboxId: string;
    }
  | {
      readonly phase: 'agent';
      readonly outcome: 'status';
      readonly stage: 'session';
      readonly state: 'busy' | 'idle' | 'retry' | 'error';
      readonly sandboxId: string;
    }
  | {
      readonly phase: 'agent';
      readonly outcome: 'activity';
      readonly stage: 'process' | 'session';
      readonly sandboxId: string;
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
      readonly phase: 'lease';
      readonly outcome: 'destroyed';
      readonly runId: string;
      readonly attempt: number;
      readonly sandboxId: string;
    }
  | {
      readonly phase: 'lease';
      readonly outcome: 'deferred';
      readonly runId: string;
      readonly attempt: number;
      readonly sandboxId: string;
      readonly reason: 'invalid' | 'not_due';
    }
  | {
      readonly phase: 'lease';
      readonly outcome: 'failed';
      readonly runId: string;
      readonly attempt: number;
      readonly sandboxId: string;
      readonly reason: 'cleanup_failed';
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

  if (event.phase === 'runner') {
    return {
      ...event,
      runId: sanitizeOperationalLogIdentifier(event.runId) ?? 'redacted',
      ...(event.sandboxId === undefined
        ? {}
        : { sandboxId: sanitizeOperationalLogIdentifier(event.sandboxId) ?? 'redacted' }),
    };
  }

  if (event.phase === 'agent') {
    const sandboxId = sanitizeOperationalLogIdentifier(event.sandboxId) ?? 'redacted';
    if (event.outcome === 'progress') {
      return { phase: 'agent', outcome: 'progress', stage: event.stage, sandboxId };
    }
    if (event.outcome === 'completed') {
      return { phase: 'agent', outcome: 'completed', stage: 'response', sandboxId };
    }
    if (event.outcome === 'failed') {
      return {
        phase: 'agent',
        outcome: 'failed',
        stage: event.stage,
        reason: event.reason,
        sandboxId,
      };
    }
    if (event.outcome === 'aborted') {
      return {
        phase: 'agent',
        outcome: 'aborted',
        stage: 'deadline',
        reason: 'deadline',
        sandboxId,
      };
    }
    return { ...event, sandboxId };
  }

  if (event.phase === 'workflow' || event.phase === 'publication') {
    return { ...event, runId: sanitizeOperationalLogIdentifier(event.runId) ?? 'redacted' };
  }

  return {
    ...event,
    runId: sanitizeOperationalLogIdentifier(event.runId) ?? 'redacted',
    sandboxId: sanitizeOperationalLogIdentifier(event.sandboxId) ?? 'redacted',
  };
};

export interface OperationalLog {
  readonly record: (event: OperationalLogEvent) => void | Promise<void>;
}
