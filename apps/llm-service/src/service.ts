import { createHash, randomUUID } from 'node:crypto';
import { Effect, Schema } from 'effect';
import { REVIEW_ATTEMPT_BUDGET_MS } from '@compte-rendu/contracts';

const GRANT_TTL_MS = 4 * REVIEW_ATTEMPT_BUDGET_MS;
const CONTROL_MAX_BYTES = 16 * 1024;
const INFERENCE_MAX_BYTES = 16 * 1024 * 1024;

const NATIVE_PATHS = ['/v1/responses', '/v1/chat/completions'] as const;
export type LlmRoutePath = (typeof NATIVE_PATHS)[number];

export interface LlmRoute {
  readonly id: string;
  readonly path: LlmRoutePath;
}

export interface LlmServiceOptions {
  readonly routes: readonly LlmRoute[];
  readonly upstream: (
    routeId: string,
    body: Record<string, unknown>,
    signal: AbortSignal,
    sessionId?: string,
  ) => Promise<Response>;
}

export interface LlmService {
  control(request: Request): Promise<Response>;
  inference(request: Request): Promise<Response>;
  close(): void;
}

const GrantRequest = Schema.Struct({
  jobId: Schema.NonEmptyString,
  routes: Schema.Array(Schema.NonEmptyString),
});
const RevokeRequest = Schema.Struct({ jobId: Schema.NonEmptyString });
const ModelRequest = Schema.Struct({ model: Schema.NonEmptyString });

interface Grant {
  readonly jobId: string;
  readonly tokenHash: string | null;
  readonly routes: ReadonlySet<string>;
  readonly expiresAt: number;
  revoked: boolean;
  readonly active: Set<AbortController>;
  expiryTimer: ReturnType<typeof setTimeout> | null;
}

type BodyResult = { readonly kind: 'ok'; readonly text: string } | { readonly kind: 'too-large' };

