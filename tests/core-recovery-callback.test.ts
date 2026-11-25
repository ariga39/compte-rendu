import { describe, expect, it } from 'vitest';
import { createCoreWorker } from '../apps/core/src/core-worker';
import { createD1ReviewStateStore } from '../apps/core/src/index';
import { SqliteD1Database } from './support/d1-database';
import { claimRunnerJob } from './support/runner-claim';
import { coreEnv, claimGithub, recordTestEvidence } from './support/core-worker-harness';

const baseSha = '1'.repeat(40);
const oldHead = '2'.repeat(40);
const newHead = '3'.repeat(40);

const failedCallback = (
  job: { readonly jobId: string; readonly runId: string; readonly attempt: number },
  cleanup: 'pending' | 'destroyed' | 'failed',
  overrides: Record<string, unknown> = {},
) =>
  JSON.stringify({
    version: 2,
    id: job.jobId,
    runId: job.runId,
    attempt: job.attempt,
    status: 'failed',
    stage: 'agent',
    baseSha,
    headSha: oldHead,
    sandbox: { cleanup },
    evidence: { id: 'evidence-recovery', status: 'incomplete' },
    timestamps: { cleanupCompletedAt: '2026-09-01T00:00:03.000Z' },
    failure: { reason: 'agent' },
    ...overrides,
  });

const callbackRequest = (body: string) =>
  new Request('https://core.internal/runner-results', {
    method: 'POST',
    headers: {
      'x-compte-rendu-runner-callback': 'verified',
      'content-type': 'application/json',
    },
    body,
  });

const createWorker = (
  database: SqliteD1Database,
  stateStore = createD1ReviewStateStore(database),
) => {
  const captured = { comments: [] as unknown[], checks: [] as unknown[] };
  const worker = createCoreWorker(
    { ...coreEnv(database), EVIDENCE_BUCKET: { put: async () => undefined } },
    {
      stateStore,
      github: {
        ...claimGithub(() => oldHead),
        createIssueComment: async (input) => {
          captured.comments.push(input);
          return input;
        },
        updateCheckRun: async (input) => {
          captured.checks.push(input);
        },
      },
    },
  );
  return { worker, stateStore, captured };
};

const claimRun = async (
  stateStore: ReturnType<typeof createD1ReviewStateStore>,
  input: {
    deliveryId: string;
    pullRequestNumber: number;
    headSha: string;
    occurredAt: string;
  },
) => {
  const run = await stateStore.claimReview({
    deliveryId: input.deliveryId,
    job: {
      repositoryId: 11,
      installationId: 7,
      pullRequestNumber: input.pullRequestNumber,
      baseSha,
      headSha: input.headSha,
      trigger: 'automatic',
    },
    occurredAt: input.occurredAt,
  });
  if (run.kind !== 'claimed') throw new Error('run was not admitted');
  return { ...run, deliveryId: input.deliveryId };
};

