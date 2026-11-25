import { Effect, Option, Schema } from 'effect';
import {
  ChatEffortControls,
  ChatRequest,
  decodeStreamFrame,
  streamEventIsError,
  streamFrameEffortReport,
  streamFrameIsError,
  streamFrameModel,
  streamFrameTerminal,
  streamFrameUsage,
  type EffortAttemptDetail,
  type EffortOutcomeKind,
  type UpstreamUsage,
} from '@compte-rendu/contracts';
import { readBoundedBody } from '@compte-rendu/contracts';
import { createBoundedSseDecoder, type SseFrame } from './bounded-sse.ts';
import {
  finalizeComplete,
  retryStillAllowed,
  savePartial,
  type AuthenticatedGrant,
  type EffortFinalization,
} from './ledger.ts';
import type { D1DatabaseLike } from './grants.ts';
import type { FrozenRoute } from './routes.ts';
import { gatewayHeaders, gatewayUrl, type GatewayConfig } from './gateway';
import { logInfo, logWarning } from './host-log.ts';
export type { GatewayConfig } from './gateway';

const GATEWAY_PATH = '/chat/completions';
// A Chat event can carry a full text delta or one tool-call argument batch.
// This is the raw whole-frame bound, including SSE event/data lines and
// separators. It is separate from the 64 KiB terminal tail held after the finish
// marker; the complete stream has no cumulative byte cap.
const MAX_CHAT_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_HELD_FRAMES = 32;
const MAX_HELD_BYTES = 64 * 1024;
const MAX_ERROR_BODY_BYTES = 16 * 1024;
const FALLBACK_REASON = 'upstream rejected reasoning_effort';

// Every supported Chat thinking switch, effort, budget and alias. A fallback
// request omits all of them, including values supplied by the client.
const CHAT_THINKING_KEYS = [
  'reasoning_effort',
  'reasoning',
  'thinking',
  'verbosity',
  'max_thinking_tokens',
] as const;

export interface InferenceRelayOptions {
  readonly database: D1DatabaseLike;
  readonly requestId: string;
  readonly gateway: GatewayConfig;
  readonly grant: AuthenticatedGrant;
  readonly route: FrozenRoute;
  readonly body: Record<string, unknown>;
  readonly fallbackAt?: number | null;
  readonly fallbackReason?: string | null;
  readonly request: Request;
  readonly waitUntil: (task: Promise<unknown>) => void;
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

interface MutableAttempt {
  attempt: 1 | 2;
  sent: ChatEffortControls | null;
  reported: ChatEffortControls | null;
  result: 'complete' | 'rejected' | 'incomplete';
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

const chatUpstreamBody = (
  body: Record<string, unknown>,
  route: FrozenRoute,
  omitThinkingControls: boolean,
): Record<string, unknown> => {
  const outbound = { ...body };
  if (omitThinkingControls || route.effort !== undefined) {
    for (const key of CHAT_THINKING_KEYS) delete outbound[key];
  }
  if (!omitThinkingControls && route.effort !== undefined) {
    Object.assign(outbound, route.effort.controls);
  }
  return {
    ...outbound,
    model: route.upstreamModel,
    store: false,
    stream: true,
  };
};

const passthroughControls = (body: Record<string, unknown>): ChatEffortControls | null => {
  const decoded = Schema.decodeUnknownOption(ChatEffortControls)({
    ...(body.reasoning_effort === undefined ? {} : { reasoning_effort: body.reasoning_effort }),
    ...(body.thinking === undefined ? {} : { thinking: body.thinking }),
  });
  return Option.isNone(decoded) ? null : decoded.value;
};

const isDeepSeekChat = (route: FrozenRoute): boolean =>
  route.profile === 'chat' && /deepseek/i.test(route.upstreamModel);

// Verified DeepSeek Chat deserializer envelope. The message must name exactly
// reasoning_effort and the exact rejected value; everything else is ignored.
const chatRejection = async (
  response: Response,
  route: FrozenRoute,
  sent: ChatEffortControls | null,
): Promise<string | null> => {
  if (response.status !== 400 || sent?.reasoning_effort === undefined || !isDeepSeekChat(route))
    return null;
  const bounded = await readBoundedBody(response.body, MAX_ERROR_BODY_BYTES);
  if (bounded.kind !== 'ok') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bounded.text) as unknown;
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || !('error' in parsed)) return null;
  const error = parsed.error;
  if (error === null || typeof error !== 'object') return null;
  const record = error as Record<string, unknown>;
  if (record.type !== 'invalid_request_error') return null;
  if (record.code !== 'invalid_request_error') return null;
  if (record.param !== null) return null;
  if (typeof record.message !== 'string') return null;
  const match =
    /^Failed to deserialize the JSON body into the target type: reasoning_effort: unknown variant `([^`]+)`, expected one of `/.exec(
      record.message,
    );
  if (match === null || match[1] !== sent.reasoning_effort) return null;
  return FALLBACK_REASON;
};

