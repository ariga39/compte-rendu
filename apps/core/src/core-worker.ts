import { DateTime, Effect, Option, Schema } from 'effect';
import {
  createCloudflareOperationalLog,
  DEFAULT_REVIEW_NAME,
  readBoundedRequestBody,
  MAX_RUNNER_CALLBACK_BYTES,
  MAX_WEBHOOK_BYTES,
  REVIEW_ATTEMPT_BUDGET_MS,
  type PublicTaskFailure,
  MetadataInvalidationEvent,
  ReviewEvent,
  RunnerJobInput,
  RunnerProgressReport,
  RunnerCleanupRecoveryReport,
  RunnerResultCallback,
  StructuredReviewResult,
  sanitizeOperationalLogEvent,
} from '@compte-rendu/contracts';
import {
  createD1ReviewStateStore,
  createGitHubPublicationAdapter,
  createGitHubAppTokenProvider,
  createReviewCoordinator,
  publishTerminalCheck,
  resetPreviousReviewVerdicts,
  createRunnerJobClient,
  type CoreLifecycleLog,
  type CoreEnv,
  type CoreLifecycleFailureReason,
  type GitHubAdapter,
  type ReviewOutcome,
  type ReviewPublicationStateStore,
} from './index';
import type { D1DatabaseLike } from './review-state-store';
import { createJobControl } from './job-control';
import type { WorkerEntrypoint } from '@compte-rendu/contracts';
import { createPostHogLifecycleLog } from './posthog';
import { handleReviewConfiguration } from './review-configuration';
import type { OperationalLog } from '@compte-rendu/contracts';
import { formatReviewFailureComment } from './review-publication-format';
import {
  handleDashboardRequest,
  refreshRepositoryMetadata,
  validateProgressSnapshot,
  type RefreshSummary,
} from './dashboard';

export interface CoreWorkerEnv extends Partial<CoreEnv> {
  readonly REVIEW_DB: D1DatabaseLike;
  readonly INFERENCE_RELAY?: import('./runner-llm-control').RelayControl & {
    catalog(): Promise<import('../../inference-worker/src/catalog').RelayCatalogSnapshot>;
    refreshCatalog(scheduledTime: number): Promise<void>;
  };
  readonly GITHUB_APP_ID: string;
  readonly GITHUB_APP_PRIVATE_KEY: string;
  readonly DASHBOARD_ORIGIN?: string;
  readonly GITHUB_CHECK_NAME?: string;
  readonly REVIEW_CONFIGURATION_TOKEN?: string;
  readonly RELAY_DEFAULT_MODEL_ROUTE?: string;
  readonly EVIDENCE_BUCKET?: R2BucketLike;
  readonly POSTHOG_ENABLED?: string;
  readonly POSTHOG_PROJECT_API_KEY?: string;
  readonly POSTHOG_HOST?: string;
  readonly POSTHOG_DEPLOYMENT?: string;
  readonly POSTHOG_ENVIRONMENT?: string;
  readonly [key: string]: unknown;
}

export interface R2BucketLike {
  readonly get?: (
    key: string,
  ) => Promise<{ size: number; arrayBuffer(): Promise<ArrayBuffer> } | null>;
  readonly put: (key: string, value: ArrayBuffer | string) => Promise<unknown>;
}

export interface CoreWorkerDependencies {
  readonly github?: GitHubAdapter;
  readonly stateStore?: ReviewPublicationStateStore;
  readonly log?: OperationalLog;
  readonly getReadInstallationToken?: (input: {
    installationId: number;
    repositoryId: number;
  }) => Promise<{ readonly token: string; readonly expiresAt: string }>;
}

