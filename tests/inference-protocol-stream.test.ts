import { Effect } from 'effect';
import { expect, it, vi } from 'vitest';
import type {
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1ResultLike,
} from '../apps/inference-worker/src/grants';
import { readUsage, type AuthenticatedGrant } from '../apps/inference-worker/src/ledger';
import type { FrozenRoute } from '../apps/inference-worker/src/routes';
import {
  encodeSseFrame,
  relayProtocolStream,
  type ProtocolStreamAdapter,
} from '../apps/inference-worker/src/protocol-stream';
import { SqliteD1Database } from './support/d1-database';

const grant: AuthenticatedGrant = {
  jobId: 'job-native-race',
  tokenHash: 'token-hash',
  routes: [
    {
      routeId: 'review',
      upstreamModel: 'native-review',
      providerSlug: 'review-provider',
      credentialAlias: 'default',
      profile: 'responses',
    },
  ],
  expiresAt: Date.now() + 60_000,
};
const route: FrozenRoute = grant.routes[0]!;

const adapter: ProtocolStreamAdapter = {
  maxTerminalBytes: 1024,
  upstreamPath: () => '/test',
  observe: (frame) =>
    frame.data === 'terminal'
      ? { observation: 'terminal', usage: { outputTokens: 2 } }
      : { observation: 'event' },
  encode: encodeSseFrame,
};

const fakeDatabase = (beforeWrite?: (sql: string) => void | Promise<void>): D1DatabaseLike => {
  const statement = (sql: string): D1PreparedStatementLike => ({
    bind: () => statement(sql),
    run: async () => {
      await beforeWrite?.(sql);
      return { meta: { changes: 1 } } satisfies D1ResultLike;
    },
    first: async () => null,
    all: async () => ({ results: [] }),
  });
  return {
    prepare: statement,
    batch: async () => [],
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

const waitForUsage = async (database: D1DatabaseLike, jobId: string) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const usage = await readUsage(database, jobId);
    if (usage?.models[0]?.outputTokens?.total === 2) return usage;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return readUsage(database, jobId);
};

const upstream = (onCancel: () => void) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode('event: delta\ndata: first\n\n'));
        controller.enqueue(encoder.encode('event: done\ndata: terminal\n\n'));
      },
      cancel() {
        onCancel();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );

const request = (signal?: AbortSignal) =>
  new Request('https://inference.internal/v1/test', {
    method: 'POST',
    body: JSON.stringify({}),
    ...(signal === undefined ? {} : { signal }),
  });

type ReadOutcome =
  | { kind: 'value'; done: boolean; text: string }
  | { kind: 'error'; message: string };

const readOutcome = (promise: Promise<ReadableStreamReadResult<Uint8Array>>) =>
  promise
    .then((result): ReadOutcome => ({
      kind: 'value',
      done: result.done,
      text: result.done ? '' : new TextDecoder().decode(result.value),
    }))
    .catch((error: unknown): ReadOutcome => ({
      kind: 'error',
      message: error instanceof Error ? error.message : String(error),
    }));

const gatedCompletion = () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = () => {};
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve;
  });
  return { gate, release: () => release(), started: startedPromise, markStarted: () => started() };
};

// The previous finalizer awaited the partial ledger write before teardown and then
// exposed the queued terminal frame, so an interrupt could both delay the upstream
// abort and present a successful native response.
it('aborts upstream and rejects the terminal frame when an interrupt races durable completion', async () => {
  const abort = new AbortController();
  let cancelled = false;
  let releasePartial = () => {};
  const partialGate = new Promise<void>((resolve) => {
    releasePartial = resolve;
  });
  const completion = gatedCompletion();
  const database = fakeDatabase(async (sql) => {
    if (sql.includes("SET status = 'complete'")) {
      completion.markStarted();
      await completion.gate;
    } else if (sql.includes('SET model =')) {
      await partialGate;
    }
  });
  const tasks: Promise<unknown>[] = [];
  const response = await Effect.runPromise(
    relayProtocolStream({
      database,
      requestId: 'request-native-interrupt',
      gateway: { accountId: 'account', gatewayId: 'gateway', runToken: 'run-token' },
      grant,
      route,
      body: {},
      request: request(abort.signal),
      waitUntil: (task) => tasks.push(task),
      adapter,
      fetch: async () => upstream(() => (cancelled = true)),
    }),
  );

  const reader = response.body!.getReader();
  await reader.read();
  const terminal = readOutcome(reader.read());
  await completion.started;
  abort.abort();
  const cancelledBeforeCompletion = await waitFor(() => cancelled, 200).then(
    () => true,
    () => false,
  );
  completion.release();
  let outcome: ReadOutcome;
  try {
    outcome = await terminal;
  } finally {
    releasePartial();
    await Promise.all(tasks);
  }

  expect({ cancelledBeforeCompletion, kind: outcome.kind }).toEqual({
    cancelledBeforeCompletion: true,
    kind: 'error',
  });
  if (outcome.kind === 'error') expect(outcome.message).toBe('model stream failed');
});

