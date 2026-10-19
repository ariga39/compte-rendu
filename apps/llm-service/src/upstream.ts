import { randomUUID } from 'node:crypto';
import { Effect, Schema } from 'effect';
import { EventSourceParserStream } from 'eventsource-parser/stream';
import {
  createProvider,
  type Model,
  type AssistantMessageEventStream,
} from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { opencodeGoProvider } from '@earendil-works/pi-ai/providers/opencode-go';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import {
  prepareChatCompletions,
  prepareResponses,
  usesGrammarTools,
  type PreparedPiRequest,
} from './pi-request.ts';

const providers = {
  'opencode-go': opencodeGoProvider(),
  'openai-codex': openaiCodexProvider(),
  'openai-compatible': createProvider<'openai-completions'>({
    id: 'openai-compatible',
    auth: { apiKey: { name: 'Service-managed API key', resolve: async () => ({ auth: {} }) } },
    models: [],
    api: openAICompletionsApi(),
  }),
};

export interface ModelRoute {
  readonly id: string;
  readonly provider: 'opencode-go' | 'openai-compatible' | 'openai-codex';
  readonly protocol: 'chat-completions' | 'codex-responses';
  readonly model: string;
  readonly baseUrl: string;
}

export interface PiUpstreamOptions {
  readonly routes: readonly ModelRoute[];
  readonly credential: (route: ModelRoute, signal: AbortSignal) => Promise<string>;
  readonly fetch?: typeof globalThis.fetch;
}

const optional = Schema.optionalKey(Schema.Unknown);
const ChatRequest = Schema.Struct({
  model: Schema.String,
  store: Schema.optionalKey(Schema.Literal(false)),
  stream: Schema.Literal(true),
  messages: Schema.Array(Schema.Unknown),
  tools: Schema.optionalKey(
    Schema.Array(Schema.Struct({ type: Schema.Literal('function'), function: Schema.Unknown })),
  ),
  tool_choice: optional,
  parallel_tool_calls: optional,
  temperature: optional,
  top_p: optional,
  max_tokens: optional,
  max_completion_tokens: optional,
  stop: optional,
  frequency_penalty: optional,
  presence_penalty: optional,
  seed: optional,
  stream_options: optional,
  response_format: optional,
  reasoning_effort: optional,
});
const ResponsesRequest = Schema.Struct({
  model: Schema.String,
  stream: Schema.Literal(true),
  input: Schema.Union([Schema.String, Schema.Array(Schema.Unknown)]),
  tools: Schema.optionalKey(
    Schema.Array(
      Schema.Union([
        Schema.Struct({
          type: Schema.Literal('function'),
          name: Schema.String,
          description: optional,
          parameters: optional,
          strict: optional,
        }),
        Schema.Struct({
          type: Schema.Literal('custom'),
          name: Schema.String,
          description: optional,
          format: optional,
        }),
      ]),
    ),
  ),
  instructions: optional,
  tool_choice: optional,
  parallel_tool_calls: optional,
  reasoning: optional,
  store: Schema.optionalKey(Schema.Literal(false)),
  include: optional,
  prompt_cache_key: optional,
  text: optional,
  client_metadata: optional,
  max_output_tokens: optional,
  temperature: optional,
  top_p: optional,
  service_tier: optional,
});

const failure = () =>
  Response.json({ error: { message: 'model request failed' } }, { status: 502 });

