import { afterEach, expect, it, vi } from 'vitest';
import { createLlmService } from '../apps/llm-service/src/service';
import type { UpstreamUsage } from '../apps/llm-service/src/usage';

afterEach(() => {
  vi.useRealTimers();
});

it('issues a two-hour grant and forwards an authorized model request', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-18T12:00:00.000Z'));

  const calls: { routeId: string; body: Record<string, unknown> }[] = [];
  const service = createLlmService({
    routes: [{ id: 'review', path: '/v1/chat/completions' }],
    upstream: async (routeId, body) => {
      calls.push({ routeId, body });
      return new Response('data: ok\n\n', {
        headers: { 'content-type': 'text/event-stream', 'x-secret': 'must-not-leak' },
      });
    },
  });

  const issued = await service.control(
    new Request('http://control.invalid/grants', {
      method: 'POST',
      body: JSON.stringify({ jobId: 'job-1', routes: ['review'] }),
    }),
  );
  expect(issued.status).toBe(201);
  const { token, expiresAt } = (await issued.json()) as { token: string; expiresAt: string };
  expect(token).toEqual(expect.any(String));
  expect(token.length).toBeGreaterThan(20);
  expect(Date.parse(expiresAt)).toBe(Date.now() + 2 * 60 * 60 * 1000);

  const response = await service.inference(
    new Request('http://inference.invalid/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: 'review', messages: [] }),
    }),
  );
  expect(response.status).toBe(200);
  await expect(response.text()).resolves.toBe('data: ok\n\n');
  expect(response.headers.get('x-secret')).toBeNull();
  expect(calls).toEqual([{ routeId: 'review', body: { model: 'review', messages: [] } }]);

  service.close();
});

