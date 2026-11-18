import { randomUUID } from 'node:crypto';
import { Effect, Option, Schema } from 'effect';
import { EventSourceParserStream } from 'eventsource-parser/stream';
import type { UpstreamUsage } from './usage.js';
import {
  ChatRequest,
  ResponsesRequest,
  decodeStreamFrame,
  modelIdentity,
  streamEventIsError,
  streamFrameIsError,
  streamFrameModel,
  streamFrameTerminal,
  streamFrameUsage,
} from '@compte-rendu/contracts';

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

const failure = (status = 502) =>
  Response.json({ error: { message: 'model request failed' } }, { status });

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
  | 'incomplete-stream'
  | 'client-cancelled'
  | 'request-aborted';

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
        outcome === 'completed' ? 'completed' : signal.aborted ? 'request-aborted' : outcome;
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
          settle(failure(upstream.status >= 400 && upstream.status <= 599 ? upstream.status : 502));
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
                const errorEvent = streamEventIsError(event.event);
                if (event.data === '[DONE]' && !errorEvent) {
                  diagnostic.state.doneMarker = true;
                } else {
                  const decoded = decodeStreamFrame(event.data);
                  if (Option.isNone(decoded)) {
                    streamOutcome = errorEvent ? 'upstream-error-event' : 'invalid-stream';
                    throw new Error(errorEvent ? 'upstream error' : 'invalid stream');
                  }
                  const frame = decoded.value;
                  const model = streamFrameModel(frame, route.protocol);
                  if (deploymentModel === null && model !== null) usage = { ...usage, model };
                  usage = { ...usage, ...streamFrameUsage(frame, route.protocol) };
                  if (streamFrameTerminal(frame, route.protocol)) {
                    diagnostic.state.finishMarker = true;
                  }
                  if (errorEvent || streamFrameIsError(frame)) {
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
  ) => Effect.runPromise(run(routeId, body, signal, sessionId, observe));
};