export const relayInference = (options: InferenceRelayOptions): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const {
      database,
      requestId,
      gateway,
      grant,
      route,
      body,
      fallbackAt = null,
      request,
      waitUntil,
    } = options;
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
    const sharedFallback = fallbackAt !== null;
    const attempts: MutableAttempt[] = [
      {
        attempt: 1,
        sent: sharedFallback ? null : (route.effort?.controls ?? passthroughControls(body)),
        reported: null,
        result: 'incomplete',
      },
    ];
    let retryUsed = false;
    let fallback: EffortOutcomeKind | null = sharedFallback ? 'shared' : null;
    let fallbackReason = sharedFallback ? (options.fallbackReason ?? FALLBACK_REASON) : null;
    let reader: ReadableStreamDefaultReader<SseFrame> | null = null;
    let downstream: ReadableStreamDefaultController<Uint8Array> | null = null;
    let finalized = false;
    let failureStarted = false;
    let completed = false;
    let closed = false;
    let finishMarker = false;
    let doneMarker = false;
    let terminalBytes = 0;
    const terminal: Uint8Array[] = [];

    const currentAttempt = (): MutableAttempt => attempts[attempts.length - 1]!;

    const finalization = (): EffortFinalization => ({
      routeId: route.routeId,
      generation: route.effortGeneration ?? null,
      fallback,
      reason: fallbackReason,
      attempts: attempts as readonly EffortAttemptDetail[],
    });

    const cleanup = () => {
      clearTimeout(expiryTimer);
      request.signal.removeEventListener('abort', onRequestAbort);
    };
    const finishOnce = async (
      complete: boolean,
    ): Promise<{ readonly completed: boolean; readonly switched: boolean }> => {
      if (finalized) return { completed: false, switched: false };
      finalized = true;
      usage.complete = complete;
      const effort = finalization();
      try {
        if (complete)
          return await finalizeComplete(database, requestId, usage, effort, grant.tokenHash);
        await savePartial(database, requestId, usage, effort);
        return { completed: true, switched: false };
      } catch {
        logWarning('relay.accounting.failed');
        return { completed: false, switched: false };
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
      currentAttempt().result = currentAttempt().result === 'rejected' ? 'rejected' : 'incomplete';
      if (retryUsed) {
        fallback = 'failed';
        fallbackReason ??= FALLBACK_REASON;
      }
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

    const attemptFetch = (omitThinkingControls: boolean) =>
      Effect.tryPromise({
        try: () =>
          fetchUpstream(gatewayUrl(gateway, route.providerSlug, GATEWAY_PATH), {
            method: 'POST',
            headers: headersFor(gateway, grant, route),
            body: JSON.stringify(chatUpstreamBody(body, route, omitThinkingControls)),
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

    const firstUpstream = yield* attemptFetch(sharedFallback);
    if (firstUpstream === null) {
      cleanup();
      yield* Effect.promise(() => finishOnce(false));
      return failure();
    }
    if (failureStarted) {
      cleanup();
      yield* Effect.promise(
        () => firstUpstream.body?.cancel().catch(() => undefined) ?? Promise.resolve(),
      );
      return failure();
    }
    if (
      firstUpstream.type === 'opaqueredirect' ||
      (firstUpstream.status >= 300 && firstUpstream.status <= 399)
    ) {
      cleanup();
      yield* Effect.promise(
        () => firstUpstream.body?.cancel().catch(() => undefined) ?? Promise.resolve(),
      );
      yield* Effect.promise(() => finishOnce(false));
      return failure();
    }
    let upstream: Response = firstUpstream;

    if (!upstream.ok) {
      const reason = sharedFallback
        ? null
        : yield* Effect.promise(() =>
            chatRejection(upstream, route, attempts[0]!.sent).catch(() => null),
          );
      if (reason !== null) {
        attempts[0]!.result = 'rejected';
        fallback = 'failed';
        fallbackReason = reason;
        const allowed =
          !request.signal.aborted &&
          !failureStarted &&
          (yield* Effect.promise(() =>
            retryStillAllowed(database, requestId, grant, route).catch(() => false),
          ));
        if (!allowed) {
          cleanup();
          yield* Effect.promise(() => finishOnce(false));
          return failure(upstream.status >= 400 && upstream.status <= 599 ? upstream.status : 502);
        }
        retryUsed = true;
        attempts.push({ attempt: 2, sent: null, reported: null, result: 'incomplete' });
        const secondUpstream = yield* attemptFetch(true);
        if (secondUpstream === null) {
          cleanup();
          yield* Effect.promise(() => finishOnce(false));
          return failure();
        }
        upstream = secondUpstream;
        if (
          secondUpstream.type === 'opaqueredirect' ||
          (secondUpstream.status >= 300 && secondUpstream.status <= 399) ||
          !secondUpstream.ok ||
          secondUpstream.body === null
        ) {
          cleanup();
          yield* Effect.promise(
            () => upstream.body?.cancel().catch(() => undefined) ?? Promise.resolve(),
          );
          yield* Effect.promise(() => finishOnce(false));
          return failure(upstream.status >= 400 && upstream.status <= 599 ? upstream.status : 502);
        }
      } else {
        cleanup();
        yield* Effect.promise(
          () => upstream.body?.cancel().catch(() => undefined) ?? Promise.resolve(),
        );
        yield* Effect.promise(() => finishOnce(false));
        return failure(upstream.status >= 400 && upstream.status <= 599 ? upstream.status : 502);
      }
    }
    if (upstream.body === null) {
      cleanup();
      yield* Effect.promise(() => finishOnce(false));
      return failure();
    }

    reader = upstream.body.pipeThrough(createBoundedSseDecoder(MAX_CHAT_FRAME_BYTES)).getReader();

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
      currentAttempt().result = 'complete';
      fallback = retryUsed ? 'switched' : sharedFallback ? 'shared' : null;
      const accounting = await finishOnce(true);
      if (!accounting.completed && fallback === 'switched') {
        // Only the first successful fallback is an atomic product commit: a
        // failed/revoked/zero-match settlement must not release a success
        // terminator or a switch event. Ordinary explicit/shared streams keep
        // their historical best-effort termination on accounting failure.
        completed = false;
        await teardown();
        return;
      }
      if (accounting.switched) {
        logInfo('relay.effort.fallback', {
          routeId: route.routeId,
          generation: route.effortGeneration ?? null,
          reason: fallbackReason,
        });
      }
      completed = true;
      cleanup();
      try {
        if (!closed) {
          flushTerminal(output);
          output.close();
        }
      } finally {
        closed = true;
        await cancelUpstream();
      }
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
            const reported = streamFrameEffortReport(frame);
            if (reported !== null) currentAttempt().reported = reported;
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
