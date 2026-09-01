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
    .then((input: { runId: string }) =>
      Response.json(
        {
          id: 'runner-job-1',
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

const successfulCallback = (runId: string, id = 'runner-job-1', attempt = 1) =>
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
      manifest: 'e30=',
      opencodeJsonl: 'e30=',
      opencodeStderr: '',
      validatedReview: 'IyMgUmV2aWV3OgoKTm8gZGVmZWN0cyBmb3VuZC4K',
      opencodeSessionList: 'W10=',
      opencodeExport: { sessionId: 'session-1', content: 'e30=' },
    },
    timestamps: {},
    result: '## Review:\n\nNo defects found.\n',
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
          manifest: 'e30=',
          opencodeJsonl: 'e30=',
          opencodeStderr: '',
          validatedReview: 'IyMgUmV2aWV3OgoKTm8gZGVmZWN0cyBmb3VuZC4K',
          opencodeSessionList: 'W10=',
          opencodeExport: { sessionId: 'session-1', content: 'e30=' },
        },
        timestamps: {
          executionStartedAt: '2026-09-01T00:00:01.000Z',
          submissionCompletedAt: '2026-09-01T00:00:02.000Z',
          cleanupCompletedAt: '2026-09-01T00:00:03.000Z',
        },
        result: '## Review:\n\nNo defects found.\n',
      });
      const divergentEvidenceResponse = await worker.fetch(
        new Request('https://core.internal/runner-results', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-compte-rendu-runner-callback': 'verified',
          },
          body: callbackBody.replace(
            'IyMgUmV2aWV3OgoKTm8gZGVmZWN0cyBmb3VuZC4K',
            'IyMgUmV2aWV3OgoKTm90IHRoZSBwdWJsaXNoZWQgcmV2aWV3Lgo=',
          ),
        }),
      );
      expect(divergentEvidenceResponse.status).toBe(409);
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
        manifest: 'e30=',
        opencodeJsonl: 'e30=',
        opencodeStderr: '',
        validatedReview: 'IyMgUmV2aWV3OgoKTm8gZGVmZWN0cyBmb3VuZC4K',
        opencodeSessionList: 'W10=',
        opencodeExport: { sessionId: 'session-1', content: 'e30=' },
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
    const callback = (runId: string, id = 'runner-job-1') =>
      new Request('https://core.internal/runner-results', {
        method: 'POST',
        headers: {
          'x-compte-rendu-runner-callback': 'verified',
          'content-type': 'application/json',
        },
        body: successfulCallback(runId, id),
      });
    try {
      expect((await worker.fetch(callback('unknown-run'))).status).toBe(404);
      expect((await worker.fetch(callback(failed.runId, 'failed-job'))).status).toBe(409);
      expect((await worker.fetch(callback(superseded.runId, 'superseded-job'))).status).toBe(409);
      expect(stored).toHaveLength(0);
      expect(published).toHaveLength(0);
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
          body: successfulCallback(claimed.runId).replace(
            '"status":"succeeded"',
            '"status":"failed"',
          ),
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
