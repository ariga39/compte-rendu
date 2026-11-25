import { describe, expect, it } from 'vitest';
import { createCoreWorker } from './support/core-http-adapter';
import { createD1ReviewStateStore } from '../apps/core/src/index';
import { publicationRecordKey } from '../apps/core/src/publication-record';
import { MAX_RUNNER_EVIDENCE_BYTES } from '../packages/contracts/src';
import { SqliteD1Database } from './support/d1-database';
import { claimRunnerJob } from './support/runner-claim';
import { coreEnv, eligibleEvent } from './support/core-worker-harness';

const result = {
  version: 2 as const,
  decision: 'request_changes' as const,
  markdown: '## Review:\n\nA concrete defect.\n',
};

const slimCallback = (runId: string, overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: 2,
    id: 'runner-job-1',
    runId,
    attempt: 1,
    baseSha: eligibleEvent.baseSha,
    headSha: eligibleEvent.headSha,
    status: 'succeeded',
    stage: 'cleanup',
    sandbox: { cleanup: 'destroyed' },
    evidence: { id: 'evidence-1', status: 'complete' },
    timestamps: {
      executionStartedAt: '2026-09-01T00:00:01.000Z',
      submissionCompletedAt: '2026-09-01T00:00:02.000Z',
      cleanupCompletedAt: '2026-09-01T00:00:03.000Z',
    },
    result,
    ...overrides,
  });

const evidenceField = async (value: string) => {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return {
    content: Buffer.from(bytes).toString('base64'),
    size: bytes.byteLength,
    sha256: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
      '',
    ),
  };
};

const evidenceUpload = async (runId: string, overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: 2,
    id: 'runner-job-1',
    runId,
    attempt: 1,
    evidenceId: 'evidence-1',
    evidence: {
      status: 'complete',
      manifest: await evidenceField('{"terminal":{"status":"succeeded"}}'),
      opencodeJsonl: await evidenceField('{"type":"result"}\n'),
      opencodeStderr: await evidenceField(''),
      validatedReview: await evidenceField(result.markdown),
      opencodeSessionList: await evidenceField('[{"id":"session-1"}]'),
      opencodeExport: {
        sessionId: 'session-1',
        content: await evidenceField('{"info":{"id":"session-1"},"messages":[]}'),
      },
    },
    timestamps: {
      executionStartedAt: '2026-09-01T00:00:01.000Z',
      submissionCompletedAt: '2026-09-01T00:00:02.000Z',
      cleanupCompletedAt: '2026-09-01T00:00:03.000Z',
    },
    ...overrides,
  });

