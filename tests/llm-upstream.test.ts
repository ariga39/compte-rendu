import { zstdDecompressSync } from 'node:zlib';
import { expect, it, vi } from 'vitest';
import { createPiUpstream } from '../apps/llm-service/src/upstream';

const decodeProviderBody = (body: unknown): Record<string, unknown> => {
  if (typeof body === 'string') return JSON.parse(body) as Record<string, unknown>;
  if (body instanceof Uint8Array)
    return JSON.parse(new TextDecoder().decode(zstdDecompressSync(body))) as Record<
      string,
      unknown
    >;
  throw new Error('unexpected provider body');
};

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

it('converts Chat Completions history and tools into the provider request', async () => {
  let captured: Record<string, unknown> | undefined;
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
    fetch: async (_url, init) => {
      if (typeof init?.body !== 'string') throw new Error('expected JSON body');
      captured = JSON.parse(init.body) as Record<string, unknown>;
      return new Response(
        'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
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
      temperature: 0.2,
      top_p: 0.9,
      messages: [
        { role: 'system', content: 'You review.' },
        { role: 'user', content: 'Review this change' },
        {
          role: 'assistant',
          content: null,
          reasoning_content: 'Checked the changed lines before choosing this tool.',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'submit_review', arguments: '{"decision":"approve"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', name: 'submit_review', content: 'ok' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'submit_review',
            description: 'Submit',
            parameters: {
              type: 'object',
              properties: { decision: { type: 'string' } },
              required: ['decision'],
              additionalProperties: false,
            },
            strict: true,
          },
        },
      ],
    },
    new AbortController().signal,
  );
  await expect(response.text()).resolves.toContain('ok');
  const request = captured as Record<string, any>;
  expect(request.model).toBe('deepseek-flash');
  expect(request.store).toBe(false);
  expect(request.temperature).toBe(0.2);
  expect(request.top_p).toBe(0.9);
  expect(request.stream_options).toEqual({ include_usage: true });
  expect(request).not.toHaveProperty('max_tokens');
  expect(request).not.toHaveProperty('max_completion_tokens');
  expect(request.messages[0]).toMatchObject({ role: 'system', content: 'You review.' });
  expect(request.messages[1]).toEqual({ role: 'user', content: 'Review this change' });
  expect(request.messages[2].reasoning_content).toBe(
    'Checked the changed lines before choosing this tool.',
  );
  expect(request.messages[2].tool_calls).toEqual([
    {
      id: 'call_1',
      type: 'function',
      function: { name: 'submit_review', arguments: '{"decision":"approve"}' },
    },
  ]);
  expect(request.messages[3]).toMatchObject({
    role: 'tool',
    tool_call_id: 'call_1',
    content: 'ok',
  });
  expect(request.tools[0]).toMatchObject({
    type: 'function',
    function: {
      name: 'submit_review',
      strict: true,
      parameters: {
        type: 'object',
        properties: { decision: { type: 'string' } },
        required: ['decision'],
        additionalProperties: false,
      },
    },
  });
});

it('rejects malformed or unsupported Chat Completions semantics before upstream', async () => {
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
    fetch: async () => {
      throw new Error('must not reach upstream');
    },
  });
  for (const body of [
    {
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'c', type: 'function', function: { name: 'x', arguments: 'not-json' } },
          ],
        },
      ],
    },
    { messages: [{ role: 'alien', content: 'x' }] },
    { messages: [{ role: 'tool', tool_call_id: 'missing', content: 'x' }] },
    { messages: [{ role: 'user', content: [{ type: 'audio', data: 'x' }] }] },
  ]) {
    const response = await upstream(
      'review',
      { model: 'review', stream: true, ...body },
      new AbortController().signal,
    );
    expect(response.status).toBe(400);
  }
});

