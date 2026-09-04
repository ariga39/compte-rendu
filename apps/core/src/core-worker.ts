import { DateTime, Effect, Option, Schema } from 'effect';
import {
  MAX_RUNNER_CALLBACK_BYTES,
  ReviewEvent,
  RunnerJobInput,
  RunnerResultCallback,
} from '@compte-rendu/contracts';
import {
  createD1ReviewStateStore,
  createGitHubPublicationAdapter,
  createGitHubAppTokenProvider,
  createReviewCoordinator,
  createRunnerJobClient,
  type CoreLifecycleLog,
  type CoreEnv,
  type CoreLifecycleFailureReason,
  type GitHubAdapter,
  type ReviewOutcome,
  type ReviewPublicationStateStore,
} from './index';
import type { D1DatabaseLike } from './review-state-store';
import type { WorkerEntrypoint } from '@compte-rendu/contracts';
import { createCloudflareOperationalLog } from './operational-log';
import { createPostHogLifecycleLog } from './posthog';
import type { OperationalLog } from '@compte-rendu/contracts';
import { formatReviewFailureComment } from './review-publication-format';

export interface CoreWorkerEnv extends Partial<CoreEnv> {
  readonly REVIEW_DB: D1DatabaseLike;
  readonly GITHUB_APP_ID: string;
  readonly GITHUB_APP_PRIVATE_KEY: string;
  readonly EVIDENCE_BUCKET?: R2BucketLike;
  readonly POSTHOG_ENABLED?: string;
  readonly POSTHOG_PROJECT_API_KEY?: string;
  readonly POSTHOG_HOST?: string;
  readonly POSTHOG_DEPLOYMENT?: string;
  readonly POSTHOG_ENVIRONMENT?: string;
  readonly [key: string]: unknown;
}

