import { describe, expect, it } from 'vitest';
import { createCoreWorker } from './support/core-worker-runtime';
import { createD1ReviewStateStore } from '../apps/core/src/index';
import { publicationRecordKey } from '../apps/core/src/publication-record';
import { SqliteD1Database } from './support/d1-database';
import { claimRunnerJob } from './support/runner-claim';
import { coreEnv, eligibleEvent } from './support/core-worker-harness';

const result = {
  version: 2 as const,
  decision: 'request_changes' as const,
  markdown: '## Review:\n\nA concrete defect.\n',
};

const runJob = {
  repositoryId: 11,
  pullRequestNumber: 42,
  installationId: 7,
  baseSha: eligibleEvent.baseSha,
  headSha: eligibleEvent.headSha,
  trigger: 'automatic' as const,
};

const archiveBucket = () => {
  const objects = new Map<string, string>();
  return {
    objects,
    bucket: {
      put: async (key: string, value: ArrayBuffer | string) => {
        objects.set(key, typeof value === 'string' ? value : new TextDecoder().decode(value));
        return { key };
      },
      get: async (key: string) => {
        const value = objects.get(key);
        if (value === undefined) return null;
        const bytes = new TextEncoder().encode(value);
        return { size: bytes.byteLength, arrayBuffer: async () => bytes.buffer };
      },
    },
  };
};

describe('scheduled Core recovery', () => {
  it('continues publication recovery when cancellation work cannot be queried', async () => {
    const database = new SqliteD1Database();
    const store = createD1ReviewStateStore(database);
    const claimed = await store.claimReview({
      deliveryId: 'recovery-publication-independent',
      job: runJob,
      occurredAt: '2026-09-01T00:00:00.000Z',
    });
    if (claimed.kind !== 'claimed') throw new Error('run was not claimed');
    await claimRunnerJob(store, { runId: claimed.runId, jobId: 'runner-job-1' });
    await store.claimRunPublication({
      runId: claimed.runId,
      occurredAt: '2026-09-01T00:00:04.000Z',
      publishing: true,
    });
    const bucket = archiveBucket();
    bucket.objects.set(
      publicationRecordKey({
        runId: claimed.runId,
        jobId: 'runner-job-1',
        attempt: 1,
      }),
      JSON.stringify({
        version: 2,
        runId: claimed.runId,
        jobId: 'runner-job-1',
        attempt: 1,
        result,
      }),
    );
    const worker = createCoreWorker(
      { ...coreEnv(database), EVIDENCE_BUCKET: bucket.bucket },
      {
        stateStore: {
          ...store,
          listCancellationWork: async () => {
            throw new Error('cancellation queries unavailable');
          },
        },
        github: {
          loadReviewTarget: async () => ({ headSha: eligibleEvent.headSha }),
          findReviewByMarker: async () => ({ id: 99 }),
          createReview: async ({ payload }) => ({ kind: 'created', review: payload }),
        },
      },
    );

    try {
      await expect(
        worker.reconcileRecoveries(Date.parse('2026-09-01T02:00:00.000Z')),
      ).rejects.toThrow(/cancellation/i);
      await expect(store.getRunOutcome(claimed.runId)).resolves.toMatchObject({
        status: 'completed',
        decision: 'request_changes',
      });
    } finally {
      database.close();
    }
  });

  it('continues Runner stop recovery when publication work cannot be queried', async () => {
    const database = new SqliteD1Database();
    const store = createD1ReviewStateStore(database);
    const claimed = await store.claimReview({
      deliveryId: 'recovery-runner-stop-independent',
      job: runJob,
      occurredAt: '2026-09-01T00:00:00.000Z',
    });
    if (claimed.kind !== 'claimed') throw new Error('run was not claimed');
    await claimRunnerJob(store, { runId: claimed.runId, jobId: 'runner-job-1' });
    await store.cancelRun({
      runId: claimed.runId,
      requestedByUid: 1,
      occurredAt: '2026-09-01T00:01:00.000Z',
    });
    const stops: Request[] = [];
    const worker = createCoreWorker(
      {
        ...coreEnv(database, async (request) => {
          stops.push(request);
          return Response.json({
            id: 'runner-job-1',
            runId: claimed.runId,
            attempt: 1,
            stage: 'cleanup',
            status: 'aborted',
            evidence: { id: 'evidence', status: 'incomplete' },
            sandbox: { cleanup: 'destroyed' },
          });
        }),
      },
      {
        stateStore: {
          ...store,
          claimStalledPublications: async () => {
            throw new Error('publication queries unavailable');
          },
        },
        github: { updateCheckRun: async () => {} },
      },
    );

    try {
      await expect(
        worker.reconcileRecoveries(Date.parse('2026-09-01T00:02:00.000Z')),
      ).rejects.toThrow(/publication/i);
      expect(stops).toHaveLength(1);
      await expect(store.getRunOutcome(claimed.runId)).resolves.toMatchObject({
        status: 'cancelled',
        cleanup: 'destroyed',
      });
    } finally {
      database.close();
    }
  });
});
