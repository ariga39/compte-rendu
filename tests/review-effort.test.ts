import { expect, it, vi } from 'vitest';
import { Effect } from 'effect';
import type { EffortJobDetail } from '../packages/contracts/src';
import { createCoreWorker } from './support/core-worker-runtime';
import { resetReviewEffort } from '../apps/core/src/review-configuration';
import { createD1ReviewStateStore } from '../apps/core/src/index';
import { createApplication } from '../apps/dashboard/src/lib/server/application';
import { SqliteD1Database } from './support/d1-database';

const deepseek = 'review-provider/deepseek-v4.1-flash';
const mimo = 'review-provider/mimo-v2.6-flash';
const deepseekControls = { reasoning_effort: 'high' as const };
const mimoControls = { thinking: { type: 'disabled' as const } };

const catalog = () => ({
  routes: [deepseek, mimo],
  efforts: {
    [deepseek]: [{ name: 'high', controls: deepseekControls }],
    [mimo]: [{ name: 'off', controls: mimoControls }],
  },
  lastAttemptAt: null,
  lastSuccessAt: null,
  rejected: 0,
  lastRefreshError: null,
});

const selection = {
  reviewers: [deepseek, mimo],
  synthesis: deepseek,
  efforts: { [deepseek]: 'high', [mimo]: 'off' },
};

const environment = (database: SqliteD1Database, overrides: Record<string, unknown> = {}) => ({
  REVIEW_DB: database,
  GITHUB_APP_ID: '1',
  GITHUB_APP_PRIVATE_KEY: 'test-private-key',
  REVIEW_CONFIGURATION_TOKEN: 'operator-token',
  INFERENCE_RELAY: {
    catalog: async () => catalog(),
    refreshCatalog: async () => {},
    issue: async () => ({ kind: 'invalid' as const }),
    issueV2: async () => ({ kind: 'invalid' as const }),
    revoke: async () => ({ kind: 'revoked' as const }),
    usage: async () => null,
    ...overrides,
  },
});

