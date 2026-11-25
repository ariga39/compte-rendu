import { describe, expect, it } from 'vitest';
import type { CoreWorkerDependencies } from '../apps/core/src/core-worker';
import { createCoreWorker } from '../apps/core/src/core-worker';
import {
  createD1ReviewStateStore,
  type ReviewJob,
  type ReviewPublicationStateStore,
} from '../apps/core/src/index';
import { SqliteD1Database } from './support/d1-database';
import { scheduleReviewEvent } from './support/core-worker-harness';
import {
  eligibleEvent,
  coreEnv,
  deferred,
  abortedCallback,
  claimGithub,
  recordTestEvidence,
} from './support/core-worker-harness';

describe('Runner claim serialization', () => {
  const oldHead = '2222222222222222222222222222222222222222';
  const newHead = '3333333333333333333333333333333333333333';
  const claimJob = (pullRequestNumber: number, headSha: string): ReviewJob => ({
    repositoryId: 11,
    pullRequestNumber,
    installationId: 7,
    baseSha: '1111111111111111111111111111111111111111',
    headSha,
    trigger: 'automatic',
  });

  const exerciseSamePullRequestExclusion = async (store: ReviewPublicationStateStore) => {
    const initial = await store.claimReview({
      deliveryId: 'delivery-serial-old',
      job: claimJob(42, oldHead),
      occurredAt: '2026-09-01T00:00:00.000Z',
    });
    if (initial.kind !== 'claimed') throw new Error('initial run was not admitted');
    expect(
      await store.claimNextJob({
        jobId: 'job-old',
        attempt: 1,
        occurredAt: '2026-09-01T00:00:01.000Z',
      }),
    ).toMatchObject({ kind: 'claimed', job: { pullRequestNumber: 42 } });

    const replacement = await store.claimReview({
      deliveryId: 'delivery-serial-new',
      job: claimJob(42, newHead),
      occurredAt: '2026-09-01T00:00:02.000Z',
    });
    if (replacement.kind !== 'claimed') throw new Error('replacement run was not admitted');

    expect(
      await store.claimNextJob({
        jobId: 'job-replacement',
        attempt: 1,
        occurredAt: '2026-09-01T00:00:03.000Z',
      }),
    ).toEqual({ kind: 'empty' });

    const unrelated = await store.claimReview({
      deliveryId: 'delivery-serial-unrelated',
      job: claimJob(43, oldHead),
      occurredAt: '2026-09-01T00:00:04.000Z',
    });
    if (unrelated.kind !== 'claimed') throw new Error('unrelated run was not admitted');
    expect(
      await store.claimNextJob({
        jobId: 'job-unrelated',
        attempt: 1,
        occurredAt: '2026-09-01T00:00:05.000Z',
      }),
    ).toMatchObject({ kind: 'claimed', job: { pullRequestNumber: 43 } });

    await store.markRunSuperseded({
      runId: initial.runId,
      occurredAt: '2026-09-01T00:00:06.000Z',
    });
    await store.clearRunnerJob({ runId: initial.runId, jobId: 'job-old' });
    expect(
      await store.claimNextJob({
        jobId: 'job-replacement',
        attempt: 1,
        occurredAt: '2026-09-01T00:00:07.000Z',
      }),
    ).toMatchObject({ kind: 'claimed', job: { pullRequestNumber: 42, headSha: newHead } });
  };

  it('serializes same-pull-request claims until destruction while unrelated runs progress', async () => {
    const database = new SqliteD1Database();
    try {
      await exerciseSamePullRequestExclusion(createD1ReviewStateStore(database));
    } finally {
      database.close();
    }
  });

  const evidenceFor = (runId: string) => ({
    key: `reviews/${runId}`,
    status: 'incomplete' as const,
    size: 1,
    sha256: 'a'.repeat(64),
    uploadedAt: '2026-09-01T00:00:08.000Z',
  });

  const exerciseFailedCleanupExclusion = async (
    store: ReviewPublicationStateStore,
    fresh: ReviewPublicationStateStore,
  ) => {
    const failed = await store.claimReview({
      deliveryId: 'delivery-failed-cleanup',
      job: claimJob(42, oldHead),
      occurredAt: '2026-09-01T00:00:00.000Z',
    });
    if (failed.kind !== 'claimed') throw new Error('failed-cleanup run was not admitted');
    await store.claimNextJob({
      jobId: 'job-failed-cleanup',
      attempt: 1,
      occurredAt: '2026-09-01T00:00:01.000Z',
    });
    await recordTestEvidence(store, {
      runId: failed.runId,
      evidence: evidenceFor(failed.runId),
      sandboxCleanup: 'failed',
    });
    await store.markSchedulingFailed({
      runId: failed.runId,
      occurredAt: '2026-09-01T00:00:02.000Z',
    });

    const replacement = await store.claimReview({
      deliveryId: 'delivery-failed-cleanup-replacement',
      job: claimJob(42, newHead),
      occurredAt: '2026-09-01T00:00:03.000Z',
    });
    if (replacement.kind !== 'claimed') throw new Error('replacement was not admitted');
    const unrelated = await store.claimReview({
      deliveryId: 'delivery-failed-cleanup-unrelated',
      job: claimJob(43, oldHead),
      occurredAt: '2026-09-01T00:00:04.000Z',
    });
    if (unrelated.kind !== 'claimed') throw new Error('unrelated was not admitted');

    expect(
      await store.claimNextJob({
        jobId: 'job-unrelated',
        attempt: 1,
        occurredAt: '2026-09-01T00:00:05.000Z',
      }),
    ).toMatchObject({ kind: 'claimed', job: { pullRequestNumber: 43 } });
    expect(
      await store.claimNextJob({
        jobId: 'job-replacement',
        attempt: 1,
        occurredAt: '2026-09-01T00:00:06.000Z',
      }),
    ).toEqual({ kind: 'empty' });

    await recordTestEvidence(fresh, {
      runId: failed.runId,
      evidence: evidenceFor(failed.runId),
      sandboxCleanup: 'destroyed',
    });
    expect(
      await fresh.claimNextJob({
        jobId: 'job-replacement',
        attempt: 1,
        occurredAt: '2026-09-01T00:00:07.000Z',
      }),
    ).toMatchObject({ kind: 'claimed', job: { pullRequestNumber: 42, headSha: newHead } });
  };

  it('keeps a same-pull-request replacement blocked by a failed cleanup until a destroyed confirmation', async () => {
    const database = new SqliteD1Database();
    try {
      await exerciseFailedCleanupExclusion(
        createD1ReviewStateStore(database),
        createD1ReviewStateStore(database),
      );
    } finally {
      database.close();
    }
  });

  const claimRequest = () =>
    new Request('https://reviews.test/runner-claim', {
      method: 'POST',
    });
  const scheduleReview = (
    env: ReturnType<typeof coreEnv>,
    dependencies: Parameters<typeof scheduleReviewEvent>[1],
    headSha: string,
    deliveryId: string,
  ) => scheduleReviewEvent(env, dependencies, { ...eligibleEvent, headSha, deliveryId });

  it('releases an unhanded superseded same-pull-request claim so the replacement becomes claimable', async () => {
    const database = new SqliteD1Database();
    const tokenMint = deferred<{ token: string; expiresAt: string }>();
    let tokenCalls = 0;
    let currentHead = oldHead;
    const env = {
      ...coreEnv(database),
      RUNNER: { fetch: async () => new Response(null, { status: 503 }) },
    };
    const dependencies: CoreWorkerDependencies = {
      github: claimGithub(() => currentHead),
      getReadInstallationToken: async () => {
        tokenCalls += 1;
        return tokenMint.promise;
      },
    };
    const worker = createCoreWorker(env, dependencies);

    try {
      expect(await scheduleReview(env, dependencies, oldHead, 'delivery-unhanded-old')).toBe(
        'accepted',
      );
      const oldClaim = worker.claimRunnerJob(claimRequest());
      for (let attempt = 0; attempt < 50 && tokenCalls === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      expect(tokenCalls).toBe(1);

      currentHead = newHead;
      expect(await scheduleReview(env, dependencies, newHead, 'delivery-unhanded-new')).toBe(
        'accepted',
      );
      tokenMint.resolve({
        token: 'repository-read-token',
        expiresAt: '2026-09-01T01:00:00.000Z',
      });

      expect((await oldClaim).status).toBe(204);

      const replacementClaim = await worker.claimRunnerJob(claimRequest());
      expect(replacementClaim.status).toBe(200);
      expect(await replacementClaim.json()).toMatchObject({
        pullRequestNumber: 42,
        headSha: newHead,
      });
    } finally {
      database.close();
    }
  });

  it('releases a pre-handoff failed claim so the same-pull-request rerun and unrelated work progress', async () => {
    const database = new SqliteD1Database();
    let mintAttempts = 0;
    let currentHead = oldHead;
    const env = coreEnv(database);
    const dependencies: CoreWorkerDependencies = {
      github: {
        getRepositoryUrl: async () => 'https://github.com/acme/reviewed.git',
        loadReviewTarget: async ({ pullRequestNumber }) => ({
          headSha: pullRequestNumber === 42 ? currentHead : eligibleEvent.headSha,
        }),
      },
      getReadInstallationToken: async () => {
        mintAttempts += 1;
        if (mintAttempts === 1) throw new Error('token mint failed');
        return { token: 'repository-read-token', expiresAt: '2026-09-01T01:00:00.000Z' };
      },
    };
    const worker = createCoreWorker(env, dependencies);

    try {
      expect(await scheduleReview(env, dependencies, oldHead, 'delivery-prehandoff-old')).toBe(
        'accepted',
      );
      expect((await worker.claimRunnerJob(claimRequest())).status).toBe(503);

      currentHead = newHead;
      expect(await scheduleReview(env, dependencies, newHead, 'delivery-prehandoff-new')).toBe(
        'accepted',
      );
      const rerunClaim = await worker.claimRunnerJob(claimRequest());
      expect(rerunClaim.status).toBe(200);
      expect(await rerunClaim.json()).toMatchObject({ pullRequestNumber: 42, headSha: newHead });

      expect(
        await scheduleReviewEvent(env, dependencies, {
          ...eligibleEvent,
          pullRequestNumber: 43,
          deliveryId: 'delivery-prehandoff-unrelated',
        }),
      ).toBe('accepted');
      const unrelatedClaim = await worker.claimRunnerJob(claimRequest());
      expect(unrelatedClaim.status).toBe(200);
      expect(await unrelatedClaim.json()).toMatchObject({ pullRequestNumber: 43 });
    } finally {
      database.close();
    }
  });

  it('leaves a claim whose ownership changed during preparation untouched without failure feedback', async () => {
    const database = new SqliteD1Database();
    let repositoryLookupStarted!: () => void;
    const lookupStarted = new Promise<void>((resolve) => {
      repositoryLookupStarted = resolve;
    });
    let releaseLookup!: () => void;
    const lookupGate = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    const issueComments: unknown[] = [];
    const env = coreEnv(database);
    const dependencies: CoreWorkerDependencies = {
      github: {
        getRepositoryUrl: async () => {
          repositoryLookupStarted();
          await lookupGate;
          throw new Error('preparation failed after ownership changed');
        },
        createIssueComment: async (input) => {
          issueComments.push(input);
        },
        loadReviewTarget: async () => ({ headSha: oldHead }),
      },
      getReadInstallationToken: async () => ({
        token: 'repository-read-token',
        expiresAt: '2026-09-01T01:00:00.000Z',
      }),
    };
    const worker = createCoreWorker(env, dependencies);

    try {
      expect(await scheduleReview(env, dependencies, oldHead, 'delivery-owner-change')).toBe(
        'accepted',
      );
      const claimPromise = worker.claimRunnerJob(claimRequest());
      await lookupStarted;
      database.database
        .prepare('UPDATE review_runs SET runner_job_id = ?, runner_attempt = ?')
        .run('job-new-owner', 2);
      releaseLookup();

      expect((await claimPromise).status).toBe(204);
      const runId = (
        database.database.prepare('SELECT run_id FROM review_runs').get() as {
          run_id: string;
        }
      ).run_id;
      await expect(createD1ReviewStateStore(database).getRunOutcome(runId)).resolves.toMatchObject({
        status: 'scheduled',
        runnerJobId: 'job-new-owner',
        runnerAttempt: 2,
      });
      expect(issueComments).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('blocks a same-pull-request replacement through the Worker callback until a destroyed confirmation', async () => {
    const database = new SqliteD1Database();
    const env = {
      ...coreEnv(database),
      EVIDENCE_BUCKET: { put: async () => undefined },
    };
    let currentHead = oldHead;
    const dependencies: CoreWorkerDependencies = {
      github: claimGithub(() => currentHead),
      getReadInstallationToken: async () => ({
        token: 'repository-read-token',
        expiresAt: '2026-09-01T01:00:00.000Z',
      }),
    };
    const callbackRequest = (body: string) =>
      new Request('https://reviews.test/runner-callback', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body,
      });
    const worker = createCoreWorker(env, dependencies);

    try {
      expect(await scheduleReview(env, dependencies, oldHead, 'delivery-cleanup-block')).toBe(
        'accepted',
      );
      const claim = await worker.claimRunnerJob(claimRequest());
      expect(claim.status).toBe(200);
      const job = (await claim.json()) as { id: string; runId: string; attempt: number };

      expect(
        (
          await worker.handleRunnerCallback(
            callbackRequest(await abortedCallback(job.runId, job.id, job.attempt, 'failed')),
          )
        ).status,
      ).toBe(202);

      currentHead = newHead;
      expect(await scheduleReview(env, dependencies, newHead, 'delivery-cleanup-replacement')).toBe(
        'accepted',
      );
      const freshWorker = createCoreWorker(env, dependencies);
      expect((await freshWorker.claimRunnerJob(claimRequest())).status).toBe(204);

      expect(
        (
          await freshWorker.handleRunnerCallback(
            callbackRequest(await abortedCallback(job.runId, job.id, job.attempt, 'destroyed')),
          )
        ).status,
      ).toBe(202);
      const released = await freshWorker.claimRunnerJob(claimRequest());
      expect(released.status).toBe(200);
      expect(await released.json()).toMatchObject({ pullRequestNumber: 42, headSha: newHead });
    } finally {
      database.close();
    }
  });

  it('does not label ordinary same-pull-request serialization as a cleanup block', async () => {
    const database = new SqliteD1Database();
    const env = coreEnv(database);
    const dependencies: CoreWorkerDependencies = {
      github: claimGithub(),
      getReadInstallationToken: async () => ({
        token: 'repository-read-token',
        expiresAt: '2026-09-01T01:00:00.000Z',
      }),
    };
    const worker = createCoreWorker(env, dependencies);
    try {
      expect(await scheduleReview(env, dependencies, oldHead, 'delivery-running-blocker')).toBe(
        'accepted',
      );
      expect((await worker.claimRunnerJob(claimRequest())).status).toBe(200);
      expect(await scheduleReview(env, dependencies, newHead, 'delivery-running-queued')).toBe(
        'accepted',
      );
      database.database
        .prepare(
          "UPDATE review_runs SET status = 'scheduled', terminal_at = NULL WHERE status = 'superseded'",
        )
        .run();
      const queued = (await (
        await worker.listPublicJobs(new URLSearchParams('status=queued'))
      ).json()) as { tasks: Array<{ runId: string; queueBlockReason?: string | null }> };
      expect(queued.tasks).toHaveLength(1);
      expect(queued.tasks[0]?.queueBlockReason).toBeNull();
    } finally {
      database.close();
    }
  });

  it('does not clear a superseded claim when the runner identity does not match another owner', async () => {
    const database = new SqliteD1Database();
    const store = createD1ReviewStateStore(database);
    try {
      const claimed = await store.claimReview({
        deliveryId: 'delivery-owner',
        job: claimJob(42, oldHead),
        occurredAt: '2026-09-01T00:00:00.000Z',
      });
      if (claimed.kind !== 'claimed') throw new Error('run was not admitted');
      await store.claimNextJob({
        jobId: 'job-owner',
        attempt: 1,
        occurredAt: '2026-09-01T00:00:01.000Z',
      });
      await store.markRunSuperseded({
        runId: claimed.runId,
        occurredAt: '2026-09-01T00:00:02.000Z',
      });
      await expect(
        store.clearRunnerJob({ runId: claimed.runId, jobId: 'job-other' }),
      ).resolves.toBe(false);
      await expect(
        store.clearRunnerJob({ runId: claimed.runId, jobId: 'job-owner' }),
      ).resolves.toBe(true);
    } finally {
      database.close();
    }
  });
});
