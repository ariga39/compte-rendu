import { expect, it, vi } from 'vitest';
import { createCoreWorker } from '../apps/core/src/core-worker';
import { createD1ReviewStateStore } from '../apps/core/src/review-state-store';
import { REVIEW_ATTEMPT_BUDGET_MS } from '../packages/contracts/src';
import { SqliteD1Database } from './support/d1-database';

const deferred = <A>() => {
  let resolve!: (value: A | PromiseLike<A>) => void;
  const promise = new Promise<A>((next) => {
    resolve = next;
  });
  return { promise, resolve };
};

const cancellationWindow = () => {
  const now = Date.now();
  return {
    retryBefore: new Date(now + 61_000).toISOString(),
    recoveryBefore: new Date(now - REVIEW_ATTEMPT_BUDGET_MS - 61_000).toISOString(),
    limit: 10,
  };
};

it('retries an unconfirmed operator stop, ends the Check, and acknowledges verified destruction', async () => {
  const database = new SqliteD1Database();
  try {
    const state = createD1ReviewStateStore(database);
    const now = new Date();
    const queued = await state.claimReview({
      deliveryId: 'operator-stop',
      occurredAt: now.toISOString(),
      job: {
        repositoryId: 1,
        installationId: 2,
        pullRequestNumber: 3,
        baseSha: '1'.repeat(40),
        headSha: '2'.repeat(40),
        trigger: 'automatic',
      },
    });
    if (queued.kind !== 'claimed') throw new Error('expected queued run');
    const { runId } = queued;
    await state.recordCheckRun!({ runId, checkRunId: 42 });
    await state.claimNextJob!({ jobId: 'job-one', attempt: 1, occurredAt: now.toISOString() });
    const stops: Request[] = [];
    const updateCheckRun = vi.fn(async () => {});
    const core = createCoreWorker(
      {
        REVIEW_DB: database,
        GITHUB_APP_ID: '1',
        GITHUB_APP_PRIVATE_KEY: 'test',
        RUNNER_AUTH_TOKEN: 'test',
        RUNNER: {
          fetch: async (request) => {
            stops.push(request);
            return stops.length === 1
              ? new Response(null, { status: 404 })
              : Response.json({
                  id: 'job-one',
                  runId,
                  attempt: 1,
                  stage: 'cleanup',
                  status: 'aborted',
                  evidence: { id: 'evidence', status: 'incomplete' },
                  sandbox: { cleanup: 'destroyed' },
                });
          },
        },
      },
      { stateStore: state, github: { updateCheckRun } },
    );
    const first = await core.cancelReview(runId, 123);
    expect(first.status).toBe(202);
    await core.reconcileCancellations(Date.now());
    expect(stops[0]?.headers.get('x-compte-rendu-claim-deadline')).toBe(
      String(+now + REVIEW_ATTEMPT_BUDGET_MS),
    );
    expect(updateCheckRun).toHaveBeenCalledWith(
      expect.objectContaining({
        checkRunId: 42,
        status: 'cancelled',
        cancellationReason: 'manual',
      }),
    );
    expect((await core.cancelReview(runId, 123)).status).toBe(202);
    await core.reconcileCancellations(Date.now() + 61_000);
    expect((await core.cancelReview(runId, 123)).status).toBe(200);
    expect(await state.getRunOutcome(runId)).toMatchObject({
      runnerJobId: 'job-one',
      status: 'cancelled',
    });
  } finally {
    database.close();
  }
});