const json = (body: unknown, status: number): Response =>
  Response.json(body, {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

const error = (status: number, message: string): Response => json({ error: { message } }, status);

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

const readBody = async (request: Request, limit: number): Promise<BodyResult> => {
  const length = request.headers.get('content-length');
  if (length !== null && Number(length) > limit) {
    await request.body?.cancel().catch(() => undefined);
    return { kind: 'too-large' };
  }
  if (!request.body) return { kind: 'ok', text: '' };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        return { kind: 'too-large' };
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { kind: 'ok', text: new TextDecoder().decode(bytes) };
};

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

const decodeStrict = <S extends Schema.Constraint>(schema: S, value: unknown) =>
  Schema.decodeUnknownEffect(schema, { onExcessProperty: 'error' })(value).pipe(
    Effect.match({ onSuccess: (decoded) => decoded, onFailure: () => undefined }),
  );

const sanitizeHeaders = (source: Response): Headers => {
  const headers = new Headers();
  const contentType = source.headers.get('content-type');
  if (contentType !== null) headers.set('content-type', contentType);
  const cacheControl = source.headers.get('cache-control');
  if (cacheControl !== null) headers.set('cache-control', cacheControl);
  return headers;
};

export const createLlmService = (options: LlmServiceOptions): LlmService => {
  const routes = new Map(options.routes.map((route) => [route.id, route] as const));
  const grants = new Map<string, Grant>();
  const byToken = new Map<string, Grant>();
  let closed = false;

  const abortGrant = (grant: Grant) => {
    for (const controller of grant.active) controller.abort(new Error('grant unavailable'));
  };

  const retire = (grant: Grant) => {
    grant.expiryTimer = null;
    abortGrant(grant);
    if (grants.get(grant.jobId) === grant) grants.delete(grant.jobId);
    if (grant.tokenHash !== null) byToken.delete(grant.tokenHash);
  };

  const scheduleRetirement = (grant: Grant) => {
    const timer = setTimeout(() => retire(grant), Math.max(0, grant.expiresAt - Date.now()));
    const handle = timer as { unref?: () => void };
    handle.unref?.();
    grant.expiryTimer = timer;
  };

  const issue = Effect.fn('LlmService.issue')(function* (request: Request) {
    const body = yield* Effect.tryPromise(() => readBody(request, CONTROL_MAX_BYTES));
    if (body.kind === 'too-large') return error(413, 'request too large');
    const raw = parseJson(body.text);
    if (raw === undefined) return error(400, 'invalid request');
    const decoded = yield* decodeStrict(GrantRequest, raw);
    if (decoded === undefined) return error(400, 'invalid request');
    if (closed) return error(503, 'service closed');
    if (grants.has(decoded.jobId)) return error(409, 'grant already issued');
    if (decoded.routes.some((id) => !routes.has(id))) return error(400, 'unknown route');

    const token = randomUUID() + randomUUID();
    const tokenHash = hashToken(token);
    const expiresAt = Date.now() + GRANT_TTL_MS;
    const grant: Grant = {
      jobId: decoded.jobId,
      tokenHash,
      routes: new Set(decoded.routes),
      expiresAt,
      revoked: false,
      active: new Set(),
      expiryTimer: null,
    };
    grants.set(grant.jobId, grant);
    byToken.set(tokenHash, grant);
    scheduleRetirement(grant);
    return json({ token, expiresAt: new Date(expiresAt).toISOString() }, 201);
  });

  const revoke = Effect.fn('LlmService.revoke')(function* (request: Request) {
    const body = yield* Effect.tryPromise(() => readBody(request, CONTROL_MAX_BYTES));
    if (body.kind === 'too-large') return error(413, 'request too large');
    const raw = parseJson(body.text);
    if (raw === undefined) return error(400, 'invalid request');
    const decoded = yield* decodeStrict(RevokeRequest, raw);
    if (decoded === undefined) return error(400, 'invalid request');

    const existing = grants.get(decoded.jobId);
    if (existing) {
      existing.revoked = true;
      abortGrant(existing);
    } else {
      const tombstone: Grant = {
        jobId: decoded.jobId,
        tokenHash: null,
        routes: new Set(),
        expiresAt: Date.now() + GRANT_TTL_MS,
        revoked: true,
        active: new Set(),
        expiryTimer: null,
      };
      grants.set(tombstone.jobId, tombstone);
      scheduleRetirement(tombstone);
    }
    return new Response(null, { status: 204 });
  });

  const control = Effect.fn('LlmService.control')(function* (request: Request) {
    if (closed) return error(503, 'service closed');
    const url = new URL(request.url);
    if (url.pathname !== '/grants' && url.pathname !== '/grants/revoke') {
      return error(404, 'not found');
    }
    if (request.method !== 'POST') return error(405, 'method not allowed');
    return yield* url.pathname === '/grants' ? issue(request) : revoke(request);
  });

  const bridge = (source: Response, controller: AbortController, cleanup: () => void): Response => {
    if (source.body === null) {
      cleanup();
      return new Response(null, { status: source.status, headers: sanitizeHeaders(source) });
    }
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    const sourceBody = source.body;
    const readSource = (): ReadableStreamDefaultReader<Uint8Array> => {
      reader ??= sourceBody.getReader();
      return reader;
    };
    const cancelSource = async () => {
      if (reader !== null) await reader.cancel().catch(() => undefined);
      else await sourceBody.cancel().catch(() => undefined);
    };
    let finished = false;
    let downstream: ReadableStreamDefaultController<Uint8Array> | null = null;
    const finish = () => {
      if (finished) return false;
      finished = true;
      controller.signal.removeEventListener('abort', onAbort);
      cleanup();
      return true;
    };
    const onAbort = () => {
      if (!finish()) return;
      void cancelSource();
      downstream?.error(new Error('upstream stream aborted'));
    };
    controller.signal.addEventListener('abort', onAbort, { once: true });
    const body = new ReadableStream<Uint8Array>(
      {
        start: (target) => {
          downstream = target;
        },
        pull: async (target) => {
          try {
            const next = await readSource().read();
            if (next.done) {
              finish();
              target.close();
              return;
            }
            target.enqueue(next.value);
          } catch {
            finish();
            await cancelSource();
            target.error(new Error('upstream stream failed'));
          }
        },
        cancel: async () => {
          finish();
          controller.abort(new Error('inference response cancelled'));
          await cancelSource();
        },
      },
      { highWaterMark: 0 },
    );
    if (controller.signal.aborted) onAbort();
    return new Response(body, { status: source.status, headers: sanitizeHeaders(source) });
  };

  const infer = Effect.fn('LlmService.inference')(function* (request: Request) {
    if (closed) return error(503, 'service closed');
    const pathname = new URL(request.url).pathname;
    if (!NATIVE_PATHS.includes(pathname as LlmRoutePath)) return error(404, 'not found');
    if (request.method !== 'POST') return error(405, 'method not allowed');

    const authorization = request.headers.get('authorization');
    const match = authorization === null ? null : /^Bearer\s+(\S+)$/i.exec(authorization);
    if (match === null || match[1] === undefined) return error(401, 'unauthorized');
    const grant = byToken.get(hashToken(match[1]));
    if (grant === undefined) return error(401, 'unauthorized');
    if (grant.revoked || Date.now() >= grant.expiresAt) return error(401, 'unauthorized');

    const body = yield* Effect.tryPromise(() => readBody(request, INFERENCE_MAX_BYTES));
    if (body.kind === 'too-large') return error(413, 'request too large');
    const raw = parseJson(body.text);
    if (raw === undefined) return error(400, 'invalid request');
    const decoded = yield* Schema.decodeUnknownEffect(ModelRequest)(raw).pipe(
      Effect.match({ onSuccess: (value) => value, onFailure: () => undefined }),
    );
    if (decoded === undefined) return error(400, 'invalid request');

    if (closed) return error(503, 'service closed');
    if (grant.revoked || Date.now() >= grant.expiresAt) return error(401, 'unauthorized');

    const route = routes.get(decoded.model);
    if (route === undefined || route.path !== pathname || !grant.routes.has(route.id)) {
      return error(403, 'route forbidden');
    }

    const controller = new AbortController();
    const onRequestAbort = () => controller.abort(new Error('inference request aborted'));
    request.signal.addEventListener('abort', onRequestAbort, { once: true });
    if (request.signal.aborted) onRequestAbort();
    grant.active.add(controller);
    const deadline = setTimeout(
      () => controller.abort(new Error('grant expired')),
      Math.max(0, grant.expiresAt - Date.now()),
    );
    const deadlineTimer = deadline as { unref?: () => void };
    deadlineTimer.unref?.();
    const cleanup = () => {
      clearTimeout(deadline);
      request.signal.removeEventListener('abort', onRequestAbort);
      grant.active.delete(controller);
    };

    const upstream = yield* Effect.tryPromise({
      try: () =>
        options.upstream(route.id, raw as Record<string, unknown>, controller.signal, grant.jobId),
      catch: () => undefined,
    }).pipe(
      Effect.match({
        onSuccess: (response) => response,
        onFailure: () => null,
      }),
    );
    if (upstream === null) {
      cleanup();
      return error(502, 'model request failed');
    }
    if (controller.signal.aborted) {
      cleanup();
      yield* Effect.tryPromise({
        try: async () => {
          await upstream.body?.cancel().catch(() => undefined);
        },
        catch: () => undefined,
      });
      return closed ? error(503, 'service closed') : error(401, 'unauthorized');
    }
    return bridge(upstream, controller, cleanup);
  });

  return {
    control: (request) => Effect.runPromise(control(request)),
    inference: (request) => Effect.runPromise(infer(request)),
    close: () => {
      if (closed) return;
      closed = true;
      for (const grant of grants.values()) {
        grant.revoked = true;
        if (grant.expiryTimer !== null) {
          clearTimeout(grant.expiryTimer);
          grant.expiryTimer = null;
        }
        abortGrant(grant);
      }
    },
  };
};
