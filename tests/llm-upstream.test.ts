import { expect, it, vi } from 'vitest';
import { createLiteLlmUpstream, type LiteLlmRoute } from '../apps/llm-service/src/upstream';

const chatRoute = (model = 'deepseek-flash'): LiteLlmRoute => ({
  id: 'review',
  model,
  protocol: 'chat-completions',
});

const responsesRoute = (model = 'gpt-6.1-sol'): LiteLlmRoute => ({
  id: 'subscription',
  model,
  protocol: 'responses',
});

const chatWire = (content = 'Looks good', extra = ''): string =>
  `data: {"id":"c1","choices":[{"index":0,"delta":{"content":"${content}"},"finish_reason":null}]}\n\n` +
  `data: {"id":"c1","choices":[],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7},"unknown_frame":{"kept":true}}${extra}\n\n` +
  'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
  'data: [DONE]\n\n';

const responsesWire = (type = 'response.completed'): string =>
  'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Reviewed","unknown_event_field":{"kept":true}}\n\n' +
  `event: ${type}\ndata: {"type":"${type}","response":{"id":"resp-1","status":"${
    type === 'response.completed' ? 'completed' : 'incomplete'
  }","output":[],"usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}}\n\n`;

const parseBody = (body: unknown): Record<string, unknown> => {
  if (typeof body !== 'string') throw new Error('expected JSON body');
  return JSON.parse(body) as Record<string, unknown>;
};

const request = (
  overrides: Partial<Parameters<typeof createLiteLlmUpstream>[0]> = {},
  route: LiteLlmRoute = chatRoute(),
) =>
  createLiteLlmUpstream({
    baseUrl: 'http://127.0.0.1:4000',
    routes: [route],
    credential: async () => 'backend-key',
    ...overrides,
  });

