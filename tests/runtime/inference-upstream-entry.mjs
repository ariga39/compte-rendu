const encoder = new TextEncoder();

let scenario = 'success';
let requests = [];
let cancellations = 0;
let waitingHeaders = 0;
let release = null;
let releasePromise = null;

const resetRelease = () => {
  releasePromise = new Promise((resolve) => {
    release = resolve;
  });
};

const reset = (next = {}) => {
  scenario = next.scenario ?? 'success';
  requests = [];
  cancellations = 0;
  waitingHeaders = 0;
  resetRelease();
};

const usageFrame = (model) =>
  `data: ${JSON.stringify({
    model,
    choices: [],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 3,
      total_tokens: 13,
      prompt_tokens_details: { cached_tokens: 4 },
      completion_tokens_details: { reasoning_tokens: 1 },
    },
  })}\n\n`;

const finishFrame = () => 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n';

const successWire = (model) =>
  `data: {"model":"${model}","choices":[{"index":0,"delta":{"content":"Reviewed"},"finish_reason":null}]}\n\n` +
  usageFrame(model) +
  finishFrame() +
  'data: [DONE]\n\n';

const partialWire = (model) =>
  `data: {"model":"${model}","choices":[{"index":0,"delta":{"content":"Partial"},"finish_reason":null}]}\n\n` +
  usageFrame(model);

const streamResponse = (wire) =>
  new Response(wire, {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
  });

const heldResponse = (model) => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          `data: {"model":"${model}","choices":[{"index":0,"delta":{"content":"Held"},"finish_reason":null}]}\n\n`,
        ),
      );
    },
    async pull(controller) {
      await releasePromise;
      if (cancelled) return;
      controller.enqueue(encoder.encode(usageFrame(model) + finishFrame() + 'data: [DONE]\n\n'));
      controller.close();
    },
    cancel() {
      cancelled = true;
      cancellations += 1;
      release?.();
    },
  });
  return new Response(body, {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
  });
};

const utf8SplitResponse = (model) => {
  const wire =
    `data: ${JSON.stringify({
      model,
      choices: [{ index: 0, delta: { content: '审查通过' }, finish_reason: null }],
    })}\n\n` +
    usageFrame(model) +
    finishFrame() +
    'data: [DONE]\n\n';
  const bytes = encoder.encode(wire);
  const marker = encoder.encode(wire.slice(0, wire.indexOf('审'))).length;
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.slice(0, marker + 1));
        controller.enqueue(bytes.slice(marker + 1, marker + 2));
        controller.enqueue(bytes.slice(marker + 2));
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } },
  );
};

const deferredTerminalResponse = (model) => {
  let step = 0;
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `data: {"model":"${model}","choices":[{"index":0,"delta":{"content":"Deferred"},"finish_reason":null}]}\n\n`,
          ),
        );
      },
      async pull(controller) {
        if (step === 0) {
          step = 1;
          controller.enqueue(encoder.encode(finishFrame()));
          return;
        }
        if (step === 1) {
          step = 2;
          await new Promise((resolve) => setTimeout(resolve, 50));
          controller.enqueue(encoder.encode(usageFrame(model) + 'data: [DONE]\n\n'));
          controller.close();
        }
      },
    }),
    { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } },
  );
};

const floodedTerminalResponse = (model) => {
  const frames = [finishFrame()];
  for (let index = 0; index < 40; index += 1) {
    frames.push(
      `data: ${JSON.stringify({
        model,
        choices: [{ index: 0, delta: { content: `held-${index}` }, finish_reason: null }],
      })}\n\n`,
    );
  }
  frames.push('data: [DONE]\n\n');
  return streamResponse(frames.join(''));
};

const floodedBytesResponse = (model) =>
  streamResponse(
    finishFrame() +
      `data: ${JSON.stringify({
        model,
        choices: [{ index: 0, delta: { content: 'x'.repeat(70 * 1024) }, finish_reason: null }],
      })}\n\n` +
      'data: [DONE]\n\n',
  );

const silentResponse = () =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"model":"deepseek-native","choices":[{"index":0,"delta":{"content":"Waiting"},"finish_reason":null}]}\n\n',
          ),
        );
      },
      cancel() {
        cancellations += 1;
        release?.();
      },
    }),
    { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } },
  );

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/__control') {
      reset(await request.json());
      return Response.json({ ok: true });
    }
    if (url.pathname === '/__release') {
      release?.();
      return Response.json({ ok: true });
    }
    if (url.pathname === '/__state') {
      return Response.json({ requests, cancellations, waitingHeaders });
    }

    request.signal.addEventListener(
      'abort',
      () => {
        cancellations += 1;
        release?.();
      },
      { once: true },
    );
    const body = request.body === null ? '' : await request.text();
    requests.push({
      url: request.url,
      headers: Object.fromEntries(request.headers),
      body,
    });

    if (scenario === 'error') {
      return new Response('private upstream diagnostic', {
        status: 429,
        headers: { 'x-private': 'must-not-leak' },
      });
    }
    if (scenario === 'incomplete') {
      return streamResponse(
        `data: {"model":"deepseek-native","choices":[{"index":0,"delta":{"content":"Cut"},"finish_reason":null}]}\n\n`,
      );
    }
    if (scenario === 'failure-after-usage') {
      return streamResponse(partialWire('deepseek-native') + 'data: not-json\n\n');
    }
    if (scenario === 'hold') return heldResponse('deepseek-native');
    if (scenario === 'silent') return silentResponse();
    if (scenario === 'utf8-split') return utf8SplitResponse('deepseek-native');
    if (scenario === 'deferred-terminal') return deferredTerminalResponse('deepseek-native');
    if (scenario === 'flood-after-finish') return floodedTerminalResponse('deepseek-native');
    if (scenario === 'flood-bytes-after-finish') return floodedBytesResponse('deepseek-native');
    if (scenario === 'wait-headers') {
      waitingHeaders += 1;
      await releasePromise;
      return streamResponse(successWire('deepseek-native'));
    }
    return streamResponse(successWire('deepseek-native'));
  },
};