it('converts Responses input and tools, preserving function call ids and outputs', async () => {
  let captured: Record<string, unknown> | undefined;
  const credential =
    'header.' +
    Buffer.from(
      JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'test-account' } }),
    ).toString('base64url') +
    '.signature';
  const wire =
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-1","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n';
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
    fetch: async (_url, init) => {
      captured = decodeProviderBody(init?.body);
      return new Response(wire, { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const response = await upstream(
    'subscription',
    {
      model: 'subscription',
      stream: true,
      store: false,
      instructions: 'Review carefully.',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Review this change' }],
        },
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'submit_review',
          arguments: '{"decision":"approve"}',
        },
        { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
      ],
      tools: [
        {
          type: 'function',
          name: 'submit_review',
          description: 'Submit',
          parameters: {
            type: 'object',
            properties: { decision: { type: 'string' } },
            required: ['decision'],
            additionalProperties: false,
          },
        },
      ],
    },
    new AbortController().signal,
  );
  await expect(response.text()).resolves.toBe(wire);
  const request = captured as Record<string, any>;
  expect(request.instructions).toBe('Review carefully.');
  expect(request.store).toBe(false);
  expect(request).not.toHaveProperty('max_output_tokens');
  expect(request.input).toEqual([
    { role: 'user', content: [{ type: 'input_text', text: 'Review this change' }] },
    {
      type: 'function_call',
      call_id: 'call_1',
      name: 'submit_review',
      arguments: '{"decision":"approve"}',
    },
    { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
  ]);
  expect(request.tools[0]).toMatchObject({ type: 'function', name: 'submit_review' });
});

it('preserves Responses custom grammar tools and their call history', async () => {
  let captured: Record<string, unknown> | undefined;
  const credential =
    'header.' +
    Buffer.from(
      JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'test-account' } }),
    ).toString('base64url') +
    '.signature';
  const wire =
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-1","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n';
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
    fetch: async (_url, init) => {
      captured = decodeProviderBody(init?.body);
      return new Response(wire, { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const response = await upstream(
    'subscription',
    {
      model: 'subscription',
      stream: true,
      store: false,
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run' }] },
        { type: 'custom_tool_call', call_id: 'c1', name: 'run_code', input: 'print(1)' },
        { type: 'custom_tool_call_output', call_id: 'c1', output: '1' },
      ],
      tools: [
        {
          type: 'custom',
          name: 'run_code',
          description: 'Run',
          format: { type: 'grammar', syntax: 'lark', definition: 'start: /.+/' },
        },
      ],
    },
    new AbortController().signal,
  );
  await expect(response.text()).resolves.toBe(wire);
  const request = captured as Record<string, any>;
  expect(request.tools[0]).toMatchObject({
    type: 'custom',
    name: 'run_code',
    format: { type: 'grammar', syntax: 'lark', definition: 'start: /.+/' },
  });
  expect(request.input).toEqual([
    { role: 'user', content: [{ type: 'input_text', text: 'run' }] },
    { type: 'custom_tool_call', call_id: 'c1', name: 'run_code', input: 'print(1)' },
    { type: 'custom_tool_call_output', call_id: 'c1', output: '1' },
  ]);
});

it('rejects unsupported Responses input items before upstream', async () => {
  const credential =
    'header.' +
    Buffer.from(
      JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'test-account' } }),
    ).toString('base64url') +
    '.signature';
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
    fetch: async () => {
      throw new Error('must not reach upstream');
    },
  });
  const response = await upstream(
    'subscription',
    { model: 'subscription', stream: true, store: false, input: [{ type: 'mystery' }] },
    new AbortController().signal,
  );
  expect(response.status).toBe(400);
});

