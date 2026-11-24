import { geminiProtocolStream } from './inference-gemini-upstream.mjs';
import { messagesProtocolStream } from './inference-messages-upstream.mjs';

const encoder = new TextEncoder();

let scenario = 'success';
let requests = [];
let cancellations = 0;
let waitingHeaders = 0;
let terminalBytes = 0;
let unterminatedBytes = 0;
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
  terminalBytes = next.terminalBytes ?? 0;
  unterminatedBytes = next.unterminatedBytes ?? 0;
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

const responsesEvent = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const responsesSuccessWire = () =>
  responsesEvent('response.created', {
    type: 'response.created',
    response: { status: 'in_progress', model: 'gpt-sol-native' },
  }) +
  responsesEvent('response.output_text.delta', {
    type: 'response.output_text.delta',
    response: { status: 'in_progress', model: 'gpt-sol-native' },
    delta: 'Reviewed',
  }) +
  responsesEvent('response.completed', {
    type: 'response.completed',
    response: {
      status: 'completed',
      model: 'gpt-sol-native',
      usage: {
        input_tokens: 20,
        input_tokens_details: { cached_tokens: 8 },
        output_tokens: 10,
        output_tokens_details: { reasoning_tokens: 4 },
        total_tokens: 30,
      },
    },
  });

const responsesUsage = (input, cached, output, reasoning) => ({
  input_tokens: input,
  input_tokens_details: { cached_tokens: cached },
  output_tokens: output,
  output_tokens_details: { reasoning_tokens: reasoning },
  total_tokens: input + output,
});

const responsesIncompleteWire = () =>
  responsesEvent('response.incomplete', {
    type: 'response.incomplete',
    response: {
      status: 'incomplete',
      model: 'gpt-sol-native',
      incomplete_details: { reason: 'max_output_tokens' },
      usage: responsesUsage(100, 20, 7, 2),
    },
  });

const responsesFailedWire = () =>
  responsesEvent('response.failed', {
    type: 'response.failed',
    response: {
      status: 'failed',
      model: 'gpt-sol-native',
      usage: responsesUsage(50, 0, 1, 0),
      error: { code: 'server_error', message: 'private upstream diagnostic' },
    },
  });

const responsesErrorWire = () =>
  responsesEvent('error', {
    type: 'error',
    code: 'server_error',
    message: 'private upstream diagnostic',
  });

const responsesMismatchedTerminalWire = () =>
  // The SSE event name and JSON type disagree: this must never complete.
  responsesEvent('response.output_text.delta', {
    type: 'response.completed',
    response: {
      status: 'completed',
      model: 'gpt-sol-native',
      usage: responsesUsage(20, 8, 10, 4),
    },
  });

const responsesStatusOnlyCompletedWire = () =>
  // A nonterminal frame cannot complete merely because it claims a status.
  responsesEvent('response.output_text.delta', {
    type: 'response.output_text.delta',
    response: {
      status: 'completed',
      model: 'gpt-sol-native',
      usage: responsesUsage(20, 8, 10, 4),
    },
  });

const responsesEmbeddedErrorWire = () =>
  // An error in the JSON channel is fatal even when the event name is ordinary.
  responsesEvent('response.output_text.delta', {
    type: 'response.output_text.delta',
    response: {
      status: 'in_progress',
      model: 'gpt-sol-native',
      error: { code: 'server_error', message: 'private upstream diagnostic' },
    },
  });

const responsesMissingUsageWire = () =>
  responsesEvent('response.output_text.delta', {
    type: 'response.output_text.delta',
    response: { status: 'in_progress', model: 'gpt-sol-native' },
    delta: 'Reviewed',
  }) +
  responsesEvent('response.completed', {
    type: 'response.completed',
    response: { status: 'completed', model: 'gpt-sol-native' },
  });

const responsesTerminalSizedWire = (size) => {
  const prefix = 'event: response.completed\ndata: ';
  const suffix = '\n\n';
  const base = {
    type: 'response.completed',
    response: {
      status: 'completed',
      model: 'gpt-sol-native',
      usage: responsesUsage(20, 8, 10, 4),
      output: [{ type: 'message', content: [{ type: 'output_text', text: '' }] }],
    },
  };
  const margin = encoder.encode(prefix + suffix + JSON.stringify(base)).length;
  const padding = size - margin;
  if (padding < 0) throw new Error('terminal size below envelope');
  base.response.output[0].content[0].text = 'x'.repeat(padding);
  return prefix + JSON.stringify(base) + suffix;
};

