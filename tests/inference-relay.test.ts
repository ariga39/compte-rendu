import { Effect } from 'effect';
import { expect, it } from 'vitest';
import type {
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1ResultLike,
} from '../apps/inference-worker/src/grants';
import { relayInference } from '../apps/inference-worker/src/relay';
import type { AuthenticatedGrant } from '../apps/inference-worker/src/ledger';
import type { FrozenRoute } from '../apps/inference-worker/src/routes';

const grant: AuthenticatedGrant = {
  jobId: 'job-relay',
  tokenHash: 'token-hash',
  routes: [
    {
      routeId: 'review',
      upstreamModel: 'native-review',
      providerSlug: 'review-provider',
      credentialAlias: 'default',
      profile: 'chat',
    },
  ],
  expiresAt: Date.now() + 60_000,
};
const route: FrozenRoute = grant.routes[0]!;

const fakeDatabase = (
  beforeWrite?: (sql: string) => void | Promise<void>,
): { database: D1DatabaseLike; updates: string[] } => {
  const updates: string[] = [];
  const statement = (sql: string): D1PreparedStatementLike => ({
    bind: () => statement(sql),
    run: async () => {
      await beforeWrite?.(sql);
      updates.push(sql);
      return { meta: { changes: 1 } } satisfies D1ResultLike;
    },
    first: async () => null,
    all: async () => ({ results: [] }),
  });
  return {
    database: {
      prepare: statement,
      batch: async () => [],
    },
    updates,
  };
};

const waitFor = async (predicate: () => boolean, timeoutMs = 2_000) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition not reached');
};

it.each(['disconnect', 'complete'] as const)(
  'releases an open upstream body on %s',
  async (ending) => {
    let cancelled = false;
    const { database, updates } = fakeDatabase();
    const response = await Effect.runPromise(
      relayInference({
        database,
        requestId: 'request-cancel',
        gateway: {
          accountId: 'account',
          gatewayId: 'gateway',
          runToken: 'run-token',
        },
        grant,
        route,
        body: { model: 'review', messages: [] },
        request: new Request('https://inference.internal/v1/chat/completions', {
          method: 'POST',
        }),
        waitUntil: () => undefined,
        fetch: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    'data: {"choices":[{"index":0,"delta":{"content":"First"}}]}\n\n' +
                      (ending === 'complete'
                        ? 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
                        : ''),
                  ),
                );
              },
              cancel() {
                cancelled = true;
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          ),
      }),
    );

    if (ending === 'complete') {
      expect(await response.text()).toContain('[DONE]');
    } else {
      const reader = response.body!.getReader();
      await reader.read();
      await reader.cancel();
      await waitFor(() => updates.some((sql) => sql.includes('SET model =')));
    }
    await waitFor(() => cancelled);
  },
);

it('cancels the upstream stream when the downstream cancels during terminal finalization', async () => {
  let cancelled = false;
  let releaseFinalize = () => {};
  const finalizeGate = new Promise<void>((resolve) => {
    releaseFinalize = resolve;
  });
  let markFinalizeStarted = () => {};
  const finalizeStarted = new Promise<void>((resolve) => {
    markFinalizeStarted = resolve;
  });
  const { database } = fakeDatabase(async (sql) => {
    if (!sql.includes("SET status = 'complete'")) return;
    markFinalizeStarted();
    await finalizeGate;
  });
  const response = await Effect.runPromise(
    relayInference({
      database,
      requestId: 'request-finalize-cancel',
      gateway: {
        accountId: 'account',
        gatewayId: 'gateway',
        runToken: 'run-token',
      },
      grant,
      route,
      body: { model: 'review', messages: [] },
      request: new Request('https://inference.internal/v1/chat/completions', {
        method: 'POST',
      }),
      waitUntil: () => undefined,
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'data: {"choices":[{"index":0,"delta":{"content":"First"}}]}\n\n' +
                    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
                    'data: [DONE]\n\n',
                ),
              );
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    }),
  );

  const reader = response.body!.getReader();
  await reader.read();
  const tail = reader.read().catch(() => ({ done: true, value: undefined }));
  await finalizeStarted;
  await reader.cancel();
  releaseFinalize();
  await tail;

  await waitFor(() => cancelled);
});

it('cancels the upstream stream when the local grant expires', async () => {
  let cancelled = false;
  const { database } = fakeDatabase();
  const response = await Effect.runPromise(
    relayInference({
      database,
      requestId: 'request-expiry',
      gateway: {
        accountId: 'account',
        gatewayId: 'gateway',
        runToken: 'run-token',
      },
      grant: { ...grant, expiresAt: Date.now() + 50 },
      route,
      body: { model: 'review', messages: [] },
      request: new Request('https://inference.internal/v1/chat/completions', {
        method: 'POST',
      }),
      waitUntil: () => undefined,
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'data: {"choices":[{"index":0,"delta":{"content":"First"}}]}\n\n',
                ),
              );
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    }),
  );

  const reader = response.body!.getReader();
  await reader.read();
  await expect(reader.read()).rejects.toThrow();
  await waitFor(() => cancelled);
});

it('rejects an upstream redirect without dispatching its body', async () => {
  let cancelled = false;
  const { database } = fakeDatabase();
  const response = await Effect.runPromise(
    relayInference({
      database,
      requestId: 'request-redirect',
      gateway: {
        accountId: 'account',
        gatewayId: 'gateway',
        runToken: 'run-token',
      },
      grant,
      route,
      body: { model: 'review', messages: [] },
      request: new Request('https://inference.internal/v1/chat/completions', {
        method: 'POST',
      }),
      waitUntil: () => undefined,
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancelled = true;
            },
          }),
          { status: 302, headers: { location: 'https://elsewhere.invalid' } },
        ),
    }),
  );

  expect(response.status).toBe(502);
  await waitFor(() => cancelled);
});