it('forwards native Chat Completions fields and usage frames with the LiteLLM model alias', async () => {
  let captured: { url: string; headers: Headers; body: Record<string, unknown> } | undefined;
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Review this change' },
        {
          type: 'image_url',
          image_url: { url: 'data:image/png;base64,aW1hZ2U=', detail: 'high' },
        },
      ],
    },
    {
      role: 'assistant',
      content: 'Earlier answer',
      reasoning_content: 'private reasoning',
      reasoning_details: [{ type: 'reasoning.encrypted', id: 'rs_1', data: 'opaque' }],
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'submit_review', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
  ];
  const tools = [
    {
      type: 'function',
      function: {
        name: 'submit_review',
        parameters: { type: 'object', properties: { decision: { type: 'string' } } },
      },
    },
  ];
  const upstream = request({
    fetch: async (url, init) => {
      captured = {
        url: url instanceof Request ? url.url : url.toString(),
        headers: new Headers(init?.headers),
        body: parseBody(init?.body),
      };
      return new Response(chatWire(), { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const response = await upstream(
    'review',
    {
      model: 'review',
      stream: false,
      store: true,
      messages,
      tools,
      tool_choice: 'auto',
      parallel_tool_calls: true,
      temperature: 0.2,
      top_p: 0.9,
      max_completion_tokens: 321,
      prompt_cache_key: 'client-cache-key',
      reasoning_effort: 'high',
      stream_options: { include_usage: true },
    },
    new AbortController().signal,
    'job-chat',
  );
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).toContain('Looks good');
  expect(text).toContain('"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}');
  expect(text).toContain('"unknown_frame":{"kept":true}');

  expect(captured?.url).toBe('http://127.0.0.1:4000/v1/chat/completions');
  expect(captured?.headers.get('authorization')).toBe('Bearer backend-key');
  expect(captured?.headers.get('x-opencode-session')).toBe('job-chat');
  expect(captured?.headers.get('session_id')).toBe('job-chat');
  expect(captured?.body.model).toBe('deepseek-flash');
  expect(captured?.body.stream).toBe(true);
  expect(captured?.body.store).toBe(false);
  expect(captured?.body.messages).toEqual(messages);
  expect(captured?.body.tools).toEqual(tools);
  expect(captured?.body.prompt_cache_key).toBe('client-cache-key');
  expect(captured?.body.max_completion_tokens).toBe(321);
});

it('forwards native Responses fields, preserving images, reasoning, signatures, and custom tools', async () => {
  let captured: { url: string; headers: Headers; body: Record<string, unknown> } | undefined;
  const input = [
    {
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: 'Review' },
        {
          type: 'input_image',
          image_url: 'data:image/png;base64,aW1hZ2U=',
          detail: 'high',
        },
      ],
    },
    { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque', summary: [] },
    {
      type: 'message',
      role: 'assistant',
      id: 'msg_1',
      phase: 'final_answer',
      content: [{ type: 'output_text', text: 'Earlier', annotations: [] }],
    },
    {
      type: 'custom_tool_call',
      call_id: 'c1',
      id: 'ctc_1',
      name: 'run_code',
      input: 'print(1)',
    },
    { type: 'custom_tool_call_output', call_id: 'c1', output: '1' },
  ];
  const tools = [
    {
      type: 'custom',
      name: 'run_code',
      description: 'Run',
      format: { type: 'grammar', syntax: 'lark', definition: 'start: /.+/' },
    },
    { type: 'function', name: 'submit_review', parameters: { type: 'object', properties: {} } },
  ];
  const upstream = request(
    {
      fetch: async (url, init) => {
        captured = {
          url: url instanceof Request ? url.url : url.toString(),
          headers: new Headers(init?.headers),
          body: parseBody(init?.body),
        };
        return new Response(responsesWire(), {
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    },
    responsesRoute(),
  );
  const response = await upstream(
    'subscription',
    {
      model: 'subscription',
      stream: true,
      store: false,
      instructions: 'Review carefully.',
      input,
      tools,
      tool_choice: { type: 'function', name: 'submit_review' },
      prompt_cache_key: 'client-cache-key',
      reasoning: { effort: 'high', summary: 'auto' },
      text: { format: { type: 'json_schema', name: 'review', schema: {} } },
      include: ['reasoning.encrypted_content'],
      client_metadata: { client: 'sandbox' },
    },
    new AbortController().signal,
    'job-responses',
  );
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).toContain('"unknown_event_field":{"kept":true}');
  expect(text).toContain('"usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}');

  expect(captured?.url).toBe('http://127.0.0.1:4000/v1/responses');
  expect(captured?.headers.get('authorization')).toBe('Bearer backend-key');
  expect(captured?.headers.get('x-opencode-session')).toBe('job-responses');
  expect(captured?.headers.get('session_id')).toBe('job-responses');
  expect(captured?.body.model).toBe('gpt-6.1-sol');
  expect(captured?.body.stream).toBe(true);
  expect(captured?.body.store).toBe(false);
  expect(captured?.body.input).toEqual(input);
  expect(captured?.body.tools).toEqual(tools);
  expect(captured?.body.prompt_cache_key).toBe('client-cache-key');
  expect(captured?.body.client_metadata).toEqual({ client: 'sandbox' });
});

it('preserves provider-generated nested payload fields unchanged', async () => {
  let captured: Record<string, unknown> | undefined;
  const messages = [
    {
      role: 'assistant',
      content: null,
      provider_specific_fields: { vendor: 'provider', cache: { cached_tokens: 12 } },
      reasoning_details: [{ type: 'reasoning.encrypted', id: 'rs_1', data: 'opaque' }],
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: {
            name: 'submit_review',
            arguments: '{}',
            provider_specific_fields: { signature: 'opaque-signature' },
          },
        },
      ],
    },
  ];
  const tools = [
    {
      type: 'function',
      function: {
        name: 'submit_review',
        parameters: { type: 'object', properties: {} },
        provider_specific_fields: { dialect: 'vendor' },
      },
      cache_control: { type: 'ephemeral' },
    },
  ];
  const upstream = request({
    fetch: async (_url, init) => {
      captured = parseBody(init?.body);
      return new Response(chatWire(), { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const response = await upstream(
    'review',
    {
      model: 'review',
      messages,
      tools,
      reasoning_effort: 'high',
    },
    new AbortController().signal,
    'job-nested',
  );
  await expect(response.text()).resolves.toContain('Looks good');
  expect(captured?.messages).toEqual(messages);
  expect(captured?.tools).toEqual(tools);
});

it('accepts native Responses incomplete as a terminal stream', async () => {
  const upstream = request(
    {
      fetch: async () =>
        new Response(responsesWire('response.incomplete'), {
          headers: { 'content-type': 'text/event-stream' },
        }),
    },
    responsesRoute(),
  );
  const response = await upstream(
    'subscription',
    { model: 'subscription', input: 'Review', prompt_cache_key: 'cache' },
    new AbortController().signal,
    'job-incomplete',
  );
  await expect(response.text()).resolves.toContain('response.incomplete');
});

it.each([
  'api_base',
  'api_key',
  'headers',
  'provider',
  'metadata',
  'base_url',
  'extra_body',
  'custom_llm_provider',
])('rejects the %s routing or credential override before contacting LiteLLM', async (field) => {
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    return new Response(chatWire(), { headers: { 'content-type': 'text/event-stream' } });
  };
  const override = field === 'headers' ? { 'x-secret': 'canary' } : 'canary';
  const chat = request({ fetch });
  const chatResponse = await chat(
    'review',
    { model: 'review', messages: [{ role: 'user', content: 'Review' }], [field]: override },
    new AbortController().signal,
  );
  expect(chatResponse.status).toBe(400);
  expect(await chatResponse.text()).not.toContain('canary');

  const responses = request({ fetch }, responsesRoute());
  const responsesResponse = await responses(
    'subscription',
    { model: 'subscription', input: 'Review', [field]: override },
    new AbortController().signal,
  );
  expect(responsesResponse.status).toBe(400);
  expect(await responsesResponse.text()).not.toContain('canary');
  expect(calls).toBe(0);
});

it('rejects malformed native requests before contacting LiteLLM', async () => {
  let calls = 0;
  const upstream = request({
    fetch: async () => {
      calls += 1;
      return new Response(chatWire(), { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  for (const body of [
    { model: 'review', messages: [], input: 'wrong protocol' },
    { model: 'review' },
    { messages: [] },
    { model: 7, messages: [] },
  ]) {
    const response = await upstream('review', body, new AbortController().signal);
    expect(response.status).toBe(400);
  }
  const responses = request(
    {
      fetch: async () => {
        calls += 1;
        return new Response(responsesWire(), {
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    },
    responsesRoute(),
  );
  expect(
    (await responses('subscription', { model: 'subscription' }, new AbortController().signal))
      .status,
  ).toBe(400);
  expect(calls).toBe(0);
});

it('does not forward raw upstream error events to the client', async () => {
  const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    const upstream = request(
      {
        fetch: async () =>
          new Response(
            'event: response.failed\ndata: {"type":"response.failed","message":"private-upstream-canary"}\n\n',
            { headers: { 'content-type': 'text/event-stream' } },
          ),
      },
      responsesRoute(),
    );
    const response = await upstream(
      'subscription',
      { model: 'subscription', input: 'Review' },
      new AbortController().signal,
      'job-error-event',
    );
    await expect(response.text()).rejects.toThrow('model stream failed');
    expect(JSON.stringify(logs.mock.calls)).not.toContain('private-upstream-canary');
    expect(JSON.stringify(logs.mock.calls)).toContain('upstream-error-event');
  } finally {
    logs.mockRestore();
  }
});

it.each(['event: error', 'event: response.failed'])(
  'rejects the SSE %s event independently of JSON fields',
  async (event) => {
    const upstream = request({
      fetch: async () =>
        new Response(`${event}\ndata: {"message":"private-event-canary"}\n\n`, {
          headers: { 'content-type': 'text/event-stream' },
        }),
    });
    const response = await upstream(
      'review',
      { model: 'review', messages: [] },
      new AbortController().signal,
    );
    await expect(response.text()).rejects.toThrow('model stream failed');
  },
);

it('rejects a Chat error payload without forwarding its diagnostic', async () => {
  const upstream = request({
    fetch: async () =>
      new Response('data: {"error":{"message":"private-payload-canary"}}\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      }),
  });
  const response = await upstream(
    'review',
    { model: 'review', messages: [] },
    new AbortController().signal,
  );
  await expect(response.text()).rejects.toThrow('model stream failed');
});

it.each([
  ['[DONE] without a Chat finish marker', 'data: [DONE]\n\n'],
  [
    'a Chat finish marker without [DONE]',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
  ],
  ['an empty Chat stream', ''],
])('does not report %s as a completed response', async (_name, wire) => {
  const upstream = request({
    fetch: async () => new Response(wire, { headers: { 'content-type': 'text/event-stream' } }),
  });
  const response = await upstream(
    'review',
    { model: 'review', messages: [] },
    new AbortController().signal,
  );
  await expect(response.text()).rejects.toThrow('model stream failed');
});

it('does not accept a Responses terminal frame as Chat completion', async () => {
  const upstream = request({
    fetch: async () =>
      new Response(
        'data: {"type":"response.completed","response":{"status":"completed"}}\n\ndata: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  });
  const response = await upstream(
    'review',
    { model: 'review', messages: [] },
    new AbortController().signal,
  );
  await expect(response.text()).rejects.toThrow('model stream failed');
});

it('does not accept Chat completion markers as Responses completion', async () => {
  const upstream = request(
    {
      fetch: async () =>
        new Response(
          'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    },
    responsesRoute(),
  );
  const response = await upstream(
    'subscription',
    { model: 'subscription', input: 'Review' },
    new AbortController().signal,
  );
  await expect(response.text()).rejects.toThrow('model stream failed');
});

it('does not start an upstream fetch for an already-aborted request', async () => {
  let calls = 0;
  const upstream = request({
    fetch: async () => {
      calls += 1;
      return new Response(chatWire(), { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const controller = new AbortController();
  controller.abort();
  const response = await upstream(
    'review',
    { model: 'review', messages: [] },
    controller.signal,
    'job-pre-aborted',
  );
  expect(response.status).toBe(502);
  expect(calls).toBe(0);
});

it('does not report a Responses stream without a terminal event as complete', async () => {
  const upstream = request(
    {
      fetch: async () =>
        new Response(
          'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Partial"}\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    },
    responsesRoute(),
  );
  const response = await upstream(
    'subscription',
    { model: 'subscription', input: 'Review' },
    new AbortController().signal,
  );
  await expect(response.text()).rejects.toThrow('model stream failed');
});

it('records incomplete-stream diagnostics without leaking prompts, credentials, or content', async () => {
  const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    const upstream = request({
      credential: async () => 'credential-canary',
      fetch: async () =>
        new Response(
          'data: {"choices":[{"index":0,"delta":{"content":"response-canary"},"finish_reason":null}]}\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    });
    const response = await upstream(
      'review',
      { model: 'review', messages: [{ role: 'user', content: 'prompt-canary' }] },
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
});

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
    const upstream = request({
      fetch: async () =>
        new Response(wire, { status, headers: { 'content-type': 'text/event-stream' } }),
    });
    const response = await upstream(
      'review',
      { model: 'review', messages: [] },
      new AbortController().signal,
      'job-classification',
    );
    if (outcome === 'completed') await expect(response.text()).resolves.toContain('[DONE]');
    else if (status !== 200) {
      expect(response.status).toBe(502);
      expect(await response.text()).not.toContain('private-error-canary');
    } else await expect(response.text()).rejects.toThrow('model stream failed');
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

it('returns a sanitized failure when the upstream transport fails', async () => {
  const upstream = request({
    fetch: async () => {
      throw new Error('private-network-canary');
    },
  });
  const response = await upstream(
    'review',
    { model: 'review', messages: [] },
    new AbortController().signal,
    'job-network',
  );
  expect(response.status).toBe(502);
  expect(await response.text()).not.toContain('private-network-canary');
});

it('rejects an unavailable credential before contacting LiteLLM', async () => {
  const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    let calls = 0;
    const upstream = request({
      credential: async () => '',
      fetch: async () => {
        calls += 1;
        return new Response(chatWire(), { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    const response = await upstream(
      'review',
      { model: 'review', messages: [] },
      new AbortController().signal,
      'job-credential',
    );
    expect(response.status).toBe(502);
    expect(calls).toBe(0);
    expect(JSON.stringify(logs.mock.calls)).toContain('credential-or-request-failure');
  } finally {
    logs.mockRestore();
  }
});

it('cancels the upstream request when a client abandons the stream', async () => {
  let observedSignal: AbortSignal | null = null;
  const upstream = request({
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
  const response = await upstream(
    'review',
    { model: 'review', messages: [] },
    new AbortController().signal,
  );
  const reader = response.body!.getReader();
  await reader.read();
  await reader.cancel();
  expect(observedSignal).toHaveProperty('aborted', true);
});

it.each(['client-cancelled', 'request-aborted', 'upstream-stream-error'] as const)(
  'identifies %s after response headers without leaking transport errors',
  async (outcome) => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      let source: ReadableStreamDefaultController<Uint8Array> | undefined;
      const controller = new AbortController();
      const upstream = request({
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
        { model: 'review', messages: [] },
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
    const upstream = request({
      fetch: async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('private-error')), {
            once: true,
          });
        }),
    });
    const pending = upstream(
      'review',
      { model: 'review', messages: [] },
      new AbortController().signal,
      'job-service-timeout',
    );
    await vi.advanceTimersByTimeAsync(120_001);
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

it('bounds the upstream stream at sixteen mebibytes', async () => {
  const chunk = new Uint8Array(16 * 1024 * 1024 + 1);
  const upstream = request({
    fetch: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(chunk);
            controller.close();
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  });
  const response = await upstream(
    'review',
    { model: 'review', messages: [] },
    new AbortController().signal,
    'job-too-large',
  );
  await expect(response.text()).rejects.toThrow('model stream failed');
});
