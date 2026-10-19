import { expect, it, vi } from 'vitest';
import { createPiUpstream } from '../apps/llm-service/src/upstream';

it('streams native Chat Completions through the configured model and upstream credential', async () => {
  const upstream = createPiUpstream({
    routes: [
      {
        id: 'review',
        provider: 'openai-compatible',
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
      expect(body.store).toBe(false);
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
      store: false,
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
        provider: 'openai-compatible',
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
    { store: true },
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
        provider: 'openai-compatible',
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
        provider: 'openai-codex',
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
        provider: 'openai-compatible',
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
        provider: 'openai-compatible',
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
          provider: 'openai-codex',
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

it.each(['', 'data: [DONE]\n\n'])(
  'records incomplete stream diagnostics without content even with terminator %j',
  async (terminator) => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const upstream = createPiUpstream({
        routes: [
          {
            id: 'review',
            provider: 'openai-compatible',
            protocol: 'chat-completions',
            model: 'test-model',
            baseUrl: 'https://provider.invalid/v1',
          },
        ],
        credential: async () => 'credential-canary',
        fetch: async () =>
          new Response(
            'data: {"choices":[{"index":0,"delta":{"content":"response-canary"},"finish_reason":null}]}\n\n' +
              terminator,
            { headers: { 'content-type': 'text/event-stream' } },
          ),
      });
      const response = await upstream(
        'review',
        { model: 'review', stream: true, messages: [{ role: 'user', content: 'prompt-canary' }] },
        new AbortController().signal,
        'job-diagnostic',
      );
      await expect(response.text()).rejects.toThrow('model stream failed');
      const output = JSON.stringify(logs.mock.calls);
      expect(output).toContain('llm.request.finished');
      expect(output).toContain('job-diagnostic');
      expect(output).toContain('incomplete-stream');
      expect(output).toContain('receivedBytes');
      expect(output).toContain('requestId');
      for (const secret of ['credential-canary', 'response-canary', 'prompt-canary'])
        expect(output).not.toContain(secret);
    } finally {
      logs.mockRestore();
    }
  },
);

it.each([
  [
    'completed',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    200,
  ],
  ['upstream-error-event', 'event: error\ndata: {"message":"private-error-canary"}\n\n', 200],
  ['upstream-http-error', 'private-error-canary', 429],
  ['invalid-stream', 'data: not-json-private-error-canary\n\n', 200],
] as const)('distinguishes %s in terminal diagnostics', async (outcome, wire, status) => {
  const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    const upstream = createPiUpstream({
      routes: [
        {
          id: 'review',
          provider: 'openai-compatible',
          protocol: 'chat-completions',
          model: 'model',
          baseUrl: 'https://provider.invalid/v1',
        },
      ],
      credential: async () => 'secret',
      fetch: async () =>
        new Response(wire, { status, headers: { 'content-type': 'text/event-stream' } }),
    });
    const response = await upstream(
      'review',
      { model: 'review', stream: true, messages: [] },
      new AbortController().signal,
      'job-classification',
    );
    if (outcome === 'completed') await expect(response.text()).resolves.toContain('[DONE]');
    else if (status !== 200) expect(response.status).toBe(502);
    else await expect(response.text()).rejects.toThrow('model stream failed');
    const finished = logs.mock.calls.filter((call) => call.includes('llm.request.finished'));
    expect(finished).toHaveLength(1);
    expect(finished[0]?.[2]).toMatchObject({
      jobId: 'job-classification',
      outcome,
      upstreamStatus: status,
    });
    expect(JSON.stringify(logs.mock.calls)).not.toContain('private-error-canary');
  } finally {
    logs.mockRestore();
  }
});

it('distinguishes the provider SDK abort from an upstream network failure', async () => {
  vi.useFakeTimers();
  const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    const upstream = createPiUpstream({
      routes: [
        {
          id: 'review',
          provider: 'openai-compatible',
          protocol: 'chat-completions',
          model: 'model',
          baseUrl: 'https://provider.invalid/v1',
        },
      ],
      credential: async () => 'secret',
      fetch: async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('private-error-canary')), {
            once: true,
          });
        }),
    });
    const pending = upstream(
      'review',
      { model: 'review', stream: true, messages: [] },
      new AbortController().signal,
      'job-timeout',
    );
    await vi.advanceTimersByTimeAsync(120001);
    expect((await pending).status).toBe(502);
    const output = JSON.stringify(logs.mock.calls);
    expect(output).toContain('provider-request-aborted');
    expect(output).not.toContain('private-error-canary');
  } finally {
    logs.mockRestore();
    vi.useRealTimers();
  }
});

it.each(['client-cancelled', 'request-aborted', 'upstream-stream-error'] as const)(
  'identifies %s after response headers without leaking transport errors',
  async (outcome) => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      let source: ReadableStreamDefaultController<Uint8Array> | undefined;
      const controller = new AbortController();
      const upstream = createPiUpstream({
        routes: [
          {
            id: 'review',
            provider: 'openai-compatible',
            protocol: 'chat-completions',
            model: 'model',
            baseUrl: 'https://provider.invalid/v1',
          },
        ],
        credential: async () => 'secret',
        fetch: async (_url, init) =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(target) {
                source = target;
                target.enqueue(
                  new TextEncoder().encode(
                    'data: {"choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}\n\n',
                  ),
                );
                init?.signal?.addEventListener(
                  'abort',
                  () => {
                    try {
                      target.error(new Error('transport-secret'));
                    } catch {
                      /* Already closed by cancellation. */
                    }
                  },
                  { once: true },
                );
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          ),
      });
      const response = await upstream(
        'review',
        { model: 'review', stream: true, messages: [] },
        controller.signal,
        'job-stream-end',
      );
      const reader = response.body!.getReader();
      expect((await reader.read()).done).toBe(false);
      if (outcome === 'client-cancelled') await reader.cancel();
      else {
        if (outcome === 'request-aborted') controller.abort();
        else source!.error(new Error('transport-secret'));
        await expect(reader.read()).rejects.toThrow('model stream failed');
      }
      const finished = logs.mock.calls.filter((call) => call.includes('llm.request.finished'));
      expect(finished).toHaveLength(1);
      expect(finished[0]?.[2]).toMatchObject({
        outcome,
        upstreamStatus: 200,
        jobId: 'job-stream-end',
      });
      expect(JSON.stringify(logs.mock.calls)).not.toContain('transport-secret');
    } finally {
      logs.mockRestore();
    }
  },
);

it('records the service deadline when its own timeout signal aborts', async () => {
  vi.useFakeTimers();
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((delay) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('deadline', 'TimeoutError')), delay);
    return controller.signal;
  });
  const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    const upstream = createPiUpstream({
      routes: [
        {
          id: 'review',
          provider: 'openai-compatible',
          protocol: 'chat-completions',
          model: 'model',
          baseUrl: 'https://provider.invalid/v1',
        },
      ],
      credential: async () => 'secret',
      fetch: async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('private-error')), {
            once: true,
          });
        }),
    });
    const pending = upstream(
      'review',
      { model: 'review', stream: true, messages: [] },
      new AbortController().signal,
      'job-service-timeout',
    );
    await vi.advanceTimersByTimeAsync(120001);
    expect((await pending).status).toBe(502);
    const finished = logs.mock.calls.filter((call) => call.includes('llm.request.finished'));
    expect(finished).toHaveLength(1);
    expect(finished[0]?.[2]).toMatchObject({
      outcome: 'service-timeout',
      jobId: 'job-service-timeout',
    });
  } finally {
    logs.mockRestore();
    timeout.mockRestore();
    vi.useRealTimers();
  }
});
