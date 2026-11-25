import { createD1ReviewStateStore } from '../apps/core/src/review-state-store';
import { afterEach, expect, it, vi } from 'vitest';
import { createApplication } from '../apps/dashboard/src/lib/server/application';
import { SqliteD1Database } from './support/d1-database';

const origin = 'https://reviews.test';
const tokenEndpoint = 'https://github.com/login/oauth/access_token';
const userEndpoint = 'https://api.github.com/user';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const relay = {
  catalog: async () => ({
    routes: ['model/a'],
    efforts: {},
    lastAttemptAt: null,
    lastSuccessAt: null,
    rejected: 0,
    lastRefreshError: null,
  }),
  refreshCatalog: async () => {},
  issueV2: async () => ({ kind: 'invalid' as const }),
  revoke: async () => ({ kind: 'revoked' as const }),
  usage: async () => null,
  effortStates: async () => ({ routes: [] }),
  effortDetails: async () => null,
};

function createApp() {
  const db = new SqliteD1Database();
  const app = createApplication({
    REVIEW_DB: db,
    WEBHOOK_SECRET: 'test',
    GITHUB_APP_ID: '1',
    GITHUB_APP_PRIVATE_KEY: 'test',
    ALLOWED_INSTALLATION_IDS: '[7]',
    DASHBOARD_ORIGIN: origin,
    DASHBOARD_GITHUB_CLIENT_ID: 'Iv23test',
    DASHBOARD_GITHUB_CLIENT_SECRET: 'test-secret',
    DASHBOARD_MODEL_EDITOR_IDS: '[42]',
    INFERENCE_RELAY: relay,
  });
  return { app, db };
}

function stubGitHub(profile: () => Record<string, unknown> | Response) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push(url);
    if (url === tokenEndpoint)
      return Response.json({ token_type: 'bearer', access_token: 'github-user-token' });
    if (url === userEndpoint) {
      const value = profile();
      return value instanceof Response ? value : Response.json(value);
    }
    throw Error('unexpected upstream');
  });
  return calls;
}

async function signIn(app: ReturnType<typeof createApp>['app'], returnTo?: string) {
  const query = returnTo === undefined ? '' : `?returnTo=${encodeURIComponent(returnTo)}`;
  const login = await app.fetch(new Request(origin + '/auth/github' + query));
  expect(login.status).toBe(303);
  const authorize = new URL(login.headers.get('location')!);
  const flow = login.headers.getSetCookie()[0]!.split(';')[0]!;
  const callback = await app.fetch(
    new Request(
      origin + '/auth/github/callback?code=test&state=' + authorize.searchParams.get('state'),
      {
        headers: { cookie: flow },
      },
    ),
  );
  expect(callback.status).toBe(303);
  const cookie = callback.headers
    .getSetCookie()
    .find((value) => value.startsWith('__Host-cr-session='))
    ?.split(';')[0];
  expect(cookie).toBeTruthy();
  return { login, authorize, callback, cookie: cookie! };
}

it('returns signed-out viewer state without contacting GitHub when no session is presented', async () => {
  const { app, db } = createApp();
  const calls = stubGitHub(() => {
    throw Error('GitHub must not be contacted for an anonymous viewer');
  });
  try {
    const reply = await app.fetch(new Request(origin + '/api/session'));
    expect(reply.status).toBe(200);
    expect(reply.headers.get('cache-control')).toBe('no-store');
    expect(await reply.json()).toEqual({ signedIn: false, account: null, operator: false });
    expect(calls).toEqual([]);
  } finally {
    db.close();
  }
});

it('returns signed-in identity and operator capability separately without exposing the token', async () => {
  const { app, db } = createApp();
  let profile: Record<string, unknown> = { id: 42, login: 'operator' };
  stubGitHub(() => profile);
  try {
    const { cookie } = await signIn(app);
    const allowed = await app.fetch(new Request(origin + '/api/session', { headers: { cookie } }));
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('cache-control')).toBe('no-store');
    const allowedBody = await allowed.text();
    expect(JSON.parse(allowedBody)).toEqual({
      signedIn: true,
      account: { login: 'operator' },
      operator: true,
    });
    expect(allowedBody).not.toContain('github-user-token');

    profile = { id: 7, login: 'visitor' };
    const disallowed = await app.fetch(
      new Request(origin + '/api/session', { headers: { cookie } }),
    );
    expect(disallowed.status).toBe(200);
    expect(await disallowed.json()).toEqual({
      signedIn: true,
      account: { login: 'visitor' },
      operator: false,
    });
  } finally {
    db.close();
  }
});