it('replays encrypted reasoning and pairs function call item ids with their outputs', async () => {
  let captured: Record<string, unknown> | undefined;
  const credential =
    'header.' +
    Buffer.from(
      JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'test-account' } }),
    ).toString('base64url') +
    '.signature';
  const wire =
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-1","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n';
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
    fetch: async (_url, init) => {
      captured = decodeProviderBody(init?.body);
      return new Response(wire, { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const response = await upstream(
    'subscription',
    {
      model: 'subscription',
      stream: true,
      store: false,
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Review' }] },
        { type: 'reasoning', id: 'rs_1', encrypted_content: 'encrypted-reasoning', summary: [] },
        {
          type: 'function_call',
          call_id: 'call_1',
          id: 'fc_item_1',
          name: 'submit_review',
          arguments: '{"decision":"approve"}',
        },
        { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
      ],
      tools: [
        {
          type: 'function',
          name: 'submit_review',
          description: 'Submit',
          parameters: { type: 'object', properties: { decision: { type: 'string' } } },
        },
      ],
    },
    new AbortController().signal,
  );
  await expect(response.text()).resolves.toBe(wire);
  const request = captured as Record<string, any>;
  expect(request.input).toEqual([
    { role: 'user', content: [{ type: 'input_text', text: 'Review' }] },
    { type: 'reasoning', id: 'rs_1', encrypted_content: 'encrypted-reasoning', summary: [] },
    {
      type: 'function_call',
      call_id: 'call_1',
      id: 'fc_item_1',
      name: 'submit_review',
      arguments: '{"decision":"approve"}',
    },
    { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
  ]);
});

it('preserves custom tool call ctc_ item ids when replaying grammar tool history', async () => {
  let captured: Record<string, unknown> | undefined;
  const credential =
    'header.' +
    Buffer.from(
      JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'test-account' } }),
    ).toString('base64url') +
    '.signature';
  const wire =
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-1","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n';
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
    fetch: async (_url, init) => {
      captured = decodeProviderBody(init?.body);
      return new Response(wire, { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const response = await upstream(
    'subscription',
    {
      model: 'subscription',
      stream: true,
      store: false,
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run' }] },
        {
          type: 'custom_tool_call',
          call_id: 'c1',
          id: 'ctc_1',
          name: 'run_code',
          input: 'print(1)',
        },
        { type: 'custom_tool_call_output', call_id: 'c1', output: '1' },
      ],
      tools: [
        {
          type: 'custom',
          name: 'run_code',
          description: 'Run',
          format: { type: 'grammar', syntax: 'lark', definition: 'start: /.+/' },
        },
      ],
    },
    new AbortController().signal,
  );
  await expect(response.text()).resolves.toBe(wire);
  const request = captured as Record<string, any>;
  expect(request.input).toEqual([
    { role: 'user', content: [{ type: 'input_text', text: 'run' }] },
    { type: 'custom_tool_call', call_id: 'c1', id: 'ctc_1', name: 'run_code', input: 'print(1)' },
    { type: 'custom_tool_call_output', call_id: 'c1', output: '1' },
  ]);
});

it('preserves assistant message item id and phase when replaying text', async () => {
  let captured: Record<string, unknown> | undefined;
  const credential =
    'header.' +
    Buffer.from(
      JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'test-account' } }),
    ).toString('base64url') +
    '.signature';
  const wire =
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-1","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n';
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
    fetch: async (_url, init) => {
      captured = decodeProviderBody(init?.body);
      return new Response(wire, { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const response = await upstream(
    'subscription',
    {
      model: 'subscription',
      stream: true,
      store: false,
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Review' }] },
        {
          type: 'message',
          role: 'assistant',
          id: 'msg_1',
          phase: 'final_answer',
          content: [{ type: 'output_text', text: 'Looks good' }],
        },
      ],
    },
    new AbortController().signal,
  );
  await expect(response.text()).resolves.toBe(wire);
  const request = captured as Record<string, any>;
  expect(request.input).toEqual([
    { role: 'user', content: [{ type: 'input_text', text: 'Review' }] },
    {
      type: 'message',
      role: 'assistant',
      id: 'msg_1',
      phase: 'final_answer',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Looks good', annotations: [] }],
    },
  ]);
});

it('replays Chat reasoning_details and treats null reasoning_content as absent', async () => {
  let captured: Record<string, unknown> | undefined;
  const details = [
    {
      type: 'reasoning.encrypted',
      id: 'rs_1',
      data: 'encrypted-detail',
      format: 'openai-responses-v1',
    },
  ];
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
    fetch: async (_url, init) => {
      if (typeof init?.body !== 'string') throw new Error('expected JSON body');
      captured = JSON.parse(init.body) as Record<string, unknown>;
      return new Response(
        'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
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
      messages: [
        { role: 'user', content: 'Review this change' },
        {
          role: 'assistant',
          content: 'Previous answer',
          reasoning_content: null,
          reasoning_details: details,
        },
        { role: 'user', content: 'Continue' },
      ],
    },
    new AbortController().signal,
  );
  await expect(response.text()).resolves.toContain('ok');
  const request = captured as Record<string, any>;
  expect(request.messages[1]).toEqual({
    role: 'assistant',
    content: 'Previous answer',
    reasoning_details: details,
  });
  expect(request.messages[1]).not.toHaveProperty('reasoning_content');
});

