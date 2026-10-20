import { describe, expect, it } from 'vitest';
import { createCoreWorker } from '../apps/core/src/core-worker';
import { createD1ReviewStateStore } from '../apps/core/src/review-state-store';
import { createGitHubPublicationAdapter } from '../apps/core/src/github-review-adapter';
import { SqliteD1Database } from './support/d1-database';

const baseSha = '1'.repeat(40);
const headSha = '2'.repeat(40);
const event = {
  deliveryId: 'reset-new-round',
  event: 'pull_request',
  action: 'synchronize',
  repositoryId: 11,
  pullRequestNumber: 42,
  installationId: 7,
  repositoryVisibility: 'public',
  baseRepositoryId: 11,
  headRepositoryId: 11,
  draft: false,
  baseSha,
  headSha,
};
const marker = (runId: string) => `<!-- compte-rendu:run:${runId} -->\nOld review body`;
const review = (id: number, runId: string, state: string, login = 'review-app[bot]') => ({
  id,
  body: marker(runId),
  state,
  commit_id: '3'.repeat(40),
  user: { login, type: 'Bot' },
});

describe('new review round resets prior GitHub verdicts', () => {
  it('dismisses only its prior votes across pages, preserving history and other reviewers', async () => {
    const database = new SqliteD1Database();
    const store = createD1ReviewStateStore(database);
    try {
      const previous = await store.claimReview({
        deliveryId: 'old-round',
        occurredAt: '2026-10-01T00:00:00.000Z',
        job: {
          repositoryId: 11,
          pullRequestNumber: 42,
          installationId: 7,
          baseSha,
          headSha: '3'.repeat(40),
          trigger: 'automatic',
        },
      });
      if (previous.kind !== 'claimed') throw new Error('fixture admission failed');
      await store.completeRunPublication({
        runId: previous.runId,
        occurredAt: '2026-10-01T00:01:00.000Z',
        fingerprints: [],
        decision: 'request_changes',
      });
      const reviews = [
        review(1, previous.runId, 'APPROVED'),
        ...Array.from({ length: 99 }, (_, i) =>
          review(i + 2, previous.runId, 'CHANGES_REQUESTED', 'other-app[bot]'),
        ),
        review(101, previous.runId, 'CHANGES_REQUESTED'),
        review(102, previous.runId, 'COMMENTED'),
        review(103, previous.runId, 'DISMISSED'),
        review(104, 'unknown-run', 'APPROVED'),
        { ...review(105, previous.runId, 'APPROVED'), user: null },
      ];
      const originalBody = reviews[0]!.body;
      const remote: typeof fetch = async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.pathname === '/repos/example/repo/pulls/42')
          return Response.json({ head: { sha: headSha } });
        if (url.pathname === '/repositories/11')
          return Response.json({ full_name: 'example/repo' });
        if (request.method === 'GET' && url.pathname.endsWith('/check-runs'))
          return Response.json({ check_runs: [] });
        if (request.method === 'POST' && url.pathname.endsWith('/check-runs'))
          return Response.json({ id: 91 });
        if (request.method === 'GET' && url.pathname.endsWith('/reviews')) {
          const page = Number(url.searchParams.get('page') ?? '1');
          return Response.json(reviews.slice((page - 1) * 100, page * 100));
        }
        const dismissal = url.pathname.match(/\/reviews\/(\d+)\/dismissals$/);
        if (request.method === 'PUT' && dismissal) {
          const target = reviews.find((r) => r.id === Number(dismissal[1]));
          if (!target) return new Response(null, { status: 404 });
          expect(await request.json()).toMatchObject({ event: 'DISMISS' });
          target.state = 'DISMISSED';
          return Response.json(target);
        }
        return new Response(null, { status: 404 });
      };
      const env = { REVIEW_DB: database, GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY: 'fixture' };
      const worker = createCoreWorker(env, {
        stateStore: store,
        github: createGitHubPublicationAdapter({
          token: 'fixture',
          fetch: remote,
          getReviewAuthorLogin: async () => 'review-app[bot]',
        }),
      });
      const tasks: Promise<unknown>[] = [];
      const response = await worker.fetch(
        new Request('https://core.internal/review-events', {
          method: 'POST',
          body: JSON.stringify(event),
        }),
        env,
        { waitUntil: (task) => tasks.push(task) },
      );
      await Promise.all(tasks);
      expect(response.status).toBe(202);
      expect(await store.getDeliveryOutcome(event.deliveryId)).toMatchObject({
        status: 'scheduled',
      });
      expect(reviews[0]!.state).toBe('DISMISSED');
      expect(reviews[100]!.state).toBe('DISMISSED');
      expect(reviews[1]!.state).toBe('CHANGES_REQUESTED');
      expect(reviews[101]!.state).toBe('COMMENTED');
      expect(reviews[103]!.state).toBe('APPROVED');
      expect(reviews[104]!.state).toBe('APPROVED');
      expect(reviews[0]!.body).toBe(originalBody);
      expect(await store.getRunOutcome(previous.runId)).toMatchObject({
        status: 'completed',
        decision: 'request_changes',
      });
    } finally {
      database.close();
    }
  });
});