it('keeps the sign-in return target in the state-bound flow and rejects unsafe targets', async () => {
  const { app, db } = createApp();
  stubGitHub(() => ({ id: 42, login: 'octocat' }));
  try {
    const job = await signIn(app, '/jobs/run-1');
    expect(job.authorize.searchParams.has('returnTo')).toBe(false);
    expect(job.callback.headers.get('location')).toBe('/jobs/run-1');

    const filtered = await signIn(app, '/history?status=failed&cursor=CURSOR-1');
    expect(filtered.callback.headers.get('location')).toBe(
      '/history?status=failed&cursor=CURSOR-1',
    );

    const dottedJob = await signIn(app, '/jobs/run.1');
    expect(dottedJob.callback.headers.get('location')).toBe('/jobs/run.1');

    const dottedFilter = await signIn(app, '/history?status=failed&cursor=CURSOR.1');
    expect(dottedFilter.callback.headers.get('location')).toBe(
      '/history?status=failed&cursor=CURSOR.1',
    );

    const datedFilter = await signIn(app, '/history?from=2026-10-16&to=2026-10-16');
    const datedLocation = new URL(datedFilter.callback.headers.get('location')!, origin);
    expect(datedLocation.pathname).toBe('/history');
    expect(datedLocation.searchParams.get('from')).toBe('2026-10-16T00:00:00.000Z');
    expect(datedLocation.searchParams.get('to')).toBe('2026-10-16T23:59:59.999Z');

    const legacy = await signIn(app);
    expect(legacy.callback.headers.get('location')).toBe('/settings');

    for (const target of [
      'https://evil.test/steal',
      '//evil.test/steal',
      '/\\evil.test/steal',
      '/%2f%2fevil.test/steal',
      '/jobs/%2e%2e/settings',
      '/' + 'a'.repeat(600),
    ]) {
      const rejected = await signIn(app, target);
      expect(rejected.callback.headers.get('location'), target).toBe('/');
    }
  } finally {
    db.close();
  }
});

it('signs out only from a same-origin POST and returns to a safe page', async () => {
  const { app, db } = createApp();
  stubGitHub(() => ({ id: 42, login: 'octocat' }));
  try {
    const { cookie } = await signIn(app, '/jobs/run-1');
    const logout = await app.fetch(
      new Request(
        origin + '/auth/logout?returnTo=' + encodeURIComponent('/history?status=failed'),
        { method: 'POST', headers: { origin, cookie } },
      ),
    );
    expect(logout.status).toBe(303);
    expect(logout.headers.get('location')).toBe('/history?status=failed');
    expect(
      logout.headers.getSetCookie().find((value) => value.startsWith('__Host-cr-session=')),
    ).toContain('Max-Age=0');

    const rejected = await app.fetch(
      new Request(origin + '/auth/logout', {
        method: 'POST',
        headers: { origin: 'https://evil.test', cookie },
      }),
    );
    expect(rejected.status).toBe(403);

    const unsafe = await app.fetch(
      new Request(origin + '/auth/logout?returnTo=' + encodeURIComponent('https://evil.test/'), {
        method: 'POST',
        headers: { origin, cookie },
      }),
    );
    expect(unsafe.status).toBe(303);
    expect(unsafe.headers.get('location')).toBe('/');
    const traversal = await app.fetch(
      new Request(origin + '/auth/logout?returnTo=/history/%2E%2E/settings', {
        method: 'POST',
        headers: { origin, cookie },
      }),
    );
    expect(traversal.headers.get('location')).toBe('/');
  } finally {
    db.close();
  }
});

it('treats an expired or unreadable session as signed out and survives a GitHub outage', async () => {
  const { app, db } = createApp();
  stubGitHub(() => ({ id: 42, login: 'octocat' }));
  try {
    const { cookie } = await signIn(app);
    const unreadable = await app.fetch(
      new Request(origin + '/api/session', {
        headers: { cookie: '__Host-cr-session=not-a-session' },
      }),
    );
    expect(unreadable.status).toBe(401);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.now() + 3_601_000));
    const expired = await app.fetch(new Request(origin + '/api/session', { headers: { cookie } }));
    expect(expired.status).toBe(401);
    vi.useRealTimers();

    vi.stubGlobal('fetch', async () => {
      throw Error('GitHub is unavailable');
    });
    const unavailable = await app.fetch(
      new Request(origin + '/api/session', { headers: { cookie } }),
    );
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({
      error: 'Could not retrieve your GitHub account details.',
    });
  } finally {
    db.close();
  }
});

