import { describe, expect, it, vi } from 'vitest';
import { createRunner } from '../apps/runner/src/runner';
import { createCoreWorker } from '../apps/core/src/core-worker';
import { createD1ReviewStateStore } from '../apps/core/src/index';
import type { ReviewEvent } from '../packages/contracts/src';
import { SqliteD1Database } from './support/d1-database';
import { claimRunnerJob } from './support/runner-claim';
import {
  eligibleEvent,
  runnerResponse,
  coreEnv,
  deferred,
  successfulCallback,
  abortedCallback,
  postHogEvents,
  postHogTestDefaults,
  runnerClaimRequest,
  scheduleEligibleReview,
  claimGithub,
  capturePostHogTransport,
} from './support/core-worker-harness';

describe('Core admission, claims, and manual policy', () => {
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
        github: claimGithub(),
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
        github: claimGithub(),
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
        github: claimGithub(),
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
        github: claimGithub(),
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
    let currentHead = eligibleEvent.headSha;
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
          loadReviewTarget: async () => ({ headSha: currentHead }),
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
      currentHead = newEvent.headSha;

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
        runId: oldRunId,
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
          runId: expect.any(String),
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
    const { fetcher, requests, waitUntilTasks } = capturePostHogTransport();
    const checks: Array<{ headSha: string }> = [];
    const env = {
      ...coreEnv(database),
      EVIDENCE_BUCKET: { put: async () => undefined },
      RUNNER: {
        fetch: async (request: Request) => {
          if (request.method === 'DELETE') return new Response(null, { status: 503 });
          return runnerResponse(request);
        },
      },
      ...postHogTestDefaults.environment,
    };
    const context = { waitUntil: (task: Promise<unknown>) => waitUntilTasks.push(task) };
    let currentHead = eligibleEvent.headSha;
    const worker = createCoreWorker(env, {
      github: {
        getRepositoryUrl: async () => 'https://github.com/acme/reviewed.git',
        loadReviewTarget: async () => ({ headSha: currentHead }),
        createCheckRun: async ({ headSha }) => {
          checks.push({ headSha });
          return { id: 321 + checks.length - 1 };
        },
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
              body: JSON.stringify({ ...eligibleEvent, deliveryId: 'delivery-cancel-fails-old' }),
            }),
            env,
            context,
          )
        ).status,
      ).toBe(202);
      await Promise.all(waitUntilTasks.splice(0));
      const oldClaim = await worker.fetch(
        new Request('https://core.internal/runner-claims', {
          method: 'POST',
          headers: { 'x-compte-rendu-runner-claim': 'verified' },
        }),
        env,
        context,
      );
      expect(oldClaim.status).toBe(200);
      const oldJob = (await oldClaim.json()) as { id: string; runId: string };
      await Promise.all(waitUntilTasks.splice(0));
      const newEvent = {
        ...eligibleEvent,
        deliveryId: 'delivery-cancel-fails-new',
        headSha: '3333333333333333333333333333333333333333',
      };
      currentHead = newEvent.headSha;
      expect(
        (
          await worker.fetch(
            new Request('https://core.internal/review-events', {
              method: 'POST',
              body: JSON.stringify(newEvent),
            }),
            env,
            context,
          )
        ).status,
      ).toBe(202);
      await Promise.all(waitUntilTasks.splice(0));
      const scheduledEvents = (await postHogEvents(requests)).filter(
        (event) => (event as { event: string }).event === 'review scheduled',
      );
      expect(scheduledEvents).toHaveLength(2);
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
      fetcher.mockRestore();
      database.close();
    }
  });

  it('stops a superseded review while the real Core claim response is in transit', async () => {
    const database = new SqliteD1Database();
    const stateStore = createD1ReviewStateStore(database);
    const intercepted = deferred<{ runId: string; id: string }>();
    const release = deferred<void>();
    const callback = deferred<{ status: string; sandbox: { cleanup: string } }>();
    const env = {
      ...coreEnv(database, (request) => runner.handle(request)),
      EVIDENCE_BUCKET: { put: async () => undefined },
    };
    const core = createCoreWorker(env, { stateStore, ...postHogTestDefaults.dependencies });
    const schedule = (event: ReviewEvent) =>
      core.fetch(
        new Request('https://core.internal/review-events', {
          method: 'POST',
          body: JSON.stringify(event),
        }),
      );
    await schedule(eligibleEvent);
    let polled = false;
    vi.stubEnv('MODEL_SECRET_COMMAND', 'secret-resolver get MODEL_API_KEY');
    const runner: ReturnType<typeof createRunner> = createRunner({
      authToken: 'runner-auth-token',
      claimUrl: 'https://core.internal/runner-claims',
      callbackUrl: 'https://core.internal/runner-results',
      callbackToken: 'callback',
      claimIntervalMs: 1000,
      claimFetch: async () => {
        if (polled) return new Response(null, { status: 204 });
        polled = true;
        const response = await core.fetch(
          new Request('https://core.internal/runner-claims', {
            method: 'POST',
            headers: { 'x-compte-rendu-runner-claim': 'verified' },
          }),
        );
        intercepted.resolve(await response.clone().json());
        await release.promise;
        return response;
      },
      callbackFetch: async (_, init) => {
        const req = new Request('https://core.internal/runner-results', init);
        req.headers.set('x-compte-rendu-runner-callback', 'verified');
        const result = await req.clone().json();
        const reply = await core.fetch(req);
        callback.resolve(result);
        return reply;
      },
      evidenceRoot: '/tmp/cr-test-in-flight-supersession',
      modelConfig: JSON.stringify({ id: 'opencode-go/test-model' }),
      progressFetch: async () => new Response(null, { status: 202 }),
      process: async () => ({ exitCode: 0, stdout: '', timedOut: false, truncated: false }),
    });
    try {
      const { runId, id } = await intercepted.promise;
      await schedule({
        ...eligibleEvent,
        deliveryId: 'replace-before-admission',
        action: 'synchronize',
        headSha: '3'.repeat(40),
      });
      expect(await stateStore.getRunOutcome(runId)).toMatchObject({
        status: 'superseded',
        runnerJobId: id,
      });
      release.resolve();
      expect(await callback.promise).toMatchObject({
        status: 'aborted',
        sandbox: { cleanup: 'destroyed' },
      });
      expect((await stateStore.getRunOutcome(runId))?.runnerJobId).toBe(id);
    } finally {
      release.resolve();
      vi.unstubAllEnvs();
      await runner.close();
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
    let currentHead = eligibleEvent.headSha;
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
        github: claimGithub(() => currentHead),
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
      currentHead = newHead;
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
        github: claimGithub(),
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

  it.each([false, true])(
    'reconciles the same claim after a lost response (preparation expires: %s)',
    async (expires) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-09-01T00:00:00Z'));
      const database = new SqliteD1Database();
      const stateStore = createD1ReviewStateStore(database);
      const env = coreEnv(database);
      let unblock!: () => void;
      let began!: () => void;
      const gate = new Promise<void>((resolve) => {
        unblock = resolve;
      });
      const preparing = new Promise<void>((resolve) => {
        began = resolve;
      });
      const checks: string[] = [];
      let lookupUnavailable = false;
      let currentHead = eligibleEvent.headSha;
      const dependencies = {
        github: {
          createCheckRun: async () => ({ id: 333 }),
          updateCheckRun: async ({ status }: { status: string }) => {
            checks.push(status);
          },
          getRepositoryUrl: async () => {
            if (lookupUnavailable) throw new Error('unavailable');
            began();
            await gate;
            return 'https://github.com/acme/reviewed.git';
          },
          loadReviewTarget: async () => ({ headSha: currentHead }),
        },
        getReadInstallationToken: async () => ({
          token: 'read-only',
          expiresAt: '2026-09-01T01:20:00.000Z',
        }),
      };
      const request = () =>
        new Request('https://core.internal/runner-claims', {
          method: 'POST',
          headers: { 'x-compte-rendu-runner-claim': 'verified' },
          body: JSON.stringify({ requestId: '89a128bf-2bda-4e85-ab11-be00c22c0675' }),
        });
      try {
        const worker = createCoreWorker(env, dependencies);
        await worker.fetch(
          new Request('https://core.internal/review-events', {
            method: 'POST',
            body: JSON.stringify(eligibleEvent),
          }),
        );
        const firstResponse = worker.fetch(request());
        await preparing;
        expect((await createCoreWorker(env, dependencies).fetch(request())).status).toBe(503);
        if (expires) {
          vi.setSystemTime(new Date('2026-09-01T01:31:00Z'));
          expect((await createCoreWorker(env, dependencies).fetch(request())).status).toBe(204);
          unblock();
          expect((await firstResponse).status).not.toBe(200);
          expect((await worker.fetch(request())).status).toBe(204);
          expect(checks).toContain('failure');
          const unpreparedRun = database.database
            .prepare('SELECT run_id FROM review_runs')
            .get() as { run_id: string };
          const unprepared = await stateStore.getRunOutcome(unpreparedRun.run_id);
          expect(unprepared?.status).toBe('failed');
          expect(unprepared?.runnerJobId).toBeUndefined();
          expect(unprepared?.cleanup).toBeUndefined();
          return;
        }
        unblock();
        const first = await firstResponse;
        expect(first.status).toBe(200);
        const assigned = (await first.clone().json()) as { id: string; runId: string };
        // A prepared replay resends the same handoff even if the head moved.
        currentHead = '3333333333333333333333333333333333333333';
        const replay = await createCoreWorker(env, dependencies).fetch(request());
        expect(replay.status).toBe(200);
        expect(replay.headers.get('cache-control')).toBe('no-store');
        expect(await replay.json()).toEqual(await first.json());
        lookupUnavailable = true;
        expect((await worker.fetch(request())).status).toBe(503);
        vi.setSystemTime(new Date('2026-09-01T01:31:00Z'));
        expect((await worker.fetch(request())).status).toBe(204);
        expect(checks).toContain('failure');
        const prepared = await stateStore.getRunOutcome(assigned.runId);
        expect(prepared?.status).toBe('failed');
        expect(prepared?.runnerJobId).toBe(assigned.id);
        expect(prepared?.cleanup).toBe('pending');
      } finally {
        unblock();
        database.close();
        vi.useRealTimers();
      }
    },
  );

  it.each(['prepared', 'legacy'] as const)(
    'reruns a same-pull-request review after a lost claim reaches the existing deadline (%s)',
    async (mode) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-09-01T00:00:00Z'));
      const database = new SqliteD1Database();
      const stateStore = createD1ReviewStateStore(database);
      const env = {
        ...coreEnv(database),
        EVIDENCE_BUCKET: { put: async () => undefined },
      };
      let currentHead = eligibleEvent.headSha;
      const checkUpdates: Array<{ runId: string; status: string }> = [];
      const worker = createCoreWorker(env, {
        stateStore,
        github: {
          ...claimGithub(() => currentHead),
          createCheckRun: async () => ({ id: 321 }),
          updateCheckRun: async ({ runId, status }: { runId: string; status: string }) => {
            checkUpdates.push({ runId, status });
          },
        },
        getReadInstallationToken: async () => ({
          token: 'repository-read-token',
          expiresAt: '2026-09-01T01:20:00.000Z',
        }),
      });
      const preparedClaimRequest = () =>
        new Request('https://core.internal/runner-claims', {
          method: 'POST',
          headers: { 'x-compte-rendu-runner-claim': 'verified' },
          body: JSON.stringify({ requestId: '5b0f4f8e-6a1d-4f6e-9c2b-3d4e5f6a7b8c' }),
        });
      const callbackRequest = (body: string) =>
        new Request('https://core.internal/runner-results', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-compte-rendu-runner-callback': 'verified',
          },
          body,
        });
      try {
        expect(
          (await scheduleEligibleReview(worker, eligibleEvent.headSha, 'delivery-liveness-old'))
            .status,
        ).toBe(202);
        const claim = await worker.fetch(
          mode === 'legacy' ? runnerClaimRequest() : preparedClaimRequest(),
        );
        expect(claim.status).toBe(200);
        const old = (await claim.json()) as { id: string; runId: string; attempt: number };
        await vi.waitFor(async () =>
          expect((await stateStore.getRunOutcome(old.runId))?.checkRunId).toBe(321),
        );

        // The original Runner neither polls again nor delivers a result.
        vi.setSystemTime(new Date('2026-09-01T01:31:00Z'));
        currentHead = '3333333333333333333333333333333333333333';
        expect(
          (await scheduleEligibleReview(worker, currentHead, 'delivery-liveness-new')).status,
        ).toBe(202);

        const replacement = await worker.fetch(runnerClaimRequest());
        expect(replacement.status).toBe(200);
        const fresh = (await replacement.json()) as {
          headSha: string;
          id: string;
          runId: string;
          attempt: number;
        };
        expect(fresh.headSha).toBe(currentHead);
        expect(fresh.id).not.toBe(old.id);

        const expired = await stateStore.getRunOutcome(old.runId);
        expect(expired).toMatchObject({
          status: 'failed',
          runnerJobId: old.id,
          cleanup: 'pending',
        });
        expect((await stateStore.getRunOutcome(fresh.runId))?.status).toBe('scheduled');
        expect(
          (
            await stateStore.getPublicOverview({
              since: '2026-09-01T00:00:00.000Z',
              limit: 10,
            })
          ).counts.cleanupAttention,
        ).toBe(1);

        // The existing terminal Check delivery publishes the abandoned failure.
        await worker.reconcileCheckDeliveries(Date.now());
        expect(checkUpdates).toContainEqual({ runId: old.runId, status: 'failure' });

        // A late original result still matches ownership, but its terminal row
        // cannot complete over the replacement.
        expect(
          (
            await worker.fetch(
              callbackRequest(await successfulCallback(old.runId, old.id, old.attempt)),
            )
          ).status,
        ).toBe(202);
        const late = await stateStore.getRunOutcome(old.runId);
        expect(late?.status).toBe('failed');
        expect(late?.decision).toBeUndefined();
        expect(late?.cleanup).toBe('destroyed');
        expect((await stateStore.getRunOutcome(fresh.runId))?.status).toBe('scheduled');
      } finally {
        database.close();
        vi.useRealTimers();
      }
    },
  );

  it('releases an unprepared expired claim without retaining a cleanup obligation', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-01T00:00:00Z'));
    const database = new SqliteD1Database();
    const stateStore = createD1ReviewStateStore(database);
    let currentHead = eligibleEvent.headSha;
    const worker = createCoreWorker(coreEnv(database), {
      stateStore,
      github: claimGithub(() => currentHead),
      getReadInstallationToken: async () => ({
        token: 'repository-read-token',
        expiresAt: '2026-09-01T01:20:00.000Z',
      }),
    });
    try {
      const scheduled = await stateStore.claimReview({
        deliveryId: 'delivery-unprepared-expiry',
        job: {
          repositoryId: eligibleEvent.repositoryId,
          pullRequestNumber: eligibleEvent.pullRequestNumber,
          installationId: eligibleEvent.installationId,
          baseSha: eligibleEvent.baseSha,
          headSha: eligibleEvent.headSha,
          trigger: 'automatic',
        },
        occurredAt: '2026-09-01T00:00:00.000Z',
      });
      if (scheduled.kind !== 'claimed') throw new Error('unprepared claim was not scheduled');
      const claimed = await stateStore.claimNextJob({
        jobId: 'unprepared-job',
        requestId: '4c8a6e2f-0b1d-4e3a-8f5c-6d7e8f9a0b1c',
        attempt: 1,
        occurredAt: '2026-09-01T00:00:01.000Z',
      });
      if (claimed.kind !== 'claimed') throw new Error('unprepared claim was not assigned');

      vi.setSystemTime(new Date('2026-09-01T01:31:00Z'));
      currentHead = '3333333333333333333333333333333333333333';
      expect(
        (await scheduleEligibleReview(worker, currentHead, 'delivery-unprepared-successor')).status,
      ).toBe(202);
      const replacement = await worker.fetch(runnerClaimRequest());
      expect(replacement.status).toBe(200);
      expect(await replacement.json()).toMatchObject({ headSha: currentHead });

      const expired = await stateStore.getRunOutcome(scheduled.runId);
      expect(expired?.status).toBe('failed');
      expect(expired?.runnerJobId).toBeUndefined();
      expect(expired?.cleanup).toBeUndefined();
      expect(
        (
          await stateStore.getPublicOverview({
            since: '2026-09-01T00:00:00.000Z',
            limit: 10,
          })
        ).counts.cleanupAttention,
      ).toBe(0);
    } finally {
      database.close();
      vi.useRealTimers();
    }
  });

  it('sweeps a stale claim before selecting unrelated eligible work', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-01T00:00:00Z'));
    const database = new SqliteD1Database();
    const stateStore = createD1ReviewStateStore(database);
    const job = (pullRequestNumber: number, headSha: string) => ({
      repositoryId: 11,
      pullRequestNumber,
      installationId: 7,
      baseSha: eligibleEvent.baseSha,
      headSha,
      trigger: 'automatic' as const,
    });
    try {
      const stale = await stateStore.claimReview({
        deliveryId: 'delivery-starvation-stale',
        job: job(71, eligibleEvent.headSha),
        occurredAt: '2026-09-01T00:00:00.000Z',
      });
      if (stale.kind !== 'claimed') throw new Error('stale run was not scheduled');
      const staleJob = await stateStore.claimNextJob({
        jobId: 'starvation-stale-job',
        attempt: 1,
        occurredAt: '2026-09-01T00:00:01.000Z',
      });
      if (staleJob.kind !== 'claimed') throw new Error('stale run was not claimed');

      const successor = await stateStore.claimReview({
        deliveryId: 'delivery-starvation-successor',
        job: job(71, '3333333333333333333333333333333333333333'),
        occurredAt: '2026-09-01T00:00:02.000Z',
      });
      if (successor.kind !== 'claimed') throw new Error('successor was not scheduled');
      const unrelated = await stateStore.claimReview({
        deliveryId: 'delivery-starvation-unrelated',
        job: job(72, eligibleEvent.headSha),
        occurredAt: '2026-09-01T00:00:03.000Z',
      });
      if (unrelated.kind !== 'claimed') throw new Error('unrelated work was not scheduled');

      vi.setSystemTime(new Date('2026-09-01T01:31:00Z'));
      await expect(
        stateStore.claimNextJob({
          jobId: 'starvation-after-deadline',
          attempt: 1,
          occurredAt: '2026-09-01T01:31:00.000Z',
        }),
      ).resolves.toMatchObject({
        kind: 'claimed',
        runId: successor.runId,
        job: { pullRequestNumber: 71, headSha: '3333333333333333333333333333333333333333' },
      });
      await expect(stateStore.getRunOutcome(stale.runId)).resolves.toMatchObject({
        status: 'failed',
      });
      await expect(
        stateStore.claimNextJob({
          jobId: 'starvation-unrelated-claim',
          attempt: 1,
          occurredAt: '2026-09-01T01:31:00.000Z',
        }),
      ).resolves.toMatchObject({
        kind: 'claimed',
        runId: unrelated.runId,
        job: { pullRequestNumber: 72 },
      });
    } finally {
      database.close();
      vi.useRealTimers();
    }
  });

  it('checks unprepared expiry at the release write instead of trusting the earlier claim kind', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-01T00:00:00Z'));
    const database = new SqliteD1Database();
    const stateStore = createD1ReviewStateStore(database);
    const requestId = '2a4b6c8d-1e3f-4a5b-9c0d-2e4f6a8b0c1d';
    const racingStore: typeof stateStore = {
      ...stateStore,
      markSchedulingFailed: async (input) => {
        // Preparation can finish after claimNextJob reported `preparing` but
        // before the expiry transition reaches the store.
        database.database
          .prepare('UPDATE review_runs SET claim_prepared = 1 WHERE run_id = ?')
          .run(input.runId);
        return stateStore.markSchedulingFailed(input);
      },
    };
    const worker = createCoreWorker(coreEnv(database), {
      stateStore: racingStore,
      github: claimGithub(),
      getReadInstallationToken: async () => ({
        token: 'repository-read-token',
        expiresAt: '2026-09-01T01:20:00.000Z',
      }),
    });
    try {
      const scheduled = await stateStore.claimReview({
        deliveryId: 'delivery-expiry-prepared-race',
        job: {
          repositoryId: eligibleEvent.repositoryId,
          pullRequestNumber: eligibleEvent.pullRequestNumber,
          installationId: eligibleEvent.installationId,
          baseSha: eligibleEvent.baseSha,
          headSha: eligibleEvent.headSha,
          trigger: 'automatic',
        },
        occurredAt: '2026-09-01T00:00:00.000Z',
      });
      if (scheduled.kind !== 'claimed') throw new Error('race claim was not scheduled');
      const claimed = await stateStore.claimNextJob({
        jobId: 'race-job',
        requestId,
        attempt: 1,
        occurredAt: '2026-09-01T00:00:01.000Z',
      });
      if (claimed.kind !== 'claimed') throw new Error('race claim was not assigned');

      vi.setSystemTime(new Date('2026-09-01T01:31:00Z'));
      const response = await worker.fetch(
        new Request('https://core.internal/runner-claims', {
          method: 'POST',
          headers: { 'x-compte-rendu-runner-claim': 'verified' },
          body: JSON.stringify({ requestId }),
        }),
      );
      expect(response.status).toBe(204);
      const expired = await stateStore.getRunOutcome(scheduled.runId);
      expect(expired?.status).toBe('failed');
      expect(expired?.runnerJobId).toBe('race-job');
      expect(expired?.cleanup).toBe('pending');
    } finally {
      database.close();
      vi.useRealTimers();
    }
  });

  it('expires a migrated owned claim whose claimed_at predates 0009', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-01T00:00:00Z'));
    const database = new SqliteD1Database();
    const stateStore = createD1ReviewStateStore(database);
    const job = (headSha: string) => ({
      repositoryId: 11,
      pullRequestNumber: 81,
      installationId: 7,
      baseSha: eligibleEvent.baseSha,
      headSha,
      trigger: 'automatic' as const,
    });
    try {
      const stale = await stateStore.claimReview({
        deliveryId: 'delivery-migrated-old',
        job: job(eligibleEvent.headSha),
        occurredAt: '2026-09-01T00:00:00.000Z',
      });
      if (stale.kind !== 'claimed') throw new Error('migrated run was not scheduled');
      await claimRunnerJob(stateStore, {
        runId: stale.runId,
        jobId: 'migrated-old-job',
        occurredAt: '2026-09-01T00:00:01.000Z',
      });
      database.database
        .prepare('UPDATE review_runs SET claimed_at = NULL WHERE run_id = ?')
        .run(stale.runId);

      const successor = await stateStore.claimReview({
        deliveryId: 'delivery-migrated-successor',
        job: job('3333333333333333333333333333333333333333'),
        occurredAt: '2026-09-01T00:00:02.000Z',
      });
      if (successor.kind !== 'claimed') throw new Error('successor was not scheduled');

      vi.setSystemTime(new Date('2026-09-01T01:31:00Z'));
      await expect(
        stateStore.claimNextJob({
          jobId: 'migrated-successor-claim',
          attempt: 1,
          occurredAt: '2026-09-01T01:31:00.000Z',
        }),
      ).resolves.toMatchObject({
        kind: 'claimed',
        runId: successor.runId,
        job: { pullRequestNumber: 81, headSha: '3333333333333333333333333333333333333333' },
      });
      await expect(stateStore.getRunOutcome(stale.runId)).resolves.toMatchObject({
        status: 'failed',
      });
    } finally {
      database.close();
      vi.useRealTimers();
    }
  });

  it.each([
    {
      label: 'migrated old',
      createdAt: '2026-09-01T00:00:00.000Z',
      eligible: true,
    },
    {
      label: 'recent',
      createdAt: '2026-09-01T01:30:00.000Z',
      eligible: false,
    },
  ] as const)(
    'applies the created_at fallback to $label cancelled ownership',
    async ({ createdAt, eligible }) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-09-01T00:00:00Z'));
      const database = new SqliteD1Database();
      const stateStore = createD1ReviewStateStore(database);
      const job = {
        repositoryId: 11,
        pullRequestNumber: 82,
        installationId: 7,
        baseSha: eligibleEvent.baseSha,
        headSha: eligibleEvent.headSha,
        trigger: 'automatic' as const,
      };
      try {
        const stale = await stateStore.claimReview({
          deliveryId: `delivery-migrated-cancelled-${eligible}`,
          job,
          occurredAt: '2026-09-01T00:00:00.000Z',
        });
        if (stale.kind !== 'claimed') throw new Error('cancelled run was not scheduled');
        await claimRunnerJob(stateStore, {
          runId: stale.runId,
          jobId: 'migrated-cancelled-job',
          occurredAt: '2026-09-01T00:00:01.000Z',
        });
        await stateStore.cancelRun({
          runId: stale.runId,
          requestedByUid: 1,
          occurredAt: '2026-09-01T00:00:02.000Z',
        });
        database.database
          .prepare('UPDATE review_runs SET claimed_at = NULL, created_at = ? WHERE run_id = ?')
          .run(createdAt, stale.runId);

        vi.setSystemTime(new Date('2026-09-01T01:31:00Z'));
        const manual = await stateStore.claimReview({
          deliveryId: `delivery-migrated-cancelled-retry-${eligible}`,
          job: { ...job, trigger: 'manual' },
          occurredAt: '2026-09-01T01:31:00.000Z',
        });
        if (eligible) {
          expect(manual.kind).toBe('claimed');
          if (manual.kind !== 'claimed') throw new Error('manual retry was not scheduled');
          await expect(
            stateStore.claimNextJob({
              jobId: 'migrated-cancelled-successor',
              attempt: 1,
              occurredAt: '2026-09-01T01:31:00.000Z',
            }),
          ).resolves.toMatchObject({ kind: 'claimed', runId: manual.runId });
        } else {
          expect(manual.kind).not.toBe('claimed');
          await expect(
            stateStore.claimNextJob({
              jobId: 'migrated-cancelled-blocked',
              attempt: 1,
              occurredAt: '2026-09-01T01:31:00.000Z',
            }),
          ).resolves.toEqual({ kind: 'empty' });
        }
      } finally {
        database.close();
        vi.useRealTimers();
      }
    },
  );

  it('expires abandoned failure publication locks without stealing fresh results or active publication', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-01T00:00:00Z'));
    const database = new SqliteD1Database();
    const stateStore = createD1ReviewStateStore(database);
    const scheduleAndClaim = async (pullRequestNumber: number) => {
      const scheduled = await stateStore.claimReview({
        deliveryId: `delivery-expiry-selector-${pullRequestNumber}`,
        job: {
          repositoryId: 11,
          pullRequestNumber,
          installationId: 7,
          baseSha: eligibleEvent.baseSha,
          headSha: eligibleEvent.headSha,
          trigger: 'automatic',
        },
        occurredAt: '2026-09-01T00:00:00.000Z',
      });
      if (scheduled.kind !== 'claimed') throw new Error('selector run was not scheduled');
      const assigned = await stateStore.claimNextJob({
        jobId: `selector-job-${pullRequestNumber}`,
        attempt: 1,
        occurredAt: '2026-09-01T00:00:01.000Z',
      });
      if (assigned.kind !== 'claimed') throw new Error('selector run was not assigned');
      return { runId: scheduled.runId, jobId: assigned.jobId };
    };
    try {
      const freshResult = await scheduleAndClaim(61);
      const staleFailure = await scheduleAndClaim(62);
      const activePublication = await scheduleAndClaim(63);

      await stateStore.recordResultReceived({
        runId: freshResult.runId,
        jobId: freshResult.jobId,
        attempt: 1,
        occurredAt: '2026-09-01T00:50:00.000Z',
      });
      await stateStore.claimRunPublication({
        runId: staleFailure.runId,
        occurredAt: '2026-09-01T00:05:00.000Z',
      });
      await stateStore.claimRunPublication({
        runId: activePublication.runId,
        occurredAt: '2026-09-01T00:05:00.000Z',
        publishing: true,
      });

      vi.setSystemTime(new Date('2026-09-01T01:40:00Z'));
      await expect(
        stateStore.claimNextJob({
          jobId: 'selector-sweep-probe',
          attempt: 1,
          occurredAt: '2026-09-01T01:40:00.000Z',
        }),
      ).resolves.toEqual({ kind: 'empty' });

      expect((await stateStore.getRunOutcome(freshResult.runId))?.status).toBe('scheduled');
      expect((await stateStore.getRunOutcome(staleFailure.runId))?.status).toBe('failed');
      expect((await stateStore.getRunOutcome(activePublication.runId))?.status).toBe('scheduled');
    } finally {
      database.close();
      vi.useRealTimers();
    }
  });

  it.each(['cancelled', 'superseded'] as const)(
    'releases a stale %s owner with unresolved cleanup only after the claim deadline',
    async (terminal) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-09-01T00:00:00Z'));
      const database = new SqliteD1Database();
      const stateStore = createD1ReviewStateStore(database);
      let currentHead = eligibleEvent.headSha;
      const worker = createCoreWorker(coreEnv(database), {
        stateStore,
        github: claimGithub(() => currentHead),
        getReadInstallationToken: async () => ({
          token: 'repository-read-token',
          expiresAt: '2026-09-01T01:20:00.000Z',
        }),
      });
      try {
        expect(
          (
            await scheduleEligibleReview(
              worker,
              eligibleEvent.headSha,
              `delivery-stale-${terminal}`,
            )
          ).status,
        ).toBe(202);
        const claim = await worker.fetch(runnerClaimRequest());
        expect(claim.status).toBe(200);
        const old = (await claim.json()) as { id: string; runId: string; attempt: number };
        if (terminal === 'cancelled') {
          await stateStore.cancelRun({
            runId: old.runId,
            requestedByUid: 1,
            occurredAt: '2026-09-01T00:00:01.000Z',
          });
        } else {
          await stateStore.markRunSuperseded({
            runId: old.runId,
            occurredAt: '2026-09-01T00:00:01.000Z',
          });
        }

        currentHead = '3333333333333333333333333333333333333333';
        vi.setSystemTime(new Date('2026-09-01T00:05:00Z'));
        expect(
          (await scheduleEligibleReview(worker, currentHead, `delivery-stale-next-${terminal}`))
            .status,
        ).toBe(202);
        expect((await worker.fetch(runnerClaimRequest())).status).toBe(204);

        vi.setSystemTime(new Date('2026-09-01T01:31:00Z'));
        const replacement = await worker.fetch(runnerClaimRequest());
        expect(replacement.status).toBe(200);
        expect(await replacement.json()).toMatchObject({ headSha: currentHead });
        await expect(stateStore.getRunOutcome(old.runId)).resolves.toMatchObject({
          status: terminal,
          runnerJobId: old.id,
          cleanup: 'pending',
        });
        expect(
          (
            await stateStore.getPublicOverview({
              since: '2026-09-01T00:00:00.000Z',
              limit: 10,
            })
          ).counts.cleanupAttention,
        ).toBe(1);
      } finally {
        database.close();
        vi.useRealTimers();
      }
    },
  );

  it('keeps automatic same-SHA eligibility while allowing a manual retry after the deadline', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-01T00:00:00Z'));
    const database = new SqliteD1Database();
    const stateStore = createD1ReviewStateStore(database);
    const worker = createCoreWorker(coreEnv(database), {
      stateStore,
      github: claimGithub(),
      getReadInstallationToken: async () => ({
        token: 'repository-read-token',
        expiresAt: '2026-09-01T01:20:00.000Z',
      }),
    });
    const job = {
      repositoryId: eligibleEvent.repositoryId,
      pullRequestNumber: eligibleEvent.pullRequestNumber,
      installationId: eligibleEvent.installationId,
      baseSha: eligibleEvent.baseSha,
      headSha: eligibleEvent.headSha,
      trigger: 'automatic' as const,
    };
    try {
      expect(
        (await scheduleEligibleReview(worker, eligibleEvent.headSha, 'delivery-same-sha-old'))
          .status,
      ).toBe(202);
      const claim = await worker.fetch(runnerClaimRequest());
      expect(claim.status).toBe(200);
      const old = (await claim.json()) as { id: string; runId: string; attempt: number };
      vi.setSystemTime(new Date('2026-09-01T01:31:00Z'));

      const automatic = await stateStore.claimReview({
        deliveryId: 'delivery-same-sha-automatic',
        job,
        occurredAt: '2026-09-01T01:31:00.000Z',
      });
      expect(automatic.kind).not.toBe('claimed');
      const expired = await stateStore.getRunOutcome(old.runId);
      expect(expired?.status).toBe('failed');
      expect(expired?.cleanup).toBe('pending');

      const manual = await stateStore.claimReview({
        deliveryId: 'delivery-same-sha-manual',
        job: { ...job, trigger: 'manual' },
        occurredAt: '2026-09-01T01:31:00.000Z',
      });
      expect(manual.kind).toBe('claimed');
      if (manual.kind !== 'claimed') throw new Error('manual retry was not scheduled');

      const rerun = await worker.fetch(runnerClaimRequest());
      expect(rerun.status).toBe(200);
      expect(await rerun.json()).toMatchObject({ headSha: eligibleEvent.headSha });
      expect((await stateStore.getRunOutcome(manual.runId))?.status).toBe('scheduled');
    } finally {
      database.close();
      vi.useRealTimers();
    }
  });

  it('derives the deadline from the durable claim time and passes the read-token expiry', async () => {
    const database = new SqliteD1Database();
    const worker = createCoreWorker(coreEnv(database), {
      github: claimGithub(),
      getReadInstallationToken: async () => ({
        token: 'repository-read-token',
        expiresAt: '2026-09-01T01:20:00.000Z',
      }),
    });
    vi.useFakeTimers({ toFake: ['Date'] });

    try {
      vi.setSystemTime(new Date('2026-09-01T00:00:00.000Z'));
      expect(
        (
          await worker.fetch(
            new Request('https://core.internal/review-events', {
              method: 'POST',
              body: JSON.stringify({
                ...eligibleEvent,
                deliveryId: 'delivery-claim-deadline',
              }),
            }),
          )
        ).status,
      ).toBe(202);

      vi.setSystemTime(new Date('2026-09-01T00:05:00.000Z'));
      const claim = await worker.fetch(
        new Request('https://core.internal/runner-claims', {
          method: 'POST',
          headers: { 'x-compte-rendu-runner-claim': 'verified' },
        }),
      );

      expect(claim.status).toBe(200);
      expect(await claim.json()).toMatchObject({
        claimDeadlineAt: Date.parse('2026-09-01T01:35:00.000Z'),
        repositoryReadTokenExpiresAt: Date.parse('2026-09-01T01:20:00.000Z'),
        repositoryReadToken: 'repository-read-token',
      });
    } finally {
      vi.useRealTimers();
      database.close();
    }
  });

  it('fails a claim closed when the read-token expiry is invalid', async () => {
    const database = new SqliteD1Database();
    const worker = createCoreWorker(coreEnv(database), {
      github: claimGithub(),
      getReadInstallationToken: async () => ({
        token: 'repository-read-token',
        expiresAt: 'not-a-date',
      }),
    });

    try {
      await worker.fetch(
        new Request('https://core.internal/review-events', {
          method: 'POST',
          body: JSON.stringify({
            ...eligibleEvent,
            deliveryId: 'delivery-invalid-read-token-expiry',
          }),
        }),
      );

      const claim = await worker.fetch(
        new Request('https://core.internal/runner-claims', {
          method: 'POST',
          headers: { 'x-compte-rendu-runner-claim': 'verified' },
        }),
      );

      expect(claim.status).toBe(503);
      await expect(
        database
          .prepare(
            `SELECT status, failure_phase, failure_reason FROM review_runs WHERE delivery_id = ?`,
          )
          .bind('delivery-invalid-read-token-expiry')
          .first(),
      ).resolves.toEqual({
        status: 'failed',
        failure_phase: 'scheduling',
        failure_reason: 'configuration',
      });
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
        github: claimGithub(),
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

  it.each([
    { markdown: '## Review:\nChange the boundary check.' },
    { markdown: 'TLDR: Request changes — the boundary excludes 100.' },
    { markdown: 'Request changes: the boundary excludes 100.' },
  ])(
    'publishes the validated structured vote from the authenticated callback ($markdown)',
    async ({ markdown }) => {
      const database = new SqliteD1Database();
      const store = createD1ReviewStateStore(database);
      const claim = await store.claimReview({
        deliveryId: 'structured-vote',
        job: {
          repositoryId: 11,
          installationId: 7,
          pullRequestNumber: 42,
          baseSha: eligibleEvent.baseSha,
          headSha: eligibleEvent.headSha,
          trigger: 'automatic',
        },
        occurredAt: '2026-09-01T00:00:00.000Z',
      });
      if (claim.kind !== 'claimed') throw new Error('not claimed');
      await claimRunnerJob(store, { runId: claim.runId, jobId: 'runner-job-1' });
      const reviews: unknown[] = [];
      const worker = createCoreWorker(
        { ...coreEnv(database), EVIDENCE_BUCKET: { put: async () => undefined } },
        {
          github: {
            loadReviewTarget: async () => ({ headSha: eligibleEvent.headSha }),
            createReview: async ({ payload }) => {
              reviews.push(payload);
              return { kind: 'created', review: payload };
            },
          },
        },
      );
      const callback = JSON.parse(await successfulCallback(claim.runId));
      callback.result = { version: 2, decision: 'request_changes', markdown };
      const response = await worker.fetch(
        new Request('https://core.internal/runner-results', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-compte-rendu-runner-callback': 'verified',
          },
          body: JSON.stringify(callback),
        }),
      );
      expect(response.status).toBe(202);
      expect(reviews).toEqual([
        expect.objectContaining({
          event: 'REQUEST_CHANGES',
          commit_id: eligibleEvent.headSha,
          body: expect.stringContaining(markdown),
        }),
      ]);
      expect(await createD1ReviewStateStore(database).getRunOutcome(claim.runId)).toMatchObject({
        status: 'completed',
        decision: 'request_changes',
      });
    },
  );

  it.each(['failed', 'superseded', 'publication-failed'] as const)(
    'does not expose an unpublished decision after %s',
    async (scenario) => {
      const database = new SqliteD1Database();
      const store = createD1ReviewStateStore(database);
      const claim = await store.claimReview({
        deliveryId: 'structured-vote',
        job: {
          repositoryId: 11,
          installationId: 7,
          pullRequestNumber: 42,
          baseSha: eligibleEvent.baseSha,
          headSha: eligibleEvent.headSha,
          trigger: 'automatic',
        },
        occurredAt: '2026-09-01T00:00:00.000Z',
      });
      if (claim.kind !== 'claimed') throw new Error('not claimed');
      await claimRunnerJob(store, { runId: claim.runId, jobId: 'runner-job-1' });
      if (scenario === 'failed')
        await store.markSchedulingFailed({
          runId: claim.runId,
          occurredAt: '2026-09-01T00:01:00.000Z',
        });
      if (scenario === 'superseded')
        await store.markRunSuperseded({
          runId: claim.runId,
          occurredAt: '2026-09-01T00:01:00.000Z',
        });
      const reviews: unknown[] = [];
      const worker = createCoreWorker(
        { ...coreEnv(database), EVIDENCE_BUCKET: { put: async () => undefined } },
        {
          github: {
            findReviewByMarker: async () => {
              throw new Error('GitHub lookup unavailable');
            },
            loadReviewTarget: async () => ({ headSha: eligibleEvent.headSha }),
            createReview: async ({ payload }) => {
              reviews.push(payload);
              return { kind: 'created', review: payload };
            },
          },
        },
      );
      const callback = JSON.parse(await successfulCallback(claim.runId));
      callback.result = { ...callback.result, decision: 'request_changes' };
      const response = await worker.fetch(
        new Request('https://core.internal/runner-results', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-compte-rendu-runner-callback': 'verified',
          },
          body: JSON.stringify(callback),
        }),
      );
      expect(response.status).toBe(scenario === 'publication-failed' ? 503 : 202);
      expect(reviews).toEqual([]);
      const fresh = createCoreWorker(coreEnv(database));
      const detail = await fresh.fetch(
        new Request(`https://core.internal/api/jobs/${claim.runId}`),
      );
      expect(await detail.json()).toMatchObject({
        task: {
          status: scenario === 'superseded' ? 'superseded' : 'failed',
          decision: null,
        },
      });
      database.close();
    },
  );

  it.each([false, true])(
    'publishes without inline evidence even when optional usage persistence fails (%s)',
    async (usageWriteFails) => {
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
      await claimRunnerJob(stateStore, { runId: claimed.runId, jobId: 'runner-job-1' });
      await stateStore.recordCheckRun({ runId: claimed.runId, checkRunId: 321 });

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
          stateStore: usageWriteFails
            ? {
                ...stateStore,
                recordModelUsage: async () => {
                  throw new Error('usage-write-secret-canary');
                },
              }
            : stateStore,
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
          version: 2,
          id: 'runner-job-1',
          runId: claimed.runId,
          attempt: 1,
          baseSha: eligibleEvent.baseSha,
          headSha: eligibleEvent.headSha,
          status: 'succeeded',
          usage: { version: 1, models: [] },
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
        expect(stored.map((entry) => entry.key)).toEqual([
          `reviews/${claimed.runId}/publications/runner-job-1/1.json`,
        ]);
        expect(reviews).toEqual([
          {
            event: 'COMMENT',
            commit_id: eligibleEvent.headSha,
            body: `<!-- compte-rendu:run:${claimed.runId} -->\n## Review:\n\nNo defects found.\n`,
          },
        ]);
        expect(checkUpdates).toEqual([
          {
            runId: claimed.runId,
            repositoryId: 11,
            installationId: 7,
            checkRunId: 321,
            status: 'success',
            decision: 'comment',
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
          cleanup: 'destroyed',
          resultReceivedAt: expect.any(String),
        });
      } finally {
        database.close();
      }
    },
  );

  it.each([
    [true, false],
    [false, false],
    [true, true],
    [false, true],
  ] as const)(
    'settles an interrupted publication after restart (verified marker exists: %s, scheduled recovery: %s)',
    async (published, scheduled) => {
      let markerAvailable = !scheduled;
      const archive = new Map<string, string>();
      const database = new SqliteD1Database();
      const stateStore = createD1ReviewStateStore(database);
      const claimed = await stateStore.claimReview({
        deliveryId: 'delivery-retained-callback',
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
      if (claimed.kind !== 'claimed') throw new Error('recovery run was not claimed');
      await claimRunnerJob(stateStore, { runId: claimed.runId, jobId: 'runner-job-1' });
      // The Worker stopped after claiming publication. GitHub may have accepted the POST.
      await stateStore.claimRunPublication({
        runId: claimed.runId,
        occurredAt: '2026-09-01T00:00:04.000Z',
        publishing: true,
      });
      const newPublications: unknown[] = [];
      const markerLookups: unknown[] = [];
      const { fetcher, requests } = capturePostHogTransport();
      const diagnostics: unknown[] = [];
      const worker = createCoreWorker(
        {
          ...coreEnv(database),
          ...postHogTestDefaults.environment,
          EVIDENCE_BUCKET: {
            put: async (key, data) => {
              if (typeof data === 'string') archive.set(key, data);
            },
            get: async (key) => {
              const value = archive.get(key);
              if (!value) return null;
              const bytes = new TextEncoder().encode(value);
              return { size: bytes.byteLength, arrayBuffer: async () => bytes.buffer };
            },
          },
        },
        {
          log: {
            record: (event) => {
              diagnostics.push(event);
            },
          },
          github: {
            loadReviewTarget: async () => ({ headSha: eligibleEvent.headSha }),
            findReviewByMarker: async (input) => {
              if (!markerAvailable) throw new Error('unavailable');
              markerLookups.push(input);
              return published ? { id: 99 } : undefined;
            },
            createReview: async (input) => {
              newPublications.push(input);
              return { kind: 'created', review: input };
            },
          },
        },
      );
      const callback = JSON.parse(await successfulCallback(claimed.runId));
      callback.result = { ...callback.result, decision: 'request_changes' };
      const request = () =>
        new Request('https://core.internal/runner-results', {
          method: 'POST',
          headers: {
            'x-compte-rendu-runner-callback': 'verified',
            'content-type': 'application/json',
          },
          body: JSON.stringify(callback),
        });
      try {
        if (scheduled) {
          expect((await worker.fetch(request())).status).toBe(503);
          expect((await stateStore.getRunOutcome(claimed.runId))?.status).toBe('scheduled');
          const now = Date.now();
          await expect(worker.reconcilePublications(now)).rejects.toThrow();
          expect((await stateStore.getRunOutcome(claimed.runId))?.status).toBe('scheduled');
          expect(diagnostics).toContainEqual({
            phase: 'publication',
            outcome: 'reconciliation_incomplete',
            runId: claimed.runId,
            reason: 'publication',
          });
          markerAvailable = true;
          await worker.reconcilePublications(now + 60_000);
          expect(await postHogEvents(requests)).toContainEqual(
            expect.objectContaining({
              event: 'review finished',
              distinct_id: claimed.runId,
              properties: expect.objectContaining({ outcome: published ? 'completed' : 'failed' }),
            }),
          );
          expect((await stateStore.getRunOutcome(claimed.runId))?.status).toBe(
            published ? 'completed' : 'failed',
          );
        } else {
          expect((await worker.fetch(request())).status).toBe(published ? 202 : 503);
        }
        expect((await worker.fetch(request())).status).toBe(202);
        if (scheduled) {
          const finished = (await postHogEvents(requests)).filter(
            (event) =>
              typeof event === 'object' &&
              event !== null &&
              'event' in event &&
              event.event === 'review finished',
          );
          expect(finished).toHaveLength(1);
        }
        expect(newPublications).toEqual([]);
        expect(markerLookups).toContainEqual({
          repositoryId: 11,
          pullRequestNumber: 42,
          installationId: 7,
          marker: `<!-- compte-rendu:run:${claimed.runId} -->`,
          expected: { headSha: eligibleEvent.headSha, event: 'REQUEST_CHANGES' },
        });
        await expect(stateStore.getRunOutcome(claimed.runId)).resolves.toMatchObject({
          status: published ? 'completed' : 'failed',
          ...(published && { decision: 'request_changes' }),
        });
      } finally {
        fetcher.mockRestore();
        database.close();
      }
    },
  );
});
