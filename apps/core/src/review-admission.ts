import {
  PullRequestFacts,
  ReviewEvent,
  type OperationalLog,
  type PullRequestFacts as PullRequestFactsType,
} from '@compte-rendu/contracts';
import { Effect, Schema } from 'effect';
import type { CancellationStore } from './cancellation-store';
import type { CheckRunStore } from './check-run-store';
import { currentIso, recordOperationalLog } from './core-observability';
import type { GitHubAdapter } from './github-adapter-contract';
import {
  completeReviewEffect,
  publishExpiredClaimChecks,
  publishTerminalCheck,
  resetPreviousReviewVerdicts,
  ReviewResetFailed,
  startCheckSetup,
  type ReviewCompletionStateStore,
} from './review-publication';
import {
  ReviewJob,
  type CancelRunnerJob,
  type ReviewApproval,
  type ReviewCheckSetupDefer,
  type ReviewDeliveryRecord,
} from './review-records';
import type { ReviewLifecycleStore } from './review-lifecycle-store';

export type ReviewAdmissionStore = ReviewLifecycleStore & CheckRunStore & CancellationStore;

export class InvalidReviewEvent extends Schema.TaggedError<InvalidReviewEvent>()(
  'InvalidReviewEvent',
  {
    message: Schema.String,
  },
) {}

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
  repositoryVisibility: event.repositoryVisibility,
  baseRef: event.baseRef,
  headRef: event.headRef,
});

interface AdmissionDependencies {
  readonly github: GitHubAdapter;
  readonly stateStore: ReviewCompletionStateStore;
  readonly cancelRunnerJob?: CancelRunnerJob;
  readonly log?: OperationalLog;
  readonly deferCheckSetup?: ReviewCheckSetupDefer;
}

