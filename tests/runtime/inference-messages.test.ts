/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { describe, expect, it } from 'vitest';
import {
  control,
  geminiRoute,
  issueGrant,
  legacyChatRoute,
  messagesRoute,
  post,
  runtime,
  upstreamState,
} from './inference-protocol-helpers';

const messagesBody = () => ({
  model: messagesRoute.routeId,
  system: [
    {
      type: 'text',
      text: 'Review this change',
      cache_control: { type: 'ephemeral' },
    },
  ],
  messages: [
    {
      role: 'user',
      content: [{ type: 'text', text: 'Review this change', cache_control: { type: 'ephemeral' } }],
    },
  ],
  tools: [
    {
      name: 'read',
      description: 'Read a repository file',
      input_schema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
      cache_control: { type: 'ephemeral' },
    },
  ],
  stream: true,
  max_tokens: 32000,
});

const messagesContinuation = () => {
  const base = messagesBody();
  return {
    ...base,
    messages: [
      ...base.messages,
      {
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            thinking: 'Need to inspect the readme.',
            signature: 'synthetic-signature-messages',
          },
          {
            type: 'tool_use',
            id: 'toolu_synthetic',
            name: 'read',
            input: { path: 'src/example.ts' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_synthetic',
            content: 'README contents',
            cache_control: { type: 'ephemeral' },
          },
        ],
      },
    ],
  };
};

