import { expect, it, vi } from 'vitest';
import { createLlmService } from '../apps/llm-service/src/service';
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

const routePath = (route: LiteLlmRoute): '/v1/chat/completions' | '/v1/responses' =>
  route.protocol === 'chat-completions' ? '/v1/chat/completions' : '/v1/responses';

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

const harness = (
  options: {
    route?: LiteLlmRoute;
    credential?: () => Promise<string>;
    fetch?: typeof globalThis.fetch;
    baseUrl?: string;
  } = {},
) => {
  const route = options.route ?? chatRoute();
  const upstream = createLiteLlmUpstream({
    baseUrl: options.baseUrl ?? 'http://127.0.0.1:4000',
    routes: [route],
    credential: options.credential ?? (async () => 'backend-key'),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const service = createLlmService({
    routes: [{ id: route.id, path: routePath(route) }],
    upstream,
  });
  let sequence = 0;
  return {
    service,
    async request(
      body: Record<string, unknown>,
      signal?: AbortSignal,
      jobId?: string,
    ): Promise<Response> {
      const job = jobId ?? `job-${++sequence}`;
      const issued = await service.control(
        new Request('http://control/grants', {
          method: 'POST',
          body: JSON.stringify({ jobId: job, routes: [route.id] }),
        }),
      );
      if (issued.status !== 201) throw new Error(`grant unavailable: ${issued.status}`);
      const { token } = (await issued.json()) as { token: string };
      return service.inference(
        new Request(`http://service${routePath(route)}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
          signal,
        }),
      );
    },
    close() {
      service.close();
    },
  };
};

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
  const h = harness({
    fetch: async (url, init) => {
      captured = {
        url: url instanceof Request ? url.url : url.toString(),
        headers: new Headers(init?.headers),
        body: parseBody(init?.body),
      };
      return new Response(chatWire(), { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const response = await h.request(
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
    undefined,
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
  const h = harness({
    route: responsesRoute(),
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
  });
  const response = await h.request(
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
    undefined,
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
  const h = harness({
    fetch: async (_url, init) => {
      captured = parseBody(init?.body);
      return new Response(chatWire(), { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const response = await h.request(
    {
      model: 'review',
      messages,
      tools,
      reasoning_effort: 'high',
    },
    undefined,
    'job-nested',
  );
  await expect(response.text()).resolves.toContain('Looks good');
  expect(captured?.messages).toEqual(messages);
  expect(captured?.tools).toEqual(tools);
});

it('accepts native Responses incomplete as a terminal stream', async () => {
  const h = harness({
    route: responsesRoute(),
    fetch: async () =>
      new Response(responsesWire('response.incomplete'), {
        headers: { 'content-type': 'text/event-stream' },
      }),
  });
  const response = await h.request(
    { model: 'subscription', input: 'Review', prompt_cache_key: 'cache' },
    undefined,
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
  const chat = harness({ fetch });
  const chatResponse = await chat.request({
    model: 'review',
    messages: [{ role: 'user', content: 'Review' }],
    [field]: override,
  });
  expect(chatResponse.status).toBe(400);
  expect(await chatResponse.text()).not.toContain('canary');

  const responses = harness({ route: responsesRoute(), fetch });
  const responsesResponse = await responses.request({
    model: 'subscription',
    input: 'Review',
    [field]: override,
  });
  expect(responsesResponse.status).toBe(400);
  expect(await responsesResponse.text()).not.toContain('canary');
  expect(calls).toBe(0);
});

it('rejects malformed native requests before contacting LiteLLM', async () => {
  let calls = 0;
  const h = harness({
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
    const response = await h.request(body);
    expect(response.status).toBe(400);
  }
  const responses = harness({
    route: responsesRoute(),
    fetch: async () => {
      calls += 1;
      return new Response(responsesWire(), {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  expect((await responses.request({ model: 'subscription' })).status).toBe(400);
  expect(calls).toBe(0);
});

it('does not forward raw upstream error events to the client', async () => {
  const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    const h = harness({
      route: responsesRoute(),
      fetch: async () =>
        new Response(
          'event: response.failed\ndata: {"type":"response.failed","message":"private-upstream-canary"}\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    });
    const response = await h.request(
      { model: 'subscription', input: 'Review' },
      undefined,
      'job-error-event',
    );
    await expect(response.text()).rejects.toThrow();
    expect(JSON.stringify(logs.mock.calls)).not.toContain('private-upstream-canary');
    expect(JSON.stringify(logs.mock.calls)).toContain('upstream-error-event');
  } finally {
    logs.mockRestore();
  }
});

it.each(['event: error', 'event: response.failed'])(
  'rejects the SSE %s event independently of JSON fields',
  async (event) => {
    const h = harness({
      fetch: async () =>
        new Response(`${event}\ndata: {"message":"private-event-canary"}\n\n`, {
          headers: { 'content-type': 'text/event-stream' },
        }),
    });
    const response = await h.request({ model: 'review', messages: [] });
    await expect(response.text()).rejects.toThrow();
  },
);

it('rejects a Chat error payload without forwarding its diagnostic', async () => {
  const h = harness({
    fetch: async () =>
      new Response('data: {"error":{"message":"private-payload-canary"}}\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      }),
  });
  const response = await h.request({ model: 'review', messages: [] });
  await expect(response.text()).rejects.toThrow();
});

it.each([
  ['[DONE] without a Chat finish marker', 'data: [DONE]\n\n'],
  [
    'a Chat finish marker without [DONE]',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
  ],
  ['an empty Chat stream', ''],
])('does not report %s as a completed response', async (_name, wire) => {
  const h = harness({
    fetch: async () => new Response(wire, { headers: { 'content-type': 'text/event-stream' } }),
  });
  const response = await h.request({ model: 'review', messages: [] });
  await expect(response.text()).rejects.toThrow();
});

it('does not accept a Responses terminal frame as Chat completion', async () => {
  const h = harness({
    fetch: async () =>
      new Response(
        'data: {"type":"response.completed","response":{"status":"completed"}}\n\ndata: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  });
  const response = await h.request({ model: 'review', messages: [] });
  await expect(response.text()).rejects.toThrow();
});

it('does not accept Chat completion markers as Responses completion', async () => {
  const h = harness({
    route: responsesRoute(),
    fetch: async () =>
      new Response(
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  });
  const response = await h.request({ model: 'subscription', input: 'Review' });
  await expect(response.text()).rejects.toThrow();
});

it('does not start an upstream fetch for an already-aborted request', async () => {
  let calls = 0;
  const h = harness({
    fetch: async () => {
      calls += 1;
      return new Response(chatWire(), { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const controller = new AbortController();
  controller.abort();
  const response = await h.request(
    { model: 'review', messages: [] },
    controller.signal,
    'job-pre-aborted',
  );
  expect(response.status).toBe(401);
  expect(calls).toBe(0);
});

it('does not report a Responses stream without a terminal event as complete', async () => {
  const h = harness({
    route: responsesRoute(),
    fetch: async () =>
      new Response(
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Partial"}\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  });
  const response = await h.request({ model: 'subscription', input: 'Review' });
  await expect(response.text()).rejects.toThrow();
});

it('records incomplete-stream diagnostics without leaking prompts, credentials, or content', async () => {
  const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    const h = harness({
      credential: async () => 'credential-canary',
      fetch: async () =>
        new Response(
          'data: {"choices":[{"index":0,"delta":{"content":"response-canary"},"finish_reason":null}]}\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    });
    const response = await h.request(
      { model: 'review', messages: [{ role: 'user', content: 'prompt-canary' }] },
      undefined,
      'job-diagnostic',
    );
    await expect(response.text()).rejects.toThrow();
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
    const h = harness({
      fetch: async () =>
        new Response(wire, { status, headers: { 'content-type': 'text/event-stream' } }),
    });
    const response = await h.request(
      { model: 'review', messages: [] },
      undefined,
      'job-classification',
    );
    if (outcome === 'completed') await expect(response.text()).resolves.toContain('[DONE]');
    else if (status !== 200) {
      expect(response.status).toBe(502);
      expect(await response.text()).not.toContain('private-error-canary');
    } else await expect(response.text()).rejects.toThrow();
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
  const h = harness({
    fetch: async () => {
      throw new Error('private-network-canary');
    },
  });
  const response = await h.request({ model: 'review', messages: [] }, undefined, 'job-network');
  expect(response.status).toBe(502);
  expect(await response.text()).not.toContain('private-network-canary');
});

it('rejects an unavailable credential before contacting LiteLLM', async () => {
  const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    let calls = 0;
    const h = harness({
      credential: async () => '',
      fetch: async () => {
        calls += 1;
        return new Response(chatWire(), { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    const response = await h.request(
      { model: 'review', messages: [] },
      undefined,
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
  const h = harness({
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
  const response = await h.request({ model: 'review', messages: [] });
  const reader = response.body!.getReader();
  await reader.read();
  await reader.cancel();
  expect(observedSignal).toHaveProperty('aborted', true);
});

it.each([
  ['client cancel', 'request-aborted', 'cancel'],
  ['request abort', 'request-aborted', 'abort'],
  ['upstream stream error', 'upstream-stream-error', 'error'],
] as const)(
  'identifies %s after response headers without leaking transport errors',
  async (_name, outcome, action) => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      let source: ReadableStreamDefaultController<Uint8Array> | undefined;
      const controller = new AbortController();
      const h = harness({
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
      const response = await h.request(
        { model: 'review', messages: [] },
        controller.signal,
        'job-stream-end',
      );
      const reader = response.body!.getReader();
      expect((await reader.read()).done).toBe(false);
      if (action === 'cancel') await reader.cancel();
      else {
        if (action === 'abort') controller.abort();
        else source!.error(new Error('transport-secret'));
        await expect(reader.read()).rejects.toThrow();
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
    const h = harness({
      fetch: async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('private-error')), {
            once: true,
          });
        }),
    });
    const pending = h.request({ model: 'review', messages: [] }, undefined, 'job-service-timeout');
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
  const h = harness({
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
  const response = await h.request({ model: 'review', messages: [] }, undefined, 'job-too-large');
  await expect(response.text()).rejects.toThrow();
});

it.each(['cancel', 'abort'] as const)(
  'records completed when a Chat client %s after finish and [DONE] before HTTP EOF',
  async (action) => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      let source: ReadableStreamDefaultController<Uint8Array> | undefined;
      const h = harness({
        fetch: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                source = controller;
                controller.enqueue(new TextEncoder().encode(chatWire()));
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          ),
      });
      const controller = new AbortController();
      const response = await h.request(
        { model: 'review', messages: [] },
        controller.signal,
        `job-chat-${action}`,
      );
      const reader = response.body!.getReader();
      let text = '';
      while (!text.includes('[DONE]')) {
        const next = await reader.read();
        if (next.done) throw new Error('stream ended before cancellation');
        text += new TextDecoder().decode(next.value);
      }
      if (action === 'cancel') await reader.cancel();
      else controller.abort();
      await vi.waitFor(() => {
        const finished = logs.mock.calls.filter((call) => call.includes('llm.request.finished'));
        expect(finished).toHaveLength(1);
        expect(finished[0]?.[2]).toMatchObject({
          jobId: `job-chat-${action}`,
          outcome: 'completed',
        });
      });
      try {
        source?.close();
      } catch {
        /* Cancellation already closed the transport. */
      }
    } finally {
      logs.mockRestore();
    }
  },
);

it.each(['cancel', 'abort'] as const)(
  'records completed when a Responses client %s after terminal completed before HTTP EOF',
  async (action) => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      let source: ReadableStreamDefaultController<Uint8Array> | undefined;
      const h = harness({
        route: responsesRoute(),
        fetch: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                source = controller;
                controller.enqueue(new TextEncoder().encode(responsesWire()));
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          ),
      });
      const controller = new AbortController();
      const response = await h.request(
        { model: 'subscription', input: 'Review' },
        controller.signal,
        `job-responses-${action}`,
      );
      const reader = response.body!.getReader();
      let text = '';
      while (!text.includes('response.completed')) {
        const next = await reader.read();
        if (next.done) throw new Error('stream ended before cancellation');
        text += new TextDecoder().decode(next.value);
      }
      if (action === 'cancel') await reader.cancel();
      else controller.abort();
      await vi.waitFor(() => {
        const finished = logs.mock.calls.filter((call) => call.includes('llm.request.finished'));
        expect(finished).toHaveLength(1);
        expect(finished[0]?.[2]).toMatchObject({
          jobId: `job-responses-${action}`,
          outcome: 'completed',
        });
      });
      try {
        source?.close();
      } catch {
        /* Cancellation already closed the transport. */
      }
    } finally {
      logs.mockRestore();
    }
  },
);
