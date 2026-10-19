import { randomUUID } from 'node:crypto';
import { Effect, Option, Schema } from 'effect';
import { EventSourceParserStream } from 'eventsource-parser/stream';
import type { UpstreamUsage } from './usage.js';

const REQUEST_TIMEOUT_MS = 120_000;
const MAX_STREAM_BYTES = 16 * 1024 * 1024;

const optional = Schema.optionalKey(Schema.Unknown);
const ChatFunction = Schema.StructWithRest(Schema.Struct({ name: Schema.String }), [
  Schema.Record(Schema.String, Schema.Unknown),
]);
const ChatTool = Schema.StructWithRest(
  Schema.Struct({ type: Schema.Literal('function'), function: ChatFunction }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
const ResponsesTool = Schema.StructWithRest(
  Schema.Struct({ type: Schema.Literals(['function', 'custom']), name: Schema.String }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
const ChatRequest = Schema.Struct({
  model: Schema.String,
  messages: Schema.Array(Schema.Unknown),
  stream: optional,
  store: optional,
  tools: Schema.optionalKey(Schema.Array(ChatTool)),
  tool_choice: optional,
  parallel_tool_calls: optional,
  temperature: optional,
  top_p: optional,
  n: optional,
  max_tokens: optional,
  max_completion_tokens: optional,
  stop: optional,
  frequency_penalty: optional,
  presence_penalty: optional,
  seed: optional,
  stream_options: optional,
  response_format: optional,
  reasoning_effort: optional,
  reasoning: optional,
  verbosity: optional,
  logprobs: optional,
  top_logprobs: optional,
  logit_bias: optional,
  user: optional,
  service_tier: optional,
  prompt_cache_key: optional,
  modalities: optional,
  audio: optional,
  prediction: optional,
});
const ResponsesRequest = Schema.Struct({
  model: Schema.String,
  input: Schema.Union([Schema.String, Schema.Array(Schema.Unknown)]),
  instructions: optional,
  stream: optional,
  store: optional,
  tools: Schema.optionalKey(Schema.Array(ResponsesTool)),
  tool_choice: optional,
  parallel_tool_calls: optional,
  temperature: optional,
  top_p: optional,
  max_output_tokens: optional,
  reasoning: optional,
  text: optional,
  include: optional,
  prompt_cache_key: optional,
  service_tier: optional,
  client_metadata: optional,
  previous_response_id: optional,
  conversation: optional,
  truncation: optional,
  user: optional,
  background: optional,
  safety_identifier: optional,
  max_tool_calls: optional,
});

const ChatChoice = Schema.Struct({
  finish_reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const TokenNumber = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const ChatUsageDetails = Schema.StructWithRest(
  Schema.Struct({
    cached_tokens: Schema.optionalKey(Schema.NullOr(TokenNumber)),
    cache_write_tokens: Schema.optionalKey(Schema.NullOr(TokenNumber)),
    cache_creation_input_tokens: Schema.optionalKey(Schema.NullOr(TokenNumber)),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
const ChatCompletionDetails = Schema.StructWithRest(
  Schema.Struct({ reasoning_tokens: Schema.optionalKey(Schema.NullOr(TokenNumber)) }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
const ChatUsage = Schema.Struct({
  prompt_tokens: Schema.optionalKey(Schema.NullOr(TokenNumber)),
  completion_tokens: Schema.optionalKey(Schema.NullOr(TokenNumber)),
  total_tokens: Schema.optionalKey(Schema.NullOr(TokenNumber)),
  prompt_tokens_details: Schema.optionalKey(Schema.NullOr(ChatUsageDetails)),
  completion_tokens_details: Schema.optionalKey(Schema.NullOr(ChatCompletionDetails)),
});
const ResponsesUsageDetails = Schema.StructWithRest(
  Schema.Struct({
    cached_tokens: Schema.optionalKey(Schema.NullOr(TokenNumber)),
    cache_write_tokens: Schema.optionalKey(Schema.NullOr(TokenNumber)),
    cache_creation_input_tokens: Schema.optionalKey(Schema.NullOr(TokenNumber)),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
const ResponsesOutputDetails = Schema.StructWithRest(
  Schema.Struct({ reasoning_tokens: Schema.optionalKey(Schema.NullOr(TokenNumber)) }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
const ResponsesUsage = Schema.Struct({
  input_tokens: Schema.optionalKey(Schema.NullOr(TokenNumber)),
  output_tokens: Schema.optionalKey(Schema.NullOr(TokenNumber)),
  total_tokens: Schema.optionalKey(Schema.NullOr(TokenNumber)),
  input_tokens_details: Schema.optionalKey(Schema.NullOr(ResponsesUsageDetails)),
  output_tokens_details: Schema.optionalKey(Schema.NullOr(ResponsesOutputDetails)),
});
const StreamFrame = Schema.Struct({
  type: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.Unknown),
  choices: Schema.optionalKey(Schema.Array(ChatChoice)),
  usage: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Unknown),
  response: Schema.optionalKey(
    Schema.Struct({
      status: Schema.optionalKey(Schema.String),
      model: Schema.optionalKey(Schema.Unknown),
      usage: Schema.optionalKey(Schema.Unknown),
    }),
  ),
});
const decodeFrame = Schema.decodeUnknownOption(Schema.fromJsonString(StreamFrame));
const SafeModel = Schema.String.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9._:/-]+$/),
);
const modelIdentity = (value: unknown): string | null =>
  Option.getOrUndefined(Schema.decodeUnknownOption(SafeModel)(value)) ?? null;

type ObservedTokens = {
  -readonly [K in Exclude<keyof UpstreamUsage, 'model' | 'complete'>]?: number;
};

const put = (
  target: ObservedTokens,
  key: Exclude<keyof UpstreamUsage, 'model' | 'complete'>,
  value: number | null | undefined,
): void => {
  if (value !== null && value !== undefined) target[key] = value;
};

const responsesUsage = (value: unknown): ObservedTokens => {
  const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(ResponsesUsage)(value));
  const observed: ObservedTokens = {};
  if (decoded === undefined) return observed;
  put(observed, 'inputTokens', decoded.input_tokens);
  put(observed, 'cacheReadTokens', decoded.input_tokens_details?.cached_tokens);
  put(
    observed,
    'cacheWriteTokens',
    decoded.input_tokens_details?.cache_write_tokens ??
      decoded.input_tokens_details?.cache_creation_input_tokens,
  );
  put(observed, 'outputTokens', decoded.output_tokens);
  put(observed, 'reasoningTokens', decoded.output_tokens_details?.reasoning_tokens);
  return observed;
};

const chatUsage = (value: unknown): ObservedTokens => {
  const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(ChatUsage)(value));
  const observed: ObservedTokens = {};
  if (decoded === undefined) return observed;
  put(observed, 'inputTokens', decoded.prompt_tokens);
  put(observed, 'cacheReadTokens', decoded.prompt_tokens_details?.cached_tokens);
  put(
    observed,
    'cacheWriteTokens',
    decoded.prompt_tokens_details?.cache_write_tokens ??
      decoded.prompt_tokens_details?.cache_creation_input_tokens,
  );
  put(observed, 'outputTokens', decoded.completion_tokens);
  put(observed, 'reasoningTokens', decoded.completion_tokens_details?.reasoning_tokens);
  return observed;
};

export interface LiteLlmRoute {
  readonly id: string;
  readonly model: string;
  readonly protocol: 'chat-completions' | 'responses';
}

export interface LiteLlmUpstreamOptions {
  readonly baseUrl: string;
  readonly routes: readonly LiteLlmRoute[];
  readonly credential: () => Promise<string>;
  readonly fetch?: typeof globalThis.fetch;
}

const failure = () =>
  Response.json({ error: { message: 'model request failed' } }, { status: 502 });

const unsupported = () =>
  Response.json({ error: { message: 'unsupported model request' } }, { status: 400 });

const endpoint = (baseUrl: string, protocol: LiteLlmRoute['protocol']): string =>
  `${baseUrl.replace(/\/+$/, '')}/v1/${
    protocol === 'chat-completions' ? 'chat/completions' : 'responses'
  }`;

type StreamOutcome =
  | 'completed'
  | 'credential-or-request-failure'
  | 'upstream-http-error'
  | 'provider-request-aborted'
  | 'upstream-fetch-error'
  | 'upstream-stream-error'
  | 'upstream-error-event'
  | 'invalid-stream'
  | 'stream-too-large'
  | 'incomplete-stream'
  | 'client-cancelled'
  | 'request-aborted'
  | 'service-timeout';

const requestDiagnostic = (route: LiteLlmRoute, jobId: string | undefined, signal: AbortSignal) => {
  const startedAt = Date.now();
  const identity = {
    requestId: randomUUID(),
    jobId: jobId ?? null,
    route: route.id,
    protocol: route.protocol,
  };
  const state = {
    receivedBytes: 0,
    upstreamStatus: null as number | null,
    finishMarker: false,
    doneMarker: false,
  };
  let finished = false;
  Effect.runSync(Effect.logInfo('llm.request.started', identity));
  return {
    state,
    finish(outcome: StreamOutcome) {
      if (finished) return;
      finished = true;
      const finalOutcome =
        outcome === 'completed'
          ? 'completed'
          : signal.aborted
            ? signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError'
              ? 'service-timeout'
              : 'request-aborted'
            : outcome;
      Effect.runSync(
        Effect.logInfo('llm.request.finished', {
          ...identity,
          ...state,
          durationMs: Date.now() - startedAt,
          outcome: finalOutcome,
        }),
      );
    },
  };
};

const relay = (
  baseUrl: string,
  route: LiteLlmRoute,
  body: Record<string, unknown>,
  key: string,
  signal: AbortSignal,
  fetchUpstream: typeof globalThis.fetch,
  diagnostic: ReturnType<typeof requestDiagnostic>,
  sessionId: string | undefined,
  observe: ((usage: UpstreamUsage) => void) | undefined,
): Promise<Response> =>
  new Promise((resolve) => {
    const controller = new AbortController();
    let settled = false;
    const settle = (response: Response) => {
      if (settled) return;
      settled = true;
      resolve(response);
    };
    let usage: UpstreamUsage = {
      model: null,
      inputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      complete: false,
    };
    let observed = false;
    const observeOnce = (complete: boolean) => {
      if (observed) return;
      observed = true;
      if (observe === undefined) return;
      try {
        observe({ ...usage, complete });
      } catch {
        /* Telemetry is optional and never changes model behavior. */
      }
    };
    const stop = () => {
      signal.removeEventListener('abort', onAbort);
      controller.abort();
    };
    const reachedTerminal = () =>
      route.protocol === 'chat-completions'
        ? diagnostic.state.finishMarker && diagnostic.state.doneMarker
        : diagnostic.state.finishMarker;
    const onAbort = () => {
      const complete = reachedTerminal();
      diagnostic.finish(complete ? 'completed' : 'request-aborted');
      observeOnce(complete);
      stop();
      settle(failure());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }

    const headers: Record<string, string> = {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
    };
    if (sessionId !== undefined) {
      headers['x-opencode-session'] = sessionId;
      headers.session_id = sessionId;
    }
    const payload = { ...body, model: route.model, store: false, stream: true };

    void (async () => {
      try {
        let upstream: Response;
        try {
          upstream = await fetchUpstream(endpoint(baseUrl, route.protocol), {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal: AbortSignal.any([controller.signal, signal]),
            redirect: 'error',
          });
        } catch {
          diagnostic.finish(
            controller.signal.aborted ? 'provider-request-aborted' : 'upstream-fetch-error',
          );
          observeOnce(false);
          stop();
          settle(failure());
          return;
        }
        const deploymentModel = modelIdentity(upstream.headers.get('x-litellm-model-name'));
        if (deploymentModel !== null) usage = { ...usage, model: deploymentModel };
        diagnostic.state.upstreamStatus = upstream.status;
        if (!upstream.ok || upstream.body === null) {
          diagnostic.finish('upstream-http-error');
          observeOnce(false);
          stop();
          await upstream.body?.cancel().catch(() => undefined);
          settle(failure());
          return;
        }

        let received = 0;
        let streamOutcome: StreamOutcome = 'upstream-stream-error';
        const decoder = new TextDecoder();
        const reader = upstream.body
          .pipeThrough(
            new TransformStream<Uint8Array, string>({
              transform(chunk, output) {
                received += chunk.byteLength;
                diagnostic.state.receivedBytes = received;
                if (received > MAX_STREAM_BYTES) {
                  streamOutcome = 'stream-too-large';
                  throw new Error('model stream too large');
                }
                output.enqueue(decoder.decode(chunk, { stream: true }));
              },
              flush(output) {
                const tail = decoder.decode();
                if (tail.length > 0) output.enqueue(tail);
              },
            }),
          )
          .pipeThrough(new EventSourceParserStream())
          .getReader();

        const complete = reachedTerminal;

        const bodyStream = new ReadableStream<Uint8Array>(
          {
            async pull(output) {
              let next: Awaited<ReturnType<typeof reader.read>>;
              try {
                next = await reader.read();
              } catch {
                diagnostic.finish(
                  controller.signal.aborted ? 'provider-request-aborted' : streamOutcome,
                );
                observeOnce(false);
                stop();
                output.error(new Error('model stream failed'));
                return;
              }
              if (next.done) {
                if (!complete()) {
                  diagnostic.finish('incomplete-stream');
                  observeOnce(false);
                  stop();
                  output.error(new Error('model stream failed'));
                  return;
                }
                diagnostic.finish('completed');
                observeOnce(true);
                stop();
                output.close();
                return;
              }
              const event = next.value;
              try {
                const errorEvent = event.event === 'error' || event.event === 'response.failed';
                if (event.data === '[DONE]' && !errorEvent) {
                  diagnostic.state.doneMarker = true;
                } else {
                  const decoded = decodeFrame(event.data);
                  if (Option.isNone(decoded)) {
                    streamOutcome = errorEvent ? 'upstream-error-event' : 'invalid-stream';
                    throw new Error(errorEvent ? 'upstream error' : 'invalid stream');
                  }
                  const frame = decoded.value;
                  if (route.protocol === 'chat-completions') {
                    const model = modelIdentity(frame.model);
                    if (deploymentModel === null && model !== null) usage = { ...usage, model };
                    usage = { ...usage, ...chatUsage(frame.usage) };
                    if (frame.choices?.some((choice) => choice.finish_reason != null) === true)
                      diagnostic.state.finishMarker = true;
                  } else {
                    const model = modelIdentity(frame.response?.model);
                    if (deploymentModel === null && model !== null) usage = { ...usage, model };
                    usage = { ...usage, ...responsesUsage(frame.response?.usage) };
                    if (
                      frame.type === 'response.completed' ||
                      frame.type === 'response.incomplete'
                    ) {
                      diagnostic.state.finishMarker = true;
                    }
                  }
                  if (
                    errorEvent ||
                    frame.error != null ||
                    frame.type === 'error' ||
                    frame.type === 'response.failed' ||
                    frame.response?.status === 'failed'
                  ) {
                    streamOutcome = 'upstream-error-event';
                    throw new Error('upstream error');
                  }
                }
                const frame =
                  (event.event === undefined ? '' : `event: ${event.event}\n`) +
                  event.data
                    .split('\n')
                    .map((line) => `data: ${line}\n`)
                    .join('') +
                  '\n';
                output.enqueue(new TextEncoder().encode(frame));
              } catch {
                diagnostic.finish(streamOutcome);
                observeOnce(false);
                stop();
                await reader.cancel().catch(() => undefined);
                output.error(new Error('model stream failed'));
              }
            },
            async cancel() {
              const complete = reachedTerminal();
              diagnostic.finish(complete ? 'completed' : 'client-cancelled');
              observeOnce(complete);
              stop();
              await reader.cancel().catch(() => undefined);
            },
          },
          { highWaterMark: 0 },
        );

        settle(
          new Response(bodyStream, {
            headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
          }),
        );
      } catch {
        diagnostic.finish(
          controller.signal.aborted ? 'provider-request-aborted' : 'upstream-fetch-error',
        );
        observeOnce(false);
        stop();
        settle(failure());
      }
    })();
  });

export const createLiteLlmUpstream = (options: LiteLlmUpstreamOptions) => {
  const run = Effect.fn('LiteLlmUpstream.request')(
    function* (
      routeId: string,
      body: Record<string, unknown>,
      signal: AbortSignal,
      sessionId?: string,
      observe?: (usage: UpstreamUsage) => void,
    ) {
      const route = options.routes.find((candidate) => candidate.id === routeId);
      if (route === undefined) return failure();
      const valid = yield* Schema.decodeUnknownEffect(
        route.protocol === 'chat-completions' ? ChatRequest : ResponsesRequest,
        { onExcessProperty: 'error' },
      )(body).pipe(
        Effect.match({
          onSuccess: () => true,
          onFailure: () => false,
        }),
      );
      if (!valid) return unsupported();
      const diagnostic = requestDiagnostic(route, sessionId, signal);
      const key = yield* Effect.tryPromise({
        try: () => options.credential(),
        catch: () => undefined,
      }).pipe(
        Effect.match({
          onSuccess: (value) => value,
          onFailure: () => undefined,
        }),
      );
      if (key === undefined || key.trim().length === 0) {
        diagnostic.finish('credential-or-request-failure');
        try {
          observe?.({
            model: null,
            inputTokens: null,
            cacheReadTokens: null,
            cacheWriteTokens: null,
            outputTokens: null,
            reasoningTokens: null,
            complete: false,
          });
        } catch {
          /* Telemetry is optional and never changes model behavior. */
        }
        return failure();
      }
      return yield* Effect.tryPromise({
        try: () =>
          relay(
            options.baseUrl,
            route,
            body,
            key.trim(),
            signal,
            options.fetch ?? globalThis.fetch,
            diagnostic,
            sessionId,
            observe,
          ),
        catch: () => undefined,
      }).pipe(
        Effect.match({
          onSuccess: (response) => response,
          onFailure: () => {
            diagnostic.finish('credential-or-request-failure');
            try {
              observe?.({
                model: null,
                inputTokens: null,
                cacheReadTokens: null,
                cacheWriteTokens: null,
                outputTokens: null,
                reasoningTokens: null,
                complete: false,
              });
            } catch {
              /* Telemetry is optional and never changes model behavior. */
            }
            return failure();
          },
        }),
      );
    },
    Effect.catch(() => Effect.succeed(failure())),
  );

  return (
    routeId: string,
    body: Record<string, unknown>,
    signal: AbortSignal,
    sessionId?: string,
    observe?: (usage: UpstreamUsage) => void,
  ) =>
    Effect.runPromise(
      run(
        routeId,
        body,
        AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        sessionId,
        observe,
      ),
    );
};