const settingsRequest = (method: string, body?: unknown, path = '/api/review-configuration') =>
  new Request('https://reviews.test' + path, {
    method,
    headers: { authorization: 'Bearer operator-token', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

it('resolves operator effort names against the trusted catalog without accepting controls', async () => {
  const database = new SqliteD1Database();
  try {
    const core = createCoreWorker(environment(database));
    const saved = await core.handleReviewConfiguration(
      settingsRequest('PUT', { revision: 0, selection }),
    );
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ revision: 1, selection });

    const row = database.database
      .prepare('SELECT effort_snapshot FROM review_configuration WHERE id = 1')
      .get() as { effort_snapshot: string };
    expect(JSON.parse(row.effort_snapshot)).toEqual([
      { routeId: deepseek, generation: 0, name: 'high', controls: deepseekControls },
      { routeId: mimo, generation: 0, name: 'off', controls: mimoControls },
    ]);

    for (const invalid of [
      {
        revision: 1,
        selection: { ...selection, efforts: { [deepseek]: 'missing' } },
      },
      {
        revision: 1,
        selection: { ...selection, efforts: { 'not-selected': 'high' } },
      },
      {
        revision: 1,
        selection: {
          ...selection,
          efforts: { [deepseek]: { name: 'high', controls: deepseekControls } },
        },
      },
      {
        revision: 1,
        selection,
        efforts: [{ routeId: deepseek, generation: 0, name: 'high', controls: deepseekControls }],
      },
    ]) {
      expect((await core.handleReviewConfiguration(settingsRequest('PUT', invalid))).status).toBe(
        400,
      );
    }
    const restored = await core.handleReviewConfiguration(settingsRequest('GET'));
    expect(await restored.json()).toEqual({ revision: 1, selection });
  } finally {
    database.close();
  }
});

it('freezes effort controls and generations at admission and advances only on explicit reset', async () => {
  const database = new SqliteD1Database();
  try {
    const core = createCoreWorker(environment(database));
    expect(
      (await core.handleReviewConfiguration(settingsRequest('PUT', { revision: 0, selection })))
        .status,
    ).toBe(200);
    const store = createD1ReviewStateStore(database);
    const admit = (deliveryId: string, pullRequestNumber: number, occurredAt: string) =>
      store.claimReview({
        deliveryId,
        occurredAt,
        job: {
          repositoryId: 11,
          installationId: 7,
          pullRequestNumber,
          baseSha: '1'.repeat(40),
          headSha: '2'.repeat(40),
          trigger: 'automatic',
        },
      });
    await admit('before-reset', 42, '2026-11-20T00:00:00.000Z');

    expect(
      (await core.handleReviewConfiguration(settingsRequest('PUT', { revision: 1, selection })))
        .status,
    ).toBe(200);
    const unchanged = await store.claimNextJob({
      jobId: 'job-before-reset',
      attempt: 1,
      occurredAt: '2026-11-20T00:01:00.000Z',
    });
    if (unchanged.kind !== 'claimed') throw new Error('expected the queued review');
    expect(unchanged.job.reviewConfiguration?.efforts).toEqual([
      { routeId: deepseek, generation: 0, name: 'high', controls: deepseekControls },
      { routeId: mimo, generation: 0, name: 'off', controls: mimoControls },
    ]);

    const stale = await Effect.runPromise(
      resetReviewEffort(
        settingsRequest(
          'POST',
          { revision: 1, route: deepseek },
          '/api/model-settings/effort-reset',
        ),
        database,
      ),
    );
    expect(stale.status).toBe(409);
    const reset = await Effect.runPromise(
      resetReviewEffort(
        settingsRequest(
          'POST',
          { revision: 2, route: deepseek },
          '/api/model-settings/effort-reset',
        ),
        database,
      ),
    );
    expect(reset.status).toBe(200);
    expect(await reset.json()).toEqual({ revision: 3, selection });

    await admit('after-reset', 43, '2026-11-20T00:02:00.000Z');
    const after = await store.claimNextJob({
      jobId: 'job-after-reset',
      attempt: 1,
      occurredAt: '2026-11-20T00:03:00.000Z',
    });
    if (after.kind !== 'claimed') throw new Error('expected the second review');
    expect(after.job.reviewConfiguration?.efforts).toEqual([
      { routeId: deepseek, generation: 1, name: 'high', controls: deepseekControls },
      { routeId: mimo, generation: 0, name: 'off', controls: mimoControls },
    ]);

    // An ordinary post-reset save without effort names must keep the advanced
    // generation instead of freezing 0 and reactivating the old marker.
    const cleared = { reviewers: [deepseek, mimo], synthesis: deepseek };
    expect(
      (
        await core.handleReviewConfiguration(
          settingsRequest('PUT', { revision: 3, selection: cleared }),
        )
      ).status,
    ).toBe(200);
    await admit('after-cleared-save', 44, '2026-11-20T00:04:00.000Z');
    const clearedClaim = await store.claimNextJob({
      jobId: 'job-after-cleared-save',
      attempt: 1,
      occurredAt: '2026-11-20T00:05:00.000Z',
    });
    if (clearedClaim.kind !== 'claimed') throw new Error('expected the cleared review');
    expect(clearedClaim.job.reviewConfiguration?.efforts).toEqual([
      { routeId: deepseek, generation: 1 },
    ]);
  } finally {
    database.close();
  }
});

it('issues the frozen route efforts to the v2 grant and refuses v1 explicit efforts', async () => {
  const database = new SqliteD1Database();
  const v1: unknown[] = [];
  const v2: unknown[] = [];
  try {
    const store = createD1ReviewStateStore(database);
    const saved = await createCoreWorker(environment(database)).handleReviewConfiguration(
      settingsRequest('PUT', { revision: 0, selection }),
    );
    expect(saved.status).toBe(200);
    await store.claimReview({
      deliveryId: 'grant-efforts',
      occurredAt: '2026-11-20T00:00:00.000Z',
      job: {
        repositoryId: 11,
        installationId: 7,
        pullRequestNumber: 42,
        baseSha: '1'.repeat(40),
        headSha: '2'.repeat(40),
        trigger: 'automatic',
      },
    });
    const claim = await store.claimNextJob({
      jobId: 'grant-job',
      attempt: 1,
      occurredAt: '2026-11-20T00:01:00.000Z',
    });
    if (claim.kind !== 'claimed') throw new Error('expected a claim');
    const application = createApplication({
      REVIEW_DB: database,
      GITHUB_APP_ID: '1',
      GITHUB_APP_PRIVATE_KEY: 'test',
      WEBHOOK_SECRET: 'test',
      ALLOWED_INSTALLATION_IDS: '[7]',
      RUNNER_CALLBACK_TOKEN: 'callback-token',
      INFERENCE_RELAY: {
        catalog: async () => catalog(),
        refreshCatalog: async () => {},
        issue: async (input) => {
          v1.push(input);
          return { kind: 'issued' as const, token: 'v1', expiresAt: '2030-01-01T00:00:00Z' };
        },
        issueV2: async (input) => {
          v2.push(input);
          return {
            kind: 'issued' as const,
            token: 'v2',
            expiresAt: '2030-01-01T00:00:00Z',
            descriptors: [deepseek, mimo].map((routeId) => ({ routeId, profile: 'chat' as const })),
          };
        },
        revoke: async () => ({ kind: 'revoked' as const }),
        usage: async () => null,
      },
    });
    const issue = (path: string) =>
      application.fetch(
        new Request('https://reviews.test' + path, {
          method: 'POST',
          headers: { authorization: 'Bearer callback-token' },
          body: JSON.stringify({
            runId: claim.runId,
            jobId: 'grant-job',
            attempt: 1,
            routes: [deepseek, mimo],
          }),
        }),
      );
    expect((await issue('/runner-llm/issue-v2')).status).toBe(201);
    expect(v2).toEqual([
      {
        jobId: 'grant-job',
        snapshot: {
          routes: [deepseek, mimo],
          efforts: [
            { routeId: deepseek, generation: 0, name: 'high', controls: deepseekControls },
            { routeId: mimo, generation: 0, name: 'off', controls: mimoControls },
          ],
        },
        latestIssueDeadline: expect.any(Number),
      },
    ]);
    expect((await issue('/runner-llm/issue')).status).toBe(409);
    expect(v1).toEqual([]);
  } finally {
    database.close();
  }
});

it('does not freeze an unused synthesis route and drops old ungranted snapshot entries', async () => {
  const database = new SqliteD1Database();
  const v1: unknown[] = [];
  const v2: unknown[] = [];
  try {
    const single = {
      reviewers: [deepseek],
      synthesis: mimo,
      efforts: { [deepseek]: 'high' },
    };
    const core = createCoreWorker(environment(database));
    expect(
      (
        await core.handleReviewConfiguration(
          settingsRequest('PUT', { revision: 0, selection: single }),
        )
      ).status,
    ).toBe(200);
    const saved = database.database
      .prepare('SELECT effort_snapshot FROM review_configuration WHERE id = 1')
      .get() as { effort_snapshot: string };
    expect(JSON.parse(saved.effort_snapshot)).toEqual([
      { routeId: deepseek, generation: 0, name: 'high', controls: deepseekControls },
    ]);

    const store = createD1ReviewStateStore(database);
    const admitted = await store.claimReview({
      deliveryId: 'single-unused-synthesis',
      occurredAt: '2026-11-20T00:00:00.000Z',
      job: {
        repositoryId: 11,
        installationId: 7,
        pullRequestNumber: 42,
        baseSha: '1'.repeat(40),
        headSha: '2'.repeat(40),
        trigger: 'automatic',
      },
    });
    if (admitted.kind !== 'claimed') throw new Error('expected admission');
    const claim = await store.claimNextJob({
      jobId: 'single-job',
      attempt: 1,
      occurredAt: '2026-11-20T00:01:00.000Z',
    });
    if (claim.kind !== 'claimed') throw new Error('expected a claim');

    // Simulate a run frozen by a previous build that also stored the unused
    // synthesis route. It must not become an ungranted control.
    const frozen = JSON.parse(
      (
        database.database
          .prepare('SELECT review_configuration FROM review_runs WHERE run_id = ?')
          .get(admitted.runId) as { review_configuration: string }
      ).review_configuration,
    ) as { efforts: unknown[] };
    frozen.efforts.push({ routeId: mimo, generation: 0 });
    database.database
      .prepare('UPDATE review_runs SET review_configuration = ? WHERE run_id = ?')
      .run(JSON.stringify(frozen), admitted.runId);

    const application = createApplication({
      REVIEW_DB: database,
      GITHUB_APP_ID: '1',
      GITHUB_APP_PRIVATE_KEY: 'test',
      WEBHOOK_SECRET: 'test',
      ALLOWED_INSTALLATION_IDS: '[7]',
      RUNNER_CALLBACK_TOKEN: 'callback-token',
      INFERENCE_RELAY: {
        catalog: async () => catalog(),
        refreshCatalog: async () => {},
        issue: async (input) => {
          v1.push(input);
          return { kind: 'issued' as const, token: 'v1', expiresAt: '2030-01-01T00:00:00Z' };
        },
        issueV2: async (input) => {
          v2.push(input);
          return {
            kind: 'issued' as const,
            token: 'v2',
            expiresAt: '2030-01-01T00:00:00Z',
            descriptors: [{ routeId: deepseek, profile: 'chat' as const }],
          };
        },
        revoke: async () => ({ kind: 'revoked' as const }),
        usage: async () => null,
      },
    });
    const issue = (path: string) =>
      application.fetch(
        new Request('https://reviews.test' + path, {
          method: 'POST',
          headers: { authorization: 'Bearer callback-token' },
          body: JSON.stringify({
            runId: claim.runId,
            jobId: 'single-job',
            attempt: 1,
            routes: [deepseek],
          }),
        }),
      );
    expect((await issue('/runner-llm/issue-v2')).status).toBe(201);
    expect(v2).toEqual([
      {
        jobId: 'single-job',
        snapshot: {
          routes: [deepseek],
          efforts: [{ routeId: deepseek, generation: 0, name: 'high', controls: deepseekControls }],
        },
        latestIssueDeadline: expect.any(Number),
      },
    ]);
    expect((await issue('/runner-llm/issue')).status).toBe(409);
    expect(v1).toEqual([]);
  } finally {
    database.close();
  }
});

it('omits default generation-only entries for a non-Chat reviewer and keeps reset generations', async () => {
  const database = new SqliteD1Database();
  const v2: unknown[] = [];
  try {
    const multi = {
      reviewers: [deepseek, mimo],
      synthesis: deepseek,
      efforts: { [deepseek]: 'high' },
    };
    const core = createCoreWorker(environment(database));
    expect(
      (
        await core.handleReviewConfiguration(
          settingsRequest('PUT', { revision: 0, selection: multi }),
        )
      ).status,
    ).toBe(200);
    const store = createD1ReviewStateStore(database);
    const admit = (deliveryId: string, pullRequestNumber: number, occurredAt: string) =>
      store.claimReview({
        deliveryId,
        occurredAt,
        job: {
          repositoryId: 11,
          installationId: 7,
          pullRequestNumber,
          baseSha: '1'.repeat(40),
          headSha: '2'.repeat(40),
          trigger: 'automatic',
        },
      });
    await admit('multi-non-chat', 42, '2026-11-20T00:00:00.000Z');
    const first = await store.claimNextJob({
      jobId: 'multi-job',
      attempt: 1,
      occurredAt: '2026-11-20T00:01:00.000Z',
    });
    if (first.kind !== 'claimed') throw new Error('expected the first claim');
    const application = createApplication({
      REVIEW_DB: database,
      GITHUB_APP_ID: '1',
      GITHUB_APP_PRIVATE_KEY: 'test',
      WEBHOOK_SECRET: 'test',
      ALLOWED_INSTALLATION_IDS: '[7]',
      RUNNER_CALLBACK_TOKEN: 'callback-token',
      INFERENCE_RELAY: {
        catalog: async () => ({
          ...catalog(),
          efforts: { [deepseek]: [{ name: 'high', controls: deepseekControls }] },
        }),
        refreshCatalog: async () => {},
        issue: async () => ({
          kind: 'issued' as const,
          token: 'v1',
          expiresAt: '2030-01-01T00:00:00Z',
        }),
        issueV2: async (input) => {
          // The real relay rejects a generation-only entry on a non-Chat route.
          if (input.snapshot.efforts?.some((effort) => effort.routeId !== deepseek))
            return { kind: 'invalid' as const };
          v2.push(input);
          return {
            kind: 'issued' as const,
            token: 'v2',
            expiresAt: '2030-01-01T00:00:00Z',
            descriptors: [
              { routeId: deepseek, profile: 'chat' as const },
              { routeId: mimo, profile: 'messages' as const },
            ],
          };
        },
        revoke: async () => ({ kind: 'revoked' as const }),
        usage: async () => null,
      },
    });
    const issue = (runId: string, jobId: string) =>
      application.fetch(
        new Request('https://reviews.test/runner-llm/issue-v2', {
          method: 'POST',
          headers: { authorization: 'Bearer callback-token' },
          body: JSON.stringify({
            runId,
            jobId,
            attempt: 1,
            routes: [deepseek, mimo],
          }),
        }),
      );
    expect((await issue(first.runId, 'multi-job')).status).toBe(201);
    expect(v2[0]).toMatchObject({
      snapshot: {
        routes: [deepseek, mimo],
        efforts: [{ routeId: deepseek, generation: 0, name: 'high', controls: deepseekControls }],
      },
    });

    expect(
      (
        await Effect.runPromise(
          resetReviewEffort(
            settingsRequest(
              'POST',
              { revision: 1, route: deepseek },
              '/api/model-settings/effort-reset',
            ),
            database,
          ),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await core.handleReviewConfiguration(
          settingsRequest('PUT', {
            revision: 2,
            selection: { reviewers: [deepseek, mimo], synthesis: deepseek },
          }),
        )
      ).status,
    ).toBe(200);
    await admit('multi-non-chat-after-reset', 43, '2026-11-20T00:02:00.000Z');
    const second = await store.claimNextJob({
      jobId: 'multi-job-reset',
      attempt: 1,
      occurredAt: '2026-11-20T00:03:00.000Z',
    });
    if (second.kind !== 'claimed') throw new Error('expected the second claim');
    expect((await issue(second.runId, 'multi-job-reset')).status).toBe(201);
    expect(v2[1]).toMatchObject({
      snapshot: {
        routes: [deepseek, mimo],
        efforts: [{ routeId: deepseek, generation: 1 }],
      },
    });
  } finally {
    database.close();
  }
});

it('projects the admission effort snapshot and terminal route summary in public detail', async () => {
  const database = new SqliteD1Database();
  try {
    const core = createCoreWorker(environment(database));
    expect(
      (await core.handleReviewConfiguration(settingsRequest('PUT', { revision: 0, selection })))
        .status,
    ).toBe(200);
    const store = createD1ReviewStateStore(database);
    const admitted = await store.claimReview({
      deliveryId: 'detail-efforts',
      occurredAt: '2026-11-20T00:00:00.000Z',
      job: {
        repositoryId: 11,
        installationId: 7,
        pullRequestNumber: 42,
        baseSha: '1'.repeat(40),
        headSha: '2'.repeat(40),
        trigger: 'automatic',
      },
    });
    if (admitted.kind !== 'claimed') throw new Error('expected admission');
    const claimed = await store.claimNextJob({
      jobId: 'detail-job',
      attempt: 1,
      occurredAt: '2026-11-20T00:01:00.000Z',
    });
    if (claimed.kind !== 'claimed') throw new Error('expected a claim');

    const waiting = await core.getPublicJobDetail(admitted.runId);
    expect(await waiting.json()).toMatchObject({
      efforts: {
        selection: [
          { route: deepseek, name: 'high', generation: 0 },
          { route: mimo, name: 'off', generation: 0 },
        ],
        summary: null,
      },
    });

    await store.recordModelUsage({
      runId: admitted.runId,
      jobId: 'detail-job',
      attempt: 1,
      usage: {
        version: 1,
        models: [],
        efforts: [
          {
            route: deepseek,
            selected: 'high',
            generation: 0,
            outcomes: [
              { kind: 'switched', reason: 'upstream rejected reasoning_effort', requests: 1 },
            ],
          },
        ],
      },
    });
    const terminal = await core.getPublicJobDetail(admitted.runId);
    expect(await terminal.json()).toMatchObject({
      efforts: {
        selection: expect.any(Array),
        summary: [
          {
            route: deepseek,
            selected: 'high',
            generation: 0,
            outcomes: [{ kind: 'switched', requests: 1 }],
          },
        ],
      },
    });
  } finally {
    database.close();
  }
});

const origin = 'https://reviews.test';
const tokenEndpoint = 'https://github.com/login/oauth/access_token';
const userEndpoint = 'https://api.github.com/user';

const signIn = async (app: ReturnType<typeof createApplication>) => {
  const login = await app.fetch(new Request(origin + '/auth/github'));
  expect(login.status).toBe(303);
  const authorize = new URL(login.headers.get('location')!);
  const flow = login.headers.getSetCookie()[0]!.split(';')[0]!;
  const callback = await app.fetch(
    new Request(
      origin + '/auth/github/callback?code=test&state=' + authorize.searchParams.get('state'),
      { headers: { cookie: flow } },
    ),
  );
  expect(callback.status).toBe(303);
  return callback.headers
    .getSetCookie()
    .find((value) => value.startsWith('__Host-cr-session='))!
    .split(';')[0]!;
};

const stubGitHub = (profile: Record<string, unknown>) => {
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === tokenEndpoint)
      return Response.json({ token_type: 'bearer', access_token: 'github-user-token' });
    if (url === userEndpoint) return Response.json(profile);
    throw Error('unexpected upstream');
  });
};

