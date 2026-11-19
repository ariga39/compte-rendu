import { afterEach, expect, it, vi } from 'vitest';
import { createApplication } from '../apps/dashboard/src/lib/server/application';
import { SqliteD1Database } from './support/d1-database';

afterEach(() => vi.unstubAllGlobals());

it('requires live GitHub UID and 2FA on every model change and preserves the previous revision on denial', async () => {
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
        lastRefreshError: null,
      }),
      refreshCatalog: async () => {},
      issue: async () => ({ kind: 'invalid' }),
      revoke: async () => ({ kind: 'revoked' }),
      usage: async () => null,
    },
  });
  let profile: Record<string, unknown> = { id: 42, two_factor_authentication: true };
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    if (
      (input instanceof Request ? input.url : String(input)) ===
      'https://github.com/login/oauth/access_token'
    )
      return Response.json({ token_type: 'bearer', access_token: 'github-user-token' });
    if ((input instanceof Request ? input.url : String(input)) === 'https://api.github.com/user')
      return Response.json(profile);
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
    const write = (revision: number, site = origin) =>
      call('/api/model-settings', {
        method: 'PUT',
        headers: { cookie, origin: site, 'content-type': 'application/json' },
        body: JSON.stringify({
          revision,
          selection: { reviewers: ['model/a'], synthesis: 'model/a' },
        }),
      });
    expect((await write(0, 'https://elsewhere.test')).status).toBe(403);
    expect((await write(0)).status).toBe(200);
    expect((await write(0)).status).toBe(409);
    for (const unauthorized of [
      { id: 42, two_factor_authentication: false },
      { id: 42 },
      { id: 1, two_factor_authentication: true },
    ]) {
      profile = unauthorized;
      expect((await write(1)).status).toBe(403);
    }
    profile = { id: 42, two_factor_authentication: true };
    const read = await call('/api/model-settings', { headers: { cookie } });
    expect(await read.json()).toMatchObject({
      configuration: { revision: 1 },
      routes: ['model/a'],
    });
  } finally {
    db.close();
  }
});