export interface R2BucketLike {
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
const runnerClaimsPath = '/runner-claims';
const runnerResultsPath = '/runner-results';
const epochMilliseconds = (value: string) => {
  const parsed = DateTime.make(value);
  return Option.isSome(parsed) ? parsed.value.epochMilliseconds : undefined;
};
const RunnerManifest = Schema.Struct({
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
  const resultBytes = new TextEncoder().encode(callback.result);
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
): WorkerEntrypoint<CoreWorkerEnv> => {
  const tokenProvider = createGitHubAppTokenProvider({
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_APP_PRIVATE_KEY,
    crypto: globalThis.crypto,
  });
  const github =
    dependencies.github ??
    createGitHubPublicationAdapter({
      token: tokenProvider.getInstallationToken,
    });
  const stateStore = dependencies.stateStore ?? createD1ReviewStateStore(env.REVIEW_DB);
  const runner =
    env.RUNNER === undefined || env.RUNNER_AUTH_TOKEN === undefined
      ? undefined
      : createRunnerJobClient({ binding: env.RUNNER, authToken: env.RUNNER_AUTH_TOKEN });
  const coordinatorDependencies = {
    github,
    stateStore,
    scheduler: {
      // A webhook only places a durable item in review_runs. The idle Runner
      // claims it through the pull route below.
      schedule: async () => undefined,
      ...(runner === undefined ? {} : { cancel: runner.cancelJob }),
    },
    log: dependencies.log ?? createCloudflareOperationalLog(),
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
      const result = lifecycleLog.record(event);
      if (result instanceof Promise) void result.catch(() => undefined);
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
          { event: 'review finished' }
        >['failurePhase']
      >;
      readonly reason: CoreLifecycleFailureReason;
    },
    runId?: string,
  ) => {
    const occurredAt = await Effect.runPromise(DateTime.now.pipe(Effect.map(DateTime.formatIso)));
    const created = epochMilliseconds(outcome.createdAt);
    const executionStarted = epochMilliseconds(
      callback?.timestamps.executionStartedAt ?? occurredAt,
    );
    const cleanupCompleted = epochMilliseconds(
      callback?.timestamps.cleanupCompletedAt ?? occurredAt,
    );
    const queueWaitMs =
      created !== undefined && executionStarted !== undefined
        ? Math.max(0, executionStarted - created)
        : 0;
    const totalDurationMs =
      created !== undefined && cleanupCompleted !== undefined
        ? Math.max(0, cleanupCompleted - created)
        : 0;
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
    recordLifecycle(lifecycleLog, {
      event: 'review finished',
      runId: callback?.runId ?? runId ?? outcome.deliveryId,
      trigger: outcome.trigger,
      outcome: terminal,
      published: terminal === 'completed',
      totalDurationMs,
      queueWaitMs,
      cleanupStatus:
        callback?.sandbox.cleanup === 'destroyed' || callback?.sandbox.cleanup === 'failed'
          ? callback.sandbox.cleanup
          : 'unknown',
      evidenceStatus: callback?.evidence.status ?? outcome.evidence?.status ?? 'unknown',
      ...(terminal === 'failed'
        ? {
            failurePhase:
              failure?.phase ??
              (failedCallback?.stage === 'checkout' ||
              failedCallback?.stage === 'sandbox' ||
              failedCallback?.stage === 'agent' ||
              failedCallback?.stage === 'cleanup'
                ? failedCallback.stage
                : 'unknown'),
            failureReason,
          }
        : {}),
    });
  };

  const markRunFailed = async (outcome: ReviewOutcome, runId: string, occurredAt: string) => {
    const notificationClaimed =
      (outcome.status === 'scheduled' || outcome.status === 'failed') &&
      stateStore.claimRunPublication !== undefined
        ? await stateStore.claimRunPublication({ runId, occurredAt })
        : false;
    await stateStore.markSchedulingFailed({ runId, occurredAt });
    if (
      (outcome.status === 'scheduled' || outcome.status === 'superseded') &&
      outcome.trigger === 'manual' &&
      outcome.commentId !== undefined &&
      github.addReaction !== undefined
    ) {
      await github
        .addReaction({
          repositoryId: outcome.repositoryId,
          installationId: outcome.installationId,
          commentId: outcome.commentId,
          content: outcome.status === 'superseded' ? 'confused' : '-1',
        })
        .catch(() => undefined);
    }
    if (
      notificationClaimed &&
      outcome.checkRunId !== undefined &&
      github.updateCheckRun !== undefined
    ) {
      await github
        .updateCheckRun({
          repositoryId: outcome.repositoryId,
          installationId: outcome.installationId,
          checkRunId: outcome.checkRunId,
          status: 'failure',
        })
        .catch(() => undefined);
    }
    if (notificationClaimed && github.createIssueComment !== undefined) {
      try {
        await github.createIssueComment({
          repositoryId: outcome.repositoryId,
          pullRequestNumber: outcome.pullRequestNumber,
          installationId: outcome.installationId,
          body: formatReviewFailureComment(runId),
        });
      } catch (error) {
        await stateStore.releaseRunPublicationClaim?.({ runId, occurredAt }).catch(() => false);
        throw error;
      }
    }
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
    if (outcome.status === 'completed') {
      return new Response(null, { status: outcome.evidence === undefined ? 409 : 202 });
    }
    const markCallbackFailed = async () => {
      const occurredAt = await Effect.runPromise(DateTime.now.pipe(Effect.map(DateTime.formatIso)));
      await markRunFailed(outcome, callback.runId, occurredAt);
    };
    const clearRunnerJob = async () => {
      if (callback.sandbox.cleanup !== 'destroyed') return;
      await stateStore.clearRunnerJob?.({ runId: callback.runId, jobId: callback.id });
    };
    if (callback.status === 'succeeded') {
      if (!(await completeCallbackEvidenceIsValid(callback))) {
        if (outcome.status !== 'scheduled') return new Response(null, { status: 409 });
        await markCallbackFailed();
        await recordFinishedLifecycle(lifecycleLog, outcome, 'failed', callback, {
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
        await recordFinishedLifecycle(lifecycleLog, outcome, 'superseded', callback);
        return new Response(null, { status: 202 });
      }
      if (outcome.status === 'failed') {
        await markCallbackFailed();
        await recordFinishedLifecycle(lifecycleLog, outcome, 'failed', callback);
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
        await github
          .updateCheckRun({
            repositoryId: finalOutcome.repositoryId,
            installationId: finalOutcome.installationId,
            checkRunId: finalOutcome.checkRunId,
            status: 'success',
          })
          .catch(() => undefined);
      }
      return new Response(null, { status: finalOutcome.status === 'failed' ? 503 : 202 });
    }

    const terminal = outcome.status === 'superseded' ? 'superseded' : 'failed';
    if (terminal === 'failed') await markCallbackFailed();
    await recordFinishedLifecycle(lifecycleLog, outcome, terminal, callback);
    await clearRunnerJob();
    return new Response(null, { status: 202 });
  };

  const handleRunnerClaim = async (
    request: Request,
    lifecycleLog: ReturnType<typeof createPostHogLifecycleLog>,
  ): Promise<Response> => {
    if (request.headers.get('x-compte-rendu-runner-claim') !== 'verified') {
      return new Response(null, { status: 401 });
    }
    if (stateStore.claimNextJob === undefined) return new Response(null, { status: 503 });

    const occurredAt = await Effect.runPromise(DateTime.now.pipe(Effect.map(DateTime.formatIso)));
    const jobId = globalThis.crypto.randomUUID();
    const claim = await stateStore.claimNextJob({ jobId, attempt: 1, occurredAt });
    if (claim.kind === 'empty') return new Response(null, { status: 204 });

    const claimedOutcome = await stateStore.getRunOutcome(claim.runId).catch(() => undefined);
    const createdAt = claimedOutcome?.createdAt;
    const parsedCreatedAt = createdAt === undefined ? undefined : epochMilliseconds(createdAt);
    const parsedClaimedAt = epochMilliseconds(occurredAt);
    const queueWaitMs =
      parsedCreatedAt !== undefined && parsedClaimedAt !== undefined
        ? Math.max(0, parsedClaimedAt - parsedCreatedAt)
        : 0;
    recordLifecycle(lifecycleLog, {
      event: 'review claimed',
      runId: claim.runId,
      trigger: claim.job.trigger,
      queueWaitMs,
    });

    try {
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
      const input = {
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
      if (
        current?.status !== 'scheduled' ||
        current.runnerJobId !== claim.jobId ||
        current.runnerAttempt !== claim.attempt
      ) {
        return new Response(null, { status: 204 });
      }
      if (current.checkRunId !== undefined && github.updateCheckRun !== undefined) {
        await github
          .updateCheckRun({
            repositoryId: current.repositoryId,
            installationId: current.installationId,
            checkRunId: current.checkRunId,
            status: 'in_progress',
          })
          .catch(() => undefined);
      }
      return new Response(JSON.stringify(input), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    } catch {
      const current = await stateStore.getRunOutcome(claim.runId);
      if (current === undefined) {
        await stateStore.markSchedulingFailed({ runId: claim.runId, occurredAt });
      } else {
        await markRunFailed(current, claim.runId, occurredAt);
      }
      const failedOutcome = await stateStore.getRunOutcome(claim.runId);
      if (failedOutcome?.status === 'failed') {
        await recordFinishedLifecycle(
          lifecycleLog,
          failedOutcome,
          'failed',
          undefined,
          {
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
    fetch: async (request, _env, context) => {
      const lifecycleLog = createPostHogLifecycleLog(env, context);
      if (request.method === 'POST' && new URL(request.url).pathname === runnerClaimsPath) {
        try {
          return await handleRunnerClaim(request, lifecycleLog);
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