it('hides a relay fallback marker once an explicit reset advances the route generation', async () => {
  const database = new SqliteD1Database();
  const app = createApplication({
    REVIEW_DB: database,
    GITHUB_APP_ID: '1',
    GITHUB_APP_PRIVATE_KEY: 'test',
    WEBHOOK_SECRET: 'test',
    ALLOWED_INSTALLATION_IDS: '[7]',
    DASHBOARD_ORIGIN: origin,
    DASHBOARD_GITHUB_CLIENT_ID: 'Iv23test',
    DASHBOARD_GITHUB_CLIENT_SECRET: 'test-secret',
    DASHBOARD_MODEL_EDITOR_IDS: '[42]',
    INFERENCE_RELAY: {
      catalog: async () => catalog(),
      refreshCatalog: async () => {},
      issue: async () => ({ kind: 'invalid' as const }),
      issueV2: async () => ({ kind: 'invalid' as const }),
      revoke: async () => ({ kind: 'revoked' as const }),
      usage: async () => null,
      effortStates: async () => ({
        routes: [
          {
            routeId: deepseek,
            generation: 0,
            fallbackAt: '2026-11-20T00:00:00.000Z',
            reason: 'upstream rejected reasoning_effort',
          },
        ],
      }),
    },
  });
  stubGitHub({ id: 42, login: 'operator' });
  const core = createCoreWorker(environment(database));
  try {
    expect(
      (await core.handleReviewConfiguration(settingsRequest('PUT', { revision: 0, selection })))
        .status,
    ).toBe(200);
    const unauthorizedReset = await app.fetch(
      new Request(origin + '/api/model-settings/effort-reset', {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({ revision: 1, route: deepseek }),
      }),
    );
    expect(unauthorizedReset.status).toBe(401);
    const cookie = await signIn(app);
    const before = await app.fetch(
      new Request(origin + '/api/model-settings', { headers: { cookie } }),
    );
    expect(await before.json()).toMatchObject({
      effortStates: [{ routeId: deepseek, generation: 0 }],
    });
    const reset = await app.fetch(
      new Request(origin + '/api/model-settings/effort-reset', {
        method: 'POST',
        headers: { cookie, origin, 'content-type': 'application/json' },
        body: JSON.stringify({ revision: 1, route: deepseek }),
      }),
    );
    expect(reset.status).toBe(200);
    const after = await app.fetch(
      new Request(origin + '/api/model-settings', { headers: { cookie } }),
    );
    expect(await after.json()).toMatchObject({ effortStates: [] });
  } finally {
    database.close();
    vi.unstubAllGlobals();
  }
});

