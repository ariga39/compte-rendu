import { describe, expect, it } from 'vitest';
import {
  createCoreWorker,
  runScheduledMetadataRefresh,
  type CoreWorkerEnv,
} from '../apps/core/src/core-worker';
import {
  createD1ReviewStateStore,
  createGitHubPublicationAdapter,
  type D1ReviewStateStore,
  type ReviewPublicationStateStore,
} from '../apps/core/src/index';
import { GitHubRequestError } from '../apps/core/src/github-review-adapter';
import { createGitHubAppTokenProvider } from '../apps/core/src/github-app-token';
import { refreshRepositoryMetadata } from '../apps/core/src/dashboard';
import type { OperationalLogEvent } from '../packages/contracts/src';
import coreWorker from '../apps/core/src/worker';
import { createIngressWorker } from '../apps/ingress/src/index';
import { SqliteD1Database } from './support/d1-database';

const coreEnv = (database: SqliteD1Database): CoreWorkerEnv => ({
  REVIEW_DB: database,
  GITHUB_APP_ID: '1',
  GITHUB_APP_PRIVATE_KEY: 'test-private-key',
  RUNNER_AUTH_TOKEN: 'test-runner-token',
});

const job = (overrides: Record<string, unknown> = {}) => ({
  repositoryId: 11,
  pullRequestNumber: 42,
  installationId: 7,
  baseSha: '1'.repeat(40),
  headSha: '2'.repeat(40),
  trigger: 'automatic' as const,
  repositoryVisibility: 'public' as const,
  ...overrides,
});

const get = (worker: ReturnType<typeof createCoreWorker>, path: string) =>
  worker.fetch(new Request(`https://core.internal${path}`));