it('keeps a bounded partial write when completion fails after teardown started', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const abort = new AbortController();
  const jobId = 'job-native-fallback';
  const requestId = 'request-native-fallback';
  const sqlite = new SqliteD1Database('inference-worker');
  try {
    const now = Date.now();
    sqlite.database
      .prepare(
        `INSERT INTO grants
          (job_id, token_hash, route_mapping, issued_at, expires_at, latest_issue_deadline, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(jobId, 'hash', JSON.stringify([]), now, now + 60_000, now + 60_000);
    sqlite.database
      .prepare(
        `INSERT INTO inference_requests
          (request_id, job_id, route, status, created_at)
         VALUES (?, ?, 'review', 'pending', 0)`,
      )
      .run(requestId, jobId);

    const completion = gatedCompletion();
    const throwingStatement = (): D1PreparedStatementLike => ({
      bind: () => throwingStatement(),
      run: async () => {
        completion.markStarted();
        await completion.gate;
        throw new Error('ledger unavailable');
      },
      first: async () => null,
      all: async () => ({ results: [] }),
    });
    const database: D1DatabaseLike = {
      prepare: (sql) =>
        sql.includes("SET status = 'complete'") ? throwingStatement() : sqlite.prepare(sql),
      batch: async () => [],
    };
    const tasks: Promise<unknown>[] = [];
    const response = await Effect.runPromise(
      relayProtocolStream({
        database,
        requestId,
        gateway: { accountId: 'account', gatewayId: 'gateway', runToken: 'run-token' },
        grant: { ...grant, jobId, tokenHash: 'hash' },
        route,
        body: {},
        request: request(abort.signal),
        waitUntil: (task) => tasks.push(task),
        adapter,
        fetch: async () => upstream(() => undefined),
      }),
    );

    const reader = response.body!.getReader();
    await reader.read();
    const terminal = readOutcome(reader.read());
    await completion.started;
    abort.abort();
    await Promise.all(tasks);
    completion.release();
    const outcome = await terminal;
    expect(outcome).toMatchObject({ kind: 'error', message: 'model stream failed' });
    await expect(waitForUsage(sqlite, jobId)).resolves.toMatchObject({
      models: [
        {
          route: 'review',
          requests: 1,
          incompleteRequests: 1,
          outputTokens: { total: 2, reportedRequests: 1 },
        },
      ],
    });
    expect(warning).toHaveBeenCalledWith(
      JSON.stringify({ level: 'warn', message: 'relay.accounting.failed' }),
    );
  } finally {
    warning.mockRestore();
    sqlite.close();
  }
});

it('waits for durable completion before exposing the terminal frame', async () => {
  const completion = gatedCompletion();
  const database = fakeDatabase(async (sql) => {
    if (!sql.includes("SET status = 'complete'")) return;
    completion.markStarted();
    await completion.gate;
  });
  const response = await Effect.runPromise(
    relayProtocolStream({
      database,
      requestId: 'request-native-order',
      gateway: { accountId: 'account', gatewayId: 'gateway', runToken: 'run-token' },
      grant,
      route,
      body: {},
      request: request(),
      waitUntil: () => undefined,
      adapter,
      fetch: async () => upstream(() => undefined),
    }),
  );

  const reader = response.body!.getReader();
  await reader.read();
  const terminal = readOutcome(reader.read());
  await completion.started;
  let settled = false;
  void terminal.then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  completion.release();
  const outcome = await terminal;
  expect(outcome).toMatchObject({ kind: 'value', done: false });
  if (outcome.kind === 'value') expect(outcome.text).toContain('terminal');
});
