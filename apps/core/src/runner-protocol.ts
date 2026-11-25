import { DateTime, Effect, Option, Schema } from 'effect';
import {
  MAX_RUNNER_CALLBACK_BYTES,
  MAX_RUNNER_EVIDENCE_BYTES,
  MAX_WEBHOOK_BYTES,
  REVIEW_ATTEMPT_BUDGET_MS,
  MetadataInvalidationEvent,
  RunnerEvidenceUpload,
  RunnerJobInput,
  RunnerProgressReport,
  RunnerTerminalCallback,
  readBoundedRequestBody,
  type PublicTaskFailure,
} from '@compte-rendu/contracts';
import type { CoreLifecycleFailureReason, CoreLifecycleLog } from './core-observability';
import type { GitHubAdapter } from './github-adapter-contract';
import type { CoreWorkerEnv } from './core-worker';
import type { D1ReviewStateStore } from './review-state-store';
import type { ReviewCoordinator } from './review-admission';
import type { ReviewOutcome } from './review-records';
import { formatReviewFailureComment } from './review-publication-format';
import {
  claimHeadStatus,
  publishTerminalCheck,
  resetPreviousReviewVerdicts,
} from './review-publication';
import { storePublicationRecord } from './publication-record';
import type { createPostHogLifecycleLog } from './posthog';
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

type LifecycleLog = ReturnType<typeof createPostHogLifecycleLog>;

export interface RunnerProtocolDependencies {
  readonly env: CoreWorkerEnv;
  readonly stateStore: D1ReviewStateStore;
  readonly github: GitHubAdapter;
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
  readonly createCoordinator: (
    lifecycle: LifecycleLog,
    defer?: (task: Promise<unknown>) => void,
  ) => ReviewCoordinator;
  readonly validateProgressSnapshot: (report: {
    readonly stage: string;
    readonly milestones: readonly { readonly stage: string; readonly startedAt: string }[];
  }) => boolean;
}