const reviewEventsPath = '/review-events';
const metadataEventsPath = '/metadata-events';
const runnerClaimsPath = '/runner-claims';
const runnerReadTokenPath = '/runner-read-token';
const runnerResultsPath = '/runner-results';
const runnerProgressPath = '/runner-progress';
const runnerCleanupRecoveryPath = '/runner-cleanup-recovery';
const MAX_PROGRESS_BYTES = 16 * 1024;
const MAX_READ_TOKEN_REQUEST_BYTES = 16 * 1024;
// Runner reserves one minute before credential expiry; a grant inside that
// window cannot be used for another read and must be replaced before returning.
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
const RunnerManifest = Schema.Struct({
  result: Schema.optional(StructuredReviewResult),
  jobId: Schema.NonEmptyString,
  runId: Schema.NonEmptyString,
  attempt: Schema.Int,
  evidenceId: Schema.NonEmptyString,
  sessionIds: Schema.Array(Schema.NonEmptyString),
  terminal: Schema.Struct({
    status: Schema.Literals(['succeeded', 'failed', 'aborted']),
  }),
  evidence: Schema.Struct({
    id: Schema.NonEmptyString,
    status: Schema.Literals(['complete', 'incomplete']),
  }),
  complete: Schema.Boolean,
  cleanup: Schema.Struct({
    status: Schema.Literals(['destroyed', 'failed']),
  }),
});
const RunnerSessionList = Schema.Union([
  Schema.Array(Schema.Struct({ id: Schema.NonEmptyString })),
  Schema.Struct({ sessions: Schema.Array(Schema.Struct({ id: Schema.NonEmptyString })) }),
]);
const RunnerSessionExport = Schema.Struct({
  info: Schema.Struct({ id: Schema.NonEmptyString }),
  messages: Schema.Array(Schema.Unknown),
});

const decodeArtifact = (content: string): Uint8Array | undefined => {
  const decoded = Schema.decodeUnknownOption(Schema.Uint8ArrayFromBase64)(content);
  return Option.isSome(decoded) ? decoded.value : undefined;
};

const artifactMatchesMetadata = async (artifact: {
  readonly content: string;
  readonly size: number;
  readonly sha256: string;
}) => {
  const bytes = decodeArtifact(artifact.content);
  if (bytes === undefined || bytes.byteLength !== artifact.size) return false;
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  const sha256 = Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return sha256 === artifact.sha256.toLowerCase();
};

const PublicationArchive = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    runId: Schema.NonEmptyString,
    jobId: Schema.NonEmptyString,
    evidence: Schema.Struct({
      manifest: Schema.Struct({ content: Schema.String }),
      validatedReview: Schema.Struct({ content: Schema.String }),
    }),
  }),
);

const decodedJson = <A>(content: string, schema: Schema.ConstraintDecoder<A>): A | undefined => {
  const bytes = decodeArtifact(content);
  if (bytes === undefined) return undefined;
  const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(schema))(
    new TextDecoder().decode(bytes),
  );
  return Option.isSome(decoded) ? decoded.value : undefined;
};

const completeCallbackEvidenceIsValid = async (
  callback: Extract<typeof RunnerResultCallback.Type, { status: 'succeeded' }>,
) => {
  const { evidence } = callback;
  const artifacts = [
    evidence.manifest,
    evidence.opencodeJsonl,
    evidence.opencodeStderr,
    evidence.validatedReview,
    evidence.opencodeSessionList,
    evidence.opencodeExport.content,
  ];
  if (
    !(await Promise.all(artifacts.map(artifactMatchesMetadata)).then((values) =>
      values.every(Boolean),
    ))
  ) {
    return false;
  }
  const manifest = decodedJson(evidence.manifest.content, RunnerManifest);
  const sessionList = decodedJson(evidence.opencodeSessionList.content, RunnerSessionList);
  const sessionExport = decodedJson(evidence.opencodeExport.content.content, RunnerSessionExport);
  if (manifest === undefined || sessionList === undefined || sessionExport === undefined)
    return false;
  const sessionIds = Array.isArray(sessionList)
    ? sessionList.map((session) => session.id)
    : 'sessions' in sessionList
      ? sessionList.sessions.map((session) => session.id)
      : [];
  if (
    sessionIds.length === 0 ||
    manifest.sessionIds.length !== sessionIds.length ||
    manifest.sessionIds.some((sessionId, index) => sessionId !== sessionIds[index]) ||
    !sessionIds.includes(evidence.opencodeExport.sessionId) ||
    sessionExport.info.id !== evidence.opencodeExport.sessionId ||
    manifest.jobId !== callback.id ||
    manifest.runId !== callback.runId ||
    manifest.attempt !== callback.attempt ||
    manifest.evidenceId !== evidence.id ||
    manifest.evidence.id !== evidence.id ||
    manifest.evidence.status !== 'complete' ||
    manifest.terminal.status !== 'succeeded' ||
    manifest.complete !== true ||
    manifest.cleanup.status !== 'destroyed'
  ) {
    return false;
  }
  const reviewBytes = decodeArtifact(evidence.validatedReview.content);
  if (typeof callback.result === 'string') {
    if (manifest.result !== undefined) return false;
  } else if (
    manifest.result === undefined ||
    manifest.result.decision !== callback.result.decision ||
    manifest.result.markdown !== callback.result.markdown
  )
    return false;
  const resultBytes = new TextEncoder().encode(
    typeof callback.result === 'string' ? callback.result : callback.result.markdown,
  );
  return (
    reviewBytes !== undefined &&
    reviewBytes.byteLength === resultBytes.byteLength &&
    reviewBytes.every((byte, index) => byte === resultBytes[index])
  );
};

