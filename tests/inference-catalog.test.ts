import { afterEach, expect, it, vi } from 'vitest';
import { createRelayCatalog } from '../apps/inference-worker/src/catalog';
import { createGrantControl } from '../apps/inference-worker/src/grants';
import { SqliteD1Database } from './support/d1-database';

afterEach(() => vi.unstubAllGlobals());
it('keeps formerly listed models available across refreshes and fresh relay instances', async () => {
  const db = new SqliteD1Database(
    ['0001_grants.sql', '0002_requests.sql', '0003_catalog.sql'],
    '../../apps/inference-worker/migrations',
  );
  const source = {
    url: 'https://models.example/v1/models',
    prefix: 'review-provider/',
    providerSlug: 'custom-review',
    credentialAlias: 'default',
  };
  try {
    let entries: unknown[] = [{ id: 'original' }, {}];
    const observedHeaders: Headers[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      observedHeaders.push(new Headers(init.headers));
      return Response.json({ data: entries });
    });
    await createRelayCatalog(db, [source]).refresh(60_000);
    expect(await createRelayCatalog(db, [source]).get()).toMatchObject({
      routes: ['review-provider/original'],
      rejected: 1,
    });
    entries = [{ id: 'new' }];
    await createRelayCatalog(db, [source]).refresh(120_000);
    expect(await createRelayCatalog(db, [source]).get()).toMatchObject({
      routes: ['review-provider/new', 'review-provider/original'],
      rejected: 0,
    });
    expect(
      observedHeaders.every(
        (headers) => !headers.has('authorization') && !headers.has('cf-aig-authorization'),
      ),
    ).toBe(true);
  } finally {
    db.close();
  }
});

it('requires the operator bearer to read the relay catalog from the application', async () => {
  const { createApplication } = await import('../apps/dashboard/src/lib/server/application');
  const db = new SqliteD1Database();
  try {
    const catalog = {
      routes: ['provider/model'],
      lastAttemptAt: null,
      lastSuccessAt: null,
      rejected: 0,
      lastRefreshError: null,
    };
    const app = createApplication({
      REVIEW_DB: db,
      GITHUB_APP_ID: '1',
      GITHUB_APP_PRIVATE_KEY: 'unused',
      WEBHOOK_SECRET: 'unused',
      ALLOWED_INSTALLATION_IDS: '[1]',
      REVIEW_CONFIGURATION_TOKEN: 'operator',
      INFERENCE_RELAY: {
        issue: async () => ({ kind: 'invalid' }),
        revoke: async () => ({ kind: 'revoked' }),
        usage: async () => null,
        catalog: async () => catalog,
        refreshCatalog: async () => {},
      },
    });
    const get = (bearer: string) =>
      app.fetch(
        new Request('https://reviews.example/api/review-configuration/catalog', {
          headers: { authorization: 'Bearer ' + bearer },
        }),
      );
    expect((await get('other')).status).toBe(401);
    expect(await (await get('operator')).json()).toEqual(catalog);
  } finally {
    db.close();
  }
});

it('preserves the last complete refresh and bounds newly discovered routes', async () => {
  const db = new SqliteD1Database(
    ['0001_grants.sql', '0002_requests.sql', '0003_catalog.sql'],
    '../../apps/inference-worker/migrations',
  );
  const catalog = createRelayCatalog(db, [
    {
      url: 'https://models.example/catalog',
      prefix: 'p/',
      providerSlug: 'custom-review',
      credentialAlias: 'default',
    },
  ]);
  try {
    vi.stubGlobal('fetch', async () => Response.json({ data: [{ id: 'old' }] }));
    await catalog.refresh(100);
    vi.stubGlobal('fetch', async () =>
      Response.json({ data: Array.from({ length: 1001 }, (_, i) => ({ id: 'm' + i })) }),
    );
    await catalog.refresh(200);
    const capped = await catalog.get();
    expect(capped.routes).toHaveLength(1000);
    expect(capped.routes).toContain('p/old');
    expect(capped.lastRefreshError).toBe('catalog limit reached');
    vi.stubGlobal('fetch', async () => {
      throw new Error('private detail');
    });
    await catalog.refresh(300);
    const failed = await catalog.get();
    expect(failed.routes).toEqual(capped.routes);
    expect(failed.lastSuccessAt).toEqual(new Date(100).toISOString());
    expect(failed.lastRefreshError).toBe('refresh failed');
  } finally {
    db.close();
  }
});

