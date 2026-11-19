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
    lastAttemptAt: null,
    lastSuccessAt: null,
    rejected: 0,
    lastRefreshError: null,
  }),
  refreshCatalog: async () => {},
  issue: async () => ({ kind: 'invalid' as const }),
  revoke: async () => ({ kind: 'revoked' as const }),
  usage: async () => null,
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
        lastAttemptAt: null,
        lastSuccessAt: null,
        rejected: 0,
        lastRefreshError: 'refresh failed',
      }),
      refreshCatalog: async () => {},
      issue: async () => ({ kind: 'invalid' }),
      revoke: async () => ({ kind: 'revoked' }),
      usage: async () => null,
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
      configuration: { revision: 1 },
      catalogRefreshFailed: true,
      routes: ['model/a'],
    });
    profile = { id: 42, two_factor_authentication: false };
    expect((await write(1)).status).toBe(200);
  } finally {
    db.close();
  }
});
