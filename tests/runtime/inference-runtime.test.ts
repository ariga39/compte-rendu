/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { createApplication } from '../../apps/dashboard/src/lib/server/application';
import {
  createD1ReviewStateStore,
  type D1DatabaseLike as ReviewDb,
} from '../../apps/core/src/review-state-store';
import type { RelayCatalogSnapshot } from '../../apps/inference-worker/src/catalog';
import { REVIEW_ATTEMPT_BUDGET_MS } from '../../packages/contracts/src';
import type {
  D1DatabaseLike,
  IssueGrantInput,
  IssueGrantResult,
  IssueGrantV2Result,
  RevokeGrantInput,
  RevokeGrantResult,
} from '../../apps/inference-worker/src/grants';
import type { ModelUsageSummary } from '../../packages/contracts/src';
import type { EffortJobDetail, EffortRouteState } from '../../packages/contracts/src/effort';

const GRANT_TTL_MS = 4 * REVIEW_ATTEMPT_BUDGET_MS;

interface InferenceBinding {
  catalog(): Promise<RelayCatalogSnapshot>;
  refreshCatalog(at: number): Promise<void>;
  fetch(request: Request): Promise<Response>;
  issue(input: IssueGrantInput): Promise<IssueGrantResult>;
  issueV2(input: IssueGrantInput): Promise<IssueGrantV2Result>;
  revoke(input: RevokeGrantInput): Promise<RevokeGrantResult>;
  usage(input: { jobId: string }): Promise<ModelUsageSummary | null>;
  effortStates(): Promise<{ routes: readonly EffortRouteState[] }>;
  effortDetails(input: { jobId: string; cursor?: string }): Promise<EffortJobDetail | null>;
  sweep(): Promise<number>;
  scheduled(): Promise<void>;
}

interface UpstreamState {
  readonly requests: readonly {
    readonly url: string;
    readonly headers: Record<string, string>;
    readonly body: string;
  }[];
  readonly cancellations: number;
  readonly waitingHeaders: number;
}

interface RuntimeEnv {
  readonly REVIEW_DB: ReviewDb;
  readonly RELAY_DB: D1DatabaseLike;
  readonly INFERENCE: InferenceBinding;
  readonly UPSTREAM: {
    fetch(input: Request | string, init?: RequestInit): Promise<Response>;
  };
}

const runtime = env as unknown as RuntimeEnv;
const snapshot = { routes: ['deepseek-review', 'step-review'] };

const d1Now = async () => {
  const row = await runtime.RELAY_DB.prepare(
    "SELECT CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER) AS now",
  ).first<{ readonly now: number }>();
  if (row === null) throw new Error('missing D1 clock');
  return row.now;
};

const control = async (scenario: string) => {
  const response = await runtime.UPSTREAM.fetch(
    new Request('https://upstream.internal/__control', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenario }),
    }),
  );
  expect(response.status).toBe(200);
};

const release = async () => {
  const response = await runtime.UPSTREAM.fetch(
    new Request('https://upstream.internal/__release', { method: 'POST' }),
  );
  expect(response.status).toBe(200);
};

const upstreamState = async (): Promise<UpstreamState> => {
  const response = await runtime.UPSTREAM.fetch(new Request('https://upstream.internal/__state'));
  return (await response.json()) as UpstreamState;
};

const issue = async (jobId: string, routes = snapshot.routes) => {
  const result = await runtime.INFERENCE.issue({
    jobId,
    snapshot: { routes },
    latestIssueDeadline: (await d1Now()) + 60_000,
  });
  if (result.kind !== 'issued') throw new Error(`grant unavailable: ${result.kind}`);
  return result.token;
};

const request = (token: string, body: Record<string, unknown>) =>
  runtime.INFERENCE.fetch(
    new Request('https://inference.internal/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }),
  );

const waitFor = async (predicate: () => boolean | Promise<boolean>, timeoutMs = 3_000) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('condition not reached');
};

const drain = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
  for (;;) {
    const next = await reader.read();
    if (next.done) return;
  }
};