it('returns bounded per-request effort details only to the current editor', async () => {
  const database = new SqliteD1Database();
  const asked: string[] = [];
  const detail: EffortJobDetail = {
    jobId: 'detail-job',
    nextCursor: null,
    requests: [
      {
        requestId: 'request-1',
        route: deepseek,
        selected: 'high',
        generation: 0,
        fallback: 'switched',
        reason: 'upstream rejected reasoning_effort',
        attempts: [
          {
            attempt: 1,
            sent: deepseekControls,
            reported: null,
            result: 'rejected',
          },
          { attempt: 2, sent: null, reported: null, result: 'complete' },
        ],
      },
    ],
  };
  const app = createApplication({
    REVIEW_DB: database,
    GITHUB_APP_ID: '1',
    GITHUB_APP_PRIVATE_KEY: 'test',
    WEBHOOK_SECRET: 'test',
    ALLOWED_INSTALLATION_IDS: '[7]',
    DASHBOARD_ORIGIN: origin,
    DASHBOARD_GITHUB_CLIENT_ID: 'Iv23test',
    DASHBOARD_GITHUB_CLIENT_SECRET: 'test-secret',
    DASHBOARD_MODEL_EDITOR_IDS: '[42]',
    INFERENCE_RELAY: {
      catalog: async () => catalog(),
      refreshCatalog: async () => {},
      issue: async () => ({ kind: 'invalid' as const }),
      issueV2: async () => ({ kind: 'invalid' as const }),
      revoke: async () => ({ kind: 'revoked' as const }),
      usage: async () => null,
      effortDetails: async (input) => {
        asked.push(input.jobId);
        return detail;
      },
    },
  });
  stubGitHub({ id: 42, login: 'operator' });
  try {
    const store = createD1ReviewStateStore(database);
    await store.claimReview({
      deliveryId: 'detail-auth',
      occurredAt: '2026-11-20T00:00:00.000Z',
      job: {
        repositoryId: 11,
        installationId: 7,
        pullRequestNumber: 42,
        baseSha: '1'.repeat(40),
        headSha: '2'.repeat(40),
        trigger: 'automatic',
      },
    });
    const claim = await store.claimNextJob({
      jobId: 'detail-job',
      attempt: 1,
      occurredAt: '2026-11-20T00:01:00.000Z',
    });
    if (claim.kind !== 'claimed') throw new Error('expected a claim');

    const path = '/api/jobs/' + claim.runId + '/effort-details';
    expect((await app.fetch(new Request(origin + path))).status).toBe(401);
    const cookie = await signIn(app);
    const allowed = await app.fetch(new Request(origin + path, { headers: { cookie } }));
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual(detail);
    expect(asked).toEqual(['detail-job']);
  } finally {
    database.close();
    vi.unstubAllGlobals();
  }
});