it('preserves explicit strict function tools in Responses payloads', async () => {
  let captured: Record<string, unknown> | undefined;
  const credential =
    'header.' +
    Buffer.from(
      JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'test-account' } }),
    ).toString('base64url') +
    '.signature';
  const wire =
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-1","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n';
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
    fetch: async (_url, init) => {
      captured = decodeProviderBody(init?.body);
      return new Response(wire, { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const response = await upstream(
    'subscription',
    {
      model: 'subscription',
      stream: true,
      store: false,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Review' }] }],
      tools: [
        {
          type: 'function',
          name: 'submit_review',
          description: 'Submit',
          strict: true,
          parameters: {
            type: 'object',
            properties: { decision: { type: 'string' } },
            required: ['decision'],
            additionalProperties: false,
          },
        },
      ],
    },
    new AbortController().signal,
  );
  await expect(response.text()).resolves.toBe(wire);
  const request = captured as Record<string, any>;
  expect(request.tools[0]).toMatchObject({ type: 'function', name: 'submit_review', strict: true });
});

it('preserves the explicit Chat max_tokens field in the provider payload', async () => {
  let captured: Record<string, unknown> | undefined;
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
    fetch: async (_url, init) => {
      if (typeof init?.body !== 'string') throw new Error('expected JSON body');
      captured = JSON.parse(init.body) as Record<string, unknown>;
      return new Response(
        'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
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
      max_tokens: 321,
      messages: [{ role: 'user', content: 'Review' }],
    },
    new AbortController().signal,
  );
  await expect(response.text()).resolves.toContain('ok');
  const request = captured as Record<string, unknown>;
  expect(request.max_tokens).toBe(321);
  expect(request).not.toHaveProperty('max_completion_tokens');
});

it('preserves an object tool_choice in the Responses payload', async () => {
  let captured: Record<string, unknown> | undefined;
  const credential =
    'header.' +
    Buffer.from(
      JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'test-account' } }),
    ).toString('base64url') +
    '.signature';
  const wire =
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-1","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n';
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
    fetch: async (_url, init) => {
      captured = decodeProviderBody(init?.body);
      return new Response(wire, { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const response = await upstream(
    'subscription',
    {
      model: 'subscription',
      stream: true,
      store: false,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Review' }] }],
      tools: [
        {
          type: 'function',
          name: 'submit_review',
          parameters: { type: 'object', properties: {} },
        },
      ],
      tool_choice: { type: 'function', name: 'submit_review' },
    },
    new AbortController().signal,
  );
  await expect(response.text()).resolves.toBe(wire);
  expect((captured as Record<string, unknown>).tool_choice).toEqual({
    type: 'function',
    name: 'submit_review',
  });
});

it('preserves native custom tool definitions and call items when no grammar is supplied', async () => {
  let captured: Record<string, unknown> | undefined;
  const credential =
    'header.' +
    Buffer.from(
      JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'test-account' } }),
    ).toString('base64url') +
    '.signature';
  const wire =
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-1","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n';
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
    fetch: async (_url, init) => {
      captured = decodeProviderBody(init?.body);
      return new Response(wire, { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const response = await upstream(
    'subscription',
    {
      model: 'subscription',
      stream: true,
      store: false,
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run' }] },
        {
          type: 'custom_tool_call',
          call_id: 'c1',
          id: 'ctc_1',
          name: 'run_code',
          input: 'print(1)',
        },
        { type: 'custom_tool_call_output', call_id: 'c1', output: '1' },
      ],
      tools: [{ type: 'custom', name: 'run_code', description: 'Run' }],
    },
    new AbortController().signal,
  );
  await expect(response.text()).resolves.toBe(wire);
  const request = captured as Record<string, any>;
  expect(request.tools[0]).toEqual({ type: 'custom', name: 'run_code', description: 'Run' });
  expect(request.input[1]).toEqual({
    type: 'custom_tool_call',
    call_id: 'c1',
    id: 'ctc_1',
    name: 'run_code',
    input: 'print(1)',
  });
  expect(request.input[2]).toEqual({
    type: 'custom_tool_call_output',
    call_id: 'c1',
    output: '1',
  });
});

