import { DateTime, Effect, Option, Schema } from 'effect';
import {
  PullRequestFacts,
  ReviewEvent,
  ReviewResult,
  GitHubSha,
  type PullRequestFacts as PullRequestFactsType,
  type OperationalLog,
  type OperationalLogEvent,
  type WorkerEntrypoint,
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

export const ReviewJob = Schema.Struct({
  repositoryId: Schema.Int,
  pullRequestNumber: Schema.Int,
  installationId: Schema.Int,
  baseSha: GitHubSha,
  headSha: GitHubSha,
  trigger: Schema.Literals(['automatic', 'manual']),
  commentId: Schema.optional(Schema.Int),
});

export type ReviewJob = typeof ReviewJob.Type;
export type ReviewDisposition =
  | 'rejected'
  | 'ignored'
  | 'awaiting approval'
  | 'scheduled'
  | 'completed'
  | 'failed';

export type ReviewRunStatus = 'scheduled' | 'failed' | 'completed' | 'superseded';
export type ReviewStoredStatus = ReviewDisposition | ReviewRunStatus | 'claiming';
export type ReviewCheckSetupStatus = 'pending' | 'ready' | 'failed';
export const CoreLifecycleFailureReason = Schema.Literals([
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
]);
export type CoreLifecycleFailureReason = typeof CoreLifecycleFailureReason.Type;

export type CoreLifecycleEvent =
  | {
      readonly event: 'review scheduled';
      readonly runId: string;
      readonly trigger: ReviewJob['trigger'];
    }
  | {
      readonly event: 'review claimed';
      readonly runId: string;
      readonly trigger: ReviewJob['trigger'];
      readonly queueWaitMs: number;
    }
  | {
      readonly event: 'review finished';
      readonly runId: string;
      readonly trigger: ReviewJob['trigger'];
      readonly outcome: 'completed' | 'failed' | 'superseded';
      readonly published: boolean;
      readonly totalDurationMs: number;
      readonly queueWaitMs?: number;
      readonly cleanupStatus: 'destroyed' | 'failed' | 'unknown';
      readonly evidenceStatus: 'complete' | 'incomplete' | 'unknown';
      readonly failurePhase?:
        | 'checkout'
        | 'sandbox'
        | 'agent'
        | 'output_validation'
        | 'evidence'
        | 'callback'
        | 'publication'
        | 'cleanup'
        | 'unknown';
      readonly failureReason?: CoreLifecycleFailureReason;
    };

export interface CoreLifecycleLog {
  readonly record: (event: CoreLifecycleEvent) => void | Promise<void>;
}
export interface ReviewOutcome {
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
  runnerJobId?: string;
  runnerAttempt?: number;
  commentId?: number;
  checkRunId?: number;
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
  readonly runId: string;
  readonly jobId: string;
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
  claimNextJob?(input: {
    jobId: string;
    attempt: number;
    occurredAt: string;
  }): Promise<
    | { kind: 'claimed'; runId: string; jobId: string; attempt: number; job: ReviewJob }
    | { kind: 'empty' }
  >;
  markSchedulingFailed(input: { runId: string; occurredAt: string }): Promise<void>;
  recordDelivery: (input: ReviewDeliveryRecord) => Promise<void>;
}

export interface ReviewStateQueries {
  recordEvidence(input: { runId: string; evidence: ReviewEvidenceMetadata }): Promise<boolean>;
  recordRunnerJob(input: { runId: string; jobId: string; attempt: number }): Promise<boolean>;
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
  markRunCompleted(input: { runId: string; occurredAt: string }): Promise<boolean>;
  markRunSuperseded(input: { runId: string; occurredAt: string }): Promise<boolean>;
  completeRunPublication(input: {
    runId: string;
    occurredAt: string;
    fingerprints: readonly string[];
  }): Promise<boolean>;
  claimRunPublication?(input: { runId: string; occurredAt: string }): Promise<boolean>;
  releaseRunPublicationClaim?(input: { runId: string; occurredAt: string }): Promise<boolean>;
  getDeliveryOutcome(deliveryId: string): Promise<ReviewOutcome | undefined>;
  getRunOutcome(runId: string): Promise<ReviewOutcome | undefined>;
}

export type ReviewPublicationStateStore = ReviewStateStore & ReviewStateQueries;

export interface ReviewScheduler {
  schedule(job: ReviewJob, runId: string): Promise<void>;
  cancel?(jobId: string): Promise<void>;
}

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
    repositoryId: number;
    installationId: number;
    checkRunId: number;
    status: 'in_progress' | 'success' | 'failure' | 'cancelled';
  }): Promise<void>;
  getRepositoryUrl?(input: { repositoryId: number; installationId: number }): Promise<unknown>;
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
  }): Promise<unknown>;
  createReview?(input: {
    repositoryId: number;
    pullRequestNumber: number;
    installationId: number;
    payload: ReviewPublicationPayload;
  }): Promise<ReviewPublicationCreateResult>;
}

