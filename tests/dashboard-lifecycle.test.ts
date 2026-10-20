import { expect, it, vi } from 'vitest';
import { createCoreWorker } from '../apps/core/src/core-worker';
import { createD1ReviewStateStore, createReviewCoordinator } from '../apps/core/src/index';
import { SqliteD1Database } from './support/d1-database';

const time = (seconds: number) => `2026-01-01T00:00:${String(seconds).padStart(2, '0')}.000Z`;
const fixture = async (claim = true) => {
  const database = new SqliteD1Database();
  const store = createD1ReviewStateStore(database);
  const review = await store.claimReview({
    deliveryId: 'lifecycle',
    occurredAt: time(0),
    job: {
      repositoryId: 11,
      pullRequestNumber: 42,
      installationId: 7,
      baseSha: '1'.repeat(40),
      headSha: '2'.repeat(40),
      trigger: 'automatic',
    },
  });
  if (review.kind !== 'claimed') throw new Error('not admitted');
  if (claim) await store.claimNextJob!({ jobId: 'runner-job', attempt: 1, occurredAt: time(1) });
  const identity = { runId: review.runId, jobId: 'runner-job', attempt: 1 };
  const detail = async () => {
    const worker = createCoreWorker({
      REVIEW_DB: database,
      GITHUB_APP_ID: '1',
      GITHUB_APP_PRIVATE_KEY: 'unused',
      RUNNER_AUTH_TOKEN: 'unused',
    });
    return (
      await worker.fetch(new Request(`https://core.internal/api/jobs/${review.runId}`))
    ).json();
  };
  return { database, store, identity, detail };
};

it('retains newer progress and immutable milestones when a terminal snapshot races it', async () => {
  const { store, identity, detail } = await fixture();
  await Promise.all([
    store.recordProgress!({
      ...identity,
      receivedAt: time(5),
      sequence: 3,
      stage: 'agent',
      milestones: [
        { stage: 'checkout', startedAt: time(1) },
        { stage: 'sandbox', startedAt: time(2) },
        { stage: 'agent', startedAt: time(3) },
      ],
    }),
    store.recordTerminalLifecycle!({
      ...identity,
      receivedAt: time(6),
      sequence: 1,
      stage: 'checkout',
      milestones: [{ stage: 'checkout', startedAt: time(4) }],
    }),
  ]);
  expect(await detail()).toMatchObject({
    task: { stage: 'agent' },
    milestones: [
      { stage: 'checkout', startedAt: time(1) },
      { stage: 'sandbox', startedAt: time(2) },
      { stage: 'agent', startedAt: time(3) },
    ],
  });
});

it('persists bounded failure categories and keeps the first terminal time', async () => {
  const { store, identity, detail } = await fixture();
  await store.markSchedulingFailed({
    runId: identity.runId,
    occurredAt: time(10),
    failure: { phase: 'sandbox', reason: 'timeout' },
  });
  await store.markSchedulingFailed({
    runId: identity.runId,
    occurredAt: time(20),
    failure: { phase: 'publication', reason: 'unknown' },
  });
  expect(await detail()).toMatchObject({
    task: {
      status: 'failed',
      terminalAt: time(10),
      failure: { phase: 'sandbox', reason: 'timeout' },
    },
  });
});

it('shows durable result receipt and publication milestones without inventing execution stages', async () => {
  const { store, identity, detail } = await fixture();
  await store.recordResultReceived!({ ...identity, occurredAt: time(8) });
  expect(await detail()).toMatchObject({
    task: { processing: 'received', resultReceivedAt: time(8), publicationStartedAt: null },
  });
  await store.claimRunPublication!({
    runId: identity.runId,
    occurredAt: time(9),
    publishing: true,
  });
  expect(await detail()).toMatchObject({
    task: { processing: 'publishing', publicationStartedAt: time(9) },
    processingMilestones: [
      { stage: 'received', startedAt: time(8) },
      { stage: 'publishing', startedAt: time(9) },
    ],
  });
  await store.markRunCompleted({ runId: identity.runId, occurredAt: time(10) });
  expect(await detail()).toMatchObject({
    task: { processing: null, resultReceivedAt: time(8), publicationStartedAt: time(9) },
  });
});

it('counts the received cohort and independently overlapping cleanup attention', async () => {
  const { store, identity } = await fixture();
  await store.markRunCompleted({ runId: identity.runId, occurredAt: '2026-01-03T00:00:00.000Z' });
  expect(
    (
      await store.getPublicOverview!({
        limit: 25,
        since: '2026-01-02T12:00:00.000Z',
      })
    ).counts,
  ).toEqual({ queued: 0, claimed: 0, publishedLast24h: 0, failedLast24h: 0, cleanupAttention: 1 });
});