export const createPiUpstream = (options: PiUpstreamOptions) => {
  const run = Effect.fn('LlmUpstream.request')(
    function* (
      routeId: string,
      body: Record<string, unknown>,
      signal: AbortSignal,
      sessionId?: string,
    ) {
      const route = options.routes.find((candidate) => candidate.id === routeId);
      if (!route || (route.provider === 'opencode-go' && !sessionId)) return failure();
      const valid = yield* Schema.decodeUnknownEffect(
        route.protocol === 'chat-completions' ? ChatRequest : ResponsesRequest,
        { onExcessProperty: 'error' },
      )(body).pipe(Effect.match({ onSuccess: () => true, onFailure: () => false }));
      if (!valid)
        return Response.json({ error: { message: 'unsupported model request' } }, { status: 400 });
      let prepared: PreparedPiRequest;
      try {
        prepared =
          route.protocol === 'chat-completions'
            ? prepareChatCompletions(
                { provider: route.provider, api: 'openai-completions', model: route.model },
                body,
              )
            : prepareResponses(
                { provider: route.provider, api: 'openai-codex-responses', model: route.model },
                body,
              );
      } catch {
        return Response.json({ error: { message: 'unsupported model request' } }, { status: 400 });
      }
      const diagnostic = requestDiagnostic(route, sessionId, signal);
      return yield* Effect.tryPromise(async () => {
        const key = await options.credential(route, signal);
        return relay(
          route,
          prepared,
          body,
          key,
          signal,
          options.fetch ?? globalThis.fetch,
          diagnostic,
          sessionId,
        );
      }).pipe(
        Effect.catch(() => {
          diagnostic.finish('credential-or-request-failure');
          return Effect.succeed(failure());
        }),
      );
    },
    Effect.catch(() => Effect.succeed(failure())),
  );
  return (route: string, body: Record<string, unknown>, signal: AbortSignal, sessionId?: string) =>
    Effect.runPromise(
      run(route, body, AbortSignal.any([signal, AbortSignal.timeout(120000)]), sessionId),
    );
};

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
  | 'service-timeout'
  | 'provider-error';