export interface ReviewPublicationPayload {
  readonly event: 'COMMENT';
  readonly commit_id: GitHubShaValue;
  readonly body: string;
}

export type ReviewPublicationCreateResult =
  | { readonly kind: 'created'; readonly review: unknown }
  | { readonly kind: 'stale'; readonly currentHeadSha: GitHubShaValue };

export interface ReviewCoordinator {
  handleReviewEvent(event: unknown): Promise<ReviewDisposition>;
  completeReview(input: { runId: string; output: unknown }): Promise<ReviewDisposition>;
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
});

const jobForFacts = (
  event: Extract<ReviewEvent, { event: 'issue_comment' }>,
  facts: PullRequestFactsType,
): ReviewJob => ({
  repositoryId: event.repositoryId,
  pullRequestNumber: event.pullRequestNumber,
  installationId: event.installationId,
  baseSha: facts.baseSha,
  headSha: facts.headSha,
  trigger: 'manual',
  commentId: event.commentId,
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
      void Promise.resolve(log.record(event)).catch(() => undefined);
    } catch {
      // Lifecycle capture is best effort and cannot affect product behavior.
    }
  });

const ReviewPublicationTarget = Schema.Struct({
  headSha: GitHubSha,
});

const ReviewPublicationCreateResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('created'), review: Schema.Unknown }),
  Schema.Struct({ kind: Schema.Literal('stale'), currentHeadSha: GitHubSha }),
]);