it('projects an authenticated failed callback through a fresh dashboard worker', async () => {
  const { database, identity, detail } = await fixture();
  const empty = {
    content: '',
    size: 0,
    sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  };
  const worker = createCoreWorker(
    {
      REVIEW_DB: database,
      GITHUB_APP_ID: '1',
      GITHUB_APP_PRIVATE_KEY: 'unused',
      EVIDENCE_BUCKET: { put: async () => undefined },
    },
    { github: {} },
  );
  const response = await worker.fetch(
    new Request('https://core.internal/runner-results', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-compte-rendu-runner-callback': 'verified' },
      body: JSON.stringify({
        id: identity.jobId,
        runId: identity.runId,
        attempt: 1,
        status: 'failed',
        stage: 'cleanup',
        sandbox: { cleanup: 'destroyed' },
        evidence: {
          id: 'evidence',
          status: 'incomplete',
          manifest: empty,
          opencodeJsonl: empty,
          opencodeStderr: empty,
        },
        timestamps: {},
        failure: { reason: 'invalid-output' },
      }),
    }),
  );
  expect(response.status).toBe(202);
  expect(await detail()).toMatchObject({
    task: {
      status: 'failed',
      failure: { phase: 'output_validation', reason: 'invalid_output' },
      resultReceivedAt: expect.any(String),
      cleanup: 'destroyed',
      processing: null,
    },
  });
});

it('does not advance a live report that changes an already recorded milestone', async () => {
  const { store, identity, detail } = await fixture();
  await store.recordProgress!({
    ...identity,
    receivedAt: time(2),
    sequence: 1,
    stage: 'checkout',
    milestones: [{ stage: 'checkout', startedAt: time(1) }],
  });
  expect(
    await store.recordProgress!({
      ...identity,
      receivedAt: time(5),
      sequence: 2,
      stage: 'agent',
      milestones: [
        { stage: 'checkout', startedAt: time(3) },
        { stage: 'agent', startedAt: time(4) },
      ],
    }),
  ).toBe(false);
  expect(await detail()).toMatchObject({
    task: { stage: 'checkout' },
    milestones: [{ stage: 'checkout', startedAt: time(1) }],
  });
});

it.each(['complete', 'publication', 'fail', 'supersede', 'replace'] as const)(
  'persists immutable terminal time through the %s path',
  async (path) => {
    const { store, identity, detail } = await fixture(path !== 'replace');
    const terminal = { runId: identity.runId, occurredAt: time(10) };
    if (path === 'complete') await store.markRunCompleted(terminal);
    if (path === 'publication')
      await store.completeRunPublication!({ ...terminal, fingerprints: [] });
    if (path === 'fail') await store.markSchedulingFailed(terminal);
    if (path === 'supersede') await store.markRunSuperseded(terminal);
    if (path === 'replace')
      await store.claimReview({
        deliveryId: 'replacement',
        occurredAt: time(10),
        job: {
          repositoryId: 11,
          pullRequestNumber: 42,
          installationId: 7,
          baseSha: '1'.repeat(40),
          headSha: '3'.repeat(40),
          trigger: 'automatic',
        },
      });
    expect(await detail()).toMatchObject({
      task: {
        terminalAt: time(10),
        status:
          path === 'complete' || path === 'publication'
            ? 'completed'
            : path === 'fail'
              ? 'failed'
              : 'superseded',
      },
    });
    await store.markRunCompleted({ ...terminal, occurredAt: time(20) });
    await store.markRunSuperseded({ ...terminal, occurredAt: time(20) });
    await store.markSchedulingFailed({ ...terminal, occurredAt: time(20) });
    expect(await detail()).toMatchObject({ task: { terminalAt: time(10) } });
  },
);

it('records publication start and completion at their actual transitions', async () => {
  const { store, identity, detail } = await fixture();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(time(5)));
  try {
    const coordinator = createReviewCoordinator({
      stateStore: store,
      scheduler: { schedule: async () => undefined },
      github: {
        loadReviewTarget: async () => {
          vi.setSystemTime(new Date(time(10)));
          return { headSha: '2'.repeat(40), files: [] };
        },
        createReview: async () => {
          vi.setSystemTime(new Date(time(20)));
          return { kind: 'created', review: {} };
        },
      },
    });
    expect(
      await coordinator.completeReview({
        runId: identity.runId,
        output: '## Review: No actionable findings.',
      }),
    ).toBe('completed');
    expect(await detail()).toMatchObject({
      task: { publicationStartedAt: time(10), terminalAt: time(20) },
    });
  } finally {
    vi.useRealTimers();
  }
});