describe('Core recovery callback boundaries', () => {
  it.each([
    [
      'completed',
      (store: ReturnType<typeof createD1ReviewStateStore>, runId: string) =>
        store.markRunCompleted({ runId, occurredAt: '2026-09-01T00:00:03.000Z' }),
    ],
    [
      'publication-claimed',
      (store: ReturnType<typeof createD1ReviewStateStore>, runId: string) =>
        store.claimRunPublication({
          runId,
          occurredAt: '2026-09-01T00:00:03.000Z',
          publishing: true,
        }),
    ],
  ] as const)('rejects a failed callback before any write when %s', async (name, win) => {
    const database = new SqliteD1Database();
    try {
      const { worker, stateStore, captured } = createWorker(database);
      const run = await claimRun(stateStore, {
        deliveryId: `delivery-recovery-${name}`,
        pullRequestNumber: 44,
        headSha: oldHead,
        occurredAt: '2026-09-01T00:00:00.000Z',
      });
      const job = await claimRunnerJob(stateStore, {
        runId: run.runId,
        jobId: `runner-job-${name}`,
      });
      await win(stateStore, run.runId);
      const before = await stateStore.getRunOutcome(run.runId);

      expect((await worker.fetch(callbackRequest(failedCallback(job, 'destroyed')))).status).toBe(
        409,
      );
      expect(await stateStore.getRunOutcome(run.runId)).toEqual(before);
      expect(captured.comments).toEqual([]);
      expect(captured.checks).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('rejects a revision mismatch before any D1 write', async () => {
    const database = new SqliteD1Database();
    try {
      const { worker, stateStore } = createWorker(database);
      const run = await claimRun(stateStore, {
        deliveryId: 'delivery-recovery-sha',
        pullRequestNumber: 45,
        headSha: oldHead,
        occurredAt: '2026-09-01T00:00:00.000Z',
      });
      const job = await claimRunnerJob(stateStore, {
        runId: run.runId,
        jobId: 'runner-job-sha',
      });
      const before = await stateStore.getRunOutcome(run.runId);
      expect(
        (
          await worker.fetch(
            callbackRequest(failedCallback(job, 'destroyed', { headSha: newHead })),
          )
        ).status,
      ).toBe(409);
      expect(await stateStore.getRunOutcome(run.runId)).toEqual(before);
    } finally {
      database.close();
    }
  });

  it('keeps a failed cleanup permanently blocking while pending still honours the claim budget', async () => {
    const database = new SqliteD1Database();
    try {
      const stateStore = createD1ReviewStateStore(database);
      const failed = await claimRun(stateStore, {
        deliveryId: 'delivery-blocking-failed',
        pullRequestNumber: 46,
        headSha: oldHead,
        occurredAt: '2026-09-01T00:00:00.000Z',
      });
      await claimRunnerJob(stateStore, {
        runId: failed.runId,
        jobId: 'runner-job-blocking-failed',
      });
      await recordTestEvidence(stateStore, {
        runId: failed.runId,
        evidence: {
          key: `reviews/${failed.runId}`,
          status: 'incomplete',
          size: 1,
          sha256: 'a'.repeat(64),
          uploadedAt: '2026-09-01T00:00:01.000Z',
        },
        sandboxCleanup: 'failed',
      });
      await stateStore.markSchedulingFailed({
        runId: failed.runId,
        occurredAt: '2026-09-01T00:00:02.000Z',
      });

      const pending = await claimRun(stateStore, {
        deliveryId: 'delivery-blocking-pending',
        pullRequestNumber: 47,
        headSha: oldHead,
        occurredAt: '2026-09-01T00:00:03.000Z',
      });
      await claimRunnerJob(stateStore, {
        runId: pending.runId,
        jobId: 'runner-job-blocking-pending',
      });
      await stateStore.recordRunnerTerminal({
        runId: pending.runId,
        jobId: 'runner-job-blocking-pending',
        attempt: 1,
        cleanup: 'pending',
      });
      await stateStore.markSchedulingFailed({
        runId: pending.runId,
        occurredAt: '2026-09-01T00:00:04.000Z',
      });

      const nextFailed = await claimRun(stateStore, {
        deliveryId: 'delivery-blocking-failed-next',
        pullRequestNumber: 46,
        headSha: newHead,
        occurredAt: '2026-09-01T00:00:05.000Z',
      });
      const nextPending = await claimRun(stateStore, {
        deliveryId: 'delivery-blocking-pending-next',
        pullRequestNumber: 47,
        headSha: newHead,
        occurredAt: '2026-09-01T00:00:05.000Z',
      });

      // Two hours later a known failed cleanup still blocks, while an unknown
      // pending cleanup follows the original 90-minute claim budget.
      expect(
        await stateStore.claimNextJob({
          jobId: 'job-after-budget',
          attempt: 1,
          occurredAt: '2026-09-01T02:00:00.000Z',
        }),
      ).toMatchObject({
        kind: 'claimed',
        runId: nextPending.runId,
        job: { pullRequestNumber: 47 },
      });
      expect(
        await stateStore.claimNextJob({
          jobId: 'job-failed-still-blocked',
          attempt: 1,
          occurredAt: '2026-09-01T02:00:01.000Z',
        }),
      ).toEqual({ kind: 'empty' });

      await stateStore.recordRunnerTerminal({
        runId: failed.runId,
        jobId: 'runner-job-blocking-failed',
        attempt: 1,
        cleanup: 'destroyed',
        cleanupCompletedAt: '2026-09-01T02:00:02.000Z',
      });
      expect(
        await stateStore.claimNextJob({
          jobId: 'job-failed-released',
          attempt: 1,
          occurredAt: '2026-09-01T02:00:03.000Z',
        }),
      ).toMatchObject({
        kind: 'claimed',
        runId: nextFailed.runId,
        job: { pullRequestNumber: 46 },
      });
    } finally {
      database.close();
    }
  });

  it('keeps the run and its delivery consistent when a started publication wins', async () => {
    const database = new SqliteD1Database();
    try {
      const stateStore = createD1ReviewStateStore(database);
      const run = await claimRun(stateStore, {
        deliveryId: 'delivery-race',
        pullRequestNumber: 48,
        headSha: oldHead,
        occurredAt: '2026-09-01T00:00:00.000Z',
      });
      await claimRunnerJob(stateStore, {
        runId: run.runId,
        jobId: 'runner-job-race',
      });
      await stateStore.claimRunPublication({
        runId: run.runId,
        occurredAt: '2026-09-01T00:00:01.000Z',
        publishing: true,
      });

      await expect(
        stateStore.markSchedulingFailed({
          runId: run.runId,
          occurredAt: '2026-09-01T00:00:02.000Z',
          requireUnpublished: true,
          failure: { phase: 'agent', reason: 'agent' },
        }),
      ).resolves.toBe(false);
      expect(await stateStore.getRunOutcome(run.runId)).toMatchObject({ status: 'scheduled' });
      expect(await stateStore.getDeliveryOutcome(run.deliveryId)).toMatchObject({
        status: 'scheduled',
      });
    } finally {
      database.close();
    }
  });

  it('marks both the run and its delivery failed when the failure actually wins', async () => {
    const database = new SqliteD1Database();
    try {
      const stateStore = createD1ReviewStateStore(database);
      const run = await claimRun(stateStore, {
        deliveryId: 'delivery-failure-wins',
        pullRequestNumber: 49,
        headSha: oldHead,
        occurredAt: '2026-09-01T00:00:00.000Z',
      });
      await claimRunnerJob(stateStore, {
        runId: run.runId,
        jobId: 'runner-job-failure-wins',
      });

      await expect(
        stateStore.markSchedulingFailed({
          runId: run.runId,
          occurredAt: '2026-09-01T00:00:02.000Z',
          requireUnpublished: true,
          failure: { phase: 'agent', reason: 'agent' },
        }),
      ).resolves.toBe(true);
      expect(await stateStore.getRunOutcome(run.runId)).toMatchObject({ status: 'failed' });
      expect(await stateStore.getDeliveryOutcome(run.deliveryId)).toMatchObject({
        status: 'failed',
      });
    } finally {
      database.close();
    }
  });
});