const responsesUtf8Split = () => {
  const wire =
    responsesEvent('response.output_text.delta', {
      type: 'response.output_text.delta',
      response: { status: 'in_progress', model: 'gpt-sol-native' },
      delta: '审查通过',
    }) +
    responsesEvent('response.completed', {
      type: 'response.completed',
      response: {
        status: 'completed',
        model: 'gpt-sol-native',
        usage: responsesUsage(20, 8, 10, 4),
      },
    });
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

const responsesHeld = () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          responsesEvent('response.output_text.delta', {
            type: 'response.output_text.delta',
            response: { status: 'in_progress', model: 'gpt-sol-native' },
            delta: 'Held',
          }),
        ),
      );
    },
    async pull(controller) {
      await releasePromise;
      if (cancelled) return;
      controller.enqueue(
        encoder.encode(
          responsesEvent('response.completed', {
            type: 'response.completed',
            response: {
              status: 'completed',
              model: 'gpt-sol-native',
              usage: responsesUsage(20, 8, 10, 4),
            },
          }),
        ),
      );
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

const responsesEofWire = () =>
  responsesEvent('response.output_text.delta', {
    type: 'response.output_text.delta',
    response: { status: 'in_progress', model: 'gpt-sol-native' },
    delta: 'Cut',
  });

const responsesUnterminatedWire = (size) =>
  'event: response.output_text.delta\ndata: ' + 'x'.repeat(size);

const successWire = (model) =>
  `data: {"model":"${model}","choices":[{"index":0,"delta":{"content":"Reviewed"},"finish_reason":null}]}\n\n` +
  usageFrame(model) +
  finishFrame() +
  'data: [DONE]\n\n';

const deepseekRejection = (value) =>
  // Verified DeepSeek Chat deserializer envelope:
  // https://github.com/anomalyco/models.dev/issues/3962 (lines 147-151)
  // https://github.com/bytedance/deer-flow/issues/4514
  Response.json(
    {
      error: {
        message:
          'Failed to deserialize the JSON body into the target type: reasoning_effort: ' +
          `unknown variant \`${value}\`, expected one of \`high\`, \`low\`, \`medium\`, \`max\`, \`xhigh\` at line 1 column 26189`,
        type: 'invalid_request_error',
        param: null,
        code: 'invalid_request_error',
      },
    },
    { status: 400 },
  );

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
          // The provider keeps its response open after the protocol terminator.
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

const oversizedChatFrameResponse = (model) =>
  streamResponse(
    `data: ${JSON.stringify({
      model,
      choices: [{ index: 0, delta: { content: 'x'.repeat(5 * 1024 * 1024) }, finish_reason: null }],
    })}\n\n` +
      usageFrame(model) +
      finishFrame() +
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
    if (url.href === 'https://catalog.test/models')
      return Response.json({
        data: [
          { id: 'common' },
          { id: scenario === 'retire-model' ? 'replacement' : 'tool-model' },
        ],
      });
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

    const messages = messagesProtocolStream(scenario, body);
    if (messages !== null) return streamResponse(messages);
    const gemini = geminiProtocolStream(scenario, body);
    if (gemini !== null) return streamResponse(gemini);
    if (scenario === 'effort-report') {
      return streamResponse(
        `data: {"model":"deepseek-native","choices":[],"reasoning_effort":"max"}\n\n` +
          successWire('deepseek-native'),
      );
    }
    if (scenario.startsWith('deepseek-reject')) {
      let parsed = null;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = null;
      }
      const sent = parsed?.reasoning_effort;
      if (scenario === 'deepseek-reject-minimal-delayed') {
        await releasePromise;
        return deepseekRejection(sent ?? 'missing');
      }
      if (scenario === 'deepseek-reject-minimal' && sent !== 'minimal')
        return streamResponse(successWire('deepseek-native'));
      if (scenario === 'deepseek-reject-mismatch') return deepseekRejection('different-value');
      if (scenario === 'deepseek-reject-generic')
        return Response.json({ error: { message: 'bad request' } }, { status: 400 });
      return deepseekRejection(sent ?? 'missing');
    }
    if (scenario === 'other-model-reject') {
      let parsed = null;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = null;
      }
      return deepseekRejection(parsed?.reasoning_effort ?? 'missing');
    }
    if (scenario === 'responses-success') return streamResponse(responsesSuccessWire());
    if (scenario === 'responses-incomplete') return streamResponse(responsesIncompleteWire());
    if (scenario === 'responses-failed') return streamResponse(responsesFailedWire());
    if (scenario === 'responses-error-event') return streamResponse(responsesErrorWire());
    if (scenario === 'responses-mismatched-terminal')
      return streamResponse(responsesMismatchedTerminalWire());
    if (scenario === 'responses-status-only-completed')
      return streamResponse(responsesStatusOnlyCompletedWire());
    if (scenario === 'responses-embedded-error')
      return streamResponse(responsesEmbeddedErrorWire());
    if (scenario === 'responses-missing-usage') return streamResponse(responsesMissingUsageWire());
    if (scenario === 'responses-terminal-size')
      return streamResponse(responsesTerminalSizedWire(terminalBytes));
    if (scenario === 'responses-utf8-split') return responsesUtf8Split();
    if (scenario === 'responses-hold') return responsesHeld();
    if (scenario === 'responses-eof') return streamResponse(responsesEofWire());
    if (scenario === 'responses-unterminated-frame')
      return streamResponse(responsesUnterminatedWire(unterminatedBytes));
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
    if (scenario === 'chat-oversized-frame') return oversizedChatFrameResponse('deepseek-native');
    if (scenario === 'wait-headers') {
      waitingHeaders += 1;
      await releasePromise;
      return streamResponse(successWire('deepseek-native'));
    }
    return streamResponse(successWire('deepseek-native'));
  },
};
