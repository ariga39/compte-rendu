import { Effect } from 'effect';
import type { ObservedTokenFields, UpstreamUsage } from '@compte-rendu/contracts';
import {
  createBoundedSseDecoder,
  DEFAULT_SSE_FRAME_OVERHEAD_BYTES,
  type SseFrame,
} from './bounded-sse.ts';
import { finalizeComplete, savePartial, type AuthenticatedGrant } from './ledger.ts';
import type { D1DatabaseLike } from './grants.ts';
import type { FrozenRoute } from './routes.ts';
import { gatewayHeaders, gatewayUrl, type GatewayConfig, type GatewayPath } from './gateway.ts';

export type { SseFrame } from './bounded-sse.ts';

export type StreamObservation = 'event' | 'ignore' | 'terminal' | 'failure';

export interface StreamObservationDetails {
  readonly observation: StreamObservation;
  readonly usage?: ObservedTokenFields;
  readonly model?: string;
}

export interface ProtocolStreamAdapter {
  readonly maxTerminalBytes: number;
  upstreamPath(route: FrozenRoute): GatewayPath;
  headers?(context: {
    readonly gateway: GatewayConfig;
    readonly grant: AuthenticatedGrant;
    readonly route: FrozenRoute;
  }): Record<string, string>;
  observe(frame: SseFrame): StreamObservationDetails;
  encode(frame: SseFrame): Uint8Array;
  /** Create a fresh adapter for one request when observation is stateful. */
  create?(): ProtocolStreamAdapter;
}

export interface ProtocolStreamOptions {
  readonly database: D1DatabaseLike;
  readonly requestId: string;
  readonly gateway: GatewayConfig;
  readonly grant: AuthenticatedGrant;
  readonly route: FrozenRoute;
  readonly body: Record<string, unknown>;
  readonly request: Request;
  readonly waitUntil: (task: Promise<unknown>) => void;
  readonly adapter: ProtocolStreamAdapter;
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

export const encodeSseFrame = (frame: SseFrame): Uint8Array => {
  const encoded =
    (frame.event === undefined ? '' : `event: ${frame.event}\n`) +
    frame.data
      .split('\n')
      .map((line) => `data: ${line}\n`)
      .join('') +
    '\n';
  return new TextEncoder().encode(encoded);
};

const failure = (status = 502): Response =>
  Response.json(
    { error: { message: 'model request failed' } },
    { status, headers: { 'cache-control': 'no-store' } },
  );

const headersFor = (
  adapter: ProtocolStreamAdapter,
  gateway: GatewayConfig,
  grant: AuthenticatedGrant,
  route: FrozenRoute,
) => {
  const trusted = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    ...gatewayHeaders(gateway, route.credentialAlias),
    'x-opencode-session': grant.jobId,
    session_id: grant.jobId,
  };
  // Adapter headers may add protocol metadata but never replace relay authority.
  return { ...adapter.headers?.({ gateway, grant, route }), ...trusted };
};

export const relayProtocolStream = (options: ProtocolStreamOptions): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const { database, requestId, gateway, grant, route, body, request, waitUntil } = options;
    const adapter = options.adapter.create?.() ?? options.adapter;
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
    let reader: ReadableStreamDefaultReader<SseFrame> | null = null;
    let downstream: ReadableStreamDefaultController<Uint8Array> | null = null;
    let finalizeStarted = false;
    let teardownStarted = false;
    let closed = false;

    const cleanup = () => {
      clearTimeout(expiryTimer);
      request.signal.removeEventListener('abort', onRequestAbort);
    };
    const persistPartial = async (): Promise<boolean> => {
      try {
        await savePartial(database, requestId, usage);
        return true;
      } catch {
        await Effect.runPromise(Effect.logWarning('relay.accounting.failed'));
        return false;
      }
    };
    const finishOnce = async (complete: boolean): Promise<boolean> => {
      if (finalizeStarted) return false;
      finalizeStarted = true;
      if (!complete) return persistPartial();
      try {
        if (!(await finalizeComplete(database, requestId, usage)).completed) return false;
        usage.complete = true;
        return true;
      } catch {
        await Effect.runPromise(Effect.logWarning('relay.accounting.failed'));
        await persistPartial();
        return false;
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
      if (closed || teardownStarted) return;
      teardownStarted = true;
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
        fetchUpstream(gatewayUrl(gateway, route.providerSlug, adapter.upstreamPath(route)), {
          method: 'POST',
          headers: headersFor(adapter, gateway, grant, route),
          body: JSON.stringify(body),
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
    if (teardownStarted) {
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

    const decoder = createBoundedSseDecoder(
      adapter.maxTerminalBytes + DEFAULT_SSE_FRAME_OVERHEAD_BYTES,
    );
    reader = upstream.body.pipeThrough(decoder).getReader();

    const observe = (frame: SseFrame) => {
      const details = adapter.observe(frame);
      if (details.model !== undefined) usage.model = details.model;
      Object.assign(usage, details.usage ?? {});
      return details.observation;
    };
    const completeStream = async (
      output: ReadableStreamDefaultController<Uint8Array>,
      bytes: Uint8Array,
    ) => {
      if (closed || teardownStarted) return;
      if (!(await finishOnce(true))) {
        await failStream();
        return;
      }
      if (closed || teardownStarted) return;
      cleanup();
      closed = true;
      try {
        output.enqueue(bytes);
        output.close();
      } finally {
        await cancelUpstream();
      }
    };

    const responseBody = new ReadableStream<Uint8Array>(
      {
        start(output) {
          downstream = output;
        },
        async pull(output) {
          if (closed) return;
          for (;;) {
            let next: Awaited<ReturnType<NonNullable<typeof reader>['read']>>;
            try {
              next = await reader!.read();
            } catch {
              await failStream();
              return;
            }
            if (next.done) {
              if (closed) return;
              await failStream();
              return;
            }
            const frame = next.value;
            const observation = observe(frame);
            if (observation === 'ignore') continue;
            if (observation === 'failure') {
              await failStream();
              return;
            }
            const bytes = adapter.encode(frame);
            if (observation === 'terminal') {
              if (bytes.byteLength > adapter.maxTerminalBytes) {
                await failStream();
                return;
              }
              await completeStream(output, bytes);
              return;
            }
            output.enqueue(bytes);
            return;
          }
        },
        async cancel() {
          if (closed || teardownStarted) return;
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