type ReviewPublicationTarget = typeof ReviewPublicationTarget.Type;

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
  input: { runId: string; output: unknown },
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

  const occurredAt = yield* currentIso;
  const getRunOutcome = stateStore.getRunOutcome;
  const markRunCompleted = stateStore.markRunCompleted;
  if (getRunOutcome === undefined || markRunCompleted === undefined) {
    yield* recordPublicationTerminal(log, input.runId, {
      outcome: 'failed',
      reason: 'completion_failed',
    });
    return 'failed' as const;
  }
  const completeRun = (fingerprints: readonly string[]) =>
    Effect.tryPromise({
      try: () =>
        stateStore.completeRunPublication === undefined
          ? markRunCompleted({ runId: input.runId, occurredAt })
          : stateStore.completeRunPublication({
              runId: input.runId,
              occurredAt,
              fingerprints,
            }),
      catch: () => undefined,
    }).pipe(Effect.catch(() => Effect.succeed(false)));
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
  const updateCheck = Effect.fn('updateReviewCheck')(function* (status: 'failure' | 'cancelled') {
    if (outcome.checkRunId === undefined || github.updateCheckRun === undefined) return;
    yield* Effect.tryPromise({
      try: () =>
        github.updateCheckRun!({
          repositoryId: outcome.repositoryId,
          installationId: outcome.installationId,
          checkRunId: outcome.checkRunId!,
          status,
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
    yield* updateCheck('failure');
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
    yield* updateCheck('cancelled');
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
  const markCompletionFailed = Effect.fn('markCompletionFailed')(function* () {
    if (!ownsPublication && stateStore.claimRunPublication !== undefined) {
      ownsPublication = yield* claimFailureNotification();
    }
    yield* Effect.tryPromise({
      try: () => stateStore.markSchedulingFailed({ runId: input.runId, occurredAt }),
      catch: () => undefined,
    });
    yield* manualReaction('-1');
    yield* publishFailureNotification(ownsPublication);
  });

  const decodedOutput = yield* Schema.decodeUnknownEffect(ReviewResult)(input.output).pipe(
    Effect.catch(() => Effect.succeed(undefined)),
  );
  if (decodedOutput === undefined) {
    yield* markCompletionFailed();
    yield* recordPublicationTerminal(log, input.runId, {
      outcome: 'failed',
      reason: 'invalid_output',
    });
    return 'failed' as const;
  }

  if (
    github.loadReviewTarget === undefined ||
    github.createReview === undefined ||
    outcome.baseSha === null ||
    outcome.headSha === null
  ) {
    yield* markCompletionFailed();
    yield* recordPublicationTerminal(log, input.runId, {
      outcome: 'failed',
      reason: 'publication_uncertain',
    });
    return 'failed' as const;
  }

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
      try: () => stateStore.markRunSuperseded!({ runId: input.runId, occurredAt }),
      catch: () => undefined,
    }).pipe(Effect.catch(() => Effect.succeed(false)));
    if (!superseded) {
      yield* recordPublicationTerminal(log, input.runId, {
        outcome: 'failed',
        reason: 'completion_failed',
      });
      return 'failed' as const;
    }
    yield* manualReaction('confused');
    yield* updateCheck('cancelled');
    yield* recordPublicationTerminal(log, input.runId, { outcome: 'superseded' });
    return 'ignored' as const;
  }

  if (target === undefined) {
    yield* markCompletionFailed();
    yield* recordPublicationTerminal(log, input.runId, {
      outcome: 'failed',
      reason: 'publication_uncertain',
    });
    return 'failed' as const;
  }

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
            }),
          catch: () => undefined,
        }).pipe(
          Effect.map((review) => ({ ok: true as const, review })),
          Effect.catch(() => Effect.succeed({ ok: false as const })),
        );

  const markerLookup = yield* lookupMarker();
  if (!markerLookup.ok) {
    yield* markCompletionFailed();
    yield* recordPublicationTerminal(log, input.runId, {
      outcome: 'failed',
      reason: 'marker_lookup_failed',
    });
    return 'failed' as const;
  }

  if (markerLookup.review !== undefined) {
    const completed = yield* completeRun([]);
    if (!completed) {
      yield* markCompletionFailed();
      yield* recordPublicationTerminal(log, input.runId, {
        outcome: 'failed',
        reason: 'completion_failed',
      });
      return 'failed' as const;
    }
    yield* recordPublicationTerminal(log, input.runId, { outcome: 'published' });
    return 'completed' as const;
  }

  if (stateStore.claimRunPublication !== undefined) {
    const publicationClaimed = yield* Effect.tryPromise({
      try: () => stateStore.claimRunPublication!({ runId: input.runId, occurredAt }),
      catch: () => false,
    }).pipe(Effect.catch(() => Effect.succeed(false)));
    if (!publicationClaimed) return 'completed' as const;
    ownsPublication = true;
  }

  const payload: ReviewPublicationPayload = formatReviewPublicationPayload({
    runId: input.runId,
    headSha: outcome.headSha,
    markdown: decodedOutput,
  });

  const publication = yield* Effect.tryPromise({
    try: () =>
      github.createReview!({
        repositoryId: outcome.repositoryId,
        pullRequestNumber: outcome.pullRequestNumber,
        installationId: outcome.installationId,
        payload,
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
      try: () => stateStore.markRunSuperseded!({ runId: input.runId, occurredAt }),
      catch: () => undefined,
    }).pipe(Effect.catch(() => Effect.succeed(false)));
    if (!superseded) {
      yield* recordPublicationTerminal(log, input.runId, {
        outcome: 'failed',
        reason: 'completion_failed',
      });
      return 'failed' as const;
    }
    yield* manualReaction('confused');
    yield* updateCheck('cancelled');
    yield* recordPublicationTerminal(log, input.runId, { outcome: 'superseded' });
    return 'ignored' as const;
  }
  if (publication === false || publication === undefined) {
    const recoveredLookup = yield* lookupMarker();
    if (recoveredLookup.ok && recoveredLookup.review !== undefined) {
      const completed = yield* completeRun([]);
      if (!completed) {
        yield* markCompletionFailed();
        yield* recordPublicationTerminal(log, input.runId, {
          outcome: 'failed',
          reason: 'completion_failed',
        });
        return 'failed' as const;
      }
      yield* recordPublicationTerminal(log, input.runId, { outcome: 'published' });
      return 'completed' as const;
    }
    yield* markCompletionFailed();
    yield* recordPublicationTerminal(log, input.runId, {
      outcome: 'failed',
      reason: recoveredLookup.ok ? 'publication_uncertain' : 'marker_lookup_failed',
    });
    return 'failed' as const;
  }
  const completed = yield* completeRun([]);
  if (!completed) {
    yield* markCompletionFailed();
    yield* recordPublicationTerminal(log, input.runId, {
      outcome: 'failed',
      reason: 'completion_failed',
    });
    return 'failed' as const;
  }
  yield* recordPublicationTerminal(log, input.runId, { outcome: 'published' });
  return 'completed' as const;
});

const schedule = (scheduler: ReviewScheduler, job: ReviewJob, runId: string) =>
  Schema.decodeUnknownEffect(ReviewJob)(job).pipe(
    Effect.mapError(() => new SchedulingFailed({ message: 'Scheduled review job is invalid' })),
    Effect.flatMap((decodedJob) =>
      Effect.tryPromise({
        try: () => scheduler.schedule(decodedJob, runId),
        catch: () => new SchedulingFailed({ message: 'Review scheduler failed' }),
      }),
    ),
  );

