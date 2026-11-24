import { afterEach, expect, it, vi } from 'vitest';
import { createRelayCatalog } from '../apps/inference-worker/src/catalog';
import { RelayCatalogSources } from '../apps/inference-worker/src/catalog-config';
import { createGrantControl } from '../apps/inference-worker/src/grants';
import { Schema } from 'effect';
import { SqliteD1Database } from './support/d1-database';

const database = () => new SqliteD1Database('inference-worker');
const deadline = () => Date.now() + 60_000;

afterEach(() => vi.unstubAllGlobals());

it('replaces a source snapshot while retaining historical mappings for queued grants', async () => {
  const db = database();
  const source = {
    url: 'https://models.example/v1/models',
    prefix: 'review-provider/',
    providerSlug: 'custom-review',
    credentialAlias: 'default',
  };
  try {
    let entries: unknown[] = [{ id: 'original' }];
    const observedHeaders: Headers[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      observedHeaders.push(new Headers(init.headers));
      return Response.json({ data: entries });
    });
    await createRelayCatalog(db, [source]).refresh(60_000);
    expect(await createRelayCatalog(db, [source]).get()).toMatchObject({
      routes: ['review-provider/original'],
      rejected: 0,
    });
    entries = [{ id: 'partial' }, {}];
    await createRelayCatalog(db, [source]).refresh(90_000);
    expect(await createRelayCatalog(db, [source]).get()).toMatchObject({
      routes: ['review-provider/original'],
      lastSuccessAt: new Date(60_000).toISOString(),
      lastRefreshError: 'refresh failed',
    });
    entries = [{ id: 'new' }];
    await createRelayCatalog(db, [source]).refresh(120_000);
    expect(await createRelayCatalog(db, [source]).get()).toMatchObject({
      routes: ['review-provider/new'],
      rejected: 0,
    });
    await expect(
      createGrantControl(db).issue({
        jobId: 'job-original',
        snapshot: { routes: ['review-provider/original'] },
        latestIssueDeadline: deadline(),
      }),
    ).resolves.toMatchObject({ kind: 'issued' });
    expect(
      observedHeaders.every(
        (headers) =>
          headers.get('user-agent') === 'compte-rendu/1.0' &&
          !headers.has('authorization') &&
          !headers.has('cf-aig-authorization'),
      ),
    ).toBe(true);
  } finally {
    db.close();
  }
});

it('publishes only trusted Chat effort names and controls with selectable routes', async () => {
  const db = database();
  const source = {
    url: 'https://models.example/v1/models',
    prefix: 'review/',
    providerSlug: 'custom-review',
    credentialAlias: 'default',
    efforts: {
      'review/deepseek-v4.1-flash': [
        { name: 'high', controls: { reasoning_effort: 'high' as const } },
      ],
      'review/mimo-v2.6-flash': [
        { name: 'off', controls: { thinking: { type: 'disabled' as const } } },
      ],
    },
  };
  try {
    vi.stubGlobal('fetch', async () =>
      Response.json({
        data: [{ id: 'deepseek-v4.1-flash' }, { id: 'mimo-v2.6-flash' }, { id: 'plain' }],
      }),
    );
    await createRelayCatalog(db, [source]).refresh(60_000);
    expect(await createRelayCatalog(db, [source]).get()).toMatchObject({
      routes: ['review/deepseek-v4.1-flash', 'review/mimo-v2.6-flash', 'review/plain'],
      efforts: {
        'review/deepseek-v4.1-flash': [{ name: 'high', controls: { reasoning_effort: 'high' } }],
        'review/mimo-v2.6-flash': [{ name: 'off', controls: { thinking: { type: 'disabled' } } }],
      },
    });
  } finally {
    db.close();
  }
});

it('rejects effort menus with conflicting or non-Chat controls in configuration', () => {
  const decode = Schema.decodeUnknownOption(RelayCatalogSources, {
    onExcessProperty: 'error',
  });
  const source = (efforts: unknown, overrides: Record<string, unknown> = {}) => ({
    url: 'https://models.example/v1/models',
    prefix: 'review/',
    providerSlug: 'custom-review',
    credentialAlias: 'default',
    efforts,
    ...overrides,
  });
  expect(
    decode([
      source({
        'review/model': [
          {
            name: 'mixed',
            controls: { reasoning_effort: 'high', thinking: { type: 'disabled' } },
          },
        ],
      }),
    ]),
  ).toMatchObject({ _tag: 'None' });
  expect(decode([source({ 'review/model': [{ name: 'empty', controls: {} }] })])).toMatchObject({
    _tag: 'None',
  });
  expect(
    decode([
      source(
        { 'review/model': [{ name: 'high', controls: { reasoning_effort: 'high' } }] },
        { models: { 'review/model': { profile: 'responses' } } },
      ),
    ]),
  ).toMatchObject({ _tag: 'None' });
  // The removed, unshipped nested syntax is not a second configuration path.
  expect(
    decode([
      source(undefined, {
        models: {
          'review/model': {
            profile: 'chat',
            efforts: [{ name: 'high', controls: { reasoning_effort: 'high' } }],
          },
        },
      }),
    ]),
  ).toMatchObject({ _tag: 'None' });
});

it('keeps the models allowlist behavior while sparse efforts stay orthogonal', async () => {
  const db = database();
  const source = {
    url: 'https://models.example/v1/models',
    prefix: 'p/',
    providerSlug: 'custom-review',
    credentialAlias: 'default',
    models: { 'p/one': { profile: 'chat' as const } },
    efforts: {
      'p/one': [{ name: 'high', controls: { reasoning_effort: 'high' as const } }],
      'p/two': [{ name: 'off', controls: { thinking: { type: 'disabled' as const } } }],
    },
  };
  try {
    vi.stubGlobal('fetch', async () => Response.json({ data: [{ id: 'one' }, { id: 'two' }] }));
    await createRelayCatalog(db, [source]).refresh(60_000);
    expect(await createRelayCatalog(db, [source]).get()).toMatchObject({
      routes: ['p/one'],
      efforts: {
        'p/one': [{ name: 'high', controls: { reasoning_effort: 'high' } }],
      },
    });
  } finally {
    db.close();
  }
});