const archiveBucket = () => {
  const objects = new Map<string, string>();
  return {
    objects,
    bucket: {
      put: async (
        key: string,
        value: ArrayBuffer | string,
        options?: { readonly onlyIf?: { readonly etagDoesNotMatch?: string } },
      ) => {
        if (options?.onlyIf?.etagDoesNotMatch === '*' && objects.has(key)) return null;
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

const publicationKey = (runId: string, jobId = 'runner-job-1', attempt = 1) =>
  publicationRecordKey({ runId, jobId, attempt });

const claimRun = async (store: ReturnType<typeof createD1ReviewStateStore>, deliveryId: string) => {
  const claimed = await store.claimReview({
    deliveryId,
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
  if (claimed.kind !== 'claimed') throw new Error('run was not claimed');
  await claimRunnerJob(store, { runId: claimed.runId, jobId: 'runner-job-1' });
  return claimed;
};

const callbackRequest = (body: string) =>
  new Request('https://core.internal/runner-results', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-compte-rendu-runner-callback': 'verified',
    },
    body,
  });

const evidenceRequest = (body: string) =>
  new Request('https://core.internal/runner-evidence', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-compte-rendu-runner-evidence': 'verified',
    },
    body,
  });

describe('slim Runner publication callbacks', () => {
  it('publishes a slim callback and stores one small authoritative record', async () => {
    const database = new SqliteD1Database();
    const store = createD1ReviewStateStore(database);
    const claimed = await claimRun(store, 'delivery-slim-publication');
    const published: unknown[] = [];
    const bucket = archiveBucket();
    const worker = createCoreWorker(
      { ...coreEnv(database), EVIDENCE_BUCKET: bucket.bucket },
      {
        stateStore: store,
        github: {
          loadReviewTarget: async () => ({ headSha: eligibleEvent.headSha }),
          findReviewByMarker: async () => undefined,
          createReview: async (input) => {
            published.push(input);
            return { kind: 'created', review: input };
          },
        },
      },
    );
    try {
      expect((await worker.fetch(callbackRequest(slimCallback(claimed.runId)))).status).toBe(202);
      expect(published).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({
            event: 'REQUEST_CHANGES',
            commit_id: eligibleEvent.headSha,
          }),
        }),
      ]);
      expect([...bucket.objects.keys()]).toEqual([publicationKey(claimed.runId)]);
      const record = JSON.parse(bucket.objects.get(publicationKey(claimed.runId))!);
      expect(record).toMatchObject({
        version: 2,
        runId: claimed.runId,
        jobId: 'runner-job-1',
        attempt: 1,
        result,
      });
      await expect(store.getRunOutcome(claimed.runId)).resolves.toMatchObject({
        status: 'completed',
        decision: 'request_changes',
      });
    } finally {
      database.close();
    }
  });

  it.each([
    ['missing base/head', (callback: Record<string, unknown>) => delete callback.baseSha],
    ['missing head', (callback: Record<string, unknown>) => delete callback.headSha],
    [
      'a pre-v2 Markdown result',
      (callback: Record<string, unknown>) => {
        callback.result = '## Review:\n\nA legacy result.\n';
      },
    ],
    [
      'an untagged callback',
      (callback: Record<string, unknown>) => {
        delete callback.version;
      },
    ],
  ])('rejects %s before publication', async (_label, mutate) => {
    const database = new SqliteD1Database();
    const store = createD1ReviewStateStore(database);
    const claimed = await claimRun(store, 'delivery-strict-v2-callback');
    const bucket = archiveBucket();
    const published: unknown[] = [];
    const worker = createCoreWorker(
      { ...coreEnv(database), EVIDENCE_BUCKET: bucket.bucket },
      {
        stateStore: store,
        github: {
          loadReviewTarget: async () => ({ headSha: eligibleEvent.headSha }),
          createReview: async (input) => {
            published.push(input);
            return { kind: 'created', review: input };
          },
        },
      },
    );
    const callback = JSON.parse(slimCallback(claimed.runId)) as Record<string, unknown>;
    mutate(callback);
    try {
      expect((await worker.fetch(callbackRequest(JSON.stringify(callback)))).status).toBe(400);
      expect(published).toEqual([]);
      expect(bucket.objects.size).toBe(0);
      await expect(store.getRunOutcome(claimed.runId)).resolves.toMatchObject({
        status: 'scheduled',
      });
    } finally {
      database.close();
    }
  });

  it('does not let a duplicate callback replace the record claimed for publication', async () => {
    const database = new SqliteD1Database();
    const store = createD1ReviewStateStore(database);
    const claimed = await claimRun(store, 'delivery-duplicate-slim-publication');
    const bucket = archiveBucket();
    let releasePublication!: () => void;
    const publicationGate = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });
    let publicationStarted!: () => void;
    const publicationStartedPromise = new Promise<void>((resolve) => {
      publicationStarted = resolve;
    });
    const published: unknown[] = [];
    const worker = createCoreWorker(
      { ...coreEnv(database), EVIDENCE_BUCKET: bucket.bucket },
      {
        stateStore: store,
        github: {
          loadReviewTarget: async () => ({ headSha: eligibleEvent.headSha }),
          findReviewByMarker: async () => undefined,
          createReview: async (input) => {
            published.push(input);
            publicationStarted();
            await publicationGate;
            return { kind: 'created', review: input };
          },
        },
      },
    );
    try {
      const first = worker.fetch(callbackRequest(slimCallback(claimed.runId)));
      await publicationStartedPromise;
      const duplicate = await worker.fetch(
        callbackRequest(
          slimCallback(claimed.runId, {
            result: { version: 2, decision: 'approve', markdown: 'Different duplicate body.' },
          }),
        ),
      );
      expect(duplicate.status).toBe(503);
      releasePublication();
      expect((await first).status).toBe(202);
      expect(published).toHaveLength(1);
      const record = JSON.parse(bucket.objects.get(publicationKey(claimed.runId))!);
      expect(record.result).toEqual(result);
    } finally {
      releasePublication();
      database.close();
    }
  });

  it('converges concurrent callbacks on one immutable attempt record', async () => {
    const database = new SqliteD1Database();
    const store = createD1ReviewStateStore(database);
    const claimed = await claimRun(store, 'delivery-concurrent-record-race');
    const bucket = archiveBucket();
    const create = bucket.bucket.put;
    let publicationPuts = 0;
    let release!: () => void;
    const bothPuts = new Promise<void>((resolve) => {
      release = resolve;
    });
    bucket.bucket.put = async (key, value, options) => {
      if (key.includes('/publications/') && options?.onlyIf !== undefined) {
        publicationPuts += 1;
        if (publicationPuts === 2) release();
        await bothPuts;
      }
      return create(key, value, options);
    };
    const published: Array<{ payload: { event: string; commit_id: string; body: string } }> = [];
    const worker = createCoreWorker(
      { ...coreEnv(database), EVIDENCE_BUCKET: bucket.bucket },
      {
        stateStore: store,
        github: {
          loadReviewTarget: async () => ({ headSha: eligibleEvent.headSha }),
          findReviewByMarker: async () => undefined,
          createReview: async (input) => {
            published.push(input as (typeof published)[number]);
            return { kind: 'created', review: input };
          },
        },
      },
    );
    const approve = {
      version: 2 as const,
      decision: 'approve' as const,
      markdown: '## Review:\n\nNo defects found.\n',
    };
    try {
      const responses = await Promise.all([
        worker.fetch(callbackRequest(slimCallback(claimed.runId))),
        worker.fetch(callbackRequest(slimCallback(claimed.runId, { result: approve }))),
      ]);
      expect(publicationPuts).toBe(2);
      expect(responses.some((response) => response.status === 202)).toBe(true);
      expect(published).toHaveLength(1);
      const record = JSON.parse(bucket.objects.get(publicationKey(claimed.runId))!);
      expect(record.result).toEqual(published[0]!.payload.event === 'APPROVE' ? approve : result);
      expect(published[0]!.payload.body).toContain(record.result.markdown);
      await expect(store.getRunOutcome(claimed.runId)).resolves.toMatchObject({
        status: 'completed',
        decision: record.result.decision,
      });
    } finally {
      release();
      database.close();
    }
  });

  it('does not reconcile an interrupted publication from the legacy runId archive', async () => {
    const database = new SqliteD1Database();
    const store = createD1ReviewStateStore(database);
    const claimed = await claimRun(store, 'delivery-legacy-archive');
    await store.claimRunPublication({
      runId: claimed.runId,
      occurredAt: '2026-09-01T00:00:04.000Z',
      publishing: true,
    });
    const bucket = archiveBucket();
    const manifest = await evidenceField(
      JSON.stringify({
        result,
        jobId: 'runner-job-1',
        runId: claimed.runId,
        attempt: 1,
        evidenceId: 'evidence-1',
        sessionIds: [],
        terminal: { status: 'succeeded' },
        evidence: { id: 'evidence-1', status: 'complete' },
        complete: true,
        cleanup: { status: 'destroyed' },
      }),
    );
    const validatedReview = await evidenceField(result.markdown);
    const archive = JSON.stringify({
      version: 1,
      runId: claimed.runId,
      jobId: 'runner-job-1',
      evidence: { manifest, validatedReview },
    });
    const archiveField = await evidenceField(archive);
    const legacyKey = `reviews/${claimed.runId}`;
    bucket.objects.set(legacyKey, archive);
    await store.recordEvidenceUpload({
      runId: claimed.runId,
      jobId: 'runner-job-1',
      attempt: 1,
      evidence: {
        key: legacyKey,
        status: 'complete',
        size: archiveField.size,
        sha256: archiveField.sha256,
        uploadedAt: '2026-09-01T00:00:03.000Z',
      },
    });
    const markerLookups: unknown[] = [];
    const publications: unknown[] = [];
    const worker = createCoreWorker(
      { ...coreEnv(database), EVIDENCE_BUCKET: bucket.bucket },
      {
        stateStore: store,
        github: {
          loadReviewTarget: async () => ({ headSha: eligibleEvent.headSha }),
          findReviewByMarker: async (input) => {
            markerLookups.push(input);
            return { id: 99 };
          },
          createReview: async (input) => {
            publications.push(input);
            return { kind: 'created', review: input };
          },
        },
      },
    );
    try {
      await expect(
        worker.reconcilePublications(Date.parse('2026-09-01T02:00:00.000Z')),
      ).rejects.toThrow();
      expect(markerLookups).toEqual([]);
      expect(publications).toEqual([]);
      await expect(store.getRunOutcome(claimed.runId)).resolves.toMatchObject({
        status: 'scheduled',
      });
    } finally {
      database.close();
    }
  });

  it('keeps the callback retryable when the necessary publication record write fails', async () => {
    const database = new SqliteD1Database();
    const store = createD1ReviewStateStore(database);
    const claimed = await claimRun(store, 'delivery-record-write-retry');
    const bucket = archiveBucket();
    const create = bucket.bucket.put;
    let unavailable = true;
    bucket.bucket.put = async (key, value, options) => {
      if (unavailable && key.includes('/publications/'))
        throw new Error('publication R2 unavailable');
      return create(key, value, options);
    };
    const published: unknown[] = [];
    const worker = createCoreWorker(
      { ...coreEnv(database), EVIDENCE_BUCKET: bucket.bucket },
      {
        stateStore: store,
        github: {
          loadReviewTarget: async () => ({ headSha: eligibleEvent.headSha }),
          createReview: async (input) => {
            published.push(input);
            return { kind: 'created', review: input };
          },
        },
      },
    );
    try {
      const body = slimCallback(claimed.runId);
      expect((await worker.fetch(callbackRequest(body))).status).toBe(503);
      expect(published).toEqual([]);
      expect(bucket.objects.size).toBe(0);
      await expect(store.getRunOutcome(claimed.runId)).resolves.toMatchObject({
        status: 'scheduled',
      });
      unavailable = false;
      expect((await worker.fetch(callbackRequest(body))).status).toBe(202);
      expect(published).toHaveLength(1);
      expect(bucket.objects.has(publicationKey(claimed.runId))).toBe(true);
      await expect(store.getRunOutcome(claimed.runId)).resolves.toMatchObject({
        status: 'completed',
      });
    } finally {
      database.close();
    }
  });

  it('reconciles an interrupted publication from the small record without a diagnostic archive', async () => {
    const database = new SqliteD1Database();
    const store = createD1ReviewStateStore(database);
    const claimed = await claimRun(store, 'delivery-reconcile-small-record');
    await store.claimRunPublication({
      runId: claimed.runId,
      occurredAt: '2026-09-01T00:00:04.000Z',
      publishing: true,
    });
    const bucket = archiveBucket();
    bucket.objects.set(
      publicationKey(claimed.runId),
      JSON.stringify({
        version: 2,
        runId: claimed.runId,
        jobId: 'runner-job-1',
        attempt: 1,
        result,
      }),
    );
    const markerLookups: unknown[] = [];
    const publications: unknown[] = [];
    const worker = createCoreWorker(
      {
        ...coreEnv(database),
        EVIDENCE_BUCKET: bucket.bucket,
      },
      {
        stateStore: store,
        github: {
          loadReviewTarget: async () => ({ headSha: eligibleEvent.headSha }),
          findReviewByMarker: async (input) => {
            markerLookups.push(input);
            return { id: 99 };
          },
          createReview: async (input) => {
            publications.push(input);
            return { kind: 'created', review: input };
          },
        },
      },
    );
    try {
      await worker.reconcilePublications(Date.parse('2026-09-01T02:00:00.000Z'));
      expect(markerLookups).toEqual([
        {
          repositoryId: 11,
          pullRequestNumber: 42,
          installationId: 7,
          marker: `<!-- compte-rendu:run:${claimed.runId} -->`,
          expected: { headSha: eligibleEvent.headSha, event: 'REQUEST_CHANGES' },
        },
      ]);
      expect(publications).toEqual([]);
      await expect(store.getRunOutcome(claimed.runId)).resolves.toMatchObject({
        status: 'completed',
        decision: 'request_changes',
      });
    } finally {
      database.close();
    }
  });

  it('refuses a stale publication record for a non-current attempt', async () => {
    const database = new SqliteD1Database();
    const store = createD1ReviewStateStore(database);
    const claimed = await claimRun(store, 'delivery-reconcile-stale-record');
    await store.claimRunPublication({
      runId: claimed.runId,
      occurredAt: '2026-09-01T00:00:04.000Z',
      publishing: true,
    });
    const bucket = archiveBucket();
    bucket.objects.set(
      publicationKey(claimed.runId, 'runner-job-1', 2),
      JSON.stringify({
        version: 2,
        runId: claimed.runId,
        jobId: 'runner-job-1',
        attempt: 2,
        result,
      }),
    );
    const publications: unknown[] = [];
    const worker = createCoreWorker(
      { ...coreEnv(database), EVIDENCE_BUCKET: bucket.bucket },
      {
        stateStore: store,
        github: {
          loadReviewTarget: async () => ({ headSha: eligibleEvent.headSha }),
          findReviewByMarker: async () => undefined,
          createReview: async (input) => {
            publications.push(input);
            return { kind: 'created', review: input };
          },
        },
      },
    );
    try {
      await expect(
        worker.reconcilePublications(Date.parse('2026-09-01T02:00:00.000Z')),
      ).rejects.toThrow();
      expect(publications).toEqual([]);
      await expect(store.getRunOutcome(claimed.runId)).resolves.toMatchObject({
        status: 'scheduled',
      });
    } finally {
      database.close();
    }
  });
});