it('returns grant-attributed model usage through the control socket', async () => {
  const service = createLlmService({
    routes: [{ id: 'review', path: '/v1/chat/completions' }],
    upstream: async (_routeId, _body, _signal, _sessionId, observe) => {
      observe?.({
        model: 'deepseek-v4.1-flash',
        inputTokens: 10,
        cacheReadTokens: 4,
        cacheWriteTokens: 2,
        outputTokens: 3,
        reasoningTokens: 1,
        complete: true,
      });
      return new Response('data: ok\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  try {
    const issued = await service.control(
      new Request('http://control/grants', {
        method: 'POST',
        body: JSON.stringify({ jobId: 'job-usage', routes: ['review'] }),
      }),
    );
    const { token } = (await issued.json()) as { token: string };
    const inference = await service.inference(
      new Request('http://service/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ model: 'review', messages: [] }),
      }),
    );
    await inference.text();

    const usage = await service.control(
      new Request('http://control/grants/usage', {
        method: 'POST',
        body: JSON.stringify({ jobId: 'job-usage' }),
      }),
    );
    expect(usage.status).toBe(200);
    expect(await usage.json()).toEqual({
      version: 1,
      models: [
        {
          route: 'review',
          model: 'deepseek-v4.1-flash',
          requests: 1,
          incompleteRequests: 0,
          inputTokens: { total: 10, reportedRequests: 1 },
          uncachedInputTokens: { total: 6, reportedRequests: 1 },
          cacheReadTokens: { total: 4, reportedRequests: 1 },
          cacheWriteTokens: { total: 2, reportedRequests: 1 },
          outputTokens: { total: 3, reportedRequests: 1 },
          reasoningTokens: { total: 1, reportedRequests: 1 },
        },
      ],
    });
  } finally {
    service.close();
  }
});

it('isolates usage between grants and records only the verified job identity', async () => {
  const service = createLlmService({
    routes: [{ id: 'review', path: '/v1/chat/completions' }],
    upstream: async (_routeId, _body, _signal, jobId, observe) => {
      observe?.({
        model: 'deepseek-v4.1-flash',
        inputTokens: jobId === 'job-a' ? 3 : 7,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        outputTokens: 1,
        reasoningTokens: null,
        complete: true,
      });
      return new Response('ok');
    },
  });
  try {
    const issue = (jobId: string) =>
      service.control(
        new Request('http://control/grants', {
          method: 'POST',
          body: JSON.stringify({ jobId, routes: ['review'] }),
        }),
      );
    const use = async (jobId: string, token: string) => {
      const response = await service.inference(
        new Request('http://service/v1/chat/completions', {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({ model: 'review' }),
        }),
      );
      await response.text();
    };
    const a = (await (await issue('job-a')).json()) as { token: string };
    const b = (await (await issue('job-b')).json()) as { token: string };
    await use('job-a', a.token);
    await use('job-b', b.token);

    const usage = async (jobId: string) =>
      (await (
        await service.control(
          new Request('http://control/grants/usage', {
            method: 'POST',
            body: JSON.stringify({ jobId }),
          }),
        )
      ).json()) as { models: Array<{ inputTokens: { total: number } }> };
    expect((await usage('job-a')).models[0]?.inputTokens.total).toBe(3);
    expect((await usage('job-b')).models[0]?.inputTokens.total).toBe(7);
  } finally {
    service.close();
  }
});

it('returns unknown and zero token counts distinctly with reported-request denominators', async () => {
  let call = 0;
  const service = createLlmService({
    routes: [{ id: 'review', path: '/v1/chat/completions' }],
    upstream: async (_routeId, _body, _signal, _jobId, observe) => {
      call += 1;
      observe?.(
        call === 1
          ? {
              model: 'deepseek-v4.1-flash',
              inputTokens: 10,
              cacheReadTokens: 4,
              cacheWriteTokens: 2,
              outputTokens: 0,
              reasoningTokens: 0,
              complete: true,
            }
          : {
              model: 'deepseek-v4.1-flash',
              inputTokens: 20,
              cacheReadTokens: null,
              cacheWriteTokens: null,
              outputTokens: null,
              reasoningTokens: null,
              complete: false,
            },
      );
      return new Response('ok');
    },
  });
  try {
    const issued = await service.control(
      new Request('http://control/grants', {
        method: 'POST',
        body: JSON.stringify({ jobId: 'job-counts', routes: ['review'] }),
      }),
    );
    const { token } = (await issued.json()) as { token: string };
    for (let index = 0; index < 2; index += 1) {
      const response = await service.inference(
        new Request('http://service/v1/chat/completions', {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({ model: 'review' }),
        }),
      );
      await response.text();
    }
    const usage = await service.control(
      new Request('http://control/grants/usage', {
        method: 'POST',
        body: JSON.stringify({ jobId: 'job-counts' }),
      }),
    );
    expect(await usage.json()).toEqual({
      version: 1,
      models: [
        {
          route: 'review',
          model: 'deepseek-v4.1-flash',
          requests: 2,
          incompleteRequests: 1,
          inputTokens: { total: 30, reportedRequests: 2 },
          uncachedInputTokens: { total: 6, reportedRequests: 1 },
          cacheReadTokens: { total: 4, reportedRequests: 1 },
          cacheWriteTokens: { total: 2, reportedRequests: 1 },
          outputTokens: { total: 0, reportedRequests: 1 },
          reasoningTokens: { total: 0, reportedRequests: 1 },
        },
      ],
    });
  } finally {
    service.close();
  }
});

it('freezes usage after revoke, after observing the aborted request', async () => {
  let observe: ((usage: UpstreamUsage) => void) | undefined;
  let aborted = false;
  const service = createLlmService({
    routes: [{ id: 'review', path: '/v1/chat/completions' }],
    upstream: async (_routeId, _body, signal, _jobId, observer) => {
      observe = observer;
      signal.addEventListener(
        'abort',
        () => {
          aborted = true;
          observer?.({
            model: 'deepseek-v4.1-flash',
            inputTokens: 9,
            cacheReadTokens: 3,
            cacheWriteTokens: null,
            outputTokens: 2,
            reasoningTokens: null,
            complete: false,
          });
        },
        { once: true },
      );
      return new Response(new ReadableStream<Uint8Array>({}, { highWaterMark: 0 }), {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  try {
    const issued = await service.control(
      new Request('http://control/grants', {
        method: 'POST',
        body: JSON.stringify({ jobId: 'job-freeze', routes: ['review'] }),
      }),
    );
    const { token } = (await issued.json()) as { token: string };
    await service.inference(
      new Request('http://service/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ model: 'review' }),
      }),
    );
    await service.control(
      new Request('http://control/grants/revoke', {
        method: 'POST',
        body: JSON.stringify({ jobId: 'job-freeze' }),
      }),
    );
    expect(aborted).toBe(true);
    observe?.({
      model: 'deepseek-v4.1-flash',
      inputTokens: 999,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      complete: true,
    });
    const usage = await service.control(
      new Request('http://control/grants/usage', {
        method: 'POST',
        body: JSON.stringify({ jobId: 'job-freeze' }),
      }),
    );
    expect(usage.status).toBe(200);
    expect(await usage.json()).toMatchObject({
      version: 1,
      models: [
        {
          requests: 1,
          incompleteRequests: 1,
          inputTokens: { total: 9, reportedRequests: 1 },
          cacheReadTokens: { total: 3, reportedRequests: 1 },
        },
      ],
    });
  } finally {
    service.close();
  }
});

it('bounds usage rows at insertion and marks an overflowing summary truncated', async () => {
  let model = 0;
  const service = createLlmService({
    routes: [{ id: 'review', path: '/v1/chat/completions' }],
    upstream: async (_routeId, _body, _signal, _jobId, observe) => {
      model += 1;
      observe?.({
        model: `model-${model}`,
        inputTokens: 1,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        outputTokens: 1,
        reasoningTokens: null,
        complete: true,
      });
      return new Response('ok');
    },
  });
  try {
    const issued = await service.control(
      new Request('http://control/grants', {
        method: 'POST',
        body: JSON.stringify({ jobId: 'job-overflow', routes: ['review'] }),
      }),
    );
    const { token } = (await issued.json()) as { token: string };
    for (let index = 0; index < 33; index += 1) {
      const response = await service.inference(
        new Request('http://service/v1/chat/completions', {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({ model: 'review' }),
        }),
      );
      await response.text();
    }
    const usage = await service.control(
      new Request('http://control/grants/usage', {
        method: 'POST',
        body: JSON.stringify({ jobId: 'job-overflow' }),
      }),
    );
    const body = (await usage.json()) as { models: unknown[]; truncated?: boolean };
    expect(body.models).toHaveLength(32);
    expect(body.truncated).toBe(true);
  } finally {
    service.close();
  }
});

it('rejects malformed usage control bodies and unknown or tombstoned jobs', async () => {
  const service = createLlmService({
    routes: [{ id: 'review', path: '/v1/chat/completions' }],
    upstream: async () => new Response('ok'),
  });
  try {
    const call = (body: string) =>
      service.control(new Request('http://control/grants/usage', { method: 'POST', body }));
    expect((await call('not json')).status).toBe(400);
    expect((await call(JSON.stringify({ jobId: 'unknown' }))).status).toBe(404);
    expect((await call(JSON.stringify({ jobId: 'unknown', extra: true }))).status).toBe(400);
    await service.control(
      new Request('http://control/grants/revoke', {
        method: 'POST',
        body: JSON.stringify({ jobId: 'tombstone' }),
      }),
    );
    expect((await call(JSON.stringify({ jobId: 'tombstone' }))).status).toBe(404);
  } finally {
    service.close();
  }
});

it('rejects a grant at its two-hour expiry boundary', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const issuedAt = new Date('2026-10-18T12:00:00.000Z').getTime();
  vi.setSystemTime(issuedAt);

  const service = createLlmService({
    routes: [{ id: 'review', path: '/v1/responses' }],
    upstream: async () => new Response('ok'),
  });
  const issued = await service.control(
    new Request('http://control.invalid/grants', {
      method: 'POST',
      body: JSON.stringify({ jobId: 'job-expiry', routes: ['review'] }),
    }),
  );
  const { token } = (await issued.json()) as { token: string };
  const call = () =>
    service.inference(
      new Request('http://inference.invalid/v1/responses', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ model: 'review', input: 'hello' }),
      }),
    );

  vi.setSystemTime(issuedAt + 2 * 60 * 60 * 1000 - 1);
  const before = await call();
  expect(before.status).toBe(200);
  await before.text();

  vi.setSystemTime(issuedAt + 2 * 60 * 60 * 1000);
  expect((await call()).status).toBe(401);

  service.close();
});

it('revokes a grant idempotently and rejects its token', async () => {
  const service = createLlmService({
    routes: [{ id: 'review', path: '/v1/chat/completions' }],
    upstream: async () => new Response('ok'),
  });
  const issued = await service.control(
    new Request('http://control.invalid/grants', {
      method: 'POST',
      body: JSON.stringify({ jobId: 'job-revoke', routes: ['review'] }),
    }),
  );
  const { token } = (await issued.json()) as { token: string };
  const revoke = () =>
    service.control(
      new Request('http://control.invalid/grants/revoke', {
        method: 'POST',
        body: JSON.stringify({ jobId: 'job-revoke' }),
      }),
    );
  expect((await revoke()).status).toBe(204);
  expect((await revoke()).status).toBe(204);

  const response = await service.inference(
    new Request('http://inference.invalid/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: 'review' }),
    }),
  );
  expect(response.status).toBe(401);
  service.close();
});

it('rejects duplicate issuance even after revocation', async () => {
  const service = createLlmService({
    routes: [{ id: 'review', path: '/v1/chat/completions' }],
    upstream: async () => new Response('ok'),
  });
  const issue = () =>
    service.control(
      new Request('http://control.invalid/grants', {
        method: 'POST',
        body: JSON.stringify({ jobId: 'job-duplicate', routes: ['review'] }),
      }),
    );
  expect((await issue()).status).toBe(201);
  expect((await issue()).status).toBe(409);
  await service.control(
    new Request('http://control.invalid/grants/revoke', {
      method: 'POST',
      body: JSON.stringify({ jobId: 'job-duplicate' }),
    }),
  );
  expect((await issue()).status).toBe(409);
  service.close();
});

it('rechecks revocation after async grant preparation', async () => {
  let started!: () => void;
  let release!: () => void;
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = createLlmService({
    prepareGrant: async () => {
      started();
      await gate;
      return {
        routes: [{ id: 'review', path: '/v1/chat/completions' as const }],
        upstream: async () => new Response('ok'),
      };
    },
  });
  try {
    const issuing = service.control(
      new Request('http://control.invalid/grants', {
        method: 'POST',
        body: JSON.stringify({ jobId: 'job-revoke-race', routes: ['review'] }),
      }),
    );
    await startedPromise;
    const revoked = await service.control(
      new Request('http://control.invalid/grants/revoke', {
        method: 'POST',
        body: JSON.stringify({ jobId: 'job-revoke-race' }),
      }),
    );
    expect(revoked.status).toBe(204);
    release();
    expect((await issuing).status).toBe(409);
  } finally {
    service.close();
  }
});

it('rechecks closure after async grant preparation', async () => {
  let started!: () => void;
  let release!: () => void;
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = createLlmService({
    prepareGrant: async () => {
      started();
      await gate;
      return {
        routes: [{ id: 'review', path: '/v1/chat/completions' as const }],
        upstream: async () => new Response('ok'),
      };
    },
  });
  try {
    const issuing = service.control(
      new Request('http://control.invalid/grants', {
        method: 'POST',
        body: JSON.stringify({ jobId: 'job-close-race', routes: ['review'] }),
      }),
    );
    await startedPromise;
    service.close();
    release();
    expect((await issuing).status).toBe(503);
  } finally {
    service.close();
  }
});

it('does not issue duplicates that race through async grant preparation', async () => {
  let prepared = 0;
  let bothStarted!: () => void;
  let release!: () => void;
  const bothStartedPromise = new Promise<void>((resolve) => {
    bothStarted = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = createLlmService({
    prepareGrant: async () => {
      prepared += 1;
      if (prepared === 2) bothStarted();
      await gate;
      return {
        routes: [{ id: 'review', path: '/v1/chat/completions' as const }],
        upstream: async () => new Response('ok'),
      };
    },
  });
  try {
    const issue = () =>
      service.control(
        new Request('http://control.invalid/grants', {
          method: 'POST',
          body: JSON.stringify({ jobId: 'job-duplicate-race', routes: ['review'] }),
        }),
      );
    const first = issue();
    const second = issue();
    await bothStartedPromise;
    release();
    const statuses = (await Promise.all([first, second])).map((response) => response.status);
    expect(statuses.sort((left, right) => left - right)).toEqual([201, 409]);
  } finally {
    service.close();
  }
});

it('tombstones a revocation for a job that has not been issued yet', async () => {
  const service = createLlmService({
    routes: [{ id: 'review', path: '/v1/chat/completions' }],
    upstream: async () => new Response('ok'),
  });
  const revoke = await service.control(
    new Request('http://control.invalid/grants/revoke', {
      method: 'POST',
      body: JSON.stringify({ jobId: 'job-late' }),
    }),
  );
  expect(revoke.status).toBe(204);
  const issue = await service.control(
    new Request('http://control.invalid/grants', {
      method: 'POST',
      body: JSON.stringify({ jobId: 'job-late', routes: ['review'] }),
    }),
  );
  expect(issue.status).toBe(409);
  service.close();
});

it('enforces the grant route allowlist and keeps control and inference separate', async () => {
  let calls = 0;
  const service = createLlmService({
    routes: [
      { id: 'review-chat', path: '/v1/chat/completions' },
      { id: 'review-responses', path: '/v1/responses' },
    ],
    upstream: async () => {
      calls += 1;
      return new Response('ok');
    },
  });
  const issued = await service.control(
    new Request('http://control.invalid/grants', {
      method: 'POST',
      body: JSON.stringify({ jobId: 'job-routes', routes: ['review-chat'] }),
    }),
  );
  const { token } = (await issued.json()) as { token: string };
  const call = (path: string, model: string) =>
    service.inference(
      new Request(`http://inference.invalid${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ model }),
      }),
    );

  const allowed = await call('/v1/chat/completions', 'review-chat');
  expect(allowed.status).toBe(200);
  await allowed.text();
  expect((await call('/v1/chat/completions', 'review-responses')).status).toBe(403);
  expect((await call('/v1/chat/completions', 'unknown-model')).status).toBe(403);
  expect((await call('/v1/responses', 'review-chat')).status).toBe(403);
  expect((await call('/v1/unknown', 'review-chat')).status).toBe(404);
  expect((await call('/grants', 'review-chat')).status).toBe(404);
  expect(
    (
      await service.control(
        new Request('http://control.invalid/v1/chat/completions', { method: 'POST', body: '{}' }),
      )
    ).status,
  ).toBe(404);
  expect(calls).toBe(1);
  service.close();
});

it('rejects malformed control bodies, unknown routes and malformed inference bodies', async () => {
  const service = createLlmService({
    routes: [{ id: 'review', path: '/v1/chat/completions' }],
    upstream: async () => new Response('ok'),
  });
  const control = (body: string) =>
    service.control(new Request('http://control.invalid/grants', { method: 'POST', body }));
  expect((await control('not json')).status).toBe(400);
  expect(
    (await control(JSON.stringify({ jobId: 'job-a', routes: ['review'], extra: true }))).status,
  ).toBe(400);
  expect((await control(JSON.stringify({ jobId: 'job-b', routes: ['missing'] }))).status).toBe(400);
  expect((await control(JSON.stringify({ jobId: 'job-c', routes: 'review' }))).status).toBe(400);

  const revoke = (body: string) =>
    service.control(new Request('http://control.invalid/grants/revoke', { method: 'POST', body }));
  expect((await revoke('not json')).status).toBe(400);
  expect((await revoke(JSON.stringify({ jobId: 'job-d', extra: true }))).status).toBe(400);

  const issued = await control(JSON.stringify({ jobId: 'job-valid', routes: ['review'] }));
  const { token } = (await issued.json()) as { token: string };
  const infer = (body: string) =>
    service.inference(
      new Request('http://inference.invalid/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body,
      }),
    );
  expect((await infer('not json')).status).toBe(400);
  expect((await infer(JSON.stringify({ messages: [] }))).status).toBe(400);
  expect((await infer(JSON.stringify({ model: 7 }))).status).toBe(400);
  service.close();
});

it('bounds control requests at sixteen kibibytes', async () => {
  const service = createLlmService({
    routes: [{ id: 'review', path: '/v1/chat/completions' }],
    upstream: async () => new Response('ok'),
  });
  const oversized = await service.control(
    new Request('http://control.invalid/grants', {
      method: 'POST',
      body: `{"jobId":"${'x'.repeat(17 * 1024)}","routes":["review"]}`,
    }),
  );
  expect(oversized.status).toBe(413);
  service.close();
});

it('bounds inference requests at sixteen mebibytes', async () => {
  let calls = 0;
  const service = createLlmService({
    routes: [{ id: 'review', path: '/v1/chat/completions' }],
    upstream: async () => {
      calls += 1;
      return new Response('ok');
    },
  });
  const issued = await service.control(
    new Request('http://control.invalid/grants', {
      method: 'POST',
      body: JSON.stringify({ jobId: 'job-large', routes: ['review'] }),
    }),
  );
  const { token } = (await issued.json()) as { token: string };
  const response = await service.inference(
    new Request('http://inference.invalid/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: 'review', padding: 'x'.repeat(16 * 1024 * 1024) }),
    }),
  );
  expect(response.status).toBe(413);
  expect(calls).toBe(0);
  service.close();
});

it('streams on demand and aborts the upstream when the response is cancelled', async () => {
  let upstreamSignal: AbortSignal | undefined;
  let upstreamCancelled = false;
  let pulls = 0;
  const service = createLlmService({
    routes: [{ id: 'review', path: '/v1/chat/completions' }],
    upstream: async (_routeId, _body, signal) => {
      upstreamSignal = signal;
      return new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              pulls += 1;
              controller.enqueue(new TextEncoder().encode(`chunk-${pulls}`));
            },
            cancel() {
              upstreamCancelled = true;
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: { 'content-type': 'text/event-stream', 'x-secret': 'must-not-leak' } },
      );
    },
  });
  const issued = await service.control(
    new Request('http://control.invalid/grants', {
      method: 'POST',
      body: JSON.stringify({ jobId: 'job-stream', routes: ['review'] }),
    }),
  );
  const { token } = (await issued.json()) as { token: string };
  const response = await service.inference(
    new Request('http://inference.invalid/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: 'review' }),
    }),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get('x-secret')).toBeNull();
  expect(pulls).toBe(0);

  const reader = response.body!.getReader();
  const first = await reader.read();
  expect(new TextDecoder().decode(first.value)).toBe('chunk-1');
  expect(pulls).toBe(1);

  await reader.cancel();
  expect(upstreamCancelled).toBe(true);
  expect(upstreamSignal?.aborted).toBe(true);
  service.close();
});

it('aborts an active upstream stream when its grant is revoked', async () => {
  let upstreamSignal: AbortSignal | undefined;
  let upstreamCancelled = false;
  const service = createLlmService({
    routes: [{ id: 'review', path: '/v1/chat/completions' }],
    upstream: async (_routeId, _body, signal) => {
      upstreamSignal = signal;
      return new Response(
        new ReadableStream<Uint8Array>(
          {
            cancel: () => {
              upstreamCancelled = true;
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const issued = await service.control(
    new Request('http://control.invalid/grants', {
      method: 'POST',
      body: JSON.stringify({ jobId: 'job-inflight-revoke', routes: ['review'] }),
    }),
  );
  const { token } = (await issued.json()) as { token: string };
  const response = await service.inference(
    new Request('http://inference.invalid/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: 'review' }),
    }),
  );
  expect(response.status).toBe(200);
  expect(upstreamSignal?.aborted).toBe(false);

  await service.control(
    new Request('http://control.invalid/grants/revoke', {
      method: 'POST',
      body: JSON.stringify({ jobId: 'job-inflight-revoke' }),
    }),
  );
  expect(upstreamSignal?.aborted).toBe(true);
  expect(upstreamCancelled).toBe(true);
  service.close();
});

it('aborts an active upstream stream at grant expiry', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(new Date('2026-10-18T12:00:00.000Z'));

  let upstreamSignal: AbortSignal | undefined;
  let upstreamCancelled = false;
  const service = createLlmService({
    routes: [{ id: 'review', path: '/v1/chat/completions' }],
    upstream: async (_routeId, _body, signal) => {
      upstreamSignal = signal;
      return new Response(
        new ReadableStream<Uint8Array>(
          {
            cancel: () => {
              upstreamCancelled = true;
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const issued = await service.control(
    new Request('http://control.invalid/grants', {
      method: 'POST',
      body: JSON.stringify({ jobId: 'job-inflight-expiry', routes: ['review'] }),
    }),
  );
  const { token } = (await issued.json()) as { token: string };
  const response = await service.inference(
    new Request('http://inference.invalid/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: 'review' }),
    }),
  );
  expect(response.status).toBe(200);
  expect(upstreamSignal?.aborted).toBe(false);

  await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
  expect(upstreamSignal?.aborted).toBe(true);
  expect(upstreamCancelled).toBe(true);
  service.close();
});

it('aborts an active upstream stream when the inference request is cancelled', async () => {
  let upstreamSignal: AbortSignal | undefined;
  const service = createLlmService({
    routes: [{ id: 'review', path: '/v1/chat/completions' }],
    upstream: async (_routeId, _body, signal) => {
      upstreamSignal = signal;
      return new Response(new ReadableStream<Uint8Array>({}, { highWaterMark: 0 }), {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  const issued = await service.control(
    new Request('http://control.invalid/grants', {
      method: 'POST',
      body: JSON.stringify({ jobId: 'job-request-abort', routes: ['review'] }),
    }),
  );
  const { token } = (await issued.json()) as { token: string };
  const client = new AbortController();
  const response = await service.inference(
    new Request('http://inference.invalid/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: 'review' }),
      signal: client.signal,
    }),
  );
  expect(response.status).toBe(200);
  expect(upstreamSignal?.aborted).toBe(false);

  client.abort();
  expect(upstreamSignal?.aborted).toBe(true);
  service.close();
});

it('aborts active streams and refuses new work after close', async () => {
  let upstreamSignal: AbortSignal | undefined;
  const service = createLlmService({
    routes: [{ id: 'review', path: '/v1/chat/completions' }],
    upstream: async (_routeId, _body, signal) => {
      upstreamSignal = signal;
      return new Response(new ReadableStream<Uint8Array>({}, { highWaterMark: 0 }), {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  const issued = await service.control(
    new Request('http://control.invalid/grants', {
      method: 'POST',
      body: JSON.stringify({ jobId: 'job-close', routes: ['review'] }),
    }),
  );
  const { token } = (await issued.json()) as { token: string };
  const response = await service.inference(
    new Request('http://inference.invalid/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: 'review' }),
    }),
  );
  expect(response.status).toBe(200);
  expect(upstreamSignal?.aborted).toBe(false);

  service.close();
  expect(upstreamSignal?.aborted).toBe(true);
  const afterClose = await service.inference(
    new Request('http://inference.invalid/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: 'review' }),
    }),
  );
  expect(afterClose.status).toBe(503);
});

it('does not reach upstream when the grant is revoked during a slow upload', async () => {
  let upstreamCalls = 0;
  const service = createLlmService({
    routes: [{ id: 'review', path: '/v1/chat/completions' }],
    upstream: async () => {
      upstreamCalls += 1;
      return new Response('ok');
    },
  });
  const issued = await service.control(
    new Request('http://control.invalid/grants', {
      method: 'POST',
      body: JSON.stringify({ jobId: 'job-slow-revoke', routes: ['review'] }),
    }),
  );
  const { token } = (await issued.json()) as { token: string };

  let pulled = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      pulled = true;
      await gate;
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ model: 'review' })));
      controller.close();
    },
  });
  const pending = service.inference(
    new Request('http://inference.invalid/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' }),
  );
  while (!pulled) await Promise.resolve();

  await service.control(
    new Request('http://control.invalid/grants/revoke', {
      method: 'POST',
      body: JSON.stringify({ jobId: 'job-slow-revoke' }),
    }),
  );
  release();

  expect((await pending).status).toBe(401);
  expect(upstreamCalls).toBe(0);
  service.close();
});

it('does not reach upstream when the service closes during a slow upload', async () => {
  let upstreamCalls = 0;
  const service = createLlmService({
    routes: [{ id: 'review', path: '/v1/chat/completions' }],
    upstream: async () => {
      upstreamCalls += 1;
      return new Response('ok');
    },
  });
  const issued = await service.control(
    new Request('http://control.invalid/grants', {
      method: 'POST',
      body: JSON.stringify({ jobId: 'job-slow-close', routes: ['review'] }),
    }),
  );
  const { token } = (await issued.json()) as { token: string };

  let pulled = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      pulled = true;
      await gate;
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ model: 'review' })));
      controller.close();
    },
  });
  const pending = service.inference(
    new Request('http://inference.invalid/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' }),
  );
  while (!pulled) await Promise.resolve();

  service.close();
  release();

  expect((await pending).status).toBe(503);
  expect(upstreamCalls).toBe(0);
});

it('cannot mint a grant when the service closes during a slow control upload', async () => {
  const service = createLlmService({
    routes: [{ id: 'review', path: '/v1/chat/completions' }],
    upstream: async () => new Response('ok'),
  });

  let pulled = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      pulled = true;
      await gate;
      controller.enqueue(
        new TextEncoder().encode(JSON.stringify({ jobId: 'job-slow-mint', routes: ['review'] })),
      );
      controller.close();
    },
  });
  const pending = service.control(
    new Request('http://control.invalid/grants', {
      method: 'POST',
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' }),
  );
  while (!pulled) await Promise.resolve();

  service.close();
  release();

  expect((await pending).status).toBe(503);
  const afterClose = await service.control(
    new Request('http://control.invalid/grants', {
      method: 'POST',
      body: JSON.stringify({ jobId: 'job-slow-mint', routes: ['review'] }),
    }),
  );
  expect(afterClose.status).toBe(503);
});

it('retires a revoked grant at its original expiry and keeps its token invalid', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(new Date('2026-10-18T12:00:00.000Z'));

  const service = createLlmService({
    routes: [{ id: 'review', path: '/v1/chat/completions' }],
    upstream: async () => new Response('ok'),
  });
  const issue = (jobId: string) =>
    service.control(
      new Request('http://control.invalid/grants', {
        method: 'POST',
        body: JSON.stringify({ jobId, routes: ['review'] }),
      }),
    );
  const issued = await issue('job-retire');
  const { token } = (await issued.json()) as { token: string };
  await service.control(
    new Request('http://control.invalid/grants/revoke', {
      method: 'POST',
      body: JSON.stringify({ jobId: 'job-retire' }),
    }),
  );

  await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);

  const stale = await service.inference(
    new Request('http://inference.invalid/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: 'review' }),
    }),
  );
  expect(stale.status).toBe(401);
  expect((await issue('job-retire')).status).toBe(201);

  const fresh = await issue('job-fresh');
  const freshToken = ((await fresh.json()) as { token: string }).token;
  const allowed = await service.inference(
    new Request('http://inference.invalid/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${freshToken}` },
      body: JSON.stringify({ model: 'review' }),
    }),
  );
  expect(allowed.status).toBe(200);
  await allowed.text();
  service.close();
});

it('retires an unknown revocation tombstone so the job can be issued later', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(new Date('2026-10-18T12:00:00.000Z'));

  const service = createLlmService({
    routes: [{ id: 'review', path: '/v1/chat/completions' }],
    upstream: async () => new Response('ok'),
  });
  const issue = () =>
    service.control(
      new Request('http://control.invalid/grants', {
        method: 'POST',
        body: JSON.stringify({ jobId: 'job-tombstone', routes: ['review'] }),
      }),
    );
  await service.control(
    new Request('http://control.invalid/grants/revoke', {
      method: 'POST',
      body: JSON.stringify({ jobId: 'job-tombstone' }),
    }),
  );
  expect((await issue()).status).toBe(409);

  await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
  expect((await issue()).status).toBe(201);
  service.close();
});

