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
  type CoreEnv,
  type GitHubAdapter,
  type ReviewPublicationStateStore,
} from './index';
import type { D1DatabaseLike } from './review-state-store';
import type { WorkerEntrypoint } from '@compte-rendu/contracts';
import { createCloudflareOperationalLog } from './operational-log';
import type { OperationalLog } from '@compte-rendu/contracts';

export interface CoreWorkerEnv extends Partial<CoreEnv> {
  readonly REVIEW_DB: D1DatabaseLike;
  readonly GITHUB_APP_ID: string;
  readonly GITHUB_APP_PRIVATE_KEY: string;
  readonly EVIDENCE_BUCKET?: R2BucketLike;
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
  const coordinator = createReviewCoordinator({
    github,
    stateStore,
    scheduler: {
      // A webhook only places a durable item in review_runs. The idle Runner
      // claims it through the pull route below.
      schedule: async () => undefined,
      ...(runner === undefined ? {} : { cancel: runner.cancelJob }),
    },
    log: dependencies.log ?? createCloudflareOperationalLog(),
  });

  const handleRunnerResult = async (request: Request): Promise<Response> => {
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
      await stateStore.markSchedulingFailed({ runId: callback.runId, occurredAt });
      if (
        (outcome.status === 'scheduled' || outcome.status === 'superseded') &&
        outcome.trigger === 'manual' &&
        outcome.commentId !== undefined &&
        github.addReaction !== undefined
      ) {
        await github.addReaction({
          repositoryId: outcome.repositoryId,
          installationId: outcome.installationId,
          commentId: outcome.commentId,
          content: outcome.status === 'superseded' ? 'confused' : '-1',
        });
      }
    };
    if (callback.status === 'succeeded') {
      if (!(await completeCallbackEvidenceIsValid(callback))) {
        if (outcome.status !== 'scheduled') return new Response(null, { status: 409 });
        await markCallbackFailed();
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
        return new Response(null, { status: 202 });
      }
      if (outcome.status !== 'scheduled') return new Response(null, { status: 202 });
      if (callback.evidence.status !== 'complete' || callback.result === undefined) {
        return new Response(null, { status: 400 });
      }
      const disposition = await coordinator.completeReview({
        runId: callback.runId,
        output: callback.result,
      });
      return new Response(null, { status: disposition === 'failed' ? 503 : 202 });
    }

    await markCallbackFailed();
    return new Response(null, { status: 202 });
  };

  const handleRunnerClaim = async (request: Request): Promise<Response> => {
    if (request.headers.get('x-compte-rendu-runner-claim') !== 'verified') {
      return new Response(null, { status: 401 });
    }
    if (stateStore.claimNextJob === undefined) return new Response(null, { status: 503 });

    const occurredAt = await Effect.runPromise(DateTime.now.pipe(Effect.map(DateTime.formatIso)));
    const jobId = globalThis.crypto.randomUUID();
    const claim = await stateStore.claimNextJob({ jobId, attempt: 1, occurredAt });
    if (claim.kind === 'empty') return new Response(null, { status: 204 });

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
      return new Response(JSON.stringify(input), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    } catch {
      await stateStore.markSchedulingFailed({ runId: claim.runId, occurredAt });
      return new Response(null, { status: 503 });
    }
  };

  return {
    fetch: async (request) => {
      if (request.method === 'POST' && new URL(request.url).pathname === runnerClaimsPath) {
        try {
          return await handleRunnerClaim(request);
        } catch {
          return new Response(null, { status: 503 });
        }
      }
      if (request.method === 'POST' && new URL(request.url).pathname === runnerResultsPath) {
        try {
          return await handleRunnerResult(request);
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
        const disposition = await coordinator.handleReviewEvent(event);
        return responseForDisposition(disposition);
      } catch {
        return new Response(null, { status: 503 });
      }
    },
  };
};
