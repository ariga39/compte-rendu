import { vi } from 'vitest';
import type { CoreWorker } from '../../apps/core/src/core-worker';
import type { ReviewPublicationStateStore } from '../../apps/core/src/index';
import type { ReviewEvent } from '../../packages/contracts/src';
import type { SqliteD1Database } from './d1-database';

export type { CoreWorker };

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

export const successfulCallback = async (runId: string, id = 'runner-job-1', attempt = 1) =>
  JSON.stringify({
    version: 2,
    id,
    runId,
    attempt,
    baseSha: eligibleEvent.baseSha,
    headSha: eligibleEvent.headSha,
    status: 'succeeded',
    stage: 'cleanup',
    sandbox: { cleanup: 'destroyed' },
    evidence: { id: 'evidence-1', status: 'complete' },
    timestamps: {
      executionStartedAt: '2026-09-01T00:00:01.000Z',
      submissionCompletedAt: '2026-09-01T00:00:02.000Z',
      cleanupCompletedAt: '2026-09-01T00:00:03.000Z',
    },
    result: {
      version: 2,
      decision: 'comment',
      markdown: '## Review:\n\nNo defects found.\n',
    },
  });

export const failedCallback = async (
  runId: string,
  id = 'runner-job-1',
  attempt = 1,
  cleanup: 'pending' | 'destroyed' | 'failed' = 'destroyed',
) =>
  JSON.stringify({
    version: 2,
    id,
    runId,
    attempt,
    baseSha: eligibleEvent.baseSha,
    headSha: eligibleEvent.headSha,
    status: 'failed',
    stage: 'agent',
    sandbox: { cleanup },
    evidence: { id: 'evidence-1', status: 'incomplete' },
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
    version: 2,
    id,
    runId,
    attempt,
    baseSha: eligibleEvent.baseSha,
    headSha: eligibleEvent.headSha,
    status: 'aborted',
    stage: 'cleanup',
    sandbox: { cleanup },
    evidence: { id: 'evidence-aborted', status: 'incomplete' },
    timestamps: { cleanupCompletedAt: '2026-09-01T00:00:03.000Z' },
  });

/**
 * Tests build historical state through the current production writes. Evidence
 * metadata uses the owner-checked upload write; cleanup and terminal timestamps
 * use the real Runner terminal update.
 */
export const recordTestEvidence = async (
  store: Pick<
    ReviewPublicationStateStore,
    'getRunOutcome' | 'recordRunnerTerminal' | 'recordEvidenceUpload'
  >,
  input: {
    readonly runId: string;
    readonly jobId?: string;
    readonly attempt?: number;
    readonly evidence?: {
      readonly key: string;
      readonly status: 'complete' | 'incomplete';
      readonly size: number;
      readonly sha256: string;
      readonly uploadedAt: string;
      readonly executionStartedAt?: string;
      readonly submissionCompletedAt?: string;
      readonly cleanupCompletedAt?: string;
    };
    readonly sandboxCleanup?: 'pending' | 'destroyed' | 'failed';
  },
) => {
  const outcome = await store.getRunOutcome(input.runId);
  const jobId = input.jobId ?? outcome?.runnerJobId;
  const attempt = input.attempt ?? outcome?.runnerAttempt;
  if (jobId === undefined || attempt === undefined) {
    throw new Error('test evidence requires a retained Runner job identity');
  }
  let written = true;
  if (input.evidence !== undefined) {
    written =
      (await store.recordEvidenceUpload({
        runId: input.runId,
        jobId,
        attempt,
        evidence: {
          key: input.evidence.key,
          status: input.evidence.status,
          size: input.evidence.size,
          sha256: input.evidence.sha256,
          uploadedAt: input.evidence.uploadedAt,
        },
      })) && written;
  }
  written =
    (await store.recordRunnerTerminal({
      runId: input.runId,
      jobId,
      attempt,
      cleanup: input.sandboxCleanup ?? outcome?.cleanup ?? 'pending',
      ...(input.evidence?.executionStartedAt === undefined
        ? {}
        : { executionStartedAt: input.evidence.executionStartedAt }),
      ...(input.evidence?.submissionCompletedAt === undefined
        ? {}
        : { submissionCompletedAt: input.evidence.submissionCompletedAt }),
      ...(input.evidence?.cleanupCompletedAt === undefined
        ? {}
        : { cleanupCompletedAt: input.evidence.cleanupCompletedAt }),
    })) && written;
  return written;
};

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
  new Request('https://reviews.test/runner-claim', { method: 'POST' });

export const scheduleEligibleReview = (worker: CoreWorker, headSha: string, deliveryId: string) =>
  worker.submitReviewEvent({ ...eligibleEvent, headSha, deliveryId });

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