const deferredUpstream = () => {
  let called = false;
  let resolve!: (response: Response) => void;
  const pending = new Promise<Response>((settle) => {
    resolve = settle;
  });
  const state = { pulls: 0, cancelled: false };
  return {
    upstream: async (): Promise<Response> => {
      called = true;
      return pending;
    },
    respond: () =>
      resolve(
        new Response(
          new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                state.pulls += 1;
                controller.enqueue(new TextEncoder().encode('leak'));
              },
              cancel() {
                state.cancelled = true;
              },
            },
            { highWaterMark: 0 },
          ),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      ),
    isCalled: () => called,
    state,
  };
};

const startDeferredInference = async (
  service: ReturnType<typeof createLlmService>,
  jobId: string,
) => {
  const issued = await service.control(
    new Request('http://control.invalid/grants', {
      method: 'POST',
      body: JSON.stringify({ jobId, routes: ['review'] }),
    }),
  );
  const { token } = (await issued.json()) as { token: string };
  const client = new AbortController();
  const pending = service.inference(
    new Request('http://inference.invalid/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: 'review' }),
      signal: client.signal,
    }),
  );
  return { pending, client };
};

it('does not emit upstream bytes when the grant is revoked while the response is pending', async () => {
  const deferred = deferredUpstream();
  const service = createLlmService({
    routes: [{ id: 'review', path: '/v1/chat/completions' }],
    upstream: deferred.upstream,
  });
  const { pending } = await startDeferredInference(service, 'job-deferred-revoke');
  await vi.waitFor(() => {
    expect(deferred.isCalled()).toBe(true);
  });

  await service.control(
    new Request('http://control.invalid/grants/revoke', {
      method: 'POST',
      body: JSON.stringify({ jobId: 'job-deferred-revoke' }),
    }),
  );
  deferred.respond();

  const response = await pending;
  expect(response.status).toBe(401);
  expect(await response.text()).not.toContain('leak');
  expect(deferred.state.pulls).toBe(0);
  expect(deferred.state.cancelled).toBe(true);
  service.close();
});