const checkStatusForOutcome = (
  outcome: ReviewOutcome | undefined,
): 'in_progress' | 'success' | 'failure' | 'cancelled' | undefined =>
  outcome?.status === 'completed'
    ? 'success'
    : outcome?.status === 'failed'
      ? 'failure'
      : outcome?.status === 'superseded'
        ? 'cancelled'
        : outcome?.status === 'scheduled' && outcome.runnerJobId !== undefined
          ? 'in_progress'
          : undefined;

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
        if (current !== undefined && status !== undefined && github.updateCheckRun !== undefined) {
          yield* Effect.tryPromise({
            try: () =>
              github.updateCheckRun!({
                repositoryId: current.repositoryId,
                installationId: current.installationId,
                checkRunId: checkRun.id,
                status,
              }),
            catch: () => undefined,
          }).pipe(Effect.catch(() => Effect.succeed(undefined)));
          if (status === 'in_progress') {
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
              yield* Effect.tryPromise({
                try: () =>
                  github.updateCheckRun!({
                    repositoryId: latest.repositoryId,
                    installationId: latest.installationId,
                    checkRunId: checkRun.id,
                    status: latestStatus,
                  }),
                catch: () => undefined,
              }).pipe(Effect.catch(() => Effect.succeed(undefined)));
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

const claimAndSchedule = (
  github: GitHubAdapter,
  stateStore: ReviewCompletionStateStore,
  scheduler: ReviewScheduler,
  deliveryId: string,
  job: ReviewJob,
  approval?: ReviewApproval,
  log?: OperationalLog,
  deferCheckSetup?: ReviewCheckSetupDefer,
  lifecycleLog?: CoreLifecycleLog,
) =>
  Effect.gen(function* () {
    const occurredAt = yield* currentIso;
    const claim = yield* Effect.tryPromise({
      try: () =>
        stateStore.claimReview({
          deliveryId,
          job,
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

    if (claim.supersededRunIds !== undefined && stateStore.getRunOutcome !== undefined) {
      for (const supersededRunId of claim.supersededRunIds) {
        const supersededOutcome = yield* Effect.tryPromise({
          try: () => stateStore.getRunOutcome!(supersededRunId),
          catch: () => undefined,
        }).pipe(Effect.catch(() => Effect.succeed(undefined)));
        if (supersededOutcome?.checkRunId !== undefined && github.updateCheckRun !== undefined) {
          yield* Effect.tryPromise({
            try: () =>
              github.updateCheckRun!({
                repositoryId: supersededOutcome.repositoryId,
                installationId: supersededOutcome.installationId,
                checkRunId: supersededOutcome.checkRunId!,
                status: 'cancelled',
              }),
            catch: () => undefined,
          }).pipe(Effect.catch(() => Effect.succeed(undefined)));
        }
        if (supersededOutcome?.status === 'superseded') {
          const createdAt = DateTime.make(supersededOutcome.createdAt);
          const supersededAt = DateTime.make(occurredAt);
          const totalDurationMs =
            Option.isSome(createdAt) && Option.isSome(supersededAt)
              ? Math.max(
                  0,
                  supersededAt.value.epochMilliseconds - createdAt.value.epochMilliseconds,
                )
              : 0;
          yield* recordLifecycleLog(lifecycleLog, {
            event: 'review finished',
            runId: supersededRunId,
            trigger: supersededOutcome.trigger,
            outcome: 'superseded',
            published: false,
            totalDurationMs,
            cleanupStatus: 'unknown',
            evidenceStatus: 'unknown',
          });
        }
      }
    }

    yield* startCheckSetup(github, stateStore, claim.runId, job, deferCheckSetup);

    if (claim.activeRunnerJob !== undefined) {
      if (scheduler.cancel === undefined || stateStore.markRunSuperseded === undefined) {
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
            github.updateCheckRun!({
              repositoryId: supersededOutcome.repositoryId,
              installationId: supersededOutcome.installationId,
              checkRunId: supersededOutcome.checkRunId!,
              status: 'cancelled',
            }),
          catch: () => undefined,
        }).pipe(Effect.catch(() => Effect.succeed(undefined)));
      }
      const canceled = yield* Effect.tryPromise({
        try: () => scheduler.cancel!(claim.activeRunnerJob!.jobId),
        catch: () => undefined,
      }).pipe(
        Effect.map(() => true),
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
    }

    yield* schedule(scheduler, job, claim.runId).pipe(
      Effect.catchTag('SchedulingFailed', (error) =>
        Effect.gen(function* () {
          yield* recordOperationalLog(log, {
            phase: 'core',
            outcome: 'retryable',
            deliveryId,
            reason: 'scheduling_failure',
          });
          return yield* Effect.tryPromise({
            try: () =>
              stateStore.markSchedulingFailed({
                runId: claim.runId,
                occurredAt,
              }),
            catch: () => error,
          }).pipe(Effect.flatMap(() => Effect.fail(error)));
        }),
      ),
    );
    yield* recordOperationalLog(log, {
      phase: 'core',
      outcome: 'scheduled',
      deliveryId,
      runId: claim.runId,
    });
    yield* recordLifecycleLog(lifecycleLog, {
      event: 'review scheduled',
      runId: claim.runId,
      trigger: job.trigger,
    });
    return 'scheduled' as const;
  });

const recordDelivery = (stateStore: ReviewStateStore, input: ReviewDeliveryRecord) => {
  return Effect.tryPromise({
    try: () => stateStore.recordDelivery(input),
    catch: () => new SchedulingFailed({ message: 'Review outcome could not be recorded' }),
  });
};

const createAutomaticCoordinator = (
  github: GitHubAdapter,
  stateStore: ReviewCompletionStateStore,
  scheduler: ReviewScheduler,
  log?: OperationalLog,
  deferCheckSetup?: ReviewCheckSetupDefer,
  lifecycleLog?: CoreLifecycleLog,
) =>
  Effect.fn('handleAutomaticReviewEvent')(function* (
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

    return yield* claimAndSchedule(
      github,
      stateStore,
      scheduler,
      event.deliveryId,
      jobForEvent(event, 'automatic'),
      undefined,
      log,
      deferCheckSetup,
      lifecycleLog,
    );
  });

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

const loadPullRequestWithRetry = (
  github: GitHubAdapter,
  event: Extract<ReviewEvent, { event: 'issue_comment' }>,
) =>
  readManualPolicyWithRetry(async () => {
    if (github.getPullRequest === undefined) {
      throw new Error('Pull request facts adapter is unavailable');
    }
    return github.getPullRequest({
      repositoryId: event.repositoryId,
      pullRequestNumber: event.pullRequestNumber,
      installationId: event.installationId,
    });
  }, PullRequestFacts);

const loadPermissionWithRetry = (
  github: GitHubAdapter,
  event: Extract<ReviewEvent, { event: 'issue_comment' }>,
) =>
  readManualPolicyWithRetry(async () => {
    if (github.getCommenterPermission === undefined) {
      throw new Error('Commenter permission adapter is unavailable');
    }
    return github.getCommenterPermission({
      repositoryId: event.repositoryId,
      pullRequestNumber: event.pullRequestNumber,
      installationId: event.installationId,
      commenterLogin: event.commenterLogin,
    });
  }, CommenterPermission);

const writeManualReaction = (
  github: GitHubAdapter,
  event: Extract<ReviewEvent, { event: 'issue_comment' }>,
  content: 'eyes' | 'confused' | '-1',
) =>
  github.addReaction === undefined
    ? Effect.succeed(undefined)
    : Effect.tryPromise({
        try: () =>
          github.addReaction!({
            repositoryId: event.repositoryId,
            installationId: event.installationId,
            commentId: event.commentId,
            content,
          }),
        catch: () => new SchedulingFailed({ message: 'Manual review feedback failed' }),
      });

const createManualCoordinator = (
  github: GitHubAdapter,
  stateStore: ReviewCompletionStateStore,
  scheduler: ReviewScheduler,
  log?: OperationalLog,
  deferCheckSetup?: ReviewCheckSetupDefer,
  lifecycleLog?: CoreLifecycleLog,
) =>
  Effect.fn('handleManualReviewEvent')(function* (
    event: Extract<ReviewEvent, { event: 'issue_comment' }>,
  ) {
    const factsRead = yield* Effect.tryPromise({
      try: () => loadPullRequestWithRetry(github, event),
      catch: () => new SchedulingFailed({ message: 'Pull request facts are uncertain' }),
    });
    if (factsRead.kind === 'uncertain') {
      yield* recordOperationalLog(log, {
        phase: 'core',
        outcome: 'retryable',
        deliveryId: event.deliveryId,
        reason: 'pull_request_facts_uncertain',
      });
      return yield* new SchedulingFailed({ message: 'Pull request facts are uncertain' });
    }

    const facts = factsRead.kind === 'value' ? factsRead.value : undefined;
    let permission: typeof CommenterPermission.Type | undefined;
    if (facts !== undefined && !facts.draft) {
      const permissionRead = yield* Effect.tryPromise({
        try: () => loadPermissionWithRetry(github, event),
        catch: () => new SchedulingFailed({ message: 'Commenter permission is uncertain' }),
      });
      if (permissionRead.kind === 'uncertain') {
        yield* recordOperationalLog(log, {
          phase: 'core',
          outcome: 'retryable',
          deliveryId: event.deliveryId,
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
        deliveryId: event.deliveryId,
        installationId: event.installationId,
        repositoryId: event.repositoryId,
        pullRequestNumber: event.pullRequestNumber,
        baseSha: facts?.baseSha ?? null,
        headSha: facts?.headSha ?? null,
        trigger: 'manual',
        status: 'awaiting approval',
        occurredAt,
      });
      yield* writeManualReaction(github, event, 'confused');
      return 'awaiting approval' as const;
    }

    const disposition = yield* claimAndSchedule(
      github,
      stateStore,
      scheduler,
      event.deliveryId,
      jobForFacts(event, facts),
      {
        installationId: event.installationId,
        repositoryId: event.repositoryId,
        pullRequestNumber: event.pullRequestNumber,
        baseSha: facts.baseSha,
        headSha: facts.headSha,
      },
      log,
      deferCheckSetup,
      lifecycleLog,
    );

    if (disposition === 'scheduled') yield* writeManualReaction(github, event, 'eyes');

    return disposition;
  });

const reviewEventEffect = (
  event: unknown,
  github: GitHubAdapter,
  stateStore: ReviewStateStore,
  scheduler: ReviewScheduler,
  log?: OperationalLog,
  deferCheckSetup?: ReviewCheckSetupDefer,
  lifecycleLog?: CoreLifecycleLog,
) =>
  Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknownEffect(ReviewEvent)(event).pipe(
      Effect.mapError(() => new InvalidReviewEvent({ message: 'Review event is invalid' })),
    );

    if (decoded.event === 'pull_request') {
      return yield* createAutomaticCoordinator(
        github,
        stateStore,
        scheduler,
        log,
        deferCheckSetup,
        lifecycleLog,
      )(decoded);
    }

    return yield* createManualCoordinator(
      github,
      stateStore,
      scheduler,
      log,
      deferCheckSetup,
      lifecycleLog,
    )(decoded);
  });

export const createInMemoryReviewStateStore = (): ReviewPublicationStateStore => {
  const deliveries = new Map<string, ReviewOutcome>();
  const runs = new Map<
    string,
    {
      runId: string;
      job: ReviewJob;
      status: ReviewRunStatus;
      deliveryId: string;
      createdAt: string;
      updatedAt: string;
      runnerJobId?: string;
      runnerAttempt?: number;
      evidence?: ReviewEvidenceMetadata;
      checkRunId?: number;
      checkSetupStatus: 'pending' | 'ready' | 'failed';
      checkSetupClaimedAt?: string;
      publicationClaimedAt?: string;
    }
  >();
  let nextRunId = 1;

  const dispositionForStatus = (status: ReviewStoredStatus): ReviewDisposition => {
    switch (status) {
      case 'failed':
        return 'failed';
      case 'completed':
        return 'completed';
      case 'scheduled':
        return 'scheduled';
      case 'awaiting approval':
        return 'awaiting approval';
      case 'superseded':
      case 'claiming':
      case 'ignored':
      case 'rejected':
        return 'ignored';
    }
  };

  const setDeliveryStatus = (deliveryId: string, status: ReviewStoredStatus, updatedAt: string) => {
    const delivery = deliveries.get(deliveryId);
    if (delivery !== undefined) deliveries.set(deliveryId, { ...delivery, status, updatedAt });
  };

  return {
    recordDelivery: async (input) => {
      if (!deliveries.has(input.deliveryId)) {
        deliveries.set(input.deliveryId, {
          deliveryId: input.deliveryId,
          installationId: input.installationId,
          repositoryId: input.repositoryId,
          pullRequestNumber: input.pullRequestNumber,
          baseSha: input.baseSha,
          headSha: input.headSha,
          trigger: input.trigger,
          status: input.status,
          createdAt: input.occurredAt,
          updatedAt: input.occurredAt,
        });
      }
    },
    claimReview: async ({ deliveryId, job, occurredAt }) => {
      const previous = deliveries.get(deliveryId);
      if (previous !== undefined) {
        const previousRun = [...runs.values()].find((run) => run.deliveryId === deliveryId);
        return {
          kind: 'replay',
          disposition: dispositionForStatus(previous.status),
          ...(previousRun?.checkSetupStatus !== 'pending'
            ? {}
            : {
                runId: previousRun.runId,
                checkSetupStatus: previousRun.checkSetupStatus,
              }),
        };
      }

      const existing = [...runs.values()].find(
        (run) =>
          run.job.repositoryId === job.repositoryId &&
          run.job.pullRequestNumber === job.pullRequestNumber &&
          run.job.headSha === job.headSha &&
          (run.status === 'scheduled' || run.status === 'completed'),
      );
      if (existing !== undefined) {
        const disposition = dispositionForStatus(existing.status);
        deliveries.set(deliveryId, {
          deliveryId,
          installationId: job.installationId,
          repositoryId: job.repositoryId,
          pullRequestNumber: job.pullRequestNumber,
          baseSha: job.baseSha,
          headSha: job.headSha,
          trigger: job.trigger,
          status: existing.status,
          createdAt: occurredAt,
          updatedAt: occurredAt,
        });
        return {
          kind: 'existing',
          disposition,
          ...(existing.status !== 'scheduled' || existing.checkSetupStatus !== 'pending'
            ? {}
            : { runId: existing.runId, checkSetupStatus: existing.checkSetupStatus }),
        };
      }

      const historical = [...runs.values()].filter(
        (run) =>
          run.job.repositoryId === job.repositoryId &&
          run.job.pullRequestNumber === job.pullRequestNumber &&
          run.job.headSha === job.headSha,
      );
      if (
        historical.length > 0 &&
        (job.trigger !== 'manual' || !historical.some((run) => run.status === 'failed'))
      ) {
        const prior = historical[historical.length - 1];
        const disposition = dispositionForStatus(prior.status);
        deliveries.set(deliveryId, {
          deliveryId,
          installationId: job.installationId,
          repositoryId: job.repositoryId,
          pullRequestNumber: job.pullRequestNumber,
          baseSha: job.baseSha,
          headSha: job.headSha,
          trigger: job.trigger,
          status: prior.status,
          createdAt: occurredAt,
          updatedAt: occurredAt,
        });
        return { kind: 'existing', disposition };
      }

      const activeRunnerJob = [...runs.values()].find(
        (run) =>
          run.job.repositoryId === job.repositoryId &&
          run.job.pullRequestNumber === job.pullRequestNumber &&
          run.job.headSha !== job.headSha &&
          run.status === 'scheduled' &&
          run.runnerJobId !== undefined,
      );
      const supersededRunIds: string[] = [];
      for (const run of runs.values()) {
        if (
          run.job.repositoryId === job.repositoryId &&
          run.job.pullRequestNumber === job.pullRequestNumber &&
          run.status === 'scheduled' &&
          run.runnerJobId === undefined &&
          run.job.headSha !== job.headSha
        ) {
          run.status = 'superseded';
          run.updatedAt = occurredAt;
          setDeliveryStatus(run.deliveryId, 'superseded', occurredAt);
          supersededRunIds.push(run.runId);
        }
      }

      const runId = `run-${nextRunId++}`;
      runs.set(runId, {
        runId,
        deliveryId,
        job,
        status: 'scheduled',
        createdAt: occurredAt,
        updatedAt: occurredAt,
        checkSetupStatus: 'pending',
      });
      deliveries.set(deliveryId, {
        deliveryId,
        installationId: job.installationId,
        repositoryId: job.repositoryId,
        pullRequestNumber: job.pullRequestNumber,
        baseSha: job.baseSha,
        headSha: job.headSha,
        trigger: job.trigger,
        status: 'scheduled',
        createdAt: occurredAt,
        updatedAt: occurredAt,
      });
      return {
        kind: 'claimed',
        runId,
        ...(activeRunnerJob === undefined
          ? {}
          : {
              activeRunnerJob: {
                runId: activeRunnerJob.runId,
                jobId: activeRunnerJob.runnerJobId!,
              },
            }),
        ...(supersededRunIds.length === 0 ? {} : { supersededRunIds }),
      };
    },
    claimNextJob: async ({ jobId, attempt, occurredAt }) => {
      const run = [...runs.values()]
        .filter(
          (candidate) => candidate.status === 'scheduled' && candidate.runnerJobId === undefined,
        )
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
      if (run === undefined) return { kind: 'empty' as const };
      run.runnerJobId = jobId;
      run.runnerAttempt = attempt;
      run.updatedAt = occurredAt;
      return { kind: 'claimed' as const, runId: run.runId, jobId, attempt, job: run.job };
    },
    markSchedulingFailed: async ({ runId, occurredAt }) => {
      const run = runs.get(runId);
      if (run !== undefined && run.status === 'scheduled') {
        run.status = 'failed';
        run.updatedAt = occurredAt;
        setDeliveryStatus(run.deliveryId, 'failed', occurredAt);
      }
    },
    recordEvidence: async ({ runId, evidence }) => {
      const run = runs.get(runId);
      if (run === undefined) return false;
      if (run.evidence !== undefined && run.evidence.key !== evidence.key) return false;
      run.evidence = evidence;
      return true;
    },
    recordRunnerJob: async ({ runId, jobId, attempt }) => {
      const run = runs.get(runId);
      if (run === undefined || run.status !== 'scheduled') return false;
      if (run.runnerJobId !== undefined && run.runnerJobId !== jobId) return false;
      if (run.runnerAttempt !== undefined && run.runnerAttempt !== attempt) return false;
      run.runnerJobId = jobId;
      run.runnerAttempt = attempt;
      return true;
    },
    clearRunnerJob: async ({ runId, jobId }) => {
      const run = runs.get(runId);
      if (run === undefined || run.status !== 'superseded' || run.runnerJobId !== jobId) {
        return false;
      }
      run.runnerJobId = undefined;
      run.runnerAttempt = undefined;
      return true;
    },
    claimCheckSetup: async ({ runId, claimedAt, staleBefore }) => {
      const run = runs.get(runId);
      if (
        run === undefined ||
        run.checkSetupStatus !== 'pending' ||
        (run.checkSetupClaimedAt !== undefined && run.checkSetupClaimedAt > staleBefore)
      ) {
        return false;
      }
      run.checkSetupClaimedAt = claimedAt;
      return true;
    },
    recordCheckRun: async ({ runId, checkRunId, setupClaim }) => {
      const run = runs.get(runId);
      if (
        run === undefined ||
        run.checkRunId !== undefined ||
        (setupClaim !== undefined && run.checkSetupClaimedAt !== setupClaim)
      ) {
        return false;
      }
      run.checkRunId = checkRunId;
      run.checkSetupStatus = 'ready';
      run.checkSetupClaimedAt = undefined;
      return true;
    },
    markCheckSetupFailed: async ({ runId, setupClaim }) => {
      const run = runs.get(runId);
      if (
        run === undefined ||
        run.checkSetupStatus !== 'pending' ||
        (setupClaim !== undefined && run.checkSetupClaimedAt !== setupClaim)
      ) {
        return false;
      }
      run.checkSetupStatus = 'failed';
      run.checkSetupClaimedAt = undefined;
      return true;
    },
    claimRunPublication: async ({ runId, occurredAt }) => {
      const run = runs.get(runId);
      if (
        run === undefined ||
        (run.status !== 'scheduled' && run.status !== 'failed') ||
        run.publicationClaimedAt !== undefined
      ) {
        return false;
      }
      run.publicationClaimedAt = occurredAt;
      return true;
    },
    releaseRunPublicationClaim: async ({ runId, occurredAt }) => {
      const run = runs.get(runId);
      if (run === undefined || run.status !== 'failed' || run.publicationClaimedAt !== occurredAt) {
        return false;
      }
      run.publicationClaimedAt = undefined;
      return true;
    },
    markRunCompleted: async ({ runId, occurredAt }) => {
      const run = runs.get(runId);
      if (run !== undefined && run.status === 'scheduled') {
        run.status = 'completed';
        run.updatedAt = occurredAt;
        setDeliveryStatus(run.deliveryId, 'completed', occurredAt);
        return true;
      }
      return false;
    },
    markRunSuperseded: async ({ runId, occurredAt }) => {
      const run = runs.get(runId);
      if (run !== undefined && run.status === 'scheduled') {
        run.status = 'superseded';
        run.updatedAt = occurredAt;
        setDeliveryStatus(run.deliveryId, 'superseded', occurredAt);
        return true;
      }
      return false;
    },
    completeRunPublication: async ({ runId, occurredAt }) => {
      const run = runs.get(runId);
      if (run !== undefined && run.status === 'scheduled') {
        run.status = 'completed';
        run.updatedAt = occurredAt;
        setDeliveryStatus(run.deliveryId, 'completed', occurredAt);
        return true;
      }
      return false;
    },
    getDeliveryOutcome: async (deliveryId) => deliveries.get(deliveryId),
    getRunOutcome: async (runId) => {
      const run = runs.get(runId);
      if (run === undefined) return undefined;
      const delivery = deliveries.get(run.deliveryId);
      return delivery === undefined
        ? undefined
        : {
            ...delivery,
            status: run.status,
            updatedAt: run.updatedAt,
            ...(run.job.commentId === undefined ? {} : { commentId: run.job.commentId }),
            ...(run.runnerJobId === undefined ? {} : { runnerJobId: run.runnerJobId }),
            ...(run.runnerAttempt === undefined ? {} : { runnerAttempt: run.runnerAttempt }),
            ...(run.checkRunId === undefined ? {} : { checkRunId: run.checkRunId }),
            evidence: run.evidence,
          };
    },
  };
};

export function createReviewCoordinator(dependencies: {
  github: GitHubAdapter;
  stateStore: ReviewCompletionStateStore;
  scheduler: ReviewScheduler;
  log?: OperationalLog;
  deferCheckSetup?: ReviewCheckSetupDefer;
  lifecycleLog?: CoreLifecycleLog;
}): ReviewCoordinator {
  return {
    handleReviewEvent: async (event) =>
      Effect.runPromise(
        reviewEventEffect(
          event,
          dependencies.github,
          dependencies.stateStore,
          dependencies.scheduler,
          dependencies.log,
          dependencies.deferCheckSetup,
          dependencies.lifecycleLog,
        ),
      ).catch((error) => {
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

const core: WorkerEntrypoint = {
  fetch: () => Effect.runPromise(Effect.succeed(new Response(null, { status: 501 }))),
};

export default core;