const verifyMetadata = async (
  store: D1ReviewStateStore,
  installationId: number,
  repositoryId: number,
  visibility: 'public' | 'private',
) => {
  const due = await store.listDueRepositoryMetadata!({
    now: '2026-01-01T00:00:00.000Z',
    limit: 50,
  });
  const row = due.find(
    (entry) => entry.repositoryId === repositoryId && entry.installationId === installationId,
  );
  if (row === undefined) throw new Error('metadata row missing');
  await store.claimRepositoryRefresh!({
    installationId,
    repositoryId,
    expectedRevision: row.revision,
    claimedAt: '2026-01-01T00:00:00.000Z',
    staleBefore: '2026-01-01T00:00:00.000Z',
  });
  await store.recordRepositoryRefresh!({
    installationId,
    repositoryId,
    expectedRevision: row.revision,
    claimedAt: '2026-01-01T00:00:00.000Z',
    fullName: 'acme/reviewed',
    visibility,
    verifiedAt: '2026-01-01T00:00:00.000Z',
    identityExpiresAt: '2999-01-01T00:00:00.000Z',
    nextRefreshAt: '2026-01-01T00:02:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
};

const asJson = async <T>(response: Response): Promise<T> => (await response.json()) as T;

describe('public dashboard reads are DB-only', () => {
  it('returns counts and current rows together while a run finishes', async () => {
    const database = new SqliteD1Database();
    const store = createD1ReviewStateStore(database);
    const claimed = await store.claimReview({
      deliveryId: 'snapshot-run',
      job: job({ repositoryVisibility: 'private' }),
      occurredAt: new Date().toISOString(),
    });
    if (claimed.kind !== 'claimed') throw new Error('not claimed');
    const worker = createCoreWorker(coreEnv(database));
    const before = await (await get(worker, '/api/dashboard')).json();
    expect(before).toMatchObject({
      counts: { queued: 1 },
      tasks: [{ runId: claimed.runId, identity: { kind: 'anonymous' } }],
      nextCursor: null,
    });
    const [response] = await Promise.all([
      get(worker, '/api/dashboard'),
      store.completeRunPublication({
        runId: claimed.runId,
        occurredAt: new Date().toISOString(),
        fingerprints: [],
      }),
    ]);
    const snapshot = await asJson<{
      counts: { queued: number };
      tasks: { status: string; dispatch: string }[];
    }>(response);
    expect(snapshot.counts.queued).toBe(
      snapshot.tasks.filter((task) => task.status === 'scheduled' && task.dispatch === 'queued')
        .length,
    );
    expect(await (await get(worker, '/api/dashboard')).json()).toMatchObject({
      counts: { queued: 0, publishedLast24h: 1 },
      tasks: [],
    });
    database.close();
  });

  it('keeps overview counts complete while paginating current rows with anonymous identities', async () => {
    const database = new SqliteD1Database();
    const store = createD1ReviewStateStore(database);
    for (let index = 0; index < 26; index += 1) {
      await store.claimReview({
        deliveryId: `snapshot-page-${index}`,
        job: job({ repositoryId: 1000 + index, repositoryVisibility: 'private' }),
        occurredAt: new Date(Date.now() + index).toISOString(),
      });
    }
    const worker = createCoreWorker(coreEnv(database));
    const first = await asJson<{
      counts: { queued: number };
      tasks: { runId: string; identity: { kind: string } }[];
      nextCursor: string;
    }>(await get(worker, '/api/dashboard'));
    expect(first.counts.queued).toBe(26);
    expect(first.tasks).toHaveLength(25);
    expect(first.tasks.every((task) => task.identity.kind === 'anonymous')).toBe(true);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await asJson<{ tasks: { runId: string }[]; nextCursor: null }>(
      await get(worker, `/api/jobs?view=current&cursor=${encodeURIComponent(first.nextCursor)}`),
    );
    expect(second.tasks).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(first.tasks.map((task) => task.runId)).not.toContain(second.tasks[0]?.runId);
    expect(
      (await get(worker, `/api/jobs?cursor=${encodeURIComponent(first.nextCursor)}`)).status,
    ).toBe(400);
    database.close();
  });

  it('retains an explicit decision through a fresh Worker without inventing historical votes', async () => {
    const database = new SqliteD1Database();
    const store = createD1ReviewStateStore(database);
    const claimed = await store.claimReview({
      deliveryId: 'decision-run',
      job: job(),
      occurredAt: '2026-01-01T00:00:00.000Z',
    });
    if (claimed.kind !== 'claimed') throw new Error('not claimed');
    const worker = createCoreWorker(coreEnv(database));
    expect(await (await get(worker, `/api/jobs/${claimed.runId}`)).json()).toMatchObject({
      task: { decision: null },
    });
    await store.completeRunPublication({
      runId: claimed.runId,
      occurredAt: '2026-01-01T00:01:00.000Z',
      fingerprints: [],
      decision: 'request_changes',
    });
    const fresh = createCoreWorker(coreEnv(database));
    expect(await (await get(fresh, `/api/jobs/${claimed.runId}`)).json()).toMatchObject({
      task: { status: 'completed', decision: 'request_changes', identity: { kind: 'anonymous' } },
    });
  });

  it('shows public repository identity and hides a known-private run as anonymous', async () => {
    const database = new SqliteD1Database();
    const store = createD1ReviewStateStore(database);
    const publicReview = await store.claimReview({
      deliveryId: 'd-public',
      job: job(),
      occurredAt: '2026-01-01T00:00:00.000Z',
    });
    const privateReview = await store.claimReview({
      deliveryId: 'd-private',
      job: job({ repositoryId: 12, repositoryVisibility: 'private' }),
      occurredAt: '2026-01-01T00:00:00.000Z',
    });
    expect(publicReview.kind).toBe('claimed');
    expect(privateReview.kind).toBe('claimed');
    await verifyMetadata(store, 7, 11, 'public');
    await verifyMetadata(store, 7, 12, 'public');

    const worker = createCoreWorker(coreEnv(database));
    const response = await get(worker, '/api/jobs');
    expect(response.status).toBe(200);
    const page = await asJson<{
      tasks: {
        runId: string;
        identity: { kind: string; repositoryFullName?: string; pullRequestNumber?: number };
      }[];
    }>(response);
    const publicTask = page.tasks.find((task) => task.runId === publicReview.runId);
    const privateTask = page.tasks.find((task) => task.runId === privateReview.runId);
    expect(publicTask?.identity).toMatchObject({
      kind: 'public',
      repositoryFullName: 'acme/reviewed',
      pullRequestNumber: 42,
    });
    expect(privateTask?.identity).toEqual({ kind: 'anonymous' });
    expect(JSON.stringify(page)).not.toContain('repositoryId');
  });

  it('persists admission branch refs and exposes them only through public identity', async () => {
    const database = new SqliteD1Database();
    const store = createD1ReviewStateStore(database);
    const worker = createCoreWorker(coreEnv(database), { github: {} });
    const post = (body: unknown) =>
      worker.fetch(
        new Request('https://core.internal/review-events', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
    const event = (overrides: Record<string, unknown>) => ({
      deliveryId: 'd-refs',
      event: 'pull_request',
      action: 'opened',
      pullRequestNumber: 42,
      installationId: 7,
      draft: false,
      baseSha: '1'.repeat(40),
      headSha: '2'.repeat(40),
      baseRef: 'main',
      headRef: 'feature/drawer',
      ...overrides,
    });
    expect(
      (
        await post(
          event({
            deliveryId: 'd-refs-public',
            repositoryId: 500,
            repositoryVisibility: 'public',
            baseRepositoryId: 500,
            headRepositoryId: 500,
          }),
        )
      ).status,
    ).toBe(202);
    expect(
      (
        await post(
          event({
            deliveryId: 'd-refs-private',
            pullRequestNumber: 43,
            repositoryId: 501,
            repositoryVisibility: 'private',
            baseRepositoryId: 501,
            headRepositoryId: 599,
            headRef: 'feature/secret',
          }),
        )
      ).status,
    ).toBe(202);
    const queue = createD1ReviewStateStore(database);
    const claims = [];
    for (const jobId of ['branch-claim-1', 'branch-claim-2']) {
      claims.push(
        await queue.claimNextJob!({ jobId, attempt: 1, occurredAt: new Date().toISOString() }),
      );
    }
    const privateClaim = claims.find(
      (claim) => claim.kind === 'claimed' && claim.job.repositoryId === 501,
    );
    expect(privateClaim).toMatchObject({
      kind: 'claimed',
      job: { baseRef: 'main', headRef: 'feature/secret' },
    });

    await verifyMetadata(store, 7, 500, 'public');
    await verifyMetadata(store, 7, 501, 'public');

    const reader = createCoreWorker(coreEnv(database));
    const page = await asJson<{
      tasks: { runId: string; identity: Record<string, unknown> }[];
    }>(await get(reader, '/api/jobs'));
    const publicTask = page.tasks.find((task) => task.identity.kind === 'public');
    const privateTask = page.tasks.find((task) => task.identity.kind === 'anonymous');
    expect(publicTask?.identity).toMatchObject({
      kind: 'public',
      baseRef: 'main',
      headRef: 'feature/drawer',
      baseSha: '1'.repeat(40),
      headSha: '2'.repeat(40),
    });
    expect(privateTask).toBeDefined();

    const detail = await asJson<{ task: { identity: Record<string, unknown> } }>(
      await get(reader, `/api/jobs/${publicTask?.runId}`),
    );
    expect(detail.task.identity).toMatchObject({ headRef: 'feature/drawer' });
    const privateDetail = await asJson<{ task: { identity: Record<string, unknown> } }>(
      await get(reader, `/api/jobs/${privateTask?.runId}`),
    );
    expect(privateDetail.task.identity).toEqual({ kind: 'anonymous' });
    expect(JSON.stringify(privateDetail)).not.toContain('feature/secret');
  });

  it('persists claimed and terminal timestamps readable by a fresh worker', async () => {
    const database = new SqliteD1Database();
    const store = createD1ReviewStateStore(database);
    const review = await store.claimReview({
      deliveryId: 'd-timestamps',
      job: job({ repositoryId: 13 }),
      occurredAt: '2026-01-01T00:00:00.000Z',
    });
    if (review.kind !== 'claimed') throw new Error('expected claimed');
    await verifyMetadata(store, 7, 13, 'public');
    const claimed = await store.claimNextJob!({
      jobId: 'job-1',
      attempt: 1,
      occurredAt: '2026-01-01T00:00:30.000Z',
    });
    expect(claimed.kind).toBe('claimed');
    await store.markRunCompleted({
      runId: review.runId,
      occurredAt: '2026-01-01T00:01:00.000Z',
    });

    const worker = createCoreWorker(coreEnv(database));
    const response = await get(worker, `/api/jobs/${review.runId}`);
    expect(response.status).toBe(200);
    const detail = await asJson<{
      task: {
        claimedAt: string | null;
        terminalAt: string | null;
        queueWaitMs: number | null;
        totalDurationMs: number | null;
      };
    }>(response);
    expect(detail.task.claimedAt).toBe('2026-01-01T00:00:30.000Z');
    expect(detail.task.terminalAt).toBe('2026-01-01T00:01:00.000Z');
    expect(detail.task.queueWaitMs).toBe(30_000);
    expect(detail.task.totalDurationMs).toBe(60_000);
  });

  it('paginates history with a scoped cursor and rejects a mismatched scope', async () => {
    const database = new SqliteD1Database();
    const store = createD1ReviewStateStore(database);
    for (let i = 0; i < 3; i += 1) {
      const review = await store.claimReview({
        deliveryId: `d-page-${i}`,
        job: job({ repositoryId: 100 + i, repositoryVisibility: 'private' }),
        occurredAt: `2026-01-0${i + 1}T00:00:00.000Z`,
      });
      expect(review.kind).toBe('claimed');
    }
    const worker = createCoreWorker(coreEnv(database));
    const first = await asJson<{
      tasks: { runId: string; identity: { kind: string } }[];
      nextCursor: string | null;
    }>(await get(worker, '/api/jobs?limit=2'));
    expect(first.tasks).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    expect(first.tasks.every((task) => task.identity.kind === 'anonymous')).toBe(true);
    expect(JSON.stringify(first)).not.toContain('repositoryFullName');
    const second = await asJson<{ tasks: { runId: string }[]; nextCursor: string | null }>(
      await get(
        worker,
        `/api/jobs?limit=2&cursor=${encodeURIComponent(first.nextCursor as string)}`,
      ),
    );
    expect(second.tasks).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    const seen = [...first.tasks, ...second.tasks].map((task) => task.runId);
    expect(new Set(seen).size).toBe(3);
    const mismatch = await get(
      worker,
      `/api/jobs?limit=2&view=current&cursor=${encodeURIComponent(first.nextCursor as string)}`,
    );
    expect(mismatch.status).toBe(400);
  });

  it('filters Queued and In progress by the same recorded dispatch state shown in each review', async () => {
    const database = new SqliteD1Database();
    const store = createD1ReviewStateStore(database);
    for (let i = 0; i < 3; i += 1) {
      await store.claimReview({
        deliveryId: `d-dispatch-${i}`,
        job: job({ repositoryId: 200 + i }),
        occurredAt: `2026-01-0${i + 1}T00:00:00.000Z`,
      });
    }
    const worker = createCoreWorker(coreEnv(database));
    const list = async (query: string) => {
      const response = await get(worker, `/api/jobs?${query}`);
      expect(response.status).toBe(200);
      return asJson<{
        tasks: { runId: string; dispatch: string | null; status: string }[];
        nextCursor: string | null;
      }>(response);
    };
    const queued = await list('status=queued&limit=1');
    expect(queued.tasks).toHaveLength(1);
    expect(queued.tasks[0]?.dispatch).toBe('queued');
    expect(queued.nextCursor).not.toBeNull();
    expect((await list('status=in_progress')).tasks).toHaveLength(0);
    expect(
      (
        await get(
          worker,
          `/api/jobs?status=in_progress&cursor=${encodeURIComponent(queued.nextCursor!)}`,
        )
      ).status,
    ).toBe(400);

    const claim = await store.claimNextJob!({
      jobId: 'dispatch-job',
      attempt: 1,
      occurredAt: '2026-01-04T00:00:00.000Z',
    });
    if (claim.kind !== 'claimed') throw new Error('expected Runner claim');
    const running = await list('status=in_progress');
    expect(running.tasks).toEqual([
      expect.objectContaining({ runId: claim.runId, dispatch: 'claimed', status: 'scheduled' }),
    ]);
    const remaining = await list('status=queued');
    expect(remaining.tasks).toHaveLength(2);
    expect(
      remaining.tasks.every((task) => task.dispatch === 'queued' && task.runId !== claim.runId),
    ).toBe(true);

    await store.markSchedulingFailed({
      runId: claim.runId,
      occurredAt: '2026-01-04T00:01:00.000Z',
    });
    expect((await list('status=in_progress')).tasks).toHaveLength(0);
    expect((await list('status=failed')).tasks).toEqual([
      expect.objectContaining({ runId: claim.runId, dispatch: null, status: 'failed' }),
    ]);
  });

  it('accepts advancing progress and ignores a stage regression', async () => {
    const database = new SqliteD1Database();
    const store = createD1ReviewStateStore(database);
    const review = await store.claimReview({
      deliveryId: 'd-progress',
      job: job({ repositoryId: 200 }),
      occurredAt: '2026-01-01T00:00:00.000Z',
    });
    if (review.kind !== 'claimed') throw new Error('expected claimed');
    const claimed = await store.claimNextJob!({
      jobId: 'job-progress-1',
      attempt: 1,
      occurredAt: '2026-01-01T00:00:10.000Z',
    });
    expect(claimed.kind).toBe('claimed');
    const worker = createCoreWorker(coreEnv(database));
    const post = (body: unknown) =>
      worker.fetch(
        new Request('https://core.internal/runner-progress', {
          method: 'POST',
          headers: {
            'x-compte-rendu-runner-progress': 'verified',
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
        }),
      );
    const identity = { runId: review.runId, id: 'job-progress-1', attempt: 1 };
    const checkout = { stage: 'checkout', startedAt: '2026-01-01T00:00:11.000Z' };
    const agent = { stage: 'agent', startedAt: '2026-01-01T00:00:12.000Z' };
    expect(
      (await post({ ...identity, sequence: 1, stage: 'checkout', milestones: [checkout] })).status,
    ).toBe(202);
    expect(
      (await post({ ...identity, sequence: 2, stage: 'agent', milestones: [checkout, agent] }))
        .status,
    ).toBe(202);
    expect(
      (await post({ ...identity, sequence: 2, stage: 'agent', milestones: [checkout, agent] }))
        .status,
    ).toBe(204);
    expect(
      (await post({ ...identity, sequence: 3, stage: 'checkout', milestones: [checkout] })).status,
    ).toBe(204);
    expect((await post({ ...identity, sequence: 4, stage: 'agent', milestones: [] })).status).toBe(
      400,
    );
    const malformed = { stage: 'checkout', startedAt: '2026-01-01' };
    expect(
      (await post({ ...identity, sequence: 5, stage: 'checkout', milestones: [malformed] })).status,
    ).toBe(400);
    const regressed = [
      { stage: 'checkout', startedAt: '2026-01-01T00:00:12.000Z' },
      { stage: 'agent', startedAt: '2026-01-01T00:00:11.000Z' },
    ];
    expect(
      (await post({ ...identity, sequence: 6, stage: 'agent', milestones: regressed })).status,
    ).toBe(400);
    const detail = await asJson<{
      task: { stage: string | null; lastProgressAt: string | null };
      milestones: { stage: string }[];
    }>(await get(worker, `/api/jobs/${review.runId}`));
    expect(detail.task.stage).toBe('agent');
    expect(detail.task.lastProgressAt).not.toBeNull();
    expect(detail.milestones.map((milestone) => milestone.stage)).toEqual(['checkout', 'agent']);
  });

  it('forwards public dashboard reads through ingress without leaking private identity', async () => {
    const database = new SqliteD1Database();
    const store = createD1ReviewStateStore(database);
    const review = await store.claimReview({
      deliveryId: 'd-ingress',
      job: job({ repositoryId: 300, repositoryVisibility: 'private' }),
      occurredAt: '2026-01-01T00:00:00.000Z',
    });
    expect(review.kind).toBe('claimed');
    await verifyMetadata(store, 7, 300, 'public');
    const ingress = createIngressWorker({
      secret: 'webhook-secret',
      crypto: globalThis.crypto,
      allowedInstallationIds: '[7]',
      core: createCoreWorker(coreEnv(database)),
    });
    const response = await ingress.fetch(new Request('https://ingress.test/api/jobs'));
    expect(response.status).toBe(200);
    const page = (await response.json()) as { tasks: unknown[] };
    expect(page.tasks).toHaveLength(1);
    expect(JSON.stringify(page)).not.toContain('repositoryFullName');
    const rejected = await ingress.fetch(
      new Request('https://ingress.test/api/jobs', { method: 'DELETE' }),
    );
    expect(rejected.status).toBe(405);
  });

  it('invalidates public metadata when the repository lookup reports it inaccessible', async () => {
    const database = new SqliteD1Database();
    const store = createD1ReviewStateStore(database);
    const review = await store.claimReview({
      deliveryId: 'd-invalidate',
      job: job({ repositoryId: 400 }),
      occurredAt: '2026-01-01T00:00:00.000Z',
    });
    expect(review.kind).toBe('claimed');
    await verifyMetadata(store, 7, 400, 'public');
    const worker = createCoreWorker(coreEnv(database));
    const identity = async () =>
      (
        (await (await get(worker, `/api/jobs/${review.runId}`)).json()) as {
          task: { identity: { kind: string } };
        }
      ).task.identity.kind;
    expect(await identity()).toBe('public');
    await runScheduledMetadataRefresh(coreEnv(database), {
      stateStore: store,
      github: {
        getRepositoryMetadata: async () => {
          throw new GitHubRequestError(404);
        },
      },
    });
    expect(await identity()).toBe('anonymous');
  });

  it('skips refresh dispatch while a throttle cooldown is active', async () => {
    const database = new SqliteD1Database();
    const store = createD1ReviewStateStore(database);
    const review = await store.claimReview({
      deliveryId: 'd-cooldown',
      job: job({ repositoryId: 401 }),
      occurredAt: '2026-01-01T00:00:00.000Z',
    });
    expect(review.kind).toBe('claimed');
    await verifyMetadata(store, 7, 401, 'public');
    await store.setRefreshCooldown?.({ nextAllowedAt: '2999-01-01T00:00:00.000Z' });
    let called = 0;
    const result = await runScheduledMetadataRefresh(coreEnv(database), {
      stateStore: store,
      github: {
        getRepositoryMetadata: async () => {
          called += 1;
          return { full_name: 'acme/reviewed', visibility: 'public' as const };
        },
      },
    });
    expect(result).toEqual({ dispatched: 0, failed: 0, skipped: 'cooldown' });
    expect(called).toBe(0);
  });

  it('forwards runner progress through ingress and serves dashboard pages', async () => {
    const database = new SqliteD1Database();
    const store = createD1ReviewStateStore(database);
    const review = await store.claimReview({
      deliveryId: 'd-ingress-progress',
      job: job({ repositoryId: 402 }),
      occurredAt: '2026-01-01T00:00:00.000Z',
    });
    if (review.kind !== 'claimed') throw new Error('expected claimed');
    await store.claimNextJob!({
      jobId: 'job-ingress-1',
      attempt: 1,
      occurredAt: '2026-01-01T00:00:10.000Z',
    });
    const ingress = createIngressWorker({
      secret: 'webhook-secret',
      crypto: globalThis.crypto,
      allowedInstallationIds: '[7]',
      runnerCallbackToken: 'progress-token',
      assets: {
        fetch: async (request) => {
          const path = new URL(request.url).pathname;
          if (path === '/index.html')
            return new Response('<!doctype html><title>Dashboard fixture</title>', {
              headers: { 'content-type': 'text/html' },
            });
          if (path === '/_app/immutable/app.js')
            return new Response('export {};', { headers: { 'content-type': 'text/javascript' } });
          return new Response(null, { status: 404 });
        },
      },
      core: createCoreWorker(coreEnv(database)),
    });
    const checkout = { stage: 'checkout', startedAt: '2026-01-01T00:00:11.000Z' };
    const unauthorized = await ingress.fetch(
      new Request('https://ingress.test/runner-progress', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId: review.runId,
          id: 'job-ingress-1',
          attempt: 1,
          sequence: 1,
          stage: 'checkout',
          milestones: [checkout],
        }),
      }),
    );
    expect(unauthorized.status).toBe(401);
    const forwarded = await ingress.fetch(
      new Request('https://ingress.test/runner-progress', {
        method: 'POST',
        headers: { authorization: 'Bearer progress-token', 'content-type': 'application/json' },
        body: JSON.stringify({
          runId: review.runId,
          id: 'job-ingress-1',
          attempt: 1,
          sequence: 1,
          stage: 'checkout',
          milestones: [checkout],
        }),
      }),
    );
    expect(forwarded.status).toBe(202);
    const detail = await asJson<{ task: { stage: string | null } }>(
      await ingress.fetch(new Request(`https://ingress.test/api/jobs/${review.runId}`)),
    );
    expect(detail.task.stage).toBe('checkout');

    const page = await ingress.fetch(new Request('https://ingress.test/'));
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await page.text()).toBe('<!doctype html><title>Dashboard fixture</title>');
    const history = await ingress.fetch(new Request('https://ingress.test/history'));
    expect(history.status).toBe(200);
    expect(history.headers.get('content-type')).toContain('text/html');
    expect(history.headers.get('cache-control')).toBe('no-store');
    const help = await ingress.fetch(new Request('https://ingress.test/help'));
    expect(help.status).toBe(200);
    expect(help.headers.get('content-type')).toContain('text/html');
    expect(help.headers.get('cache-control')).toBe('no-store');
    const asset = await ingress.fetch(new Request('https://ingress.test/_app/immutable/app.js'));
    expect(asset.headers.get('content-type')).toBe('text/javascript');
    expect(await asset.text()).toBe('export {};');
    const absent = await ingress.fetch(new Request('https://ingress.test/_app/missing.js'));
    expect(absent.status).toBe(404);
    const unmatched = await ingress.fetch(new Request('https://ingress.test/dashboard.js'));
    expect(unmatched.status).toBe(405);
  });

  it('does not cache an unavailable Core binding on public reads', async () => {
    const ingress = createIngressWorker({
      secret: 'webhook-secret',
      crypto: globalThis.crypto,
      allowedInstallationIds: '[7]',
      core: {
        fetch: async () => {
          throw new Error('unavailable');
        },
      },
    });
    const response = await ingress.fetch(new Request('https://ingress.test/api/dashboard'));
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe('');
  });

  it('fails closed with no-store 503 when the read database is unavailable', async () => {
    const outage = {
      prepare: () => {
        throw new Error('database unavailable');
      },
    } as unknown as SqliteD1Database;
    const worker = createCoreWorker(coreEnv(outage));
    const response = await get(worker, '/api/dashboard');
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe('');
  });

  it('binds refresh completion to the exact lease and rejects a stale claimant', async () => {
    const database = new SqliteD1Database();
    const store = createD1ReviewStateStore(database);
    await store.claimReview({
      deliveryId: 'd-lease',
      job: job({ repositoryId: 320 }),
      occurredAt: '2026-01-01T00:00:00.000Z',
    });
    const due = await store.listDueRepositoryMetadata!({
      now: '2026-01-01T00:00:00.000Z',
      limit: 50,
    });
    const row = due.find((entry) => entry.repositoryId === 320);
    if (row === undefined) throw new Error('metadata row missing');
    const first = '2026-01-01T00:01:00.000Z';
    const second = '2026-01-01T00:02:00.000Z';
    expect(
      await store.claimRepositoryRefresh!({
        installationId: 7,
        repositoryId: 320,
        expectedRevision: row.revision,
        claimedAt: first,
        staleBefore: '2026-01-01T00:00:30.000Z',
      }),
    ).toBe(true);
    expect(
      await store.claimRepositoryRefresh!({
        installationId: 7,
        repositoryId: 320,
        expectedRevision: row.revision,
        claimedAt: second,
        staleBefore: '2026-01-01T00:01:30.000Z',
      }),
    ).toBe(true);
    const staleCompletion = await store.recordRepositoryRefresh!({
      installationId: 7,
      repositoryId: 320,
      expectedRevision: row.revision,
      claimedAt: first,
      fullName: 'acme/stale',
      visibility: 'public',
      verifiedAt: second,
      identityExpiresAt: '2999-01-01T00:00:00.000Z',
      nextRefreshAt: '2026-01-01T00:04:00.000Z',
      updatedAt: second,
    });
    expect(staleCompletion).toBe(false);
    const freshCompletion = await store.recordRepositoryRefresh!({
      installationId: 7,
      repositoryId: 320,
      expectedRevision: row.revision,
      claimedAt: second,
      fullName: 'acme/fresh',
      visibility: 'public',
      verifiedAt: second,
      identityExpiresAt: '2999-01-01T00:00:00.000Z',
      nextRefreshAt: '2026-01-01T00:04:00.000Z',
      updatedAt: second,
    });
    expect(freshCompletion).toBe(true);
  });

  it('does not downgrade a known-private observation to unknown on a stale 404', async () => {
    const database = new SqliteD1Database();
    const store = createD1ReviewStateStore(database);
    await store.claimReview({
      deliveryId: 'd-known-private',
      job: job({ repositoryId: 321 }),
      occurredAt: '2026-01-01T00:00:00.000Z',
    });
    await verifyMetadata(store, 7, 321, 'private');
    const due = await store.listDueRepositoryMetadata!({
      now: '2026-01-01T00:03:00.000Z',
      limit: 50,
    });
    const row = due.find((entry) => entry.repositoryId === 321);
    if (row === undefined) throw new Error('metadata row missing');
    const downgraded = await store.invalidateRepositoryMetadata!({
      installationId: 7,
      repositoryId: 321,
      visibility: 'unknown',
      expectedRevision: row.revision,
      updatedAt: '2026-01-01T00:03:00.000Z',
      nextRefreshAt: '2026-01-01T00:04:00.000Z',
    });
    expect(downgraded).toBe(false);
    const after = await store.listDueRepositoryMetadata!({
      now: '2026-01-01T00:04:00.000Z',
      limit: 50,
    });
    expect(after.find((entry) => entry.repositoryId === 321)?.visibility).toBe('private');
  });

  it('keeps the longer of two persisted refresh cooldowns', async () => {
    const database = new SqliteD1Database();
    const store = createD1ReviewStateStore(database);
    await store.setRefreshCooldown!({ nextAllowedAt: '2026-01-01T00:05:00.000Z' });
    await store.setRefreshCooldown!({ nextAllowedAt: '2026-01-01T00:01:00.000Z' });
    expect(await store.getRefreshCooldown!()).toBe('2026-01-01T00:05:00.000Z');
    await store.setRefreshCooldown!({ nextAllowedAt: '2026-01-01T00:10:00.000Z' });
    expect(await store.getRefreshCooldown!()).toBe('2026-01-01T00:10:00.000Z');
  });

  it('aborts and defers a repository lookup that exceeds the refresh deadline', async () => {
    const database = new SqliteD1Database();
    const store = createD1ReviewStateStore(database);
    await store.claimReview({
      deliveryId: 'd-timeout',
      job: job({ repositoryId: 322 }),
      occurredAt: '2026-01-01T00:00:00.000Z',
    });
    let aborted = false;
    const result = await refreshRepositoryMetadata({
      stateStore: store,
      timeoutMs: 20,
      now: '2026-01-01T00:00:00.000Z',
      github: {
        getRepositoryMetadata: async ({ signal }) => {
          signal?.addEventListener('abort', () => {
            aborted = true;
          });
          return await new Promise(() => undefined);
        },
      },
    });
    expect(result).toEqual({ dispatched: 0, failed: 1, skipped: '' });
    expect(aborted).toBe(true);
  });

  it('parses Retry-After dates and rate-limit reset headers into bounded delays', async () => {
    const dateAdapter = createGitHubPublicationAdapter({
      token: 'token',
      fetch: async () =>
        new Response(null, {
          status: 429,
          headers: { 'retry-after': new Date(Date.now() + 4000).toUTCString() },
        }),
    });
    {
      try {
        await dateAdapter.getRepositoryMetadata!({ repositoryId: 1, installationId: 7 });
        expect.unreachable('expected throttle');
      } catch (error) {
        expect(error).toBeInstanceOf(GitHubRequestError);
        const delay = (error as GitHubRequestError).retryAfterMs ?? 0;
        expect(delay).toBeGreaterThan(2000);
        expect(delay).toBeLessThanOrEqual(4000);
      }
    }
    const resetAdapter = createGitHubPublicationAdapter({
      token: 'token',
      fetch: async () =>
        new Response(null, {
          status: 403,
          headers: { 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 30) },
        }),
    });
    try {
      await resetAdapter.getRepositoryMetadata!({ repositoryId: 1, installationId: 7 });
      expect.unreachable('expected throttle');
    } catch (error) {
      expect(error).toBeInstanceOf(GitHubRequestError);
      const delay = (error as GitHubRequestError).retryAfterMs ?? 0;
      expect(delay).toBeGreaterThan(20000);
      expect(delay).toBeLessThanOrEqual(30000);
    }
  });

  it('invalidates metadata from signed pull request, removal and installation events', async () => {
    const secret = 'webhook-secret';
    const sign = async (body: string) => {
      const key = await globalThis.crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const digest = new Uint8Array(
        await globalThis.crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)),
      );
      return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
    };
    const send = async (event: string, value: unknown) => {
      const body = JSON.stringify(value);
      const signature = await sign(body);
      return ingress.fetch(
        new Request('https://ingress.test/webhooks/github', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-github-event': event,
            'x-github-delivery': `d-${event}`,
            'x-hub-signature-256': `sha256=${signature}`,
          },
          body,
        }),
      );
    };
    const database = new SqliteD1Database();
    const store = createD1ReviewStateStore(database);
    for (const repositoryId of [330, 331, 332, 333]) {
      await store.claimReview({
        deliveryId: `d-meta-${repositoryId}`,
        job: job({ repositoryId }),
        occurredAt: '2026-01-01T00:00:00.000Z',
      });
      await verifyMetadata(store, 7, repositoryId, 'public');
    }
    const worker = createCoreWorker(coreEnv(database));
    const ingress = createIngressWorker({
      secret,
      crypto: globalThis.crypto,
      allowedInstallationIds: '[7]',
      core: worker,
    });
    const identityFor = async (runId: string) =>
      (
        (await (await get(worker, `/api/jobs/${runId}`)).json()) as {
          task: { identity: { kind: string } };
        }
      ).task.identity.kind;
    const runIdFor = async (repositoryId: number) => {
      const rows = await store.listPublicRuns!({
        limit: 50,
        filter: { status: 'all', cleanup: 'all' },
        view: 'history',
      });
      const row = rows.find((entry) => entry.repositoryId === repositoryId);
      if (row === undefined) throw new Error('run missing');
      return row.runId;
    };

    expect(
      (
        await send('pull_request', {
          action: 'closed',
          installation: { id: 7 },
          repository: { id: 330, visibility: 'private' },
        })
      ).status,
    ).toBe(204);
    expect(await identityFor(await runIdFor(330))).toBe('anonymous');

    expect(
      (
        await send('installation_repositories', {
          action: 'removed',
          installation: { id: 7 },
          repositories_removed: [{ id: 331 }],
        })
      ).status,
    ).toBe(202);
    expect(await identityFor(await runIdFor(331))).toBe('anonymous');

    expect(
      (await send('installation', { action: 'deleted', installation: { id: 7 } })).status,
    ).toBe(202);
    expect(await identityFor(await runIdFor(332))).toBe('anonymous');
    expect(await identityFor(await runIdFor(333))).toBe('anonymous');
  });

  it('emits aggregate bounded refresh facts and runs through the scheduled boundary', async () => {
    const database = new SqliteD1Database();
    const events: OperationalLogEvent[] = [];
    const summary = await runScheduledMetadataRefresh(coreEnv(database), {
      log: {
        record: async (event: OperationalLogEvent) => {
          events.push(event);
        },
      },
    });
    expect(summary).toEqual({ dispatched: 0, failed: 0, skipped: '' });
    expect(events).toEqual([
      { phase: 'core', outcome: 'metadata_refresh', dispatched: 0, failed: 0, skipped: '' },
    ]);

    let task: Promise<unknown> | undefined;
    coreWorker.scheduled({}, coreEnv(database), {
      waitUntil: (pending) => {
        task = pending;
      },
    });
    expect(task).toBeDefined();
    await task;
    expect(coreWorker.scheduled({}, undefined)).toBeUndefined();
  });

  it('returns a neutral 404 for a malformed run id instead of a server error', async () => {
    const database = new SqliteD1Database();
    const worker = createCoreWorker(coreEnv(database));
    const response = await worker.fetch(new Request('https://core.internal/api/jobs/%E0%A4%A'));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('');
    const nested = await createIngressWorker({
      secret: 'webhook-secret',
      crypto: globalThis.crypto,
      allowedInstallationIds: '[7]',
      core: worker,
      assets: {
        fetch: async (request) => {
          const path = new URL(request.url).pathname;
          if (path === '/index.html')
            return new Response('<!doctype html><title>Dashboard fixture</title>', {
              headers: { 'content-type': 'text/html' },
            });
          if (path === '/_app/immutable/app.js')
            return new Response('export {};', { headers: { 'content-type': 'text/javascript' } });
          return new Response(null, { status: 404 });
        },
      },
    }).fetch(new Request('https://ingress.test/jobs/deep/nested'));
    expect(nested.status).toBe(200);
    expect(nested.headers.get('content-type')).toContain('text/html');
  });

  it('applies selected status and cleanup filters within views', async () => {
    const database = new SqliteD1Database();
    const store = createD1ReviewStateStore(database);
    const scheduled = await store.claimReview({
      deliveryId: 'd-view-scheduled',
      job: job({ repositoryId: 340 }),
      occurredAt: '2026-01-01T00:00:00.000Z',
    });
    if (scheduled.kind !== 'claimed') throw new Error('expected claimed');
    await store.claimNextJob!({
      jobId: 'job-view-1',
      attempt: 1,
      occurredAt: '2026-01-01T00:00:10.000Z',
    });
    const cleanupFailed = await store.claimReview({
      deliveryId: 'd-view-cleanup',
      job: job({ repositoryId: 341 }),
      occurredAt: '2026-01-01T00:00:00.000Z',
    });
    if (cleanupFailed.kind !== 'claimed') throw new Error('expected claimed');
    await database
      .prepare("UPDATE review_runs SET runner_cleanup_status = 'failed' WHERE run_id = ?")
      .bind(cleanupFailed.runId)
      .run();
    const worker = createCoreWorker(coreEnv(database));
    const list = async (query: string) =>
      asJson<{ tasks: { runId: string }[] }>(await get(worker, `/api/jobs?${query}`));

    expect((await list('view=current&status=failed')).tasks).toHaveLength(0);
    const current = await list('view=current');
    expect(current.tasks.map((task) => task.runId)).toContain(scheduled.runId);
    expect((await list('view=cleanup&cleanup=destroyed')).tasks).toHaveLength(0);
    const cleanup = await list('view=cleanup');
    expect(cleanup.tasks.map((task) => task.runId)).toContain(cleanupFailed.runId);
  });

  it('ignores unrelated repository and installation actions without contacting core', async () => {
    const secret = 'webhook-secret';
    const sign = async (body: string) => {
      const key = await globalThis.crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const digest = new Uint8Array(
        await globalThis.crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)),
      );
      return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
    };
    const forwarded: Request[] = [];
    const ingress = createIngressWorker({
      secret,
      crypto: globalThis.crypto,
      allowedInstallationIds: '[7]',
      core: {
        fetch: async (request) => {
          forwarded.push(request);
          return new Response(null, { status: 202 });
        },
      },
    });
    const send = async (event: string, value: unknown) => {
      const body = JSON.stringify(value);
      return ingress.fetch(
        new Request('https://ingress.test/webhooks/github', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-github-event': event,
            'x-github-delivery': `d-${event}`,
            'x-hub-signature-256': `sha256=${await sign(body)}`,
          },
          body,
        }),
      );
    };

    const unhandled: [string, unknown][] = [
      ['repository', { action: 'created', installation: { id: 7 }, repository: { id: 1 } }],
      ['repository', { action: 'publicized', installation: { id: 7 }, repository: { id: 1 } }],
      [
        'installation_repositories',
        { action: 'added', installation: { id: 7 }, repositories_added: [{ id: 1 }] },
      ],
      ['installation', { action: 'created', installation: { id: 7 } }],
      ['installation', { action: 'unsuspend', installation: { id: 7 } }],
    ];
    for (const [event, value] of unhandled) {
      expect((await send(event, value)).status).toBe(204);
    }
    expect(forwarded).toHaveLength(0);

    expect(
      (
        await send('repository', {
          action: 'privatized',
          installation: { id: 7 },
          repository: { id: 1 },
        })
      ).status,
    ).toBe(202);
    expect(forwarded).toHaveLength(1);
  });

  it('fails closed when metadata revocation storage errors', async () => {
    const worker = createCoreWorker(coreEnv(new SqliteD1Database()), {
      stateStore: {
        invalidateRepositoryMetadataBatch: async () => {
          throw new Error('database unavailable');
        },
      } as unknown as ReviewPublicationStateStore,
    });
    const response = await worker.fetch(
      new Request('https://core.internal/metadata-events', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          deliveryId: 'd-revoke-error',
          event: 'metadata',
          reason: 'repository_private',
          installationId: 7,
          repositoryIds: [1],
          visibility: 'private',
        }),
      }),
    );
    expect(response.status).toBe(503);
  });

  it('reaches later due repositories across refreshes without exposing a private task', async () => {
    const database = new SqliteD1Database();
    const store = createD1ReviewStateStore(database);
    const runIds: Record<number, string> = {};
    for (let repositoryId = 1; repositoryId <= 9; repositoryId += 1) {
      const review = await store.claimReview({
        deliveryId: `d-due-${repositoryId}`,
        job: job({ repositoryId }),
        occurredAt: '2026-01-01T00:00:00.000Z',
      });
      if (review.kind !== 'claimed') throw new Error('expected claimed');
      runIds[repositoryId] = review.runId;
      await verifyMetadata(store, 7, repositoryId, 'private');
    }
    const worker = createCoreWorker(coreEnv(database));
    const identity = async (repositoryId: number) =>
      (
        (await (await get(worker, `/api/jobs/${runIds[repositoryId]}`)).json()) as {
          task: { identity: { kind: string } };
        }
      ).task.identity.kind;
    const github = {
      getRepositoryMetadata: async ({ repositoryId }: { repositoryId: number }) => {
        if (repositoryId === 9)
          return { full_name: 'acme/becomes-public', visibility: 'public' as const };
        throw new GitHubRequestError(404);
      },
    };

    expect(await identity(9)).toBe('anonymous');
    await refreshRepositoryMetadata({
      stateStore: store,
      github,
      now: '2999-01-01T00:00:00.000Z',
    });
    expect(await identity(9)).toBe('anonymous');
    await refreshRepositoryMetadata({
      stateStore: store,
      github,
      now: '2999-01-01T00:03:00.000Z',
    });
    expect(await identity(9)).toBe('public');
    expect(await identity(1)).toBe('anonymous');
  });

  it('cancels a stalled error body instead of waiting for it', async () => {
    const adapter = createGitHubPublicationAdapter({
      token: 'token',
      fetch: async () => new Response(new ReadableStream({ start() {} }), { status: 429 }),
    });
    const started = Date.now();
    await expect(
      adapter.getRepositoryMetadata!({ repositoryId: 1, installationId: 7 }),
    ).rejects.toBeInstanceOf(GitHubRequestError);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('preserves a token-exchange throttle into the metadata refresh cooldown', async () => {
    const database = new SqliteD1Database();
    const store = createD1ReviewStateStore(database);
    for (let repositoryId = 1; repositoryId <= 8; repositoryId += 1) {
      await store.claimReview({
        deliveryId: `d-token-throttle-${repositoryId}`,
        job: job({ repositoryId }),
        occurredAt: '2026-01-01T00:00:00.000Z',
      });
    }
    const keyPair = await globalThis.crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    );
    const encodedKey = globalThis.btoa(
      String.fromCharCode(
        ...new Uint8Array(await globalThis.crypto.subtle.exportKey('pkcs8', keyPair.privateKey)),
      ),
    );
    const privateKey = `-----BEGIN PRIVATE KEY-----\n${encodedKey.match(/.{1,64}/g)?.join('\n')}\n-----END PRIVATE KEY-----`;
    let tokenExchanges = 0;
    const provider = createGitHubAppTokenProvider({
      appId: '1234567',
      privateKey,
      crypto: globalThis.crypto,
      fetch: async () => {
        tokenExchanges += 1;
        return new Response(null, { status: 429, headers: { 'retry-after': '60' } });
      },
    });
    const github = createGitHubPublicationAdapter({
      token: (installationId, signal) => provider.getInstallationToken(installationId, signal),
      fetch: async () => {
        throw new Error('metadata request should not run while throttled');
      },
    });
    const log = { record: async () => {} };
    const first = await runScheduledMetadataRefresh(coreEnv(database), {
      stateStore: store,
      github,
      log,
    });
    expect(first.dispatched).toBe(0);
    expect(first.skipped).toBe('');
    expect(tokenExchanges).toBeGreaterThan(0);
    expect(tokenExchanges).toBeLessThan(8);
    const cooldown = await store.getRefreshCooldown!();
    expect(cooldown).toBeDefined();
    expect(Date.parse(cooldown!)).toBeGreaterThan(Date.now());

    const freshStore = createD1ReviewStateStore(database);
    const second = await runScheduledMetadataRefresh(coreEnv(database), {
      stateStore: freshStore,
      github,
      log,
    });
    expect(second).toEqual({ dispatched: 0, failed: 0, skipped: 'cooldown' });
    expect(tokenExchanges).toBeLessThan(8);
  });
});

describe('dashboard instance name', () => {
  it.each([undefined, '', '  ', 'Ariga39 AI Review'])(
    'serves the Check name through ingress (%s)',
    async (name) => {
      const database = new SqliteD1Database();
      const core = createCoreWorker({ ...coreEnv(database), GITHUB_CHECK_NAME: name });
      const ingress = createIngressWorker({
        core,
        secret: 'test-secret',
        crypto,
        allowedInstallationIds: [],
      });
      const response = await ingress.fetch(
        new Request('https://reviews.example/api/dashboard-config'),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ name: name?.trim() || 'Compte-rendu review' });
      expect(response.headers.get('cache-control')).toBe('no-store');
    },
  );
});