const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const resetFixture = async () => {
  const database = new SqliteD1Database();
  const store = createD1ReviewStateStore(database);
  const previous = await store.claimReview({
    deliveryId: 'previous',
    occurredAt: '2026-10-01T00:00:00.000Z',
    job: {
      repositoryId: 11,
      pullRequestNumber: 42,
      installationId: 7,
      baseSha,
      headSha: '3'.repeat(40),
      trigger: 'automatic',
    },
  });
  if (previous.kind !== 'claimed') throw new Error('fixture admission failed');
  await store.completeRunPublication({
    runId: previous.runId,
    occurredAt: '2026-10-01T00:01:00.000Z',
    fingerprints: [],
    decision: 'approve',
  });
  const reviews = [review(1, previous.runId, 'APPROVED')];
  const checks: Array<{ id: number; external_id: string; status?: string; conclusion?: string }> =
    [];
  const controls = {
    deny: false,
    repositoryUnavailable: false,
    malformed: false,
    endless: false,
    loseDismissal: false,
    currentHead: headSha,
    onList: async () => {},
    beforeDismiss: async () => {},
  };
  const remote: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === '/repositories/11' && controls.repositoryUnavailable)
      return new Response(null, { status: 503 });
    if (url.pathname === '/repositories/11')
      return Response.json({
        full_name: 'example/repo',
        clone_url: 'https://github.com/example/repo.git',
      });
    if (url.pathname === '/repos/example/repo/pulls/42')
      return Response.json({ head: { sha: controls.currentHead } });
    if (request.method === 'GET' && url.pathname.endsWith('/check-runs'))
      return Response.json({ check_runs: checks });
    if (request.method === 'POST' && url.pathname.endsWith('/check-runs')) {
      const data = await request.json();
      const check = { id: checks.length + 10, ...data };
      checks.push(check);
      return Response.json(check);
    }
    if (request.method === 'PATCH' && url.pathname.includes('/check-runs/')) {
      const check = checks.find((c) => c.id === Number(url.pathname.split('/').at(-1)));
      if (!check) return new Response(null, { status: 404 });
      Object.assign(check, await request.json());
      return Response.json(check);
    }
    if (request.method === 'GET' && url.pathname.endsWith('/reviews')) {
      const snapshot = structuredClone(reviews);
      await controls.onList();
      return Response.json(
        controls.malformed
          ? {}
          : controls.endless
            ? Array.from({ length: 100 }, () => snapshot[0])
            : snapshot,
      );
    }
    const dismissal = url.pathname.match(/\/reviews\/(\d+)\/dismissals$/);
    if (request.method === 'PUT' && dismissal) {
      await controls.beforeDismiss();
      if (controls.deny) return new Response(null, { status: 403 });
      const target = reviews.find((r) => r.id === Number(dismissal[1]));
      if (!target) return new Response(null, { status: 404 });
      if (target.state === 'DISMISSED') return new Response(null, { status: 422 });
      target.state = 'DISMISSED';
      if (controls.loseDismissal) {
        controls.loseDismissal = false;
        throw new Error('lost response');
      }
      return Response.json(target);
    }
    const exact = url.pathname.match(/\/reviews\/(\d+)$/);
    if (request.method === 'GET' && exact)
      return Response.json(reviews.find((r) => r.id === Number(exact[1])));
    return new Response(null, { status: 404 });
  };
  const env = { REVIEW_DB: database, GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY: 'fixture' };
  const logs: unknown[] = [];
  const worker = createCoreWorker(env, {
    stateStore: store,
    log: {
      record: (entry) => {
        logs.push(entry);
      },
    },
    getReadInstallationToken: async () => ({
      token: 'read-only',
      expiresAt: '2099-01-01T00:00:00.000Z',
    }),
    github: createGitHubPublicationAdapter({
      token: 'fixture',
      fetch: remote,
      getReviewAuthorLogin: async () => 'review-app[bot]',
    }),
  });
  const tasks: Promise<unknown>[] = [];
  const send = (body = event) =>
    worker.fetch(
      new Request('https://core.internal/review-events', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
      env,
      { waitUntil: (task) => tasks.push(task) },
    );
  const claim = () =>
    worker.fetch(
      new Request('https://core.internal/runner-claims', {
        method: 'POST',
        headers: { 'x-compte-rendu-runner-claim': 'verified' },
      }),
      env,
      { waitUntil: (task) => tasks.push(task) },
    );
  return {
    database,
    store,
    reviews,
    checks,
    controls,
    logs,
    send,
    claim,
    worker,
    env,
    settle: async () => {
      await Promise.all(tasks.splice(0));
    },
  };
};

