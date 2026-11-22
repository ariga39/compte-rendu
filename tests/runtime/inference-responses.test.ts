/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type {
  D1DatabaseLike,
  IssueGrantInput,
  IssueGrantResult,
  RevokeGrantInput,
  RevokeGrantResult,
} from '../../apps/inference-worker/src/grants';
import type { ModelUsageSummary } from '../../packages/contracts/src';
import type { RelayCatalogSnapshot } from '../../apps/inference-worker/src/catalog';
import type { D1DatabaseLike as ReviewDb } from '../../apps/core/src/review-state-store';
import { MAX_RESPONSES_TERMINAL_BYTES } from '../../apps/inference-worker/src/responses';
import { responsesSecondTurnFixture } from '../fixtures/responses-second-turn';
import { responsesMultipartToolOutputFixture } from '../fixtures/responses-multipart';

interface InferenceBinding {
  catalog(): Promise<RelayCatalogSnapshot>;
  refreshCatalog(at: number): Promise<void>;
  fetch(request: Request): Promise<Response>;
  issueV2(input: IssueGrantInput): Promise<IssueGrantResult>;
  revoke(input: RevokeGrantInput): Promise<RevokeGrantResult>;
  usage(input: { jobId: string }): Promise<ModelUsageSummary | null>;
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

const d1Now = async () => {
  const row = await runtime.RELAY_DB.prepare(
    "SELECT CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER) AS now",
  ).first<{ readonly now: number }>();
  if (row === null) throw new Error('missing D1 clock');
  return row.now;
};

const control = async (scenario: string, extra: Record<string, unknown> = {}) => {
  const response = await runtime.UPSTREAM.fetch(
    new Request('https://upstream.internal/__control', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenario, ...extra }),
    }),
  );
  expect(response.status).toBe(200);
};

const upstreamState = async (): Promise<UpstreamState> => {
  const response = await runtime.UPSTREAM.fetch(new Request('https://upstream.internal/__state'));
  return (await response.json()) as UpstreamState;
};

const questions = {
  responses: {
    routeId: 'sol-review',
    upstreamModel: 'gpt-sol-native',
    providerSlug: 'responses-provider',
    credentialAlias: 'openai-byok',
    profile: 'responses',
  },
  chat: {
    routeId: 'deepseek-review',
    upstreamModel: 'deepseek-native',
    providerSlug: 'review-provider',
    credentialAlias: 'review-alias',
  },
} as const;

const issueGrant = async (
  jobId: string,
  routes: readonly (typeof questions)[keyof typeof questions][],
) => {
  for (const route of routes) {
    await runtime.RELAY_DB.prepare(
      'INSERT OR IGNORE INTO catalog_routes(route_id, upstream_model, provider_slug, credential_alias, profile) VALUES(?,?,?,?,?)',
    )
      .bind(
        route.routeId,
        route.upstreamModel,
        route.providerSlug,
        route.credentialAlias,
        'profile' in route ? route.profile : 'chat',
      )
      .run();
  }
  const result = await runtime.INFERENCE.issueV2({
    jobId,
    snapshot: { routes: routes.map((r) => r.routeId) },
    latestIssueDeadline: (await d1Now()) + 60_000,
  });
  if (result.kind !== 'issued') throw new Error('expected profiled grant');
  return result.token;
};

