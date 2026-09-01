import { describe, expect, it } from 'vitest';
import { createCoreWorker } from '../apps/core/src/core-worker';
import { createD1ReviewStateStore, createInMemoryReviewStateStore } from '../apps/core/src/index';
import { createGitHubPublicationAdapter } from '../apps/core/src/github-review-adapter';
import type { ReviewEvent } from '../packages/contracts/src';
import type { OperationalLogEvent } from '../packages/contracts/src';
import { SqliteD1Database } from './support/d1-database';

const eligibleEvent: ReviewEvent = {
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

const runnerResponse = (request: Request) =>
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

const coreEnv = (database: SqliteD1Database, runnerFetch = runnerResponse) => ({
  REVIEW_DB: database,
  RUNNER: { fetch: runnerFetch },
  RUNNER_AUTH_TOKEN: 'runner-auth-token',
  GITHUB_APP_ID: '1234567',
  GITHUB_APP_PRIVATE_KEY: 'test-private-key',
});

const evidenceField = async (content: string) => {
  const decoded = globalThis.atob(content);
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return {
    content,
    size: bytes.byteLength,
    sha256: Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join(''),
  };
};

const jsonlArtifact = 'e30=';
const sessionListArtifact = 'W3siaWQiOiJzZXNzaW9uLTEifV0=';
const exportArtifact = 'eyJpbmZvIjp7ImlkIjoic2Vzc2lvbi0xIn0sIm1lc3NhZ2VzIjpbXX0=';
const reviewArtifact = 'IyMgUmV2aWV3OgoKTm8gZGVmZWN0cyBmb3VuZC4K';
const manifestArtifact = (runId: string, id: string, attempt: number) =>
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

const successfulCallback = async (runId: string, id = 'runner-job-1', attempt = 1) =>
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

const failedCallback = async (runId: string, id = 'runner-job-1', attempt = 1) =>
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

describe('Core Worker', () => {
  it('claims and immediately submits one Runner Job without creating a Workflow', async () => {
    const database = new SqliteD1Database();
    const runnerRequests: Request[] = [];
    const worker = createCoreWorker(
      {
        REVIEW_DB: database,
        RUNNER: {
          fetch: async (request) => {
            runnerRequests.push(request.clone());
            return runnerResponse(request);
          },
        },
        RUNNER_AUTH_TOKEN: 'runner-auth-token',
        GITHUB_APP_ID: '1234567',
        GITHUB_APP_PRIVATE_KEY: 'test-private-key',
      },
      {
        github: { getRepositoryUrl: async () => 'https://github.com/acme/reviewed.git' },
        getReadInstallationToken: async () => ({
          token: 'repository-read-token',
          expiresAt: '2026-09-01T01:00:00.000Z',
        }),
      },
    );

    try {
      const response = await worker.fetch(
        new Request('https://core.internal/review-events', {
          method: 'POST',
          body: JSON.stringify(eligibleEvent),
        }),
      );

      expect(response.status).toBe(202);
      expect(runnerRequests).toHaveLength(1);
      expect(runnerRequests[0]?.method).toBe('POST');
      expect(runnerRequests[0]?.headers.get('authorization')).toBe('Bearer runner-auth-token');
      expect(await runnerRequests[0]?.json()).toMatchObject({
        runId: expect.any(String),
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        attempt: 1,
        repositoryUrl: 'https://github.com/acme/reviewed.git',
        repositoryName: 'acme/reviewed',
        pullRequestNumber: 42,
        baseSha: eligibleEvent.baseSha,
        headSha: eligibleEvent.headSha,
        repositoryReadToken: 'repository-read-token',
      });
    } finally {
      database.close();
    }
  });

  it('retries a lost Runner admission with the same immutable Job input', async () => {
    const database = new SqliteD1Database();
    const runnerRequests: Request[] = [];
    let admissions = 0;
    const worker = createCoreWorker(
      {
        REVIEW_DB: database,
        RUNNER: {
          fetch: async (request) => {
            runnerRequests.push(request.clone());
            admissions += 1;
            if (admissions === 1) throw new Error('Runner response was lost');
            return runnerResponse(request);
          },
        },
        RUNNER_AUTH_TOKEN: 'runner-auth-token',
        GITHUB_APP_ID: '1234567',
        GITHUB_APP_PRIVATE_KEY: 'test-private-key',
      },
      {
        github: { getRepositoryUrl: async () => 'https://github.com/acme/reviewed.git' },
        getReadInstallationToken: async () => ({
          token: 'repository-read-token',
          expiresAt: '2026-09-01T01:00:00.000Z',
        }),
      },
    );

    try {
      const response = await worker.fetch(
        new Request('https://core.internal/review-events', {
          method: 'POST',
          body: JSON.stringify({ ...eligibleEvent, deliveryId: 'delivery-admission-retry' }),
        }),
      );

      expect(response.status).toBe(202);
      expect(runnerRequests).toHaveLength(2);
      const firstInput = await runnerRequests[0]?.json();
      const secondInput = await runnerRequests[1]?.json();
      expect(secondInput).toEqual(firstInput);
      expect(firstInput).toMatchObject({ id: expect.any(String), attempt: 1 });
    } finally {
      database.close();
    }
  });

  it('stores callback evidence in R2 before publishing a successful runner result', async () => {
    const database = new SqliteD1Database();
    const stateStore = createD1ReviewStateStore(database);
    const claimed = await stateStore.claimReview({
      deliveryId: 'delivery-runner-callback',
      job: {
        repositoryId: 11,
        pullRequestNumber: 42,
        installationId: 7,
        baseSha: eligibleEvent.baseSha,
        headSha: eligibleEvent.headSha,
        trigger: 'automatic',
      },
      occurredAt: '2026-09-01T00:00:00.000Z',
    });
    if (claimed.kind !== 'claimed') throw new Error('test run was not claimed');
    if (
      !(await stateStore.recordRunnerJob({
        runId: claimed.runId,
        jobId: 'runner-job-1',
        attempt: 1,
      }))
    ) {
      throw new Error('test runner job was not recorded');
    }

    const stored: Array<{ key: string; value: ArrayBuffer | string }> = [];
    const reviews: unknown[] = [];
    const worker = createCoreWorker(
      {
        REVIEW_DB: database,
        GITHUB_APP_ID: '1234567',
        GITHUB_APP_PRIVATE_KEY: 'test-private-key',
        EVIDENCE_BUCKET: {
          put: async (key, value) => stored.push({ key, value }),
        },
      },
      {
        stateStore,
        github: {
          loadReviewTarget: async () => ({ headSha: eligibleEvent.headSha }),
          createReview: async ({ payload }) => {
            reviews.push(payload);
            return { kind: 'created', review: payload };
          },
        },
      },
    );

    try {
      const callbackBody = JSON.stringify({
        id: 'runner-job-1',
        runId: claimed.runId,
        attempt: 1,
        status: 'succeeded',
        stage: 'cleanup',
        sandbox: { cleanup: 'destroyed' },
        evidence: {
          id: 'evidence-1',
          status: 'complete',
          manifest: await evidenceField(manifestArtifact(claimed.runId, 'runner-job-1', 1)),
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
      const missingDecisiveTimestamp = JSON.parse(callbackBody) as {
        timestamps: Record<string, string>;
      };
      delete missingDecisiveTimestamp.timestamps.cleanupCompletedAt;
      const incompleteResponse = await worker.fetch(
        new Request('https://core.internal/runner-results', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-compte-rendu-runner-callback': 'verified',
          },
          body: JSON.stringify(missingDecisiveTimestamp),
        }),
      );
      expect(incompleteResponse.status).toBe(400);
      expect(stored).toHaveLength(0);
      expect(reviews).toHaveLength(0);
      const wrongIdResponse = await worker.fetch(
        new Request('https://core.internal/runner-results', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-compte-rendu-runner-callback': 'verified',
          },
          body: callbackBody.replace('runner-job-1', 'wrong-runner-job'),
        }),
      );
      expect(wrongIdResponse.status).toBe(409);
      const wrongAttemptResponse = await worker.fetch(
        new Request('https://core.internal/runner-results', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-compte-rendu-runner-callback': 'verified',
          },
          body: callbackBody.replace('"attempt":1', '"attempt":999'),
        }),
      );
      expect(wrongAttemptResponse.status).toBe(409);
      const response = await worker.fetch(
        new Request('https://core.internal/runner-results', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-compte-rendu-runner-callback': 'verified',
          },
          body: callbackBody,
        }),
      );

      expect(response.status).toBe(202);
      expect(stored).toHaveLength(1);
      expect(stored[0]?.key).toBe(`reviews/${claimed.runId}`);
      const evidenceObject = JSON.parse(stored[0]?.value as string) as {
        evidence: Record<string, unknown>;
      };
      expect(evidenceObject.evidence).toEqual({
        id: 'evidence-1',
        status: 'complete',
        manifest: await evidenceField(manifestArtifact(claimed.runId, 'runner-job-1', 1)),
        opencodeJsonl: await evidenceField(jsonlArtifact),
        opencodeStderr: await evidenceField(''),
        validatedReview: await evidenceField(reviewArtifact),
        opencodeSessionList: await evidenceField(sessionListArtifact),
        opencodeExport: { sessionId: 'session-1', content: await evidenceField(exportArtifact) },
      });
      expect(evidenceObject.evidence).not.toHaveProperty('files');
      expect(reviews).toEqual([
        {
          event: 'COMMENT',
          commit_id: eligibleEvent.headSha,
          body: `<!-- compte-rendu:run:${claimed.runId} -->\n## Review:\n\nNo defects found.\n`,
        },
      ]);
      const replay = await worker.fetch(
        new Request('https://core.internal/runner-results', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-compte-rendu-runner-callback': 'verified',
          },
          body: callbackBody,
        }),
      );
      expect(replay.status).toBe(202);
      expect(stored).toHaveLength(1);
      expect(reviews).toHaveLength(1);
      await expect(stateStore.getRunOutcome(claimed.runId)).resolves.toMatchObject({
        status: 'completed',
        evidence: {
          key: `reviews/${claimed.runId}`,
          status: 'complete',
          size: expect.any(Number),
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          executionStartedAt: '2026-09-01T00:00:01.000Z',
          submissionCompletedAt: '2026-09-01T00:00:02.000Z',
          cleanupCompletedAt: '2026-09-01T00:00:03.000Z',
        },
      });
    } finally {
      database.close();
    }
  });

  it('does not publish callbacks for unknown, failed, or superseded runs', async () => {
    const database = new SqliteD1Database();
    const stateStore = createD1ReviewStateStore(database);
    const failed = await stateStore.claimReview({
      deliveryId: 'delivery-callback-failed',
      job: {
        repositoryId: 11,
        pullRequestNumber: 42,
        installationId: 7,
        baseSha: eligibleEvent.baseSha,
        headSha: eligibleEvent.headSha,
        trigger: 'automatic',
      },
      occurredAt: '2026-09-01T00:00:00.000Z',
    });
    if (failed.kind !== 'claimed') throw new Error('failed test run was not claimed');
    await stateStore.recordRunnerJob({ runId: failed.runId, jobId: 'failed-job', attempt: 1 });
    await stateStore.markSchedulingFailed({
      runId: failed.runId,
      occurredAt: '2026-09-01T00:00:01.000Z',
    });
    const superseded = await stateStore.claimReview({
      deliveryId: 'delivery-callback-superseded-old',
      job: {
        repositoryId: 11,
        pullRequestNumber: 43,
        installationId: 7,
        baseSha: eligibleEvent.baseSha,
        headSha: eligibleEvent.headSha,
        trigger: 'automatic',
      },
      occurredAt: '2026-09-01T00:00:00.000Z',
    });
    if (superseded.kind !== 'claimed') throw new Error('superseded test run was not claimed');
    await stateStore.recordRunnerJob({
      runId: superseded.runId,
      jobId: 'superseded-job',
      attempt: 1,
    });
    const replacement = await stateStore.claimReview({
      deliveryId: 'delivery-callback-superseded-new',
      job: {
        repositoryId: 11,
        pullRequestNumber: 43,
        installationId: 7,
        baseSha: eligibleEvent.baseSha,
        headSha: '3333333333333333333333333333333333333333',
        trigger: 'automatic',
      },
      occurredAt: '2026-09-01T00:00:02.000Z',
    });
    if (replacement.kind !== 'claimed') throw new Error('replacement test run was not claimed');
    const stored: unknown[] = [];
    const published: unknown[] = [];
    const worker = createCoreWorker(
      {
        REVIEW_DB: database,
        GITHUB_APP_ID: '1234567',
        GITHUB_APP_PRIVATE_KEY: 'test-private-key',
        EVIDENCE_BUCKET: {
          put: async (...args) => {
            stored.push(args);
          },
        },
      },
      {
        stateStore,
        github: {
          loadReviewTarget: async () => ({ headSha: eligibleEvent.headSha }),
          createReview: async (input) => {
            published.push(input);
            return { kind: 'created', review: input };
          },
        },
      },
    );
    const callback = async (runId: string, id = 'runner-job-1') =>
      new Request('https://core.internal/runner-results', {
        method: 'POST',
        headers: {
          'x-compte-rendu-runner-callback': 'verified',
          'content-type': 'application/json',
        },
        body: await successfulCallback(runId, id),
      });
    try {
      expect((await worker.fetch(await callback('unknown-run'))).status).toBe(404);
      expect((await worker.fetch(await callback(failed.runId, 'failed-job'))).status).toBe(202);
      expect((await worker.fetch(await callback(superseded.runId, 'superseded-job'))).status).toBe(
        202,
      );
      expect(stored).toHaveLength(2);
      expect(published).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  it('publishes one concurrent duplicate success callback', async () => {
    const database = new SqliteD1Database();
    const stateStore = createD1ReviewStateStore(database);
    const claimed = await stateStore.claimReview({
      deliveryId: 'delivery-callback-concurrent',
      job: {
        repositoryId: 11,
        pullRequestNumber: 42,
        installationId: 7,
        baseSha: eligibleEvent.baseSha,
        headSha: eligibleEvent.headSha,
        trigger: 'automatic',
      },
      occurredAt: '2026-09-01T00:00:00.000Z',
    });
    if (claimed.kind !== 'claimed') throw new Error('concurrent run was not claimed');
    await stateStore.recordRunnerJob({ runId: claimed.runId, jobId: 'runner-job-1', attempt: 1 });
    const published: unknown[] = [];
    let releasePublication!: () => void;
    const publicationGate = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });
    let publicationStarted!: () => void;
    const publicationStartedPromise = new Promise<void>((resolve) => {
      publicationStarted = resolve;
    });
    const worker = createCoreWorker(
      {
        REVIEW_DB: database,
        GITHUB_APP_ID: '1234567',
        GITHUB_APP_PRIVATE_KEY: 'test-private-key',
        EVIDENCE_BUCKET: { put: async () => undefined },
      },
      {
        stateStore,
        github: {
          loadReviewTarget: async () => ({ headSha: eligibleEvent.headSha }),
          createReview: async (input) => {
            published.push(input);
            publicationStarted();
            await publicationGate;
            return { kind: 'created', review: input };
          },
        },
      },
    );
    const callbackBody = await successfulCallback(claimed.runId);
    const callbackRequest = () =>
      new Request('https://core.internal/runner-results', {
        method: 'POST',
        headers: {
          'x-compte-rendu-runner-callback': 'verified',
          'content-type': 'application/json',
        },
        body: callbackBody,
      });
    try {
      const first = worker.fetch(callbackRequest());
      await publicationStartedPromise;
      const second = worker.fetch(callbackRequest());
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(published).toHaveLength(1);
      releasePublication();
      await expect(Promise.all([first, second])).resolves.toHaveLength(2);
      await expect(stateStore.getRunOutcome(claimed.runId)).resolves.toMatchObject({
        status: 'completed',
      });
    } finally {
      database.close();
    }
  });

  it('marks a failed manual callback and gives feedback on the original comment', async () => {
    const database = new SqliteD1Database();
    const stateStore = createD1ReviewStateStore(database);
    const claimed = await stateStore.claimReview({
      deliveryId: 'delivery-callback-manual-failure',
      job: {
        repositoryId: 11,
        pullRequestNumber: 42,
        installationId: 7,
        baseSha: eligibleEvent.baseSha,
        headSha: eligibleEvent.headSha,
        trigger: 'manual',
        commentId: 987654,
      },
      occurredAt: '2026-09-01T00:00:00.000Z',
    });
    if (claimed.kind !== 'claimed') throw new Error('manual test run was not claimed');
    await stateStore.recordRunnerJob({ runId: claimed.runId, jobId: 'runner-job-1', attempt: 1 });
    const reactions: unknown[] = [];
    const worker = createCoreWorker(
      {
        REVIEW_DB: database,
        GITHUB_APP_ID: '1234567',
        GITHUB_APP_PRIVATE_KEY: 'test-private-key',
        EVIDENCE_BUCKET: { put: async () => undefined },
      },
      {
        stateStore,
        github: {
          addReaction: async (input) => {
            reactions.push(input);
          },
        },
      },
    );
    try {
      const response = await worker.fetch(
        new Request('https://core.internal/runner-results', {
          method: 'POST',
          headers: {
            'x-compte-rendu-runner-callback': 'verified',
            'content-type': 'application/json',
          },
          body: await failedCallback(claimed.runId),
        }),
      );
      expect(response.status).toBe(202);
      await expect(stateStore.getRunOutcome(claimed.runId)).resolves.toMatchObject({
        status: 'failed',
        commentId: 987654,
      });
      expect(reactions).toEqual([
        { repositoryId: 11, installationId: 7, commentId: 987654, content: '-1' },
      ]);
    } finally {
      database.close();
    }
  });

  it('fails a correlated successful callback with invalid evidence and gives manual feedback', async () => {
    const database = new SqliteD1Database();
    const stateStore = createD1ReviewStateStore(database);
    const claimed = await stateStore.claimReview({
      deliveryId: 'delivery-callback-invalid-evidence',
      job: {
        repositoryId: 11,
        pullRequestNumber: 42,
        installationId: 7,
        baseSha: eligibleEvent.baseSha,
        headSha: eligibleEvent.headSha,
        trigger: 'manual',
        commentId: 987654,
      },
      occurredAt: '2026-09-01T00:00:00.000Z',
    });
    if (claimed.kind !== 'claimed') throw new Error('invalid evidence run was not claimed');
    await stateStore.recordRunnerJob({ runId: claimed.runId, jobId: 'runner-job-1', attempt: 1 });
    const stored: unknown[] = [];
    const reactions: unknown[] = [];
    const worker = createCoreWorker(
      {
        REVIEW_DB: database,
        GITHUB_APP_ID: '1234567',
        GITHUB_APP_PRIVATE_KEY: 'test-private-key',
        EVIDENCE_BUCKET: { put: async (...args) => stored.push(args) },
      },
      {
        stateStore,
        github: {
          addReaction: async (input) => {
            reactions.push(input);
          },
        },
      },
    );
    try {
      const callback = JSON.parse(await successfulCallback(claimed.runId)) as {
        evidence: { manifest: { sha256: string } };
      };
      callback.evidence.manifest.sha256 = '0'.repeat(64);
      const response = await worker.fetch(
        new Request('https://core.internal/runner-results', {
          method: 'POST',
          headers: {
            'x-compte-rendu-runner-callback': 'verified',
            'content-type': 'application/json',
          },
          body: JSON.stringify(callback),
        }),
      );
      expect(response.status).toBe(202);
      await expect(stateStore.getRunOutcome(claimed.runId)).resolves.toMatchObject({
        status: 'failed',
      });
      expect(stored).toHaveLength(0);
      expect(reactions).toEqual([
        { repositoryId: 11, installationId: 7, commentId: 987654, content: '-1' },
      ]);
    } finally {
      database.close();
    }
  });

  it('keeps an eligible submission when core operational logging fails', async () => {
    const database = new SqliteD1Database();
    const runnerRequests: Request[] = [];
    const worker = createCoreWorker(
      coreEnv(database, async (request) => {
        runnerRequests.push(request.clone());
        return runnerResponse(request);
      }),
      {
        github: { getRepositoryUrl: async () => 'https://github.com/acme/reviewed.git' },
        log: {
          record: () => {
            throw new Error('log sink unavailable');
          },
        },
        getReadInstallationToken: async () => ({
          token: 'read-token',
          expiresAt: '2026-09-01T01:00:00.000Z',
        }),
      },
    );
    try {
      expect(
        await worker.fetch(
          new Request('https://core.internal/review-events', {
            method: 'POST',
            body: JSON.stringify(eligibleEvent),
          }),
        ),
      ).toMatchObject({ status: 202 });
      expect(runnerRequests).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it('redacts unsafe delivery identifiers in core operational logs', async () => {
    const database = new SqliteD1Database();
    const events: OperationalLogEvent[] = [];
    const worker = createCoreWorker(coreEnv(database), {
      github: { getRepositoryUrl: async () => 'https://github.com/acme/reviewed.git' },
      getReadInstallationToken: async () => ({
        token: 'read-token',
        expiresAt: '2026-09-01T01:00:00.000Z',
      }),
      log: {
        record: async (event) => {
          events.push(event);
        },
      },
    });
    try {
      expect(
        await worker.fetch(
          new Request('https://core.internal/review-events', {
            method: 'POST',
            body: JSON.stringify({ ...eligibleEvent, deliveryId: 'delivery\nunsafe' }),
          }),
        ),
      ).toMatchObject({ status: 202 });
      expect(events).toEqual([
        { phase: 'core', outcome: 'scheduled', deliveryId: 'redacted', runId: expect.any(String) },
      ]);
    } finally {
      database.close();
    }
  });

  it('accepts a manual review after production GitHub policy reads', async () => {
    const database = new SqliteD1Database();
    const reactions: unknown[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const inputUrl =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(inputUrl);
      if (url.pathname === '/repositories/11')
        return new Response(
          JSON.stringify({
            full_name: 'acme/reviewed',
            clone_url: 'https://github.com/acme/reviewed.git',
          }),
        );
      if (url.pathname === '/repos/acme/reviewed/pulls/42')
        return new Response(
          JSON.stringify({
            draft: false,
            base: { sha: eligibleEvent.baseSha, repo: { id: 11, visibility: 'public' } },
            head: { sha: eligibleEvent.headSha, repo: { id: 99 } },
          }),
        );
      if (url.pathname === '/repos/acme/reviewed/collaborators/alice/permission')
        return new Response(JSON.stringify({ permission: 'write' }));
      if (url.pathname.endsWith('/reactions')) {
        reactions.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}'));
        return new Response(JSON.stringify({ id: 1 }), { status: 201 });
      }
      return new Response('{}', { status: 404 });
    };
    const worker = createCoreWorker(coreEnv(database), {
      github: createGitHubPublicationAdapter({ token: 'installation-token', fetch: fetcher }),
      getReadInstallationToken: async () => ({
        token: 'read-token',
        expiresAt: '2026-09-01T01:00:00.000Z',
      }),
    });
    try {
      const response = await worker.fetch(
        new Request('https://core.internal/review-events', {
          method: 'POST',
          body: JSON.stringify({
            deliveryId: 'delivery-core-worker-manual',
            event: 'issue_comment',
            action: 'created',
            repositoryId: 11,
            pullRequestNumber: 42,
            installationId: 7,
            commentId: 987654,
            commenterLogin: 'alice',
            command: '/ai-review',
          }),
        }),
      );
      expect(response.status).toBe(202);
      expect(reactions).toEqual([{ content: 'eyes' }]);
    } finally {
      database.close();
    }
  });

  it('treats a production GitHub 404 for the manual PR as confirmed missing', async () => {
    const database = new SqliteD1Database();
    let submitted = false;
    const fetcher: typeof fetch = async (input) => {
      const inputUrl =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(inputUrl);
      if (url.pathname === '/repositories/11')
        return new Response(JSON.stringify({ full_name: 'acme/reviewed' }));
      if (url.pathname === '/repos/acme/reviewed/pulls/42')
        return new Response('{}', { status: 404 });
      if (url.pathname.endsWith('/reactions'))
        return new Response(JSON.stringify({ id: 1 }), { status: 201 });
      return new Response('{}', { status: 404 });
    };
    const worker = createCoreWorker(
      coreEnv(database, async (request) => {
        submitted = true;
        return runnerResponse(request);
      }),
      { github: createGitHubPublicationAdapter({ token: 'installation-token', fetch: fetcher }) },
    );
    try {
      expect(
        await worker.fetch(
          new Request('https://core.internal/review-events', {
            method: 'POST',
            body: JSON.stringify({
              deliveryId: 'delivery-core-worker-manual-missing',
              event: 'issue_comment',
              action: 'created',
              repositoryId: 11,
              pullRequestNumber: 42,
              installationId: 7,
              commentId: 987655,
              commenterLogin: 'alice',
              command: '/ai-review',
            }),
          }),
        ),
      ).toMatchObject({ status: 202 });
      expect(submitted).toBe(false);
    } finally {
      database.close();
    }
  });

  it('treats production collaborator permission none as confirmed denial', async () => {
    const database = new SqliteD1Database();
    let submitted = false;
    const fetcher: typeof fetch = async (input) => {
      const inputUrl =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(inputUrl);
      if (url.pathname === '/repositories/11')
        return new Response(JSON.stringify({ full_name: 'acme/reviewed' }));
      if (url.pathname === '/repos/acme/reviewed/pulls/42')
        return new Response(
          JSON.stringify({
            draft: false,
            base: { sha: eligibleEvent.baseSha, repo: { id: 11, visibility: 'public' } },
            head: { sha: eligibleEvent.headSha, repo: { id: 99 } },
          }),
        );
      if (url.pathname.endsWith('/permission'))
        return new Response(JSON.stringify({ permission: 'none' }));
      if (url.pathname.endsWith('/reactions'))
        return new Response(JSON.stringify({ id: 1 }), { status: 201 });
      return new Response('{}', { status: 404 });
    };
    const worker = createCoreWorker(
      coreEnv(database, async (request) => {
        submitted = true;
        return runnerResponse(request);
      }),
      { github: createGitHubPublicationAdapter({ token: 'installation-token', fetch: fetcher }) },
    );
    try {
      expect(
        await worker.fetch(
          new Request('https://core.internal/review-events', {
            method: 'POST',
            body: JSON.stringify({
              deliveryId: 'delivery-core-worker-permission-none',
              event: 'issue_comment',
              action: 'created',
              repositoryId: 11,
              pullRequestNumber: 42,
              installationId: 7,
              commentId: 987656,
              commenterLogin: 'alice',
              command: '/ai-review',
            }),
          }),
        ),
      ).toMatchObject({ status: 202 });
      expect(submitted).toBe(false);
    } finally {
      database.close();
    }
  });

  it('returns 503 when manual GitHub facts remain uncertain', async () => {
    const database = new SqliteD1Database();
    const events: OperationalLogEvent[] = [];
    const worker = createCoreWorker(coreEnv(database), {
      github: {
        getPullRequest: async () => {
          throw new Error('GitHub facts unavailable');
        },
      },
      log: {
        record: async (event) => {
          events.push(event);
        },
      },
    });
    try {
      expect(
        await worker.fetch(
          new Request('https://core.internal/review-events', {
            method: 'POST',
            body: JSON.stringify({
              deliveryId: 'delivery-core-worker-manual-uncertain',
              event: 'issue_comment',
              action: 'created',
              repositoryId: 11,
              pullRequestNumber: 42,
              installationId: 7,
              commentId: 987657,
              commenterLogin: 'alice',
              command: '/ai-review',
            }),
          }),
        ),
      ).toMatchObject({ status: 503 });
      expect(events).toEqual([
        {
          phase: 'core',
          outcome: 'retryable',
          deliveryId: 'delivery-core-worker-manual-uncertain',
          reason: 'pull_request_facts_uncertain',
        },
      ]);
    } finally {
      database.close();
    }
  });

  it('returns 503 when manual commenter permission remains uncertain', async () => {
    const database = new SqliteD1Database();
    const events: OperationalLogEvent[] = [];
    const worker = createCoreWorker(coreEnv(database), {
      github: {
        getPullRequest: async () => ({
          repositoryVisibility: 'public',
          baseRepositoryId: 11,
          headRepositoryId: 99,
          draft: false,
          baseSha: eligibleEvent.baseSha,
          headSha: eligibleEvent.headSha,
        }),
        getCommenterPermission: async () => {
          throw new Error('GitHub permission unavailable');
        },
      },
      log: {
        record: async (event) => {
          events.push(event);
        },
      },
    });
    try {
      expect(
        await worker.fetch(
          new Request('https://core.internal/review-events', {
            method: 'POST',
            body: JSON.stringify({
              deliveryId: 'delivery-core-worker-permission-uncertain',
              event: 'issue_comment',
              action: 'created',
              repositoryId: 11,
              pullRequestNumber: 42,
              installationId: 7,
              commentId: 987658,
              commenterLogin: 'alice',
              command: '/ai-review',
            }),
          }),
        ),
      ).toMatchObject({ status: 503 });
      expect(events).toEqual([
        {
          phase: 'core',
          outcome: 'retryable',
          deliveryId: 'delivery-core-worker-permission-uncertain',
          reason: 'commenter_permission_uncertain',
        },
      ]);
    } finally {
      database.close();
    }
  });

  it('keeps Runner admission failure fail-closed', async () => {
    const database = new SqliteD1Database();
    const events: OperationalLogEvent[] = [];
    const worker = createCoreWorker(
      coreEnv(database, async () => {
        throw new Error('runner admission failed');
      }),
      {
        github: { getRepositoryUrl: async () => 'https://github.com/acme/reviewed.git' },
        getReadInstallationToken: async () => ({
          token: 'read-token',
          expiresAt: '2026-09-01T01:00:00.000Z',
        }),
        log: {
          record: async (event) => {
            events.push(event);
          },
        },
      },
    );
    try {
      expect(
        await worker.fetch(
          new Request('https://core.internal/review-events', {
            method: 'POST',
            body: JSON.stringify({
              ...eligibleEvent,
              deliveryId: 'delivery-core-worker-schedule-failed',
            }),
          }),
        ),
      ).toMatchObject({ status: 503 });
      expect(events).toEqual([
        {
          phase: 'core',
          outcome: 'retryable',
          deliveryId: 'delivery-core-worker-schedule-failed',
          reason: 'scheduling_failure',
        },
      ]);
    } finally {
      database.close();
    }
  });

  it('returns 503 and records a retryable state failure when claiming fails', async () => {
    const database = new SqliteD1Database();
    const events: OperationalLogEvent[] = [];
    const baseStateStore = createInMemoryReviewStateStore();
    const stateStore = {
      ...baseStateStore,
      claimReview: async () => {
        throw new Error('state unavailable');
      },
    };
    const worker = createCoreWorker(coreEnv(database), {
      stateStore,
      log: {
        record: async (event) => {
          events.push(event);
        },
      },
    });
    try {
      expect(
        await worker.fetch(
          new Request('https://core.internal/review-events', {
            method: 'POST',
            body: JSON.stringify(eligibleEvent),
          }),
        ),
      ).toMatchObject({ status: 503 });
      expect(events).toEqual([
        {
          phase: 'core',
          outcome: 'retryable',
          deliveryId: eligibleEvent.deliveryId,
          reason: 'state_failure',
        },
      ]);
    } finally {
      database.close();
    }
  });
});
