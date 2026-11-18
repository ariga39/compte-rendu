import { Effect, Option, Schema } from 'effect';
import {
  ChatRequest,
  decodeStreamFrame,
  streamEventIsError,
  streamFrameIsError,
  streamFrameModel,
  streamFrameTerminal,
  streamFrameUsage,
  type UpstreamUsage,
} from '@compte-rendu/contracts';
import { EventSourceParserStream } from 'eventsource-parser/stream';
import { finalizeComplete, savePartial, type AuthenticatedGrant } from './ledger.ts';
import type { D1DatabaseLike } from './grants.ts';
import type { FrozenRoute } from './routes.ts';
import { gatewayHeaders, gatewayUrl, type GatewayConfig } from './gateway';
export type { GatewayConfig } from './gateway';

const CHAT_PATH = '/v1/chat/completions';
const GATEWAY_PATH = '/chat/completions';
const MAX_HELD_FRAMES = 32;
const MAX_HELD_BYTES = 64 * 1024;

export interface InferenceRelayOptions {
  readonly database: D1DatabaseLike;
  readonly requestId: string;
  readonly gateway: GatewayConfig;
  readonly grant: AuthenticatedGrant;
  readonly route: FrozenRoute;
  readonly body: Record<string, unknown>;
  readonly request: Request;
  readonly waitUntil: (task: Promise<unknown>) => void;
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

const failure = (status = 502): Response =>
  Response.json(
    { error: { message: 'model request failed' } },
    { status, headers: { 'cache-control': 'no-store' } },
  );

const frameBytes = (event: { readonly event?: string; readonly data: string }): Uint8Array => {
  const frame =
    (event.event === undefined ? '' : `event: ${event.event}\n`) +
    event.data
      .split('\n')
      .map((line) => `data: ${line}\n`)
      .join('') +
    '\n';
  return new TextEncoder().encode(frame);
};

const headersFor = (gateway: GatewayConfig, grant: AuthenticatedGrant, route: FrozenRoute) => ({
  'content-type': 'application/json',
  accept: 'text/event-stream',
  ...gatewayHeaders(gateway, route.credentialAlias),
  'x-opencode-session': grant.jobId,
  session_id: grant.jobId,
});

export const isChatCompletionPath = (pathname: string): boolean => pathname === CHAT_PATH;

export const relayInference = (options: InferenceRelayOptions): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const { database, requestId, gateway, grant, route, body, request, waitUntil } = options;
    const fetchUpstream = options.fetch ?? globalThis.fetch;
    const controller = new AbortController();
    const usage: { -readonly [K in keyof UpstreamUsage]: UpstreamUsage[K] } = {
      model: null,
      inputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      complete: false,
    };
    let reader: ReadableStreamDefaultReader<{ event?: string; data: string }> | null = null;
    let downstream: ReadableStreamDefaultController<Uint8Array> | null = null;
    let finalized = false;
    let failureStarted = false;
    let completed = false;
    let closed = false;
    let finishMarker = false;
    let doneMarker = false;
    let terminalBytes = 0;
    const terminal: Uint8Array[] = [];

    const cleanup = () => {
      clearTimeout(expiryTimer);
      request.signal.removeEventListener('abort', onRequestAbort);
    };
    const finishOnce = async (complete: boolean) => {
      if (finalized) return;
      finalized = true;
      usage.complete = complete;
      try {
        if (complete) await finalizeComplete(database, requestId, usage);
        else await savePartial(database, requestId, usage);
      } catch {
        await Effect.runPromise(Effect.logWarning('relay.accounting.failed'));
      }
    };
    const cancelUpstream = async () => {
      await reader?.cancel().catch(() => undefined);
    };
    const teardown = async () => {
      cleanup();
      controller.abort(new Error('inference request stopped'));
      await cancelUpstream();
      if (!closed) {
        closed = true;
        downstream?.error(new Error('model stream failed'));
      }
    };
    const failStream = async () => {
      if (finalized || completed) return;
      failureStarted = true;
      await finishOnce(false);
      await teardown();
    };
    const onRequestAbort = () => {
      waitUntil(failStream());
    };
    const expiryTimer = setTimeout(
      () => {
        waitUntil(failStream());
      },
      Math.max(0, grant.expiresAt - Date.now()),
    ) as ReturnType<typeof setTimeout> & { unref?: () => void };
    expiryTimer.unref?.();
    request.signal.addEventListener('abort', onRequestAbort, { once: true });
    if (request.signal.aborted) onRequestAbort();