export const createRunnerProtocol = (dependencies: RunnerProtocolDependencies) => {
  const { env, stateStore, github, tokenProvider, createCoordinator, validateProgressSnapshot } =
    dependencies;
  const recordLifecycle = (
    lifecycleLog: ReturnType<typeof createPostHogLifecycleLog>,
    event: Parameters<ReturnType<typeof createPostHogLifecycleLog>['record']>[0],
  ) => {
    try {
      lifecycleLog.record(event);
    } catch {
      // Lifecycle capture is strictly best effort and cannot affect product behavior.
    }
  };

  const recordFinishedLifecycle = async (
    lifecycleLog: ReturnType<typeof createPostHogLifecycleLog>,
    outcome: ReviewOutcome,
    terminal: 'completed' | 'failed' | 'superseded',
    callback?: typeof RunnerTerminalCallback.Type,
    failure?: {
      readonly phase: NonNullable<
        Extract<
          Parameters<CoreLifecycleLog['record']>[0],
          { event: 'review finished'; outcome: 'failed' }
        >['failurePhase']
      >;
      readonly reason: CoreLifecycleFailureReason;
    },
    runId?: string,
  ) => {
    const occurredAt = new Date().toISOString();
    const created = epochMilliseconds(outcome.createdAt);
    const finishedAt = epochMilliseconds(occurredAt);
    const totalDurationMs =
      created !== undefined && finishedAt !== undefined ? Math.max(0, finishedAt - created) : 0;
    const failedCallback = callback?.status === 'failed' ? callback : undefined;
    const failureReason =
      terminal !== 'failed'
        ? undefined
        : (failure?.reason ??
          (failedCallback?.failure === undefined
            ? 'unknown'
            : failedCallback.failure.reason === 'invalid-output'
              ? 'invalid_output'
              : failedCallback.failure.reason));
    const common = {
      event: 'review finished',
      runId: callback?.runId ?? runId ?? outcome.deliveryId,
      trigger: outcome.trigger,
      totalDurationMs,
      cleanupStatus:
        callback?.sandbox.cleanup === 'destroyed' || callback?.sandbox.cleanup === 'failed'
          ? callback.sandbox.cleanup
          : 'unknown',
      evidenceStatus: callback?.evidence.status ?? outcome.evidence?.status ?? 'unknown',
    } as const;
    if (terminal === 'completed') {
      recordLifecycle(lifecycleLog, { ...common, outcome: terminal, published: true });
    } else if (terminal === 'superseded') {
      recordLifecycle(lifecycleLog, { ...common, outcome: terminal, published: false });
    } else {
      recordLifecycle(lifecycleLog, {
        ...common,
        outcome: terminal,
        published: false,
        failurePhase:
          failure?.phase ??
          (failedCallback?.stage === 'admission' ||
          failedCallback?.stage === 'checkout' ||
          failedCallback?.stage === 'sandbox' ||
          failedCallback?.stage === 'agent' ||
          failedCallback?.stage === 'cleanup'
            ? failedCallback.stage
            : 'unknown'),
        failureReason: failureReason ?? 'unknown',
      });
    }
  };

  const markRunFailed = async (
    outcome: ReviewOutcome,
    runId: string,
    occurredAt: string,
    releaseRunnerClaim?: {
      jobId: string;
      attempt: number;
      requireUnprepared?: boolean;
    },
    failure?: PublicTaskFailure,
    requireUnpublished = false,
  ): Promise<ReviewOutcome | undefined> => {
    const notificationClaimed =
      outcome.status === 'scheduled' || outcome.status === 'failed'
        ? await stateStore.claimRunPublication({ runId, occurredAt })
        : false;
    const statusWriteSucceeded = await stateStore.markSchedulingFailed({
      runId,
      occurredAt,
      ...(releaseRunnerClaim === undefined ? {} : { releaseRunnerClaim }),
      ...(failure === undefined ? {} : { failure }),
      ...(requireUnpublished ? { requireUnpublished: true } : {}),
    });
    // Cancellation can win after the caller read the run but before the claim
    // and status write above. The durable outcome is the winner; only the
    // failed (or superseded) winner gets external failure feedback.
    const settled = await stateStore.getRunOutcome(runId).catch(() => undefined);
    // A failed post-write read must not hide feedback when this attempt
    // provably owns publication and wrote the failed status. Known
    // cancelled/superseded outcomes still take precedence.
    const failed =
      settled?.status === 'failed' ||
      (settled === undefined &&
        notificationClaimed &&
        (statusWriteSucceeded || outcome.status === 'failed'));
    const superseded = settled?.status === 'superseded';
    const winner =
      settled ??
      (failed ? { ...outcome, status: 'failed' as const, updatedAt: occurredAt } : undefined);
    if (winner === undefined) return undefined;
    const failureTransitioned = failed && outcome.status === 'scheduled';
    const supersessionRetained = superseded && outcome.status === 'superseded';
    if (
      (failureTransitioned || supersessionRetained) &&
      winner.trigger === 'manual' &&
      winner.commentId !== undefined &&
      github.addReaction !== undefined
    ) {
      await github
        .addReaction({
          repositoryId: winner.repositoryId,
          installationId: winner.installationId,
          commentId: winner.commentId,
          content: supersessionRetained ? 'confused' : '-1',
        })
        .catch(() => undefined);
    }
    if (failed && winner.checkRunId !== undefined && github.updateCheckRun !== undefined) {
      await publishTerminalCheck({ github, stateStore, runId, occurredAt }).catch(() => undefined);
    }
    if (notificationClaimed && failed && github.createIssueComment !== undefined) {
      try {
        await github.createIssueComment({
          repositoryId: winner.repositoryId,
          pullRequestNumber: winner.pullRequestNumber,
          installationId: winner.installationId,
          body: formatReviewFailureComment(runId),
        });
      } catch (error) {
        await stateStore.releaseRunPublicationClaim({ runId, occurredAt }).catch(() => false);
        throw error;
      }
    }
    return winner;
  };

  const handleRunnerResult = async (
    request: Request,
    lifecycleLog: ReturnType<typeof createPostHogLifecycleLog>,
  ): Promise<Response> => {
    if (request.headers.get('x-compte-rendu-runner-callback') !== 'verified') {
      return new Response(null, { status: 401 });
    }
    const body = await request.arrayBuffer();
    if (body.byteLength > MAX_RUNNER_CALLBACK_BYTES) return new Response(null, { status: 413 });
    let callback: typeof RunnerTerminalCallback.Type;
    try {
      callback = await Schema.decodeUnknownPromise(Schema.fromJsonString(RunnerTerminalCallback))(
        new TextDecoder().decode(body),
      );
    } catch {
      return new Response(null, { status: 400 });
    }
    if (env.EVIDENCE_BUCKET === undefined) return new Response(null, { status: 503 });

    const outcome = await stateStore.getRunOutcome(callback.runId);
    if (outcome === undefined) return new Response(null, { status: 404 });
    if (outcome.runnerJobId !== callback.id || outcome.runnerAttempt !== callback.attempt) {
      return new Response(null, { status: 409 });
    }
    // New callbacks carry immutable SHAs. Older issued v2 archives may omit
    // them, so absence remains compatible while a present value must match.
    if (
      (callback.baseSha !== undefined && outcome.baseSha !== callback.baseSha) ||
      (callback.headSha !== undefined && outcome.headSha !== callback.headSha)
    ) {
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
      try {
        await stateStore.recordModelUsage({
          runId: callback.runId,
          jobId: callback.id,
          attempt: callback.attempt,
          usage: callback.usage,
        });
      } catch {
        await Effect.runPromise(Effect.logWarning('model usage persistence unavailable')).catch(
          () => undefined,
        );
      }
    }
    await stateStore.recordResultReceived({
      runId: callback.runId,
      jobId: callback.id,
      attempt: callback.attempt,
      occurredAt: new Date().toISOString(),
    });
    if (callback.lifecycle !== undefined && validateProgressSnapshot(callback.lifecycle)) {
      const lifecycleAt = await Effect.runPromise(
        DateTime.now.pipe(Effect.map(DateTime.formatIso)),
      );
      await stateStore
        .recordTerminalLifecycle({
          runId: callback.runId,
          jobId: callback.id,
          attempt: callback.attempt,
          receivedAt: lifecycleAt,
          sequence: callback.lifecycle.sequence,
          stage: callback.lifecycle.stage,
          milestones: callback.lifecycle.milestones,
        })
        .catch(() => false);
    }
    if (outcome.status === 'completed') {
      if (outcome.checkRunId !== undefined && github.updateCheckRun !== undefined) {
        await publishTerminalCheck({
          github,
          stateStore,
          runId: callback.runId,
          occurredAt: new Date().toISOString(),
        }).catch(() => undefined);
      }
      return new Response(null, { status: 202 });
    }
    const markCallbackFailed = async () => {
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
      return markRunFailed(outcome, callback.runId, occurredAt, undefined, failure, true);
    };
    await stateStore.recordRunnerTerminal({
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
    });

    if ((await stateStore.getRunOutcome(callback.runId))?.status === 'cancelled')
      return new Response(null, { status: 202 });

    if (callback.status === 'succeeded') {
      if (outcome.status === 'superseded') {
        if (
          outcome.trigger === 'manual' &&
          outcome.commentId !== undefined &&
          github.addReaction !== undefined
        ) {
          await github.addReaction({
            repositoryId: outcome.repositoryId,
            installationId: outcome.installationId,
            commentId: outcome.commentId,
            content: 'confused',
          });
        }
        if (outcome.checkRunId !== undefined && github.updateCheckRun !== undefined) {
          await publishTerminalCheck({
            github,
            stateStore,
            runId: callback.runId,
            occurredAt: new Date().toISOString(),
          }).catch(() => undefined);
        }
        await recordFinishedLifecycle(lifecycleLog, outcome, 'superseded', callback);
        return new Response(null, { status: 202 });
      }
      if (outcome.status === 'failed') {
        await markCallbackFailed();
        return new Response(null, { status: 202 });
      }
      if (outcome.status !== 'scheduled') return new Response(null, { status: 202 });
      const publication = await storePublicationRecord(env.EVIDENCE_BUCKET, {
        version: 2,
        runId: callback.runId,
        jobId: callback.id,
        attempt: callback.attempt,
        result: callback.result,
      });
      // The persisted attempt-specific result is the only publication basis.
      // A failed necessary write stays retryable instead of claiming a run that
      // reconciliation could never recover.
      if (publication.kind === 'unavailable') return new Response(null, { status: 503 });
      const disposition = await createCoordinator(lifecycleLog).completeReview({
        runId: callback.runId,
        output: publication.record.result,
      });
      const finalOutcome = await stateStore.getRunOutcome(callback.runId);
      if (finalOutcome === undefined || finalOutcome.status === 'scheduled') {
        return new Response(null, { status: 503 });
      }
      if (finalOutcome.status === 'cancelled') return new Response(null, { status: 202 });
      await recordFinishedLifecycle(
        lifecycleLog,
        finalOutcome,
        finalOutcome.status === 'completed'
          ? 'completed'
          : finalOutcome.status === 'superseded'
            ? 'superseded'
            : 'failed',
        callback,
        finalOutcome.status === 'failed' ? { phase: 'publication', reason: 'unknown' } : undefined,
      );
      if (
        disposition === 'completed' &&
        finalOutcome.status === 'completed' &&
        finalOutcome.checkRunId !== undefined &&
        github.updateCheckRun !== undefined
      ) {
        await publishTerminalCheck({
          github,
          stateStore,
          runId: callback.runId,
          occurredAt: new Date().toISOString(),
        }).catch(() => undefined);
      }
      return new Response(null, { status: finalOutcome.status === 'failed' ? 503 : 202 });
    }

    const settled = await markCallbackFailed();
    if (settled?.status === 'failed' || settled?.status === 'superseded') {
      await recordFinishedLifecycle(
        lifecycleLog,
        settled,
        settled.status === 'superseded' ? 'superseded' : 'failed',
        callback,
      );
    }
    return new Response(null, { status: 202 });
  };

  const handleRunnerEvidence = async (request: Request): Promise<Response> => {
    if (request.headers.get('x-compte-rendu-runner-evidence') !== 'verified') {
      return new Response(null, { status: 401 });
    }
    const body = await request.arrayBuffer();
    if (body.byteLength > MAX_RUNNER_EVIDENCE_BYTES) return new Response(null, { status: 413 });
    let upload: typeof RunnerEvidenceUpload.Type;
    try {
      upload = await Schema.decodeUnknownPromise(Schema.fromJsonString(RunnerEvidenceUpload), {
        onExcessProperty: 'error',
      })(new TextDecoder().decode(body));
    } catch {
      return new Response(null, { status: 400 });
    }
    if (env.EVIDENCE_BUCKET === undefined) return new Response(null, { status: 503 });
    if (upload.evidence.id !== undefined && upload.evidence.id !== upload.evidenceId) {
      return new Response(null, { status: 400 });
    }
    const outcome = await stateStore.getRunOutcome(upload.runId);
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
    const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    const sha256 = Array.from(new Uint8Array(hash), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    const key = `reviews/${upload.runId}/diagnostics/${upload.id}/${upload.attempt}/${sha256}.json`;
    await env.EVIDENCE_BUCKET.put(key, object);
    // D1 selects only the current owner's archive. Terminal timestamps were
    // already recorded from the authoritative callback and are not touched by
    // this later, best-effort upload.
    const recorded = await stateStore.recordEvidenceUpload({
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
    });
    return new Response(null, { status: recorded ? 202 : 409 });
  };

  const handleMetadataInvalidation = async (request: Request): Promise<Response> => {
    const body = await request.arrayBuffer();
    if (body.byteLength > MAX_WEBHOOK_BYTES) return new Response(null, { status: 413 });
    let event: typeof MetadataInvalidationEvent.Type;
    try {
      event = await Schema.decodeUnknownPromise(Schema.fromJsonString(MetadataInvalidationEvent), {
        onExcessProperty: 'error',
      })(new TextDecoder().decode(body));
    } catch {
      return new Response(null, { status: 400 });
    }
    const observedAt = new Date().toISOString();
    await stateStore.invalidateRepositoryMetadataBatch({
      installationId: event.installationId,
      repositoryIds: event.repositoryIds,
      visibility: event.visibility,
      updatedAt: observedAt,
      nextRefreshAt: observedAt,
    });
    return new Response(null, { status: 202 });
  };

  const handleRunnerProgress = async (request: Request): Promise<Response> => {
    if (request.headers.get('x-compte-rendu-runner-progress') !== 'verified') {
      return new Response(null, { status: 401 });
    }
    const body = await request.arrayBuffer();
    if (body.byteLength > MAX_PROGRESS_BYTES) return new Response(null, { status: 413 });
    let report: typeof RunnerProgressReport.Type;
    try {
      report = await Schema.decodeUnknownPromise(Schema.fromJsonString(RunnerProgressReport), {
        onExcessProperty: 'error',
      })(new TextDecoder().decode(body));
    } catch {
      return new Response(null, { status: 400 });
    }
    if (!validateProgressSnapshot(report)) return new Response(null, { status: 400 });
    const occurredAt = new Date().toISOString();
    const recorded = await stateStore
      .recordProgress({
        runId: report.runId,
        jobId: report.id,
        attempt: report.attempt,
        receivedAt: occurredAt,
        sequence: report.sequence,
        stage: report.stage,
        milestones: report.milestones,
      })
      .catch(() => false);
    if (recorded) return new Response(null, { status: 202 });
    const outcome = await stateStore.getRunOutcome(report.runId).catch(() => undefined);
    if (
      outcome === undefined ||
      outcome.runnerJobId !== report.id ||
      outcome.runnerAttempt !== report.attempt
    ) {
      return new Response(null, { status: 409 });
    }
    return new Response(null, { status: 204 });
  };

  const liveReadTokenClaim = async (input: { runId: string; jobId: string; attempt: number }) => {
    const outcome = await stateStore.getRunOutcome(input.runId).catch(() => undefined);
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
  };

  const handleRunnerReadToken = async (request: Request): Promise<Response> => {
    if (request.headers.get('x-compte-rendu-runner-read-token') !== 'verified') {
      return new Response(null, { status: 401 });
    }
    const body = await request.arrayBuffer();
    if (body.byteLength > MAX_READ_TOKEN_REQUEST_BYTES) {
      return new Response(null, { status: 413 });
    }
    let renewal: typeof RunnerReadTokenRequest.Type;
    try {
      renewal = await Schema.decodeUnknownPromise(Schema.fromJsonString(RunnerReadTokenRequest), {
        onExcessProperty: 'error',
      })(new TextDecoder().decode(body));
    } catch {
      return new Response(null, { status: 400 });
    }
    if (renewal.attempt < 1) return new Response(null, { status: 400 });

    const initial = await liveReadTokenClaim(renewal);
    const nowMillis = await Effect.runPromise(
      DateTime.now.pipe(Effect.map(DateTime.toEpochMillis)),
    );
    if (initial === undefined || nowMillis >= initial.claimedAtMillis + REVIEW_ATTEMPT_BUDGET_MS) {
      return new Response(null, { status: 409 });
    }

    const mint =
      dependencies.getReadInstallationToken ??
      ((input: { installationId: number; repositoryId: number }) =>
        tokenProvider.getReadInstallationToken(input.installationId, input.repositoryId));
    const grant = await mint({
      installationId: initial.outcome.installationId,
      repositoryId: initial.outcome.repositoryId,
    });
    const expiresAtMillis = epochMilliseconds(grant.expiresAt);
    if (expiresAtMillis === undefined) {
      throw new Error('GitHub read token expiry is invalid');
    }

    const current = await liveReadTokenClaim(renewal);
    const currentMillis = await Effect.runPromise(
      DateTime.now.pipe(Effect.map(DateTime.toEpochMillis)),
    );
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
  };

  const handleRunnerClaim = async (
    request: Request,
    lifecycleLog: ReturnType<typeof createPostHogLifecycleLog>,
  ): Promise<Response> => {
    if (request.headers.get('x-compte-rendu-runner-claim') !== 'verified') {
      return new Response(null, { status: 401 });
    }
    const occurredAt = new Date().toISOString();
    const body = await readBoundedRequestBody(request, 64 * 1024);
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
    const jobId = globalThis.crypto.randomUUID();
    const claim = await stateStore.claimNextJob({ jobId, requestId, attempt: 1, occurredAt });
    if (claim.kind === 'empty') return new Response(null, { status: 204 });
    if (claim.kind === 'preparing' || claim.replay) {
      const start = epochMilliseconds(claim.claimedAt);
      if (start !== undefined && Date.parse(occurredAt) >= start + REVIEW_ATTEMPT_BUDGET_MS) {
        const outcome = await stateStore.getRunOutcome(claim.runId);
        if (outcome?.status !== 'scheduled') return new Response(null, { status: 204 });
        const failure = { phase: 'scheduling', reason: 'timeout' } as const;
        // claim_prepared=0 proves no handoff was prepared. A replay of a
        // prepared claim is not proof that it never reached a Runner.
        const release =
          claim.kind === 'preparing'
            ? { jobId: claim.jobId, attempt: 1, requireUnprepared: true }
            : undefined;
        const failed = await markRunFailed(outcome, claim.runId, occurredAt, release, failure);
        if (failed?.status === 'failed')
          await recordFinishedLifecycle(
            lifecycleLog,
            failed,
            'failed',
            undefined,
            failure,
            claim.runId,
          );
        return new Response(null, { status: 204 });
      }
      if (claim.kind === 'preparing') return new Response(null, { status: 503 });
    }

    const claimedAt = claim.claimedAt;
    const claimedOutcome = await stateStore.getRunOutcome(claim.runId).catch(() => undefined);
    const createdAt = claimedOutcome?.createdAt;
    const parsedCreatedAt = createdAt === undefined ? undefined : epochMilliseconds(createdAt);
    const parsedClaimedAt = epochMilliseconds(claimedAt);
    const queueWaitMs =
      parsedCreatedAt !== undefined && parsedClaimedAt !== undefined
        ? Math.max(0, parsedClaimedAt - parsedCreatedAt)
        : 0;
    if (!claim.replay)
      recordLifecycle(lifecycleLog, {
        event: 'review claimed',
        runId: claim.runId,
        trigger: claim.job.trigger,
        queueWaitMs,
      });

    const releaseUndeliveredCancellation = async () => {
      const stopped = await stateStore.confirmRunnerDestroyed({
        runId: claim.runId,
        jobId: claim.jobId,
        attempt: claim.attempt,
        occurredAt: new Date().toISOString(),
      });
      return new Response(null, { status: stopped ? 204 : 503 });
    };

    const supersedeStaleClaim = async (): Promise<Response> => {
      const released = await stateStore.markRunSuperseded({
        runId: claim.runId,
        occurredAt,
        releaseRunnerClaim: { jobId: claim.jobId, attempt: claim.attempt },
      });
      if (!released) throw new Error('Supersession failed');
      const superseded = await stateStore.getRunOutcome(claim.runId);
      if (superseded?.status !== 'superseded' || superseded.runnerJobId !== undefined)
        throw new Error('Supersession failed');
      if (superseded.checkRunId !== undefined && github.updateCheckRun !== undefined) {
        await publishTerminalCheck({
          github,
          stateStore,
          runId: claim.runId,
          occurredAt,
        }).catch(() => undefined);
      }
      await recordFinishedLifecycle(
        lifecycleLog,
        superseded,
        'superseded',
        undefined,
        undefined,
        claim.runId,
      );
      return new Response(null, { status: 204 });
    };

    let preparationFailure: PublicTaskFailure | undefined;
    try {
      // A prepared replay is an idempotent resend of the same handoff, so it
      // keeps the original decision instead of re-running freshness.
      if (!claim.replay) {
        const head = await Effect.runPromise(claimHeadStatus(github, claim.job));
        if (head === 'stale') return await supersedeStaleClaim();
        if (head === 'unavailable') {
          // A failed head lookup is a claim-confirmation failure, not a
          // review-reset failure; keep the existing generic preparation path.
          preparationFailure = { phase: 'scheduling', reason: 'unknown' };
          throw new Error('Current PR head unavailable');
        }
      }
      const reset = claim.replay
        ? { kind: 'reset' as const }
        : await Effect.runPromise(
            resetPreviousReviewVerdicts(github, stateStore, claim.runId, claim.job).pipe(
              Effect.match({
                onFailure: () => ({ kind: 'failed' as const }),
                onSuccess: (result) => result ?? { kind: 'reset' as const },
              }),
            ),
          );
      if (reset.kind === 'failed') {
        preparationFailure = { phase: 'scheduling', reason: 'review_reset_failed' };
        throw new Error('Previous review reset failed');
      }
      if (reset.kind === 'stale') return await supersedeStaleClaim();
      if (github.getRepositoryUrl === undefined) throw new Error('Repository lookup unavailable');
      const repositoryUrl = await Schema.decodeUnknownPromise(Schema.NonEmptyString)(
        await github.getRepositoryUrl({
          repositoryId: claim.job.repositoryId,
          installationId: claim.job.installationId,
        }),
      );
      const repositoryName = new URL(repositoryUrl).pathname
        .replace(/^\//, '')
        .replace(/\.git$/, '');
      if (!/^[^/]+\/[^/]+$/.test(repositoryName)) throw new Error('Repository identity is invalid');
      const readGrant = await (
        dependencies.getReadInstallationToken ??
        ((input: { installationId: number; repositoryId: number }) =>
          tokenProvider.getReadInstallationToken(input.installationId, input.repositoryId))
      )({
        installationId: claim.job.installationId,
        repositoryId: claim.job.repositoryId,
      });
      const claimedAtMillis = epochMilliseconds(claimedAt);
      const readTokenExpiresAt = epochMilliseconds(readGrant.expiresAt);
      if (claimedAtMillis === undefined || readTokenExpiresAt === undefined) {
        preparationFailure = { phase: 'scheduling', reason: 'configuration' };
        throw new Error('Claim or GitHub read token timestamp is invalid');
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
      await Schema.decodeUnknownPromise(RunnerJobInput)(input);
      const current = await stateStore.getRunOutcome(claim.runId);
      if (current?.status === 'cancelled') return releaseUndeliveredCancellation();
      if (current?.status !== 'scheduled') {
        if (
          current !== undefined &&
          current.runnerJobId === claim.jobId &&
          current.runnerAttempt === claim.attempt &&
          current.status === 'superseded'
        ) {
          await stateStore.clearRunnerJob({ runId: claim.runId, jobId: claim.jobId });
        }
        return new Response(null, { status: 204 });
      }
      if (current.runnerJobId !== claim.jobId || current.runnerAttempt !== claim.attempt) {
        return new Response(null, { status: 204 });
      }
      const wroteInProgress =
        !claim.replay && current.checkRunId !== undefined && github.updateCheckRun !== undefined;
      if (wroteInProgress) {
        await github.updateCheckRun!({
          runId: claim.runId,
          repositoryId: current.repositoryId,
          installationId: current.installationId,
          checkRunId: current.checkRunId!,
          status: 'in_progress',
        }).catch(() => undefined);
      }
      // A cancellation can win while the in_progress Check write is in flight.
      // Re-read before handing the job to Runner so the claim is released and
      // a stale Check write is reconciled durably instead of leaving the Check
      // in progress forever.
      const latest = await stateStore.getRunOutcome(claim.runId).catch(() => current);
      if (latest?.status === 'cancelled') {
        const checkRunId = latest.checkRunId ?? current.checkRunId;
        if (wroteInProgress && checkRunId !== undefined) {
          await stateStore
            .reopenCheckCancellation({ runId: claim.runId, checkRunId })
            .catch(() => false);
          const confirmAt = await Effect.runPromise(
            DateTime.now.pipe(Effect.map(DateTime.formatIso)),
          );
          await github.updateCheckRun!({
            runId: claim.runId,
            repositoryId: latest.repositoryId,
            installationId: latest.installationId,
            checkRunId,
            status: 'cancelled',
            cancellationReason: 'manual',
          })
            .then(() =>
              stateStore.confirmCheckCancelled({
                runId: claim.runId,
                checkRunId,
                occurredAt: confirmAt,
              }),
            )
            .catch(() => undefined);
        }
        return releaseUndeliveredCancellation();
      }
      if (
        requestId &&
        !claim.replay &&
        !(await stateStore.markClaimPrepared(claim.runId, jobId, claim.attempt).catch(() => false))
      )
        return new Response(null, { status: 503 });
      return new Response(JSON.stringify(input), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      });
    } catch {
      const current = await stateStore.getRunOutcome(claim.runId);
      if (
        current !== undefined &&
        (current.runnerJobId !== claim.jobId || current.runnerAttempt !== claim.attempt)
      ) {
        return new Response(null, { status: 204 });
      }
      if (current?.status === 'cancelled') return releaseUndeliveredCancellation();
      if (claim.replay)
        return new Response(null, {
          status: current && current.status !== 'scheduled' ? 204 : 503,
        });
      const failedAt = new Date().toISOString();
      if (current === undefined) {
        await stateStore.markSchedulingFailed({
          runId: claim.runId,
          occurredAt: failedAt,
          failure: preparationFailure,
        });
      } else {
        await markRunFailed(
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
      const failedOutcome = await stateStore.getRunOutcome(claim.runId);
      if (failedOutcome?.status === 'failed') {
        await recordFinishedLifecycle(
          lifecycleLog,
          failedOutcome,
          'failed',
          undefined,
          preparationFailure ?? {
            phase: 'unknown',
            reason: 'unknown',
          },
          claim.runId,
        );
      }
      return new Response(null, { status: 503 });
    }
  };

  return {
    recordFinishedLifecycle,
    handleRunnerResult,
    handleRunnerEvidence,
    handleMetadataInvalidation,
    handleRunnerProgress,
    handleRunnerReadToken,
    handleRunnerClaim,
  };
};
