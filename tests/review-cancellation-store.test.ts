import { describe, expect, it } from 'vitest';
import {
  createD1ReviewStateStore,
  createInMemoryReviewStateStore,
  type ReviewJob,
  type ReviewStateQueries,
  type ReviewStateStore,
} from '../apps/core/src/index';
import { SqliteD1Database } from './support/d1-database';

const baseSha = '1111111111111111111111111111111111111111';
const headSha = '2222222222222222222222222222222222222222';

const job = (overrides: Partial<ReviewJob> = {}): ReviewJob => ({
  installationId: 7,
  repositoryId: 11,
  pullRequestNumber: 42,
  baseSha,
  headSha,
  trigger: 'automatic',
  ...overrides,
});

type CancellationStore = ReviewStateStore & ReviewStateQueries;

const schedule = async (
  store: ReviewStateStore,
  deliveryId: string,
  input: ReviewJob = job(),
): Promise<string> => {
  const claim = await store.claimReview({
    deliveryId,
    job: input,
    occurredAt: '2026-11-19T00:00:00.000Z',
  });
  if (claim.kind !== 'claimed') throw new Error(`run was not claimed: ${claim.kind}`);
  return claim.runId;
};

const evidence = (key: string) => ({
  key,
  status: 'complete' as const,
  size: 10,
  sha256: 'a'.repeat(64),
  uploadedAt: '2026-11-19T00:01:00.000Z',
});

describe('cancellation migration', () => {
  it('upgrades existing runs and deliveries without losing rows or uniqueness rules', async () => {
    const database = new SqliteD1Database('core', '0014_failure_http_status.sql');
    const legacyRunId = 'legacy-before-cancellation';
    database.database.exec(`
      INSERT INTO deliveries (
        delivery_id, installation_id, repository_id, pull_request_number,
        base_sha, head_sha, trigger, status, created_at, updated_at
      ) VALUES (
        'legacy-delivery', 7, 11, 42,
        '${baseSha}', '${headSha}', 'automatic', 'scheduled',
        '2026-11-19T00:00:00.000Z', '2026-11-19T00:00:00.000Z'
      );
      INSERT INTO review_runs (
        run_id, delivery_id, installation_id, repository_id,
        pull_request_number, base_sha, head_sha, trigger,
        status, created_at, updated_at
      ) VALUES (
        '${legacyRunId}', 'legacy-delivery', 7, 11, 42,
        '${baseSha}', '${headSha}', 'automatic', 'scheduled',
        '2026-11-19T00:00:00.000Z', '2026-11-19T00:00:00.000Z'
      );
    `);

    try {
      database.migrateThrough('0015_review_cancellation.sql');
      const store = createD1ReviewStateStore(database);
      await expect(
        store.cancelRun({
          runId: legacyRunId,
          requestedByUid: 1001,
          occurredAt: '2026-11-19T00:01:00.000Z',
        }),
      ).resolves.toMatchObject({ kind: 'cancelled' });
      await expect(store.getRunOutcome(legacyRunId)).resolves.toMatchObject({
        status: 'cancelled',
      });
      await expect(store.getDeliveryOutcome('legacy-delivery')).resolves.toMatchObject({
        status: 'cancelled',
      });
      await expect(
        store.claimReview({
          deliveryId: 'legacy-manual-retry',
          job: job({ trigger: 'manual' }),
          occurredAt: '2026-11-19T00:02:00.000Z',
        }),
      ).resolves.toMatchObject({ kind: 'claimed' });
    } finally {
      database.close();
    }
  });
});