const responseForDisposition = (
  disposition: Awaited<ReturnType<ReturnType<typeof createReviewCoordinator>['handleReviewEvent']>>,
) => new Response(null, { status: disposition === 'failed' ? 503 : 202 });

export const createCoreWorker = (
  env: CoreWorkerEnv,
  dependencies: CoreWorkerDependencies = {},
): WorkerEntrypoint<CoreWorkerEnv> &
  ReturnType<typeof createJobControl> & {
    reconcileCheckDeliveries(now: number): Promise<void>;
    reconcilePublications(now: number): Promise<void>;
  } => {
  const tokenProvider = createGitHubAppTokenProvider({
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_APP_PRIVATE_KEY,
    crypto: globalThis.crypto,
  });
  const github =
    dependencies.github ??
    createGitHubPublicationAdapter({
      token: tokenProvider.getInstallationToken,
      getReviewAuthorLogin: tokenProvider.getReviewAuthorLogin,
      dashboardOrigin: env.DASHBOARD_ORIGIN,
      checkName: env.GITHUB_CHECK_NAME,
    });
  const stateStore =
    dependencies.stateStore ??
    createD1ReviewStateStore(
      env.REVIEW_DB,
      env.INFERENCE_RELAY ? env.RELAY_DEFAULT_MODEL_ROUTE : undefined,
    );
  const runner =
    env.RUNNER === undefined || env.RUNNER_AUTH_TOKEN === undefined
      ? undefined
      : createRunnerJobClient({ binding: env.RUNNER, authToken: env.RUNNER_AUTH_TOKEN });
  const log = dependencies.log ?? createCloudflareOperationalLog();
  const coordinatorDependencies = {
    github,
    stateStore,
    ...(runner === undefined ? {} : { cancelRunnerJob: runner.cancelJob }),
    log,
  } as const;
  const createCoordinator = (
    lifecycleLog: ReturnType<typeof createPostHogLifecycleLog>,
    deferCheckSetup?: (task: Promise<unknown>) => void,
  ) =>
    createReviewCoordinator({
      ...coordinatorDependencies,
      lifecycleLog,
      ...(deferCheckSetup === undefined
        ? {}
        : { deferCheckSetup: (task: Promise<void>) => deferCheckSetup(task) }),
    });

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
    callback?: typeof RunnerResultCallback.Type,
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
    const occurredAt = await Effect.runPromise(DateTime.now.pipe(Effect.map(DateTime.formatIso)));
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
    releaseRunnerClaim?: { jobId: string; attempt: number },
    failure?: PublicTaskFailure,
  ): Promise<ReviewOutcome | undefined> => {
    const notificationClaimed =
      (outcome.status === 'scheduled' || outcome.status === 'failed') &&
      stateStore.claimRunPublication !== undefined
        ? await stateStore.claimRunPublication({ runId, occurredAt })
        : false;
    const statusWriteSucceeded = await stateStore.markSchedulingFailed({
      runId,
      occurredAt,
      ...(releaseRunnerClaim === undefined ? {} : { releaseRunnerClaim }),
      ...(failure === undefined ? {} : { failure }),
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
        await stateStore.releaseRunPublicationClaim?.({ runId, occurredAt }).catch(() => false);
        throw error;
      }
    }
    return winner;
  };

  const handleRunnerCleanupRecovery = async (request: Request): Promise<Response> => {
    if (request.headers.get('x-compte-rendu-runner-cleanup-recovery') !== 'verified') {
      return new Response(null, { status: 401 });
    }
    const body = await request.arrayBuffer();
    if (body.byteLength > 64 * 1024) return new Response(null, { status: 413 });
    let report: typeof RunnerCleanupRecoveryReport.Type;
    try {
      report = await Schema.decodeUnknownPromise(
        Schema.fromJsonString(RunnerCleanupRecoveryReport),
        {
          onExcessProperty: 'error',
        },
      )(new TextDecoder().decode(body));
    } catch {
      return new Response(null, { status: 400 });
    }
    if (
      env.EVIDENCE_BUCKET === undefined ||
      stateStore.validateRunnerCleanupRecovery === undefined ||
      stateStore.recoverRunnerCleanup === undefined
    ) {
      return new Response(null, { status: 503 });
    }
    if (
      Option.isNone(DateTime.make(report.confirmedAt)) ||
      report.sandboxName !== `compte-rendu-${report.jobId}`
    ) {
      return new Response(null, { status: 400 });
    }
    const validation = await stateStore.validateRunnerCleanupRecovery({
      runId: report.runId,
      jobId: report.jobId,
      attempt: report.attempt,
      evidenceId: report.evidenceId,
      baseSha: report.baseSha,
      headSha: report.headSha,
      sandboxName: report.sandboxName,
      confirmedAt: report.confirmedAt,
    });
    if (validation.kind === 'rejected') return new Response(null, { status: 409 });
    const audit = {
      version: 1,
      ...report,
      confirmedAt:
        validation.kind === 'already'
          ? validation.cleanupCompletedAt || report.confirmedAt
          : report.confirmedAt,
    };
    await env.EVIDENCE_BUCKET.put(
      `cleanup-recoveries/${report.runId}/${report.jobId}/${report.attempt}.json`,
      JSON.stringify(audit),
    );
    const result = await stateStore.recoverRunnerCleanup({
      runId: report.runId,
      jobId: report.jobId,
      attempt: report.attempt,
      evidenceId: report.evidenceId,
      baseSha: report.baseSha,
      headSha: report.headSha,
      sandboxName: report.sandboxName,
      confirmedAt: report.confirmedAt,
    });
    if (result.kind === 'rejected') return new Response(null, { status: 409 });
    return Response.json(
      { accepted: true },
      { status: 202, headers: { 'cache-control': 'no-store' } },
    );
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
    let callback: typeof RunnerResultCallback.Type;
    try {
      callback = await Schema.decodeUnknownPromise(Schema.fromJsonString(RunnerResultCallback))(
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
    if (callback.usage !== undefined) {
      try {
        await stateStore.recordModelUsage?.({
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
    await stateStore.recordResultReceived?.({
      runId: callback.runId,
      jobId: callback.id,
      attempt: callback.attempt,
      occurredAt: await Effect.runPromise(DateTime.now.pipe(Effect.map(DateTime.formatIso))),
    });
    if (
      callback.lifecycle !== undefined &&
      validateProgressSnapshot(callback.lifecycle) &&
      stateStore.recordTerminalLifecycle !== undefined
    ) {
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
      return new Response(null, { status: outcome.evidence === undefined ? 409 : 202 });
    }
    const markCallbackFailed = async () => {
      const occurredAt = await Effect.runPromise(DateTime.now.pipe(Effect.map(DateTime.formatIso)));
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
      return markRunFailed(outcome, callback.runId, occurredAt, undefined, failure);
    };
    const clearRunnerJob = async () => {
      if (callback.sandbox.cleanup !== 'destroyed') return;
      await stateStore.clearRunnerJob?.({ runId: callback.runId, jobId: callback.id });
    };
    if (callback.status === 'succeeded') {
      if (!(await completeCallbackEvidenceIsValid(callback))) {
        const confirmed = await stateStore.confirmRunnerDestroyed?.({
          runId: callback.runId,
          jobId: callback.id,
          attempt: callback.attempt,
          occurredAt: callback.timestamps.cleanupCompletedAt,
          expectedStatus: outcome.status,
        });
        if (!confirmed) return new Response(null, { status: 503 });
        const latest = await stateStore.getRunOutcome(callback.runId).catch(() => undefined);
        if (latest?.status === 'cancelled') return new Response(null, { status: 202 });
        if (outcome.status !== 'scheduled') return new Response(null, { status: 409 });
        const settled = await markCallbackFailed();
        if (settled?.status !== 'failed') return new Response(null, { status: 202 });
        await recordFinishedLifecycle(lifecycleLog, settled, 'failed', callback, {
          phase: 'evidence',
          reason: 'evidence',
        });
        return new Response(null, { status: 202 });
      }
    }

    const evidenceObject = JSON.stringify({
      version: 1,
      runId: callback.runId,
      jobId: callback.id,
      evidenceId: callback.evidence.id,
      evidence: callback.evidence,
    });
    await env.EVIDENCE_BUCKET.put(`reviews/${callback.runId}`, evidenceObject);
    const evidenceBytes = new TextEncoder().encode(evidenceObject);
    const evidenceHash = await globalThis.crypto.subtle.digest('SHA-256', evidenceBytes);
    const evidenceRecorded = await stateStore.recordEvidence({
      runId: callback.runId,
      sandboxCleanup: callback.sandbox.cleanup,
      evidence: {
        key: `reviews/${callback.runId}`,
        status: callback.evidence.status,
        size: evidenceBytes.byteLength,
        sha256: Array.from(new Uint8Array(evidenceHash), (byte) =>
          byte.toString(16).padStart(2, '0'),
        ).join(''),
        uploadedAt: await Effect.runPromise(DateTime.now.pipe(Effect.map(DateTime.formatIso))),
        executionStartedAt: callback.timestamps.executionStartedAt,
        submissionCompletedAt: callback.timestamps.submissionCompletedAt,
        cleanupCompletedAt: callback.timestamps.cleanupCompletedAt,
      },
    });
    if (!evidenceRecorded) return new Response(null, { status: 409 });
    if ((await stateStore.getRunOutcome(callback.runId))?.status === 'cancelled')
      return new Response(null, { status: 202 });

    if (callback.status === 'succeeded') {
      if (outcome.status === 'superseded') {
        await clearRunnerJob();
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
      if (callback.evidence.status !== 'complete' || callback.result === undefined) {
        return new Response(null, { status: 400 });
      }
      const disposition = await createCoordinator(lifecycleLog).completeReview({
        runId: callback.runId,
        output: callback.result,
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
    await clearRunnerJob();
    return new Response(null, { status: 202 });
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
    if (stateStore.invalidateRepositoryMetadataBatch === undefined) {
      return new Response(null, { status: 503 });
    }
    const observedAt = await Effect.runPromise(DateTime.now.pipe(Effect.map(DateTime.formatIso)));
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
    if (stateStore.recordProgress === undefined) return new Response(null, { status: 503 });
    const occurredAt = await Effect.runPromise(DateTime.now.pipe(Effect.map(DateTime.formatIso)));
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
    const occurredAt = await Effect.runPromise(DateTime.now.pipe(Effect.map(DateTime.formatIso)));
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
        if (!(await stateStore.expireClaimHandoff?.(claim.runId, claim.jobId, 1, occurredAt)))
          return new Response(null, { status: 503 });
        const failure = { phase: 'scheduling', reason: 'timeout' } as const;
        const failed = await markRunFailed(outcome, claim.runId, occurredAt, undefined, failure);
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
      const stopped = await stateStore.confirmRunnerDestroyed?.({
        runId: claim.runId,
        jobId: claim.jobId,
        attempt: claim.attempt,
        occurredAt: new Date().toISOString(),
      });
      return new Response(null, { status: stopped ? 204 : 503 });
    };

    let preparationFailure: PublicTaskFailure | undefined;
    try {
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
      if (reset.kind === 'stale') {
        const released = await stateStore.markRunSuperseded?.({
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
      }
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
          await stateStore.clearRunnerJob?.({ runId: claim.runId, jobId: claim.jobId });
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
            .reopenCheckCancellation?.({ runId: claim.runId, checkRunId })
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
              stateStore.confirmCheckCancelled?.({
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
        !(await stateStore
          .markClaimPrepared?.(claim.runId, jobId, claim.attempt)
          .catch(() => false))
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
      const failedAt = await Effect.runPromise(DateTime.now.pipe(Effect.map(DateTime.formatIso)));
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
    async reconcileCheckDeliveries(now) {
      const work = (await stateStore.listPendingCheckDeliveries?.({ limit: 8 })) ?? [];
      const occurredAt = new Date(now).toISOString();
      let incomplete = false;
      for (const item of work) {
        try {
          const outcome = await stateStore.getRunOutcome(item.runId);
          if (outcome === undefined || outcome.checkRunId !== item.checkRunId) {
            incomplete = true;
            continue;
          }
          await publishTerminalCheck({ github, stateStore, runId: item.runId, occurredAt });
        } catch {
          incomplete = true;
        }
      }
      if (incomplete) throw new Error('Check delivery reconciliation incomplete');
    },
    async reconcilePublications(now) {
      const ids =
        (await stateStore.claimStalledPublications?.(
          new Date(now - REVIEW_ATTEMPT_BUDGET_MS).toISOString(),
          new Date(now).toISOString(),
          4,
        )) ?? [];
      const captures: Promise<unknown>[] = [];
      const lifecycle = createPostHogLifecycleLog(env, {
        waitUntil: (task) => captures.push(task),
      });
      let incomplete = false;
      for (const runId of ids) {
        let reason: 'state' | 'evidence' | 'publication' | 'check' = 'state';
        try {
          const outcome = await stateStore.getRunOutcome(runId);
          if (outcome?.status !== 'scheduled' || !outcome.publicationClaimedAt) continue;
          reason = 'evidence';
          const evidence = outcome.evidence;
          const key = `reviews/${runId}`;
          if (!evidence || evidence.key !== key || evidence.size > MAX_RUNNER_CALLBACK_BYTES)
            throw new Error('Invalid evidence metadata');
          const record = await env.EVIDENCE_BUCKET?.get?.(key);
          if (!record || record.size !== evidence.size) throw new Error('Invalid evidence size');
          const bytes = await record.arrayBuffer();
          const hash = await crypto.subtle.digest('SHA-256', bytes);
          const digest = Array.from(new Uint8Array(hash), (value) =>
            value.toString(16).padStart(2, '0'),
          ).join('');
          if (digest !== evidence.sha256 || bytes.byteLength !== evidence.size)
            throw new Error('Invalid evidence digest');
          const archive = Schema.decodeUnknownSync(PublicationArchive)(
            new TextDecoder().decode(bytes),
          );
          const manifest = decodedJson(archive.evidence.manifest.content, RunnerManifest);
          if (
            !manifest ||
            !manifest.complete ||
            manifest.terminal.status !== 'succeeded' ||
            archive.runId !== runId ||
            manifest.runId !== runId ||
            archive.jobId !== outcome.runnerJobId ||
            manifest.jobId !== archive.jobId ||
            manifest.attempt !== outcome.runnerAttempt
          )
            throw new Error('Invalid evidence identity');
          const review = decodeArtifact(archive.evidence.validatedReview.content);
          if (!review) throw new Error('Invalid review artifact');
          const output = manifest.result ?? new TextDecoder().decode(review);
          reason = 'publication';
          const disposition = await createCoordinator(lifecycle).completeReview({
            runId,
            output,
            reconcileClaimedAt: outcome.publicationClaimedAt,
          });
          const settled = await stateStore.getRunOutcome(runId);
          if (!settled || settled.status === 'scheduled')
            throw new Error('Publication still pending');
          if (
            (settled.status === 'completed' || settled.status === 'failed') &&
            disposition === settled.status
          ) {
            await recordFinishedLifecycle(
              lifecycle,
              settled,
              settled.status,
              undefined,
              settled.status === 'failed' ? { phase: 'publication', reason: 'unknown' } : undefined,
              runId,
            );
          }
          if (settled.status === 'completed' && settled.checkRunId !== undefined) {
            reason = 'check';
            await publishTerminalCheck({
              github,
              stateStore,
              runId,
              occurredAt: new Date(now).toISOString(),
            });
          }
        } catch {
          incomplete = true;
          try {
            await log.record({
              phase: 'publication',
              outcome: 'reconciliation_incomplete',
              runId,
              reason,
            });
          } catch {
            // Continue reconciling other runs if the log sink fails.
          }
        }
      }
      await Promise.allSettled(captures);
      if (incomplete) throw new Error('Publication reconciliation incomplete');
    },
    ...createJobControl(stateStore, github, runner, log, (context) =>
      createPostHogLifecycleLog(env, context),
    ),
    fetch: async (request, _env, context) => {
      if (new URL(request.url).pathname === '/review-configuration') {
        return handleReviewConfiguration(
          request,
          env.REVIEW_DB,
          env.REVIEW_CONFIGURATION_TOKEN,
          env.INFERENCE_RELAY,
        );
      }
      const lifecycleLog = createPostHogLifecycleLog(env, context);
      if (request.method === 'POST' && new URL(request.url).pathname === runnerClaimsPath) {
        try {
          return await handleRunnerClaim(request, lifecycleLog);
        } catch {
          return new Response(null, { status: 503 });
        }
      }
      if (request.method === 'POST' && new URL(request.url).pathname === runnerReadTokenPath) {
        try {
          return await handleRunnerReadToken(request);
        } catch {
          return new Response(null, { status: 503 });
        }
      }
      if (
        request.method === 'POST' &&
        new URL(request.url).pathname === runnerCleanupRecoveryPath
      ) {
        try {
          return await handleRunnerCleanupRecovery(request);
        } catch {
          return new Response(null, { status: 503 });
        }
      }
      if (request.method === 'POST' && new URL(request.url).pathname === runnerResultsPath) {
        try {
          return await handleRunnerResult(request, lifecycleLog);
        } catch {
          return new Response(null, { status: 503 });
        }
      }
      if (request.method === 'POST' && new URL(request.url).pathname === runnerProgressPath) {
        try {
          return await handleRunnerProgress(request);
        } catch {
          return new Response(null, { status: 503 });
        }
      }
      if (request.method === 'POST' && new URL(request.url).pathname === metadataEventsPath) {
        try {
          return await handleMetadataInvalidation(request);
        } catch {
          return new Response(null, { status: 503 });
        }
      }
      if (request.method === 'GET' && new URL(request.url).pathname === '/api/dashboard-config') {
        return Response.json(
          { name: env.GITHUB_CHECK_NAME?.trim() || DEFAULT_REVIEW_NAME },
          { headers: { 'cache-control': 'no-store' } },
        );
      }
      if (request.method === 'GET') {
        try {
          const dashboardResponse = await handleDashboardRequest(request, { stateStore });
          if (dashboardResponse !== undefined) return dashboardResponse;
        } catch {
          const path = new URL(request.url).pathname;
          if (path === '/api/dashboard' || path === '/api/jobs' || path.startsWith('/api/jobs/')) {
            return new Response(null, {
              status: 503,
              headers: { 'cache-control': 'no-store' },
            });
          }
        }
      }
      if (request.method !== 'POST' || new URL(request.url).pathname !== reviewEventsPath) {
        return new Response(null, { status: 404 });
      }

      const body = await Effect.runPromise(
        Effect.tryPromise({
          try: () => request.json(),
          catch: () => undefined,
        }).pipe(Effect.catch(() => Effect.succeed(undefined))),
      );
      if (body === undefined) return new Response(null, { status: 400 });

      const event = await Effect.runPromise(
        Schema.decodeUnknownEffect(ReviewEvent)(body).pipe(
          Effect.catch(() => Effect.succeed(undefined)),
        ),
      );
      if (event === undefined) return new Response(null, { status: 400 });

      if (
        event.event === 'pull_request' &&
        event.repositoryVisibility === 'private' &&
        stateStore.invalidateRepositoryMetadata !== undefined
      ) {
        const observedAt = await Effect.runPromise(
          DateTime.now.pipe(Effect.map(DateTime.formatIso)),
        );
        await stateStore
          .invalidateRepositoryMetadata({
            installationId: event.installationId,
            repositoryId: event.repositoryId,
            visibility: 'private',
            updatedAt: observedAt,
            nextRefreshAt: observedAt,
          })
          .catch(() => false);
      }

      try {
        const eventCoordinator = createCoordinator(
          lifecycleLog,
          context === undefined ? undefined : (task) => context.waitUntil(task),
        );
        const disposition = await eventCoordinator.handleReviewEvent(event);
        return responseForDisposition(disposition);
      } catch {
        return new Response(null, { status: 503 });
      }
    },
  };
};

export const runScheduledMetadataRefresh = async (
  env: CoreWorkerEnv,
  dependencies: CoreWorkerDependencies = {},
): Promise<RefreshSummary> => {
  const tokenProvider = createGitHubAppTokenProvider({
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_APP_PRIVATE_KEY,
    crypto: globalThis.crypto,
  });
  const github =
    dependencies.github ??
    createGitHubPublicationAdapter({ token: tokenProvider.getInstallationToken });
  const stateStore =
    dependencies.stateStore ??
    createD1ReviewStateStore(
      env.REVIEW_DB,
      env.INFERENCE_RELAY ? env.RELAY_DEFAULT_MODEL_ROUTE : undefined,
    );
  const log = dependencies.log ?? createCloudflareOperationalLog();
  const summary = await refreshRepositoryMetadata({ stateStore, github });
  try {
    await log.record(
      sanitizeOperationalLogEvent({ phase: 'core', outcome: 'metadata_refresh', ...summary }),
    );
  } catch {
    // aggregate refresh facts are best-effort
  }
  return summary;
};
