/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { createApplication } from '../../apps/dashboard/src/lib/server/application';
import {
  createD1ReviewStateStore,
  type D1DatabaseLike as ReviewDb,
} from '../../apps/core/src/review-state-store';
import type { RelayCatalogSnapshot } from '../../apps/inference-worker/src/catalog';
import { REVIEW_ATTEMPT_BUDGET_MS } from '../../packages/contracts/src';
import type {
  D1DatabaseLike,
  IssueGrantInput,
  IssueGrantResult,
  RevokeGrantInput,
  RevokeGrantResult,
} from '../../apps/inference-worker/src/grants';
import type { ModelUsageSummary } from '../../packages/contracts/src';

const GRANT_TTL_MS = 4 * REVIEW_ATTEMPT_BUDGET_MS;

interface InferenceBinding {
  catalog(): Promise<RelayCatalogSnapshot>;
  refreshCatalog(at: number): Promise<void>;
  fetch(request: Request): Promise<Response>;
  issue(input: IssueGrantInput): Promise<IssueGrantResult>;
  revoke(input: RevokeGrantInput): Promise<RevokeGrantResult>;
  usage(input: { jobId: string }): Promise<ModelUsageSummary | null>;
  sweep(): Promise<number>;
  scheduled(): Promise<void>;
}

interface UpstreamState {
  readonly requests: readonly {
    readonly url: string;
    readonly headers: Record<string, string>;
    readonly body: string;
  }[];
  readonly cancellations: number;
  readonly waitingHeaders: number;
}

interface RuntimeEnv {
  readonly REVIEW_DB: ReviewDb;
  readonly RELAY_DB: D1DatabaseLike;
  readonly INFERENCE: InferenceBinding;
  readonly UPSTREAM: {
    fetch(input: Request | string, init?: RequestInit): Promise<Response>;
  };
}

const runtime = env as unknown as RuntimeEnv;
const snapshot = { routes: ['deepseek-review', 'step-review'] };

const d1Now = async () => {
  const row = await runtime.RELAY_DB.prepare(
    "SELECT CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER) AS now",
  ).first<{ readonly now: number }>();
  if (row === null) throw new Error('missing D1 clock');
  return row.now;
};

const control = async (scenario: string) => {
  const response = await runtime.UPSTREAM.fetch(
    new Request('https://upstream.internal/__control', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenario }),
    }),
  );
  expect(response.status).toBe(200);
};

const release = async () => {
  const response = await runtime.UPSTREAM.fetch(
    new Request('https://upstream.internal/__release', { method: 'POST' }),
  );
  expect(response.status).toBe(200);
};

const upstreamState = async (): Promise<UpstreamState> => {
  const response = await runtime.UPSTREAM.fetch(new Request('https://upstream.internal/__state'));
  return (await response.json()) as UpstreamState;
};

const issue = async (jobId: string, routes = snapshot.routes) => {
  const result = await runtime.INFERENCE.issue({
    jobId,
    snapshot: { routes },
    latestIssueDeadline: (await d1Now()) + 60_000,
  });
  if (result.kind !== 'issued') throw new Error(`grant unavailable: ${result.kind}`);
  return result.token;
};

const request = (token: string, body: Record<string, unknown>) =>
  runtime.INFERENCE.fetch(
    new Request('https://inference.internal/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }),
  );

const waitFor = async (predicate: () => boolean | Promise<boolean>, timeoutMs = 3_000) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('condition not reached');
};

const drain = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
  for (;;) {
    const next = await reader.read();
    if (next.done) return;
  }
};