describe('Messages public workerd route', () => {
  it('authenticates, admits a local-tool turn, relays safe Gateway headers and records usage', async () => {
    await control('messages-success');
    const token = await issueGrant('messages-success', [messagesRoute]);

    const response = await post(token, '/v1/messages?beta=true', messagesBody(), {
      'x-api-key': 'client-side-placeholder-must-not-forward',
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const text = await response.text();
    expect(text).toContain('event: message_stop');
    expect(text).toContain('Reviewed by Messages');

    const state = await upstreamState();
    expect(state.requests).toHaveLength(1);
    const upstream = state.requests[0]!;
    expect(upstream.url).toBe(
      'https://gateway.ai.cloudflare.com/v1/test-account/test-gateway/custom-review-provider/messages',
    );
    expect(upstream.headers['cf-aig-authorization']).toBe('Bearer test-run-token');
    expect(upstream.headers['cf-aig-byok-alias']).toBe('review-alias');
    expect(upstream.headers['anthropic-version']).toBe('2023-06-01');
    expect(upstream.headers.authorization).toBeUndefined();
    expect(upstream.headers['x-api-key']).toBeUndefined();
    const body = JSON.parse(upstream.body) as Record<string, unknown>;
    expect(body.model).toBe('claude-native');
    expect(body.stream).toBe(true);
    expect(body.messages).toEqual(messagesBody().messages);
    expect(body.tools).toEqual(messagesBody().tools);

    await expect(runtime.INFERENCE.usage({ jobId: 'messages-success' })).resolves.toEqual({
      version: 1,
      models: [
        {
          route: messagesRoute.routeId,
          model: 'claude-native',
          requests: 1,
          incompleteRequests: 0,
          inputTokens: { total: 24, reportedRequests: 1 },
          uncachedInputTokens: { total: 19, reportedRequests: 1 },
          cacheReadTokens: { total: 5, reportedRequests: 1 },
          cacheWriteTokens: { total: 2, reportedRequests: 1 },
          outputTokens: { total: 11, reportedRequests: 1 },
          reasoningTokens: null,
        },
      ],
    });
    await runtime.INFERENCE.revoke({ jobId: 'messages-success' });
  });

  it('relays a signed thinking/tool continuation without rewriting local tool data', async () => {
    await control('messages-tool');
    const token = await issueGrant('messages-tool', [messagesRoute]);

    const first = await post(token, '/v1/messages?beta=true', messagesBody());
    expect(first.status).toBe(200);
    expect(await first.text()).toContain('event: content_block_start');

    const second = await post(token, '/v1/messages?beta=true', messagesContinuation());
    expect(second.status).toBe(200);
    expect(await second.text()).toContain('Reviewed by Messages');

    const state = await upstreamState();
    expect(state.requests).toHaveLength(2);
    const continuation = JSON.parse(state.requests[1]!.body) as {
      readonly messages: readonly unknown[];
    };
    expect(continuation.messages).toEqual(messagesContinuation().messages);
    expect(state.requests[1]!.body).toContain('synthetic-signature-messages');
    expect(state.requests[1]!.body).toContain('tool_result');
    await runtime.INFERENCE.revoke({ jobId: 'messages-tool' });
  });

  it('fails closed with partial usage for max_tokens and upstream error events', async () => {
    await control('messages-max-tokens');
    const token = await issueGrant('messages-max', [messagesRoute]);
    const response = await post(token, '/v1/messages?beta=true', messagesBody());
    expect(response.status).toBe(200);
    await expect(response.text()).rejects.toThrow();

    await expect(runtime.INFERENCE.usage({ jobId: 'messages-max' })).resolves.toMatchObject({
      models: [
        {
          requests: 1,
          incompleteRequests: 1,
          inputTokens: { total: 19 },
          cacheReadTokens: { total: 2 },
          outputTokens: { total: 11 },
        },
      ],
    });

    await control('messages-error');
    const errored = await issueGrant('messages-error', [messagesRoute]);
    const failed = await post(errored, '/v1/messages?beta=true', messagesBody());
    expect(failed.status).toBe(200);
    await expect(failed.text()).rejects.toThrow();
    await runtime.INFERENCE.revoke({ jobId: 'messages-max' });
    await runtime.INFERENCE.revoke({ jobId: 'messages-error' });
  });

  it('does not complete on message_stop without a successful stop reason', async () => {
    await control('messages-missing-stop');
    const token = await issueGrant('messages-missing-stop', [messagesRoute]);
    const response = await post(token, '/v1/messages?beta=true', messagesBody());
    expect(response.status).toBe(200);
    await expect(response.text()).rejects.toThrow();
    await expect(
      runtime.INFERENCE.usage({ jobId: 'messages-missing-stop' }),
    ).resolves.toMatchObject({
      models: [{ incompleteRequests: 1, inputTokens: { total: 19 } }],
    });
    await runtime.INFERENCE.revoke({ jobId: 'messages-missing-stop' });
  });

  it('isolates terminal state between requests', async () => {
    await control('messages-max-tokens');
    const first = await issueGrant('messages-state-first', [messagesRoute]);
    await expect(
      (await post(first, '/v1/messages?beta=true', messagesBody())).text(),
    ).rejects.toThrow();

    await control('messages-success');
    const second = await issueGrant('messages-state-second', [messagesRoute]);
    const response = await post(second, '/v1/messages?beta=true', messagesBody());
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('event: message_stop');
    await runtime.INFERENCE.revoke({ jobId: 'messages-state-first' });
    await runtime.INFERENCE.revoke({ jobId: 'messages-state-second' });
  });

  it('rejects wrong profiles, unknown routes, invalid bodies and missing grants before upstream', async () => {
    await control('messages-success');
    const token = await issueGrant('messages-denied', [geminiRoute, legacyChatRoute]);
    expect((await post(token, '/v1/messages', messagesBody())).status).toBe(403);

    const silent = messagesBody();
    expect(
      (await post(token, '/v1/messages', { ...silent, messages: [], max_tokens: 0 })).status,
    ).toBe(400);
    expect(
      (await post(token, '/v1/messages', { ...silent, container: 'container_1' })).status,
    ).toBe(400);
    expect((await post('not-a-valid-token', '/v1/messages', silent)).status).toBe(401);
    expect((await upstreamState()).requests).toHaveLength(0);
    await runtime.INFERENCE.revoke({ jobId: 'messages-denied' });
  });
});
