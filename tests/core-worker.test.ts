import { describe, expect, it, vi } from 'vitest';
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

const deferred = <A>() => {
  let resolve!: (value: A | PromiseLike<A>) => void;
  const promise = new Promise<A>((next) => {
    resolve = next;
  });
  return { promise, resolve };
};

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

const abortedCallback = async (
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

describe('Core Worker', () => {
  it('keeps an existing scheduled run claimable after Check migration', async () => {
    const database = new SqliteD1Database([
      '0001_review_state.sql',
      '0002_allow_manual_retry.sql',
      '0003_runner_evidence.sql',
      '0004_runner_admission.sql',
      '0005_publication_claim.sql',
    ]);
    const legacyRunId = 'legacy-run-before-check-migration';
    database.database.exec(`
      INSERT INTO deliveries (
        delivery_id, installation_id, repository_id, pull_request_number,
        base_sha, head_sha, trigger, status, created_at, updated_at
      ) VALUES (
        'delivery-before-check-migration', 7, 11, 42,
        '1111111111111111111111111111111111111111',
        '2222222222222222222222222222222222222222',
        'automatic', 'scheduled', '2026-09-01T00:00:00.000Z',
        '2026-09-01T00:00:00.000Z'
      );
      INSERT INTO review_runs (
        run_id, delivery_id, installation_id, repository_id,
        pull_request_number, base_sha, head_sha, trigger,
        status, created_at, updated_at
      ) VALUES (
        '${legacyRunId}', 'delivery-before-check-migration', 7, 11, 42,
        '1111111111111111111111111111111111111111',
        '2222222222222222222222222222222222222222',
        'automatic', 'scheduled', '2026-09-01T00:00:00.000Z',
        '2026-09-01T00:00:00.000Z'
      );
    `);

    try {
      database.applyMigrations(['0006_review_check_runs.sql']);
      const migratedStore = createD1ReviewStateStore(database);
      if (migratedStore.claimNextJob === undefined) throw new Error('claim route is unavailable');
      await expect(
        migratedStore.claimNextJob!({
          jobId: 'legacy-runner-job',
          attempt: 1,
          occurredAt: '2026-09-01T00:00:01.000Z',
        }),
      ).resolves.toMatchObject({ kind: 'claimed', runId: legacyRunId });
    } finally {
      database.close();
    }
  });

  it('acknowledges and admits a durable Job while Check setup remains pending', async () => {
    const database = new SqliteD1Database();
    const backgroundTasks: Promise<unknown>[] = [];
    const checkUpdates: unknown[] = [];
    const checkStarted = deferred<void>();
    const check = deferred<{ id: number }>();
    const worker = createCoreWorker(coreEnv(database), {
      github: {
        createCheckRun: async () => {
          checkStarted.resolve();
          return check.promise;
        },
        updateCheckRun: async (input) => {
          checkUpdates.push(input);
        },
        getRepositoryUrl: async () => 'https://github.com/acme/reviewed.git',
      },
      getReadInstallationToken: async () => ({
        token: 'repository-read-token',
        expiresAt: '2026-09-01T01:00:00.000Z',
      }),
    });
    const scheduling = worker.fetch(
      new Request('https://core.internal/review-events', {
        method: 'POST',
        body: JSON.stringify({ ...eligibleEvent, deliveryId: 'delivery-check-gates-claim' }),
      }),
      undefined,
      { waitUntil: (task) => backgroundTasks.push(task) },
    );
    const claimRequest = () =>
      new Request('https://core.internal/runner-claims', {
        method: 'POST',
        headers: { 'x-compte-rendu-runner-claim': 'verified' },
      });

    try {
      await checkStarted.promise;
      expect((await scheduling).status).toBe(202);
      const claim = await worker.fetch(claimRequest());
      expect(claim.status).toBe(200);
      expect(await claim.json()).toMatchObject({
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        runId: expect.any(String),
        attempt: 1,
        repositoryUrl: 'https://github.com/acme/reviewed.git',
        repositoryName: 'acme/reviewed',
        pullRequestNumber: eligibleEvent.pullRequestNumber,
        baseSha: eligibleEvent.baseSha,
        headSha: eligibleEvent.headSha,
        repositoryReadToken: 'repository-read-token',
      });
      check.resolve({ id: 321 });
      await Promise.all(backgroundTasks);
      expect(checkUpdates).toEqual([
        {
          repositoryId: eligibleEvent.repositoryId,
          installationId: eligibleEvent.installationId,
          checkRunId: 321,
          status: 'in_progress',
        },
      ]);
    } finally {
      database.close();
    }
  });

  it('completes a Check that is created after its Review was published', async () => {
    const database = new SqliteD1Database();
    const backgroundTasks: Promise<unknown>[] = [];
    const checkUpdates: unknown[] = [];
    const check = deferred<{ id: number }>();
    const worker = createCoreWorker(
      {
        ...coreEnv(database),
        EVIDENCE_BUCKET: { put: async () => undefined },
      },
      {
        github: {
          createCheckRun: async () => check.promise,
          updateCheckRun: async (input) => {
            checkUpdates.push(input);
          },
          getRepositoryUrl: async () => 'https://github.com/acme/reviewed.git',
          loadReviewTarget: async () => ({ headSha: eligibleEvent.headSha }),
          createReview: async ({ payload }) => ({ kind: 'created', review: payload }),
        },
        getReadInstallationToken: async () => ({
          token: 'repository-read-token',
          expiresAt: '2026-09-01T01:00:00.000Z',
        }),
      },
    );

    try {
      expect(
        (
          await worker.fetch(
            new Request('https://core.internal/review-events', {
              method: 'POST',
              body: JSON.stringify({
                ...eligibleEvent,
                deliveryId: 'delivery-check-after-completion',
              }),
            }),
            undefined,
            { waitUntil: (task) => backgroundTasks.push(task) },
          )
        ).status,
      ).toBe(202);
      const claim = await worker.fetch(
        new Request('https://core.internal/runner-claims', {
          method: 'POST',
          headers: { 'x-compte-rendu-runner-claim': 'verified' },
        }),
      );
      expect(claim.status).toBe(200);
      const claimed = (await claim.json()) as { id: string; runId: string };
      expect(
        (
          await worker.fetch(
            new Request('https://core.internal/runner-results', {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'x-compte-rendu-runner-callback': 'verified',
              },
              body: await successfulCallback(claimed.runId, claimed.id),
            }),
          )
        ).status,
      ).toBe(202);

      check.resolve({ id: 322 });
      await Promise.all(backgroundTasks);
      expect(checkUpdates).toEqual([
        {
          repositoryId: eligibleEvent.repositoryId,
          installationId: eligibleEvent.installationId,
          checkRunId: 322,
          status: 'success',
        },
      ]);
    } finally {
      database.close();
    }
  });

  it('does not let a late in-progress Check update overwrite Review completion', async () => {
    const database = new SqliteD1Database();
    const backgroundTasks: Promise<unknown>[] = [];
    const check = deferred<{ id: number }>();
    const inProgressStarted = deferred<void>();
    const releaseInProgress = deferred<void>();
    const checkStatuses: string[] = [];
    const worker = createCoreWorker(
      {
        ...coreEnv(database),
        EVIDENCE_BUCKET: { put: async () => undefined },
      },
      {
        github: {
          createCheckRun: async () => check.promise,
          updateCheckRun: async ({ status }) => {
            if (status === 'in_progress' && !checkStatuses.includes('in_progress')) {
              inProgressStarted.resolve();
              await releaseInProgress.promise;
            }
            checkStatuses.push(status);
          },
          getRepositoryUrl: async () => 'https://github.com/acme/reviewed.git',
          loadReviewTarget: async () => ({ headSha: eligibleEvent.headSha }),
          createReview: async ({ payload }) => ({ kind: 'created', review: payload }),
        },
        getReadInstallationToken: async () => ({
          token: 'repository-read-token',
          expiresAt: '2026-09-01T01:00:00.000Z',
        }),
      },
    );

    try {
      expect(
        (
          await worker.fetch(
            new Request('https://core.internal/review-events', {
              method: 'POST',
              body: JSON.stringify({
                ...eligibleEvent,
                deliveryId: 'delivery-check-in-progress-race',
              }),
            }),
            undefined,
            { waitUntil: (task) => backgroundTasks.push(task) },
          )
        ).status,
      ).toBe(202);
      const claim = await worker.fetch(
        new Request('https://core.internal/runner-claims', {
          method: 'POST',
          headers: { 'x-compte-rendu-runner-claim': 'verified' },
        }),
      );
      expect(claim.status).toBe(200);
      const claimed = (await claim.json()) as { id: string; runId: string };
      check.resolve({ id: 321 });
      await inProgressStarted.promise;

      expect(
        (
          await worker.fetch(
            new Request('https://core.internal/runner-results', {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'x-compte-rendu-runner-callback': 'verified',
              },
              body: await successfulCallback(claimed.runId, claimed.id),
            }),
          )
        ).status,
      ).toBe(202);
      releaseInProgress.resolve();
      await Promise.all(backgroundTasks);

      expect(checkStatuses.at(-1)).toBe('success');
    } finally {
      releaseInProgress.resolve();
      await Promise.all(backgroundTasks);
      database.close();
    }
  });

  it('fails a Check that is created after its Review failed', async () => {
    const database = new SqliteD1Database();
    const backgroundTasks: Promise<unknown>[] = [];
    const checkUpdates: unknown[] = [];
    const check = deferred<{ id: number }>();
    const worker = createCoreWorker(
      {
        ...coreEnv(database),
        EVIDENCE_BUCKET: { put: async () => undefined },
      },
      {
        github: {
          createCheckRun: async () => check.promise,
          updateCheckRun: async (input) => {
            checkUpdates.push(input);
          },
          createIssueComment: async (input) => ({ id: 123, body: input.body }),
          getRepositoryUrl: async () => 'https://github.com/acme/reviewed.git',
        },
        getReadInstallationToken: async () => ({
          token: 'repository-read-token',
          expiresAt: '2026-09-01T01:00:00.000Z',
        }),
      },
    );

    try {
      expect(
        (
          await worker.fetch(
            new Request('https://core.internal/review-events', {
              method: 'POST',
              body: JSON.stringify({
                ...eligibleEvent,
                deliveryId: 'delivery-check-after-failure',
              }),
            }),
            undefined,
            { waitUntil: (task) => backgroundTasks.push(task) },
          )
        ).status,
      ).toBe(202);
      const claim = await worker.fetch(
        new Request('https://core.internal/runner-claims', {
          method: 'POST',
          headers: { 'x-compte-rendu-runner-claim': 'verified' },
        }),
      );
      const claimed = (await claim.json()) as { id: string; runId: string };
      expect(
        (
          await worker.fetch(
            new Request('https://core.internal/runner-results', {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'x-compte-rendu-runner-callback': 'verified',
              },
              body: await failedCallback(claimed.runId, claimed.id),
            }),
          )
        ).status,
      ).toBe(202);

      check.resolve({ id: 323 });
      await Promise.all(backgroundTasks);
      expect(checkUpdates).toEqual([
        {
          repositoryId: eligibleEvent.repositoryId,
          installationId: eligibleEvent.installationId,
          checkRunId: 323,
          status: 'failure',
        },
      ]);
    } finally {
      database.close();
    }
  });

  it('cancels a Check that is created after its queued Review was superseded', async () => {
    const database = new SqliteD1Database();
    const backgroundTasks: Promise<unknown>[] = [];
    const checkUpdates: unknown[] = [];
    const oldCheck = deferred<{ id: number }>();
    const worker = createCoreWorker(coreEnv(database), {
      github: {
        createCheckRun: async ({ headSha }) =>
          headSha === eligibleEvent.headSha ? oldCheck.promise : { id: 325 },
        updateCheckRun: async (input) => {
          checkUpdates.push(input);
        },
      },
    });

    try {
      expect(
        (
          await worker.fetch(
            new Request('https://core.internal/review-events', {
              method: 'POST',
              body: JSON.stringify({
                ...eligibleEvent,
                deliveryId: 'delivery-late-check-superseded-old',
              }),
            }),
            undefined,
            { waitUntil: (task) => backgroundTasks.push(task) },
          )
        ).status,
      ).toBe(202);
      expect(
        (
          await worker.fetch(
            new Request('https://core.internal/review-events', {
              method: 'POST',
              body: JSON.stringify({
                ...eligibleEvent,
                deliveryId: 'delivery-late-check-superseded-new',
                action: 'synchronize',
                headSha: '3333333333333333333333333333333333333333',
              }),
            }),
          )
        ).status,
      ).toBe(202);

      oldCheck.resolve({ id: 324 });
      await Promise.all(backgroundTasks);
      expect(checkUpdates).toEqual([
        {
          repositoryId: eligibleEvent.repositoryId,
          installationId: eligibleEvent.installationId,
          checkRunId: 324,
          status: 'cancelled',
        },
      ]);
    } finally {
      database.close();
    }
  });

  it('unblocks a run when Check setup fails at the GitHub API', async () => {
    const database = new SqliteD1Database();
    const worker = createCoreWorker(coreEnv(database), {
      github: {
        createCheckRun: async () => {
          throw new Error('Checks API unavailable');
        },
        getRepositoryUrl: async () => 'https://github.com/acme/reviewed.git',
      },
      getReadInstallationToken: async () => ({
        token: 'repository-read-token',
        expiresAt: '2026-09-01T01:00:00.000Z',
      }),
    });

    try {
      expect(
        (
          await worker.fetch(
            new Request('https://core.internal/review-events', {
              method: 'POST',
              body: JSON.stringify({ ...eligibleEvent, deliveryId: 'delivery-check-fails' }),
            }),
          )
        ).status,
      ).toBe(202);
      const claim = await worker.fetch(
        new Request('https://core.internal/runner-claims', {
          method: 'POST',
          headers: { 'x-compte-rendu-runner-claim': 'verified' },
        }),
      );
      expect(claim.status).toBe(200);
      expect(await claim.json()).toMatchObject({ headSha: eligibleEvent.headSha });
    } finally {
      database.close();
    }
  });

  it('creates one queued Check for a durably scheduled run', async () => {
    const database = new SqliteD1Database();
    const checks: unknown[] = [];
    const worker = createCoreWorker(coreEnv(database), {
      github: {
        createCheckRun: async (input) => {
          checks.push(input);
          return { id: 321 };
        },
      },
    });
    const request = () =>
      new Request('https://core.internal/review-events', {
        method: 'POST',
        body: JSON.stringify({ ...eligibleEvent, deliveryId: 'delivery-check-queued' }),
      });

    try {
      expect((await worker.fetch(request())).status).toBe(202);
      expect((await worker.fetch(request())).status).toBe(202);
      expect(checks).toEqual([
        {
          repositoryId: 11,
          installationId: 7,
          headSha: eligibleEvent.headSha,
          runId: expect.any(String),
        },
      ]);
    } finally {
      database.close();
    }
  });

  it('recovers an interrupted Check after the Review completes without racing an active replay', async () => {
    const database = new SqliteD1Database();
    const backgroundTasks: Promise<unknown>[] = [];
    const firstCheckCreated = deferred<void>();
    const releaseFirstResponse = deferred<{ id: number }>();
    const remoteChecks: Array<{ id: number; external_id: string }> = [];
    const checkRequests: unknown[] = [];
    const checkUpdates: unknown[] = [];
    const worker = createCoreWorker(
      {
        ...coreEnv(database),
        EVIDENCE_BUCKET: { put: async () => undefined },
      },
      {
        github: {
          createCheckRun: async (input) => {
            checkRequests.push(input);
            const existing = remoteChecks.find((check) => check.external_id === input.runId);
            if (existing !== undefined) return existing;
            remoteChecks.push({ id: 321, external_id: input.runId });
            firstCheckCreated.resolve();
            return releaseFirstResponse.promise;
          },
          updateCheckRun: async (input) => {
            checkUpdates.push(input);
          },
          getRepositoryUrl: async () => 'https://github.com/acme/reviewed.git',
          loadReviewTarget: async () => ({ headSha: eligibleEvent.headSha }),
          createReview: async ({ payload }) => ({ kind: 'created', review: payload }),
        },
        getReadInstallationToken: async () => ({
          token: 'repository-read-token',
          expiresAt: '2026-09-01T01:00:00.000Z',
        }),
      },
    );
    const request = () =>
      new Request('https://core.internal/review-events', {
        method: 'POST',
        body: JSON.stringify({
          ...eligibleEvent,
          deliveryId: 'delivery-check-interrupted-after-create',
        }),
      });
    const context = { waitUntil: (task: Promise<unknown>) => backgroundTasks.push(task) };

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-04T00:00:00.000Z'));
    try {
      expect((await worker.fetch(request(), undefined, context)).status).toBe(202);
      await firstCheckCreated.promise;
      expect((await worker.fetch(request(), undefined, context)).status).toBe(202);
      expect(checkRequests).toHaveLength(1);

      const claim = await worker.fetch(
        new Request('https://core.internal/runner-claims', {
          method: 'POST',
          headers: { 'x-compte-rendu-runner-claim': 'verified' },
        }),
      );
      expect(claim.status).toBe(200);
      const claimed = (await claim.json()) as { id: string; runId: string };
      expect(
        (
          await worker.fetch(
            new Request('https://core.internal/runner-results', {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'x-compte-rendu-runner-callback': 'verified',
              },
              body: await successfulCallback(claimed.runId, claimed.id),
            }),
          )
        ).status,
      ).toBe(202);

      vi.setSystemTime(new Date('2026-09-04T00:02:00.000Z'));
      expect((await worker.fetch(request())).status).toBe(202);
      expect(remoteChecks).toHaveLength(1);
      expect(checkRequests).toHaveLength(2);
      expect(checkUpdates).toEqual([
        {
          repositoryId: eligibleEvent.repositoryId,
          installationId: eligibleEvent.installationId,
          checkRunId: 321,
          status: 'success',
        },
      ]);
    } finally {
      releaseFirstResponse.resolve({ id: 321 });
      await Promise.all(backgroundTasks);
      vi.useRealTimers();
      database.close();
    }
  });

  it('marks the persisted Check in progress when the Runner claims its Job', async () => {
    const database = new SqliteD1Database();
    const updates: unknown[] = [];
    const worker = createCoreWorker(coreEnv(database), {
      github: {
        createCheckRun: async () => ({ id: 321 }),
        updateCheckRun: async (input) => {
          updates.push(input);
        },
        getRepositoryUrl: async () => 'https://github.com/acme/reviewed.git',
      },
      getReadInstallationToken: async () => ({
        token: 'repository-read-token',
        expiresAt: '2026-09-01T01:00:00.000Z',
      }),
    });

    try {
      expect(
        (
          await worker.fetch(
            new Request('https://core.internal/review-events', {
              method: 'POST',
              body: JSON.stringify({ ...eligibleEvent, deliveryId: 'delivery-check-claimed' }),
            }),
          )
        ).status,
      ).toBe(202);
      expect(
        (
          await worker.fetch(
            new Request('https://core.internal/runner-claims', {
              method: 'POST',
              headers: { 'x-compte-rendu-runner-claim': 'verified' },
            }),
          )
        ).status,
      ).toBe(200);
      expect(updates).toEqual([
        {
          repositoryId: 11,
          installationId: 7,
          checkRunId: 321,
          status: 'in_progress',
        },
      ]);
    } finally {
      database.close();
    }
  });

  it('publishes a terminal failure when Runner claim preparation fails', async () => {
    const database = new SqliteD1Database();
    const comments: string[] = [];
    const checks: string[] = [];
    const worker = createCoreWorker(coreEnv(database), {
      github: {
        createCheckRun: async () => ({ id: 321 }),
        updateCheckRun: async ({ status }) => {
          checks.push(status);
        },
        createIssueComment: async ({ body }) => {
          comments.push(body);
          return { id: 123, body };
        },
        getRepositoryUrl: async () => {
          throw new Error('GitHub repository lookup failed');
        },
      },
    });

    try {
      expect(
        (
          await worker.fetch(
            new Request('https://core.internal/review-events', {
              method: 'POST',
              body: JSON.stringify({ ...eligibleEvent, deliveryId: 'delivery-claim-failure' }),
            }),
          )
        ).status,
      ).toBe(202);
      const claim = await worker.fetch(
        new Request('https://core.internal/runner-claims', {
          method: 'POST',
          headers: { 'x-compte-rendu-runner-claim': 'verified' },
        }),
      );

      expect(claim.status).toBe(503);
      expect(comments).toEqual([expect.stringContaining('Review failed')]);
      expect(checks).toEqual(['failure']);
    } finally {
      database.close();
    }
  });

  it('durably schedules an eligible webhook without admitting a Job or minting a read token', async () => {
    const database = new SqliteD1Database();
    let runnerAdmissions = 0;
    let tokenMints = 0;
    const worker = createCoreWorker(
      {
        REVIEW_DB: database,
        RUNNER: {
          fetch: async () => {
            runnerAdmissions += 1;
            return new Response(null, { status: 202 });
          },
        },
        RUNNER_AUTH_TOKEN: 'runner-auth-token',
        GITHUB_APP_ID: '1234567',
        GITHUB_APP_PRIVATE_KEY: 'test-private-key',
      },
      {
        github: { getRepositoryUrl: async () => 'https://github.com/acme/reviewed.git' },
        getReadInstallationToken: async () => {
          tokenMints += 1;
          return { token: 'repository-read-token', expiresAt: '2026-09-01T01:00:00.000Z' };
        },
      },
    );

    try {
      const response = await worker.fetch(
        new Request('https://core.internal/review-events', {
          method: 'POST',
          body: JSON.stringify({ ...eligibleEvent, deliveryId: 'delivery-queued-only' }),
        }),
      );

      expect(response.status).toBe(202);
      expect(runnerAdmissions).toBe(0);
      expect(tokenMints).toBe(0);
    } finally {
      database.close();
    }
  });

  it('claims the oldest queued run and mints its read token only at claim time', async () => {
    const database = new SqliteD1Database();
    let tokenMints = 0;
    const worker = createCoreWorker(
      {
        REVIEW_DB: database,
        GITHUB_APP_ID: '1234567',
        GITHUB_APP_PRIVATE_KEY: 'test-private-key',
      },
      {
        github: { getRepositoryUrl: async () => 'https://github.com/acme/reviewed.git' },
        getReadInstallationToken: async () => {
          tokenMints += 1;
          return { token: 'repository-read-token', expiresAt: '2026-09-01T01:00:00.000Z' };
        },
      },
    );

    try {
      const scheduled = await worker.fetch(
        new Request('https://core.internal/review-events', {
          method: 'POST',
          body: JSON.stringify({ ...eligibleEvent, deliveryId: 'delivery-claimable' }),
        }),
      );
      expect(scheduled.status).toBe(202);
      expect(tokenMints).toBe(0);

      const claim = await worker.fetch(
        new Request('https://core.internal/runner-claims', {
          method: 'POST',
          headers: { 'x-compte-rendu-runner-claim': 'verified' },
        }),
      );

      expect(claim.status).toBe(200);
      expect(await claim.json()).toMatchObject({
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        runId: expect.any(String),
        attempt: 1,
        repositoryUrl: 'https://github.com/acme/reviewed.git',
        repositoryName: 'acme/reviewed',
        pullRequestNumber: 42,
        baseSha: eligibleEvent.baseSha,
        headSha: eligibleEvent.headSha,
        repositoryReadToken: 'repository-read-token',
      });
      expect(tokenMints).toBe(1);
    } finally {
      database.close();
    }
  });

  it('allows a fresh claim to take later queued work after an earlier claim remains recorded', async () => {
    const database = new SqliteD1Database();
    const worker = createCoreWorker(
      { REVIEW_DB: database, GITHUB_APP_ID: '1234567', GITHUB_APP_PRIVATE_KEY: 'test-private-key' },
      {
        github: { getRepositoryUrl: async () => 'https://github.com/acme/reviewed.git' },
        getReadInstallationToken: async () => ({
          token: 'repository-read-token',
          expiresAt: '2026-09-01T01:00:00.000Z',
        }),
      },
    );

    try {
      for (const event of [
        { ...eligibleEvent, deliveryId: 'delivery-restart-old' },
        {
          ...eligibleEvent,
          deliveryId: 'delivery-restart-new',
          pullRequestNumber: 43,
        },
      ]) {
        expect(
          (
            await worker.fetch(
              new Request('https://core.internal/review-events', {
                method: 'POST',
                body: JSON.stringify(event),
              }),
            )
          ).status,
        ).toBe(202);
      }

      const firstClaim = await worker.fetch(
        new Request('https://core.internal/runner-claims', {
          method: 'POST',
          headers: { 'x-compte-rendu-runner-claim': 'verified' },
        }),
      );
      expect(firstClaim.status).toBe(200);
      expect(await firstClaim.json()).toMatchObject({ runId: expect.any(String) });

      const restartedClaim = await worker.fetch(
        new Request('https://core.internal/runner-claims', {
          method: 'POST',
          headers: { 'x-compte-rendu-runner-claim': 'verified' },
        }),
      );
      expect(restartedClaim.status).toBe(200);
      expect(await restartedClaim.json()).toMatchObject({
        pullRequestNumber: 43,
        headSha: eligibleEvent.headSha,
      });
    } finally {
      database.close();
    }
  });

  it('does not return the same queued run to concurrent claims', async () => {
    const database = new SqliteD1Database();
    const worker = createCoreWorker(
      { REVIEW_DB: database, GITHUB_APP_ID: '1234567', GITHUB_APP_PRIVATE_KEY: 'test-private-key' },
      {
        github: { getRepositoryUrl: async () => 'https://github.com/acme/reviewed.git' },
        getReadInstallationToken: async () => ({
          token: 'repository-read-token',
          expiresAt: '2026-09-01T01:00:00.000Z',
        }),
      },
    );

    try {
      for (const deliveryId of ['delivery-concurrent-1', 'delivery-concurrent-2']) {
        const response = await worker.fetch(
          new Request('https://core.internal/review-events', {
            method: 'POST',
            body: JSON.stringify({ ...eligibleEvent, deliveryId }),
          }),
        );
        expect(response.status).toBe(202);
      }

      const claims = await Promise.all(
        [1, 2].map(() =>
          Promise.resolve(
            worker.fetch(
              new Request('https://core.internal/runner-claims', {
                method: 'POST',
                headers: { 'x-compte-rendu-runner-claim': 'verified' },
              }),
            ),
          ),
        ),
      );

      expect(claims.map((response) => response.status).sort((left, right) => left - right)).toEqual(
        [200, 204],
      );
      const claimed = claims.find((response) => response.status === 200);
      expect(claimed).toBeDefined();
      expect(await claimed!.json()).toMatchObject({
        headSha: eligibleEvent.headSha,
        attempt: 1,
      });
    } finally {
      database.close();
    }
  });

  it('aborts a running old head before allowing the newer head to claim', async () => {
    const database = new SqliteD1Database();
    const runnerRequests: Request[] = [];
    const checkUpdates: unknown[] = [];
    let nextCheckRunId = 321;
    let oldRunId = '';
    let worker!: ReturnType<typeof createCoreWorker>;
    worker = createCoreWorker(
      {
        REVIEW_DB: database,
        EVIDENCE_BUCKET: { put: async () => undefined },
        RUNNER: {
          fetch: async (request) => {
            runnerRequests.push(request.clone());
            if (request.method === 'DELETE') {
              const jobId = new URL(request.url).pathname.split('/').pop();
              await worker.fetch(
                new Request('https://core.internal/runner-results', {
                  method: 'POST',
                  headers: {
                    'content-type': 'application/json',
                    'x-compte-rendu-runner-callback': 'verified',
                  },
                  body: await abortedCallback(oldRunId, jobId!),
                }),
              );
              return Response.json(
                {
                  id: jobId,
                  runId: oldRunId,
                  attempt: 1,
                  evidence: { id: 'evidence-old', status: 'pending' },
                  status: 'aborted',
                  stage: 'cleanup',
                  sandbox: { cleanup: 'destroyed' },
                },
                { status: 200 },
              );
            }
            return new Response(null, { status: 404 });
          },
        },
        RUNNER_AUTH_TOKEN: 'runner-auth-token',
        GITHUB_APP_ID: '1234567',
        GITHUB_APP_PRIVATE_KEY: 'test-private-key',
      },
      {
        github: {
          getRepositoryUrl: async () => 'https://github.com/acme/reviewed.git',
          createCheckRun: async () => ({ id: nextCheckRunId++ }),
          updateCheckRun: async (input) => {
            checkUpdates.push(input);
          },
        },
        getReadInstallationToken: async () => ({
          token: 'repository-read-token',
          expiresAt: '2026-09-01T01:00:00.000Z',
        }),
      },
    );

    try {
      const oldEvent = { ...eligibleEvent, deliveryId: 'delivery-old-running' };
      const newEvent = {
        ...eligibleEvent,
        deliveryId: 'delivery-new-queued',
        headSha: '3333333333333333333333333333333333333333',
      };
      expect(
        (
          await worker.fetch(
            new Request('https://core.internal/review-events', {
              method: 'POST',
              body: JSON.stringify(oldEvent),
            }),
          )
        ).status,
      ).toBe(202);
      const oldClaim = await worker.fetch(
        new Request('https://core.internal/runner-claims', {
          method: 'POST',
          headers: { 'x-compte-rendu-runner-claim': 'verified' },
        }),
      );
      const oldJob = (await oldClaim.json()) as { id: string; runId: string };
      oldRunId = oldJob.runId;

      expect(
        (
          await worker.fetch(
            new Request('https://core.internal/review-events', {
              method: 'POST',
              body: JSON.stringify(newEvent),
            }),
          )
        ).status,
      ).toBe(202);
      expect(runnerRequests).toHaveLength(1);
      expect(runnerRequests[0]?.method).toBe('DELETE');
      expect(runnerRequests[0]?.url).toBe(`http://runner.internal/jobs/${oldJob.id}`);
      expect((await createD1ReviewStateStore(database).getRunOutcome(oldRunId))?.status).toBe(
        'superseded',
      );
      expect(checkUpdates).toContainEqual({
        repositoryId: 11,
        installationId: 7,
        checkRunId: 321,
        status: 'cancelled',
      });

      const newClaim = await worker.fetch(
        new Request('https://core.internal/runner-claims', {
          method: 'POST',
          headers: { 'x-compte-rendu-runner-claim': 'verified' },
        }),
      );
      expect(newClaim.status).toBe(200);
      expect(await newClaim.json()).toMatchObject({ headSha: newEvent.headSha, attempt: 1 });
    } finally {
      database.close();
    }
  });

  it('cancels the queued Check when a newer head supersedes it before claim', async () => {
    const database = new SqliteD1Database();
    const updates: unknown[] = [];
    let nextCheckRunId = 321;
    const worker = createCoreWorker(coreEnv(database), {
      github: {
        createCheckRun: async () => ({ id: nextCheckRunId++ }),
        updateCheckRun: async (input) => {
          updates.push(input);
        },
      },
    });

    try {
      for (const event of [
        { ...eligibleEvent, deliveryId: 'delivery-queued-old-head' },
        {
          ...eligibleEvent,
          deliveryId: 'delivery-queued-new-head',
          action: 'synchronize' as const,
          headSha: '3333333333333333333333333333333333333333',
        },
      ]) {
        expect(
          (
            await worker.fetch(
              new Request('https://core.internal/review-events', {
                method: 'POST',
                body: JSON.stringify(event),
              }),
            )
          ).status,
        ).toBe(202);
      }
      expect(updates).toEqual([
        {
          repositoryId: 11,
          installationId: 7,
          checkRunId: 321,
          status: 'cancelled',
        },
      ]);
    } finally {
      database.close();
    }
  });

  it('creates the replacement Check when old-head cancellation fails', async () => {
    const database = new SqliteD1Database();
    const checks: Array<{ headSha: string }> = [];
    const worker = createCoreWorker(
      {
        ...coreEnv(database),
        EVIDENCE_BUCKET: { put: async () => undefined },
        RUNNER: {
          fetch: async (request) => {
            if (request.method === 'DELETE') return new Response(null, { status: 503 });
            return runnerResponse(request);
          },
        },
      },
      {
        github: {
          getRepositoryUrl: async () => 'https://github.com/acme/reviewed.git',
          createCheckRun: async ({ headSha }) => {
            checks.push({ headSha });
            return { id: 321 + checks.length - 1 };
          },
        },
        getReadInstallationToken: async () => ({
          token: 'repository-read-token',
          expiresAt: '2026-09-01T01:00:00.000Z',
        }),
      },
    );

    try {
      expect(
        (
          await worker.fetch(
            new Request('https://core.internal/review-events', {
              method: 'POST',
              body: JSON.stringify({ ...eligibleEvent, deliveryId: 'delivery-cancel-fails-old' }),
            }),
          )
        ).status,
      ).toBe(202);
      const oldClaim = await worker.fetch(
        new Request('https://core.internal/runner-claims', {
          method: 'POST',
          headers: { 'x-compte-rendu-runner-claim': 'verified' },
        }),
      );
      expect(oldClaim.status).toBe(200);
      const oldJob = (await oldClaim.json()) as { id: string; runId: string };
      const newEvent = {
        ...eligibleEvent,
        deliveryId: 'delivery-cancel-fails-new',
        headSha: '3333333333333333333333333333333333333333',
      };
      expect(
        (
          await worker.fetch(
            new Request('https://core.internal/review-events', {
              method: 'POST',
              body: JSON.stringify(newEvent),
            }),
          )
        ).status,
      ).toBe(202);
      expect(checks.map(({ headSha }) => headSha)).toEqual([
        eligibleEvent.headSha,
        newEvent.headSha,
      ]);
      const replacementClaim = await worker.fetch(
        new Request('https://core.internal/runner-claims', {
          method: 'POST',
          headers: { 'x-compte-rendu-runner-claim': 'verified' },
        }),
      );
      expect(replacementClaim.status).toBe(204);
      expect(
        (
          await worker.fetch(
            new Request('https://core.internal/runner-results', {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'x-compte-rendu-runner-callback': 'verified',
              },
              body: await abortedCallback(oldJob.runId, oldJob.id, 1, 'failed'),
            }),
          )
        ).status,
      ).toBe(202);
      const claimBeforeCleanup = await worker.fetch(
        new Request('https://core.internal/runner-claims', {
          method: 'POST',
          headers: { 'x-compte-rendu-runner-claim': 'verified' },
        }),
      );
      expect(claimBeforeCleanup.status).toBe(204);
      expect(
        (
          await worker.fetch(
            new Request('https://core.internal/runner-results', {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'x-compte-rendu-runner-callback': 'verified',
              },
              body: await abortedCallback(oldJob.runId, oldJob.id),
            }),
          )
        ).status,
      ).toBe(202);
      const claimAfterCleanup = await worker.fetch(
        new Request('https://core.internal/runner-claims', {
          method: 'POST',
          headers: { 'x-compte-rendu-runner-claim': 'verified' },
        }),
      );
      expect(claimAfterCleanup.status).toBe(200);
      expect(await claimAfterCleanup.json()).toMatchObject({ headSha: newEvent.headSha });
    } finally {
      database.close();
    }
  });

  it('does not return a claimed old head that becomes superseded while its token is minted', async () => {
    const database = new SqliteD1Database();
    let tokenMintStarted!: () => void;
    let releaseTokenMint!: () => void;
    const mintStarted = new Promise<void>((resolve) => {
      tokenMintStarted = resolve;
    });
    const tokenMintGate = new Promise<void>((resolve) => {
      releaseTokenMint = resolve;
    });
    const worker = createCoreWorker(
      {
        REVIEW_DB: database,
        RUNNER: {
          fetch: async (request) =>
            Response.json({
              id: new URL(request.url).pathname.split('/').pop(),
              runId: 'old-run',
              attempt: 1,
              evidence: { id: 'old-evidence', status: 'incomplete' },
              status: 'aborted',
              stage: 'cleanup',
              sandbox: { cleanup: 'destroyed' },
            }),
        },
        RUNNER_AUTH_TOKEN: 'runner-auth-token',
        GITHUB_APP_ID: '1234567',
        GITHUB_APP_PRIVATE_KEY: 'test-private-key',
      },
      {
        github: { getRepositoryUrl: async () => 'https://github.com/acme/reviewed.git' },
        getReadInstallationToken: async () => {
          tokenMintStarted();
          await tokenMintGate;
          return { token: 'repository-read-token', expiresAt: '2026-09-01T01:00:00.000Z' };
        },
      },
    );

    try {
      expect(
        (
          await worker.fetch(
            new Request('https://core.internal/review-events', {
              method: 'POST',
              body: JSON.stringify({ ...eligibleEvent, deliveryId: 'delivery-claim-race-old' }),
            }),
          )
        ).status,
      ).toBe(202);
      const oldClaim = worker.fetch(
        new Request('https://core.internal/runner-claims', {
          method: 'POST',
          headers: { 'x-compte-rendu-runner-claim': 'verified' },
        }),
      );
      await mintStarted;

      const newHead = '3333333333333333333333333333333333333333';
      expect(
        (
          await worker.fetch(
            new Request('https://core.internal/review-events', {
              method: 'POST',
              body: JSON.stringify({
                ...eligibleEvent,
                deliveryId: 'delivery-claim-race-new',
                headSha: newHead,
              }),
            }),
          )
        ).status,
      ).toBe(202);
      releaseTokenMint();

      expect((await oldClaim).status).toBe(204);
      const currentClaim = await worker.fetch(
        new Request('https://core.internal/runner-claims', {
          method: 'POST',
          headers: { 'x-compte-rendu-runner-claim': 'verified' },
        }),
      );
      expect(currentClaim.status).toBe(200);
      expect(await currentClaim.json()).toMatchObject({ headSha: newHead });
    } finally {
      releaseTokenMint();
      database.close();
    }
  });

  it('queues an eligible review without creating a Runner Job', async () => {
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
      expect(runnerRequests).toHaveLength(0);
      const claim = await worker.fetch(
        new Request('https://core.internal/runner-claims', {
          method: 'POST',
          headers: { 'x-compte-rendu-runner-claim': 'verified' },
        }),
      );
      expect(claim.status).toBe(200);
      expect(await claim.json()).toMatchObject({ repositoryReadToken: 'repository-read-token' });
      expect(runnerRequests).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  it('does not retry or admit a Runner while accepting a webhook', async () => {
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
      expect(runnerRequests).toHaveLength(0);
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
    await stateStore.recordCheckRun?.({ runId: claimed.runId, checkRunId: 321 });

    const stored: Array<{ key: string; value: ArrayBuffer | string }> = [];
    const reviews: unknown[] = [];
    const checkUpdates: unknown[] = [];
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
          updateCheckRun: async (input) => {
            checkUpdates.push(input);
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
      expect(checkUpdates).toEqual([
        {
          repositoryId: 11,
          installationId: 7,
          checkRunId: 321,
          status: 'success',
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
      expect(checkUpdates).toHaveLength(1);
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

  it('keeps duplicate success callbacks retryable until publication completes', async () => {
    const database = new SqliteD1Database();
    const stateStore = createD1ReviewStateStore(database);
    const claimed = await stateStore.claimReview({
      deliveryId: 'delivery-duplicate-success',
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
    if (claimed.kind !== 'claimed') throw new Error('duplicate callback run was not claimed');
    await stateStore.recordRunnerJob({ runId: claimed.runId, jobId: 'runner-job-1', attempt: 1 });
    await stateStore.recordCheckRun?.({ runId: claimed.runId, checkRunId: 321 });
    let signalPublicationStarted!: () => void;
    const publicationStarted = new Promise<void>((resolve) => {
      signalPublicationStarted = resolve;
    });
    let finishPublication!: () => void;
    const publicationFinished = new Promise<void>((resolve) => {
      finishPublication = resolve;
    });
    const checkUpdates: Array<{ status: string }> = [];
    let firstPublication = true;
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
          findReviewByMarker: async () => undefined,
          createReview: async ({ payload }) => {
            if (firstPublication) {
              firstPublication = false;
              signalPublicationStarted();
              await publicationFinished;
            }
            return { kind: 'created', review: payload };
          },
          updateCheckRun: async ({ status }) => {
            checkUpdates.push({ status });
          },
        },
      },
    );
    const callback = async () =>
      new Request('https://core.internal/runner-results', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-compte-rendu-runner-callback': 'verified',
        },
        body: await successfulCallback(claimed.runId),
      });

    try {
      const winner = worker.fetch(await callback());
      await publicationStarted;
      const duplicate = await worker.fetch(await callback());
      expect(duplicate.status).toBe(503);
      expect(checkUpdates).toEqual([]);
      finishPublication();
      expect((await winner).status).toBe(202);
      expect(checkUpdates).toEqual([{ status: 'success' }]);
    } finally {
      database.close();
    }
  });

  it('retries failure feedback for a succeeded callback after publication fails', async () => {
    const database = new SqliteD1Database();
    const stateStore = createD1ReviewStateStore(database);
    const claimed = await stateStore.claimReview({
      deliveryId: 'delivery-succeeded-callback-failure-retry',
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
    if (claimed.kind !== 'claimed') throw new Error('failure retry run was not claimed');
    await stateStore.recordRunnerJob({ runId: claimed.runId, jobId: 'runner-job-1', attempt: 1 });
    await stateStore.recordCheckRun?.({ runId: claimed.runId, checkRunId: 321 });
    const comments: string[] = [];
    const checkUpdates: string[] = [];
    let firstComment = true;
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
          createReview: async () => {
            throw new Error('review publication unavailable');
          },
          createIssueComment: async ({ body }) => {
            if (firstComment) {
              firstComment = false;
              throw new Error('failure comment unavailable');
            }
            comments.push(body);
            return { id: 123, body };
          },
          updateCheckRun: async ({ status }) => {
            checkUpdates.push(status);
          },
        },
      },
    );
    const callbackBody = await successfulCallback(claimed.runId);
    const request = () =>
      new Request('https://core.internal/runner-results', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-compte-rendu-runner-callback': 'verified',
        },
        body: callbackBody,
      });

    try {
      expect((await worker.fetch(request())).status).toBe(503);
      expect((await worker.fetch(request())).status).toBe(202);
      expect(comments).toEqual([
        `Review failed before a result could be published. Please retry with \`/ai-review\`.\n\n<!-- compte-rendu:failure:run:${claimed.runId} -->`,
      ]);
      expect(checkUpdates.at(-1)).toBe('failure');
      expect(await stateStore.getRunOutcome(claimed.runId)).toMatchObject({ status: 'failed' });
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
    await stateStore.markRunSuperseded({
      runId: superseded.runId,
      occurredAt: '2026-09-01T00:00:03.000Z',
    });
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

  it('publishes one failure comment for duplicate failed callbacks', async () => {
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
    await stateStore.recordCheckRun?.({ runId: claimed.runId, checkRunId: 321 });
    const reactions: unknown[] = [];
    const comments: Array<{ body: string; [key: string]: unknown }> = [];
    const checkUpdates: unknown[] = [];
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
          createIssueComment: async (input) => {
            comments.push(input);
            return input;
          },
          updateCheckRun: async (input) => {
            checkUpdates.push(input);
          },
        },
      },
    );
    try {
      const callbackBody = await failedCallback(claimed.runId);
      const callback = () =>
        new Request('https://core.internal/runner-results', {
          method: 'POST',
          headers: {
            'x-compte-rendu-runner-callback': 'verified',
            'content-type': 'application/json',
          },
          body: callbackBody,
        });
      expect((await worker.fetch(callback())).status).toBe(202);
      expect((await worker.fetch(callback())).status).toBe(202);
      await expect(stateStore.getRunOutcome(claimed.runId)).resolves.toMatchObject({
        status: 'failed',
        commentId: 987654,
      });
      expect(reactions).toEqual([
        { repositoryId: 11, installationId: 7, commentId: 987654, content: '-1' },
      ]);
      expect(comments).toEqual([
        {
          repositoryId: 11,
          pullRequestNumber: 42,
          installationId: 7,
          body: `Review failed before a result could be published. Please retry with \`/ai-review\`.\n\n<!-- compte-rendu:failure:run:${claimed.runId} -->`,
        },
      ]);
      expect(checkUpdates).toEqual([
        {
          repositoryId: 11,
          installationId: 7,
          checkRunId: 321,
          status: 'failure',
        },
      ]);
    } finally {
      database.close();
    }
  });

  it('publishes failure feedback when the manual reaction fails', async () => {
    const database = new SqliteD1Database();
    const stateStore = createD1ReviewStateStore(database);
    const claimed = await stateStore.claimReview({
      deliveryId: 'delivery-reaction-fails',
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
    if (claimed.kind !== 'claimed') throw new Error('reaction failure run was not claimed');
    await stateStore.recordRunnerJob({ runId: claimed.runId, jobId: 'runner-job-1', attempt: 1 });
    await stateStore.recordCheckRun?.({ runId: claimed.runId, checkRunId: 321 });
    const comments: string[] = [];
    const checkUpdates: string[] = [];
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
          addReaction: async () => {
            throw new Error('reaction unavailable');
          },
          createIssueComment: async ({ body }) => {
            comments.push(body);
            return { id: 123, body };
          },
          updateCheckRun: async ({ status }) => {
            checkUpdates.push(status);
          },
        },
      },
    );

    try {
      expect(
        (
          await worker.fetch(
            new Request('https://core.internal/runner-results', {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'x-compte-rendu-runner-callback': 'verified',
              },
              body: await failedCallback(claimed.runId),
            }),
          )
        ).status,
      ).toBe(202);
      expect(comments).toEqual([
        `Review failed before a result could be published. Please retry with \`/ai-review\`.\n\n<!-- compte-rendu:failure:run:${claimed.runId} -->`,
      ]);
      expect(checkUpdates).toEqual(['failure']);
    } finally {
      database.close();
    }
  });

  it('retries a failed callback when the failure comment was not created', async () => {
    const database = new SqliteD1Database();
    const stateStore = createD1ReviewStateStore(database);
    const claimed = await stateStore.claimReview({
      deliveryId: 'delivery-callback-failure-comment-retry',
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
    if (claimed.kind !== 'claimed') throw new Error('failure retry run was not claimed');
    await stateStore.recordRunnerJob({ runId: claimed.runId, jobId: 'runner-job-1', attempt: 1 });
    const comments: string[] = [];
    let first = true;
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
          createIssueComment: async ({ body }) => {
            if (first) {
              first = false;
              throw new Error('GitHub unavailable before create');
            }
            comments.push(body);
            return { id: 123, body };
          },
        },
      },
    );
    const callbackBody = await failedCallback(claimed.runId);
    const request = () =>
      new Request('https://core.internal/runner-results', {
        method: 'POST',
        headers: {
          'x-compte-rendu-runner-callback': 'verified',
          'content-type': 'application/json',
        },
        body: callbackBody,
      });

    try {
      expect((await worker.fetch(request())).status).toBe(503);
      expect((await worker.fetch(request())).status).toBe(202);
      expect(comments).toEqual([
        `Review failed before a result could be published. Please retry with \`/ai-review\`.\n\n<!-- compte-rendu:failure:run:${claimed.runId} -->`,
      ]);
    } finally {
      database.close();
    }
  });

  it('recovers a failure comment when GitHub creates it but loses the response', async () => {
    const remoteComments: Array<{ id: number; body: string }> = [];
    let posts = 0;
    const fetcher: typeof fetch = async (input, init) => {
      const inputUrl =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(inputUrl);
      const method = init?.method ?? 'GET';
      if (url.pathname === '/repositories/11') {
        return Response.json({ full_name: 'acme/reviewed' });
      }
      if (url.pathname === '/repos/acme/reviewed/issues/42/comments' && method === 'GET') {
        return Response.json(remoteComments);
      }
      if (url.pathname === '/repos/acme/reviewed/issues/42/comments' && method === 'POST') {
        posts += 1;
        const { body } = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
          body: string;
        };
        remoteComments.push({ id: 123, body });
        return new Response('{}', { status: 503 });
      }
      return new Response('{}', { status: 404 });
    };
    const github = createGitHubPublicationAdapter({
      token: 'installation-token',
      fetch: fetcher,
    });
    const input = {
      repositoryId: 11,
      pullRequestNumber: 42,
      installationId: 7,
      body: 'Review failed.\n\n<!-- compte-rendu:failure:run:run-1 -->',
    };

    await expect(github.createIssueComment?.(input)).resolves.toEqual({
      id: 123,
      body: input.body,
    });
    await expect(github.createIssueComment?.(input)).resolves.toEqual({
      id: 123,
      body: input.body,
    });
    expect(posts).toBe(1);
  });

  it('creates and updates a GitHub Check without duplicating a lost create response', async () => {
    const remoteChecks: Array<{ id: number; external_id: string }> = [];
    const requests: Array<{ method: string; path: string; body: unknown }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const inputUrl =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(inputUrl);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      if (url.pathname === '/repositories/11') {
        return Response.json({ full_name: 'acme/reviewed' });
      }
      if (url.pathname.endsWith('/commits/2222222222222222222222222222222222222222/check-runs')) {
        return Response.json({ total_count: remoteChecks.length, check_runs: remoteChecks });
      }
      if (url.pathname === '/repos/acme/reviewed/check-runs' && method === 'POST') {
        requests.push({ method, path: url.pathname, body });
        remoteChecks.push({ id: 321, external_id: 'run-1' });
        return new Response('{}', { status: 503 });
      }
      if (url.pathname === '/repos/acme/reviewed/check-runs/321' && method === 'PATCH') {
        requests.push({ method, path: url.pathname, body });
        return Response.json({ id: 321 });
      }
      return new Response('{}', { status: 404 });
    };
    const github = createGitHubPublicationAdapter({
      token: 'installation-token',
      fetch: fetcher,
    });
    const createInput = {
      repositoryId: 11,
      installationId: 7,
      headSha: eligibleEvent.headSha,
      runId: 'run-1',
    };

    await expect(github.createCheckRun?.(createInput)).resolves.toEqual({ id: 321 });
    await expect(github.createCheckRun?.(createInput)).resolves.toEqual({ id: 321 });
    for (const status of ['in_progress', 'success', 'failure', 'cancelled'] as const) {
      await github.updateCheckRun?.({
        repositoryId: 11,
        installationId: 7,
        checkRunId: 321,
        status,
      });
    }

    expect(requests).toEqual([
      {
        method: 'POST',
        path: '/repos/acme/reviewed/check-runs',
        body: {
          name: 'Petit Chiba Review',
          head_sha: eligibleEvent.headSha,
          status: 'queued',
          external_id: 'run-1',
          output: {
            title: 'Review queued',
            summary: 'Waiting for an available review runner.',
          },
        },
      },
      {
        method: 'PATCH',
        path: '/repos/acme/reviewed/check-runs/321',
        body: {
          status: 'in_progress',
          output: { title: 'Review in progress', summary: 'The review agent is running.' },
        },
      },
      {
        method: 'PATCH',
        path: '/repos/acme/reviewed/check-runs/321',
        body: {
          status: 'completed',
          conclusion: 'success',
          output: { title: 'Review completed', summary: 'The Review was published.' },
        },
      },
      {
        method: 'PATCH',
        path: '/repos/acme/reviewed/check-runs/321',
        body: {
          status: 'completed',
          conclusion: 'failure',
          output: {
            title: 'Review failed',
            summary: 'See the failure comment on this pull request.',
          },
        },
      },
      {
        method: 'PATCH',
        path: '/repos/acme/reviewed/check-runs/321',
        body: {
          status: 'completed',
          conclusion: 'cancelled',
          output: {
            title: 'Review cancelled',
            summary: 'A newer pull request revision replaced this run.',
          },
        },
      },
    ]);
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
      expect(runnerRequests).toHaveLength(0);
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

  it('accepts a queued review without requiring Runner admission', async () => {
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
      ).toMatchObject({ status: 202 });
      expect(events).toEqual([
        {
          phase: 'core',
          outcome: 'scheduled',
          deliveryId: 'delivery-core-worker-schedule-failed',
          runId: expect.any(String),
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
