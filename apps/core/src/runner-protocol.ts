import { DateTime, Effect, Option, Schema } from 'effect';
import {
  MAX_RUNNER_CALLBACK_BYTES,
  MAX_RUNNER_EVIDENCE_BYTES,
  REVIEW_ATTEMPT_BUDGET_MS,
  RUNNER_CONCURRENCY_DEFAULT,
  RUNNER_CONCURRENCY_HEADER,
  RunnerEvidenceUpload,
  RunnerJobInput,
  RunnerProgressReport,
  RunnerTerminalCallback,
  readBoundedRequestBytes,
  readBoundedRequestBody,
  type OperationalLog,
  type PublicTaskFailure,
  type ReviewResetOperation,
} from '@compte-rendu/contracts';
import { currentIso, recordOperationalLog } from './core-observability';
import type { GitHubAdapter } from './github-adapter-contract';
import type { CoreWorkerEnv } from './core-worker';
import type { D1ReviewStateStore } from './review-state-store';
import type { ReviewDisposition } from './review-records';
import type { ReviewOutcome } from './review-records';
import { formatReviewFailureComment } from './review-publication-format';
import {
  claimHeadStatus,
  publishExpiredClaimChecks,
  publishTerminalCheck,
  resetPreviousReviewVerdicts,
  ReviewResetFailed,
} from './review-publication';
import { storePublicationRecord } from './publication-record';
import {
  readDesiredRunnerConcurrency,
  type DesiredRunnerConcurrencyState,
} from './review-configuration';
const MAX_PROGRESS_BYTES = 16 * 1024;
const MAX_READ_TOKEN_REQUEST_BYTES = 16 * 1024;
const READ_TOKEN_RENEWAL_MARGIN_MS = 60 * 1000;
const RunnerReadTokenRequest = Schema.Struct({
  runId: Schema.NonEmptyString,
  jobId: Schema.NonEmptyString,
  attempt: Schema.Int,
});
const epochMilliseconds = (value: string) => {
  const parsed = DateTime.make(value);
  return Option.isSome(parsed) ? parsed.value.epochMilliseconds : undefined;
};
const port = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (error: unknown) => error });
const bestEffort = <A>(run: () => Promise<A>, fallback: A) =>
  Effect.promise(() => run().catch(() => fallback));

export interface RunnerProtocolDependencies {
  readonly env: CoreWorkerEnv;
  readonly stateStore: D1ReviewStateStore;
  readonly github: GitHubAdapter;
  readonly log?: OperationalLog;
  readonly tokenProvider: {
    getReadInstallationToken(
      installationId: number,
      repositoryId: number,
    ): Promise<{ readonly token: string; readonly expiresAt: string }>;
  };
  readonly getReadInstallationToken?: (input: {
    installationId: number;
    repositoryId: number;
  }) => Promise<{ readonly token: string; readonly expiresAt: string }>;
  readonly completeReview: (input: {
    runId: string;
    output: unknown;
    reconcileClaimedAt?: string;
  }) => Effect.Effect<ReviewDisposition, unknown>;
  readonly validateProgressSnapshot: (report: {
    readonly stage: string;
    readonly milestones: readonly { readonly stage: string; readonly startedAt: string }[];
  }) => boolean;
}