it('preserves a supplied Responses prompt_cache_key', async () => {
  let captured: Record<string, unknown> | undefined;
  const credential =
    'header.' +
    Buffer.from(
      JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'test-account' } }),
    ).toString('base64url') +
    '.signature';
  const wire =
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-1","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n';
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
    fetch: async (_url, init) => {
      captured = decodeProviderBody(init?.body);
      return new Response(wire, { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const response = await upstream(
    'subscription',
    {
      model: 'subscription',
      stream: true,
      store: false,
      prompt_cache_key: 'client-cache-key',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Review' }] }],
    },
    new AbortController().signal,
  );
  await expect(response.text()).resolves.toBe(wire);
  expect((captured as Record<string, unknown>).prompt_cache_key).toBe('client-cache-key');
});

it('preserves supported inline Chat images in the provider payload', async () => {
  let captured: Record<string, unknown> | undefined;
  const image = 'data:image/png;base64,' + Buffer.from('image-bytes').toString('base64');
  const upstream = createPiUpstream({
    routes: [
      {
        id: 'review',
        provider: 'openai-compatible',
        protocol: 'chat-completions',
        model: 'vision-model',
        baseUrl: 'https://provider.invalid/v1',
      },
    ],
    credential: async () => 'secret',
    fetch: async (_url, init) => {
      if (typeof init?.body !== 'string') throw new Error('expected JSON body');
      captured = JSON.parse(init.body) as Record<string, unknown>;
      return new Response(
        'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
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
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this image' },
            { type: 'image_url', image_url: { url: image } },
          ],
        },
      ],
    },
    new AbortController().signal,
  );
  await expect(response.text()).resolves.toContain('ok');
  const request = captured as Record<string, any>;
  expect(request.messages[0].content).toEqual([
    { type: 'text', text: 'Describe this image' },
    { type: 'image_url', image_url: { url: image } },
  ]);
});

it('treats a null Chat reasoning_content as absent', async () => {
  let captured: Record<string, unknown> | undefined;
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
    fetch: async (_url, init) => {
      if (typeof init?.body !== 'string') throw new Error('expected JSON body');
      captured = JSON.parse(init.body) as Record<string, unknown>;
      return new Response(
        'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
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
      messages: [
        { role: 'user', content: 'Review this change' },
        { role: 'assistant', content: 'Previous answer', reasoning_content: null },
        { role: 'user', content: 'Continue' },
      ],
    },
    new AbortController().signal,
  );
  await expect(response.text()).resolves.toContain('ok');
  const request = captured as Record<string, any>;
  expect(request.messages[1]).toEqual({ role: 'assistant', content: 'Previous answer' });
});

it('retains empty signed reasoning items through replay', async () => {
  let captured: Record<string, unknown> | undefined;
  const credential =
    'header.' +
    Buffer.from(
      JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'test-account' } }),
    ).toString('base64url') +
    '.signature';
  const wire =
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-1","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n';
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
    fetch: async (_url, init) => {
      captured = decodeProviderBody(init?.body);
      return new Response(wire, { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const response = await upstream(
    'subscription',
    {
      model: 'subscription',
      stream: true,
      store: false,
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Review' }] },
        {
          type: 'reasoning',
          id: 'rs_empty',
          encrypted_content: 'opaque',
          summary: [],
          status: 'completed',
        },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done' }] },
      ],
    },
    new AbortController().signal,
  );
  await expect(response.text()).resolves.toBe(wire);
  const request = captured as Record<string, any>;
  expect(request.input).toEqual([
    { role: 'user', content: [{ type: 'input_text', text: 'Review' }] },
    {
      type: 'reasoning',
      id: 'rs_empty',
      encrypted_content: 'opaque',
      summary: [],
      status: 'completed',
    },
    {
      type: 'message',
      role: 'assistant',
      id: 'msg_pi_1',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Done', annotations: [] }],
    },
  ]);
});