it('rejects a source refresh when an effort route resolves to a non-Chat profile', async () => {
  const db = database();
  const source = {
    url: 'https://models.example/v1/models',
    prefix: 'p/',
    providerSlug: 'custom-review',
    credentialAlias: 'default',
    profile: 'chat' as const,
    profiles: ['chat', 'responses'] as const,
    efforts: {
      'p/route': [{ name: 'high', controls: { reasoning_effort: 'high' as const } }],
    },
  };
  try {
    vi.stubGlobal('fetch', async () =>
      Response.json({
        data: [
          {
            id: 'route',
            api: { responses: {} },
            recommended_api: 'responses',
          },
        ],
      }),
    );
    await createRelayCatalog(db, [source]).refresh(60_000);
    expect(await createRelayCatalog(db, [source]).get()).toMatchObject({
      routes: [],
      lastRefreshError: 'refresh failed',
    });
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
      efforts: {},
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

it('rejects a snapshot over the distinct selectable route limit and keeps the prior snapshot', async () => {
  const db = database();
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
      Response.json({ data: Array.from({ length: 1000 }, (_, i) => ({ id: 'm' + i })) }),
    );
    await catalog.refresh(200);
    const capped = await catalog.get();
    expect(capped.routes).toHaveLength(1000);
    expect(capped.routes).not.toContain('p/old');
    expect(capped.lastRefreshError).toBeNull();
    await expect(
      createGrantControl(db).issue({
        jobId: 'before-the-budget-replacement',
        snapshot: { routes: ['p/old'] },
        latestIssueDeadline: deadline(),
      }),
    ).resolves.toMatchObject({ kind: 'issued' });

    vi.stubGlobal('fetch', async () =>
      Response.json({ data: Array.from({ length: 1001 }, (_, i) => ({ id: 'n' + i })) }),
    );
    await catalog.refresh(300);
    const rejected = await catalog.get();
    expect(rejected.routes).toEqual(capped.routes);
    expect(rejected.lastRefreshError).toBe('catalog limit reached');
    expect(rejected.lastSuccessAt).toEqual(new Date(200).toISOString());

    vi.stubGlobal('fetch', async () => {
      throw new Error('private detail');
    });
    await catalog.refresh(400);
    const failed = await catalog.get();
    expect(failed.routes).toEqual(capped.routes);
    expect(failed.lastSuccessAt).toEqual(new Date(200).toISOString());
    expect(failed.lastRefreshError).toBe('refresh failed');
  } finally {
    db.close();
  }
});

it('reports an attempted route remap and keeps its former mapping', async () => {
  const db = database();
  try {
    vi.stubGlobal('fetch', async () => Response.json({ data: [] }));
    const source = {
      url: 'https://models.example/models',
      prefix: 'p/',
      providerSlug: 'custom-review',
      credentialAlias: 'default',
      aliases: { unchanged: 'original', review: 'one', removed: 'other' },
    };
    await createRelayCatalog(db, [source]).refresh(100);
    const changed = createRelayCatalog(db, [
      { ...source, aliases: { unchanged: 'original', review: 'two' } },
    ]);
    await changed.refresh(200);
    expect(await changed.get()).toMatchObject({
      lastAttemptAt: new Date(200).toISOString(),
      lastRefreshError: 'route mapping conflict',
      routes: ['unchanged'],
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
  const db = database();
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
    expect(await catalog.get()).toMatchObject({ routes: ['p/old'] });
  } finally {
    db.close();
  }
});

it('replaces each source independently and serves the failed source snapshot with a warning', async () => {
  const db = database();
  const first = {
    url: 'https://a.example/models',
    prefix: 'a/',
    providerSlug: 'custom-a',
    credentialAlias: 'default',
  };
  const second = {
    url: 'https://b.example/models',
    prefix: 'b/',
    providerSlug: 'custom-b',
    credentialAlias: 'default',
  };
  const entries = new Map<string, unknown[]>([
    ['https://a.example/models', [{ id: 'one' }]],
    ['https://b.example/models', [{ id: 'one' }]],
  ]);
  vi.stubGlobal('fetch', async (url: string) => Response.json({ data: entries.get(url) ?? [] }));
  const catalog = createRelayCatalog(db, [first, second]);
  try {
    await catalog.refresh(100);
    expect((await catalog.get()).routes).toEqual(['a/one', 'b/one']);

    entries.set('https://a.example/models', [{ id: 'two' }]);
    entries.set('https://b.example/models', [{ id: 'two' }]);
    await catalog.refresh(200);
    expect((await catalog.get()).routes).toEqual(['a/two', 'b/two']);

    vi.stubGlobal('fetch', async (url: string) => {
      if (url === 'https://a.example/models') throw new Error('provider down');
      return Response.json({ data: [{ id: 'three' }] });
    });
    await catalog.refresh(300);
    expect(await catalog.get()).toMatchObject({
      routes: ['a/two', 'b/three'],
      lastAttemptAt: new Date(300).toISOString(),
      lastSuccessAt: new Date(200).toISOString(),
      lastRefreshError: 'refresh failed',
    });
  } finally {
    db.close();
  }
});

it('removes memberships from sources that are no longer configured but keeps old grants resolvable', async () => {
  const db = database();
  const retired = {
    providerSlug: 'custom-legacy',
    credentialAlias: 'default',
    aliases: { retired: 'retired-model' },
  };
  const active = {
    url: 'https://b.example/models',
    prefix: 'b/',
    providerSlug: 'custom-b',
    credentialAlias: 'default',
  };
  const entries = new Map<string, unknown[]>([['https://b.example/models', [{ id: 'one' }]]]);
  vi.stubGlobal('fetch', async (url: string) => Response.json({ data: entries.get(url) ?? [] }));
  try {
    await createRelayCatalog(db, [retired, active]).refresh(100);
    expect((await createRelayCatalog(db, [retired, active]).get()).routes).toEqual([
      'b/one',
      'retired',
    ]);

    const remaining = createRelayCatalog(db, [active]);
    expect((await remaining.get()).routes).toEqual(['b/one']);
    entries.set('https://b.example/models', [{ id: 'two' }]);
    await remaining.refresh(200);
    expect(await remaining.get()).toMatchObject({
      routes: ['b/two'],
      lastRefreshError: null,
    });

    await expect(
      createGrantControl(db).issue({
        jobId: 'job-retired',
        snapshot: { routes: ['retired'] },
        latestIssueDeadline: deadline(),
      }),
    ).resolves.toMatchObject({ kind: 'issued' });
  } finally {
    db.close();
  }
});

it('keeps explicit aliases served by a separate provider without discovering unrelated routes there', async () => {
  const db = database();
  const fetch = vi.fn(async () => Response.json({ data: [{ id: 'current' }] }));
  vi.stubGlobal('fetch', fetch);
  try {
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

it('presents a discovered route instead of an alias with the same provider, credential and model', async () => {
  const db = database();
  const source = {
    url: 'https://models.example/native/models',
    prefix: 'provider/',
    providerSlug: 'custom-review',
    credentialAlias: 'default',
    aliases: { 'legacy-review': 'same-model' },
  };
  try {
    vi.stubGlobal('fetch', async () => Response.json({ data: [{ id: 'same-model' }] }));
    const catalog = createRelayCatalog(db, [source]);
    await catalog.refresh(50);
    expect((await catalog.get()).routes).toEqual(['provider/same-model']);
    await expect(
      createGrantControl(db).issue({
        jobId: 'job-legacy-alias',
        snapshot: { routes: ['legacy-review'] },
        latestIssueDeadline: deadline(),
      }),
    ).resolves.toMatchObject({ kind: 'issued' });
  } finally {
    db.close();
  }
});

it.each([
  ['custom-private', 'custom-private'],
  ['openai', 'custom-openai'],
  ['native:openai', 'openai'],
])(
  'discovers the catalog for %s through its frozen Gateway destination',
  async (providerSlug, path) => {
    const db = database();
    try {
      const observed: { url: string; headers: Headers; redirect?: RequestRedirect }[] = [];
      vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
        observed.push({ url, headers: new Headers(init.headers), redirect: init.redirect });
        return Response.json({ data: [{ id: 'custom-model' }] });
      });
      const configured = {
        discovery: 'gateway',
        prefix: 'p/',
        providerSlug,
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
        `https://gateway.ai.cloudflare.com/v1/account/gateway/${path}/models`,
      );
      expect(observed[0]?.headers.get('cf-aig-authorization')).toBe('Bearer test-run-token');
      expect(observed[0]?.headers.get('cf-aig-byok-alias')).toBe('billing');
      expect(observed[0]?.redirect).toBe('manual');
      expect(() => decode([{ ...configured, url: 'https://other.example' }])).toThrow();
    } finally {
      db.close();
    }
  },
);

it.each([
  {
    providerSlug: 'native:anthropic',
    path: 'anthropic/v1',
    cursor: 'after_id=claude-a',
    pages: [
      { data: [{ id: 'claude-a' }], has_more: true, last_id: 'claude-a' },
      { data: [{ id: 'claude-b' }], has_more: false },
    ],
    models: ['p/claude-a', 'p/claude-b'],
  },
  {
    providerSlug: 'native:google-ai-studio',
    path: 'google-ai-studio/v1beta',
    cursor: 'pageToken=more%2Bmodels',
    pages: [
      {
        models: [{ name: 'models/gemini-a', supportedGenerationMethods: ['generateContent'] }],
        nextPageToken: 'more+models',
      },
      {
        models: [
          { name: 'models/embed', supportedGenerationMethods: ['embedContent'] },
          { name: 'models/gemini-b', supportedGenerationMethods: ['generateContent'] },
        ],
      },
    ],
    models: ['p/gemini-a', 'p/gemini-b'],
  },
])(
  'discovers all native BYOK pages for $providerSlug',
  async ({ providerSlug, path, cursor, pages, models }) => {
    const db = database();
    try {
      const urls: string[] = [];
      vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
        urls.push(url);
        if (
          providerSlug === 'native:anthropic' &&
          new Headers(init.headers).get('anthropic-version') !== '2023-06-01'
        )
          return new Response(null, { status: 400 });
        return Response.json(pages[urls.length - 1]);
      });
      const sources = Schema.decodeUnknownSync(RelayCatalogSources)([
        {
          discovery: 'gateway',
          prefix: 'p/',
          providerSlug,
          credentialAlias: 'review',
          models: Object.fromEntries(
            models.map((id) => [
              id,
              { profile: providerSlug === 'native:anthropic' ? 'messages' : 'gemini' },
            ]),
          ),
        },
      ]);
      const catalog = createRelayCatalog(db, sources, {
        accountId: 'account',
        gatewayId: 'gateway',
        runToken: 'test',
      });
      await catalog.refresh(60);
      const first = `https://gateway.ai.cloudflare.com/v1/account/gateway/${path}/models`;
      expect(await catalog.get()).toMatchObject({ routes: models, lastRefreshError: null });
      expect(urls).toEqual([first, first + '?' + cursor]);
    } finally {
      db.close();
    }
  },
);

it.each([
  ['native:anthropic', { models: { 'models/unsupported': { profile: 'chat' } } }],
  ['native:google-ai-studio', { profile: 'chat' }],
  ['native:anthropic', { profiles: ['messages', 'chat'] }],
] as const)('rejects incompatible Chat configuration for %s', (providerSlug, settings) => {
  expect(() =>
    Schema.decodeUnknownSync(RelayCatalogSources)([
      {
        discovery: 'gateway',
        prefix: 'models/',
        providerSlug,
        credentialAlias: 'review',
        ...settings,
      },
    ]),
  ).toThrow();
});

it.each(['custom-review', 'native:openai'])(
  'preserves independent ID-only and rich profiles for %s',
  async (providerSlug) => {
    const db = database();
    try {
      const sources = Schema.decodeUnknownSync(RelayCatalogSources)([
        {
          url: 'https://models.example/models',
          prefix: 'p/',
          providerSlug,
          credentialAlias: 'review',
          profile: 'chat',
          profiles: ['responses'],
        },
      ]);
      vi.stubGlobal('fetch', async () =>
        Response.json({
          data: [{ id: 'bare' }, { id: 'rich', api: { 'chat-completions': {}, responses: {} } }],
        }),
      );
      await createRelayCatalog(db, sources).refresh(50);
      await expect(
        createGrantControl(db).issueV2({
          jobId: 'job-compat',
          snapshot: { routes: ['p/bare', 'p/rich'] },
          latestIssueDeadline: deadline(),
        }),
      ).resolves.toMatchObject({
        kind: 'issued',
        descriptors: [
          { routeId: 'p/bare', profile: 'chat' },
          { routeId: 'p/rich', profile: 'responses' },
        ],
      });
    } finally {
      db.close();
    }
  },
);

it('freezes the alias-only source provider and credential on a legacy grant', async () => {
  const db = database();
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

    await expect(
      createGrantControl(db).issue({
        jobId: 'job-legacy',
        snapshot: { routes: ['legacy-review'] },
        latestIssueDeadline: deadline(),
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

it('reads a paginated source through its final page before replacing the snapshot', async () => {
  const db = database();
  const pages = new Map<string, unknown>([
    [
      'https://models.example/models',
      { data: [{ id: 'one' }], next: 'https://models.example/models?page=2' },
    ],
    ['https://models.example/models?page=2', { data: [{ id: 'two' }], has_more: false }],
  ]);
  vi.stubGlobal('fetch', async (url: string) => Response.json(pages.get(url) ?? { data: [] }));
  try {
    const catalog = createRelayCatalog(db, [
      {
        url: 'https://models.example/models',
        prefix: 'p/',
        providerSlug: 'custom-review',
        credentialAlias: 'default',
      },
    ]);
    await catalog.refresh(50);
    expect(await catalog.get()).toMatchObject({
      routes: ['p/one', 'p/two'],
      lastRefreshError: null,
    });
  } finally {
    db.close();
  }
});

it('never follows a next-page URL that changes the configured Gateway provider path', async () => {
  const db = database();
  const configured = 'https://gateway.ai.cloudflare.com/v1/account/gateway/custom-private/models';
  const other = 'https://gateway.ai.cloudflare.com/v1/account/gateway/custom-other/models';
  const observed: string[] = [];
  let next: string | null = null;
  vi.stubGlobal('fetch', async (url: string) => {
    observed.push(url);
    return Response.json({ data: [{ id: 'one' }], ...(next === null ? {} : { next }) });
  });
  try {
    const catalog = createRelayCatalog(
      db,
      [
        {
          discovery: 'gateway',
          prefix: 'p/',
          providerSlug: 'custom-private',
          credentialAlias: 'default',
        },
      ],
      { accountId: 'account', gatewayId: 'gateway', runToken: 'test-run-token' },
    );
    await catalog.refresh(25);
    expect(observed).toEqual([configured]);
    next = other;
    await catalog.refresh(50);
    expect(observed).toEqual([configured, configured]);
    expect(await catalog.get()).toMatchObject({
      routes: ['p/one'],
      lastRefreshError: 'refresh failed',
      lastSuccessAt: new Date(25).toISOString(),
    });
  } finally {
    db.close();
  }
});

it('rejects a continuation signal that cannot establish a complete list', async () => {
  const db = database();
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
    vi.stubGlobal('fetch', async () => Response.json({ data: [{ id: 'new' }], has_more: true }));
    await catalog.refresh(200);
    expect(await catalog.get()).toMatchObject({
      routes: ['p/old'],
      lastSuccessAt: new Date(100).toISOString(),
      lastRefreshError: 'refresh failed',
    });
  } finally {
    db.close();
  }
});

it('withdraws a source on a valid complete empty list and retains it on malformed or oversized responses', async () => {
  const db = database();
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

    vi.stubGlobal('fetch', async () => new Response('{', { status: 200 }));
    await catalog.refresh(200);
    expect((await catalog.get()).routes).toEqual(['p/old']);

    vi.stubGlobal('fetch', async () => new Response('x'.repeat(300 * 1024), { status: 200 }));
    await catalog.refresh(300);
    expect((await catalog.get()).routes).toEqual(['p/old']);

    vi.stubGlobal('fetch', async () => Response.json({ data: [] }));
    await catalog.refresh(400);
    expect(await catalog.get()).toMatchObject({
      routes: [],
      lastSuccessAt: new Date(400).toISOString(),
      lastRefreshError: null,
    });
  } finally {
    db.close();
  }
});

it('an initial failed refresh contributes no discovered choices', async () => {
  const db = database();
  try {
    vi.stubGlobal('fetch', async () => {
      throw new Error('offline');
    });
    const catalog = createRelayCatalog(db, [
      {
        url: 'https://models.example/models',
        prefix: 'p/',
        providerSlug: 'custom-review',
        credentialAlias: 'default',
      },
    ]);
    await catalog.refresh(50);
    expect(await catalog.get()).toMatchObject({
      routes: [],
      lastAttemptAt: new Date(50).toISOString(),
      lastSuccessAt: null,
      lastRefreshError: 'refresh failed',
    });
  } finally {
    db.close();
  }
});

it('an initial mixed valid and malformed list publishes no partial snapshot', async () => {
  const db = database();
  const source = {
    url: 'https://models.example/models',
    prefix: 'p/',
    providerSlug: 'custom-review',
    credentialAlias: 'default',
  };
  try {
    vi.stubGlobal('fetch', async () => Response.json({ data: [{ id: 'partial' }, {}] }));
    const catalog = createRelayCatalog(db, [source]);
    await catalog.refresh(50);
    expect(await catalog.get()).toMatchObject({
      routes: [],
      lastAttemptAt: new Date(50).toISOString(),
      lastSuccessAt: null,
      lastRefreshError: 'refresh failed',
    });
  } finally {
    db.close();
  }
});

it('rejects a snapshot with an invalid combined ID length without publishing a partial list', async () => {
  const db = database();
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
    let entries: unknown[] = [{ id: 'a' }, { id: 'ab' }];
    vi.stubGlobal('fetch', async () => Response.json({ data: entries }));
    const catalog = createRelayCatalog(db, sources);
    await catalog.refresh(25);
    expect(await catalog.get()).toMatchObject({
      routes: [],
      lastSuccessAt: null,
      lastRefreshError: 'refresh failed',
    });

    entries = [{ id: 'a' }];
    await catalog.refresh(50);
    expect(await catalog.get()).toMatchObject({
      routes: [`${prefix}a`],
      lastRefreshError: null,
    });

    entries = [{ id: 'a' }, { id: 'ab' }];
    await catalog.refresh(75);
    expect(await catalog.get()).toMatchObject({
      routes: [`${prefix}a`],
      lastSuccessAt: new Date(50).toISOString(),
      lastRefreshError: 'refresh failed',
    });
  } finally {
    db.close();
  }
});

it('publishes only configured protocols from a rich catalog and freezes them in a v2 grant', async () => {
  const db = database();
  const source = {
    url: 'https://models.example/v1/models',
    prefix: 'go/',
    providerSlug: 'custom-go',
    credentialAlias: 'default',
    profiles: ['chat', 'responses', 'messages', 'gemini'] as const,
  };
  try {
    vi.stubGlobal('fetch', async () =>
      Response.json({
        data: [
          {
            id: 'chat-model',
            api: { 'chat-completions': {} },
            recommended_api: 'chat-completions',
          },
          { id: 'responses-model', api: { responses: {} }, recommended_api: 'responses' },
          { id: 'messages-model', api: { messages: {} }, recommended_api: 'messages' },
          { id: 'gemini-model', api: { 'generate-content': {} }, recommended_api: 'interactions' },
          { id: 'interactions-model', api: { interactions: {} }, recommended_api: 'interactions' },
          {
            id: 'no-tools-model',
            api: { 'chat-completions': {} },
            capabilities: { tools: { supported: false } },
          },
          { id: 'both-model', api: { 'chat-completions': {}, responses: {} } },
        ],
      }),
    );
    const catalog = createRelayCatalog(db, [source]);
    await catalog.refresh(50);
    expect(await catalog.get()).toMatchObject({
      routes: [
        'go/both-model',
        'go/chat-model',
        'go/gemini-model',
        'go/messages-model',
        'go/responses-model',
      ],
      lastRefreshError: null,
    });
    const profiles = db.database
      .prepare('SELECT route_id, profile FROM catalog_routes ORDER BY route_id')
      .all() as unknown as ReadonlyArray<{
      readonly route_id: string;
      readonly profile: string;
    }>;
    expect(profiles).toEqual([
      { route_id: 'go/both-model', profile: 'chat' },
      { route_id: 'go/chat-model', profile: 'chat' },
      { route_id: 'go/gemini-model', profile: 'gemini' },
      { route_id: 'go/messages-model', profile: 'messages' },
      { route_id: 'go/responses-model', profile: 'responses' },
    ]);

    const routes = profiles.map((row) => row.route_id);
    const issued = await createGrantControl(db).issueV2({
      jobId: 'job-rich',
      snapshot: { routes },
      latestIssueDeadline: deadline(),
    });
    expect(issued).toMatchObject({ kind: 'issued' });
    if (issued.kind !== 'issued') throw new Error('expected an issued grant');
    expect(issued.descriptors).toHaveLength(routes.length);
    expect(issued.descriptors).toEqual(
      expect.arrayContaining([
        { routeId: 'go/both-model', profile: 'chat' },
        { routeId: 'go/chat-model', profile: 'chat' },
        { routeId: 'go/gemini-model', profile: 'gemini' },
        { routeId: 'go/messages-model', profile: 'messages' },
        { routeId: 'go/responses-model', profile: 'responses' },
      ]),
    );
    expect(issued.descriptors.every((descriptor) => !('model' in descriptor))).toBe(true);
    const stored = db.database
      .prepare('SELECT route_mapping FROM grants WHERE job_id = ?')
      .get('job-rich') as { readonly route_mapping: string };
    expect(JSON.parse(stored.route_mapping)).toContainEqual({
      routeId: 'go/responses-model',
      upstreamModel: 'responses-model',
      providerSlug: 'custom-go',
      credentialAlias: 'default',
      profile: 'responses',
    });
  } finally {
    db.close();
  }
});

it('rejects a Gemini alias whose upstream model is not one segment and keeps the healthy snapshot', async () => {
  const db = database();
  const configured = (model: string) =>
    Schema.decodeUnknownSync(RelayCatalogSources)([
      {
        providerSlug: 'custom-review',
        credentialAlias: 'default',
        profile: 'chat',
        aliases: { 'gemini-route': model },
        models: { 'gemini-route': { profile: 'gemini' } },
      },
    ]);

  try {
    await createRelayCatalog(db, configured('gemini-pro')).refresh(100);
    expect(await createRelayCatalog(db, configured('gemini-pro')).get()).toMatchObject({
      routes: ['gemini-route'],
      lastRefreshError: null,
    });

    await createRelayCatalog(db, configured('models/gemini-pro')).refresh(200);
    expect(await createRelayCatalog(db, configured('gemini-pro')).get()).toMatchObject({
      routes: ['gemini-route'],
      lastRefreshError: 'refresh failed',
      lastSuccessAt: new Date(100).toISOString(),
    });

    await createRelayCatalog(db, configured('gemini-pro')).refresh(300);
    expect(await createRelayCatalog(db, configured('gemini-pro')).get()).toMatchObject({
      routes: ['gemini-route'],
      lastRefreshError: null,
      lastSuccessAt: new Date(300).toISOString(),
    });
  } finally {
    db.close();
  }
});

it('rejects a discovered Gemini override whose model id is not one segment', async () => {
  const db = database();
  const source = Schema.decodeUnknownSync(RelayCatalogSources)([
    {
      url: 'https://models.example/v1/models',
      prefix: 'go/',
      providerSlug: 'custom-go',
      credentialAlias: 'default',
      profiles: ['gemini'],
      models: { 'go/gemini/model': { profile: 'gemini' } },
    },
  ]);
  try {
    vi.stubGlobal('fetch', async () => Response.json({ data: [{ id: 'gemini/model' }] }));
    await createRelayCatalog(db, source).refresh(50);
    expect(await createRelayCatalog(db, source).get()).toMatchObject({
      routes: [],
      rejected: 1,
      lastRefreshError: 'refresh failed',
    });
    expect(db.database.prepare('SELECT route_id FROM catalog_routes').all()).toEqual([]);
  } finally {
    db.close();
  }
});

it('exposes only the explicit allowlist from an ID-only listing and freezes configured limits', async () => {
  const db = database();
  const source = {
    url: 'https://api.openai.example/v1/models',
    prefix: 'openai-platform/',
    providerSlug: 'custom-openai',
    credentialAlias: 'sol',
    models: {
      'openai-platform/gpt-6.2-sol': {
        profile: 'responses' as const,
        limit: { context: 1_050_000, output: 128_000 },
      },
    },
  };
  try {
    vi.stubGlobal('fetch', async () =>
      Response.json({
        data: [{ id: 'gpt-6.2-sol' }, { id: 'non-review-model' }, { id: 'text-embedding-3-large' }],
      }),
    );
    const catalog = createRelayCatalog(db, [source]);
    await catalog.refresh(50);
    expect(await catalog.get()).toMatchObject({
      routes: ['openai-platform/gpt-6.2-sol'],
      lastRefreshError: null,
    });
    expect(
      db.database
        .prepare('SELECT profile, limit_json FROM catalog_routes WHERE route_id = ?')
        .get('openai-platform/gpt-6.2-sol'),
    ).toEqual({
      profile: 'responses',
      limit_json: '{"context":1050000,"output":128000}',
    });

    const issued = await createGrantControl(db).issueV2({
      jobId: 'job-sol',
      snapshot: { routes: ['openai-platform/gpt-6.2-sol'] },
      latestIssueDeadline: deadline(),
    });
    expect(issued).toMatchObject({
      kind: 'issued',
      descriptors: [
        {
          routeId: 'openai-platform/gpt-6.2-sol',
          profile: 'responses',
          limit: { context: 1_050_000, output: 128_000 },
        },
      ],
    });
    await expect(
      createGrantControl(db).issue({
        jobId: 'job-sol-v1',
        snapshot: { routes: ['openai-platform/gpt-6.2-sol'] },
        latestIssueDeadline: deadline(),
      }),
    ).resolves.toEqual({ kind: 'invalid' });

    const changed = createRelayCatalog(db, [
      {
        ...source,
        models: {
          'openai-platform/gpt-6.2-sol': {
            profile: 'responses',
            limit: { context: 1_050_000, output: 100_000 },
          },
        },
      },
    ]);
    await changed.refresh(100);
    expect(await changed.get()).toMatchObject({
      routes: ['openai-platform/gpt-6.2-sol'],
      lastSuccessAt: new Date(50).toISOString(),
      lastRefreshError: 'route mapping conflict',
    });
    expect(
      db.database
        .prepare('SELECT profile, limit_json FROM catalog_routes WHERE route_id = ?')
        .get('openai-platform/gpt-6.2-sol'),
    ).toEqual({
      profile: 'responses',
      limit_json: '{"context":1050000,"output":128000}',
    });
  } finally {
    db.close();
  }
});

it('keeps unqualified ID-only discovery unchanged', async () => {
  const db = database();
  try {
    vi.stubGlobal('fetch', async () =>
      Response.json({ data: [{ id: 'first' }, { id: 'second' }] }),
    );
    const catalog = createRelayCatalog(db, [
      {
        url: 'https://models.example/models',
        prefix: 'p/',
        providerSlug: 'custom-review',
        credentialAlias: 'default',
      },
    ]);
    await catalog.refresh(10);
    expect((await catalog.get()).routes).toEqual(['p/first', 'p/second']);
    expect(db.database.prepare('SELECT DISTINCT profile FROM catalog_routes').all()).toEqual([
      { profile: 'chat' },
    ]);
  } finally {
    db.close();
  }
});

it('resolves each alias from its producing source and rejects conflicting descriptors', async () => {
  const db = database();
  const source = (
    aliases: Record<string, string>,
    models: Record<
      string,
      { profile: 'chat' | 'responses'; limit?: { context?: number; output?: number } }
    >,
  ) => ({
    providerSlug: 'custom-legacy',
    credentialAlias: 'default',
    aliases,
    models,
  });
  try {
    const catalog = createRelayCatalog(db, [
      source(
        { 'route-a': 'model-a' },
        { 'route-a': { profile: 'chat', limit: { context: 100, output: 50 } } },
      ),
      source(
        { 'route-b': 'model-b' },
        { 'route-b': { profile: 'responses', limit: { context: 200, output: 50 } } },
      ),
      // Same resolved descriptor, different object key order: not a conflict.
      source(
        { 'route-a': 'model-a' },
        { 'route-a': { profile: 'chat', limit: { output: 50, context: 100 } } },
      ),
    ]);
    await catalog.refresh(10);
    expect(await catalog.get()).toMatchObject({
      routes: ['route-a', 'route-b'],
      lastRefreshError: null,
    });
    expect(
      db.database
        .prepare('SELECT route_id, profile, limit_json FROM catalog_routes ORDER BY route_id')
        .all(),
    ).toEqual([
      { route_id: 'route-a', profile: 'chat', limit_json: '{"context":100,"output":50}' },
      { route_id: 'route-b', profile: 'responses', limit_json: '{"context":200,"output":50}' },
    ]);

    const conflicting = createRelayCatalog(db, [
      source(
        { 'route-a': 'model-a' },
        { 'route-a': { profile: 'chat', limit: { context: 100, output: 50 } } },
      ),
      source(
        { 'route-b': 'model-b' },
        { 'route-b': { profile: 'responses', limit: { context: 200, output: 50 } } },
      ),
      source(
        { 'route-a': 'model-a' },
        { 'route-a': { profile: 'responses', limit: { context: 100, output: 50 } } },
      ),
    ]);
    await conflicting.refresh(20);
    expect(await conflicting.get()).toMatchObject({
      routes: ['route-a', 'route-b'],
      lastSuccessAt: new Date(10).toISOString(),
      lastRefreshError: 'refresh failed',
    });
    expect(
      db.database
        .prepare('SELECT route_id, profile, limit_json FROM catalog_routes ORDER BY route_id')
        .all(),
    ).toEqual([
      { route_id: 'route-a', profile: 'chat', limit_json: '{"context":100,"output":50}' },
      { route_id: 'route-b', profile: 'responses', limit_json: '{"context":200,"output":50}' },
    ]);
  } finally {
    db.close();
  }
});

it('keeps a differently limited alias visible beside its discovered route', async () => {
  const db = database();
  try {
    vi.stubGlobal('fetch', async () => Response.json({ data: [{ id: 'model' }] }));
    const catalog = createRelayCatalog(db, [
      {
        url: 'https://models.example/models',
        prefix: 'p/',
        providerSlug: 'custom-review',
        credentialAlias: 'default',
      },
      {
        providerSlug: 'custom-review',
        credentialAlias: 'default',
        aliases: { legacy: 'model' },
        models: { legacy: { profile: 'chat', limit: { context: 100 } } },
      },
    ]);
    await catalog.refresh(10);
    expect(await catalog.get()).toMatchObject({
      routes: ['legacy', 'p/model'],
      lastRefreshError: null,
    });
  } finally {
    db.close();
  }
});

it('requires an explicit model override for non-chat profiles on ID-only discovery', async () => {
  const db = database();
  const base = {
    url: 'https://api.example/v1/models',
    prefix: 'openai-platform/',
    providerSlug: 'custom-openai',
    credentialAlias: 'sol',
    profiles: ['responses'] as const,
  };
  try {
    vi.stubGlobal('fetch', async () => Response.json({ data: [{ id: 'gpt-6.2-sol' }] }));
    const unverified = createRelayCatalog(db, [base]);
    await unverified.refresh(10);
    expect(await unverified.get()).toMatchObject({
      routes: [],
      lastRefreshError: null,
    });

    const verified = createRelayCatalog(db, [
      {
        ...base,
        models: {
          'openai-platform/gpt-6.2-sol': {
            profile: 'responses',
            limit: { context: 1_050_000, output: 128_000 },
          },
        },
      },
    ]);
    await verified.refresh(20);
    expect(await verified.get()).toMatchObject({
      routes: ['openai-platform/gpt-6.2-sol'],
      lastRefreshError: null,
    });
  } finally {
    db.close();
  }
});

it('still exposes chat from a qualified ID-only list without a model override', async () => {
  const db = database();
  try {
    vi.stubGlobal('fetch', async () => Response.json({ data: [{ id: 'chat-model' }] }));
    const catalog = createRelayCatalog(db, [
      {
        url: 'https://models.example/models',
        prefix: 'p/',
        providerSlug: 'custom-review',
        credentialAlias: 'default',
        profiles: ['chat'],
      },
    ]);
    await catalog.refresh(10);
    expect((await catalog.get()).routes).toEqual(['p/chat-model']);
    expect(
      db.database
        .prepare('SELECT profile FROM catalog_routes WHERE route_id = ?')
        .get('p/chat-model'),
    ).toEqual({ profile: 'chat' });
  } finally {
    db.close();
  }
});

it('lets an explicit no-tools capability beat the legacy chat default', async () => {
  const db = database();
  try {
    vi.stubGlobal('fetch', async () =>
      Response.json({
        data: [
          {
            id: 'no-tools',
            api: { responses: {} },
            capabilities: { tools: { supported: false } },
          },
          { id: 'ordinary', api: { responses: {} } },
        ],
      }),
    );
    const catalog = createRelayCatalog(db, [
      {
        url: 'https://models.example/models',
        prefix: 'p/',
        providerSlug: 'custom-review',
        credentialAlias: 'default',
      },
    ]);
    await catalog.refresh(10);
    expect(await catalog.get()).toMatchObject({
      routes: ['p/ordinary'],
      lastRefreshError: null,
    });
  } finally {
    db.close();
  }
});

it('preserves the previous snapshot for malformed rich capabilities', async () => {
  const db = database();
  const source = {
    url: 'https://models.example/models',
    prefix: 'p/',
    providerSlug: 'custom-review',
    credentialAlias: 'default',
  };
  const catalog = createRelayCatalog(db, [source]);
  try {
    vi.stubGlobal('fetch', async () => Response.json({ data: [{ id: 'saved' }] }));
    await catalog.refresh(10);
    vi.stubGlobal('fetch', async () =>
      Response.json({
        data: [
          {
            id: 'malformed',
            capabilities: { tools: { supported: 'no' } },
          },
        ],
      }),
    );
    await catalog.refresh(20);
    expect(await catalog.get()).toMatchObject({
      routes: ['p/saved'],
      lastSuccessAt: new Date(10).toISOString(),
      lastRefreshError: 'refresh failed',
    });
  } finally {
    db.close();
  }
});

it('keeps an unqualified rich source on its historical chat-only semantics', async () => {
  const db = database();
  try {
    vi.stubGlobal('fetch', async () =>
      Response.json({
        data: [{ id: 'responses-only', api: { responses: {} }, recommended_api: 'responses' }],
      }),
    );
    const catalog = createRelayCatalog(db, [
      {
        url: 'https://models.example/models',
        prefix: 'p/',
        providerSlug: 'custom-review',
        credentialAlias: 'default',
      },
    ]);
    await catalog.refresh(10);
    expect((await catalog.get()).routes).toEqual(['p/responses-only']);
    expect(
      db.database
        .prepare('SELECT profile FROM catalog_routes WHERE route_id = ?')
        .get('p/responses-only'),
    ).toEqual({ profile: 'chat' });
  } finally {
    db.close();
  }
});

it('honours recommended_api before the configured profile order', async () => {
  const db = database();
  try {
    vi.stubGlobal('fetch', async () =>
      Response.json({
        data: [
          {
            id: 'both',
            api: { 'chat-completions': {}, responses: {} },
            recommended_api: 'responses',
          },
        ],
      }),
    );
    const catalog = createRelayCatalog(db, [
      {
        url: 'https://models.example/models',
        prefix: 'p/',
        providerSlug: 'custom-review',
        credentialAlias: 'default',
        profiles: ['chat', 'responses'],
      },
    ]);
    await catalog.refresh(10);
    expect(
      db.database.prepare('SELECT profile FROM catalog_routes WHERE route_id = ?').get('p/both'),
    ).toEqual({ profile: 'responses' });
  } finally {
    db.close();
  }
});

it('treats a profile change for an existing route as an immutable conflict', async () => {
  const db = database();
  const base = {
    providerSlug: 'custom-legacy',
    credentialAlias: 'default',
    aliases: { 'legacy-review': 'legacy-model' },
    profile: 'chat' as const,
  };
  try {
    await createRelayCatalog(db, [base]).refresh(100);
    const changed = createRelayCatalog(db, [{ ...base, profile: 'responses' }]);
    await changed.refresh(200);
    expect(await changed.get()).toMatchObject({
      routes: ['legacy-review'],
      lastSuccessAt: new Date(100).toISOString(),
      lastRefreshError: 'route mapping conflict',
    });
    expect(
      db.database
        .prepare('SELECT profile FROM catalog_routes WHERE route_id = ?')
        .get('legacy-review'),
    ).toEqual({ profile: 'chat' });
  } finally {
    db.close();
  }
});

it('rejects duplicate or oversized configured profile lists', () => {
  const decode = Schema.decodeUnknownSync(RelayCatalogSources, { onExcessProperty: 'error' });
  const base = {
    providerSlug: 'custom-review',
    credentialAlias: 'default',
    aliases: { review: 'model' },
  };
  expect(() => decode([{ ...base, profiles: ['chat', 'chat'] }])).toThrow();
  expect(() => decode([{ ...base, profiles: [] }])).toThrow();
  expect(() =>
    decode([{ ...base, profiles: ['chat', 'responses', 'messages', 'gemini', 'chat'] }]),
  ).toThrow();
  expect(() => decode([{ ...base, profiles: ['unknown'] }])).toThrow();
  expect(
    decode([
      {
        ...base,
        models: {
          review: { profile: 'responses', limit: { context: 1000, output: 200 } },
        },
      },
    ]),
  ).toHaveLength(1);
  expect(() =>
    decode([
      {
        ...base,
        models: { review: { profile: 'responses', limit: { context: 0 } } },
      },
    ]),
  ).toThrow();
  expect(() => decode([{ ...base, models: { review: { profile: 'unknown' } } }])).toThrow();
});

it('preserves choices when a provider sends malformed continuation metadata', async () => {
  const db = database();
  try {
    let body: unknown = { data: [{ id: 'saved' }] };
    vi.stubGlobal('fetch', async () =>
      Response.json(body, {
        headers: { Link: '<https://example.test/info>; title="Information"' },
      }),
    );
    const catalog = createRelayCatalog(db, [
      {
        url: 'https://models.example/models',
        prefix: 'p/',
        providerSlug: 'review',
        credentialAlias: 'default',
      },
    ]);
    await catalog.refresh(1);
    expect((await catalog.get()).routes).toEqual(['p/saved']);
    body = { data: [], next: { unexpected: 'cursor' } };
    await catalog.refresh(2);
    expect(await catalog.get()).toMatchObject({
      routes: ['p/saved'],
      lastRefreshError: 'refresh failed',
    });
  } finally {
    db.close();
  }
});