describe('Inference Worker runtime boundaries', () => {
  it('keeps grant control off the public HTTP interface', async () => {
    const now = await d1Now();
    for (const path of ['/grants', '/grants/revoke', '/runner-llm/grants']) {
      const response = await runtime.INFERENCE.fetch(
        new Request(`https://inference.internal${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jobId: 'runtime-public',
            snapshot,
            latestIssueDeadline: now + 60_000,
          }),
        }),
      );

      expect(response.status).toBe(404);
    }
    await expect(
      runtime.INFERENCE.issue({
        jobId: 'runtime-public',
        snapshot,
        latestIssueDeadline: now + 60_000,
      }),
    ).resolves.toMatchObject({ kind: 'issued' });
  });

  it('does not serve retired Messages or Gemini wire protocols', async () => {
    for (const path of [
      '/v1/messages',
      '/v1beta/models/r-Z2VtaW5pLW5hdGl2ZQ:streamGenerateContent?alt=sse',
    ]) {
      const response = await runtime.INFERENCE.fetch(
        new Request(`https://inference.internal${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer retired' },
          body: JSON.stringify({}),
        }),
      );
      expect(response.status).toBe(404);
    }
  });

  it('freezes effort controls at admission instead of re-reading the mutable menu', async () => {
    const routeId = 'frozen/effort';
    await runtime.RELAY_DB.prepare(
      `INSERT OR REPLACE INTO catalog_routes
        (route_id, upstream_model, provider_slug, credential_alias, profile, efforts_json)
       VALUES (?, 'deepseek-v4-flash', 'review-provider', 'review-alias', 'chat', ?)`,
    )
      .bind(routeId, JSON.stringify([{ name: 'high', controls: { reasoning_effort: 'high' } }]))
      .run();
    try {
      await control('success');
      const issued = await runtime.INFERENCE.issueV2({
        jobId: 'runtime-frozen-effort',
        snapshot: {
          routes: [routeId],
          efforts: [
            {
              routeId,
              name: 'high',
              generation: 0,
              controls: { reasoning_effort: 'high' },
            },
          ],
        },
        latestIssueDeadline: (await d1Now()) + 60_000,
      });
      if (issued.kind !== 'issued') throw new Error('grant unavailable');
      // A later settings edit must not invalidate the already-frozen admission.
      await runtime.RELAY_DB.prepare(
        "UPDATE catalog_routes SET efforts_json = '[]' WHERE route_id = ?",
      )
        .bind(routeId)
        .run();
      const response = await request(issued.token, { model: routeId, messages: [] });
      expect(response.status).toBe(200);
      await response.text();
      expect(JSON.parse((await upstreamState()).requests[0]!.body).reasoning_effort).toBe('high');
      await runtime.INFERENCE.revoke({ jobId: 'runtime-frozen-effort' });
    } finally {
      await runtime.RELAY_DB.prepare('DELETE FROM catalog_routes WHERE route_id = ?')
        .bind(routeId)
        .run();
    }
  });

  it('rejects explicit efforts on the v1 grant and invalid effort snapshots on v2', async () => {
    const now = await d1Now();
    await expect(
      runtime.INFERENCE.issue({
        jobId: 'runtime-v1-effort',
        snapshot: {
          routes: ['deepseek-review'],
          efforts: [
            {
              routeId: 'deepseek-review',
              name: 'high',
              generation: 0,
              controls: { reasoning_effort: 'high' },
            },
          ],
        },
        latestIssueDeadline: now + 60_000,
      }),
    ).resolves.toEqual({ kind: 'invalid' });
    for (const efforts of [
      [
        {
          routeId: 'deepseek-review',
          name: 'high',
          generation: 0,
          controls: { reasoning_effort: 'high' as const },
        },
        {
          routeId: 'deepseek-review',
          name: 'max',
          generation: 0,
          controls: { reasoning_effort: 'max' as const },
        },
      ],
      [
        {
          routeId: 'step-review',
          name: 'high',
          generation: 0,
          controls: { reasoning_effort: 'high' as const },
        },
      ],
    ]) {
      await expect(
        runtime.INFERENCE.issueV2({
          jobId: `runtime-invalid-effort-${efforts.length}-${efforts[0]!.routeId}`,
          snapshot: { routes: ['deepseek-review'], efforts },
          latestIssueDeadline: now + 60_000,
        }),
      ).resolves.toEqual({ kind: 'invalid' });
    }
  });

  it('accepts generation-only effort metadata on non-Chat grants but rejects controls', async () => {
    const routeId = 'legacy/responses';
    await runtime.RELAY_DB.prepare(
      `INSERT OR REPLACE INTO catalog_routes
        (route_id, upstream_model, provider_slug, credential_alias, profile)
       VALUES (?, 'responses-native', 'review-provider', 'review-alias', 'responses')`,
    )
      .bind(routeId)
      .run();
    try {
      const issued = await runtime.INFERENCE.issueV2({
        jobId: 'runtime-nonchat-generation',
        snapshot: {
          routes: [routeId],
          efforts: [{ routeId, generation: 4 }],
        },
        latestIssueDeadline: (await d1Now()) + 60_000,
      });
      expect(issued).toMatchObject({
        kind: 'issued',
        descriptors: [{ routeId, profile: 'responses' }],
      });
      await runtime.INFERENCE.revoke({ jobId: 'runtime-nonchat-generation' });
      await expect(
        runtime.INFERENCE.issueV2({
          jobId: 'runtime-nonchat-controls',
          snapshot: {
            routes: [routeId],
            efforts: [
              {
                routeId,
                generation: 4,
                name: 'high',
                controls: { reasoning_effort: 'high' },
              },
            ],
          },
          latestIssueDeadline: (await d1Now()) + 60_000,
        }),
      ).resolves.toEqual({ kind: 'invalid' });
    } finally {
      await runtime.RELAY_DB.prepare('DELETE FROM catalog_routes WHERE route_id = ?')
        .bind(routeId)
        .run();
    }
  });

  it('issues one frozen grant for a selection above the D1 parameter limit', async () => {
    const routes = Array.from({ length: 101 }, (_, index) => `bulk-${index}`);
    await runtime.RELAY_DB.prepare(
      `INSERT INTO catalog_routes (route_id, upstream_model, provider_slug, credential_alias)
       SELECT value, value, 'review-provider', 'review-alias' FROM json_each(?)`,
    )
      .bind(JSON.stringify(routes))
      .run();
    expect(await issue('runtime-many-routes', routes)).toBeTruthy();
  });

  it('issues and revokes through the service-binding RPC interface', async () => {
    const now = await d1Now();
    const issued = await runtime.INFERENCE.issue({
      jobId: 'runtime-rpc',
      snapshot,
      latestIssueDeadline: now + 60_000,
    });

    expect(issued.kind).toBe('issued');
    if (issued.kind !== 'issued') throw new Error('expected an issued grant');
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(Date.parse(issued.expiresAt)).toBeGreaterThanOrEqual(now + GRANT_TTL_MS);
    expect(Date.parse(issued.expiresAt)).toBeLessThanOrEqual((await d1Now()) + GRANT_TTL_MS);

    await expect(runtime.INFERENCE.revoke({ jobId: 'runtime-rpc' })).resolves.toEqual({
      kind: 'revoked',
    });
    await expect(
      runtime.INFERENCE.issue({
        jobId: 'runtime-rpc',
        snapshot,
        latestIssueDeadline: (await d1Now()) + 60_000,
      }),
    ).resolves.toEqual({ kind: 'duplicate' });
  });

  it('issues a versioned grant with client descriptors over RPC', async () => {
    const now = await d1Now();
    const issued = await runtime.INFERENCE.issueV2({
      jobId: 'runtime-rpc-v2',
      snapshot: { routes: ['deepseek-review'] },
      latestIssueDeadline: now + 60_000,
    });
    expect(issued).toMatchObject({
      kind: 'issued',
      descriptors: [{ routeId: 'deepseek-review', profile: 'chat' }],
    });
    if (issued.kind !== 'issued') throw new Error('expected an issued grant');
    expect(issued.descriptors[0]).not.toHaveProperty('upstreamModel');
    await expect(runtime.INFERENCE.revoke({ jobId: 'runtime-rpc-v2' })).resolves.toEqual({
      kind: 'revoked',
    });
  });

  it('rejects a non-chat v2 grant on the chat-only inference endpoint', async () => {
    await control('success');
    await runtime.RELAY_DB.prepare(
      `INSERT INTO catalog_routes
        (route_id, upstream_model, provider_slug, credential_alias, profile)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind('responses-review', 'responses-native', 'review-provider', 'review-alias', 'responses')
      .run();
    const before = (await upstreamState()).requests.length;
    const issued = await runtime.INFERENCE.issueV2({
      jobId: 'runtime-profile-guard',
      snapshot: { routes: ['responses-review'] },
      latestIssueDeadline: (await d1Now()) + 60_000,
    });
    expect(issued).toMatchObject({
      kind: 'issued',
      descriptors: [{ routeId: 'responses-review', profile: 'responses' }],
    });
    if (issued.kind !== 'issued') throw new Error('expected an issued grant');
    const response = await request(issued.token, {
      model: 'responses-review',
      messages: [],
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { message: 'route forbidden' } });
    expect((await upstreamState()).requests).toHaveLength(before);
    await runtime.INFERENCE.revoke({ jobId: 'runtime-profile-guard' });
  });

  it('rejects an expired issue deadline over RPC', async () => {
    const now = await d1Now();
    await expect(
      runtime.INFERENCE.issue({
        jobId: 'runtime-expired',
        snapshot,
        latestIssueDeadline: now,
      }),
    ).resolves.toEqual({ kind: 'deadline-exceeded' });
  });

  it('rejects a frozen snapshot route absent from the trusted catalog', async () => {
    await expect(
      runtime.INFERENCE.issue({
        jobId: 'runtime-unknown-route',
        snapshot: { routes: ['deepseek-review', 'missing-review'] },
        latestIssueDeadline: (await d1Now()) + 60_000,
      }),
    ).resolves.toEqual({ kind: 'invalid' });
  });
});

describe('Inference Worker public streaming', () => {
  it('routes a frozen native OpenAI grant to its BYOK destination', async () => {
    await runtime.RELAY_DB.prepare(
      "INSERT INTO catalog_routes (route_id, upstream_model, provider_slug, credential_alias) VALUES ('platform/chat', 'chat-model', 'native:openai', 'platform-key')",
    ).run();
    await control('success');
    const token = await issue('native-platform-job', ['platform/chat']);
    const response = await request(token, { model: 'platform/chat', messages: [], stream: true });
    expect(await response.text()).toContain('[DONE]');
    expect((await upstreamState()).requests[0]).toMatchObject({
      url: 'https://gateway.ai.cloudflare.com/v1/test-account/test-gateway/openai/chat/completions',
      headers: { 'cf-aig-byok-alias': 'platform-key' },
    });
  });

  it('streams a frozen catalog route through trusted Gateway headers and records complete usage', async () => {
    await control('success');
    const token = await issue('runtime-success', ['deepseek-review']);

    const response = await request(token, {
      model: 'deepseek-review',
      messages: [{ role: 'user', content: 'Review this change' }],
      tools: [{ type: 'function', function: { name: 'submit_review', parameters: {} } }],
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const text = await response.text();
    expect(text).toContain('Reviewed');
    expect(text).toContain('[DONE]');

    const state = await upstreamState();
    expect(state.requests).toHaveLength(1);
    const upstream = state.requests[0]!;
    expect(upstream.url).toBe(
      'https://gateway.ai.cloudflare.com/v1/test-account/test-gateway/custom-review-provider/chat/completions',
    );
    expect(upstream.headers['cf-aig-authorization']).toBe('Bearer test-run-token');
    expect(upstream.headers['cf-aig-collect-log']).toBe('false');
    expect(upstream.headers['cf-aig-collect-log-payload']).toBe('false');
    expect(upstream.headers['cf-aig-skip-cache']).toBe('true');
    expect(upstream.headers['cf-aig-byok-alias']).toBe('review-alias');
    expect(upstream.headers.authorization).toBeUndefined();
    const body = JSON.parse(upstream.body) as Record<string, unknown>;
    expect(body.model).toBe('deepseek-review-native');
    expect(body.stream).toBe(true);
    expect(body.store).toBe(false);
    expect(body.messages).toEqual([{ role: 'user', content: 'Review this change' }]);

    await expect(runtime.INFERENCE.usage({ jobId: 'runtime-success' })).resolves.toEqual({
      version: 1,
      models: [
        {
          route: 'deepseek-review',
          model: 'deepseek-native',
          requests: 1,
          incompleteRequests: 0,
          inputTokens: { total: 10, reportedRequests: 1 },
          uncachedInputTokens: { total: 6, reportedRequests: 1 },
          cacheReadTokens: { total: 4, reportedRequests: 1 },
          cacheWriteTokens: null,
          outputTokens: { total: 3, reportedRequests: 1 },
          reasoningTokens: { total: 1, reportedRequests: 1 },
        },
      ],
    });
    await runtime.INFERENCE.revoke({ jobId: 'runtime-success' });
    await expect(runtime.INFERENCE.usage({ jobId: 'runtime-success' })).resolves.toMatchObject({
      models: [{ requests: 1, incompleteRequests: 0 }],
    });
  });

  it('rejects hosted, remote and stateful Chat capabilities before upstream', async () => {
    await control('success');
    const token = await issue('runtime-chat-rejections', ['deepseek-review']);
    const base = {
      model: 'deepseek-review',
      messages: [{ role: 'user', content: 'Review this change' }],
    };
    const invalid: readonly [string, Record<string, unknown>][] = [
      ['hosted web search tool', { ...base, tools: [{ type: 'web_search_preview' }] }],
      [
        'non-function local tool',
        { ...base, tools: [{ type: 'custom', custom: { name: 'submit_review' } }] },
      ],
      ['hosted tool selection', { ...base, tool_choice: { type: 'web_search_preview' } }],
      [
        'remote image content part',
        {
          ...base,
          messages: [
            {
              role: 'user',
              content: [{ type: 'image_url', image_url: { url: 'https://remote.example' } }],
            },
          ],
        },
      ],
      [
        'provider file content part',
        {
          ...base,
          messages: [{ role: 'user', content: [{ type: 'file', file: { file_id: 'file_1' } }] }],
        },
      ],
      [
        'input audio content part',
        {
          ...base,
          messages: [
            {
              role: 'user',
              content: [{ type: 'input_audio', input_audio: { data: 'AAAA', format: 'wav' } }],
            },
          ],
        },
      ],
      ['hosted web search options', { ...base, web_search_options: {} }],
      ['previous response lookup', { ...base, previous_response_id: 'resp_1' }],
      ['server conversation', { ...base, conversation: 'conv_1' }],
      ['hosted MCP servers', { ...base, mcp_servers: [{ url: 'https://remote.example' }] }],
      ['server container', { ...base, container: 'cntr_1' }],
      ['provider content cache', { ...base, cachedContent: 'cached-content' }],
      ['provider file ids', { ...base, file_ids: ['file_1'] }],
      ['stored response', { ...base, store: true }],
      ['non-streaming', { ...base, stream: false }],
    ];

    for (const [name, body] of invalid) {
      const response = await request(token, body);
      expect(response.status, name).toBe(400);
    }
    expect((await upstreamState()).requests).toHaveLength(0);
  });

  it('passes benign Chat fields and local tool definitions through', async () => {
    await control('success');
    const token = await issue('runtime-chat-benign-fields', ['deepseek-review']);
    const messages = [
      { role: 'system', content: 'Review this change' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Review this change', cache_control: { type: 'ephemeral' } },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'refusal', refusal: 'I cannot help with that.' }],
        audio: { id: 'audio_1' },
      },
      {
        role: 'assistant',
        content: null,
        reasoning_content: 'previous reasoning',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'submit_review', arguments: '{"decision":"approve"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'done' },
    ];
    const tools = [
      {
        type: 'function',
        function: {
          name: 'submit_review',
          description: 'Submit the completed review',
          parameters: {
            type: 'object',
            properties: { image_url: { type: 'string' }, body: { type: 'string' } },
            required: ['body'],
            additionalProperties: false,
          },
          strict: true,
        },
        provider_extension: { hosted: true, remote: 'https://docs.example/tool' },
      },
    ];
    const harmless = {
      messages,
      tools,
      tool_choice: { type: 'function', function: { name: 'submit_review' } },
      temperature: 0.2,
      top_p: 0.9,
      prompt_cache_retention: '24h',
      verbosity: 'low',
      reasoning_effort: 'max',
      service_tier: 'auto',
      modalities: ['text', 'audio'],
      audio: { voice: 'alloy', format: 'wav' },
      prediction: {
        type: 'content',
        content: [{ type: 'text', text: 'known review text' }],
      },
    };

    const response = await request(token, { model: 'deepseek-review', ...harmless });
    expect(response.status).toBe(200);
    await response.text();

    const [upstream] = (await upstreamState()).requests;
    const body = JSON.parse(upstream!.body) as Record<string, unknown>;
    for (const [key, value] of Object.entries(harmless)) expect(body[key], key).toEqual(value);
    expect(body.model).toBe('deepseek-review-native');
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
  });

  it('round-trips UTF-8 split inside a code point across upstream chunks', async () => {
    await control('utf8-split');
    const token = await issue('runtime-utf8', ['deepseek-review']);
    const response = await request(token, { model: 'deepseek-review', messages: [] });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('审查通过');
    await expect(runtime.INFERENCE.usage({ jobId: 'runtime-utf8' })).resolves.toMatchObject({
      models: [{ requests: 1, incompleteRequests: 0, inputTokens: { total: 10 } }],
    });
    await runtime.INFERENCE.revoke({ jobId: 'runtime-utf8' });
  });

  it('continues from a held terminal frame to delayed usage and DONE without eager draining', async () => {
    await control('deferred-terminal');
    const token = await issue('runtime-deferred-terminal', ['deepseek-review']);
    const response = await request(token, { model: 'deepseek-review', messages: [] });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('Deferred');
    expect(text).toContain('"finish_reason":"stop"');
    expect(text).toContain('[DONE]');
    await expect(
      runtime.INFERENCE.usage({ jobId: 'runtime-deferred-terminal' }),
    ).resolves.toMatchObject({
      models: [{ requests: 1, incompleteRequests: 0, inputTokens: { total: 10 } }],
    });
    await runtime.INFERENCE.revoke({ jobId: 'runtime-deferred-terminal' });
  });

  it('keeps the issued route mapping when the catalog changes afterwards', async () => {
    await control('success');
    const token = await issue('runtime-frozen', ['other-review']);
    try {
      await runtime.RELAY_DB.prepare(
        `UPDATE catalog_routes
        SET upstream_model = ?, provider_slug = ?, credential_alias = ?
        WHERE route_id = ?`,
      )
        .bind('changed-native', 'changed-provider', 'changed-alias', 'other-review')
        .run();

      const response = await request(token, { model: 'other-review', messages: [] });
      expect(response.status).toBe(200);
      await response.text();

      const upstream = (await upstreamState()).requests[0]!;
      expect(upstream.url).toContain('/custom-review-provider/chat/completions');
      expect(upstream.headers['cf-aig-byok-alias']).toBe('review-alias');
      expect((JSON.parse(upstream.body) as { model: string }).model).toBe('other-review-native');
    } finally {
      await runtime.RELAY_DB.prepare(
        `UPDATE catalog_routes
        SET upstream_model = ?, provider_slug = ?, credential_alias = ?
        WHERE route_id = ?`,
      )
        .bind('other-review-native', 'review-provider', 'review-alias', 'other-review')
        .run();
      await runtime.INFERENCE.revoke({ jobId: 'runtime-frozen' });
    }
  });

  it('injects the route effort over a conflicting client reasoning setting', async () => {
    await control('success');
    await runtime.RELAY_DB.prepare('UPDATE catalog_routes SET efforts_json = ? WHERE route_id = ?')
      .bind(
        JSON.stringify([{ name: 'high', controls: { reasoning_effort: 'high' } }]),
        'deepseek-review',
      )
      .run();
    const issued = await runtime.INFERENCE.issueV2({
      jobId: 'runtime-effort-injection',
      snapshot: {
        routes: ['deepseek-review'],
        efforts: [
          {
            routeId: 'deepseek-review',
            name: 'high',
            generation: 0,
            controls: { reasoning_effort: 'high' },
          },
        ],
      },
      latestIssueDeadline: (await d1Now()) + 60_000,
    });
    expect(issued.kind).toBe('issued');
    if (issued.kind !== 'issued') throw new Error('expected an issued grant');

    const response = await request(issued.token, {
      model: 'deepseek-review',
      messages: [],
      reasoning_effort: 'low',
    });
    expect(response.status).toBe(200);
    await response.text();

    const body = JSON.parse((await upstreamState()).requests[0]!.body) as Record<string, unknown>;
    expect(body.reasoning_effort).toBe('high');
    await runtime.INFERENCE.revoke({ jobId: 'runtime-effort-injection' });
  });

  it('injects the MiMo off control when the client sends no thinking fields', async () => {
    await control('success');
    await runtime.RELAY_DB.prepare('UPDATE catalog_routes SET efforts_json = ? WHERE route_id = ?')
      .bind(
        JSON.stringify([{ name: 'off', controls: { thinking: { type: 'disabled' } } }]),
        'step-review',
      )
      .run();
    try {
      const issued = await runtime.INFERENCE.issueV2({
        jobId: 'runtime-mimo-off',
        snapshot: {
          routes: ['step-review'],
          efforts: [
            {
              routeId: 'step-review',
              name: 'off',
              generation: 0,
              controls: { thinking: { type: 'disabled' } },
            },
          ],
        },
        latestIssueDeadline: (await d1Now()) + 60_000,
      });
      expect(issued.kind).toBe('issued');
      if (issued.kind !== 'issued') throw new Error('expected an issued grant');
      const response = await request(issued.token, {
        model: 'step-review',
        messages: [],
        reasoning_effort: 'low',
      });
      expect(response.status).toBe(200);
      await response.text();
      const body = JSON.parse((await upstreamState()).requests[0]!.body) as Record<string, unknown>;
      expect(body.thinking).toEqual({ type: 'disabled' });
      expect(body.reasoning_effort).toBeUndefined();
      await runtime.INFERENCE.revoke({ jobId: 'runtime-mimo-off' });
    } finally {
      await runtime.RELAY_DB.prepare(
        "UPDATE catalog_routes SET efforts_json = '[]' WHERE route_id IN ('deepseek-review', 'step-review')",
      ).run();
    }
  });

  it('falls back once on the verified DeepSeek rejection, then reuses the default', async () => {
    const routeId = 'fallback/deepseek';
    await runtime.RELAY_DB.prepare(
      `INSERT OR REPLACE INTO catalog_routes
        (route_id, upstream_model, provider_slug, credential_alias, profile, efforts_json)
       VALUES (?, 'deepseek-v4-flash', 'review-provider', 'review-alias', 'chat', ?)`,
    )
      .bind(
        routeId,
        JSON.stringify([{ name: 'minimal', controls: { reasoning_effort: 'minimal' } }]),
      )
      .run();
    await runtime.RELAY_DB.prepare('DELETE FROM route_effort_state WHERE route_id = ?')
      .bind(routeId)
      .run();
    await control('deepseek-reject-minimal');
    try {
      const issueEffort = async (jobId: string, generation: number, name: string) => {
        const controls =
          name === 'minimal'
            ? { reasoning_effort: 'minimal' as const }
            : { reasoning_effort: 'high' as const };
        const issued = await runtime.INFERENCE.issueV2({
          jobId,
          snapshot: {
            routes: [routeId],
            efforts: [{ routeId, name, generation, controls }],
          },
          latestIssueDeadline: (await d1Now()) + 60_000,
        });
        if (issued.kind !== 'issued') throw new Error(`grant unavailable: ${issued.kind}`);
        return issued.token;
      };

      const messages = [
        { role: 'assistant', content: 'Checking', reasoning_content: 'private reasoning' },
        { role: 'tool', tool_call_id: 'call-1', content: 'tool result' },
      ];
      const tools = [{ type: 'function', function: { name: 'inspect', parameters: {} } }];
      const first = await issueEffort('runtime-fallback-first', 0, 'minimal');
      const firstResponse = await request(first, {
        model: routeId,
        messages,
        tools,
        reasoning_effort: 'high',
      });
      expect(firstResponse.status).toBe(200);
      expect(await firstResponse.text()).toContain('[DONE]');
      const afterFirst = await upstreamState();
      expect(afterFirst.requests).toHaveLength(2);
      expect(JSON.parse(afterFirst.requests[0]!.body).reasoning_effort).toBe('minimal');
      const retryBody = JSON.parse(afterFirst.requests[1]!.body) as Record<string, unknown>;
      expect(retryBody.reasoning_effort).toBeUndefined();
      expect(retryBody.thinking).toBeUndefined();
      expect(retryBody.messages).toEqual(messages);
      expect(retryBody.tools).toEqual(tools);

      await expect(
        runtime.INFERENCE.usage({ jobId: 'runtime-fallback-first' }),
      ).resolves.toMatchObject({
        efforts: [
          {
            route: routeId,
            selected: 'minimal',
            generation: 0,
            outcomes: [
              {
                kind: 'switched',
                reason: 'upstream rejected reasoning_effort',
                requests: 1,
              },
            ],
          },
        ],
      });
      const details = await runtime.INFERENCE.effortDetails({
        jobId: 'runtime-fallback-first',
      });
      expect(details?.requests[0]?.attempts).toEqual([
        {
          attempt: 1,
          sent: { reasoning_effort: 'minimal' },
          reported: null,
          result: 'rejected',
        },
        { attempt: 2, sent: null, reported: null, result: 'complete' },
      ]);

      const sharedCount = (await upstreamState()).requests.length;
      const second = await issueEffort('runtime-fallback-shared', 0, 'high');
      const sharedResponse = await request(second, {
        model: routeId,
        messages: [],
        reasoning_effort: 'high',
      });
      expect(sharedResponse.status).toBe(200);
      await sharedResponse.text();
      const sharedRequests = (await upstreamState()).requests.slice(sharedCount);
      expect(sharedRequests).toHaveLength(1);
      expect(
        (JSON.parse(sharedRequests[0]!.body) as Record<string, unknown>).reasoning_effort,
      ).toBeUndefined();
      await expect(
        runtime.INFERENCE.usage({ jobId: 'runtime-fallback-shared' }),
      ).resolves.toMatchObject({
        efforts: [
          { route: routeId, selected: 'high', generation: 0, outcomes: [{ kind: 'shared' }] },
        ],
      });
      const states = await runtime.INFERENCE.effortStates();
      expect(
        (states.routes as readonly Record<string, unknown>[]).find(
          (entry) => entry.routeId === routeId,
        ),
      ).toMatchObject({
        routeId,
        generation: 0,
        reason: 'upstream rejected reasoning_effort',
      });

      await control('success');
      const resetCount = (await upstreamState()).requests.length;
      const reset = await issueEffort('runtime-fallback-reset', 1, 'high');
      const resetResponse = await request(reset, { model: routeId, messages: [] });
      expect(resetResponse.status).toBe(200);
      await resetResponse.text();
      const resetRequests = (await upstreamState()).requests.slice(resetCount);
      expect(JSON.parse(resetRequests[0]!.body).reasoning_effort).toBe('high');

      await runtime.INFERENCE.revoke({ jobId: 'runtime-fallback-first' });
      await runtime.INFERENCE.revoke({ jobId: 'runtime-fallback-shared' });
      await runtime.INFERENCE.revoke({ jobId: 'runtime-fallback-reset' });
    } finally {
      await runtime.RELAY_DB.prepare('DELETE FROM route_effort_state WHERE route_id = ?')
        .bind(routeId)
        .run();
      await runtime.RELAY_DB.prepare('DELETE FROM catalog_routes WHERE route_id = ?')
        .bind(routeId)
        .run();
    }
  });

  it('does not retry a generic 400 or a non-DeepSeek route', async () => {
    const genericRoute = 'fallback/generic';
    const otherRoute = 'fallback/other';
    await runtime.RELAY_DB.prepare(
      `INSERT OR REPLACE INTO catalog_routes
        (route_id, upstream_model, provider_slug, credential_alias, profile, efforts_json)
       VALUES (?, 'deepseek-v4-flash', 'review-provider', 'review-alias', 'chat', ?)`,
    )
      .bind(
        genericRoute,
        JSON.stringify([{ name: 'minimal', controls: { reasoning_effort: 'minimal' } }]),
      )
      .run();
    await runtime.RELAY_DB.prepare(
      `INSERT OR REPLACE INTO catalog_routes
        (route_id, upstream_model, provider_slug, credential_alias, profile, efforts_json)
       VALUES (?, 'mimo-v2.6-flash', 'review-provider', 'review-alias', 'chat', ?)`,
    )
      .bind(
        otherRoute,
        JSON.stringify([{ name: 'off', controls: { thinking: { type: 'disabled' } } }]),
      )
      .run();
    await runtime.RELAY_DB.prepare('DELETE FROM route_effort_state WHERE route_id IN (?, ?)')
      .bind(genericRoute, otherRoute)
      .run();
    try {
      await control('deepseek-reject-generic');
      const generic = await runtime.INFERENCE.issueV2({
        jobId: 'runtime-fallback-generic',
        snapshot: {
          routes: [genericRoute],
          efforts: [
            {
              routeId: genericRoute,
              name: 'minimal',
              generation: 0,
              controls: { reasoning_effort: 'minimal' },
            },
          ],
        },
        latestIssueDeadline: (await d1Now()) + 60_000,
      });
      if (generic.kind !== 'issued') throw new Error('grant unavailable');
      const before = (await upstreamState()).requests.length;
      const response = await request(generic.token, { model: genericRoute, messages: [] });
      expect(response.status).toBe(400);
      expect((await upstreamState()).requests).toHaveLength(before + 1);

      await control('other-model-reject');
      const other = await runtime.INFERENCE.issueV2({
        jobId: 'runtime-fallback-other',
        snapshot: {
          routes: [otherRoute],
          efforts: [
            {
              routeId: otherRoute,
              name: 'off',
              generation: 0,
              controls: { thinking: { type: 'disabled' } },
            },
          ],
        },
        latestIssueDeadline: (await d1Now()) + 60_000,
      });
      if (other.kind !== 'issued') throw new Error('grant unavailable');
      const otherBefore = (await upstreamState()).requests.length;
      const otherResponse = await request(other.token, { model: otherRoute, messages: [] });
      expect(otherResponse.status).toBe(400);
      expect((await upstreamState()).requests).toHaveLength(otherBefore + 1);
      await runtime.INFERENCE.revoke({ jobId: 'runtime-fallback-generic' });
      await runtime.INFERENCE.revoke({ jobId: 'runtime-fallback-other' });
    } finally {
      await runtime.RELAY_DB.prepare('DELETE FROM route_effort_state WHERE route_id IN (?, ?)')
        .bind(genericRoute, otherRoute)
        .run();
      await runtime.RELAY_DB.prepare('DELETE FROM catalog_routes WHERE route_id IN (?, ?)')
        .bind(genericRoute, otherRoute)
        .run();
    }
  });

  it('sends at most one retry when revoke lands between attempts', async () => {
    const routeId = 'fallback/revoked';
    await runtime.RELAY_DB.prepare(
      `INSERT OR REPLACE INTO catalog_routes
        (route_id, upstream_model, provider_slug, credential_alias, profile, efforts_json)
       VALUES (?, 'deepseek-v4-flash', 'review-provider', 'review-alias', 'chat', ?)`,
    )
      .bind(
        routeId,
        JSON.stringify([{ name: 'minimal', controls: { reasoning_effort: 'minimal' } }]),
      )
      .run();
    await runtime.RELAY_DB.prepare('DELETE FROM route_effort_state WHERE route_id = ?')
      .bind(routeId)
      .run();
    await control('deepseek-reject-minimal-delayed');
    try {
      const issued = await runtime.INFERENCE.issueV2({
        jobId: 'runtime-fallback-revoked',
        snapshot: {
          routes: [routeId],
          efforts: [
            {
              routeId,
              name: 'minimal',
              generation: 0,
              controls: { reasoning_effort: 'minimal' },
            },
          ],
        },
        latestIssueDeadline: (await d1Now()) + 60_000,
      });
      if (issued.kind !== 'issued') throw new Error('grant unavailable');
      const before = (await upstreamState()).requests.length;
      const pending = request(issued.token, { model: routeId, messages: [] });
      await waitFor(async () => (await upstreamState()).requests.length === before + 1);
      await runtime.INFERENCE.revoke({ jobId: 'runtime-fallback-revoked' });
      await release();
      const response = await pending;
      expect(response.status).toBe(400);
      expect((await upstreamState()).requests).toHaveLength(before + 1);
      await expect(
        runtime.INFERENCE.usage({ jobId: 'runtime-fallback-revoked' }),
      ).resolves.toMatchObject({ models: [{ requests: 1, incompleteRequests: 1 }] });
    } finally {
      await runtime.RELAY_DB.prepare('DELETE FROM route_effort_state WHERE route_id = ?')
        .bind(routeId)
        .run();
      await runtime.RELAY_DB.prepare('DELETE FROM catalog_routes WHERE route_id = ?')
        .bind(routeId)
        .run();
    }
  });

  it('pages authorized attempt details and aggregates the full job summary', async () => {
    const routeId = 'fallback/paged';
    await runtime.RELAY_DB.prepare(
      `INSERT OR REPLACE INTO catalog_routes
        (route_id, upstream_model, provider_slug, credential_alias, profile, efforts_json)
       VALUES (?, 'deepseek-v4-flash', 'review-provider', 'review-alias', 'chat', ?)`,
    )
      .bind(routeId, JSON.stringify([{ name: 'high', controls: { reasoning_effort: 'high' } }]))
      .run();
    await runtime.RELAY_DB.prepare('DELETE FROM route_effort_state WHERE route_id = ?')
      .bind(routeId)
      .run();
    await control('success');
    try {
      const issued = await runtime.INFERENCE.issueV2({
        jobId: 'runtime-effort-paged',
        snapshot: {
          routes: [routeId],
          efforts: [
            {
              routeId,
              name: 'high',
              generation: 0,
              controls: { reasoning_effort: 'high' },
            },
          ],
        },
        latestIssueDeadline: (await d1Now()) + 60_000,
      });
      if (issued.kind !== 'issued') throw new Error('grant unavailable');
      for (let index = 0; index < 21; index += 1) {
        const response = await request(issued.token, { model: routeId, messages: [] });
        expect(response.status).toBe(200);
        await response.text();
      }
      const first = await runtime.INFERENCE.effortDetails({ jobId: 'runtime-effort-paged' });
      expect(first?.requests).toHaveLength(20);
      expect(first?.nextCursor).toEqual(expect.any(String));
      const second = await runtime.INFERENCE.effortDetails({
        jobId: 'runtime-effort-paged',
        cursor: first!.nextCursor!,
      });
      expect(second?.requests).toHaveLength(1);
      expect(second?.nextCursor).toBeNull();
      await expect(
        runtime.INFERENCE.usage({ jobId: 'runtime-effort-paged' }),
      ).resolves.toMatchObject({
        efforts: [
          { route: routeId, selected: 'high', generation: 0, outcomes: [{ requests: 21 }] },
        ],
      });
      await runtime.INFERENCE.revoke({ jobId: 'runtime-effort-paged' });
    } finally {
      await runtime.RELAY_DB.prepare('DELETE FROM route_effort_state WHERE route_id = ?')
        .bind(routeId)
        .run();
      await runtime.RELAY_DB.prepare('DELETE FROM catalog_routes WHERE route_id = ?')
        .bind(routeId)
        .run();
    }
  });

  it('records a supported client control as sent when the route has no selected effort', async () => {
    await control('success');
    const issued = await runtime.INFERENCE.issueV2({
      jobId: 'runtime-passthrough',
      snapshot: { routes: ['deepseek-review'] },
      latestIssueDeadline: (await d1Now()) + 60_000,
    });
    if (issued.kind !== 'issued') throw new Error('grant unavailable');
    const response = await request(issued.token, {
      model: 'deepseek-review',
      messages: [],
      reasoning_effort: 'low',
    });
    expect(response.status).toBe(200);
    await response.text();
    const details = await runtime.INFERENCE.effortDetails({ jobId: 'runtime-passthrough' });
    expect(details?.requests[0]?.selected).toBeNull();
    expect(details?.requests[0]?.attempts).toEqual([
      {
        attempt: 1,
        sent: { reasoning_effort: 'low' },
        reported: null,
        result: 'complete',
      },
    ]);
    await runtime.INFERENCE.revoke({ jobId: 'runtime-passthrough' });
  });

  it('keeps an older grant generation in fallback after a newer generation trips', async () => {
    const routeId = 'fallback/generation';
    await runtime.RELAY_DB.prepare(
      `INSERT OR REPLACE INTO catalog_routes
        (route_id, upstream_model, provider_slug, credential_alias, profile, efforts_json)
       VALUES (?, 'deepseek-v4-flash', 'review-provider', 'review-alias', 'chat', ?)`,
    )
      .bind(routeId, '[]')
      .run();
    await runtime.RELAY_DB.prepare('DELETE FROM route_effort_state WHERE route_id = ?')
      .bind(routeId)
      .run();
    await control('deepseek-reject-minimal');
    try {
      const issue = async (jobId: string, generation: number, name: 'minimal' | 'high') => {
        const controls =
          name === 'minimal'
            ? { reasoning_effort: 'minimal' as const }
            : { reasoning_effort: 'high' as const };
        const issued = await runtime.INFERENCE.issueV2({
          jobId,
          snapshot: {
            routes: [routeId],
            efforts: [{ routeId, generation, name, controls }],
          },
          latestIssueDeadline: (await d1Now()) + 60_000,
        });
        if (issued.kind !== 'issued') throw new Error('grant unavailable');
        return issued.token;
      };
      const newer = await issue('runtime-generation-newer', 1, 'minimal');
      const newerResponse = await request(newer, { model: routeId, messages: [] });
      expect(newerResponse.status).toBe(200);
      await newerResponse.text();
      const state = await runtime.INFERENCE.effortStates();
      expect(
        (state.routes as readonly Record<string, unknown>[]).find(
          (entry) => entry.routeId === routeId,
        ),
      ).toMatchObject({ generation: 1 });

      const older = await issue('runtime-generation-older', 0, 'high');
      const before = (await upstreamState()).requests.length;
      const response = await request(older, {
        model: routeId,
        messages: [],
        reasoning_effort: 'high',
      });
      expect(response.status).toBe(200);
      await response.text();
      const olderRequest = (await upstreamState()).requests[before];
      expect(
        (JSON.parse(olderRequest!.body) as Record<string, unknown>).reasoning_effort,
      ).toBeUndefined();
      await runtime.INFERENCE.revoke({ jobId: 'runtime-generation-newer' });
      await runtime.INFERENCE.revoke({ jobId: 'runtime-generation-older' });
    } finally {
      await runtime.RELAY_DB.prepare('DELETE FROM route_effort_state WHERE route_id = ?')
        .bind(routeId)
        .run();
      await runtime.RELAY_DB.prepare('DELETE FROM catalog_routes WHERE route_id = ?')
        .bind(routeId)
        .run();
    }
  });

  it('records only an explicit upstream control report, never reasoning tokens', async () => {
    await control('effort-report');
    const issued = await runtime.INFERENCE.issueV2({
      jobId: 'runtime-effort-report',
      snapshot: {
        routes: ['deepseek-review'],
        efforts: [
          {
            routeId: 'deepseek-review',
            name: 'high',
            generation: 0,
            controls: { reasoning_effort: 'high' },
          },
        ],
      },
      latestIssueDeadline: (await d1Now()) + 60_000,
    });
    if (issued.kind !== 'issued') throw new Error('grant unavailable');
    const response = await request(issued.token, { model: 'deepseek-review', messages: [] });
    expect(response.status).toBe(200);
    await response.text();
    const details = await runtime.INFERENCE.effortDetails({ jobId: 'runtime-effort-report' });
    expect(details?.requests[0]?.attempts).toEqual([
      {
        attempt: 1,
        sent: { reasoning_effort: 'high' },
        reported: { reasoning_effort: 'max' },
        result: 'complete',
      },
    ]);
    await expect(
      runtime.INFERENCE.usage({ jobId: 'runtime-effort-report' }),
    ).resolves.toMatchObject({
      models: [{ reasoningTokens: { total: 1, reportedRequests: 1 } }],
      efforts: [{ route: 'deepseek-review', selected: 'high', outcomes: [{ kind: null }] }],
    });
    await runtime.INFERENCE.revoke({ jobId: 'runtime-effort-report' });
  });

  it('keeps best-effort termination for ordinary explicit and shared accounting failures', async () => {
    const routeId = 'fallback/accounting';
    await runtime.RELAY_DB.prepare(
      `INSERT OR REPLACE INTO catalog_routes
        (route_id, upstream_model, provider_slug, credential_alias, profile, efforts_json)
       VALUES (?, 'deepseek-v4-flash', 'review-provider', 'review-alias', 'chat', ?)`,
    )
      .bind(routeId, JSON.stringify([{ name: 'high', controls: { reasoning_effort: 'high' } }]))
      .run();
    await runtime.RELAY_DB.prepare('DELETE FROM route_effort_state WHERE route_id = ?')
      .bind(routeId)
      .run();
    const installFailure = () =>
      runtime.RELAY_DB.prepare(
        `CREATE TRIGGER fail_effort_completion
         BEFORE UPDATE OF status ON inference_requests
         WHEN NEW.status = 'complete'
         BEGIN SELECT RAISE(ABORT, 'injected accounting failure'); END`,
      ).run();
    const dropFailure = () =>
      runtime.RELAY_DB.prepare('DROP TRIGGER IF EXISTS fail_effort_completion').run();
    await control('success');
    try {
      const explicit = await runtime.INFERENCE.issueV2({
        jobId: 'runtime-accounting-explicit',
        snapshot: {
          routes: [routeId],
          efforts: [
            {
              routeId,
              generation: 0,
              name: 'high',
              controls: { reasoning_effort: 'high' },
            },
          ],
        },
        latestIssueDeadline: (await d1Now()) + 60_000,
      });
      if (explicit.kind !== 'issued') throw new Error('grant unavailable');
      await installFailure();
      const explicitResponse = await request(explicit.token, { model: routeId, messages: [] });
      expect(explicitResponse.status).toBe(200);
      expect(await explicitResponse.text()).toContain('[DONE]');
      await dropFailure();

      await runtime.RELAY_DB.prepare(
        `INSERT INTO route_effort_state (route_id, generation, fallback_at, reason)
         VALUES (?, 0, ?, 'upstream rejected reasoning_effort')`,
      )
        .bind(routeId, Date.now())
        .run();
      const shared = await runtime.INFERENCE.issueV2({
        jobId: 'runtime-accounting-shared',
        snapshot: {
          routes: [routeId],
          efforts: [
            {
              routeId,
              generation: 0,
              name: 'high',
              controls: { reasoning_effort: 'high' },
            },
          ],
        },
        latestIssueDeadline: (await d1Now()) + 60_000,
      });
      if (shared.kind !== 'issued') throw new Error('grant unavailable');
      await installFailure();
      const sharedResponse = await request(shared.token, { model: routeId, messages: [] });
      expect(sharedResponse.status).toBe(200);
      expect(await sharedResponse.text()).toContain('[DONE]');
      await dropFailure();
      await runtime.INFERENCE.revoke({ jobId: 'runtime-accounting-explicit' });
      await runtime.INFERENCE.revoke({ jobId: 'runtime-accounting-shared' });
    } finally {
      await dropFailure();
      await runtime.RELAY_DB.prepare('DELETE FROM route_effort_state WHERE route_id = ?')
        .bind(routeId)
        .run();
      await runtime.RELAY_DB.prepare('DELETE FROM catalog_routes WHERE route_id = ?')
        .bind(routeId)
        .run();
    }
  });

  it('suppresses the successful terminator when the first fallback settlement fails', async () => {
    const routeId = 'fallback/settlement';
    await runtime.RELAY_DB.prepare(
      `INSERT OR REPLACE INTO catalog_routes
        (route_id, upstream_model, provider_slug, credential_alias, profile, efforts_json)
       VALUES (?, 'deepseek-v4-flash', 'review-provider', 'review-alias', 'chat', ?)`,
    )
      .bind(
        routeId,
        JSON.stringify([{ name: 'minimal', controls: { reasoning_effort: 'minimal' } }]),
      )
      .run();
    await runtime.RELAY_DB.prepare('DELETE FROM route_effort_state WHERE route_id = ?')
      .bind(routeId)
      .run();
    await runtime.RELAY_DB.prepare(
      `CREATE TRIGGER fail_effort_completion
       BEFORE UPDATE OF status ON inference_requests
       WHEN NEW.status = 'complete'
       BEGIN SELECT RAISE(ABORT, 'injected accounting failure'); END`,
    ).run();
    await control('deepseek-reject-minimal');
    try {
      const issued = await runtime.INFERENCE.issueV2({
        jobId: 'runtime-settlement-failure',
        snapshot: {
          routes: [routeId],
          efforts: [
            {
              routeId,
              generation: 0,
              name: 'minimal',
              controls: { reasoning_effort: 'minimal' },
            },
          ],
        },
        latestIssueDeadline: (await d1Now()) + 60_000,
      });
      if (issued.kind !== 'issued') throw new Error('grant unavailable');
      const response = await request(issued.token, { model: routeId, messages: [] });
      expect(response.status).toBe(200);
      await expect(response.text()).rejects.toThrow();
      const state = await runtime.RELAY_DB.prepare(
        'SELECT COUNT(*) AS count FROM route_effort_state WHERE route_id = ?',
      )
        .bind(routeId)
        .first<{ readonly count: number }>();
      expect(state?.count).toBe(0);
      await runtime.INFERENCE.revoke({ jobId: 'runtime-settlement-failure' });
    } finally {
      await runtime.RELAY_DB.prepare('DROP TRIGGER IF EXISTS fail_effort_completion').run();
      await runtime.RELAY_DB.prepare('DELETE FROM route_effort_state WHERE route_id = ?')
        .bind(routeId)
        .run();
      await runtime.RELAY_DB.prepare('DELETE FROM catalog_routes WHERE route_id = ?')
        .bind(routeId)
        .run();
    }
  });

  it('suppresses the first fallback terminator on an actual revoke before completion', async () => {
    const routeId = 'fallback/revoke-settlement';
    await runtime.RELAY_DB.prepare(
      `INSERT OR REPLACE INTO catalog_routes
        (route_id, upstream_model, provider_slug, credential_alias, profile, efforts_json)
       VALUES (?, 'deepseek-v4-flash', 'review-provider', 'review-alias', 'chat', ?)`,
    )
      .bind(
        routeId,
        JSON.stringify([{ name: 'minimal', controls: { reasoning_effort: 'minimal' } }]),
      )
      .run();
    await runtime.RELAY_DB.prepare('DELETE FROM route_effort_state WHERE route_id = ?')
      .bind(routeId)
      .run();
    await control('deepseek-reject-minimal-then-hold');
    try {
      const issued = await runtime.INFERENCE.issueV2({
        jobId: 'runtime-revoke-settlement',
        snapshot: {
          routes: [routeId],
          efforts: [
            {
              routeId,
              generation: 0,
              name: 'minimal',
              controls: { reasoning_effort: 'minimal' },
            },
          ],
        },
        latestIssueDeadline: (await d1Now()) + 60_000,
      });
      if (issued.kind !== 'issued') throw new Error('grant unavailable');
      const before = (await upstreamState()).requests.length;
      const pending = request(issued.token, { model: routeId, messages: [] });
      await waitFor(async () => (await upstreamState()).requests.length === before + 2);
      await runtime.INFERENCE.revoke({ jobId: 'runtime-revoke-settlement' });
      await release();
      const response = await pending;
      expect(response.status).toBe(200);
      await expect(response.text()).rejects.toThrow();
      const state = await runtime.RELAY_DB.prepare(
        'SELECT COUNT(*) AS count FROM route_effort_state WHERE route_id = ?',
      )
        .bind(routeId)
        .first<{ readonly count: number }>();
      expect(state?.count).toBe(0);
    } finally {
      await runtime.RELAY_DB.prepare('DELETE FROM route_effort_state WHERE route_id = ?')
        .bind(routeId)
        .run();
      await runtime.RELAY_DB.prepare('DELETE FROM catalog_routes WHERE route_id = ?')
        .bind(routeId)
        .run();
    }
  });

  it('rejects wrong, unknown, revoked and ungranted routes before upstream inference', async () => {
    await control('success');
    const wrongToken = await request('not-a-valid-token', {
      model: 'deepseek-review',
      messages: [],
    });
    expect(wrongToken.status).toBe(401);

    const token = await issue('runtime-denied', ['deepseek-review']);
    const ungranted = await request(token, { model: 'step-review', messages: [] });
    expect(ungranted.status).toBe(403);

    await runtime.INFERENCE.revoke({ jobId: 'runtime-denied' });
    const revoked = await request(token, { model: 'deepseek-review', messages: [] });
    expect(revoked.status).toBe(401);

    expect((await upstreamState()).requests).toHaveLength(0);
  });

  it('sanitizes an upstream HTTP failure while retaining an incomplete request', async () => {
    await control('error');
    const token = await issue('runtime-error', ['deepseek-review']);
    const response = await request(token, { model: 'deepseek-review', messages: [] });
    expect(response.status).toBe(429);
    expect(response.headers.get('x-private')).toBeNull();
    const text = await response.text();
    expect(text).not.toContain('private upstream diagnostic');
    expect(JSON.parse(text)).toEqual({ error: { message: 'model request failed' } });

    await runtime.INFERENCE.revoke({ jobId: 'runtime-error' });
    await expect(runtime.INFERENCE.usage({ jobId: 'runtime-error' })).resolves.toMatchObject({
      models: [{ requests: 1, incompleteRequests: 1, model: null }],
    });
  });

  it('retains partial usage when the upstream stream fails', async () => {
    await control('failure-after-usage');
    const token = await issue('runtime-partial', ['deepseek-review']);
    const response = await request(token, { model: 'deepseek-review', messages: [] });
    expect(response.status).toBe(200);
    await expect(response.text()).rejects.toThrow();

    await expect(runtime.INFERENCE.usage({ jobId: 'runtime-partial' })).resolves.toMatchObject({
      models: [
        {
          route: 'deepseek-review',
          model: 'deepseek-native',
          requests: 1,
          incompleteRequests: 1,
          inputTokens: { total: 10, reportedRequests: 1 },
          cacheReadTokens: { total: 4, reportedRequests: 1 },
          outputTokens: { total: 3, reportedRequests: 1 },
        },
      ],
    });
    await runtime.INFERENCE.revoke({ jobId: 'runtime-partial' });
  });

  it('marks a premature EOF incomplete', async () => {
    await control('incomplete');
    const token = await issue('runtime-eof', ['deepseek-review']);
    const response = await request(token, { model: 'deepseek-review', messages: [] });
    await expect(response.text()).rejects.toThrow();

    await runtime.INFERENCE.revoke({ jobId: 'runtime-eof' });
    await expect(runtime.INFERENCE.usage({ jobId: 'runtime-eof' })).resolves.toMatchObject({
      models: [{ requests: 1, incompleteRequests: 1, inputTokens: null }],
    });
  });

  it('seals pending usage at revoke and ignores a later completion', async () => {
    await control('hold');
    const token = await issue('runtime-sealed', ['deepseek-review']);
    const response = await request(token, { model: 'deepseek-review', messages: [] });
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);

    await runtime.INFERENCE.revoke({ jobId: 'runtime-sealed' });
    await expect(runtime.INFERENCE.usage({ jobId: 'runtime-sealed' })).resolves.toMatchObject({
      models: [{ requests: 1, incompleteRequests: 1 }],
    });

    await release();
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
    }
    await expect(runtime.INFERENCE.usage({ jobId: 'runtime-sealed' })).resolves.toMatchObject({
      models: [{ requests: 1, incompleteRequests: 1, model: null }],
    });
  });

  it('revokes only pending accounting while a completed request keeps its usage', async () => {
    await control('success');
    const token = await issue('runtime-revoke-mixed', ['deepseek-review']);
    const completed = await request(token, { model: 'deepseek-review', messages: [] });
    expect(completed.status).toBe(200);
    await completed.text();

    await control('hold');
    const pending = await request(token, { model: 'deepseek-review', messages: [] });
    const reader = pending.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);

    await runtime.INFERENCE.revoke({ jobId: 'runtime-revoke-mixed' });
    const expectMixedRevoke = async () => {
      const summary = await runtime.INFERENCE.usage({ jobId: 'runtime-revoke-mixed' });
      expect(summary?.models).toHaveLength(2);
      expect(summary?.models.find((row) => row.model === 'deepseek-native')).toMatchObject({
        route: 'deepseek-review',
        requests: 1,
        incompleteRequests: 0,
        inputTokens: { total: 10, reportedRequests: 1 },
        outputTokens: { total: 3, reportedRequests: 1 },
      });
      expect(summary?.models.find((row) => row.model === null)).toMatchObject({
        route: 'deepseek-review',
        requests: 1,
        incompleteRequests: 1,
        inputTokens: null,
      });
    };
    await expectMixedRevoke();

    await release();
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
    }
    await expectMixedRevoke();
  });

  it('cancels the upstream fetch when the client disconnects', async () => {
    await control('silent');
    const token = await issue('runtime-disconnect', ['deepseek-review']);
    const aborter = new AbortController();
    const response = await runtime.INFERENCE.fetch(
      new Request('https://inference.internal/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ model: 'deepseek-review', messages: [] }),
        signal: aborter.signal,
      }),
    );
    const reader = response.body!.getReader();
    await reader.read();
    aborter.abort();
    await expect(reader.read()).rejects.toThrow();

    await runtime.INFERENCE.revoke({ jobId: 'runtime-disconnect' });
    await expect(runtime.INFERENCE.usage({ jobId: 'runtime-disconnect' })).resolves.toMatchObject({
      models: [{ requests: 1, incompleteRequests: 1 }],
    });
  });

  it('cancels the upstream fetch at local grant expiry', async () => {
    await control('silent');
    const token = await issue('runtime-local-expiry', ['deepseek-review']);
    const expiry = Date.now() + 250;
    await runtime.RELAY_DB.prepare('UPDATE grants SET expires_at = ? WHERE job_id = ?')
      .bind(expiry, 'runtime-local-expiry')
      .run();

    const response = await request(token, { model: 'deepseek-review', messages: [] });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    await reader.read();
    await expect(reader.read()).rejects.toThrow();

    await runtime.INFERENCE.revoke({ jobId: 'runtime-local-expiry' });
    await expect(runtime.INFERENCE.usage({ jobId: 'runtime-local-expiry' })).resolves.toMatchObject(
      {
        models: [{ requests: 1, incompleteRequests: 1 }],
      },
    );
  });
  it('bounds held terminal frames after the finish marker', async () => {
    await control('flood-after-finish');
    const token = await issue('runtime-flood', ['deepseek-review']);
    const response = await request(token, { model: 'deepseek-review', messages: [] });
    await expect(response.text()).rejects.toThrow();

    await runtime.INFERENCE.revoke({ jobId: 'runtime-flood' });
    await expect(runtime.INFERENCE.usage({ jobId: 'runtime-flood' })).resolves.toMatchObject({
      models: [{ requests: 1, incompleteRequests: 1 }],
    });
  });

  it('bounds held terminal bytes after the finish marker', async () => {
    await control('flood-bytes-after-finish');
    const token = await issue('runtime-flood-bytes', ['deepseek-review']);
    const response = await request(token, { model: 'deepseek-review', messages: [] });
    await expect(response.text()).rejects.toThrow();

    await runtime.INFERENCE.revoke({ jobId: 'runtime-flood-bytes' });
    await expect(runtime.INFERENCE.usage({ jobId: 'runtime-flood-bytes' })).resolves.toMatchObject({
      models: [{ requests: 1, incompleteRequests: 1 }],
    });
  });

  it('bounds an oversized Chat frame before parsing', async () => {
    await control('chat-oversized-frame');
    const token = await issue('runtime-chat-oversized-frame', ['deepseek-review']);
    const response = await request(token, { model: 'deepseek-review', messages: [] });
    expect(response.status).toBe(200);
    await expect(response.text()).rejects.toThrow();

    await runtime.INFERENCE.revoke({ jobId: 'runtime-chat-oversized-frame' });
    await expect(
      runtime.INFERENCE.usage({ jobId: 'runtime-chat-oversized-frame' }),
    ).resolves.toMatchObject({
      models: [{ requests: 1, incompleteRequests: 1 }],
    });
  });

  it('keeps a sibling job isolated when another job is revoked midstream', async () => {
    await control('hold');
    const tokenA = await issue('runtime-sibling-a', ['deepseek-review']);
    const tokenB = await issue('runtime-sibling-b', ['deepseek-review']);
    const responseA = await request(tokenA, { model: 'deepseek-review', messages: [] });
    const responseB = await request(tokenB, { model: 'deepseek-review', messages: [] });
    const readerA = responseA.body!.getReader();
    const readerB = responseB.body!.getReader();
    await Promise.all([readerA.read(), readerB.read()]);

    await runtime.INFERENCE.revoke({ jobId: 'runtime-sibling-a' });
    await release();
    await Promise.all([drain(readerA), drain(readerB)]);

    await expect(runtime.INFERENCE.usage({ jobId: 'runtime-sibling-a' })).resolves.toMatchObject({
      models: [{ requests: 1, incompleteRequests: 1 }],
    });
    await expect(runtime.INFERENCE.usage({ jobId: 'runtime-sibling-b' })).resolves.toMatchObject({
      models: [{ requests: 1, incompleteRequests: 0, inputTokens: { total: 10 } }],
    });
  });

  it('revokes while the upstream is still waiting for response headers', async () => {
    await control('wait-headers');
    const token = await issue('runtime-wait-headers', ['deepseek-review']);
    const pending = request(token, { model: 'deepseek-review', messages: [] });
    await waitFor(async () => (await upstreamState()).waitingHeaders >= 1);
    await runtime.INFERENCE.revoke({ jobId: 'runtime-wait-headers' });
    await release();
    const response = await pending;
    expect(response.status).toBe(200);
    await response.text();

    await expect(runtime.INFERENCE.usage({ jobId: 'runtime-wait-headers' })).resolves.toMatchObject(
      {
        models: [{ requests: 1, incompleteRequests: 1, model: null }],
      },
    );
  });

  it('denies admission when revoke lands during a slow request upload', async () => {
    await control('success');
    const token = await issue('runtime-slow-upload', ['deepseek-review']);
    const encoder = new TextEncoder();
    let releaseBody!: () => void;
    const bodyGate = new Promise<void>((resolve) => {
      releaseBody = resolve;
    });
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    let firstPull = true;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"model":"deepseek-review",'));
      },
      async pull(controller) {
        if (firstPull) {
          firstPull = false;
          signalStarted();
        }
        await bodyGate;
        controller.enqueue(encoder.encode('"messages":[]}'));
        controller.close();
      },
    });
    const pending = runtime.INFERENCE.fetch(
      new Request('https://inference.internal/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body,
      }),
    );
    await started;
    await runtime.INFERENCE.revoke({ jobId: 'runtime-slow-upload' });
    releaseBody();
    const response = await pending;
    expect(response.status).toBe(401);
    expect((await upstreamState()).requests).toHaveLength(0);
  });

  it('tears down a request waiting on headers at local expiry without hanging', async () => {
    await control('wait-headers');
    const token = await issue('runtime-header-expiry', ['deepseek-review']);
    await runtime.RELAY_DB.prepare('UPDATE grants SET expires_at = ? WHERE job_id = ?')
      .bind(Date.now() + 250, 'runtime-header-expiry')
      .run();
    const response = await request(token, { model: 'deepseek-review', messages: [] });
    expect(response.status).toBe(502);
    await release();
    await runtime.INFERENCE.revoke({ jobId: 'runtime-header-expiry' });
    await expect(
      runtime.INFERENCE.usage({ jobId: 'runtime-header-expiry' }),
    ).resolves.toMatchObject({
      models: [{ requests: 1, incompleteRequests: 1 }],
    });
  });
});

describe('Inference Worker usage retention', () => {
  it('returns null for an unknown job and for a tombstone', async () => {
    await expect(runtime.INFERENCE.usage({ jobId: 'runtime-absent' })).resolves.toBeNull();
    await runtime.INFERENCE.revoke({ jobId: 'runtime-tombstone' });
    await expect(runtime.INFERENCE.usage({ jobId: 'runtime-tombstone' })).resolves.toBeNull();
  });

  it('sweeps expired grants and their request rows in bounded batches', async () => {
    await control('success');
    const token = await issue('runtime-sweep', ['deepseek-review']);
    const response = await request(token, { model: 'deepseek-review', messages: [] });
    await response.text();

    await runtime.RELAY_DB.prepare('UPDATE grants SET expires_at = ? WHERE job_id = ?')
      .bind((await d1Now()) - 2 * 24 * 60 * 60 * 1000, 'runtime-sweep')
      .run();
    await expect(runtime.INFERENCE.sweep()).resolves.toBeGreaterThanOrEqual(1);
    await expect(runtime.INFERENCE.usage({ jobId: 'runtime-sweep' })).resolves.toBeNull();
    const rows = await runtime.RELAY_DB.prepare(
      'SELECT COUNT(*) AS count FROM inference_requests WHERE job_id = ?',
    )
      .bind('runtime-sweep')
      .first<{ readonly count: number }>();
    expect(rows?.count).toBe(0);
  });

  it('keeps active and recently expired grants while removing only beyond-retention state', async () => {
    await control('success');
    for (const jobId of [
      'runtime-retain-active',
      'runtime-retain-recent',
      'runtime-retain-stale',
    ]) {
      const token = await issue(jobId, ['deepseek-review']);
      const response = await request(token, { model: 'deepseek-review', messages: [] });
      expect(response.status).toBe(200);
      await response.text();
    }

    const now = await d1Now();
    const retention = 24 * 60 * 60 * 1000;
    const setExpiry = (jobId: string, expiresAt: number) =>
      runtime.RELAY_DB.prepare('UPDATE grants SET expires_at = ? WHERE job_id = ?')
        .bind(expiresAt, jobId)
        .run();
    await setExpiry('runtime-retain-active', now + 60_000);
    await setExpiry('runtime-retain-recent', now - 60_000);
    await setExpiry('runtime-retain-stale', now - retention - 60_000);

    await expect(runtime.INFERENCE.sweep()).resolves.toBeGreaterThanOrEqual(1);

    const expectSurvivor = async (jobId: string) => {
      const summary = await runtime.INFERENCE.usage({ jobId });
      expect(summary?.models).toHaveLength(1);
      expect(summary?.models[0]).toMatchObject({
        route: 'deepseek-review',
        requests: 1,
        incompleteRequests: 0,
        inputTokens: { total: 10, reportedRequests: 1 },
      });
    };
    await expectSurvivor('runtime-retain-active');
    await expectSurvivor('runtime-retain-recent');
    await expect(runtime.INFERENCE.usage({ jobId: 'runtime-retain-stale' })).resolves.toBeNull();

    const staleRequests = await runtime.RELAY_DB.prepare(
      'SELECT COUNT(*) AS count FROM inference_requests WHERE job_id = ?',
    )
      .bind('runtime-retain-stale')
      .first<{ readonly count: number }>();
    expect(staleRequests?.count).toBe(0);
    const staleGrants = await runtime.RELAY_DB.prepare(
      'SELECT COUNT(*) AS count FROM grants WHERE job_id = ?',
    )
      .bind('runtime-retain-stale')
      .first<{ readonly count: number }>();
    expect(staleGrants?.count).toBe(0);
  });

  it('runs the retention sweep through the scheduled handler', async () => {
    await control('success');
    const token = await issue('runtime-scheduled', ['deepseek-review']);
    const response = await request(token, { model: 'deepseek-review', messages: [] });
    await response.text();

    await runtime.RELAY_DB.prepare('UPDATE grants SET expires_at = ? WHERE job_id = ?')
      .bind((await d1Now()) - 2 * 24 * 60 * 60 * 1000, 'runtime-scheduled')
      .run();
    await expect(runtime.INFERENCE.scheduled()).resolves.toBeUndefined();
    await expect(runtime.INFERENCE.usage({ jobId: 'runtime-scheduled' })).resolves.toBeNull();
  });
});

it('discovers provider models through the private relay binding on a scheduled refresh', async () => {
  await runtime.INFERENCE.refreshCatalog(Date.parse('2026-11-18T00:00:00Z'));
  expect(await runtime.INFERENCE.catalog()).toMatchObject({
    routes: expect.arrayContaining(['sample/tool-model']),
    rejected: 0,
    lastRefreshError: null,
  });
});

it('serves a claimed model through application control, managed inference, and durable usage across workers', async () => {
  const environment = {
    REVIEW_DB: runtime.REVIEW_DB,
    INFERENCE_RELAY: runtime.INFERENCE,
    RELAY_DEFAULT_MODEL_ROUTE: 'sample/tool-model',
    GITHUB_APP_ID: '1',
    GITHUB_APP_PRIVATE_KEY: 'unused',
    ALLOWED_INSTALLATION_IDS: '[7]',
    WEBHOOK_SECRET: 'unused',
    RUNNER_CALLBACK_TOKEN: 'test-runner',
  };
  const app = () =>
    createApplication(environment, {
      github: {
        getRepositoryUrl: async () => 'https://github.com/example/reviewed.git',
        loadReviewTarget: async () => ({ headSha: 'b'.repeat(40) }),
      },
      getReadInstallationToken: async () => ({
        token: 'read-only-test',
        expiresAt: '2099-01-01T00:00:00Z',
      }),
    });
  const post = (path: string, payload: unknown) =>
    app().fetch(
      new Request('https://app.example' + path, {
        method: 'POST',
        headers: { authorization: 'Bearer test-runner', 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }),
    );
  await control('success');
  await runtime.INFERENCE.refreshCatalog(Date.now());
  await createD1ReviewStateStore(runtime.REVIEW_DB, 'sample/tool-model').claimReview({
    deliveryId: 'integrated-grant',
    occurredAt: '2026-11-18T00:00:00Z',
    job: {
      repositoryId: 1,
      installationId: 7,
      pullRequestNumber: 1,
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      trigger: 'automatic',
    },
  });
  await control('retire-model');
  await runtime.INFERENCE.refreshCatalog(Date.now() + 1);
  expect((await runtime.INFERENCE.catalog()).routes).toEqual([
    'sample/common',
    'sample/replacement',
  ]);
  const claimed = await post('/runner-claim', {});
  expect(claimed.status).toBe(200);
  const claim = (await claimed.json()) as {
    id: string;
    runId: string;
    attempt: number;
    reviewConfiguration: { selection: { reviewers: string[] } };
  };
  const routes = claim.reviewConfiguration.selection.reviewers;
  const issued = await post('/runner-llm/issue', {
    jobId: claim.id,
    runId: claim.runId,
    attempt: claim.attempt,
    routes,
  });
  expect(issued.status).toBe(201);
  const { token } = (await issued.json()) as { token: string };
  const inference = () =>
    runtime.INFERENCE.fetch(
      new Request('https://inference.example/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify({ model: routes[0], messages: [{ role: 'user', content: 'test' }] }),
      }),
    );
  const result = await inference();
  expect(result.status).toBe(200);
  expect(await result.text()).toContain('[DONE]');
  expect((await post('/runner-llm/revoke', { jobId: claim.id })).status).toBe(204);
  expect((await inference()).status).toBe(401);
  const usage = await post('/runner-llm/usage', { jobId: claim.id });
  expect(await usage.json()).toMatchObject({
    models: [{ route: 'sample/tool-model', requests: 1, incompleteRequests: 0 }],
  });
});