describe('private Runner evidence upload', () => {
  it('stores a late v2 archive and its D1 metadata without publishing', async () => {
    const database = new SqliteD1Database();
    const store = createD1ReviewStateStore(database);
    const claimed = await claimRun(store, 'delivery-evidence-upload');
    const bucket = archiveBucket();
    const published: unknown[] = [];
    const worker = createCoreWorker(
      { ...coreEnv(database), EVIDENCE_BUCKET: bucket.bucket },
      {
        stateStore: store,
        github: {
          loadReviewTarget: async () => ({ headSha: eligibleEvent.headSha }),
          createReview: async (input) => {
            published.push(input);
            return { kind: 'created', review: input };
          },
        },
      },
    );
    try {
      expect((await worker.fetch(callbackRequest(slimCallback(claimed.runId)))).status).toBe(202);
      expect(published).toHaveLength(1);
      await expect(store.getRunOutcome(claimed.runId)).resolves.toMatchObject({
        status: 'completed',
      });

      const response = await worker.fetch(
        evidenceRequest(
          await evidenceUpload(claimed.runId, {
            timestamps: {
              executionStartedAt: '2026-09-01T09:00:01.000Z',
              submissionCompletedAt: '2026-09-01T09:00:02.000Z',
              cleanupCompletedAt: '2026-09-01T09:00:03.000Z',
            },
          }),
        ),
      );
      expect(response.status).toBe(202);
      const outcome = await store.getRunOutcome(claimed.runId);
      expect(outcome?.evidence).toMatchObject({
        key: expect.stringMatching(
          new RegExp(`^reviews/${claimed.runId}/diagnostics/runner-job-1/1/[0-9a-f]{64}\\.json$`),
        ),
        status: 'complete',
        size: expect.any(Number),
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        executionStartedAt: '2026-09-01T00:00:01.000Z',
        submissionCompletedAt: '2026-09-01T00:00:02.000Z',
        cleanupCompletedAt: '2026-09-01T00:00:03.000Z',
      });
      const archived = JSON.parse(bucket.objects.get(outcome!.evidence!.key)!);
      expect(archived).toMatchObject({
        version: 2,
        runId: claimed.runId,
        jobId: 'runner-job-1',
        attempt: 1,
        evidenceId: 'evidence-1',
        evidence: { status: 'complete' },
      });
      expect(archived.timestamps).toEqual({
        executionStartedAt: '2026-09-01T09:00:01.000Z',
        submissionCompletedAt: '2026-09-01T09:00:02.000Z',
        cleanupCompletedAt: '2026-09-01T09:00:03.000Z',
      });
      expect(published).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it('keeps a late old-attempt archive from replacing the current attempt archive', async () => {
    const database = new SqliteD1Database();
    const store = createD1ReviewStateStore(database);
    const claimed = await claimRun(store, 'delivery-evidence-attempt-race');
    const bucket = archiveBucket();
    const create = bucket.bucket.put;
    let oldPutReached!: () => void;
    const oldPutStarted = new Promise<void>((resolve) => {
      oldPutReached = resolve;
    });
    let releaseOldPut!: () => void;
    const oldPutGate = new Promise<void>((resolve) => {
      releaseOldPut = resolve;
    });
    bucket.bucket.put = async (key, value, options) => {
      if (key.includes('/runner-job-1/1/')) {
        oldPutReached();
        await oldPutGate;
      }
      return create(key, value, options);
    };
    const worker = createCoreWorker(
      { ...coreEnv(database), EVIDENCE_BUCKET: bucket.bucket },
      { stateStore: store },
    );
    try {
      const oldUpload = worker.fetch(evidenceRequest(await evidenceUpload(claimed.runId)));
      await oldPutStarted;

      await database
        .prepare('UPDATE review_runs SET runner_job_id = ?, runner_attempt = ? WHERE run_id = ?')
        .bind('runner-job-2', 2, claimed.runId)
        .run();
      const newer = JSON.parse(await evidenceUpload(claimed.runId)) as {
        id: string;
        attempt: number;
        evidence: { validatedReview: { content: string; size: number; sha256: string } };
      };
      newer.id = 'runner-job-2';
      newer.attempt = 2;
      newer.evidence.validatedReview = await evidenceField('new attempt review');
      const newerResponse = await worker.fetch(evidenceRequest(JSON.stringify(newer)));
      expect(newerResponse.status).toBe(202);
      const current = await store.getRunOutcome(claimed.runId);
      const currentKey = current?.evidence?.key;
      expect(currentKey).toMatch(
        new RegExp(`^reviews/${claimed.runId}/diagnostics/runner-job-2/2/[0-9a-f]{64}\\.json$`),
      );

      releaseOldPut();
      expect((await oldUpload).status).toBe(409);

      const final = await store.getRunOutcome(claimed.runId);
      expect(final?.evidence?.key).toBe(currentKey);
      const currentArchive = JSON.parse(bucket.objects.get(currentKey!)!);
      expect(currentArchive).toMatchObject({ jobId: 'runner-job-2', attempt: 2 });
      expect(
        Buffer.from(currentArchive.evidence.validatedReview.content, 'base64').toString(),
      ).toBe('new attempt review');
      expect(
        [...bucket.objects.keys()].filter((key) => key.includes('/diagnostics/')),
      ).toHaveLength(2);
    } finally {
      releaseOldPut();
      database.close();
    }
  });

  it('rejects unauthorized, oversized, malformed, and non-current uploads without changing publication', async () => {
    const database = new SqliteD1Database();
    const store = createD1ReviewStateStore(database);
    const claimed = await claimRun(store, 'delivery-evidence-bounds');
    const bucket = archiveBucket();
    const worker = createCoreWorker(
      { ...coreEnv(database), EVIDENCE_BUCKET: bucket.bucket },
      { stateStore: store },
    );
    try {
      expect(
        (
          await worker.fetch(
            new Request('https://core.internal/runner-evidence', {
              method: 'POST',
              headers: { 'x-compte-rendu-runner-evidence': 'verified' },
              body: new Uint8Array(MAX_RUNNER_EVIDENCE_BYTES + 1),
            }),
          )
        ).status,
      ).toBe(413);
      expect((await worker.fetch(evidenceRequest('{'))).status).toBe(400);
      expect(
        (await worker.fetch(evidenceRequest(await evidenceUpload(claimed.runId, { attempt: 2 }))))
          .status,
      ).toBe(409);
      const missingIdentity = JSON.parse(await evidenceUpload(claimed.runId)) as Record<
        string,
        unknown
      >;
      delete missingIdentity.evidenceId;
      expect((await worker.fetch(evidenceRequest(JSON.stringify(missingIdentity)))).status).toBe(
        400,
      );
      expect(bucket.objects.size).toBe(0);
      await expect(store.getRunOutcome(claimed.runId)).resolves.toMatchObject({
        status: 'scheduled',
      });
    } finally {
      database.close();
    }
  });

  it('keeps publication independent when the archive write fails', async () => {
    const database = new SqliteD1Database();
    const store = createD1ReviewStateStore(database);
    const claimed = await claimRun(store, 'delivery-evidence-unavailable');
    const bucket = archiveBucket();
    const create = bucket.bucket.put;
    bucket.bucket.put = async (key, value, options) => {
      if (key.includes('/diagnostics/')) throw new Error('R2 diagnostic write unavailable');
      return create(key, value, options);
    };
    const worker = createCoreWorker(
      { ...coreEnv(database), EVIDENCE_BUCKET: bucket.bucket },
      {
        stateStore: store,
        github: {
          loadReviewTarget: async () => ({ headSha: eligibleEvent.headSha }),
          createReview: async (input) => ({ kind: 'created', review: input }),
        },
      },
    );
    try {
      expect((await worker.fetch(callbackRequest(slimCallback(claimed.runId)))).status).toBe(202);
      expect(
        (await worker.fetch(evidenceRequest(await evidenceUpload(claimed.runId)))).status,
      ).toBe(503);
      await expect(store.getRunOutcome(claimed.runId)).resolves.toMatchObject({
        status: 'completed',
      });
    } finally {
      database.close();
    }
  });
});