const claimAndSchedule = (
  dependencies: AdmissionDependencies,
  deliveryId: string,
  job: ReviewJob,
  approval?: ReviewApproval,
) =>
  Effect.gen(function* () {
    const { github, stateStore, cancelRunnerJob, log, deferCheckSetup } = dependencies;
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
          onExpiredClaims: (claims) => publishExpiredClaimChecks(github, stateStore, claims),
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
      return {
        disposition: claim.disposition,
        ...(claim.blockingCleanupStatus === undefined
          ? {}
          : { blockingCleanupStatus: claim.blockingCleanupStatus }),
      };
    }
    const admission =
      claim.blockingCleanupStatus === undefined
        ? {}
        : { blockingCleanupStatus: claim.blockingCleanupStatus };

    if (claim.supersededRunIds !== undefined) {
      for (const supersededRunId of claim.supersededRunIds) {
        const supersededOutcome = yield* Effect.tryPromise({
          try: () => stateStore.getRunOutcome(supersededRunId),
          catch: () => undefined,
        }).pipe(Effect.catch(() => Effect.succeed(undefined)));
        if (supersededOutcome?.checkRunId !== undefined && github.updateCheckRun !== undefined) {
          yield* Effect.tryPromise({
            try: () =>
              publishTerminalCheck({
                github,
                stateStore,
                runId: supersededRunId,
              }),
            catch: () => undefined,
          }).pipe(Effect.catch(() => Effect.succeed(undefined)));
        }
      }
    }

    yield* startCheckSetup(github, stateStore, claim.runId, job, deferCheckSetup);

    // Eager cleanup is retried by the claim path. A late failure here must not
    // overwrite a run whose Runner already confirmed the reset and started.
    yield* resetPreviousReviewVerdicts(github, stateStore, claim.runId, job).pipe(
      Effect.catch((error) =>
        recordOperationalLog(log, {
          phase: 'core',
          outcome: 'retryable',
          deliveryId,
          reason: 'review_reset_failed',
          ...(error instanceof ReviewResetFailed && error.operation !== undefined
            ? { operation: error.operation }
            : {}),
          ...(error instanceof ReviewResetFailed && error.status !== undefined
            ? { status: error.status }
            : {}),
        }),
      ),
    );

    if (claim.activeRunnerJob !== undefined) {
      if (cancelRunnerJob === undefined) {
        return { disposition: 'scheduled' as const, ...admission };
      }
      const supersededOutcome = yield* Effect.tryPromise({
        try: () => stateStore.getRunOutcome(claim.activeRunnerJob!.runId),
        catch: () => undefined,
      }).pipe(Effect.catch(() => Effect.succeed(undefined)));
      const superseded = yield* Effect.tryPromise({
        try: () =>
          stateStore.markRunSuperseded({ runId: claim.activeRunnerJob!.runId, occurredAt }),
        catch: () => false,
      }).pipe(Effect.catch(() => Effect.succeed(false)));
      if (!superseded) return { disposition: 'scheduled' as const, ...admission };
      if (supersededOutcome?.checkRunId !== undefined && github.updateCheckRun !== undefined) {
        yield* Effect.tryPromise({
          try: () =>
            publishTerminalCheck({
              github,
              stateStore,
              runId: claim.activeRunnerJob!.runId,
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
      if (!canceled) return { disposition: 'scheduled' as const, ...admission };
      const cleared = yield* Effect.tryPromise({
        try: () =>
          stateStore.clearRunnerJob({
            runId: claim.activeRunnerJob!.runId,
            jobId: claim.activeRunnerJob!.jobId,
          }),
        catch: () => false,
      }).pipe(Effect.catch(() => Effect.succeed(false)));
      if (!cleared) return { disposition: 'scheduled' as const, ...admission };
    }

    yield* recordOperationalLog(log, {
      phase: 'core',
      outcome: 'scheduled',
      deliveryId,
      runId: claim.runId,
    });
    return { disposition: 'scheduled' as const, ...admission };
  });

const recordDelivery = (stateStore: ReviewLifecycleStore, input: ReviewDeliveryRecord) => {
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

    const admission = yield* claimAndSchedule(
      dependencies,
      event.deliveryId,
      jobForEvent(event, 'automatic'),
    );
    return admission.disposition;
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
      return { disposition: 'awaiting approval' as const };
    }

    const admission = yield* claimAndSchedule(
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

    if (admission.disposition === 'scheduled') yield* writeManualReaction(github, intent, 'eyes');

    return admission;
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

    const outcome = yield* Effect.tryPromise({
      try: () => stateStore.getRunOutcome(externalRunId),
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

    const admission = yield* handleManualIntent({
      deliveryId: event.deliveryId,
      repositoryId: event.repositoryId,
      pullRequestNumber: outcome.pullRequestNumber,
      installationId: event.installationId,
      senderLogin: event.senderLogin,
    });
    if (
      outcome.status === 'cancelled' &&
      admission.blockingCleanupStatus !== undefined &&
      (admission.disposition === 'scheduled' || admission.disposition === 'cancelled') &&
      github.updateCheckRun !== undefined
    ) {
      yield* Effect.tryPromise({
        try: () =>
          github.updateCheckRun!({
            runId: externalRunId,
            repositoryId: outcome.repositoryId,
            installationId: event.installationId,
            checkRunId,
            status: 'cancelled',
            cancellationReason: 'manual',
            retryBlocked:
              admission.blockingCleanupStatus === 'failed' ? 'cleanup-failed' : 'cleanup-pending',
            retryQueued: admission.disposition === 'scheduled',
          }),
        catch: () => new SchedulingFailed({ message: 'Check retry feedback failed' }),
      }).pipe(
        Effect.catch(() =>
          recordOperationalLog(log, {
            phase: 'core',
            outcome: 'retry_feedback_failed',
            deliveryId: event.deliveryId,
          }),
        ),
      );
    }
    return admission.disposition;
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

    const admission = yield* handleManualIntent({
      deliveryId: decoded.deliveryId,
      repositoryId: decoded.repositoryId,
      pullRequestNumber: decoded.pullRequestNumber,
      installationId: decoded.installationId,
      senderLogin: decoded.commenterLogin,
      commentId: decoded.commentId,
    });
    return admission.disposition;
  });
};

export const createReviewAdmission = (dependencies: AdmissionDependencies) => {
  const handleReviewEvent = createReviewEventHandler(dependencies);
  return {
    // A malformed direct event is ignored; other typed scheduling failures are
    // reported as a retryable failed disposition, matching the old Worker edge.
    // Ingress validates before this point, so these only apply to direct calls.
    handleReviewEvent: (event: unknown) =>
      handleReviewEvent(event).pipe(
        Effect.catchTag('InvalidReviewEvent', () => Effect.succeed('ignored' as const)),
        Effect.catch(() => Effect.succeed('failed' as const)),
      ),
    completeReview: (input: { runId: string; output: unknown; reconcileClaimedAt?: string }) =>
      completeReviewEffect(input, dependencies.github, dependencies.stateStore, dependencies.log),
  };
};

export type ReviewAdmission = ReturnType<typeof createReviewAdmission>;