describe.each([
  ['D1', () => createD1ReviewStateStore(new SqliteD1Database())],
  ['in-memory', () => createInMemoryReviewStateStore()],
] as const)('%s cancellation store', (_name, createStore) => {
  it('atomically cancels a queued run so a racing claim cannot take it', async () => {
    const store = createStore() as CancellationStore;
    const runId = await schedule(store, 'cancel-queued');

    await expect(
      store.cancelRun({
        runId,
        requestedByUid: 1001,
        occurredAt: '2026-11-19T00:01:00.000Z',
      }),
    ).resolves.toEqual({
      kind: 'cancelled',
      cancellation: {
        runId,
        requestedAt: '2026-11-19T00:01:00.000Z',
        requestedByUid: 1001,
        runnerJobId: null,
        runnerAttempt: null,
        cleanup: null,
        checkRunId: null,
      },
    });

    await expect(
      store.claimNextJob?.({
        jobId: 'racing-job',
        attempt: 1,
        occurredAt: '2026-11-19T00:01:01.000Z',
      }),
    ).resolves.toEqual({ kind: 'empty' });
    await expect(store.getRunOutcome(runId)).resolves.toMatchObject({
      status: 'cancelled',
    });
    await expect(store.getDeliveryOutcome('cancel-queued')).resolves.toMatchObject({
      status: 'cancelled',
    });
    if (store.getPublicRun !== undefined) {
      await expect(store.getPublicRun(runId)).resolves.toMatchObject({
        status: 'cancelled',
        runnerJobId: null,
      });
    }
    if (store.listPublicRuns !== undefined) {
      await expect(
        store.listPublicRuns({
          limit: 10,
          filter: { status: 'cancelled', cleanup: 'all' },
          view: 'history',
        }),
      ).resolves.toMatchObject([{ runId, status: 'cancelled' }]);
    }
    if (store.getPublicOverview !== undefined) {
      await expect(
        store.getPublicOverview({ since: '2026-01-01T00:00:00.000Z', limit: 10 }),
      ).resolves.toMatchObject({ counts: { queued: 0, cleanupAttention: 0 } });
    }
  });

  it('retains runner identity and beats publication without losing the disposition to late callbacks', async () => {
    const store = createStore() as CancellationStore;
    const runId = await schedule(store, 'cancel-claimed');
    await store.recordRunnerJob({ runId, jobId: 'runner-job-1', attempt: 1 });

    const first = await store.cancelRun({
      runId,
      requestedByUid: 1001,
      occurredAt: '2026-11-19T00:01:00.000Z',
    });
    expect(first).toMatchObject({
      kind: 'cancelled',
      cancellation: {
        runId,
        requestedByUid: 1001,
        runnerJobId: 'runner-job-1',
        runnerAttempt: 1,
        cleanup: 'pending',
      },
    });
    await expect(store.getRunOutcome(runId)).resolves.toMatchObject({
      status: 'cancelled',
      runnerJobId: 'runner-job-1',
      runnerAttempt: 1,
    });
    if (store.getPublicOverview !== undefined) {
      await expect(
        store.getPublicOverview({ since: '2026-01-01T00:00:00.000Z', limit: 10 }),
      ).resolves.toMatchObject({ counts: { cleanupAttention: 1 } });
    }

    await expect(
      store.claimRunPublication?.({
        runId,
        occurredAt: '2026-11-19T00:02:00.000Z',
        publishing: true,
      }),
    ).resolves.toBe(false);
    await expect(
      store.markRunCompleted({ runId, occurredAt: '2026-11-19T00:02:00.000Z' }),
    ).resolves.toBe(false);
    await expect(
      store.completeRunPublication({
        runId,
        occurredAt: '2026-11-19T00:02:00.000Z',
        fingerprints: ['finding-1'],
        decision: 'approve',
      }),
    ).resolves.toBe(false);
    await expect(
      store.markRunSuperseded({ runId, occurredAt: '2026-11-19T00:02:00.000Z' }),
    ).resolves.toBe(false);
    await expect(
      store.markSchedulingFailed({ runId, occurredAt: '2026-11-19T00:02:00.000Z' }),
    ).resolves.toBe(false);
    await expect(store.getRunOutcome(runId)).resolves.toMatchObject({
      status: 'cancelled',
    });

    await expect(
      store.recordEvidence({
        runId,
        evidence: evidence('late-evidence'),
        sandboxCleanup: 'destroyed',
      }),
    ).resolves.toBe(true);
    await expect(
      store.cancelRun({
        runId,
        requestedByUid: 9999,
        occurredAt: '2026-11-19T00:03:00.000Z',
      }),
    ).resolves.toMatchObject({
      kind: 'already_cancelled',
      cancellation: {
        requestedAt: '2026-11-19T00:01:00.000Z',
        requestedByUid: 1001,
        cleanup: 'destroyed',
      },
    });
    await expect(
      store.listCancellationWork?.({
        retryBefore: '2026-11-19T01:00:00.000Z',
        recoveryBefore: '2026-11-18T00:00:00.000Z',
        limit: 10,
      }),
    ).resolves.toEqual([]);
    if (store.getPublicOverview !== undefined) {
      await expect(
        store.getPublicOverview({ since: '2026-01-01T00:00:00.000Z', limit: 10 }),
      ).resolves.toMatchObject({ counts: { cleanupAttention: 0 } });
    }
  });

  it('reports a conflict for a publication claim or any other terminal state', async () => {
    const store = createStore() as CancellationStore;
    const publishedRun = await schedule(store, 'cancel-published');
    await store.recordRunnerJob({
      runId: publishedRun,
      jobId: 'runner-job-published',
      attempt: 1,
    });
    await expect(
      store.claimRunPublication?.({
        runId: publishedRun,
        occurredAt: '2026-11-19T00:01:00.000Z',
        publishing: true,
      }),
    ).resolves.toBe(true);
    await expect(
      store.cancelRun({
        runId: publishedRun,
        requestedByUid: 1001,
        occurredAt: '2026-11-19T00:02:00.000Z',
      }),
    ).resolves.toEqual({
      kind: 'conflict',
      runId: publishedRun,
      status: 'scheduled',
      publicationClaimed: true,
    });

    const completedRun = await schedule(
      store,
      'cancel-completed',
      job({ headSha: '4'.repeat(40) }),
    );
    await expect(
      store.completeRunPublication({
        runId: completedRun,
        occurredAt: '2026-11-19T00:02:00.000Z',
        fingerprints: [],
      }),
    ).resolves.toBe(true);
    await expect(
      store.cancelRun({
        runId: completedRun,
        requestedByUid: 1001,
        occurredAt: '2026-11-19T00:02:00.000Z',
      }),
    ).resolves.toEqual({
      kind: 'conflict',
      runId: completedRun,
      status: 'completed',
      publicationClaimed: false,
    });
    await expect(
      store.cancelRun({
        runId: 'missing-run',
        requestedByUid: 1001,
        occurredAt: '2026-11-19T00:02:00.000Z',
      }),
    ).resolves.toEqual({ kind: 'not_found', runId: 'missing-run' });
  });

  it('allows a fresh manual retry only after the cancelled runner claim is torn down', async () => {
    const store = createStore() as CancellationStore;
    const runId = await schedule(store, 'cancel-before-retry');
    await store.recordRunnerJob({ runId, jobId: 'runner-job-retry', attempt: 1 });
    await store.cancelRun({
      runId,
      requestedByUid: 1001,
      occurredAt: '2026-11-19T00:01:00.000Z',
    });

    await expect(
      store.claimReview({
        deliveryId: 'retry-before-cleanup',
        job: job({ trigger: 'manual' }),
        occurredAt: '2026-11-19T00:02:00.000Z',
      }),
    ).resolves.toMatchObject({ kind: 'existing', disposition: 'cancelled' });

    await store.recordEvidence({
      runId,
      evidence: evidence('retry-evidence'),
      sandboxCleanup: 'destroyed',
    });
    const retry = await store.claimReview({
      deliveryId: 'retry-after-cleanup',
      job: job({ trigger: 'manual' }),
      occurredAt: '2026-11-19T00:03:00.000Z',
    });
    expect(retry).toMatchObject({ kind: 'claimed' });
    if (retry.kind !== 'claimed') throw new Error('retry was not claimed');
    expect(retry.runId).not.toBe(runId);
    await expect(
      store.claimNextJob?.({
        jobId: 'retry-job',
        attempt: 1,
        occurredAt: '2026-11-19T00:04:00.000Z',
      }),
    ).resolves.toMatchObject({ kind: 'claimed', runId: retry.runId });
  });

  it('blocks a same-pull-request replacement until the cancelled claim cleanup is confirmed', async () => {
    const store = createStore() as CancellationStore;
    const cancelledRun = await schedule(store, 'blocking-cancel');
    await store.recordRunnerJob({
      runId: cancelledRun,
      jobId: 'runner-job-blocking',
      attempt: 1,
    });
    await store.cancelRun({
      runId: cancelledRun,
      requestedByUid: 1001,
      occurredAt: '2026-11-19T00:01:00.000Z',
    });

    const replacementRun = await schedule(
      store,
      'blocking-replacement',
      job({ headSha: '3'.repeat(40) }),
    );
    await expect(
      store.claimNextJob?.({
        jobId: 'replacement-job',
        attempt: 1,
        occurredAt: '2026-11-19T00:02:00.000Z',
      }),
    ).resolves.toEqual({ kind: 'empty' });

    await store.recordEvidence({
      runId: cancelledRun,
      evidence: evidence('blocking-evidence'),
      sandboxCleanup: 'destroyed',
    });
    await expect(
      store.claimNextJob?.({
        jobId: 'replacement-job',
        attempt: 1,
        occurredAt: '2026-11-19T00:03:00.000Z',
      }),
    ).resolves.toMatchObject({ kind: 'claimed', runId: replacementRun });
  });

  it('guards check setup and exposes an in-flight check for cancellation reconciliation', async () => {
    const store = createStore() as CancellationStore;
    const runId = await schedule(store, 'cancel-check-setup');
    await expect(
      store.claimCheckSetup?.({
        runId,
        claimedAt: '2026-11-19T00:00:30.000Z',
        staleBefore: '2026-11-19T00:00:00.000Z',
      }),
    ).resolves.toBe(true);
    await store.cancelRun({
      runId,
      requestedByUid: 1001,
      occurredAt: '2026-11-19T00:01:00.000Z',
    });
    await expect(
      store.claimCheckSetup?.({
        runId,
        claimedAt: '2026-11-19T00:01:30.000Z',
        staleBefore: '2026-11-19T00:01:00.000Z',
      }),
    ).resolves.toBe(false);
    await expect(
      store.recordCheckRun?.({
        runId,
        checkRunId: 321,
        setupClaim: '2026-11-19T00:00:30.000Z',
      }),
    ).resolves.toBe(true);

    const work = await store.listCancellationWork?.({
      retryBefore: '2026-11-19T00:02:00.000Z',
      recoveryBefore: '2026-11-19T00:00:00.000Z',
      limit: 10,
    });
    expect(work).toMatchObject([
      {
        runId,
        checkRunId: 321,
        needsRunnerStop: false,
        needsCheckReconciliation: true,
      },
    ]);
    await store.recordCheckCancellationAttempt?.({
      runId,
      checkRunId: 321,
      occurredAt: '2026-11-19T00:02:00.000Z',
      expectedLastAttempt: null,
    });
    await expect(
      store.listCancellationWork?.({
        retryBefore: '2026-11-19T00:01:59.000Z',
        recoveryBefore: '2026-11-19T00:00:00.000Z',
        limit: 10,
      }),
    ).resolves.toEqual([]);
    await expect(
      store.listCancellationWork?.({
        retryBefore: '2026-11-19T00:02:00.000Z',
        recoveryBefore: '2026-11-19T00:00:00.000Z',
        limit: 10,
      }),
    ).resolves.toMatchObject([{ runId, needsCheckReconciliation: true }]);
    await store.confirmCheckCancelled?.({
      runId,
      checkRunId: 321,
      occurredAt: '2026-11-19T00:02:01.000Z',
    });
    await expect(
      store.listCancellationWork?.({
        retryBefore: '2026-11-19T01:00:00.000Z',
        recoveryBefore: '2026-11-19T00:00:00.000Z',
        limit: 10,
      }),
    ).resolves.toEqual([]);
    await expect(
      store.confirmCheckCancelled?.({
        runId,
        checkRunId: 321,
        occurredAt: '2026-11-19T00:02:02.000Z',
      }),
    ).resolves.toBe(false);
  });

  it('retains the first confirmed teardown time when a later callback supplies it', async () => {
    const store = createStore() as CancellationStore;
    const runId = await schedule(store, 'late-cleanup-time');
    await store.recordRunnerJob({ runId, jobId: 'job', attempt: 1 });
    await store.cancelRun({ runId, requestedByUid: 1, occurredAt: '2026-11-19T00:01:00.000Z' });
    const key = 'reviews/' + runId;
    await store.recordEvidence({ runId, evidence: evidence(key), sandboxCleanup: 'destroyed' });
    await store.recordEvidence({
      runId,
      evidence: { ...evidence(key), cleanupCompletedAt: '2026-11-19T00:01:59.000Z' },
      sandboxCleanup: 'failed',
    });
    expect((await store.getRunOutcome(runId))?.evidence?.cleanupCompletedAt).toBeUndefined();
    for (const timestamp of ['2026-11-19T00:02:00.000Z', '2026-11-19T00:03:00.000Z'])
      await store.recordEvidence({
        runId,
        evidence: { ...evidence(key), cleanupCompletedAt: timestamp },
        sandboxCleanup: 'destroyed',
      });
    expect((await store.getRunOutcome(runId))?.evidence?.cleanupCompletedAt).toBe(
      '2026-11-19T00:02:00.000Z',
    );
  });

  it('reopens a reconciled Check cancellation after a stale in-progress write', async () => {
    const store = createStore() as CancellationStore;
    const runId = await schedule(store, 'cancel-check-reopen');
    const scheduledRun = await schedule(store, 'cancel-check-reopen-scheduled', {
      ...job(),
      pullRequestNumber: 43,
      headSha: '3'.repeat(40),
    });
    await store.recordCheckRun?.({ runId, checkRunId: 501 });
    await store.cancelRun({
      runId,
      requestedByUid: 1001,
      occurredAt: '2026-11-19T00:01:00.000Z',
    });
    await expect(
      store.recordCheckCancellationAttempt?.({
        runId,
        checkRunId: 501,
        occurredAt: '2026-11-19T00:01:30.000Z',
        expectedLastAttempt: null,
      }),
    ).resolves.toBe(true);
    await expect(
      store.confirmCheckCancelled?.({
        runId,
        checkRunId: 501,
        occurredAt: '2026-11-19T00:01:31.000Z',
      }),
    ).resolves.toBe(true);
    await expect(
      store.listCancellationWork?.({
        retryBefore: '2026-11-19T00:02:00.000Z',
        recoveryBefore: '2026-11-19T00:00:00.000Z',
        limit: 10,
      }),
    ).resolves.toEqual([]);

    await expect(store.reopenCheckCancellation?.({ runId, checkRunId: 501 })).resolves.toBe(true);
    await expect(store.reopenCheckCancellation?.({ runId, checkRunId: 999 })).resolves.toBe(false);
    await expect(
      store.reopenCheckCancellation?.({ runId: scheduledRun, checkRunId: 501 }),
    ).resolves.toBe(false);
    await expect(
      store.listCancellationWork?.({
        retryBefore: '2026-11-19T00:02:00.000Z',
        recoveryBefore: '2026-11-19T00:00:00.000Z',
        limit: 10,
      }),
    ).resolves.toMatchObject([{ runId, needsCheckReconciliation: true }]);

    await expect(
      store.recordCheckCancellationAttempt?.({
        runId,
        checkRunId: 501,
        occurredAt: '2026-11-19T00:02:01.000Z',
        expectedLastAttempt: null,
      }),
    ).resolves.toBe(true);
    await expect(
      store.confirmCheckCancelled?.({
        runId,
        checkRunId: 501,
        occurredAt: '2026-11-19T00:02:02.000Z',
      }),
    ).resolves.toBe(true);
    await expect(
      store.listCancellationWork?.({
        retryBefore: '2026-11-19T00:02:03.000Z',
        recoveryBefore: '2026-11-19T00:00:00.000Z',
        limit: 10,
      }),
    ).resolves.toEqual([]);
  });

  it('recovers a failed cancelled-run cleanup and keeps destroyed teardown monotonic', async () => {
    const store = createStore() as CancellationStore;
    const runId = await schedule(store, 'cancel-cleanup-recovery');
    await store.recordRunnerJob({
      runId,
      jobId: 'runner-job-recovery',
      attempt: 1,
    });
    await store.cancelRun({
      runId,
      requestedByUid: 1001,
      occurredAt: '2026-11-19T00:01:00.000Z',
    });
    await store.recordEvidence({
      runId,
      evidence: evidence('failed-cleanup'),
      sandboxCleanup: 'failed',
    });

    const recovery = {
      runId,
      jobId: 'runner-job-recovery',
      attempt: 1,
      evidenceId: 'evidence-id',
      baseSha,
      headSha,
      sandboxName: 'sandbox',
      confirmedAt: '2026-11-19T00:02:00.000Z',
    };
    await expect(store.validateRunnerCleanupRecovery?.(recovery)).resolves.toEqual({
      kind: 'recoverable',
    });
    await expect(store.recoverRunnerCleanup?.(recovery)).resolves.toEqual({
      kind: 'recovered',
      cleanupCompletedAt: '2026-11-19T00:02:00.000Z',
    });
    await expect(store.validateRunnerCleanupRecovery?.(recovery)).resolves.toEqual({
      kind: 'already',
      cleanupCompletedAt: '2026-11-19T00:02:00.000Z',
    });
    await store.recordEvidence({
      runId,
      evidence: evidence('failed-cleanup'),
      sandboxCleanup: 'failed',
    });
    await expect(store.getRunOutcome(runId)).resolves.toMatchObject({
      status: 'cancelled',
      evidence: {
        cleanupCompletedAt: '2026-11-19T00:02:00.000Z',
      },
    });
  });

  it('exposes the original claim time and separates old cleanup blockers from retryable stops', async () => {
    const store = createStore() as CancellationStore;
    const runId = await schedule(store, 'recovery-window');
    await expect(
      store.claimNextJob?.({
        jobId: 'recovery-job',
        attempt: 1,
        occurredAt: '2026-11-19T00:00:30.000Z',
      }),
    ).resolves.toMatchObject({ kind: 'claimed', runId });
    await store.cancelRun({
      runId,
      requestedByUid: 1001,
      occurredAt: '2026-11-19T00:01:00.000Z',
    });

    await expect(
      store.listCancellationWork?.({
        retryBefore: '2026-11-19T01:00:00.000Z',
        recoveryBefore: '2026-11-19T00:00:45.000Z',
        limit: 10,
      }),
    ).resolves.toMatchObject([
      {
        runId,
        claimedAt: '2026-11-19T00:00:30.000Z',
        runnerJobId: 'recovery-job',
        runnerAttempt: 1,
        needsRunnerStop: true,
        cleanupBlocked: true,
        recoveryRequired: false,
      },
    ]);

    await expect(
      store.listCancellationWork?.({
        retryBefore: '2026-11-19T01:00:00.000Z',
        recoveryBefore: '2026-11-19T00:02:00.000Z',
        limit: 10,
      }),
    ).resolves.toMatchObject([
      {
        runId,
        needsRunnerStop: false,
        cleanupBlocked: true,
        recoveryRequired: true,
      },
    ]);

    await expect(
      store.confirmRunnerDestroyed?.({
        runId,
        jobId: 'foreign-job',
        attempt: 1,
        occurredAt: '2026-11-19T00:03:00.000Z',
      }),
    ).resolves.toBe(false);
    await expect(
      store.confirmRunnerDestroyed?.({
        runId,
        jobId: 'recovery-job',
        attempt: 2,
        occurredAt: '2026-11-19T00:03:00.000Z',
      }),
    ).resolves.toBe(false);
    await expect(
      store.confirmRunnerDestroyed?.({
        runId,
        jobId: 'recovery-job',
        attempt: 1,
        occurredAt: '2026-11-19T00:03:00.000Z',
      }),
    ).resolves.toBe(true);
    await expect(
      store.recordEvidence({
        runId,
        evidence: evidence('late-cancellation-evidence'),
      }),
    ).resolves.toBe(true);
    if (store.recordModelUsage !== undefined) {
      await expect(
        store.recordModelUsage({
          runId,
          jobId: 'recovery-job',
          attempt: 1,
          usage: { version: 1, models: [] },
        }),
      ).resolves.toBe(true);
    }
    await expect(store.getRunOutcome(runId)).resolves.toMatchObject({
      status: 'cancelled',
      runnerJobId: 'recovery-job',
      runnerAttempt: 1,
      evidence: { key: 'late-cancellation-evidence' },
    });
    await expect(
      store.listCancellationWork?.({
        retryBefore: '2026-11-19T01:00:00.000Z',
        recoveryBefore: '2026-11-18T00:00:00.000Z',
        limit: 10,
      }),
    ).resolves.toEqual([]);
  });

  it('limits cancellation work to an optional runId for an immediate targeted stop', async () => {
    const store = createStore() as CancellationStore;
    const firstRun = await schedule(store, 'targeted-first', job({ pullRequestNumber: 201 }));
    await store.recordRunnerJob({ runId: firstRun, jobId: 'targeted-job-1', attempt: 1 });
    await store.cancelRun({
      runId: firstRun,
      requestedByUid: 1001,
      occurredAt: '2026-11-19T00:01:00.000Z',
    });
    const secondRun = await schedule(store, 'targeted-second', job({ pullRequestNumber: 202 }));
    await store.recordRunnerJob({ runId: secondRun, jobId: 'targeted-job-2', attempt: 1 });
    await store.cancelRun({
      runId: secondRun,
      requestedByUid: 1001,
      occurredAt: '2026-11-19T00:02:00.000Z',
    });

    await expect(
      store.listCancellationWork?.({
        retryBefore: '2026-11-19T01:00:00.000Z',
        recoveryBefore: '2026-11-18T00:00:00.000Z',
        limit: 10,
      }),
    ).resolves.toMatchObject([{ runId: firstRun }, { runId: secondRun }]);
    await expect(
      store.listCancellationWork?.({
        runId: secondRun,
        retryBefore: '2026-11-19T01:00:00.000Z',
        recoveryBefore: '2026-11-18T00:00:00.000Z',
        limit: 1,
      }),
    ).resolves.toMatchObject([{ runId: secondRun, needsRunnerStop: true }]);
    await expect(
      store.listCancellationWork?.({
        runId: 'missing-run',
        retryBefore: '2026-11-19T01:00:00.000Z',
        recoveryBefore: '2026-11-18T00:00:00.000Z',
        limit: 1,
      }),
    ).resolves.toEqual([]);
  });

  it('leases one stop and one Check dispatch per observed attempt snapshot', async () => {
    const store = createStore() as CancellationStore;
    const runId = await schedule(store, 'cancellation-cas');
    await store.recordRunnerJob({ runId, jobId: 'cas-job', attempt: 1 });
    await store.recordCheckRun?.({ runId, checkRunId: 321 });
    await store.cancelRun({
      runId,
      requestedByUid: 1001,
      occurredAt: '2026-11-19T00:01:00.000Z',
    });

    const [snapshot] =
      (await store.listCancellationWork?.({
        runId,
        retryBefore: '2026-11-19T00:02:00.000Z',
        recoveryBefore: '2026-11-19T00:00:00.000Z',
        limit: 1,
      })) ?? [];
    if (snapshot === undefined) throw new Error('cancellation work was not visible');
    expect(snapshot).toMatchObject({
      runnerStopAttemptedAt: null,
      checkCancelAttemptedAt: null,
      needsRunnerStop: true,
      needsCheckReconciliation: true,
    });

    const stopResults = await Promise.all([
      store.recordRunnerStopAttempt!({
        runId,
        jobId: 'cas-job',
        attempt: 1,
        occurredAt: '2026-11-19T00:02:00.000Z',
        expectedLastAttempt: snapshot.runnerStopAttemptedAt,
      }),
      store.recordRunnerStopAttempt!({
        runId,
        jobId: 'cas-job',
        attempt: 1,
        occurredAt: '2026-11-19T00:02:01.000Z',
        expectedLastAttempt: snapshot.runnerStopAttemptedAt,
      }),
    ]);
    expect(stopResults.filter(Boolean)).toHaveLength(1);

    const checkResults = await Promise.all([
      store.recordCheckCancellationAttempt!({
        runId,
        checkRunId: 321,
        occurredAt: '2026-11-19T00:02:00.000Z',
        expectedLastAttempt: snapshot.checkCancelAttemptedAt,
      }),
      store.recordCheckCancellationAttempt!({
        runId,
        checkRunId: 321,
        occurredAt: '2026-11-19T00:02:01.000Z',
        expectedLastAttempt: snapshot.checkCancelAttemptedAt,
      }),
    ]);
    expect(checkResults.filter(Boolean)).toHaveLength(1);

    const [leased] =
      (await store.listCancellationWork?.({
        runId,
        retryBefore: '2026-11-19T00:02:02.000Z',
        recoveryBefore: '2026-11-19T00:00:00.000Z',
        limit: 1,
      })) ?? [];
    if (leased === undefined) throw new Error('leased cancellation work was not visible');
    expect(['2026-11-19T00:02:00.000Z', '2026-11-19T00:02:01.000Z']).toContain(
      leased.runnerStopAttemptedAt,
    );
    expect(['2026-11-19T00:02:00.000Z', '2026-11-19T00:02:01.000Z']).toContain(
      leased.checkCancelAttemptedAt,
    );

    await expect(
      store.recordRunnerStopAttempt!({
        runId,
        jobId: 'cas-job',
        attempt: 1,
        occurredAt: '2026-11-19T00:03:00.000Z',
        expectedLastAttempt: leased.runnerStopAttemptedAt,
      }),
    ).resolves.toBe(true);
    await expect(
      store.recordCheckCancellationAttempt!({
        runId,
        checkRunId: 321,
        occurredAt: '2026-11-19T00:03:00.000Z',
        expectedLastAttempt: leased.checkCancelAttemptedAt,
      }),
    ).resolves.toBe(true);
    await expect(
      store.recordRunnerStopAttempt!({
        runId,
        jobId: 'cas-job',
        attempt: 1,
        occurredAt: '2026-11-19T00:04:00.000Z',
        expectedLastAttempt: null,
      }),
    ).resolves.toBe(false);
    await expect(
      store.recordCheckCancellationAttempt!({
        runId,
        checkRunId: 321,
        occurredAt: '2026-11-19T00:04:00.000Z',
        expectedLastAttempt: null,
      }),
    ).resolves.toBe(false);
  });

  it('returns a bounded, retry-aware cancellation work list', async () => {
    const store = createStore() as CancellationStore;
    const runIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const runId = await schedule(store, `work-${index}`, job({ pullRequestNumber: 100 + index }));
      await store.recordRunnerJob({
        runId,
        jobId: `runner-job-${index}`,
        attempt: 1,
      });
      await store.cancelRun({
        runId,
        requestedByUid: 1001,
        occurredAt: `2026-11-19T00:0${index + 1}:00.000Z`,
      });
      runIds.push(runId);
    }

    await expect(
      store.listCancellationWork?.({
        retryBefore: '2026-11-19T01:00:00.000Z',
        recoveryBefore: '2026-11-18T00:00:00.000Z',
        limit: 2,
      }),
    ).resolves.toMatchObject([
      { runId: runIds[0], needsRunnerStop: true },
      { runId: runIds[1], needsRunnerStop: true },
    ]);
    await store.recordRunnerStopAttempt?.({
      runId: runIds[0] as string,
      jobId: 'runner-job-0',
      attempt: 1,
      occurredAt: '2026-11-19T00:10:00.000Z',
      expectedLastAttempt: null,
    });
    await expect(
      store.listCancellationWork?.({
        retryBefore: '2026-11-19T00:09:59.000Z',
        recoveryBefore: '2026-11-18T00:00:00.000Z',
        limit: 10,
      }),
    ).resolves.toMatchObject([{ runId: runIds[1] }, { runId: runIds[2] }]);
    await expect(
      store.recordRunnerStopAttempt?.({
        runId: runIds[0] as string,
        jobId: 'foreign-job',
        attempt: 1,
        occurredAt: '2026-11-19T00:11:00.000Z',
        expectedLastAttempt: '2026-11-19T00:10:00.000Z',
      }),
    ).resolves.toBe(false);
  });
});