it('requires an allowlisted GitHub UID on every model change and preserves the previous revision on denial', async () => {
  const db = new SqliteD1Database();
  const origin = 'https://reviews.test';
  const app = createApplication({
    REVIEW_DB: db,
    WEBHOOK_SECRET: 'test',
    GITHUB_APP_ID: '1',
    GITHUB_APP_PRIVATE_KEY: 'test',
    ALLOWED_INSTALLATION_IDS: '[7]',
    DASHBOARD_ORIGIN: origin,
    DASHBOARD_GITHUB_CLIENT_ID: 'Iv23test',
    DASHBOARD_GITHUB_CLIENT_SECRET: 'test-secret',
    DASHBOARD_MODEL_EDITOR_IDS: '[42]',
    INFERENCE_RELAY: {
      catalog: async () => ({
        routes: ['model/a'],
        efforts: {},
        lastAttemptAt: null,
        lastSuccessAt: null,
        rejected: 0,
        lastRefreshError: 'refresh failed',
      }),
      refreshCatalog: async () => {},
      issueV2: async () => ({ kind: 'invalid' }),
      revoke: async () => ({ kind: 'revoked' }),
      usage: async () => null,
      effortStates: async () => ({ routes: [] }),
      effortDetails: async () => null,
    },
  });
  let profile: Record<string, unknown> | Response = { id: 42 };
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    if (
      (input instanceof Request ? input.url : String(input)) ===
      'https://github.com/login/oauth/access_token'
    )
      return Response.json({ token_type: 'bearer', access_token: 'github-user-token' });
    if ((input instanceof Request ? input.url : String(input)) === 'https://api.github.com/user')
      return profile instanceof Response ? profile : Response.json(profile);
    throw Error('unexpected upstream');
  });
  const call = (path: string, init?: RequestInit) => app.fetch(new Request(origin + path, init));
  try {
    const login = await call('/auth/github');
    expect(login.status).toBe(303);
    const authorize = new URL(login.headers.get('location')!);
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.has('scope')).toBe(false);
    const flow = login.headers.getSetCookie()[0]!.split(';')[0];
    expect((await call('/api/model-settings')).status).toBe(401);
    expect(
      (await call('/auth/github/callback?code=test&state=wrong', { headers: { cookie: flow! } }))
        .status,
    ).toBe(400);
    const callback = await call(
      '/auth/github/callback?code=test&state=' + authorize.searchParams.get('state'),
      { headers: { cookie: flow! } },
    );
    expect(callback.status).toBe(303);
    const cookie = callback.headers
      .getSetCookie()
      .find((c) => c.startsWith('__Host-cr-session='))!
      .split(';')[0]!;
    expect(cookie).not.toContain('github-user-token');
    const write = (revision: number, site = origin, route = 'model/a') =>
      call('/api/model-settings', {
        method: 'PUT',
        headers: { cookie, origin: site, 'content-type': 'application/json' },
        body: JSON.stringify({
          revision,
          selection: { reviewers: [route], synthesis: route },
        }),
      });
    expect((await write(0, 'https://elsewhere.test')).status).toBe(403);
    expect((await write(0, origin, 'not-in-catalog')).status).toBe(400);
    expect((await write(0)).status).toBe(200);
    expect((await write(0)).status).toBe(409);
    profile = { id: 1, two_factor_authentication: true };
    expect((await write(1)).status).toBe(403);
    profile = Response.redirect('https://example.test/');
    const unavailable = await write(1);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({
      error: 'Could not retrieve your GitHub account details.',
    });
    profile = { id: 42 };
    const read = await call('/api/model-settings', { headers: { cookie } });
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      configuration: { revision: 1, concurrency: null },
      catalogRefreshFailed: true,
      routes: ['model/a'],
    });
    profile = { id: 42, two_factor_authentication: false };
    expect((await write(1)).status).toBe(200);
    const concurrencyWrite = await call('/api/model-settings', {
      method: 'PUT',
      headers: { cookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({
        revision: 2,
        selection: { reviewers: ['model/a'], synthesis: 'model/a' },
        concurrency: 3,
      }),
    });
    expect(concurrencyWrite.status).toBe(200);
    const withConcurrency = await call('/api/model-settings', { headers: { cookie } });
    expect(await withConcurrency.json()).toMatchObject({
      configuration: { revision: 3, concurrency: 3 },
    });
  } finally {
    db.close();
  }
});