it.each([false, true])(
  'reopens Check reconciliation when a claim writes in_progress after cancellation (repair failure: %s)',
  async (repairFails) => {
    const database = new SqliteD1Database();
    try {
      const state = createD1ReviewStateStore(database);
      const queued = await state.claimReview({
        deliveryId: 'late-check-write',
        occurredAt: new Date().toISOString(),
        job: {
          repositoryId: 1,
          installationId: 2,
          pullRequestNumber: 3,
          baseSha: '1'.repeat(40),
          headSha: '2'.repeat(40),
          trigger: 'manual',
          commentId: 99,
        },
      });
      if (queued.kind !== 'claimed') throw new Error('expected queued run');
      const { runId } = queued;
      await state.recordCheckRun!({ runId, checkRunId: 777 });

      const started = deferred<void>();
      const release = deferred<void>();
      const statuses: string[] = [];
      let failNextCancelled = false;
      const updateCheckRun = async ({ status }: { status: string }) => {
        if (status === 'in_progress') {
          started.resolve();
          await release.promise;
        } else if (status === 'cancelled' && failNextCancelled) {
          failNextCancelled = false;
          throw new Error('GitHub Check update failed');
        }
        statuses.push(status);
      };
      const env = {
        REVIEW_DB: database,
        GITHUB_APP_ID: '1',
        GITHUB_APP_PRIVATE_KEY: 'test',
        RUNNER_AUTH_TOKEN: 'test',
        RUNNER: { fetch: async () => new Response(null, { status: 404 }) },
      };
      const core = createCoreWorker(env, {
        stateStore: state,
        github: {
          updateCheckRun,
          getRepositoryUrl: async () => 'https://github.com/example/repo.git',
        },
        getReadInstallationToken: async () => ({
          token: 'test-read',
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        }),
      });

      const claim = core.fetch(
        new Request('https://core.internal/runner-claims', {
          method: 'POST',
          headers: { 'x-compte-rendu-runner-claim': 'verified' },
        }),
        env,
      );
      await started.promise;
      expect((await core.cancelReview(runId, 123)).status).toBe(202);
      await core.reconcileCancellations(Date.now());
      expect(statuses).toEqual(['cancelled']);

      if (repairFails) failNextCancelled = true;
      release.resolve();
      expect((await claim).status).toBe(204);
      expect((await core.cancelReview(runId, 123)).status).toBe(200);
      expect(await state.getRunOutcome(runId)).toMatchObject({
        status: 'cancelled',
        runnerJobId: expect.any(String),
      });

      if (repairFails) {
        expect(statuses.at(-1)).toBe('in_progress');
        await expect(state.listCancellationWork!(cancellationWindow())).resolves.toMatchObject([
          { runId, needsCheckReconciliation: true },
        ]);
        await core.reconcileCancellations(Date.now() + 61_000);
        expect(statuses.at(-1)).toBe('cancelled');
        await expect(state.listCancellationWork!(cancellationWindow())).resolves.toEqual([]);
      } else {
        expect(statuses.at(-1)).toBe('cancelled');
        await expect(state.listCancellationWork!(cancellationWindow())).resolves.toEqual([]);
      }
    } finally {
      database.close();
    }
  },
);

it('releases a cancelled claim when token preparation finishes before Runner receives it', async () => {
  const database = new SqliteD1Database();
  try {
    const state = createD1ReviewStateStore(database);
    const queued = await state.claimReview({
      deliveryId: 'cancel-during-token',
      occurredAt: new Date().toISOString(),
      job: {
        repositoryId: 1,
        installationId: 2,
        pullRequestNumber: 3,
        baseSha: '1'.repeat(40),
        headSha: '2'.repeat(40),
        trigger: 'automatic',
      },
    });
    if (queued.kind !== 'claimed') throw new Error('expected queued run');
    const env = { REVIEW_DB: database, GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: 'test' };
    const core = createCoreWorker(env, {
      stateStore: state,
      github: { getRepositoryUrl: async () => 'https://github.com/example/repo.git' },
      getReadInstallationToken: async () => {
        await state.cancelRun({
          runId: queued.runId,
          requestedByUid: 123,
          occurredAt: new Date().toISOString(),
        });
        return { token: 'test-read', expiresAt: new Date(Date.now() + 3600000).toISOString() };
      },
    });
    const response = await core.fetch(
      new Request('https://core.internal/runner-claims', {
        method: 'POST',
        headers: { 'x-compte-rendu-runner-claim': 'verified' },
      }),
      env,
    );
    expect(response.status).toBe(204);
    expect((await core.cancelReview(queued.runId, 123)).status).toBe(200);
    const history = await core.fetch(
      new Request('https://core.internal/api/jobs?status=cancelled'),
      env,
    );
    expect(history.status).toBe(200);
    expect(await history.json()).toMatchObject({
      tasks: [{ runId: queued.runId, status: 'cancelled', identity: { kind: 'anonymous' } }],
    });
  } finally {
    database.close();
  }
});