export const createRunnerProtocol = (dependencies: RunnerProtocolDependencies) => {
  const { env, stateStore, github, log, tokenProvider, completeReview, validateProgressSnapshot } =
    dependencies;

  const markRunFailed = (
    outcome: ReviewOutcome,
    runId: string,
    occurredAt: string,
    releaseRunnerClaim?: {
      jobId: string;
      attempt: number;
      requireUnprepared?: boolean;
    },
    failure?: PublicTaskFailure,
  ) =>
    Effect.gen(function* () {
      // Write the terminal state before taking the failure-notification claim.
      // A transient terminal write failure must leave no publication claim behind
      // for the next callback retry to trip over.
      const statusWriteSucceeded = yield* Effect.tryPromise({
        try: () =>
          stateStore.markSchedulingFailed({
            runId,
            occurredAt,
            ...(releaseRunnerClaim === undefined ? {} : { releaseRunnerClaim }),
            ...(failure === undefined ? {} : { failure }),
            // This is never a publishing owner: never overwrite a concurrent
            // successful publication that has already started.
            requireUnpublished: true,
          }),
        catch: (error) => error,
      });
      // Cancellation can win after the caller read the run but before the
      // terminal write. The durable outcome is the winner; only the failed (or
      // superseded) winner gets external feedback.
      const settled = yield* Effect.tryPromise({
        try: () => stateStore.getRunOutcome(runId),
        catch: () => undefined,
      }).pipe(Effect.catch(() => Effect.succeed(undefined)));
      // A failed post-write read must not hide feedback when this attempt
      // provably wrote the failed status. Known cancelled/superseded outcomes
      // still take precedence.
      const failed =
        settled?.status === 'failed' ||
        (settled === undefined && (statusWriteSucceeded || outcome.status === 'failed'));
      const superseded = settled?.status === 'superseded';
      const winner =
        settled ??
        (failed ? { ...outcome, status: 'failed' as const, updatedAt: occurredAt } : undefined);
      if (winner === undefined) return undefined;
      // Only a durably failed run may claim failure-notification ownership.
      // claimRunPublication accepts status=failed without publishing, so this
      // remains race-safe after the terminal write. A claim failure stays
      // retryable instead of ACKing a callback that never notified.
      const notificationClaimed = failed
        ? yield* port(() => stateStore.claimRunPublication({ runId, occurredAt }))
        : false;
      const failureTransitioned = failed && notificationClaimed && outcome.status === 'scheduled';
      const supersessionRetained =
        superseded && outcome.status === 'superseded' && outcome.resultReceivedAt === undefined;
      if (
        (failureTransitioned || supersessionRetained) &&
        winner.trigger === 'manual' &&
        winner.commentId !== undefined &&
        github.addReaction !== undefined
      ) {
        yield* Effect.tryPromise({
          try: () =>
            github.addReaction!({
              repositoryId: winner.repositoryId,
              installationId: winner.installationId,
              commentId: winner.commentId!,
              content: supersessionRetained ? 'confused' : '-1',
            }),
          catch: () => undefined,
        }).pipe(Effect.catch(() => Effect.succeed(undefined)));
      }
      if (failed && winner.checkRunId !== undefined && github.updateCheckRun !== undefined) {
        yield* Effect.tryPromise({
          try: () => publishTerminalCheck({ github, stateStore, runId }),
          catch: () => undefined,
        }).pipe(Effect.catch(() => Effect.succeed(undefined)));
      }
      if (notificationClaimed && failed && github.createIssueComment !== undefined) {
        yield* Effect.tryPromise({
          try: () =>
            github.createIssueComment!({
              repositoryId: winner.repositoryId,
              pullRequestNumber: winner.pullRequestNumber,
              installationId: winner.installationId,
              body: formatReviewFailureComment(runId),
            }),
          catch: (error) => error,
        }).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              yield* Effect.tryPromise({
                try: () => stateStore.releaseRunPublicationClaim({ runId, occurredAt }),
                catch: () => false,
              }).pipe(Effect.catch(() => Effect.succeed(false)));
              return yield* Effect.fail(error);
            }),
          ),
        );
      }
      return winner;
    });

  const handleRunnerResult = (request: Request) =>
    Effect.gen(function* () {
      const body = yield* port(() => readBoundedRequestBytes(request, MAX_RUNNER_CALLBACK_BYTES));
      if (body === undefined) return new Response(null, { status: 413 });
      const callback = yield* bestEffort(
        () =>
          Schema.decodeUnknownPromise(Schema.fromJsonString(RunnerTerminalCallback))(
            new TextDecoder().decode(body),
          ),
        undefined,
      );
      if (callback === undefined) return new Response(null, { status: 400 });
      if (env.EVIDENCE_BUCKET === undefined) return new Response(null, { status: 503 });

      const outcome = yield* port(() => stateStore.getRunOutcome(callback.runId));
      if (outcome === undefined) return new Response(null, { status: 404 });
      if (outcome.runnerJobId !== callback.id || outcome.runnerAttempt !== callback.attempt) {
        return new Response(null, { status: 409 });
      }
      if (callback.baseSha !== outcome.baseSha || callback.headSha !== outcome.headSha) {
        return new Response(null, { status: 409 });
      }
      // A non-success result can never overwrite a completed review or a
      // publication that already owns the run. Reject before any D1 write.
      if (
        callback.status !== 'succeeded' &&
        (outcome.status === 'completed' ||
          (outcome.status === 'scheduled' && outcome.publicationClaimedAt !== undefined))
      ) {
        return new Response(null, { status: 409 });
      }
      // A repeated fully-settled failure is idempotent. Its original failure,
      // usage, result time and first cleanup confirmation remain unchanged.
      if (
        callback.status !== 'succeeded' &&
        outcome.resultReceivedAt !== undefined &&
        outcome.cleanup === 'destroyed' &&
        (outcome.status === 'cancelled' || outcome.status === 'superseded')
      ) {
        return new Response(null, { status: 202 });
      }
      if (callback.usage !== undefined) {
        const recorded = yield* Effect.promise(() =>
          stateStore
            .recordModelUsage({
              runId: callback.runId,
              jobId: callback.id,
              attempt: callback.attempt,
              usage: callback.usage!,
            })
            .then(() => true)
            .catch(() => false),
        );
        if (!recorded) yield* Effect.logWarning('model usage persistence unavailable');
      }
      yield* port(() =>
        stateStore.recordResultReceived({
          runId: callback.runId,
          jobId: callback.id,
          attempt: callback.attempt,
          occurredAt: new Date().toISOString(),
        }),
      );
      if (callback.lifecycle !== undefined && validateProgressSnapshot(callback.lifecycle)) {
        const lifecycleAt = yield* currentIso;
        yield* bestEffort(
          () =>
            stateStore.recordTerminalLifecycle({
              runId: callback.runId,
              jobId: callback.id,
              attempt: callback.attempt,
              receivedAt: lifecycleAt,
              sequence: callback.lifecycle!.sequence,
              stage: callback.lifecycle!.stage,
              milestones: callback.lifecycle!.milestones,
            }),
          false,
        );
      }
      if (outcome.status === 'completed') {
        if (outcome.checkRunId !== undefined && github.updateCheckRun !== undefined) {
          yield* bestEffort(
            () =>
              publishTerminalCheck({
                github,
                stateStore,
                runId: callback.runId,
              }),
            undefined,
          );
        }
        return new Response(null, { status: 202 });
      }
      const markCallbackFailed = () =>
        Effect.gen(function* () {
          const occurredAt = new Date().toISOString();
          const reason =
            callback.status === 'failed'
              ? callback.failure.reason === 'invalid-output'
                ? 'invalid_output'
                : callback.failure.reason
              : callback.status === 'succeeded'
                ? 'evidence'
                : 'unknown';
          const failure: PublicTaskFailure = {
            reason,
            ...(callback.status === 'failed' && callback.failure.httpStatus !== undefined
              ? { httpStatus: callback.failure.httpStatus }
              : {}),
            phase:
              reason === 'configuration'
                ? 'admission'
                : reason === 'upstream'
                  ? 'agent'
                  : reason === 'invalid_output'
                    ? 'output_validation'
                    : reason === 'timeout' || reason === 'unknown'
                      ? 'unknown'
                      : reason,
          };
          return yield* markRunFailed(outcome, callback.runId, occurredAt, undefined, failure);
        });
      yield* port(() =>
        stateStore.recordRunnerTerminal({
          runId: callback.runId,
          jobId: callback.id,
          attempt: callback.attempt,
          cleanup: callback.sandbox.cleanup,
          ...(callback.timestamps.executionStartedAt === undefined
            ? {}
            : { executionStartedAt: callback.timestamps.executionStartedAt }),
          ...(callback.timestamps.submissionCompletedAt === undefined
            ? {}
            : { submissionCompletedAt: callback.timestamps.submissionCompletedAt }),
          ...(callback.timestamps.cleanupCompletedAt === undefined
            ? {}
            : { cleanupCompletedAt: callback.timestamps.cleanupCompletedAt }),
        }),
      );

      if ((yield* port(() => stateStore.getRunOutcome(callback.runId)))?.status === 'cancelled')
        return new Response(null, { status: 202 });

      if (callback.status === 'succeeded') {
        if (outcome.status === 'superseded') {
          // The terminal cleanup write above still applies, but a settled
          // superseded result must not repeat its reaction, Check or telemetry.
          if (outcome.resultReceivedAt !== undefined) {
            return new Response(null, { status: 202 });
          }
          if (
            outcome.trigger === 'manual' &&
            outcome.commentId !== undefined &&
            github.addReaction !== undefined
          ) {
            yield* bestEffort(
              () =>
                github.addReaction!({
                  repositoryId: outcome.repositoryId,
                  installationId: outcome.installationId,
                  commentId: outcome.commentId!,
                  content: 'confused',
                }),
              undefined,
            );
          }
          if (outcome.checkRunId !== undefined && github.updateCheckRun !== undefined) {
            yield* bestEffort(
              () =>
                publishTerminalCheck({
                  github,
                  stateStore,
                  runId: callback.runId,
                }),
              undefined,
            );
          }
          return new Response(null, { status: 202 });
        }
        if (outcome.status === 'failed') {
          yield* markCallbackFailed();
          return new Response(null, { status: 202 });
        }
        if (outcome.status !== 'scheduled') return new Response(null, { status: 202 });
        const publication = yield* port(() =>
          storePublicationRecord(env.EVIDENCE_BUCKET, {
            version: 2,
            runId: callback.runId,
            jobId: callback.id,
            attempt: callback.attempt,
            result: callback.result,
          }),
        );
        // The persisted attempt-specific result is the only publication basis.
        // A failed necessary write stays retryable instead of claiming a run that
        // reconciliation could never recover.
        if (publication.kind === 'unavailable') return new Response(null, { status: 503 });
        const disposition = yield* completeReview({
          runId: callback.runId,
          output: publication.record.result,
        });
        const finalOutcome = yield* port(() => stateStore.getRunOutcome(callback.runId));
        if (finalOutcome === undefined || finalOutcome.status === 'scheduled') {
          return new Response(null, { status: 503 });
        }
        if (finalOutcome.status === 'cancelled') return new Response(null, { status: 202 });
        if (
          disposition === 'completed' &&
          finalOutcome.status === 'completed' &&
          finalOutcome.checkRunId !== undefined &&
          github.updateCheckRun !== undefined
        ) {
          yield* bestEffort(
            () =>
              publishTerminalCheck({
                github,
                stateStore,
                runId: callback.runId,
              }),
            undefined,
          );
        }
        return new Response(null, { status: finalOutcome.status === 'failed' ? 503 : 202 });
      }

      yield* markCallbackFailed();
      return new Response(null, { status: 202 });
    });

  const handleRunnerEvidence = (request: Request) =>
    Effect.gen(function* () {
      const body = yield* port(() => readBoundedRequestBytes(request, MAX_RUNNER_EVIDENCE_BYTES));
      if (body === undefined) return new Response(null, { status: 413 });
      const upload = yield* bestEffort(
        () =>
          Schema.decodeUnknownPromise(Schema.fromJsonString(RunnerEvidenceUpload), {
            onExcessProperty: 'error',
          })(new TextDecoder().decode(body)),
        undefined,
      );
      if (upload === undefined) return new Response(null, { status: 400 });
      if (env.EVIDENCE_BUCKET === undefined) return new Response(null, { status: 503 });
      if (upload.evidence.id !== undefined && upload.evidence.id !== upload.evidenceId) {
        return new Response(null, { status: 400 });
      }
      const outcome = yield* port(() => stateStore.getRunOutcome(upload.runId));
      if (outcome === undefined) return new Response(null, { status: 404 });
      if (outcome.runnerJobId !== upload.id || outcome.runnerAttempt !== upload.attempt) {
        return new Response(null, { status: 409 });
      }

      // Private diagnostics are best effort. Their arrival never changes the
      // publication state, and the content-addressed attempt key makes a late
      // old-attempt write unable to replace a newer archive.
      const object = JSON.stringify({
        version: 2,
        runId: upload.runId,
        jobId: upload.id,
        attempt: upload.attempt,
        evidenceId: upload.evidenceId,
        evidence: { id: upload.evidence.id ?? upload.evidenceId, ...upload.evidence },
        ...(upload.timestamps === undefined ? {} : { timestamps: upload.timestamps }),
      });
      const bytes = new TextEncoder().encode(object);
      const hash = yield* port(() => globalThis.crypto.subtle.digest('SHA-256', bytes));
      const sha256 = Array.from(new Uint8Array(hash), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('');
      const key = `reviews/${upload.runId}/diagnostics/${upload.id}/${upload.attempt}/${sha256}.json`;
      yield* port(() => env.EVIDENCE_BUCKET!.put(key, object));
      // D1 selects only the current owner's archive. Terminal timestamps were
      // already recorded from the authoritative callback and are not touched by
      // this later, best-effort upload.
      const recorded = yield* port(() =>
        stateStore.recordEvidenceUpload({
          runId: upload.runId,
          jobId: upload.id,
          attempt: upload.attempt,
          evidence: {
            key,
            status: upload.evidence.status,
            size: bytes.byteLength,
            sha256,
            uploadedAt: new Date().toISOString(),
          },
        }),
      );
      return new Response(null, { status: recorded ? 202 : 409 });
    });

  const handleRunnerProgress = (request: Request) =>
    Effect.gen(function* () {
      const body = yield* port(() => readBoundedRequestBytes(request, MAX_PROGRESS_BYTES));
      if (body === undefined) return new Response(null, { status: 413 });
      const report = yield* bestEffort(
        () =>
          Schema.decodeUnknownPromise(Schema.fromJsonString(RunnerProgressReport), {
            onExcessProperty: 'error',
          })(new TextDecoder().decode(body)),
        undefined,
      );
      if (report === undefined) return new Response(null, { status: 400 });
      if (!validateProgressSnapshot(report)) return new Response(null, { status: 400 });
      const occurredAt = new Date().toISOString();
      const recorded = yield* bestEffort(
        () =>
          stateStore.recordProgress({
            runId: report.runId,
            jobId: report.id,
            attempt: report.attempt,
            receivedAt: occurredAt,
            sequence: report.sequence,
            stage: report.stage,
            milestones: report.milestones,
          }),
        false,
      );
      if (recorded) return new Response(null, { status: 202 });
      const outcome = yield* bestEffort(() => stateStore.getRunOutcome(report.runId), undefined);
      if (
        outcome === undefined ||
        outcome.runnerJobId !== report.id ||
        outcome.runnerAttempt !== report.attempt
      ) {
        return new Response(null, { status: 409 });
      }
      return new Response(null, { status: 204 });
    });

  const liveReadTokenClaim = (input: { runId: string; jobId: string; attempt: number }) =>
    Effect.gen(function* () {
      const outcome = yield* bestEffort(() => stateStore.getRunOutcome(input.runId), undefined);
      if (
        outcome === undefined ||
        outcome.status !== 'scheduled' ||
        outcome.runnerJobId !== input.jobId ||
        outcome.runnerAttempt !== input.attempt ||
        outcome.publicationClaimedAt !== undefined ||
        outcome.claimedAt === undefined
      ) {
        return undefined;
      }
      const claimedAtMillis = epochMilliseconds(outcome.claimedAt);
      return claimedAtMillis === undefined ? undefined : { outcome, claimedAtMillis };
    });

  const handleRunnerReadToken = (request: Request) =>
    Effect.gen(function* () {
      const body = yield* port(() =>
        readBoundedRequestBytes(request, MAX_READ_TOKEN_REQUEST_BYTES),
      );
      if (body === undefined) {
        return new Response(null, { status: 413 });
      }
      const renewal = yield* bestEffort(
        () =>
          Schema.decodeUnknownPromise(Schema.fromJsonString(RunnerReadTokenRequest), {
            onExcessProperty: 'error',
          })(new TextDecoder().decode(body)),
        undefined,
      );
      if (renewal === undefined) return new Response(null, { status: 400 });
      if (renewal.attempt < 1) return new Response(null, { status: 400 });

      const initial = yield* liveReadTokenClaim(renewal);
      const nowMillis = yield* DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
      if (
        initial === undefined ||
        nowMillis >= initial.claimedAtMillis + REVIEW_ATTEMPT_BUDGET_MS
      ) {
        return new Response(null, { status: 409 });
      }

      const mint =
        dependencies.getReadInstallationToken ??
        ((input: { installationId: number; repositoryId: number }) =>
          tokenProvider.getReadInstallationToken(input.installationId, input.repositoryId));
      const grant = yield* port(() =>
        mint({
          installationId: initial.outcome.installationId,
          repositoryId: initial.outcome.repositoryId,
        }),
      );
      const expiresAtMillis = epochMilliseconds(grant.expiresAt);
      if (expiresAtMillis === undefined) {
        return yield* Effect.fail(new Error('GitHub read token expiry is invalid'));
      }

      const current = yield* liveReadTokenClaim(renewal);
      const currentMillis = yield* DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
      if (
        current === undefined ||
        current.claimedAtMillis !== initial.claimedAtMillis ||
        currentMillis >= current.claimedAtMillis + REVIEW_ATTEMPT_BUDGET_MS
      ) {
        return new Response(null, { status: 409 });
      }
      if (expiresAtMillis <= currentMillis + READ_TOKEN_RENEWAL_MARGIN_MS) {
        return new Response(null, { status: 503 });
      }

      return Response.json(
        {
          token: grant.token,
          expiresAt: new Date(expiresAtMillis).toISOString(),
        },
        { status: 200, headers: { 'cache-control': 'no-store' } },
      );
    });

  const attachRunnerConcurrency = (
    response: Response,
    concurrency: DesiredRunnerConcurrencyState,
  ) => {
    if (response.status !== 200 && response.status !== 204) return response;
    if (concurrency.kind === 'value') {
      response.headers.set(RUNNER_CONCURRENCY_HEADER, String(concurrency.value));
    } else if (concurrency.kind === 'default') {
      response.headers.set(RUNNER_CONCURRENCY_HEADER, RUNNER_CONCURRENCY_DEFAULT);
    }
    // unavailable: omit the header so Runners keep their current target.
    return response;
  };

  const readConcurrency = () =>
    bestEffort(() => readDesiredRunnerConcurrency(env.REVIEW_DB), {
      kind: 'unavailable' as const,
    });

  // HEAD is a read-only target read. It never allocates a claim ID, touches a
  // queue row or prepares work, so a full Runner can poll it safely.
  const handleRunnerClaimHead = () =>
    Effect.gen(function* () {
      const desiredConcurrency = yield* readConcurrency();
      return attachRunnerConcurrency(
        new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } }),
        desiredConcurrency,
      );
    });

  const handleRunnerClaim = (request: Request) =>
    Effect.gen(function* () {
      const occurredAt = new Date().toISOString();
      const body = yield* port(() => readBoundedRequestBody(request, 64 * 1024));
      if (body.kind !== 'ok') return new Response(null, { status: 413 });
      const parsed = Schema.decodeUnknownOption(
        Schema.fromJsonString(
          Schema.Struct({
            requestId: Schema.optional(Schema.String.check(Schema.isUUID(4))),
          }),
        ),
      )(body.text || '{}');
      if (Option.isNone(parsed)) return new Response(null, { status: 400 });
      const requestId = parsed.value.requestId;
      const desiredConcurrency = yield* readConcurrency();
      const noContent = () =>
        attachRunnerConcurrency(new Response(null, { status: 204 }), desiredConcurrency);
      const jobId = globalThis.crypto.randomUUID();
      const claim = yield* port(() =>
        stateStore.claimNextJob({
          jobId,
          requestId,
          attempt: 1,
          occurredAt,
          onExpiredClaims: (claims) => publishExpiredClaimChecks(github, stateStore, claims),
        }),
      );
      if (claim.kind === 'empty') return noContent();
      if (claim.kind === 'preparing' || claim.replay) {
        const start = epochMilliseconds(claim.claimedAt);
        if (start !== undefined && Date.parse(occurredAt) >= start + REVIEW_ATTEMPT_BUDGET_MS) {
          const outcome = yield* port(() => stateStore.getRunOutcome(claim.runId));
          if (outcome?.status !== 'scheduled') return noContent();
          const failure = { phase: 'scheduling', reason: 'timeout' } as const;
          // claim_prepared=0 proves no handoff was prepared. A replay of a
          // prepared claim is not proof that it never reached a Runner.
          const release =
            claim.kind === 'preparing'
              ? { jobId: claim.jobId, attempt: 1, requireUnprepared: true }
              : undefined;
          yield* markRunFailed(outcome, claim.runId, occurredAt, release, failure);
          return noContent();
        }
        if (claim.kind === 'preparing') return new Response(null, { status: 503 });
      }

      const claimedAt = claim.claimedAt;

      const releaseUndeliveredCancellation = () =>
        Effect.gen(function* () {
          const stopped = yield* port(() =>
            stateStore.confirmRunnerDestroyed({
              runId: claim.runId,
              jobId: claim.jobId,
              attempt: claim.attempt,
              occurredAt: new Date().toISOString(),
            }),
          );
          return stopped ? noContent() : new Response(null, { status: 503 });
        });

      const supersedeStaleClaim = () =>
        Effect.gen(function* () {
          const released = yield* port(() =>
            stateStore.markRunSuperseded({
              runId: claim.runId,
              occurredAt,
              releaseRunnerClaim: { jobId: claim.jobId, attempt: claim.attempt },
            }),
          );
          if (!released) return yield* Effect.fail(new Error('Supersession failed'));
          const superseded = yield* port(() => stateStore.getRunOutcome(claim.runId));
          if (superseded?.status !== 'superseded' || superseded.runnerJobId !== undefined)
            return yield* Effect.fail(new Error('Supersession failed'));
          if (superseded.checkRunId !== undefined && github.updateCheckRun !== undefined) {
            yield* bestEffort(
              () =>
                publishTerminalCheck({
                  github,
                  stateStore,
                  runId: claim.runId,
                }),
              undefined,
            );
          }
          return noContent();
        });

      let preparationFailure: PublicTaskFailure | undefined;
      let resetDiagnostics:
        | { readonly operation?: ReviewResetOperation; readonly status?: number }
        | undefined;
      const prepare = Effect.gen(function* () {
        // A prepared replay is an idempotent resend of the same handoff, so it
        // keeps the original decision instead of re-running freshness.
        if (!claim.replay) {
          const head = yield* claimHeadStatus(github, claim.job);
          if (head === 'stale') return yield* supersedeStaleClaim();
          if (head === 'unavailable') {
            // A failed head lookup is a claim-confirmation failure, not a
            // review-reset failure; keep the existing generic preparation path.
            preparationFailure = { phase: 'scheduling', reason: 'unknown' };
            return yield* Effect.fail(new Error('Current PR head unavailable'));
          }
        }
        const reset = claim.replay
          ? { kind: 'reset' as const }
          : yield* resetPreviousReviewVerdicts(github, stateStore, claim.runId, claim.job).pipe(
              Effect.match({
                onFailure: (error) => ({ kind: 'failed' as const, error }),
                onSuccess: (result) => result ?? { kind: 'reset' as const },
              }),
            );
        if (reset.kind === 'failed') {
          preparationFailure = { phase: 'scheduling', reason: 'review_reset_failed' };
          if (reset.error instanceof ReviewResetFailed)
            resetDiagnostics = {
              ...(reset.error.operation === undefined ? {} : { operation: reset.error.operation }),
              ...(reset.error.status === undefined ? {} : { status: reset.error.status }),
            };
          return yield* Effect.fail(new Error('Previous review reset failed'));
        }
        if (reset.kind === 'stale') return yield* supersedeStaleClaim();
        if (github.getRepositoryUrl === undefined)
          return yield* Effect.fail(new Error('Repository lookup unavailable'));
        const rawRepositoryUrl = yield* port(() =>
          github.getRepositoryUrl!({
            repositoryId: claim.job.repositoryId,
            installationId: claim.job.installationId,
          }),
        );
        const repositoryUrl = yield* port(() =>
          Schema.decodeUnknownPromise(Schema.NonEmptyString)(rawRepositoryUrl),
        );
        const repositoryName = new URL(repositoryUrl).pathname
          .replace(/^\//, '')
          .replace(/\.git$/, '');
        if (!/^[^/]+\/[^/]+$/.test(repositoryName))
          return yield* Effect.fail(new Error('Repository identity is invalid'));
        const readGrant = yield* port(() =>
          (
            dependencies.getReadInstallationToken ??
            ((input: { installationId: number; repositoryId: number }) =>
              tokenProvider.getReadInstallationToken(input.installationId, input.repositoryId))
          )({
            installationId: claim.job.installationId,
            repositoryId: claim.job.repositoryId,
          }),
        );
        const claimedAtMillis = epochMilliseconds(claimedAt);
        const readTokenExpiresAt = epochMilliseconds(readGrant.expiresAt);
        if (claimedAtMillis === undefined || readTokenExpiresAt === undefined) {
          preparationFailure = { phase: 'scheduling', reason: 'configuration' };
          return yield* Effect.fail(new Error('Claim or GitHub read token timestamp is invalid'));
        }
        const input = {
          ...(claim.job.reviewConfiguration === undefined
            ? {}
            : { reviewConfiguration: claim.job.reviewConfiguration }),
          claimDeadlineAt: claimedAtMillis + REVIEW_ATTEMPT_BUDGET_MS,
          repositoryReadTokenExpiresAt: readTokenExpiresAt,
          id: claim.jobId,
          runId: claim.runId,
          attempt: claim.attempt,
          repositoryUrl,
          repositoryName,
          pullRequestNumber: claim.job.pullRequestNumber,
          baseSha: claim.job.baseSha,
          headSha: claim.job.headSha,
          repositoryReadToken: readGrant.token,
        };
        yield* port(() => Schema.decodeUnknownPromise(RunnerJobInput)(input));
        const current = yield* port(() => stateStore.getRunOutcome(claim.runId));
        if (current?.status === 'cancelled') return yield* releaseUndeliveredCancellation();
        if (current?.status !== 'scheduled') {
          if (
            current !== undefined &&
            current.runnerJobId === claim.jobId &&
            current.runnerAttempt === claim.attempt &&
            current.status === 'superseded'
          ) {
            yield* port(() =>
              stateStore.clearRunnerJob({ runId: claim.runId, jobId: claim.jobId }),
            );
          }
          return noContent();
        }
        if (current.runnerJobId !== claim.jobId || current.runnerAttempt !== claim.attempt) {
          return noContent();
        }
        const wroteInProgress =
          !claim.replay && current.checkRunId !== undefined && github.updateCheckRun !== undefined;
        if (wroteInProgress) {
          yield* bestEffort(
            () =>
              github.updateCheckRun!({
                runId: claim.runId,
                repositoryId: current.repositoryId,
                installationId: current.installationId,
                checkRunId: current.checkRunId!,
                status: 'in_progress',
              }),
            undefined,
          );
        }
        // A cancellation can win while the in_progress Check write is in flight.
        // Re-read before handing the job to Runner so the claim is released and
        // one direct best-effort write can replace the stale in-progress state.
        const latest = yield* bestEffort(() => stateStore.getRunOutcome(claim.runId), current);
        if (latest?.status === 'cancelled') {
          const checkRunId = latest.checkRunId ?? current.checkRunId;
          if (wroteInProgress && checkRunId !== undefined) {
            yield* bestEffort(
              () =>
                github.updateCheckRun!({
                  runId: claim.runId,
                  repositoryId: latest.repositoryId,
                  installationId: latest.installationId,
                  checkRunId,
                  status: 'cancelled',
                  cancellationReason: 'manual',
                }),
              undefined,
            );
          }
          return yield* releaseUndeliveredCancellation();
        }
        if (
          requestId &&
          !claim.replay &&
          !(yield* bestEffort(
            () => stateStore.markClaimPrepared(claim.runId, jobId, claim.attempt),
            false,
          ))
        )
          return new Response(null, { status: 503 });
        return new Response(JSON.stringify(input), {
          status: 200,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          },
        });
      });

      const handlePreparationFailure = () =>
        Effect.gen(function* () {
          const current = yield* port(() => stateStore.getRunOutcome(claim.runId));
          if (
            current !== undefined &&
            (current.runnerJobId !== claim.jobId || current.runnerAttempt !== claim.attempt)
          ) {
            return noContent();
          }
          if (current?.status === 'cancelled') return yield* releaseUndeliveredCancellation();
          if (claim.replay)
            return current && current.status !== 'scheduled'
              ? noContent()
              : new Response(null, { status: 503 });
          if (preparationFailure?.reason === 'review_reset_failed' && current !== undefined) {
            yield* recordOperationalLog(log, {
              phase: 'core',
              outcome: 'retryable',
              deliveryId: current.deliveryId,
              reason: 'review_reset_failed',
              ...(resetDiagnostics?.operation === undefined
                ? {}
                : { operation: resetDiagnostics.operation }),
              ...(resetDiagnostics?.status === undefined
                ? {}
                : { status: resetDiagnostics.status }),
            });
          }
          const failedAt = new Date().toISOString();
          if (current === undefined) {
            yield* port(() =>
              stateStore.markSchedulingFailed({
                runId: claim.runId,
                occurredAt: failedAt,
                failure: preparationFailure,
              }),
            );
          } else {
            yield* markRunFailed(
              current,
              claim.runId,
              failedAt,
              {
                jobId: claim.jobId,
                attempt: claim.attempt,
              },
              preparationFailure,
            );
          }
          return new Response(null, { status: 503 });
        });

      const result = yield* prepare.pipe(Effect.catchCause(handlePreparationFailure));
      return attachRunnerConcurrency(result, desiredConcurrency);
    });

  return {
    handleRunnerResult,
    handleRunnerEvidence,
    handleRunnerProgress,
    handleRunnerReadToken,
    handleRunnerClaim,
    handleRunnerClaimHead,
  };
};