describe('review reset failure and concurrency', () => {
  it('makes a denied reset visible and never admits the new round to a Runner', async () => {
    const f = await resetFixture();
    try {
      f.controls.deny = true;
      expect((await f.send()).status).toBe(202);
      await f.settle();
      expect((await f.claim()).status).toBe(503);
      expect(f.reviews[0]!.state).toBe('APPROVED');
      expect(f.checks[0]).toMatchObject({ status: 'completed', conclusion: 'failure' });
      expect(f.logs).toContainEqual(expect.objectContaining({ reason: 'review_reset_failed' }));
      const outcome = await f.store.getDeliveryOutcome(event.deliveryId);
      expect(outcome?.status).toBe('failed');
      const runId = f.checks[0]!.external_id;
      const snapshot = await f.worker.fetch(
        new Request(`https://core.internal/api/jobs/${runId}`),
        f.env,
      );
      expect(await snapshot.json()).toMatchObject({
        task: { failure: { phase: 'scheduling', reason: 'review_reset_failed' } },
      });
    } finally {
      await f.settle();
      f.database.close();
    }
  });
});

it('cannot bypass a pending reset by claiming while the webhook is still running', async () => {
  const f = await resetFixture();
  const entered = gate();
  const release = gate();
  let first = true;
  f.controls.onList = async () => {
    if (first) {
      first = false;
      entered.resolve();
      await release.promise;
    }
  };
  f.controls.deny = true;
  const admission = f.send();
  try {
    await entered.promise;
    const claim = await f.claim();
    expect(claim.status).toBe(503);
    expect(f.reviews[0]!.state).toBe('APPROVED');
  } finally {
    release.resolve();
    await admission;
    await f.settle();
    f.database.close();
  }
});

it('keeps overlapping admission and claim successful when both observed the old vote', async () => {
  const f = await resetFixture();
  const entered = gate();
  const release = gate();
  let first = true;
  f.controls.onList = async () => {
    if (first) {
      first = false;
      entered.resolve();
      await release.promise;
    }
  };
  const admission = f.send();
  try {
    await entered.promise;
    expect((await f.claim()).status).toBe(200);
    release.resolve();
    expect((await admission).status).toBe(202);
    expect(await f.store.getDeliveryOutcome(event.deliveryId)).toMatchObject({
      status: 'scheduled',
    });
    expect(f.reviews[0]!.state).toBe('DISMISSED');
  } finally {
    release.resolve();
    await admission;
    await f.settle();
    f.database.close();
  }
});

it('confirms the exact review after a lost dismissal response', async () => {
  const f = await resetFixture();
  try {
    f.controls.loseDismissal = true;
    expect((await f.send()).status).toBe(202);
    expect(f.reviews[0]!.state).toBe('DISMISSED');
  } finally {
    await f.settle();
    f.database.close();
  }
});

it('does not clear this round or repeat the reset when a delivery is replayed', async () => {
  const f = await resetFixture();
  try {
    expect((await f.send()).status).toBe(202);
    await f.settle();
    const runId = f.checks[0]!.external_id;
    f.reviews.push(review(2, runId, 'CHANGES_REQUESTED'));
    expect((await f.claim()).status).toBe(200);
    expect(f.reviews[1]!.state).toBe('CHANGES_REQUESTED');
    await f.store.completeRunPublication({
      runId,
      occurredAt: new Date().toISOString(),
      fingerprints: [],
      decision: 'request_changes',
    });
    expect((await f.send()).status).toBe(202);
    expect(f.reviews[1]!.state).toBe('CHANGES_REQUESTED');
    expect(await f.store.getRunOutcome(runId)).toMatchObject({
      status: 'completed',
      decision: 'request_changes',
    });
  } finally {
    await f.settle();
    f.database.close();
  }
});