it('reports an attempted route remap and keeps its former mapping', async () => {
  const db = new SqliteD1Database(
    ['0001_grants.sql', '0002_requests.sql', '0003_catalog.sql'],
    '../../apps/inference-worker/migrations',
  );
  try {
    vi.stubGlobal('fetch', async () => Response.json({ data: [] }));
    const source = {
      url: 'https://models.example/models',
      prefix: 'p/',
      providerSlug: 'custom-review',
      credentialAlias: 'default',
      aliases: { review: 'one' },
    };
    await createRelayCatalog(db, [source]).refresh(100);
    const changed = createRelayCatalog(db, [{ ...source, aliases: { review: 'two' } }]);
    await changed.refresh(200);
    expect(await changed.get()).toMatchObject({
      lastRefreshError: 'route mapping conflict',
      lastSuccessAt: new Date(100).toISOString(),
    });
    await createRelayCatalog(db, [source]).refresh(300);
    expect(await changed.get()).toMatchObject({
      lastRefreshError: null,
      lastSuccessAt: new Date(300).toISOString(),
    });
  } finally {
    db.close();
  }
});

it('an older refresh finishing last cannot overwrite a newer failure', async () => {
  const db = new SqliteD1Database(
    ['0001_grants.sql', '0002_requests.sql', '0003_catalog.sql'],
    '../../apps/inference-worker/migrations',
  );
  const source = {
    url: 'https://models.example/models',
    prefix: 'p/',
    providerSlug: 'custom-review',
    credentialAlias: 'default',
  };
  const catalog = createRelayCatalog(db, [source]);
  try {
    vi.stubGlobal('fetch', async () => Response.json({ data: [{ id: 'old' }] }));
    await catalog.refresh(100);
    let finish!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    vi.stubGlobal('fetch', () => pending);
    const older = catalog.refresh(200);
    vi.stubGlobal('fetch', async () => new Response(null, { status: 503 }));
    await catalog.refresh(300);
    finish(Response.json({ data: [{ id: 'other' }] }));
    await older;
    expect(await catalog.get()).toMatchObject({
      lastAttemptAt: new Date(300).toISOString(),
      lastRefreshError: 'refresh failed',
    });
  } finally {
    db.close();
  }
});

it('retains explicit aliases served by a separate provider without discovering unrelated routes there', async () => {
  const db = new SqliteD1Database(
    ['0001_grants.sql', '0002_requests.sql', '0003_catalog.sql'],
    '../../apps/inference-worker/migrations',
  );
  const fetch = vi.fn(async () => Response.json({ data: [{ id: 'current' }] }));
  vi.stubGlobal('fetch', fetch);
  try {
    const { RelayCatalogSources } = await import('../apps/inference-worker/src/catalog-config');
    const { Schema } = await import('effect');
    const sources = Schema.decodeUnknownSync(RelayCatalogSources)([
      {
        url: 'https://models.example/native/models',
        prefix: 'provider/',
        providerSlug: 'custom-current',
        credentialAlias: 'default',
      },
      {
        providerSlug: 'custom-legacy',
        credentialAlias: 'default',
        aliases: { 'old-review': 'old-model' },
      },
    ]);
    const catalog = createRelayCatalog(db, sources);
    await catalog.refresh(50);
    expect(await catalog.get()).toMatchObject({
      routes: ['old-review', 'provider/current'],
      lastRefreshError: null,
    });
    expect(fetch.mock.calls).toHaveLength(1);
  } finally {
    db.close();
  }
});

