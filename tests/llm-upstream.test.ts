import { expect, it } from 'vitest';
import { createPiUpstream } from '../apps/llm-service/src/upstream';

it('streams native Chat Completions through the configured model and upstream credential', async () => {
  const upstream = createPiUpstream({
    routes: [
      {
        id: 'review',
        protocol: 'chat-completions',
        model: 'deepseek-flash',
        baseUrl: 'https://provider.invalid/v1',
      },
    ],
    credential: async () => 'upstream-secret',
    fetch: async (url, init) => {
      expect(url instanceof Request ? url.url : url.toString()).toBe(
        'https://provider.invalid/v1/chat/completions',
      );
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer upstream-secret');
      if (typeof init?.body !== 'string') throw new Error('expected JSON body');
      const body = JSON.parse(init.body);
      expect(body.model).toBe('deepseek-flash');
      expect(body.messages).toEqual([{ role: 'user', content: 'Review this change' }]);
      return new Response(
        'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"Looks good"},"finish_reason":null}]}\n\ndata: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const response = await upstream(
    'review',
    {
      model: 'review',
      stream: true,
      messages: [{ role: 'user', content: 'Review this change' }],
    },
    new AbortController().signal,
  );
  expect(response.status).toBe(200);
  expect(await response.text()).toContain('Looks good');
});

it('rejects unsupported or server-executed tools before sending a provider request', async () => {
  const upstream = createPiUpstream({
    routes: [
      {
        id: 'review',
        protocol: 'chat-completions',
        model: 'deepseek-flash',
        baseUrl: 'https://provider.invalid/v1',
      },
    ],
    credential: async () => 'secret',
    fetch: async () => {
      throw new Error('must not reach upstream');
    },
  });
  for (const extra of [
    { stream: false },
    { base_url: 'https://evil.invalid' },
    { tools: [{ type: 'web_search' }] },
  ]) {
    const response = await upstream(
      'review',
      {
        model: 'review',
        stream: true,
        messages: [{ role: 'user', content: 'Hi' }],
        ...extra,
      },
      new AbortController().signal,
    );
    expect(response.status).toBe(400);
  }
});

it('does not report a truncated upstream stream as successful completion', async () => {
  const upstream = createPiUpstream({
    routes: [
      {
        id: 'review',
        protocol: 'chat-completions',
        model: 'deepseek-flash',
        baseUrl: 'https://provider.invalid/v1',
      },
    ],
    credential: async () => 'secret',
    fetch: async () =>
      new Response(
        'data: {"choices":[{"index":0,"delta":{"content":"Partial"},"finish_reason":null}]}\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  });
  const response = await upstream(
    'review',
    { model: 'review', stream: true, messages: [] },
    new AbortController().signal,
  );
  await expect(response.text()).rejects.toThrow('model stream failed');
});

it('preserves native Responses events for subscription clients', async () => {
  const credential =
    'header.' +
    Buffer.from(
      JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'test-account' } }),
    ).toString('base64url') +
    '.signature';
  const wire =
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-test","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n';
  const upstream = createPiUpstream({
    routes: [
      {
        id: 'subscription',
        protocol: 'codex-responses',
        model: 'gpt-6.1-sol',
        baseUrl: 'https://chatgpt.com/backend-api',
      },
    ],
    credential: async () => credential,
    fetch: async (url, init) => {
      expect(url instanceof Request ? url.url : url.toString()).toBe(
        'https://chatgpt.com/backend-api/codex/responses',
      );
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ' + credential);
      return new Response(wire, { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const response = await upstream(
    'subscription',
    { model: 'subscription', stream: true, input: [], store: false },
    new AbortController().signal,
  );
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(wire);
});

it('cancels the upstream request when a client abandons the stream', async () => {
  let observedSignal: AbortSignal | null = null;
  const request = createPiUpstream({
    routes: [
      {
        id: 'review',
        protocol: 'chat-completions',
        model: 'deepseek-flash',
        baseUrl: 'https://provider.invalid/v1',
      },
    ],
    credential: async () => 'secret',
    fetch: async (_url, init) => {
      observedSignal = init?.signal ?? null;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"choices":[{"index":0,"delta":{"content":"Partial"},"finish_reason":null}]}\n\n',
              ),
            );
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const response = await request(
    'review',
    { model: 'review', stream: true, messages: [] },
    new AbortController().signal,
  );
  const reader = response.body!.getReader();
  await reader.read();
  await reader.cancel();
  expect(observedSignal).toHaveProperty('aborted', true);
});

it('does not forward raw upstream error events to the sandbox', async () => {
  const request = createPiUpstream({
    routes: [
      {
        id: 'review',
        protocol: 'chat-completions',
        model: 'deepseek-flash',
        baseUrl: 'https://provider.invalid/v1',
      },
    ],
    credential: async () => 'secret',
    fetch: async () =>
      new Response('data: {"error":{"message":"private upstream diagnostic"}}\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      }),
  });
  const response = await request(
    'review',
    { model: 'review', stream: true, messages: [] },
    new AbortController().signal,
  );
  await expect(response.body!.getReader().read()).rejects.toThrow('model stream failed');
});

it.each(['error', 'response.failed'])(
  'rejects a subscription SSE %s event independently of JSON fields',
  async (event) => {
    const access =
      'header.' +
      Buffer.from(
        JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'test-account' } }),
      ).toString('base64url') +
      '.signature';
    const request = createPiUpstream({
      routes: [
        {
          id: 'subscription',
          protocol: 'codex-responses',
          model: 'gpt-6.1-sol',
          baseUrl: 'https://chatgpt.com/backend-api',
        },
      ],
      credential: async () => access,
      fetch: async () =>
        new Response(`event: ${event}\ndata: {"message":"private upstream diagnostic"}\n\n`, {
          headers: { 'content-type': 'text/event-stream' },
        }),
    });
    const response = await request(
      'subscription',
      { model: 'subscription', stream: true, input: [], store: false },
      new AbortController().signal,
    );
    await expect(response.body!.getReader().read()).rejects.toThrow('model stream failed');
  },
);