it.each(['malformed', 'endless'] as const)(
  'does not dismiss anything when the review listing/target is %s',
  async (mode) => {
    const f = await resetFixture();
    try {
      f.controls[mode] = true;
      expect((await f.send()).status).toBe(202);
      expect(f.reviews[0]!.state).toBe('APPROVED');
      expect((await f.claim()).status).toBe(503);
    } finally {
      await f.settle();
      f.database.close();
    }
  },
);

it('does not dismiss votes belonging to a different installation or pull request', async () => {
  const f = await resetFixture();
  try {
    for (const [index, target] of [
      { installationId: 8, pullRequestNumber: 42 },
      { installationId: 7, pullRequestNumber: 43 },
    ].entries()) {
      const prior = await f.store.claimReview({
        deliveryId: `other-${index}`,
        occurredAt: '2026-10-02T00:00:00.000Z',
        job: {
          repositoryId: 11,
          ...target,
          baseSha,
          headSha: String(index + 5).repeat(40),
          trigger: 'automatic',
        },
      });
      if (prior.kind !== 'claimed') throw new Error('fixture admission failed');
      f.reviews.push(review(index + 2, prior.runId, 'APPROVED'));
    }
    expect((await f.send()).status).toBe(202);
    expect(f.reviews.map((r) => r.state)).toEqual(['DISMISSED', 'APPROVED', 'APPROVED']);
  } finally {
    await f.settle();
    f.database.close();
  }
});

it('does not fail an admitted Runner when a slower eager reset loses its listing response', async () => {
  const f = await resetFixture();
  const entered = gate();
  const release = gate();
  let first = true;
  f.controls.onList = async () => {
    if (first) {
      first = false;
      entered.resolve();
      await release.promise;
      throw new Error('listing response lost');
    }
  };
  const admission = f.send();
  try {
    await entered.promise;
    expect((await f.claim()).status).toBe(200);
    release.resolve();
    await admission;
    expect(await f.store.getDeliveryOutcome(event.deliveryId)).toMatchObject({
      status: 'scheduled',
    });
    expect(f.reviews[0]!.state).toBe('DISMISSED');
  } finally {
    release.resolve();
    await admission;
    await f.settle();
    f.database.close();
  }
});

it('supersedes a stale queued round without dismissing votes or reporting failure', async () => {
  const f = await resetFixture();
  try {
    expect((await f.send()).status).toBe(202);
    await f.settle();
    f.reviews[0]!.state = 'CHANGES_REQUESTED';
    f.controls.currentHead = '4'.repeat(40);
    expect((await f.claim()).status).toBe(204);
    expect(f.reviews[0]!.state).toBe('CHANGES_REQUESTED');
    expect(await f.store.getDeliveryOutcome(event.deliveryId)).toMatchObject({
      status: 'superseded',
    });
    expect(f.checks[0]).toMatchObject({ status: 'completed', conclusion: 'cancelled' });
    expect(f.logs).not.toContainEqual(expect.objectContaining({ reason: 'review_reset_failed' }));
    expect((await f.claim()).status).toBe(204);
  } finally {
    await f.settle();
    f.database.close();
  }
});

it('recovers a transient listing failure during the mandatory claim reset', async () => {
  const f = await resetFixture();
  try {
    expect((await f.send()).status).toBe(202);
    await f.settle();
    f.reviews[0]!.state = 'CHANGES_REQUESTED';
    let unavailable = true;
    f.controls.onList = async () => {
      if (unavailable) {
        unavailable = false;
        throw new Error('temporary network failure');
      }
    };
    expect((await f.claim()).status).toBe(200);
    expect(f.reviews[0]!.state).toBe('DISMISSED');
    expect(await f.store.getDeliveryOutcome(event.deliveryId)).toMatchObject({
      status: 'scheduled',
    });
  } finally {
    await f.settle();
    f.database.close();
  }
});

it('keeps a prior Request changes dismissed when the replacement round fails', async () => {
  const f = await resetFixture();
  try {
    f.reviews[0]!.state = 'CHANGES_REQUESTED';
    expect((await f.send()).status).toBe(202);
    await f.settle();
    expect(f.reviews[0]!.state).toBe('DISMISSED');
    f.controls.repositoryUnavailable = true;
    expect((await f.claim()).status).toBe(503);
    expect(await f.store.getDeliveryOutcome(event.deliveryId)).toMatchObject({ status: 'failed' });
    expect(f.reviews[0]!.state).toBe('DISMISSED');
    expect(f.reviews[0]!.body).toContain('Old review body');
  } finally {
    await f.settle();
    f.database.close();
  }
});