it('does not emit upstream bytes when the request is cancelled while the response is pending', async () => {
  const deferred = deferredUpstream();
  const service = createLlmService({
    routes: [{ id: 'review', path: '/v1/chat/completions' }],
    upstream: deferred.upstream,
  });
  const { pending, client } = await startDeferredInference(service, 'job-deferred-cancel');
  await vi.waitFor(() => {
    expect(deferred.isCalled()).toBe(true);
  });

  client.abort();
  deferred.respond();

  const response = await pending;
  expect(response.status).toBe(401);
  expect(await response.text()).not.toContain('leak');
  expect(deferred.state.pulls).toBe(0);
  expect(deferred.state.cancelled).toBe(true);
  service.close();
});

it('does not emit upstream bytes when the service closes while the response is pending', async () => {
  const deferred = deferredUpstream();
  const service = createLlmService({
    routes: [{ id: 'review', path: '/v1/chat/completions' }],
    upstream: deferred.upstream,
  });
  const { pending } = await startDeferredInference(service, 'job-deferred-close');
  await vi.waitFor(() => {
    expect(deferred.isCalled()).toBe(true);
  });

  service.close();
  deferred.respond();

  const response = await pending;
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain('leak');
  expect(deferred.state.pulls).toBe(0);
  expect(deferred.state.cancelled).toBe(true);
});
