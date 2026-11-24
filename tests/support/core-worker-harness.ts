import { vi } from 'vitest';
import type { createCoreWorker } from '../../apps/core/src/core-worker';
import type { ReviewPublicationStateStore } from '../../apps/core/src/index';
import type { ReviewEvent } from '../../packages/contracts/src';
import type { SqliteD1Database } from './d1-database';

export const eligibleEvent: Extract<ReviewEvent, { event: 'pull_request' }> = {
  deliveryId: 'delivery-core-worker-1',
  event: 'pull_request',
  action: 'opened',
  repositoryId: 11,
  pullRequestNumber: 42,
  installationId: 7,
  repositoryVisibility: 'private',
  baseRepositoryId: 11,
  headRepositoryId: 99,
  draft: false,
  baseSha: '1111111111111111111111111111111111111111',
  headSha: '2222222222222222222222222222222222222222',
};

export const runnerResponse = (request: Request) =>
  request
    .clone()
    .json()
    .then((input: { runId: string; id?: string }) =>
      Response.json(
        {
          id: input.id ?? 'runner-job-1',
          runId: input.runId,
          attempt: 1,
          evidence: { id: 'evidence-1', status: 'pending' },
          status: 'queued',
          stage: 'admission',
          sandbox: { cleanup: 'pending' },
        },
        { status: 202 },
      ),
    );

export const coreEnv = (database: SqliteD1Database, runnerFetch = runnerResponse) => ({
  REVIEW_DB: database,
  RUNNER: { fetch: runnerFetch },
  RUNNER_AUTH_TOKEN: 'runner-auth-token',
  GITHUB_APP_ID: '1234567',
  GITHUB_APP_PRIVATE_KEY: 'test-private-key',
});

export const deferred = <A>() => {
  let resolve!: (value: A | PromiseLike<A>) => void;
  const promise = new Promise<A>((next) => {
    resolve = next;
  });
  return { promise, resolve };
};

export const evidenceField = async (content: string) => {
  const decoded = globalThis.atob(content);
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return {
    content,
    size: bytes.byteLength,
    sha256: Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join(''),
  };
};

export const jsonlArtifact = 'e30=';
export const sessionListArtifact = 'W3siaWQiOiJzZXNzaW9uLTEifV0=';
export const exportArtifact = 'eyJpbmZvIjp7ImlkIjoic2Vzc2lvbi0xIn0sIm1lc3NhZ2VzIjpbXX0=';
export const reviewArtifact = 'IyMgUmV2aWV3OgoKTm8gZGVmZWN0cyBmb3VuZC4K';
export const manifestArtifact = (runId: string, id: string, attempt: number) =>
  Buffer.from(
    JSON.stringify({
      jobId: id,
      runId,
      attempt,
      evidenceId: 'evidence-1',
      sessionIds: ['session-1'],
      terminal: { status: 'succeeded' },
      evidence: { id: 'evidence-1', status: 'complete' },
      complete: true,
      cleanup: { status: 'destroyed' },
    }),
  ).toString('base64');

export const successfulCallback = async (runId: string, id = 'runner-job-1', attempt = 1) =>
  JSON.stringify({
    id,
    runId,
    attempt,
    status: 'succeeded',
    stage: 'cleanup',
    sandbox: { cleanup: 'destroyed' },
    evidence: {
      id: 'evidence-1',
      status: 'complete',
      manifest: await evidenceField(manifestArtifact(runId, id, attempt)),
      opencodeJsonl: await evidenceField(jsonlArtifact),
      opencodeStderr: await evidenceField(''),
      validatedReview: await evidenceField(reviewArtifact),
      opencodeSessionList: await evidenceField(sessionListArtifact),
      opencodeExport: { sessionId: 'session-1', content: await evidenceField(exportArtifact) },
    },
    timestamps: {
      executionStartedAt: '2026-09-01T00:00:01.000Z',
      submissionCompletedAt: '2026-09-01T00:00:02.000Z',
      cleanupCompletedAt: '2026-09-01T00:00:03.000Z',
    },
    result: '## Review:\n\nNo defects found.\n',
  });

