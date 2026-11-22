/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { describe, expect, it } from 'vitest';
import { geminiRouteHandle } from '../../apps/inference-worker/src/gemini';
import {
  control,
  geminiRoute,
  issueGrant,
  messagesRoute,
  post,
  runtime,
  upstreamState,
} from './inference-protocol-helpers';

const geminiBody = () => ({
  contents: [{ role: 'user', parts: [{ text: 'Review this change' }] }],
  systemInstruction: { parts: [{ text: 'Review this change' }] },
  tools: [
    {
      functionDeclarations: [
        {
          name: 'read',
          description: 'Read a repository file',
          parametersJsonSchema: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
      ],
    },
  ],
  generationConfig: { maxOutputTokens: 32000 },
});

const geminiContinuation = () => {
  const base = geminiBody();
  return {
    ...base,
    contents: [
      ...base.contents,
      {
        role: 'model',
        parts: [
          { text: 'I will inspect the readme.', thought: true },
          {
            functionCall: { name: 'read', args: { path: 'src/example.ts' } },
            thoughtSignature: 'c3ludGhldGljLXNpZ25hdHVyZQ==',
          },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'read',
              response: { name: 'read', content: 'README contents' },
            },
          },
        ],
      },
    ],
  };
};

const geminiPath = (handle: string) => `/v1beta/models/${handle}:streamGenerateContent?alt=sse`;

describe('Gemini public workerd route', () => {
  it('selects the opaque handler, relays the typed upstream path and records usage', async () => {
    await control('gemini-success');
    const token = await issueGrant('gemini-success', [geminiRoute]);
    const handle = geminiRouteHandle(geminiRoute.routeId);

    const response = await post(token, geminiPath(handle), geminiBody(), {
      'x-goog-api-key': 'synthetic-client-placeholder-must-not-forward',
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const text = await response.text();
    expect(text).toContain('Reviewed by ');
    expect(text).toContain('Gemini');

    const state = await upstreamState();
    expect(state.requests).toHaveLength(1);
    const upstream = state.requests[0]!;
    expect(upstream.url).toBe(
      'https://gateway.ai.cloudflare.com/v1/test-account/test-gateway/custom-review-provider/models/gemini-native:streamGenerateContent?alt=sse',
    );
    expect(upstream.headers['cf-aig-authorization']).toBe('Bearer test-run-token');
    expect(upstream.headers['cf-aig-byok-alias']).toBe('review-alias');
    expect(upstream.headers.authorization).toBeUndefined();
    expect(upstream.headers['x-goog-api-key']).toBeUndefined();
    const body = JSON.parse(upstream.body) as Record<string, unknown>;
    expect(body).not.toHaveProperty('model');
    expect(body.contents).toEqual(geminiBody().contents);
    expect(body.tools).toEqual(geminiBody().tools);

    await expect(runtime.INFERENCE.usage({ jobId: 'gemini-success' })).resolves.toEqual({
      version: 1,
      models: [
        {
          route: geminiRoute.routeId,
          model: 'gemini-native',
          requests: 1,
          incompleteRequests: 0,
          inputTokens: { total: 19, reportedRequests: 1 },
          uncachedInputTokens: { total: 12, reportedRequests: 1 },
          cacheReadTokens: { total: 7, reportedRequests: 1 },
          cacheWriteTokens: null,
          outputTokens: { total: 10, reportedRequests: 1 },
          reasoningTokens: { total: 2, reportedRequests: 1 },
        },
      ],
    });
    await runtime.INFERENCE.revoke({ jobId: 'gemini-success' });
  });

  it('relays a signed thought signature and function response continuation', async () => {
    await control('gemini-tool');
    const token = await issueGrant('gemini-tool', [geminiRoute]);
    const handle = geminiRouteHandle(geminiRoute.routeId);

    const first = await post(token, geminiPath(handle), geminiBody());
    expect(first.status).toBe(200);
    expect(await first.text()).toContain('functionCall');

    const second = await post(token, geminiPath(handle), geminiContinuation());
    expect(second.status).toBe(200);
    expect(await second.text()).toContain('Reviewed by ');

    const state = await upstreamState();
    expect(state.requests).toHaveLength(2);
    expect(state.requests[1]!.body).toContain('thoughtSignature');
    expect(state.requests[1]!.body).toContain('c3ludGhldGljLXNpZ25hdHVyZQ==');
    expect(state.requests[1]!.body).toContain('functionResponse');
    await runtime.INFERENCE.revoke({ jobId: 'gemini-tool' });
  });

  it('fails closed for MAX_TOKENS and blocked finishes with partial usage', async () => {
    await control('gemini-max-tokens');
    const token = await issueGrant('gemini-max', [geminiRoute]);
    const handle = geminiRouteHandle(geminiRoute.routeId);
    const response = await post(token, geminiPath(handle), geminiBody());
    expect(response.status).toBe(200);
    await expect(response.text()).rejects.toThrow();

    await expect(runtime.INFERENCE.usage({ jobId: 'gemini-max' })).resolves.toMatchObject({
      models: [
        {
          requests: 1,
          incompleteRequests: 1,
          inputTokens: { total: 19 },
          cacheReadTokens: { total: 2 },
          outputTokens: { total: 3 },
        },
      ],
    });

    await control('gemini-blocked');
    const blocked = await issueGrant('gemini-blocked', [geminiRoute]);
    const blockedResponse = await post(blocked, geminiPath(handle), geminiBody());
    await expect(blockedResponse.text()).rejects.toThrow();
    await runtime.INFERENCE.revoke({ jobId: 'gemini-max' });
    await runtime.INFERENCE.revoke({ jobId: 'gemini-blocked' });
  });

  it('accepts only the v1beta streaming path and a granted Gemini profile', async () => {
    await control('gemini-success');
    const token = await issueGrant('gemini-denied', [geminiRoute, messagesRoute]);
    const handle = geminiRouteHandle(geminiRoute.routeId);

    expect(
      (await post(token, `/v1/models/${handle}:streamGenerateContent`, geminiBody())).status,
    ).toBe(404);
    expect((await post(token, geminiPath('r-unknown'), geminiBody())).status).toBe(403);
    expect(
      (await post(token, geminiPath(geminiRouteHandle(messagesRoute.routeId)), geminiBody()))
        .status,
    ).toBe(403);
    expect(
      (
        await post(token, geminiPath(handle), {
          ...geminiBody(),
          cachedContent: 'cachedContents/1',
        })
      ).status,
    ).toBe(400);
    expect((await upstreamState()).requests).toHaveLength(0);
    await runtime.INFERENCE.revoke({ jobId: 'gemini-denied' });
  });
});
