import { DateTime, Effect, Schema } from 'effect';
import {
  MAX_RUNNER_CALLBACK_BYTES,
  ReviewEvent,
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
  type ReviewScheduler,
} from './index';
import type { D1DatabaseLike } from './review-state-store';
import type { WorkerEntrypoint } from '@compte-rendu/contracts';
import { createCloudflareOperationalLog } from './operational-log';
import type { OperationalLog } from '@compte-rendu/contracts';
import type { RunnerJobSubmitter } from './runner-job-client';

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
const runnerResultsPath = '/runner-results';
const hasCompleteCallbackEvidence = (evidence: (typeof RunnerResultCallback.Type)['evidence']) =>
  evidence.manifest.length > 0 &&
  evidence.opencodeJsonl.length > 0 &&
  evidence.validatedReview !== undefined &&
  evidence.validatedReview.length > 0 &&
  evidence.opencodeSessionList !== undefined &&
  evidence.opencodeSessionList.length > 0 &&
  evidence.opencodeExport !== undefined &&
  evidence.opencodeExport.content.length > 0;

const callbackArtifactMatchesResult = (
  evidence: (typeof RunnerResultCallback.Type)['evidence'],
  result: string,
) => {
  if (evidence.validatedReview === undefined) return false;
  try {
    const decoded = globalThis.atob(evidence.validatedReview);
    const artifact = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
    const expected = new TextEncoder().encode(result);
    return (
      artifact.byteLength === expected.byteLength &&
      artifact.every((byte, index) => byte === expected[index])
    );
  } catch {
    return false;
  }
};

const createRunnerScheduler = (
  runner: RunnerJobSubmitter,
  github: GitHubAdapter,
  stateStore: ReviewPublicationStateStore,
  getReadInstallationToken: (input: {
    installationId: number;
    repositoryId: number;
  }) => Promise<{ readonly token: string; readonly expiresAt: string }>,
): ReviewScheduler => ({
  schedule: async (job, runId) => {
    if (github.getRepositoryUrl === undefined) throw new Error('Repository lookup unavailable');
    const repositoryUrl = await Schema.decodeUnknownPromise(Schema.NonEmptyString)(
      await github.getRepositoryUrl({
        repositoryId: job.repositoryId,
        installationId: job.installationId,
      }),
    );
    const repositoryName = new URL(repositoryUrl).pathname.replace(/^\//, '').replace(/\.git$/, '');
    if (!/^[^/]+\/[^/]+$/.test(repositoryName)) throw new Error('Repository identity is invalid');
    const readGrant = await getReadInstallationToken({
      installationId: job.installationId,
      repositoryId: job.repositoryId,
    });
    const admitted = await runner.submitJob({
      runId,
      repositoryUrl,
      repositoryName,
      pullRequestNumber: job.pullRequestNumber,
      baseSha: job.baseSha,
      headSha: job.headSha,
      repositoryReadToken: readGrant.token,
    });
    if (
      !(await stateStore.recordRunnerJob({ runId, jobId: admitted.id, attempt: admitted.attempt }))
    ) {
      throw new Error('Runner Job identity could not be recorded');
    }
  },
});

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
    scheduler:
      runner === undefined
        ? {
            schedule: async () => {
              throw new Error('Runner binding unavailable');
            },
          }
        : createRunnerScheduler(
            runner,
            github,
            stateStore,
            dependencies.getReadInstallationToken ??
              ((input) =>
                tokenProvider.getReadInstallationToken(input.installationId, input.repositoryId)),
          ),
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
      callback = await Schema.decodeUnknownPromise(RunnerResultCallback)(
        JSON.parse(new TextDecoder().decode(body)),
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
    if (
      callback.status === 'succeeded' &&
      (outcome.status !== 'scheduled' ||
        callback.evidence.status !== 'complete' ||
        !hasCompleteCallbackEvidence(callback.evidence) ||
        callback.result === undefined ||
        !callbackArtifactMatchesResult(callback.evidence, callback.result) ||
        callback.sandbox.cleanup !== 'destroyed')
    ) {
      return new Response(null, { status: 409 });
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
      if (callback.evidence.status !== 'complete' || callback.result === undefined) {
        return new Response(null, { status: 400 });
      }
      const disposition = await coordinator.completeReview({
        runId: callback.runId,
        output: callback.result,
      });
      return new Response(null, { status: disposition === 'failed' ? 503 : 202 });
    }

    await stateStore.markSchedulingFailed({
      runId: callback.runId,
      occurredAt: new Date().toISOString(),
    });
    if (
      outcome.status === 'scheduled' &&
      outcome.trigger === 'manual' &&
      outcome.commentId !== undefined &&
      github.addReaction !== undefined
    ) {
      await github.addReaction({
        repositoryId: outcome.repositoryId,
        installationId: outcome.installationId,
        commentId: outcome.commentId,
        content: '-1',
      });
    }
    return new Response(null, { status: 202 });
  };

  return {
    fetch: async (request) => {
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