it('preserves an explicit Chat max_completion_tokens field on a provider that prefers max_tokens', async () => {
  let captured: Record<string, unknown> | undefined;
  const upstream = createPiUpstream({
    routes: [
      {
        id: 'review',
        provider: 'openai-compatible',
        protocol: 'chat-completions',
        model: 'deepseek-flash',
        baseUrl: 'https://api.deepseek.com/v1',
      },
    ],
    credential: async () => 'secret',
    fetch: async (_url, init) => {
      if (typeof init?.body !== 'string') throw new Error('expected JSON body');
      captured = JSON.parse(init.body) as Record<string, unknown>;
      return new Response(
        'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
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
      max_completion_tokens: 321,
      messages: [{ role: 'user', content: 'Review' }],
    },
    new AbortController().signal,
  );
  await expect(response.text()).resolves.toContain('ok');
  const request = captured as Record<string, unknown>;
  expect(request.max_completion_tokens).toBe(321);
  expect(request).not.toHaveProperty('max_tokens');
});

it.each(['reasoning', 'reasoning_text'])(
  'replays the Chat %s reasoning alias with its original field signature',
  async (field) => {
    let captured: Record<string, unknown> | undefined;
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
      fetch: async (_url, init) => {
        if (typeof init?.body !== 'string') throw new Error('expected JSON body');
        captured = JSON.parse(init.body) as Record<string, unknown>;
        return new Response(
          'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
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
        messages: [
          { role: 'user', content: 'Review this change' },
          { role: 'assistant', content: 'Previous answer', [field]: 'kept reasoning' },
          { role: 'user', content: 'Continue' },
        ],
      },
      new AbortController().signal,
    );
    await expect(response.text()).resolves.toContain('ok');
    const request = captured as Record<string, any>;
    expect(request.messages[1]).toEqual({
      role: 'assistant',
      content: 'Previous answer',
      [field]: 'kept reasoning',
    });
  },
);

it('maps Responses input_image data URLs and image tool outputs to inline images', async () => {
  let captured: Record<string, unknown> | undefined;
  const credential =
    'header.' +
    Buffer.from(
      JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'test-account' } }),
    ).toString('base64url') +
    '.signature';
  const wire =
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-1","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n';
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
    fetch: async (_url, init) => {
      captured = decodeProviderBody(init?.body);
      return new Response(wire, { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const image = 'data:image/png;base64,' + Buffer.from('image-bytes').toString('base64');
  const response = await upstream(
    'subscription',
    {
      model: 'subscription',
      stream: true,
      store: false,
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'Describe' },
            { type: 'input_image', image_url: image, detail: 'high' },
          ],
        },
        { type: 'function_call', call_id: 'c1', name: 'look', arguments: '{}' },
        {
          type: 'function_call_output',
          call_id: 'c1',
          output: [{ type: 'input_image', image_url: image }],
        },
      ],
      tools: [{ type: 'function', name: 'look', parameters: { type: 'object', properties: {} } }],
    },
    new AbortController().signal,
  );
  await expect(response.text()).resolves.toBe(wire);
  const request = captured as Record<string, any>;
  expect(request.input[0]).toEqual({
    role: 'user',
    content: [
      { type: 'input_text', text: 'Describe' },
      { type: 'input_image', image_url: image, detail: 'high' },
    ],
  });
  expect(request.input[2]).toEqual({
    type: 'function_call_output',
    call_id: 'c1',
    output: [{ type: 'input_image', image_url: image, detail: 'auto' }],
  });
});

it('preserves assistant message identity and phase across multi-part text content', async () => {
  let captured: Record<string, unknown> | undefined;
  const credential =
    'header.' +
    Buffer.from(
      JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'test-account' } }),
    ).toString('base64url') +
    '.signature';
  const wire =
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-1","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n';
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
    fetch: async (_url, init) => {
      captured = decodeProviderBody(init?.body);
      return new Response(wire, { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const response = await upstream(
    'subscription',
    {
      model: 'subscription',
      stream: true,
      store: false,
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Review' }] },
        {
          type: 'message',
          role: 'assistant',
          id: 'msg_multi',
          phase: 'commentary',
          content: [
            { type: 'output_text', text: 'First part' },
            { type: 'output_text', text: 'Second part' },
          ],
        },
      ],
    },
    new AbortController().signal,
  );
  await expect(response.text()).resolves.toBe(wire);
  const request = captured as Record<string, any>;
  expect(request.input[1]).toEqual({
    type: 'message',
    role: 'assistant',
    id: 'msg_multi',
    phase: 'commentary',
    status: 'completed',
    content: [{ type: 'output_text', text: 'First partSecond part', annotations: [] }],
  });
});