describe('Inference Worker runtime boundaries', () => {
  it('keeps grant control off the public HTTP interface', async () => {
    const now = await d1Now();
    for (const path of ['/grants', '/grants/revoke', '/runner-llm/grants']) {
      const response = await runtime.INFERENCE.fetch(
        new Request(`https://inference.internal${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jobId: 'runtime-public',
            snapshot,
            latestIssueDeadline: now + 60_000,
          }),
        }),
      );

      expect(response.status).toBe(404);
    }
    await expect(
      runtime.INFERENCE.issue({
        jobId: 'runtime-public',
        snapshot,
        latestIssueDeadline: now + 60_000,
      }),
    ).resolves.toMatchObject({ kind: 'issued' });
  });

  it('issues and revokes through the service-binding RPC interface', async () => {
    const now = await d1Now();
    const issued = await runtime.INFERENCE.issue({
      jobId: 'runtime-rpc',
      snapshot,
      latestIssueDeadline: now + 60_000,
    });

    expect(issued.kind).toBe('issued');
    if (issued.kind !== 'issued') throw new Error('expected an issued grant');
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(Date.parse(issued.expiresAt)).toBeGreaterThanOrEqual(now + GRANT_TTL_MS);
    expect(Date.parse(issued.expiresAt)).toBeLessThanOrEqual((await d1Now()) + GRANT_TTL_MS);

    await expect(runtime.INFERENCE.revoke({ jobId: 'runtime-rpc' })).resolves.toEqual({
      kind: 'revoked',
    });
    await expect(
      runtime.INFERENCE.issue({
        jobId: 'runtime-rpc',
        snapshot,
        latestIssueDeadline: (await d1Now()) + 60_000,
      }),
    ).resolves.toEqual({ kind: 'duplicate' });
  });

  it('rejects an expired issue deadline over RPC', async () => {
    const now = await d1Now();
    await expect(
      runtime.INFERENCE.issue({
        jobId: 'runtime-expired',
        snapshot,
        latestIssueDeadline: now,
      }),
    ).resolves.toEqual({ kind: 'deadline-exceeded' });
  });

  it('rejects a frozen snapshot route absent from the trusted catalog', async () => {
    await expect(
      runtime.INFERENCE.issue({
        jobId: 'runtime-unknown-route',
        snapshot: { routes: ['deepseek-review', 'missing-review'] },
        latestIssueDeadline: (await d1Now()) + 60_000,
      }),
    ).resolves.toEqual({ kind: 'invalid' });
  });
});

describe('Inference Worker public streaming', () => {
  it('streams a frozen catalog route through trusted Gateway headers and records complete usage', async () => {
    await control('success');
    const token = await issue('runtime-success', ['deepseek-review']);

    const response = await request(token, {
      model: 'deepseek-review',
      messages: [{ role: 'user', content: 'Review this change' }],
      stream: false,
      store: true,
      tools: [{ type: 'function', function: { name: 'submit_review', parameters: {} } }],
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const text = await response.text();
    expect(text).toContain('Reviewed');
    expect(text).toContain('[DONE]');

    const state = await upstreamState();
    expect(state.requests).toHaveLength(1);
    const upstream = state.requests[0]!;
    expect(upstream.url).toBe(
      'https://gateway.ai.cloudflare.com/v1/test-account/test-gateway/custom-review-provider/chat/completions',
    );
    expect(upstream.headers['cf-aig-authorization']).toBe('Bearer test-run-token');
    expect(upstream.headers['cf-aig-collect-log']).toBe('false');
    expect(upstream.headers['cf-aig-collect-log-payload']).toBe('false');
    expect(upstream.headers['cf-aig-skip-cache']).toBe('true');
    expect(upstream.headers['cf-aig-byok-alias']).toBe('review-alias');
    expect(upstream.headers.authorization).toBeUndefined();
    const body = JSON.parse(upstream.body) as Record<string, unknown>;
    expect(body.model).toBe('deepseek-review-native');
    expect(body.stream).toBe(true);
    expect(body.store).toBe(false);
    expect(body.messages).toEqual([{ role: 'user', content: 'Review this change' }]);

    await expect(runtime.INFERENCE.usage({ jobId: 'runtime-success' })).resolves.toEqual({
      version: 1,
      models: [
        {
          route: 'deepseek-review',
          model: 'deepseek-native',
          requests: 1,
          incompleteRequests: 0,
          inputTokens: { total: 10, reportedRequests: 1 },
          uncachedInputTokens: { total: 6, reportedRequests: 1 },
          cacheReadTokens: { total: 4, reportedRequests: 1 },
          cacheWriteTokens: null,
          outputTokens: { total: 3, reportedRequests: 1 },
          reasoningTokens: { total: 1, reportedRequests: 1 },
        },
      ],
    });
    await runtime.INFERENCE.revoke({ jobId: 'runtime-success' });
    await expect(runtime.INFERENCE.usage({ jobId: 'runtime-success' })).resolves.toMatchObject({
      models: [{ requests: 1, incompleteRequests: 0 }],
    });
  });

  it('round-trips UTF-8 split inside a code point across upstream chunks', async () => {
    await control('utf8-split');
    const token = await issue('runtime-utf8', ['deepseek-review']);
    const response = await request(token, { model: 'deepseek-review', messages: [] });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('审查通过');
    await expect(runtime.INFERENCE.usage({ jobId: 'runtime-utf8' })).resolves.toMatchObject({
      models: [{ requests: 1, incompleteRequests: 0, inputTokens: { total: 10 } }],
    });
    await runtime.INFERENCE.revoke({ jobId: 'runtime-utf8' });
  });

  it('continues from a held terminal frame to delayed usage and DONE without eager draining', async () => {
    await control('deferred-terminal');
    const token = await issue('runtime-deferred-terminal', ['deepseek-review']);
    const response = await request(token, { model: 'deepseek-review', messages: [] });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('Deferred');
    expect(text).toContain('"finish_reason":"stop"');
    expect(text).toContain('[DONE]');
    await expect(
      runtime.INFERENCE.usage({ jobId: 'runtime-deferred-terminal' }),
    ).resolves.toMatchObject({
      models: [{ requests: 1, incompleteRequests: 0, inputTokens: { total: 10 } }],
    });
    await runtime.INFERENCE.revoke({ jobId: 'runtime-deferred-terminal' });
  });

  it('keeps the issued route mapping when the catalog changes afterwards', async () => {
    await control('success');
    const token = await issue('runtime-frozen', ['other-review']);
    try {
      await runtime.RELAY_DB.prepare(
        `UPDATE catalog_routes
        SET upstream_model = ?, provider_slug = ?, credential_alias = ?
        WHERE route_id = ?`,
      )
        .bind('changed-native', 'changed-provider', 'changed-alias', 'other-review')
        .run();

      const response = await request(token, { model: 'other-review', messages: [] });
      expect(response.status).toBe(200);
      await response.text();

      const upstream = (await upstreamState()).requests[0]!;
      expect(upstream.url).toContain('/custom-review-provider/chat/completions');
      expect(upstream.headers['cf-aig-byok-alias']).toBe('review-alias');
      expect((JSON.parse(upstream.body) as { model: string }).model).toBe('other-review-native');
    } finally {
      await runtime.RELAY_DB.prepare(
        `UPDATE catalog_routes
        SET upstream_model = ?, provider_slug = ?, credential_alias = ?
        WHERE route_id = ?`,
      )
        .bind('other-review-native', 'review-provider', 'review-alias', 'other-review')
        .run();
      await runtime.INFERENCE.revoke({ jobId: 'runtime-frozen' });
    }
  });

  it('rejects wrong, unknown, revoked and ungranted routes before upstream inference', async () => {
    await control('success');
    const wrongToken = await request('not-a-valid-token', {
      model: 'deepseek-review',
      messages: [],
    });
    expect(wrongToken.status).toBe(401);

    const token = await issue('runtime-denied', ['deepseek-review']);
    const ungranted = await request(token, { model: 'step-review', messages: [] });
    expect(ungranted.status).toBe(403);

    await runtime.INFERENCE.revoke({ jobId: 'runtime-denied' });
    const revoked = await request(token, { model: 'deepseek-review', messages: [] });
    expect(revoked.status).toBe(401);

    expect((await upstreamState()).requests).toHaveLength(0);
  });

  it('sanitizes an upstream HTTP failure while retaining an incomplete request', async () => {
    await control('error');
    const token = await issue('runtime-error', ['deepseek-review']);
    const response = await request(token, { model: 'deepseek-review', messages: [] });
    expect(response.status).toBe(429);
    expect(response.headers.get('x-private')).toBeNull();
    const text = await response.text();
    expect(text).not.toContain('private upstream diagnostic');
    expect(JSON.parse(text)).toEqual({ error: { message: 'model request failed' } });

    await runtime.INFERENCE.revoke({ jobId: 'runtime-error' });
    await expect(runtime.INFERENCE.usage({ jobId: 'runtime-error' })).resolves.toMatchObject({
      models: [{ requests: 1, incompleteRequests: 1, model: null }],
    });
  });

  it('retains partial usage when the upstream stream fails', async () => {
    await control('failure-after-usage');
    const token = await issue('runtime-partial', ['deepseek-review']);
    const response = await request(token, { model: 'deepseek-review', messages: [] });
    expect(response.status).toBe(200);
    await expect(response.text()).rejects.toThrow();

    await expect(runtime.INFERENCE.usage({ jobId: 'runtime-partial' })).resolves.toMatchObject({
      models: [
        {
          route: 'deepseek-review',
          model: 'deepseek-native',
          requests: 1,
          incompleteRequests: 1,
          inputTokens: { total: 10, reportedRequests: 1 },
          cacheReadTokens: { total: 4, reportedRequests: 1 },
          outputTokens: { total: 3, reportedRequests: 1 },
        },
      ],
    });
    await runtime.INFERENCE.revoke({ jobId: 'runtime-partial' });
  });

  it('marks a premature EOF incomplete', async () => {
    await control('incomplete');
    const token = await issue('runtime-eof', ['deepseek-review']);
    const response = await request(token, { model: 'deepseek-review', messages: [] });
    await expect(response.text()).rejects.toThrow();

    await runtime.INFERENCE.revoke({ jobId: 'runtime-eof' });
    await expect(runtime.INFERENCE.usage({ jobId: 'runtime-eof' })).resolves.toMatchObject({
      models: [{ requests: 1, incompleteRequests: 1, inputTokens: null }],
    });
  });

  it('seals pending usage at revoke and ignores a later completion', async () => {
    await control('hold');
    const token = await issue('runtime-sealed', ['deepseek-review']);
    const response = await request(token, { model: 'deepseek-review', messages: [] });
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);

    await runtime.INFERENCE.revoke({ jobId: 'runtime-sealed' });
    await expect(runtime.INFERENCE.usage({ jobId: 'runtime-sealed' })).resolves.toMatchObject({
      models: [{ requests: 1, incompleteRequests: 1 }],
    });

    await release();
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
    }
    await expect(runtime.INFERENCE.usage({ jobId: 'runtime-sealed' })).resolves.toMatchObject({
      models: [{ requests: 1, incompleteRequests: 1, model: null }],
    });
  });

  it('cancels the upstream fetch when the client disconnects', async () => {
    await control('silent');
    const token = await issue('runtime-disconnect', ['deepseek-review']);
    const aborter = new AbortController();
    const response = await runtime.INFERENCE.fetch(
      new Request('https://inference.internal/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ model: 'deepseek-review', messages: [] }),
        signal: aborter.signal,
      }),
    );
    const reader = response.body!.getReader();
    await reader.read();
    aborter.abort();
    await expect(reader.read()).rejects.toThrow();

    await runtime.INFERENCE.revoke({ jobId: 'runtime-disconnect' });
    await expect(runtime.INFERENCE.usage({ jobId: 'runtime-disconnect' })).resolves.toMatchObject({
      models: [{ requests: 1, incompleteRequests: 1 }],
    });
  });

  it('cancels the upstream fetch at local grant expiry', async () => {
    await control('silent');
    const token = await issue('runtime-local-expiry', ['deepseek-review']);
    const expiry = Date.now() + 250;
    await runtime.RELAY_DB.prepare('UPDATE grants SET expires_at = ? WHERE job_id = ?')
      .bind(expiry, 'runtime-local-expiry')
      .run();

    const response = await request(token, { model: 'deepseek-review', messages: [] });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    await reader.read();
    await expect(reader.read()).rejects.toThrow();

    await runtime.INFERENCE.revoke({ jobId: 'runtime-local-expiry' });
    await expect(runtime.INFERENCE.usage({ jobId: 'runtime-local-expiry' })).resolves.toMatchObject(
      {
        models: [{ requests: 1, incompleteRequests: 1 }],
      },
    );
  });
  it('bounds held terminal frames after the finish marker', async () => {
    await control('flood-after-finish');
    const token = await issue('runtime-flood', ['deepseek-review']);
    const response = await request(token, { model: 'deepseek-review', messages: [] });
    await expect(response.text()).rejects.toThrow();

    await runtime.INFERENCE.revoke({ jobId: 'runtime-flood' });
    await expect(runtime.INFERENCE.usage({ jobId: 'runtime-flood' })).resolves.toMatchObject({
      models: [{ requests: 1, incompleteRequests: 1 }],
    });
  });

  it('bounds held terminal bytes after the finish marker', async () => {
    await control('flood-bytes-after-finish');
    const token = await issue('runtime-flood-bytes', ['deepseek-review']);
    const response = await request(token, { model: 'deepseek-review', messages: [] });
    await expect(response.text()).rejects.toThrow();

    await runtime.INFERENCE.revoke({ jobId: 'runtime-flood-bytes' });
    await expect(runtime.INFERENCE.usage({ jobId: 'runtime-flood-bytes' })).resolves.toMatchObject({
      models: [{ requests: 1, incompleteRequests: 1 }],
    });
  });

  it('keeps a sibling job isolated when another job is revoked midstream', async () => {
    await control('hold');
    const tokenA = await issue('runtime-sibling-a', ['deepseek-review']);
    const tokenB = await issue('runtime-sibling-b', ['deepseek-review']);
    const responseA = await request(tokenA, { model: 'deepseek-review', messages: [] });
    const responseB = await request(tokenB, { model: 'deepseek-review', messages: [] });
    const readerA = responseA.body!.getReader();
    const readerB = responseB.body!.getReader();
    await Promise.all([readerA.read(), readerB.read()]);

    await runtime.INFERENCE.revoke({ jobId: 'runtime-sibling-a' });
    await release();
    await Promise.all([drain(readerA), drain(readerB)]);

    await expect(runtime.INFERENCE.usage({ jobId: 'runtime-sibling-a' })).resolves.toMatchObject({
      models: [{ requests: 1, incompleteRequests: 1 }],
    });
    await expect(runtime.INFERENCE.usage({ jobId: 'runtime-sibling-b' })).resolves.toMatchObject({
      models: [{ requests: 1, incompleteRequests: 0, inputTokens: { total: 10 } }],
    });
  });

  it('revokes while the upstream is still waiting for response headers', async () => {
    await control('wait-headers');
    const token = await issue('runtime-wait-headers', ['deepseek-review']);
    const pending = request(token, { model: 'deepseek-review', messages: [] });
    await waitFor(async () => (await upstreamState()).waitingHeaders >= 1);
    await runtime.INFERENCE.revoke({ jobId: 'runtime-wait-headers' });
    await release();
    const response = await pending;
    expect(response.status).toBe(200);
    await response.text();

    await expect(runtime.INFERENCE.usage({ jobId: 'runtime-wait-headers' })).resolves.toMatchObject(
      {
        models: [{ requests: 1, incompleteRequests: 1, model: null }],
      },
    );
  });

  it('denies admission when revoke lands during a slow request upload', async () => {
    await control('success');
    const token = await issue('runtime-slow-upload', ['deepseek-review']);
    const encoder = new TextEncoder();
    let releaseBody!: () => void;
    const bodyGate = new Promise<void>((resolve) => {
      releaseBody = resolve;
    });
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    let firstPull = true;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"model":"deepseek-review",'));
      },
      async pull(controller) {
        if (firstPull) {
          firstPull = false;
          signalStarted();
        }
        await bodyGate;
        controller.enqueue(encoder.encode('"messages":[]}'));
        controller.close();
      },
    });
    const pending = runtime.INFERENCE.fetch(
      new Request('https://inference.internal/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body,
      }),
    );
    await started;
    await runtime.INFERENCE.revoke({ jobId: 'runtime-slow-upload' });
    releaseBody();
    const response = await pending;
    expect(response.status).toBe(401);
    expect((await upstreamState()).requests).toHaveLength(0);
  });

  it('tears down a request waiting on headers at local expiry without hanging', async () => {
    await control('wait-headers');
    const token = await issue('runtime-header-expiry', ['deepseek-review']);
    await runtime.RELAY_DB.prepare('UPDATE grants SET expires_at = ? WHERE job_id = ?')
      .bind(Date.now() + 250, 'runtime-header-expiry')
      .run();
    const response = await request(token, { model: 'deepseek-review', messages: [] });
    expect(response.status).toBe(502);
    await release();
    await runtime.INFERENCE.revoke({ jobId: 'runtime-header-expiry' });
    await expect(
      runtime.INFERENCE.usage({ jobId: 'runtime-header-expiry' }),
    ).resolves.toMatchObject({
      models: [{ requests: 1, incompleteRequests: 1 }],
    });
  });
});

describe('Inference Worker usage retention', () => {
  it('returns null for an unknown job and for a tombstone', async () => {
    await expect(runtime.INFERENCE.usage({ jobId: 'runtime-absent' })).resolves.toBeNull();
    await runtime.INFERENCE.revoke({ jobId: 'runtime-tombstone' });
    await expect(runtime.INFERENCE.usage({ jobId: 'runtime-tombstone' })).resolves.toBeNull();
  });

  it('sweeps expired grants and their request rows in bounded batches', async () => {
    await control('success');
    const token = await issue('runtime-sweep', ['deepseek-review']);
    const response = await request(token, { model: 'deepseek-review', messages: [] });
    await response.text();

    await runtime.RELAY_DB.prepare('UPDATE grants SET expires_at = ? WHERE job_id = ?')
      .bind((await d1Now()) - 2 * 24 * 60 * 60 * 1000, 'runtime-sweep')
      .run();
    await expect(runtime.INFERENCE.sweep()).resolves.toBeGreaterThanOrEqual(1);
    await expect(runtime.INFERENCE.usage({ jobId: 'runtime-sweep' })).resolves.toBeNull();
    const rows = await runtime.RELAY_DB.prepare(
      'SELECT COUNT(*) AS count FROM inference_requests WHERE job_id = ?',
    )
      .bind('runtime-sweep')
      .first<{ readonly count: number }>();
    expect(rows?.count).toBe(0);
  });

  it('runs the retention sweep through the scheduled handler', async () => {
    await control('success');
    const token = await issue('runtime-scheduled', ['deepseek-review']);
    const response = await request(token, { model: 'deepseek-review', messages: [] });
    await response.text();

    await runtime.RELAY_DB.prepare('UPDATE grants SET expires_at = ? WHERE job_id = ?')
      .bind((await d1Now()) - 2 * 24 * 60 * 60 * 1000, 'runtime-scheduled')
      .run();
    await expect(runtime.INFERENCE.scheduled()).resolves.toBeUndefined();
    await expect(runtime.INFERENCE.usage({ jobId: 'runtime-scheduled' })).resolves.toBeNull();
  });
});

it('discovers provider models through the private relay binding on a scheduled refresh', async () => {
  await runtime.INFERENCE.refreshCatalog(Date.parse('2026-11-18T00:00:00Z'));
  expect(await runtime.INFERENCE.catalog()).toMatchObject({
    routes: expect.arrayContaining(['sample/tool-model']),
    rejected: 0,
    lastRefreshError: null,
  });
});

it('serves a claimed model through application control, managed inference, and durable usage across workers', async () => {
  const environment = {
    REVIEW_DB: runtime.REVIEW_DB,
    INFERENCE_RELAY: runtime.INFERENCE,
    RELAY_DEFAULT_MODEL_ROUTE: 'sample/tool-model',
    GITHUB_APP_ID: '1',
    GITHUB_APP_PRIVATE_KEY: 'unused',
    ALLOWED_INSTALLATION_IDS: '[7]',
    WEBHOOK_SECRET: 'unused',
    RUNNER_CALLBACK_TOKEN: 'test-runner',
  };
  const app = () =>
    createApplication(environment, {
      github: { getRepositoryUrl: async () => 'https://github.com/example/reviewed.git' },
      getReadInstallationToken: async () => ({
        token: 'read-only-test',
        expiresAt: '2099-01-01T00:00:00Z',
      }),
    });
  const post = (path: string, payload: unknown) =>
    app().fetch(
      new Request('https://app.example' + path, {
        method: 'POST',
        headers: { authorization: 'Bearer test-runner', 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }),
    );
  await control('success');
  await runtime.INFERENCE.refreshCatalog(Date.now());
  await createD1ReviewStateStore(runtime.REVIEW_DB, 'sample/tool-model').claimReview({
    deliveryId: 'integrated-grant',
    occurredAt: '2026-11-18T00:00:00Z',
    job: {
      repositoryId: 1,
      installationId: 7,
      pullRequestNumber: 1,
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      trigger: 'automatic',
    },
  });
  await control('retire-model');
  await runtime.INFERENCE.refreshCatalog(Date.now() + 1);
  expect((await runtime.INFERENCE.catalog()).routes).toEqual([
    'sample/common',
    'sample/replacement',
  ]);
  const claimed = await post('/runner-claim', {});
  expect(claimed.status).toBe(200);
  const claim = (await claimed.json()) as {
    id: string;
    runId: string;
    attempt: number;
    reviewConfiguration: { selection: { reviewers: string[] } };
  };
  const routes = claim.reviewConfiguration.selection.reviewers;
  const issued = await post('/runner-llm/issue', {
    jobId: claim.id,
    runId: claim.runId,
    attempt: claim.attempt,
    routes,
  });
  expect(issued.status).toBe(201);
  const { token } = (await issued.json()) as { token: string };
  const inference = () =>
    runtime.INFERENCE.fetch(
      new Request('https://inference.example/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify({ model: routes[0], messages: [{ role: 'user', content: 'test' }] }),
      }),
    );
  const result = await inference();
  expect(result.status).toBe(200);
  expect(await result.text()).toContain('[DONE]');
  expect((await post('/runner-llm/revoke', { jobId: claim.id })).status).toBe(204);
  expect((await inference()).status).toBe(401);
  const usage = await post('/runner-llm/usage', { jobId: claim.id });
  expect(await usage.json()).toMatchObject({
    models: [{ route: 'sample/tool-model', requests: 1, incompleteRequests: 0 }],
  });
});