    const upstream = yield* Effect.tryPromise({
      try: () =>
        fetchUpstream(gatewayUrl(gateway, route.providerSlug, GATEWAY_PATH), {
          method: 'POST',
          headers: headersFor(gateway, grant, route),
          body: JSON.stringify({ ...body, model: route.upstreamModel, store: false, stream: true }),
          signal: controller.signal,
          redirect: 'manual',
        }),
      catch: () => undefined,
    }).pipe(
      Effect.match({
        onSuccess: (response) => response,
        onFailure: () => null,
      }),
    );
    if (upstream === null) {
      cleanup();
      yield* Effect.promise(() => finishOnce(false));
      return failure();
    }
    if (failureStarted) {
      cleanup();
      yield* Effect.promise(
        () => upstream.body?.cancel().catch(() => undefined) ?? Promise.resolve(),
      );
      return failure();
    }
    if (upstream.type === 'opaqueredirect' || (upstream.status >= 300 && upstream.status <= 399)) {
      cleanup();
      yield* Effect.promise(
        () => upstream.body?.cancel().catch(() => undefined) ?? Promise.resolve(),
      );
      yield* Effect.promise(() => finishOnce(false));
      return failure();
    }
    if (!upstream.ok || upstream.body === null) {
      cleanup();
      yield* Effect.promise(
        () => upstream.body?.cancel().catch(() => undefined) ?? Promise.resolve(),
      );
      yield* Effect.promise(() => finishOnce(false));
      return failure(upstream.status >= 400 && upstream.status <= 599 ? upstream.status : 502);
    }

    const decoder = new TextDecoder();
    const measure = new TransformStream<Uint8Array, string>({
      transform(chunk, output) {
        output.enqueue(decoder.decode(chunk, { stream: true }));
      },
      flush(output) {
        const tail = decoder.decode();
        if (tail.length > 0) output.enqueue(tail);
      },
    });
    reader = upstream.body
      .pipeThrough(measure)
      .pipeThrough(new EventSourceParserStream())
      .getReader();

    const reachedTerminal = () => finishMarker && doneMarker;
    const holdTerminal = (chunk: Uint8Array): boolean => {
      if (terminal.length >= MAX_HELD_FRAMES || terminalBytes + chunk.byteLength > MAX_HELD_BYTES)
        return false;
      terminal.push(chunk);
      terminalBytes += chunk.byteLength;
      return true;
    };
    const flushTerminal = (output: ReadableStreamDefaultController<Uint8Array>) => {
      for (const chunk of terminal) output.enqueue(chunk);
      terminal.length = 0;
      terminalBytes = 0;
    };
    const completeStream = async (output: ReadableStreamDefaultController<Uint8Array>) => {
      if (failureStarted) return;
      completed = true;
      await finishOnce(true);
      cleanup();
      flushTerminal(output);
      closed = true;
      output.close();
    };

    const responseBody = new ReadableStream<Uint8Array>(
      {
        start(output) {
          downstream = output;
        },
        async pull(output) {
          if (completed) return;
          for (;;) {
            let next: Awaited<ReturnType<NonNullable<typeof reader>['read']>>;
            try {
              next = await reader!.read();
            } catch {
              await failStream();
              return;
            }
            if (next.done) {
              if (reachedTerminal()) {
                await completeStream(output);
              } else {
                await failStream();
              }
              return;
            }
            const event = next.value;
            const errorEvent = streamEventIsError(event.event);
            if (event.data === '[DONE]' && !errorEvent) {
              doneMarker = true;
              if (!holdTerminal(frameBytes(event))) {
                await failStream();
                return;
              }
              if (reachedTerminal()) {
                await completeStream(output);
                return;
              }
              continue;
            }
            const decoded = decodeStreamFrame(event.data);
            if (Option.isNone(decoded)) {
              await failStream();
              return;
            }
            const frame = decoded.value;
            const model = streamFrameModel(frame);
            if (model !== null) usage.model = model;
            Object.assign(usage, streamFrameUsage(frame));
            if (streamFrameTerminal(frame)) finishMarker = true;
            if (errorEvent || streamFrameIsError(frame)) {
              await failStream();
              return;
            }
            const bytes = frameBytes(event);
            if (finishMarker) {
              if (!holdTerminal(bytes)) {
                await failStream();
                return;
              }
              if (reachedTerminal()) {
                await completeStream(output);
                return;
              }
              continue;
            }
            output.enqueue(bytes);
            return;
          }
        },
        async cancel() {
          if (closed || completed) return;
          closed = true;
          controller.abort(new Error('inference response cancelled'));
          await failStream();
        },
      },
      { highWaterMark: 0 },
    );

    return new Response(responseBody, {
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
    });
  });

export const validateChatBody = (raw: unknown): Record<string, unknown> | null => {
  const decoded = Schema.decodeUnknownOption(ChatRequest, { onExcessProperty: 'error' })(raw);
  if (Option.isNone(decoded)) return null;
  return raw as Record<string, unknown>;
};