it('discovers a private provider catalog only through its trusted Gateway BYOK route', async () => {
  const db = new SqliteD1Database(
    ['0001_grants.sql', '0002_requests.sql', '0003_catalog.sql'],
    '../../apps/inference-worker/migrations',
  );
  const { RelayCatalogSources } = await import('../apps/inference-worker/src/catalog-config');
  const { Schema } = await import('effect');
  try {
    const observed: { url: string; headers: Headers; redirect?: RequestRedirect }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      observed.push({ url, headers: new Headers(init.headers), redirect: init.redirect });
      return Response.json({ data: [{ id: 'custom-model' }] });
    });
    const configured = {
      discovery: 'gateway',
      prefix: 'p/',
      providerSlug: 'custom-private',
      credentialAlias: 'billing',
    };
    const decode = Schema.decodeUnknownSync(RelayCatalogSources, { onExcessProperty: 'error' });
    const catalog = createRelayCatalog(db, decode([configured]), {
      accountId: 'account',
      gatewayId: 'gateway',
      runToken: 'test-run-token',
    });
    await catalog.refresh(60);
    expect(await catalog.get()).toMatchObject({
      routes: ['p/custom-model'],
      lastRefreshError: null,
    });
    expect(observed[0]?.url).toBe(
      'https://gateway.ai.cloudflare.com/v1/account/gateway/custom-private/models',
    );
    expect(observed[0]?.headers.get('cf-aig-authorization')).toBe('Bearer test-run-token');
    expect(observed[0]?.headers.get('cf-aig-byok-alias')).toBe('billing');
    expect(observed[0]?.redirect).toBe('manual');
    expect(() => decode([{ ...configured, url: 'https://other.example' }])).toThrow();
  } finally {
    db.close();
  }
});

it('freezes the alias-only source provider and credential on a legacy grant', async () => {
  const db = new SqliteD1Database(
    ['0001_grants.sql', '0002_requests.sql', '0003_catalog.sql'],
    '../../apps/inference-worker/migrations',
  );
  const { RelayCatalogSources } = await import('../apps/inference-worker/src/catalog-config');
  const { Schema } = await import('effect');
  try {
    const sources = Schema.decodeUnknownSync(RelayCatalogSources)([
      {
        providerSlug: 'custom-legacy',
        credentialAlias: 'billing',
        aliases: { 'legacy-review': 'legacy-model' },
      },
    ]);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await createRelayCatalog(db, sources).refresh(50);
    expect(fetch).not.toHaveBeenCalled();

    const deadline = Date.now() + 60_000;
    await expect(
      createGrantControl(db).issue({
        jobId: 'job-legacy',
        snapshot: { routes: ['legacy-review'] },
        latestIssueDeadline: deadline,
      }),
    ).resolves.toMatchObject({ kind: 'issued' });
    const grant = db.database
      .prepare('SELECT route_mapping FROM grants WHERE job_id = ?')
      .get('job-legacy') as { readonly route_mapping: string };
    expect(JSON.parse(grant.route_mapping)).toEqual([
      {
        routeId: 'legacy-review',
        upstreamModel: 'legacy-model',
        providerSlug: 'custom-legacy',
        credentialAlias: 'billing',
      },
    ]);
  } finally {
    db.close();
  }
});

it('validates the combined prefix and model length per discovered route', async () => {
  const db = new SqliteD1Database(
    ['0001_grants.sql', '0002_requests.sql', '0003_catalog.sql'],
    '../../apps/inference-worker/migrations',
  );
  const { RelayCatalogSources } = await import('../apps/inference-worker/src/catalog-config');
  const { Schema } = await import('effect');
  try {
    const prefix = 'a'.repeat(127);
    const sources = Schema.decodeUnknownSync(RelayCatalogSources)([
      {
        url: 'https://models.example/models',
        prefix,
        providerSlug: 'custom-review',
        credentialAlias: 'default',
      },
    ]);
    vi.stubGlobal('fetch', async () => Response.json({ data: [{ id: 'a' }, { id: 'ab' }] }));
    const catalog = createRelayCatalog(db, sources);
    await catalog.refresh(25);
    expect(await catalog.get()).toMatchObject({
      routes: [`${prefix}a`],
      rejected: 1,
      lastRefreshError: null,
    });
  } finally {
    db.close();
  }
});