it('rejects remote Chat image URLs without invoking the upstream transport', async () => {
  let fetchCalls = 0;
  const remote = 'https://images.invalid/picture.png';
  const upstream = createPiUpstream({
    routes: [
      {
        id: 'review',
        provider: 'openai-compatible',
        protocol: 'chat-completions',
        model: 'vision-model',
        baseUrl: 'https://provider.invalid/v1',
      },
    ],
    credential: async () => 'secret',
    fetch: async () => {
      fetchCalls++;
      throw new Error('must not reach upstream');
    },
  });
  const response = await upstream(
    'review',
    {
      model: 'review',
      stream: true,
      store: false,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe' },
            { type: 'image_url', image_url: { url: remote } },
          ],
        },
      ],
    },
    new AbortController().signal,
  );
  expect(response.status).toBe(400);
  expect(fetchCalls).toBe(0);
});

it('accepts inline images in Chat tool results and forwards them to the provider', async () => {
  let captured: Record<string, unknown> | undefined;
  const image = 'data:image/png;base64,' + Buffer.from('tool-image').toString('base64');
  const upstream = createPiUpstream({
    routes: [
      {
        id: 'review',
        provider: 'openai-compatible',
        protocol: 'chat-completions',
        model: 'vision-model',
        baseUrl: 'https://provider.invalid/v1',
      },
    ],
    credential: async () => 'secret',
    fetch: async (_url, init) => {
      if (typeof init?.body !== 'string') throw new Error('expected JSON body');
      captured = JSON.parse(init.body) as Record<string, unknown>;
      return new Response(
        'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
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
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'screenshot', arguments: '{}' } },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'call_1',
          name: 'screenshot',
          content: [
            { type: 'text', text: 'captured' },
            { type: 'image_url', image_url: { url: image } },
          ],
        },
      ],
      tools: [
        {
          type: 'function',
          function: { name: 'screenshot', parameters: { type: 'object', properties: {} } },
        },
      ],
    },
    new AbortController().signal,
  );
  await expect(response.text()).resolves.toContain('ok');
  const request = captured as Record<string, any>;
  expect(request.messages[1]).toMatchObject({
    role: 'tool',
    tool_call_id: 'call_1',
    content: 'captured',
  });
  expect(request.messages[2]).toEqual({
    role: 'user',
    content: [
      { type: 'text', text: 'Attached image(s) from tool result:' },
      { type: 'image_url', image_url: { url: image } },
    ],
  });
});

it('preserves Chat image_url detail on the generated provider payload', async () => {
  let captured: Record<string, unknown> | undefined;
  const image = 'data:image/png;base64,' + Buffer.from('image-bytes').toString('base64');
  const upstream = createPiUpstream({
    routes: [
      {
        id: 'review',
        provider: 'openai-compatible',
        protocol: 'chat-completions',
        model: 'vision-model',
        baseUrl: 'https://provider.invalid/v1',
      },
    ],
    credential: async () => 'secret',
    fetch: async (_url, init) => {
      if (typeof init?.body !== 'string') throw new Error('expected JSON body');
      captured = JSON.parse(init.body) as Record<string, unknown>;
      return new Response(
        'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
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
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe' },
            { type: 'image_url', image_url: { url: image, detail: 'high' } },
          ],
        },
      ],
    },
    new AbortController().signal,
  );
  await expect(response.text()).resolves.toContain('ok');
  const request = captured as Record<string, any>;
  expect(request.messages[0]).toEqual({
    role: 'user',
    content: [
      { type: 'text', text: 'Describe' },
      { type: 'image_url', image_url: { url: image, detail: 'high' } },
    ],
  });
});
