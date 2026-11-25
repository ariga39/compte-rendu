import { expect, it, vi } from 'vitest';
import { createCoreWorker } from './support/core-worker-runtime';
import { createD1ReviewStateStore } from '../apps/core/src/review-state-store';
import { REVIEW_ATTEMPT_BUDGET_MS, type OperationalLogEvent } from '../packages/contracts/src';
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
    await state.recordCheckRun({ runId, checkRunId: 42 });
    await state.claimNextJob({ jobId: 'job-one', attempt: 1, occurredAt: now.toISOString() });
    const stops: Request[] = [];
    const updateCheckRun = vi.fn(async () => {});
    const events: OperationalLogEvent[] = [];
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
      {
        stateStore: state,
        log: { record: (event) => void events.push(event) },
        github: { updateCheckRun },
      },
    );
    const first = await core.cancelReview(runId, 123);
    expect(first.status).toBe(202);
    expect(updateCheckRun).toHaveBeenCalledWith(
      expect.objectContaining({
        checkRunId: 42,
        status: 'cancelled',
        cancellationReason: 'manual',
      }),
    );
    await core.reconcileCancellations(Date.now());
    expect(stops[0]?.headers.get('x-compte-rendu-claim-deadline')).toBe(
      String(+now + REVIEW_ATTEMPT_BUDGET_MS),
    );
    expect(updateCheckRun).toHaveBeenCalledTimes(1);
    expect((await core.cancelReview(runId, 123)).status).toBe(202);
    await core.reconcileCancellations(Date.now() + 61_000);
    expect((await core.cancelReview(runId, 123)).status).toBe(200);
    expect(events).toEqual([]);
    expect(await state.getRunOutcome(runId)).toMatchObject({
      runnerJobId: 'job-one',
      status: 'cancelled',
    });
  } finally {
    database.close();
  }
});

it('records one cancellation lifecycle event for a queued run', async () => {
  const database = new SqliteD1Database();
  const captures: Request[] = [];
  const tasks: Promise<unknown>[] = [];
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    captures.push(new Request(input, init));
    return new Response('{}', { status: 200 });
  });
  try {
    const state = createD1ReviewStateStore(database);
    const queued = await state.claimReview({
      deliveryId: 'queued-cancellation-lifecycle',
      occurredAt: '2026-09-01T00:00:00.000Z',
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
    const env = {
      REVIEW_DB: database,
      GITHUB_APP_ID: '1',
      GITHUB_APP_PRIVATE_KEY: 'test',
      POSTHOG_ENABLED: 'true',
      POSTHOG_PROJECT_API_KEY: 'phc_test_project_key',
      POSTHOG_HOST: 'https://posthog.example.test',
      POSTHOG_DEPLOYMENT: 'test',
      POSTHOG_ENVIRONMENT: 'staging',
    };
    const core = createCoreWorker(env, { stateStore: state });
    const context = { waitUntil: (task: Promise<unknown>) => tasks.push(task) };

    expect((await core.cancelReview(queued.runId, 123, context)).status).toBe(200);
    await Promise.all(tasks.splice(0));
    const events = (
      await Promise.all(
        captures.map(async (request) => {
          const body = (await request.json()) as { batch: readonly unknown[] };
          return body.batch;
        }),
      )
    ).flat();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'review finished',
      properties: {
        outcome: 'cancelled',
        published: false,
        cleanup_status: 'unknown',
        evidence_status: 'unknown',
      },
    });
    expect(events[0]).not.toHaveProperty('properties.requestedByUid');
    expect((await core.cancelReview(queued.runId, 123, context)).status).toBe(200);
    await Promise.all(tasks.splice(0));
    expect(captures).toHaveLength(1);
  } finally {
    fetcher.mockRestore();
    database.close();
  }
});