it('serves every public query without contacting GitHub or Runner', async () => {
  const { database, identity } = await fixture();
  let externalRequests = 0;
  const forbidden = async (): Promise<never> => {
    externalRequests += 1;
    throw new Error('external read forbidden');
  };
  const worker = createCoreWorker(
    {
      REVIEW_DB: database,
      GITHUB_APP_ID: '1',
      GITHUB_APP_PRIVATE_KEY: 'unused',
      RUNNER: { fetch: forbidden },
    },
    {
      github: {
        getRepositoryMetadata: forbidden,
        getRepositoryUrl: forbidden,
        getPullRequest: forbidden,
      },
    },
  );
  for (const path of ['/api/dashboard', '/api/jobs', `/api/jobs/${identity.runId}`]) {
    const response = await worker.fetch(new Request(`https://core.internal${path}`));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.text();
    expect(body).not.toContain('repositoryId');
    expect(body).not.toContain('installationId');
  }
  expect(externalRequests).toBe(0);
});

it('records pre-handoff failure at the failure time rather than the earlier claim time', async () => {
  const { database, detail } = await fixture(false);
  vi.useFakeTimers();
  vi.setSystemTime(new Date(time(5)));
  try {
    const worker = createCoreWorker(
      { REVIEW_DB: database, GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: 'unused' },
      {
        github: {
          getRepositoryUrl: async () => {
            vi.setSystemTime(new Date(time(10)));
            throw new Error('lookup unavailable');
          },
        },
      },
    );
    expect(
      (
        await worker.fetch(
          new Request('https://core.internal/runner-claims', {
            method: 'POST',
            headers: { 'x-compte-rendu-runner-claim': 'verified' },
          }),
        )
      ).status,
    ).toBe(503);
    expect(await detail()).toMatchObject({
      task: { claimedAt: time(5), terminalAt: time(10), status: 'failed' },
    });
  } finally {
    vi.useRealTimers();
  }
});

it('does not report fresh progress when a terminal snapshot is repeated', async () => {
  const { store, identity, detail } = await fixture();
  const snapshot = {
    ...identity,
    sequence: 1,
    stage: 'checkout' as const,
    milestones: [{ stage: 'checkout' as const, startedAt: time(1) }],
  };
  await store.recordTerminalLifecycle!({ ...snapshot, receivedAt: time(2) });
  await store.recordTerminalLifecycle!({ ...snapshot, receivedAt: time(10) });
  expect(await detail()).toMatchObject({ task: { lastProgressAt: time(2) } });
});

it('retains callback observation times after supersession without treating cleanup finish as success', async () => {
  const { store, identity, detail } = await fixture();
  await store.markRunSuperseded({ runId: identity.runId, occurredAt: time(10) });
  await store.recordEvidence({
    runId: identity.runId,
    sandboxCleanup: 'failed',
    evidence: {
      key: `reviews/${identity.runId}`,
      status: 'incomplete',
      size: 1,
      sha256: 'a'.repeat(64),
      uploadedAt: time(25),
      executionStartedAt: time(2),
      submissionCompletedAt: time(8),
      cleanupCompletedAt: time(20),
    },
  });
  expect(await detail()).toMatchObject({
    task: {
      status: 'superseded',
      terminalAt: time(10),
      cleanup: 'failed',
      executionStartedAt: time(2),
      submissionCompletedAt: time(8),
      cleanupCompletedAt: time(20),
    },
  });
});

it('does not disclose arbitrary callback strings as public observation timestamps', async () => {
  const { store, identity, detail } = await fixture();
  await store.recordEvidence({
    runId: identity.runId,
    evidence: {
      key: `reviews/${identity.runId}`,
      status: 'incomplete',
      size: 1,
      sha256: 'a'.repeat(64),
      uploadedAt: time(25),
      executionStartedAt: 'private callback diagnostic',
      submissionCompletedAt: 'secret-like fixture',
      cleanupCompletedAt: time(20),
    },
  });
  const result = await detail();
  expect(result).toMatchObject({
    task: { executionStartedAt: null, submissionCompletedAt: null, cleanupCompletedAt: time(20) },
  });
  expect(JSON.stringify(result)).not.toContain('private callback diagnostic');
  expect(JSON.stringify(result)).not.toContain('secret-like fixture');
});