const requestDiagnostic = (route: ModelRoute, jobId: string | undefined, signal: AbortSignal) => {
  const startedAt = Date.now();
  const identity = {
    requestId: randomUUID(),
    jobId: jobId ?? null,
    route: route.id,
    provider: route.provider,
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
      const finalOutcome = signal.aborted
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
  route: ModelRoute,
  prepared: PreparedPiRequest,
  body: Record<string, unknown>,
  key: string,
  signal: AbortSignal,
  fetchUpstream: typeof globalThis.fetch,
  diagnostic: ReturnType<typeof requestDiagnostic>,
  sessionId?: string,
): Promise<Response> =>
  new Promise((resolve) => {
    const controller = new AbortController();
    const abort = () => {
      diagnostic.finish('request-aborted');
      controller.abort();
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const model = {
      id: route.model,
      name: route.model,
      provider: route.provider,
      baseUrl: route.baseUrl,
      reasoning: true,
      input: ['text', 'image'],
      contextWindow: 0,
      maxTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    } satisfies Omit<Model<'openai-completions'>, 'api'>;
    let completed = false;
    let settled = false;
    let parserDone: Promise<void>;
    const settle = (response: Response) => {
      if (!settled) {
        settled = true;
        resolve(response);
      }
    };
    const stop = () => {
      signal.removeEventListener('abort', abort);
      controller.abort();
    };
    let streamOutcome: StreamOutcome = 'upstream-stream-error';
    let upstreamEof = false;
    const intercept: typeof globalThis.fetch = async (url, init) => {
      const upstream = await fetchUpstream(url, {
        ...init,
        signal: AbortSignal.any([controller.signal, ...(init?.signal ? [init.signal] : [])]),
        redirect: 'error',
      }).catch(() => {
        diagnostic.finish(
          init?.signal?.aborted ? 'provider-request-aborted' : 'upstream-fetch-error',
        );
        throw new Error('upstream request failed');
      });
      diagnostic.state.upstreamStatus = upstream.status;
      if (!upstream.ok || !upstream.body) {
        diagnostic.finish('upstream-http-error');
        await upstream.body?.cancel();
        settle(failure());
        throw new Error('upstream rejected request');
      }
      let received = 0;
      const decoder = new TextDecoder();
      const wire = upstream.body
        .pipeThrough(
          new TransformStream<Uint8Array, string>({
            transform(chunk, output) {
              received += chunk.byteLength;
              diagnostic.state.receivedBytes = received;
              if (received > 16 * 1024 * 1024) {
                streamOutcome = 'stream-too-large';
                throw new Error('model stream too large');
              }
              output.enqueue(decoder.decode(chunk, { stream: true }));
            },
          }),
        )
        .pipeThrough(new EventSourceParserStream())
        .pipeThrough(
          new TransformStream({
            transform(event, output) {
              if (event.event === 'error' || event.event === 'response.failed') {
                streamOutcome = 'upstream-error-event';
                throw new Error('upstream error');
              }
              if (event.data === '[DONE]') diagnostic.state.doneMarker = true;
              if (event.data !== '[DONE]') {
                streamOutcome = 'invalid-stream';
                const decoded = Schema.decodeUnknownSync(
                  Schema.fromJsonString(
                    Schema.Struct({
                      type: Schema.optionalKey(Schema.String),
                      choices: Schema.optionalKey(
                        Schema.Array(
                          Schema.Struct({
                            finish_reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
                          }),
                        ),
                      ),
                      error: Schema.optionalKey(Schema.Unknown),
                      response: Schema.optionalKey(
                        Schema.Struct({ status: Schema.optionalKey(Schema.String) }),
                      ),
                    }),
                  ),
                )(event.data);
                streamOutcome = 'upstream-stream-error';
                if (
                  decoded.choices?.some((choice) => choice.finish_reason != null) ||
                  decoded.type === 'response.completed'
                )
                  diagnostic.state.finishMarker = true;
                if (
                  decoded.error != null ||
                  decoded.type === 'error' ||
                  decoded.type === 'response.failed' ||
                  decoded.response?.status === 'failed'
                ) {
                  streamOutcome = 'upstream-error-event';
                  throw new Error('upstream error');
                }
              }
              const frame =
                (event.event ? `event: ${event.event}\n` : '') +
                event.data
                  .split('\n')
                  .map((line) => `data: ${line}\n`)
                  .join('') +
                '\n';
              output.enqueue(new TextEncoder().encode(frame));
            },
          }),
        );
      const reader = wire.getReader();
      const parser = new TransformStream<Uint8Array, Uint8Array>();
      const writer = parser.writable.getWriter();
      const downstream = new ReadableStream<Uint8Array>({
        async pull(output) {
          try {
            const next = await reader.read();
            if (next.done) {
              upstreamEof = true;
              await writer.close().catch(() => undefined);
              await parserDone;
              if (!completed) throw new Error('incomplete model stream');
              diagnostic.finish('completed');
              output.close();
              stop();
              return;
            }
            await writer.write(next.value).catch((error: unknown) => {
              if (!completed) throw error;
            });
            output.enqueue(next.value);
          } catch {
            diagnostic.finish(
              upstreamEof
                ? 'incomplete-stream'
                : init?.signal?.aborted
                  ? 'provider-request-aborted'
                  : streamOutcome,
            );
            stop();
            await reader.cancel().catch(() => undefined);
            await writer.abort().catch(() => undefined);
            output.error(new Error('model stream failed'));
          }
        },
        async cancel() {
          diagnostic.finish('client-cancelled');
          stop();
          await reader.cancel().catch(() => undefined);
          await writer.abort().catch(() => undefined);
        },
      });
      settle(
        new Response(downstream, {
          headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
        }),
      );
      return new Response(parser.readable, { headers: { 'content-type': 'text/event-stream' } });
    };
    const settings = {
      apiKey: key,
      sessionId,
      signal: controller.signal,
      fetch: intercept,
      maxRetries: 0,
      timeoutMs: 120000,
      ...prepared.options,
      ...(prepared.patch === undefined
        ? {}
        : { onPayload: (payload: unknown) => prepared.patch!(payload as Record<string, unknown>) }),
    };
    const context = prepared.context;
    const chatModel = {
      ...model,
      api: 'openai-completions',
      compat: { supportsDeveloperRole: false },
    } satisfies Model<'openai-completions'>;
    const codexModel = {
      ...model,
      api: 'openai-codex-responses',
      ...(usesGrammarTools(body) ? { compat: { supportsOpenAIGrammarTools: true } } : {}),
    } satisfies Model<'openai-codex-responses'>;
    const events: AssistantMessageEventStream =
      route.provider === 'opencode-go'
        ? providers['opencode-go'].stream(chatModel, context, settings)
        : route.provider === 'openai-compatible'
          ? providers['openai-compatible'].stream(chatModel, context, settings)
          : providers['openai-codex'].stream(codexModel, context, {
              ...settings,
              transport: 'sse',
            });
    parserDone = (async () => {
      for await (const event of events) {
        if (event.type === 'done') completed = true;
        if (event.type === 'error') {
          if (!settled) diagnostic.finish('provider-error');
          settle(failure());
        }
      }
      if (!settled) {
        diagnostic.finish('provider-error');
        settle(failure());
        stop();
      }
    })();
    void parserDone.catch(() => {
      diagnostic.finish('provider-error');
      settle(failure());
      stop();
    });
  });