it('ends the Check immediately and directly repairs a stale in-progress write after cancellation', async () => {
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
    await state.recordCheckRun({ runId, checkRunId: 777 });

    const started = deferred<void>();
    const release = deferred<void>();
    const statuses: string[] = [];
    const updateCheckRun = async ({ status }: { status: string }) => {
      if (status === 'in_progress') {
        started.resolve();
        await release.promise;
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
        loadReviewTarget: async () => ({ headSha: '2'.repeat(40) }),
      },
      getReadInstallationToken: async () => ({
        token: 'test-read',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    });

    const claim = core.claimRunnerJob(
      new Request('https://reviews.test/runner-claim', {
        method: 'POST',
      }),
    );
    await started.promise;
    expect((await core.cancelReview(runId, 123)).status).toBe(202);
    expect(statuses).toEqual(['cancelled']);

    release.resolve();
    expect((await claim).status).toBe(204);
    expect((await core.cancelReview(runId, 123)).status).toBe(200);
    expect(await state.getRunOutcome(runId)).toMatchObject({
      status: 'cancelled',
      runnerJobId: expect.any(String),
    });
    expect(statuses.at(-1)).toBe('cancelled');
    await expect(state.listCancellationWork(cancellationWindow())).resolves.toEqual([]);
  } finally {
    database.close();
  }
});

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
      github: {
        getRepositoryUrl: async () => 'https://github.com/example/repo.git',
        loadReviewTarget: async () => ({ headSha: '2'.repeat(40) }),
      },
      getReadInstallationToken: async () => {
        await state.cancelRun({
          runId: queued.runId,
          requestedByUid: 123,
          occurredAt: new Date().toISOString(),
        });
        return { token: 'test-read', expiresAt: new Date(Date.now() + 3600000).toISOString() };
      },
    });
    const response = await core.claimRunnerJob(
      new Request('https://reviews.test/runner-claim', {
        method: 'POST',
      }),
    );
    expect(response.status).toBe(204);
    expect((await core.cancelReview(queued.runId, 123)).status).toBe(200);
    const history = await core.listPublicJobs(new URLSearchParams('status=cancelled'));
    expect(history.status).toBe(200);
    expect(await history.json()).toMatchObject({
      tasks: [{ runId: queued.runId, status: 'cancelled', identity: { kind: 'anonymous' } }],
    });
  } finally {
    database.close();
  }
});

it('keeps cancellation terminal when the immediate Check update fails', async () => {
  const database = new SqliteD1Database();
  try {
    const state = createD1ReviewStateStore(database);
    const now = new Date();
    const queued = await state.claimReview({
      deliveryId: 'cancellation-check-failure',
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
    await state.recordCheckRun({ runId, checkRunId: 42 });
    await state.claimNextJob({ jobId: 'job-one', attempt: 1, occurredAt: now.toISOString() });
    const events: OperationalLogEvent[] = [];
    const core = createCoreWorker(
      {
        REVIEW_DB: database,
        GITHUB_APP_ID: '1',
        GITHUB_APP_PRIVATE_KEY: 'test',
        RUNNER_AUTH_TOKEN: 'test',
        RUNNER: { fetch: async () => new Response(null, { status: 404 }) },
      },
      {
        stateStore: state,
        log: { record: (event) => void events.push(event) },
        github: {
          updateCheckRun: async () => {
            throw new Error('github credential ghp_check_secret');
          },
        },
      },
    );

    expect((await core.cancelReview(runId, 123)).status).toBe(202);
    expect(await state.getRunOutcome(runId)).toMatchObject({ status: 'cancelled' });
    expect(events).toEqual([
      {
        phase: 'cancellation',
        outcome: 'delivery_failed',
        runId,
        kind: 'check-cancel',
      },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/ghp_|secret/);
  } finally {
    database.close();
  }
});

it.each(['lease', 'delivery'] as const)(
  'identifies a Runner-stop cancellation failure at the %s boundary without exposing credentials',
  async (boundary) => {
    const database = new SqliteD1Database();
    try {
      const state = createD1ReviewStateStore(database);
      const now = new Date();
      const queued = await state.claimReview({
        deliveryId: 'cancellation-delivery-failure',
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
      await state.recordCheckRun({ runId, checkRunId: 42 });
      await state.claimNextJob({ jobId: 'job-one', attempt: 1, occurredAt: now.toISOString() });
      const failLease = async () => {
        throw new Error('state credential ghp_state_secret');
      };
      const events: OperationalLogEvent[] = [];
      const core = createCoreWorker(
        {
          REVIEW_DB: database,
          GITHUB_APP_ID: '1',
          GITHUB_APP_PRIVATE_KEY: 'test',
          RUNNER_AUTH_TOKEN: 'test',
          RUNNER: {
            fetch: async () => {
              return new Response('runner credential ghp_runner_secret', { status: 503 });
            },
          },
        },
        {
          stateStore:
            boundary === 'delivery' ? state : { ...state, recordRunnerStopAttempt: failLease },
          log: { record: (event) => void events.push(event) },
          github: { updateCheckRun: async () => {} },
        },
      );
      expect((await core.cancelReview(runId, 123)).status).toBe(202);
      await expect(core.reconcileCancellations(Date.now())).rejects.toThrow(
        'Review cancellation delivery failed',
      );
      expect(events).toEqual([
        {
          phase: 'cancellation',
          outcome: 'delivery_failed',
          runId,
          kind: 'runner-stop',
        },
      ]);
      expect(JSON.stringify(events)).not.toMatch(/ghp_|secret/);
      await expect(state.listCancellationWork(cancellationWindow())).resolves.toMatchObject([
        { runId, needsRunnerStop: true },
      ]);
      expect((await core.cancelReview(runId, 123)).status).toBe(202);
    } finally {
      database.close();
    }
  },
);