export const failedCallback = async (runId: string, id = 'runner-job-1', attempt = 1) =>
  JSON.stringify({
    id,
    runId,
    attempt,
    status: 'failed',
    stage: 'agent',
    sandbox: { cleanup: 'destroyed' },
    evidence: {
      id: 'evidence-1',
      status: 'incomplete',
      manifest: await evidenceField(''),
      opencodeJsonl: await evidenceField(''),
      opencodeStderr: await evidenceField(''),
    },
    timestamps: {},
    failure: { reason: 'agent' },
  });

export const abortedCallback = async (
  runId: string,
  id: string,
  attempt = 1,
  cleanup: 'pending' | 'destroyed' | 'failed' = 'destroyed',
) =>
  JSON.stringify({
    id,
    runId,
    attempt,
    status: 'aborted',
    stage: 'cleanup',
    sandbox: { cleanup },
    evidence: {
      id: 'evidence-aborted',
      status: 'incomplete',
      manifest: await evidenceField(''),
      opencodeJsonl: await evidenceField(''),
      opencodeStderr: await evidenceField(''),
    },
    timestamps: { cleanupCompletedAt: '2026-09-01T00:00:03.000Z' },
  });

export const postHogEvents = async (requests: readonly Request[]) =>
  Promise.all(
    requests.map(async (request) => {
      const payload = JSON.parse(await request.clone().text()) as {
        batch: readonly unknown[];
      };
      return payload.batch;
    }),
  ).then((batches) => batches.flat());

export const postHogTestDefaults = {
  environment: {
    POSTHOG_ENABLED: 'true',
    POSTHOG_PROJECT_API_KEY: 'phc_test_project_key',
    POSTHOG_HOST: 'https://posthog.example.test',
    POSTHOG_DEPLOYMENT: 'test-installation',
    POSTHOG_ENVIRONMENT: 'staging',
  },
  dependencies: {
    github: {
      getRepositoryUrl: async () => 'https://github.com/acme/reviewed.git',
      loadReviewTarget: async () => ({ headSha: eligibleEvent.headSha }),
    },
    getReadInstallationToken: async () => ({
      token: 'read-token',
      expiresAt: '2026-09-01T01:00:00.000Z',
    }),
  },
} as const;

export const runnerClaimRequest = () =>
  new Request('https://core.internal/runner-claims', {
    method: 'POST',
    headers: { 'x-compte-rendu-runner-claim': 'verified' },
  });

export const scheduleEligibleReview = (
  worker: ReturnType<typeof createCoreWorker>,
  headSha: string,
  deliveryId: string,
) =>
  worker.fetch(
    new Request('https://core.internal/review-events', {
      method: 'POST',
      body: JSON.stringify({ ...eligibleEvent, headSha, deliveryId }),
    }),
  );

export const claimGithub = (headSha: string | (() => string) = eligibleEvent.headSha) => ({
  getRepositoryUrl: async () => 'https://github.com/acme/reviewed.git',
  loadReviewTarget: async () => ({
    headSha: typeof headSha === 'function' ? headSha() : headSha,
  }),
});

export const capturePostHogTransport = (status = 200) => {
  const requests: Request[] = [];
  const waitUntilTasks: Promise<unknown>[] = [];
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    requests.push(new Request(input, init));
    return new Response('{}', { status });
  });
  return { fetcher, requests, waitUntilTasks };
};

export const failReadAfterSchedulingWrite = (
  state: ReviewPublicationStateStore,
  ownership: 'owned' | 'unowned',
): ReviewPublicationStateStore => {
  let failNextRead = false;
  return {
    ...state,
    ...(ownership === 'unowned' ? { claimRunPublication: async () => false } : {}),
    markSchedulingFailed: async (input) => {
      const written = await state.markSchedulingFailed(input);
      failNextRead = true;
      return written;
    },
    getRunOutcome: async (runId) => {
      if (failNextRead) {
        failNextRead = false;
        throw new Error('review state read unavailable');
      }
      return state.getRunOutcome(runId);
    },
  };
};