const post = (token: string, path: string, body: Record<string, unknown>) =>
  runtime.INFERENCE.fetch(
    new Request(`https://inference.internal${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }),
  );

const drainUntilFailure = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
    }
  } catch {
    // Expected: the relay sanitizes the stream failure.
  }
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
};

const readUntilFailure = async (response: Response) =>
  drainUntilFailure(response.body!.getReader());

const responsesBody = () => ({
  model: questions.responses.routeId,
  instructions: 'Review this change',
  input: [
    {
      role: 'user',
      content: [{ type: 'input_text', text: 'Review this change' }],
    },
    {
      type: 'reasoning',
      id: 'rs_1',
      encrypted_content: 'encrypted-reasoning',
      summary: [],
    },
    {
      type: 'function_call',
      id: 'fc_1',
      call_id: 'call_1',
      name: 'read_file',
      arguments: '{"path":"src/app.ts"}',
    },
    { type: 'function_call_output', call_id: 'call_1', output: 'file contents' },
  ],
  tools: [
    {
      type: 'function',
      name: 'read_file',
      description: 'Read a repository file',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    },
  ],
  include: ['reasoning.encrypted_content'],
  text: { format: { type: 'text' } },
  prompt_cache_key: 'review-cache',
  reasoning: { effort: 'high' },
  max_output_tokens: 1024,
  stream: true,
  store: false,
});

describe('Responses route authentication and native streaming', () => {
  it('streams a frozen Responses route and records terminal usage', async () => {
    await control('responses-success');
    const token = await issueGrant('responses-success', [questions.responses]);

    const response = await post(token, '/v1/responses', responsesBody());

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const text = await response.text();
    expect(text).toContain('event: response.output_text.delta');
    expect(text).toContain('event: response.completed');
    expect(text).not.toContain('[DONE]');

    const state = await upstreamState();
    expect(state.requests).toHaveLength(1);
    const upstream = state.requests[0]!;
    expect(upstream.url).toBe(
      'https://gateway.ai.cloudflare.com/v1/test-account/test-gateway/custom-responses-provider/responses',
    );
    expect(upstream.headers['cf-aig-authorization']).toBe('Bearer test-run-token');
    expect(upstream.headers['cf-aig-byok-alias']).toBe('openai-byok');
    expect(upstream.headers.authorization).toBeUndefined();
    const body = JSON.parse(upstream.body) as Record<string, unknown>;
    expect(body.model).toBe('gpt-sol-native');
    expect(body.stream).toBe(true);
    expect(body.store).toBe(false);
    expect(body.tools).toEqual(responsesBody().tools);
    expect(body.include).toEqual(['reasoning.encrypted_content']);
    expect(body.input).toEqual(responsesBody().input);

    await expect(runtime.INFERENCE.usage({ jobId: 'responses-success' })).resolves.toEqual({
      version: 1,
      models: [
        {
          route: 'sol-review',
          model: 'gpt-sol-native',
          requests: 1,
          incompleteRequests: 0,
          inputTokens: { total: 20, reportedRequests: 1 },
          uncachedInputTokens: { total: 12, reportedRequests: 1 },
          cacheReadTokens: { total: 8, reportedRequests: 1 },
          cacheWriteTokens: null,
          outputTokens: { total: 10, reportedRequests: 1 },
          reasoningTokens: { total: 4, reportedRequests: 1 },
        },
      ],
    });
  });

  it.each([
    { verbosity: 'low' },
    { format: { type: 'text' }, verbosity: 'medium' },
    { verbosity: 'high' },
  ])('forwards Responses text options %j unchanged', async (text) => {
    await control('responses-success');
    const token = await issueGrant('sol-verbosity-' + text.verbosity, [questions.responses]);
    const response = await post(token, '/v1/responses', { ...responsesBody(), text });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('event: response.completed');
    const [upstream] = (await upstreamState()).requests;
    expect(JSON.parse(upstream!.body).text).toEqual(text);
  });

  it('rejects unsupported Responses state, hosted tools and transport shapes at admission', async () => {
    await control('responses-success');
    const token = await issueGrant('responses-rejections', [questions.responses]);
    const base = responsesBody();
    const invalid: readonly [string, Record<string, unknown>][] = [
      ['unknown field', { ...base, temperature: 0.2 }],
      ['unknown verbosity', { ...base, text: { verbosity: 'verbose' } }],
      ['previous response lookup', { ...base, previous_response_id: 'resp_1' }],
      ['server conversation', { ...base, conversation: 'conv_1' }],
      ['background work', { ...base, background: true }],
      ['automatic truncation', { ...base, truncation: 'auto' }],
      ['non-streaming', { ...base, stream: false }],
      ['stored response', { ...base, store: true }],
      ['unsupported include', { ...base, include: ['message.output_text.logprobs'] }],
      [
        'structured text format',
        { ...base, text: { format: { type: 'json_schema', name: 'review', schema: {} } } },
      ],
      ['unsupported reasoning effort', { ...base, reasoning: { effort: 'extreme' } }],
      ['oversized output cap', { ...base, max_output_tokens: 256_001 }],
      ['hosted web search', { ...base, tools: [{ type: 'web_search_preview' }] }],
      [
        'hosted file search',
        { ...base, tools: [{ type: 'file_search', vector_store_ids: ['vs_1'] }] },
      ],
      ['item reference', { ...base, input: [{ type: 'item_reference', id: 'msg_1' }] }],
      [
        'hosted computer call',
        {
          ...base,
          input: [{ type: 'computer_call', call_id: 'call_1', action: { type: 'click' } }],
        },
      ],
      [
        'remote image content',
        {
          ...base,
          input: [
            {
              role: 'user',
              content: [{ type: 'input_image', image_url: 'https://remote.example/image.png' }],
            },
          ],
        },
      ],
      [
        'provider file content',
        {
          ...base,
          input: [{ role: 'user', content: [{ type: 'input_file', file_id: 'file_1' }] }],
        },
      ],
      [
        'media in tool output array',
        {
          ...base,
          input: [
            {
              type: 'function_call_output',
              call_id: 'call_1',
              output: [
                {
                  type: 'input_image',
                  image_url: 'https://remote.example/image.png',
                },
              ],
            },
          ],
        },
      ],
      [
        'file in tool output array',
        {
          ...base,
          input: [
            {
              type: 'function_call_output',
              call_id: 'call_1',
              output: [{ type: 'input_file', file_id: 'file_1' }],
            },
          ],
        },
      ],
      [
        'output text part in tool output array',
        {
          ...base,
          input: [
            {
              type: 'function_call_output',
              call_id: 'call_1',
              output: [{ type: 'output_text', text: 'contents' }],
            },
          ],
        },
      ],
      [
        'phase on user message',
        {
          ...base,
          input: [{ role: 'user', phase: 'commentary', content: 'Review this change' }],
        },
      ],
      [
        'unsupported assistant phase',
        {
          ...base,
          input: [
            {
              role: 'assistant',
              phase: 'thinking',
              content: [{ type: 'output_text', text: 'Reviewing' }],
            },
          ],
        },
      ],

      [
        'reasoning replay without id',
        {
          ...base,
          input: [{ type: 'reasoning', encrypted_content: 'encrypted-reasoning' }],
        },
      ],
      [
        'unknown nested message field',
        {
          ...base,
          input: [
            {
              role: 'user',
              content: [{ type: 'input_text', text: 'review', image_url: 'https://remote' }],
            },
          ],
        },
      ],
      [
        'unknown nested tool field',
        {
          ...base,
          tools: [{ type: 'function', name: 'read_file', parameters: {}, hosted: true }],
        },
      ],
    ];

    for (const [name, body] of invalid) {
      const response = await post(token, '/v1/responses', body);
      expect(response.status, name).toBe(400);
    }
    expect((await upstreamState()).requests).toHaveLength(0);
  });

  it('forwards multipart shell output and assistant phases unchanged', async () => {
    await control('responses-success');
    const token = await issueGrant('responses-multipart', [questions.responses]);

    const response = await post(token, '/v1/responses', {
      ...responsesBody(),
      input: responsesMultipartToolOutputFixture,
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('event: response.completed');
    const upstream = (await upstreamState()).requests[0]!;
    expect((JSON.parse(upstream.body) as { input: unknown }).input).toEqual(
      responsesMultipartToolOutputFixture,
    );
  });

  it('accepts inline output-message and reasoning replay shapes from a second tool turn', async () => {
    await control('responses-success');
    const token = await issueGrant('responses-replay-shapes', [questions.responses]);
    const body = {
      ...responsesBody(),
      input: [
        { role: 'user', content: 'Review this change' },
        {
          id: 'msg_out_1',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'I will read it', annotations: [] }],
        },
        {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'read_file',
          arguments: '{"path":"src/app.ts"}',
          status: 'completed',
        },
        { type: 'function_call_output', call_id: 'call_1', output: 'file contents' },
        { type: 'reasoning', id: 'rs_1', encrypted_content: 'encrypted-reasoning' },
      ],
    };

    const response = await post(token, '/v1/responses', body);
    expect(response.status).toBe(200);
    const upstream = (await upstreamState()).requests[0]!;
    expect((JSON.parse(upstream.body) as { input: unknown }).input).toEqual(body.input);
  });

  it('records partial usage and withholds successful completion for incomplete or failed turns', async () => {
    const cases = [
      {
        scenario: 'responses-incomplete',
        jobId: 'responses-incomplete',
        model: 'gpt-sol-native',
        input: 100,
        cached: 20,
        output: 7,
        reasoning: 2,
      },
      {
        scenario: 'responses-failed',
        jobId: 'responses-failed',
        model: 'gpt-sol-native',
        input: 50,
        cached: 0,
        output: 1,
        reasoning: 0,
      },
    ] as const;
    for (const item of cases) {
      await control(item.scenario);
      const token = await issueGrant(item.jobId, [questions.responses]);
      const response = await post(token, '/v1/responses', responsesBody());
      expect(response.status).toBe(200);
      await expect(response.text()).rejects.toThrow();
      await expect(runtime.INFERENCE.usage({ jobId: item.jobId })).resolves.toMatchObject({
        models: [
          {
            route: 'sol-review',
            model: item.model,
            requests: 1,
            incompleteRequests: 1,
            inputTokens: { total: item.input, reportedRequests: 1 },
            cacheReadTokens: { total: item.cached, reportedRequests: 1 },
            outputTokens: { total: item.output, reportedRequests: 1 },
            reasoningTokens: { total: item.reasoning, reportedRequests: 1 },
          },
        ],
      });
    }
  });

  it('sanitizes error events and upstream HTTP failures while retaining partial rows', async () => {
    await control('responses-error-event');
    const errorToken = await issueGrant('responses-error-event', [questions.responses]);
    const errorResponse = await post(errorToken, '/v1/responses', responsesBody());
    expect(errorResponse.status).toBe(200);
    await expect(errorResponse.text()).rejects.toThrow();
    await expect(
      runtime.INFERENCE.usage({ jobId: 'responses-error-event' }),
    ).resolves.toMatchObject({
      models: [{ requests: 1, incompleteRequests: 1, model: null, inputTokens: null }],
    });

    await control('error');
    const httpToken = await issueGrant('responses-http-error', [questions.responses]);
    const httpResponse = await post(httpToken, '/v1/responses', responsesBody());
    expect(httpResponse.status).toBe(429);
    expect(httpResponse.headers.get('x-private')).toBeNull();
    const text = await httpResponse.text();
    expect(text).not.toContain('private upstream diagnostic');
    expect(JSON.parse(text)).toEqual({ error: { message: 'model request failed' } });
    await expect(runtime.INFERENCE.usage({ jobId: 'responses-http-error' })).resolves.toMatchObject(
      { models: [{ requests: 1, incompleteRequests: 1, model: null }] },
    );
  });

  it('records a complete turn with unknown usage and preserves observed model identity', async () => {
    await control('responses-missing-usage');
    const token = await issueGrant('responses-missing-usage', [questions.responses]);
    const response = await post(token, '/v1/responses', responsesBody());
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('event: response.completed');
    await expect(runtime.INFERENCE.usage({ jobId: 'responses-missing-usage' })).resolves.toEqual({
      version: 1,
      models: [
        {
          route: 'sol-review',
          model: 'gpt-sol-native',
          requests: 1,
          incompleteRequests: 0,
          inputTokens: null,
          uncachedInputTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          outputTokens: null,
          reasoningTokens: null,
        },
      ],
    });
  });

  it('bounds the one held terminal event above 64 KiB and at its byte ceiling', async () => {
    await control('responses-terminal-size', { terminalBytes: 70 * 1024 });
    const largeToken = await issueGrant('responses-large-terminal', [questions.responses]);
    const large = await post(largeToken, '/v1/responses', responsesBody());
    expect(large.status).toBe(200);
    const largeText = await large.text();
    expect(largeText).toContain('event: response.completed');
    expect(new TextEncoder().encode(largeText).byteLength).toBeGreaterThan(64 * 1024);
    await expect(
      runtime.INFERENCE.usage({ jobId: 'responses-large-terminal' }),
    ).resolves.toMatchObject({ models: [{ incompleteRequests: 0, inputTokens: { total: 20 } }] });

    await control('responses-terminal-size', { terminalBytes: MAX_RESPONSES_TERMINAL_BYTES });
    const limitToken = await issueGrant('responses-limit-terminal', [questions.responses]);
    const limit = await post(limitToken, '/v1/responses', responsesBody());
    expect(limit.status).toBe(200);
    expect(await limit.text()).toContain('event: response.completed');

    await control('responses-terminal-size', {
      terminalBytes: MAX_RESPONSES_TERMINAL_BYTES + 1,
    });
    const overToken = await issueGrant('responses-over-terminal', [questions.responses]);
    const over = await post(overToken, '/v1/responses', responsesBody());
    expect(over.status).toBe(200);
    await expect(over.text()).rejects.toThrow();
    await expect(
      runtime.INFERENCE.usage({ jobId: 'responses-over-terminal' }),
    ).resolves.toMatchObject({
      models: [
        {
          requests: 1,
          incompleteRequests: 1,
          inputTokens: { total: 20, reportedRequests: 1 },
          outputTokens: { total: 10, reportedRequests: 1 },
        },
      ],
    });
  });

  it('round-trips UTF-8 split inside a code point and a premature EOF as incomplete', async () => {
    await control('responses-utf8-split');
    const token = await issueGrant('responses-utf8', [questions.responses]);
    const response = await post(token, '/v1/responses', responsesBody());
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('审查通过');
    await expect(runtime.INFERENCE.usage({ jobId: 'responses-utf8' })).resolves.toMatchObject({
      models: [{ incompleteRequests: 0, inputTokens: { total: 20 } }],
    });

    await control('responses-eof');
    const eofToken = await issueGrant('responses-eof', [questions.responses]);
    const eof = await post(eofToken, '/v1/responses', responsesBody());
    expect(eof.status).toBe(200);
    await expect(eof.text()).rejects.toThrow();
    await expect(runtime.INFERENCE.usage({ jobId: 'responses-eof' })).resolves.toMatchObject({
      models: [{ requests: 1, incompleteRequests: 1, inputTokens: null }],
    });
  });

  it('cancels an abandoned Responses stream and seals its partial row', async () => {
    await control('responses-hold');
    const token = await issueGrant('responses-disconnect', [questions.responses]);
    const aborter = new AbortController();
    const response = await runtime.INFERENCE.fetch(
      new Request('https://inference.internal/v1/responses', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify(responsesBody()),
        signal: aborter.signal,
      }),
    );
    const reader = response.body!.getReader();
    await reader.read();
    aborter.abort();
    await expect(reader.read()).rejects.toThrow();
    await expect(new Promise<void>((resolve) => setTimeout(resolve, 50))).resolves.toBeUndefined();

    await expect(runtime.INFERENCE.usage({ jobId: 'responses-disconnect' })).resolves.toMatchObject(
      { models: [{ requests: 1, incompleteRequests: 1 }] },
    );
  });

  it('cancels a Responses stream at local grant expiry', async () => {
    await control('responses-hold');
    const token = await issueGrant('responses-expiry', [questions.responses]);
    await runtime.RELAY_DB.prepare('UPDATE grants SET expires_at = ? WHERE job_id = ?')
      .bind(Date.now() + 250, 'responses-expiry')
      .run();

    const response = await post(token, '/v1/responses', responsesBody());
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    await reader.read();
    await expect(reader.read()).rejects.toThrow();
    await expect(runtime.INFERENCE.usage({ jobId: 'responses-expiry' })).resolves.toMatchObject({
      models: [{ requests: 1, incompleteRequests: 1 }],
    });
  });

  it('keeps a sibling Responses job complete when another job is revoked midstream', async () => {
    await control('responses-hold');
    const tokenA = await issueGrant('responses-sibling-a', [questions.responses]);
    const tokenB = await issueGrant('responses-sibling-b', [questions.responses]);
    const responseA = await post(tokenA, '/v1/responses', responsesBody());
    const responseB = await post(tokenB, '/v1/responses', responsesBody());
    const readerA = responseA.body!.getReader();
    const readerB = responseB.body!.getReader();
    await Promise.all([readerA.read(), readerB.read()]);

    await runtime.INFERENCE.revoke({ jobId: 'responses-sibling-a' });
    await runtime.UPSTREAM.fetch(
      new Request('https://upstream.internal/__release', { method: 'POST' }),
    );
    const drain = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) return;
        }
      } catch {
        return;
      }
    };
    await Promise.all([drain(readerA), drain(readerB)]);

    await expect(runtime.INFERENCE.usage({ jobId: 'responses-sibling-a' })).resolves.toMatchObject({
      models: [{ requests: 1, incompleteRequests: 1 }],
    });
    await expect(runtime.INFERENCE.usage({ jobId: 'responses-sibling-b' })).resolves.toMatchObject({
      models: [{ requests: 1, incompleteRequests: 0, inputTokens: { total: 20 } }],
    });
  });

  it('accepts a sanitized second-round capture from pinned OpenCode v2.0.32', async () => {
    await control('responses-success');
    const token = await issueGrant('responses-pinned-replay', [questions.responses]);

    const response = await post(
      token,
      '/v1/responses',
      responsesSecondTurnFixture as unknown as Record<string, unknown>,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('event: response.completed');

    const upstream = (await upstreamState()).requests[0]!;
    const body = JSON.parse(upstream.body) as Record<string, unknown>;
    expect(body.model).toBe('gpt-sol-native');
    expect(body.input).toEqual(responsesSecondTurnFixture.input);
    expect(body.tools).toEqual(responsesSecondTurnFixture.tools);
    expect(body.include).toEqual(['reasoning.encrypted_content']);
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    expect(
      (responsesSecondTurnFixture.input as readonly { readonly type?: string }[]).map(
        (item) => item.type ?? 'message',
      ),
    ).toEqual(['message', 'reasoning', 'function_call', 'function_call_output']);
  });

  it('never completes on mismatched or status-only terminal frames, including EOF', async () => {
    const scenarios = [
      ['responses-mismatched-terminal', 'responses-mismatched-terminal'],
      ['responses-status-only-completed', 'responses-status-only-completed'],
      ['responses-embedded-error', 'responses-embedded-error'],
      ['responses-eof', 'responses-nonterminal-eof'],
    ] as const;
    for (const [scenario, jobId] of scenarios) {
      await control(scenario);
      const token = await issueGrant(jobId, [questions.responses]);
      const response = await post(token, '/v1/responses', responsesBody());
      expect(response.status).toBe(200);
      const text = await readUntilFailure(response);
      expect(text).not.toContain('event: response.completed');
      await expect(runtime.INFERENCE.usage({ jobId })).resolves.toMatchObject({
        models: [{ requests: 1, incompleteRequests: 1 }],
      });
      const complete = await runtime.RELAY_DB.prepare(
        'SELECT COUNT(*) AS count FROM inference_requests WHERE job_id = ? AND status = ?',
      )
        .bind(jobId, 'complete')
        .first<{ readonly count: number }>();
      expect(complete?.count).toBe(0);
    }
  });

  it('withholds response.completed after a revoke seals the pending row midstream', async () => {
    await control('responses-hold');
    const token = await issueGrant('responses-revoke-midstream', [questions.responses]);
    const response = await post(token, '/v1/responses', responsesBody());
    const reader = response.body!.getReader();
    await reader.read();

    await runtime.INFERENCE.revoke({ jobId: 'responses-revoke-midstream' });
    await runtime.UPSTREAM.fetch(
      new Request('https://upstream.internal/__release', { method: 'POST' }),
    );
    const text = await drainUntilFailure(reader);
    expect(text).not.toContain('event: response.completed');

    await expect(
      runtime.INFERENCE.usage({ jobId: 'responses-revoke-midstream' }),
    ).resolves.toMatchObject({ models: [{ requests: 1, incompleteRequests: 1 }] });
    const complete = await runtime.RELAY_DB.prepare(
      'SELECT COUNT(*) AS count FROM inference_requests WHERE job_id = ? AND status = ?',
    )
      .bind('responses-revoke-midstream', 'complete')
      .first<{ readonly count: number }>();
    expect(complete?.count).toBe(0);
  });

  it('bounds an unterminated no-newline frame before the parser buffers it whole', async () => {
    await control('responses-unterminated-frame', {
      unterminatedBytes: MAX_RESPONSES_TERMINAL_BYTES + 70 * 1024,
    });
    const token = await issueGrant('responses-unterminated-frame', [questions.responses]);
    const response = await post(token, '/v1/responses', responsesBody());
    expect(response.status).toBe(200);
    await expect(readUntilFailure(response)).resolves.not.toContain('event: response.completed');
    await expect(
      runtime.INFERENCE.usage({ jobId: 'responses-unterminated-frame' }),
    ).resolves.toMatchObject({ models: [{ requests: 1, incompleteRequests: 1 }] });
  });

  it('rejects the wrong protocol for a frozen route before contacting upstream', async () => {
    await control('responses-success');
    const token = await issueGrant('responses-wrong-protocol', [
      questions.responses,
      questions.chat,
    ]);

    const responsesOnChat = await post(token, '/v1/responses', {
      ...responsesBody(),
      model: questions.chat.routeId,
    });
    expect(responsesOnChat.status).toBe(403);

    const chatOnResponses = await post(token, '/v1/chat/completions', {
      model: questions.responses.routeId,
      messages: [],
    });
    expect(chatOnResponses.status).toBe(403);

    const ungranted = await post(token, '/v1/responses', {
      ...responsesBody(),
      model: 'not-granted',
    });
    expect(ungranted.status).toBe(403);

    expect((await upstreamState()).requests).toHaveLength(0);
  });
});