it('canonicalizes a dashboard origin with surrounding whitespace and a trailing slash', async () => {
  const db = new SqliteD1Database();
  const app = createApplication({
    REVIEW_DB: db,
    WEBHOOK_SECRET: 'test',
    GITHUB_APP_ID: '1',
    GITHUB_APP_PRIVATE_KEY: 'test',
    ALLOWED_INSTALLATION_IDS: '[7]',
    DASHBOARD_ORIGIN: '  https://reviews.test/  ',
    DASHBOARD_GITHUB_CLIENT_ID: 'Iv23test',
    DASHBOARD_GITHUB_CLIENT_SECRET: 'test-secret',
    DASHBOARD_MODEL_EDITOR_IDS: '[42]',
    INFERENCE_RELAY: relay,
  });
  stubGitHub(() => ({ id: 42, login: 'operator' }));
  try {
    const { cookie } = await signIn(app);
    const viewer = await app.fetch(new Request(origin + '/api/session', { headers: { cookie } }));
    expect(viewer.status).toBe(200);
    expect(await viewer.json()).toEqual({
      signedIn: true,
      account: { login: 'operator' },
      operator: true,
    });
    const settings = await app.fetch(
      new Request(origin + '/api/model-settings', { headers: { cookie } }),
    );
    expect(settings.status).toBe(200);

    const state = createD1ReviewStateStore(db);
    const queued = await state.claimReview({
      deliveryId: 'canonical-origin-cancel',
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
    if (queued.kind !== 'claimed') throw new Error('expected queued review');
    const cancelled = await app.fetch(
      new Request(origin + '/api/jobs/' + queued.runId + '/cancel', {
        method: 'POST',
        headers: { cookie, origin },
      }),
    );
    expect(cancelled.status).toBe(200);
  } finally {
    db.close();
  }
});

it.each([
  'https://reviews.test/path',
  'https://reviews.test/?query=1',
  'https://reviews.test/#fragment',
  'http://reviews.test',
  'https://operator:secret@reviews.test',
  'not a url',
])('rejects non-canonical dashboard origin %s', async (configured) => {
  const db = new SqliteD1Database();
  const app = createApplication({
    REVIEW_DB: db,
    WEBHOOK_SECRET: 'test',
    GITHUB_APP_ID: '1',
    GITHUB_APP_PRIVATE_KEY: 'test',
    ALLOWED_INSTALLATION_IDS: '[7]',
    DASHBOARD_ORIGIN: configured,
    DASHBOARD_GITHUB_CLIENT_ID: 'Iv23test',
    DASHBOARD_GITHUB_CLIENT_SECRET: 'test-secret',
    DASHBOARD_MODEL_EDITOR_IDS: '[42]',
    INFERENCE_RELAY: relay,
  });
  try {
    for (const path of ['/api/session', '/auth/github', '/api/model-settings'])
      expect((await app.fetch(new Request(origin + path))).status, path).toBe(503);
    const cancelled = await app.fetch(
      new Request(origin + '/api/jobs/run-1/cancel', {
        method: 'POST',
        headers: { origin },
      }),
    );
    expect(cancelled.status).toBe(403);
  } finally {
    db.close();
  }
});

it('requires the current operator and same origin to cancel a queued review by its public ID', async () => {
  const { app, db } = createApp();
  let uid = 42;
  stubGitHub(() => ({ id: uid, login: 'operator' }));
  try {
    const state = createD1ReviewStateStore(db);
    const queued = await state.claimReview({
      deliveryId: 'dashboard-cancel',
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
    if (queued.kind !== 'claimed') throw new Error('expected queued review');
    const cancel = (cookie: string, from: string, id = queued.runId) =>
      app.fetch(
        new Request(origin + '/api/jobs/' + id + '/cancel', {
          method: 'POST',
          headers: { cookie, origin: from },
        }),
      );
    expect((await cancel('', origin)).status).toBe(401);
    const { cookie } = await signIn(app);
    expect((await cancel(cookie, 'https://other.test')).status).toBe(403);
    uid = 99;
    expect((await cancel(cookie, origin)).status).toBe(403);
    expect(await state.getRunOutcome(queued.runId)).toMatchObject({ status: 'scheduled' });
    uid = 42;
    expect((await cancel(cookie, origin, 'unknown')).status).toBe(404);
    const response = await cancel(cookie, origin);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ status: 'cancelled', pendingCleanup: false });
    expect((await cancel(cookie, origin)).status).toBe(200);
    expect(await state.getRunOutcome(queued.runId)).toMatchObject({ status: 'cancelled' });
  } finally {
    db.close();
  }
});

it('returns the stored 503 when the model settings binding fails after catalog load', async () => {
  const db = new SqliteD1Database();
  let reads = 0;
  let armed = false;
  const app = createApplication({
    get REVIEW_DB() {
      reads += 1;
      if (armed && reads === 2) throw new Error('binding unavailable');
      return db;
    },
    WEBHOOK_SECRET: 'test',
    GITHUB_APP_ID: '1',
    GITHUB_APP_PRIVATE_KEY: 'test',
    ALLOWED_INSTALLATION_IDS: '[7]',
    DASHBOARD_ORIGIN: origin,
    DASHBOARD_GITHUB_CLIENT_ID: 'Iv23test',
    DASHBOARD_GITHUB_CLIENT_SECRET: 'test-secret',
    DASHBOARD_MODEL_EDITOR_IDS: '[42]',
    INFERENCE_RELAY: relay,
  });
  stubGitHub(() => ({ id: 42 }));
  try {
    const { cookie } = await signIn(app);
    armed = true;
    reads = 0;
    const response = await app.fetch(
      new Request(origin + '/api/model-settings', { headers: { cookie } }),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(await response.json()).toEqual({
      error: 'Could not read the saved model configuration.',
    });
  } finally {
    db.close();
  }
});

it('loads and saves concurrency through Settings when the catalog is unavailable', async () => {
  const db = new SqliteD1Database();
  let catalogUnavailable = false;
  const app = createApplication({
    REVIEW_DB: db,
    WEBHOOK_SECRET: 'test',
    GITHUB_APP_ID: '1',
    GITHUB_APP_PRIVATE_KEY: 'test',
    ALLOWED_INSTALLATION_IDS: '[7]',
    DASHBOARD_ORIGIN: origin,
    DASHBOARD_GITHUB_CLIENT_ID: 'Iv23test',
    DASHBOARD_GITHUB_CLIENT_SECRET: 'test-secret',
    DASHBOARD_MODEL_EDITOR_IDS: '[42]',
    INFERENCE_RELAY: {
      catalog: async () => {
        if (catalogUnavailable) throw new Error('relay unavailable');
        return {
          routes: ['model/a'],
          efforts: { 'model/a': [{ name: 'high', controls: { reasoning_effort: 'high' } }] },
          lastAttemptAt: '2026-11-25T00:00:00.000Z',
          lastSuccessAt: '2026-11-25T00:00:00.000Z',
          rejected: 0,
          lastRefreshError: null,
        };
      },
      refreshCatalog: async () => {},
      issueV2: async () => ({ kind: 'invalid' as const }),
      revoke: async () => ({ kind: 'revoked' as const }),
      usage: async () => null,
      effortStates: async () => ({ routes: [] }),
      effortDetails: async () => null,
    },
  });
  stubGitHub(() => ({ id: 42, login: 'operator' }));
  try {
    const { cookie } = await signIn(app);
    const request = (method: string, body?: unknown) =>
      app.fetch(
        new Request(origin + '/api/model-settings', {
          method,
          headers: { cookie, origin, 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
    expect(
      (
        await request('PUT', {
          revision: 0,
          selection: {
            reviewers: ['model/a'],
            synthesis: 'model/a',
            efforts: { 'model/a': 'high' },
          },
          concurrency: 2,
        })
      ).status,
    ).toBe(200);
    const before = db.database
      .prepare('SELECT selection, effort_snapshot FROM review_configuration WHERE id = 1')
      .get() as { selection: string; effort_snapshot: string };

    catalogUnavailable = true;
    const loaded = await request('GET');
    expect(loaded.status).toBe(200);
    expect(await loaded.json()).toMatchObject({
      configuration: {
        revision: 1,
        concurrency: 2,
        selection: { reviewers: ['model/a'], synthesis: 'model/a' },
      },
      routes: [],
      catalogUnavailable: true,
      catalogRefreshFailed: false,
    });

    const saved = await request('PUT', { revision: 1, concurrency: 5 });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({
      revision: 2,
      concurrency: 5,
      selection: {
        reviewers: ['model/a'],
        synthesis: 'model/a',
        efforts: { 'model/a': 'high' },
      },
    });
    const after = db.database
      .prepare(
        'SELECT selection, effort_snapshot, runner_concurrency FROM review_configuration WHERE id = 1',
      )
      .get() as { selection: string; effort_snapshot: string; runner_concurrency: number };
    expect(after.runner_concurrency).toBe(5);
    expect(after.selection).toBe(before.selection);
    expect(after.effort_snapshot).toBe(before.effort_snapshot);

    // Normal model editing resumes once the catalog is reachable again.
    catalogUnavailable = false;
    expect(
      (
        await request('PUT', {
          revision: 2,
          selection: { reviewers: ['model/a'], synthesis: 'model/a' },
        })
      ).status,
    ).toBe(200);
  } finally {
    db.close();
  }
});
