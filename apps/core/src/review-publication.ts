import {
  GitHubSha,
  REVIEW_ATTEMPT_BUDGET_MS,
  RunnerReviewResult,
  type OperationalLog,
  type OperationalLogEvent,
  type PublicTaskFailure,
  type ReviewDecision,
} from '@compte-rendu/contracts';
import { DateTime, Effect, Option, Schema } from 'effect';
import type { CancellationStore } from './cancellation-store';
import type { CheckRunStore } from './check-run-store';
import { currentIso, recordOperationalLog } from './core-observability';
import type {
  GitHubAdapter,
  ReviewPublicationCreateResult,
  ReviewPublicationPayload,
} from './github-adapter-contract';
import type { ReviewCheckSetupDefer, ReviewJob, ReviewOutcome } from './review-records';
import {
  formatReviewFailureComment,
  formatReviewPublicationMarker,
  formatReviewPublicationPayload,
} from './review-publication-format';
import type { ReviewLifecycleStore } from './review-lifecycle-store';

export type ReviewCompletionStateStore = ReviewLifecycleStore & CheckRunStore & CancellationStore;

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

export const completeReviewEffect = Effect.fn('completeReview')(function* (
  input: { runId: string; output: unknown; reconcileClaimedAt?: string },
  github: GitHubAdapter,
  stateStore: ReviewCompletionStateStore,
  log: OperationalLog | undefined,
) {
  let occurredAt = yield* currentIso;
  let decision: ReviewDecision | undefined;
  const completeRun = Effect.fn('completeRun')(function* () {
    const completedAt = yield* currentIso;
    return yield* Effect.tryPromise({
      try: () =>
        stateStore.completeRunPublication({
          runId: input.runId,
          occurredAt: completedAt,
          decision,
        }),
      catch: () => undefined,
    }).pipe(Effect.catch(() => Effect.succeed(false)));
  });
  const outcome = yield* Effect.tryPromise({
    try: () => stateStore.getRunOutcome(input.runId),
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
    return yield* Effect.tryPromise({
      try: () => stateStore.claimRunPublication({ runId: input.runId, occurredAt }),
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
    if (!created) {
      yield* Effect.tryPromise({
        try: () => stateStore.releaseRunPublicationClaim({ runId: input.runId, occurredAt }),
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
    try: () => stateStore.getRunOutcome(input.runId),
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
      const superseded = yield* Effect.tryPromise({
        try: async () =>
          stateStore.markRunSuperseded({
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
  {
    occurredAt = yield* currentIso;
    const publicationClaimed = yield* Effect.tryPromise({
      try: () =>
        stateStore.claimRunPublication({
          runId: input.runId,
          occurredAt,
          publishing: true,
        }),
      catch: () => false,
    }).pipe(Effect.catch(() => Effect.succeed(false)));
    if (!publicationClaimed) {
      const latest = yield* Effect.tryPromise(() => stateStore.getRunOutcome(input.runId)).pipe(
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
    const superseded = yield* Effect.tryPromise({
      try: async () =>
        stateStore.markRunSuperseded({
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
  if (github.updateCheckRun === undefined) return false;
  const outcome = await stateStore.getRunOutcome(runId);
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
    !(await stateStore.claimCheckDelivery({
      runId,
      checkRunId,
      occurredAt,
      ...(reopen === undefined ? {} : { reopen }),
    }))
  ) {
    return false;
  }
  const current = await stateStore.getRunOutcome(runId);
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
  await stateStore.confirmCheckDelivery({ runId, checkRunId, occurredAt });
  return true;
};

const checkSetupLeaseDuration = { minutes: 1 } as const;

export const setupCheck = Effect.fn('setupCheck')(function* (
  github: GitHubAdapter,
  stateStore: ReviewCompletionStateStore,
  runId: string,
  job: ReviewJob,
) {
  let setupClaim: string | undefined;
  {
    const now = yield* DateTime.now;
    setupClaim = DateTime.formatIso(now);
    const staleBefore = DateTime.formatIso(DateTime.subtract(now, checkSetupLeaseDuration));
    const claimed = yield* Effect.tryPromise({
      try: () => stateStore.claimCheckSetup({ runId, claimedAt: setupClaim!, staleBefore }),
      catch: () => false,
    }).pipe(Effect.catch(() => Effect.succeed(false)));
    if (!claimed) return;
  }
  if (github.createCheckRun !== undefined) {
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
          stateStore.recordCheckRun({
            runId,
            checkRunId: checkRun.id,
            ...(setupClaim === undefined ? {} : { setupClaim }),
          }),
        catch: () => false,
      }).pipe(Effect.catch(() => Effect.succeed(false)));
      if (recorded) {
        const current = yield* Effect.tryPromise({
          try: () => stateStore.getRunOutcome(runId),
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
                stateStore.confirmCheckCancelled({
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
              try: () => stateStore.getRunOutcome(runId),
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
      if (!recorded) {
        yield* Effect.tryPromise({
          try: () =>
            stateStore.markCheckSetupFailed({
              runId,
              ...(setupClaim === undefined ? {} : { setupClaim }),
            }),
          catch: () => false,
        }).pipe(Effect.catch(() => Effect.succeed(false)));
      }
    } else {
      yield* Effect.tryPromise({
        try: () =>
          stateStore.markCheckSetupFailed({
            runId,
            ...(setupClaim === undefined ? {} : { setupClaim }),
          }),
        catch: () => false,
      }).pipe(Effect.catch(() => Effect.succeed(false)));
    }
  } else {
    yield* Effect.tryPromise({
      try: () =>
        stateStore.markCheckSetupFailed({
          runId,
          ...(setupClaim === undefined ? {} : { setupClaim }),
        }),
      catch: () => false,
    }).pipe(Effect.catch(() => Effect.succeed(false)));
  }
});

export const startCheckSetup = Effect.fn('startCheckSetup')(function* (
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
