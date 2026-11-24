import { describe, expect, it, vi } from 'vitest';
import { createCoreWorker } from '../apps/core/src/core-worker';
import { createD1ReviewStateStore } from '../apps/core/src/index';
import { SqliteD1Database } from './support/d1-database';
import { claimRunnerJob } from './support/runner-claim';
import {
  eligibleEvent,
  coreEnv,
  deferred,
  evidenceField,
  successfulCallback,
  failedCallback,
  runnerClaimRequest,
} from './support/core-worker-harness';

describe('Core Check setup and delivery reconciliation', () => {
  it('keeps an existing scheduled run claimable after Check migration', async () => {
    const database = new SqliteD1Database('core', '0005_publication_claim.sql');
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
      database.migrateThrough();
      const migratedStore = createD1ReviewStateStore(database);
      await expect(
        migratedStore.claimNextJob({
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
        loadReviewTarget: async () => ({ headSha: eligibleEvent.headSha }),
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
    try {
      await checkStarted.promise;
      expect((await scheduling).status).toBe(202);
      const claim = await worker.fetch(runnerClaimRequest());
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
          runId: expect.any(String),
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
          runId: claimed.runId,
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
    const checkDecisions: (string | undefined)[] = [];
    const worker = createCoreWorker(
      {
        ...coreEnv(database),
        EVIDENCE_BUCKET: { put: async () => undefined },
      },
      {
        github: {
          createCheckRun: async () => check.promise,
          updateCheckRun: async ({ status, decision }) => {
            if (status === 'in_progress' && !checkStatuses.includes('in_progress')) {
              inProgressStarted.resolve();
              await releaseInProgress.promise;
            }
            checkStatuses.push(status);
            checkDecisions.push(decision);
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
      const callback = JSON.parse(await successfulCallback(claimed.runId, claimed.id));
      callback.result = { version: 2, decision: 'request_changes', markdown: callback.result };
      const manifest = JSON.parse(
        Buffer.from(callback.evidence.manifest.content, 'base64').toString(),
      );
      manifest.result = callback.result;
      callback.evidence.manifest = await evidenceField(
        Buffer.from(JSON.stringify(manifest)).toString('base64'),
      );

      expect(
        (
          await worker.fetch(
            new Request('https://core.internal/runner-results', {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'x-compte-rendu-runner-callback': 'verified',
              },
              body: JSON.stringify(callback),
            }),
          )
        ).status,
      ).toBe(202);
      releaseInProgress.resolve();
      await Promise.all(backgroundTasks);

      expect(checkStatuses.at(-1)).toBe('success');
      expect(checkDecisions.at(-1)).toBe('request_changes');
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
          loadReviewTarget: async () => ({ headSha: eligibleEvent.headSha }),
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
          runId: claimed.runId,
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

  it('finishes a late Check as manually cancelled when the operator wins during creation', async () => {
    const database = new SqliteD1Database();
    const background: Promise<unknown>[] = [];
    const started = deferred<string>();
    const check = deferred<{ id: number }>();
    const updateCheckRun = vi.fn(async () => {});
    const worker = createCoreWorker(coreEnv(database), {
      github: {
        createCheckRun: async ({ runId }) => {
          started.resolve(runId);
          return check.promise;
        },
        updateCheckRun,
      },
    });
    try {
      await worker.fetch(
        new Request('https://core.internal/review-events', {
          method: 'POST',
          body: JSON.stringify(eligibleEvent),
        }),
        undefined,
        { waitUntil: (task) => background.push(task) },
      );
      expect((await worker.cancelReview(await started.promise, 1)).status).toBe(200);
      check.resolve({ id: 324 });
      await Promise.all(background);
      expect(updateCheckRun).toHaveBeenCalledWith(
        expect.objectContaining({
          checkRunId: 324,
          status: 'cancelled',
          cancellationReason: 'manual',
        }),
      );
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
          runId: expect.any(String),
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
        loadReviewTarget: async () => ({ headSha: eligibleEvent.headSha }),
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
          runId: claimed.runId,
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

  it('retries a transient terminal Check update from a fresh Worker without another review or Check', async () => {
    const database = new SqliteD1Database();
    const stateStore = createD1ReviewStateStore(database);
    const claimed = await stateStore.claimReview({
      deliveryId: 'delivery-check-retry-success',
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
    if (claimed.kind !== 'claimed') throw new Error('retry run was not claimed');
    await claimRunnerJob(stateStore, { runId: claimed.runId, jobId: 'runner-job-1' });
    await stateStore.recordCheckRun?.({ runId: claimed.runId, checkRunId: 321 });
    const reviews: unknown[] = [];
    const createChecks: unknown[] = [];
    const firstUpdates: unknown[] = [];
    const firstWorker = createCoreWorker(
      {
        REVIEW_DB: database,
        GITHUB_APP_ID: '1234567',
        GITHUB_APP_PRIVATE_KEY: 'test-private-key',
        EVIDENCE_BUCKET: { put: async () => undefined },
      },
      {
        stateStore,
        github: {
          createCheckRun: async (input) => {
            createChecks.push(input);
            return { id: 999 };
          },
          loadReviewTarget: async () => ({ headSha: eligibleEvent.headSha }),
          createReview: async ({ payload }) => {
            reviews.push(payload);
            return { kind: 'created', review: payload };
          },
          updateCheckRun: async (input) => {
            firstUpdates.push(input);
            throw new Error('Checks API temporarily unavailable');
          },
        },
      },
    );
    const callbackBody = await successfulCallback(claimed.runId);
    const callback = () =>
      new Request('https://core.internal/runner-results', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-compte-rendu-runner-callback': 'verified',
        },
        body: callbackBody,
      });

    try {
      expect((await firstWorker.fetch(callback())).status).toBe(202);
      expect(await stateStore.getRunOutcome(claimed.runId)).toMatchObject({ status: 'completed' });
      expect(reviews).toHaveLength(1);
      expect(firstUpdates).toEqual([
        {
          runId: claimed.runId,
          repositoryId: 11,
          installationId: 7,
          checkRunId: 321,
          status: 'success',
        },
      ]);

      const retriedUpdates: unknown[] = [];
      const freshWorker = createCoreWorker(
        {
          REVIEW_DB: database,
          GITHUB_APP_ID: '1234567',
          GITHUB_APP_PRIVATE_KEY: 'test-private-key',
          EVIDENCE_BUCKET: { put: async () => undefined },
        },
        {
          stateStore: createD1ReviewStateStore(database),
          github: {
            createCheckRun: async (input) => {
              createChecks.push(input);
              return { id: 999 };
            },
            createReview: async ({ payload }) => {
              reviews.push(payload);
              return { kind: 'created', review: payload };
            },
            updateCheckRun: async (input) => {
              retriedUpdates.push(input);
            },
          },
        },
      );
      await freshWorker.reconcileCheckDeliveries(Date.now());
      expect(retriedUpdates).toEqual([
        {
          runId: claimed.runId,
          repositoryId: 11,
          installationId: 7,
          checkRunId: 321,
          status: 'success',
        },
      ]);
      expect(reviews).toHaveLength(1);
      expect(createChecks).toEqual([]);

      await freshWorker.reconcileCheckDeliveries(Date.now());
      expect(retriedUpdates).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it('retries a failed terminal Check after a duplicate callback without reposting the review', async () => {
    const database = new SqliteD1Database();
    const stateStore = createD1ReviewStateStore(database);
    const claimed = await stateStore.claimReview({
      deliveryId: 'delivery-check-retry-duplicate-callback',
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
    if (claimed.kind !== 'claimed') throw new Error('retry run was not claimed');
    await claimRunnerJob(stateStore, { runId: claimed.runId, jobId: 'runner-job-1' });
    await stateStore.recordCheckRun?.({ runId: claimed.runId, checkRunId: 321 });
    const reviews: unknown[] = [];
    let checkAvailable = false;
    const updates: string[] = [];
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
          createReview: async ({ payload }) => {
            reviews.push(payload);
            return { kind: 'created', review: payload };
          },
          updateCheckRun: async ({ status }) => {
            if (!checkAvailable) throw new Error('Checks API temporarily unavailable');
            updates.push(status);
          },
        },
      },
    );
    const callbackBody = await successfulCallback(claimed.runId);
    const callback = () =>
      new Request('https://core.internal/runner-results', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-compte-rendu-runner-callback': 'verified',
        },
        body: callbackBody,
      });

    try {
      expect((await worker.fetch(callback())).status).toBe(202);
      expect(reviews).toHaveLength(1);
      checkAvailable = true;
      expect((await worker.fetch(callback())).status).toBe(202);
      expect(reviews).toHaveLength(1);
      expect(updates).toEqual(['success']);
    } finally {
      database.close();
    }
  });

  it('retries a terminal Check after late Check setup when the first catch-up fails', async () => {
    const database = new SqliteD1Database();
    const backgroundTasks: Promise<unknown>[] = [];
    const check = deferred<{ id: number }>();
    const checkRequests: unknown[] = [];
    const firstUpdates: unknown[] = [];
    const retriedUpdates: unknown[] = [];
    let checkAvailable = false;
    const worker = createCoreWorker(
      {
        ...coreEnv(database),
        EVIDENCE_BUCKET: { put: async () => undefined },
      },
      {
        github: {
          createCheckRun: async (input) => {
            checkRequests.push(input);
            return check.promise;
          },
          updateCheckRun: async (input) => {
            firstUpdates.push(input);
            if (!checkAvailable) throw new Error('Checks API temporarily unavailable');
            retriedUpdates.push(input);
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
    const context = { waitUntil: (task: Promise<unknown>) => backgroundTasks.push(task) };

    try {
      expect(
        (
          await worker.fetch(
            new Request('https://core.internal/review-events', {
              method: 'POST',
              body: JSON.stringify({
                ...eligibleEvent,
                deliveryId: 'delivery-check-retry-late-setup',
              }),
            }),
            undefined,
            context,
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
      expect(firstUpdates).toEqual([
        {
          runId: claimed.runId,
          repositoryId: 11,
          installationId: 7,
          checkRunId: 322,
          status: 'success',
        },
      ]);

      checkAvailable = true;
      await worker.reconcileCheckDeliveries(Date.now());
      expect(retriedUpdates).toEqual([
        {
          runId: claimed.runId,
          repositoryId: 11,
          installationId: 7,
          checkRunId: 322,
          status: 'success',
        },
      ]);
      expect(checkRequests).toHaveLength(1);
    } finally {
      check.resolve({ id: 322 });
      await Promise.all(backgroundTasks);
      database.close();
    }
  });

  it('retries a failed Check after a failed callback without posting another review', async () => {
    const database = new SqliteD1Database();
    const stateStore = createD1ReviewStateStore(database);
    const claimed = await stateStore.claimReview({
      deliveryId: 'delivery-check-retry-failure',
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
    if (claimed.kind !== 'claimed') throw new Error('failure run was not claimed');
    await claimRunnerJob(stateStore, { runId: claimed.runId, jobId: 'runner-job-1' });
    await stateStore.recordCheckRun?.({ runId: claimed.runId, checkRunId: 321 });
    const reviews: unknown[] = [];
    const firstUpdates: string[] = [];
    const retriedUpdates: string[] = [];
    let checkAvailable = false;
    const github = {
      loadReviewTarget: async () => ({ headSha: eligibleEvent.headSha }),
      createReview: async ({ payload }: { payload: unknown }) => {
        reviews.push(payload);
        return { kind: 'created' as const, review: payload };
      },
      updateCheckRun: async ({ status }: { status: string }) => {
        if (!checkAvailable) {
          firstUpdates.push(status);
          throw new Error('Checks API temporarily unavailable');
        }
        retriedUpdates.push(status);
      },
    };
    const worker = createCoreWorker(
      {
        REVIEW_DB: database,
        GITHUB_APP_ID: '1234567',
        GITHUB_APP_PRIVATE_KEY: 'test-private-key',
        EVIDENCE_BUCKET: { put: async () => undefined },
      },
      { stateStore, github },
    );
    const callbackBody = await failedCallback(claimed.runId);
    const callback = () =>
      new Request('https://core.internal/runner-results', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-compte-rendu-runner-callback': 'verified',
        },
        body: callbackBody,
      });

    try {
      expect((await worker.fetch(callback())).status).toBe(202);
      expect(await stateStore.getRunOutcome(claimed.runId)).toMatchObject({ status: 'failed' });
      expect(reviews).toEqual([]);
      expect(firstUpdates).toEqual(['failure']);

      checkAvailable = true;
      expect((await worker.fetch(callback())).status).toBe(202);
      expect(retriedUpdates).toEqual(['failure']);
      expect(reviews).toEqual([]);

      const freshWorker = createCoreWorker(
        {
          REVIEW_DB: database,
          GITHUB_APP_ID: '1234567',
          GITHUB_APP_PRIVATE_KEY: 'test-private-key',
          EVIDENCE_BUCKET: { put: async () => undefined },
        },
        { stateStore: createD1ReviewStateStore(database), github },
      );
      await freshWorker.reconcileCheckDeliveries(Date.now());
      expect(retriedUpdates).toEqual(['failure']);
      expect(reviews).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('rotates pending Check deliveries so an unavailable Check cannot starve later rows', async () => {
    const database = new SqliteD1Database();
    const stateStore = createD1ReviewStateStore(database);
    const runIds: string[] = [];
    try {
      for (let index = 1; index <= 10; index += 1) {
        const claimed = await stateStore.claimReview({
          deliveryId: `delivery-check-sweep-${index}`,
          job: {
            repositoryId: 11,
            pullRequestNumber: 100 + index,
            installationId: 7,
            baseSha: eligibleEvent.baseSha,
            headSha: eligibleEvent.headSha,
            trigger: 'automatic',
          },
          occurredAt: `2026-09-01T00:00:0${index}.000Z`,
        });
        if (claimed.kind !== 'claimed') throw new Error('sweep run was not claimed');
        await stateStore.recordCheckRun!({
          runId: claimed.runId,
          checkRunId: 1000 + index,
        });
        await stateStore.markRunCompleted({
          runId: claimed.runId,
          occurredAt: `2026-09-01T00:01:0${index % 10}.000Z`,
        });
        await stateStore.claimCheckDelivery!({
          runId: claimed.runId,
          checkRunId: 1000 + index,
          occurredAt: `2026-09-01T00:02:${String(index).padStart(2, '0')}.000Z`,
        });
        runIds.push(claimed.runId);
      }

      const updates: number[] = [];
      const worker = createCoreWorker(coreEnv(database), {
        stateStore,
        github: {
          updateCheckRun: async ({ checkRunId }) => {
            if (checkRunId !== 1010) throw new Error('Check is permanently unavailable');
            updates.push(checkRunId);
          },
        },
      });

      await expect(worker.reconcileCheckDeliveries(Date.now())).rejects.toThrow(
        'Check delivery reconciliation incomplete',
      );
      expect(updates).not.toContain(1010);
      await expect(worker.reconcileCheckDeliveries(Date.now() + 60_000)).rejects.toThrow(
        'Check delivery reconciliation incomplete',
      );
      expect(updates).toContain(1010);
      expect(runIds).toHaveLength(10);
    } finally {
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
        loadReviewTarget: async () => ({ headSha: eligibleEvent.headSha }),
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
          runId: expect.any(String),
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
      expect(comments).toEqual([expect.stringContaining('Review job failed')]);
      expect(checks).toEqual(['failure']);
    } finally {
      database.close();
    }
  });
});
