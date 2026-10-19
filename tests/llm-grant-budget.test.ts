import { REVIEW_ATTEMPT_BUDGET_MS } from '../packages/contracts/src/index';
import { afterEach, expect, it, vi } from 'vitest';
import { createLlmService } from '../apps/llm-service/src/service';

afterEach(() => vi.useRealTimers());

it('derives grant and revocation lifetime from the shared review budget', async () => {
  vi.useFakeTimers();
  const issuedAt = new Date('2026-10-18T12:00:00Z').getTime();
  vi.setSystemTime(issuedAt);
  const lifetime = 4 * REVIEW_ATTEMPT_BUDGET_MS;
  const service = createLlmService({
    routes: [{ id: 'review', path: '/v1/chat/completions' }],
    upstream: async () => new Response('ok'),
  });
  const issue = (jobId: string) =>
    service.control(
      new Request('http://control/grants', {
        method: 'POST',
        body: JSON.stringify({ jobId, routes: ['review'] }),
      }),
    );
  try {
    const granted = await issue('active');
    const { token, expiresAt } = await granted.json();
    expect(expiresAt).toBe(new Date(issuedAt + lifetime).toISOString());
    const inference = () =>
      service.inference(
        new Request('http://inference/v1/chat/completions', {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({ model: 'review' }),
        }),
      );
    await service.control(
      new Request('http://control/grants/revoke', {
        method: 'POST',
        body: JSON.stringify({ jobId: 'cancelled-before-issue' }),
      }),
    );
    await vi.advanceTimersByTimeAsync(lifetime - 1);
    const before = await inference();
    expect(before.status).toBe(200);
    await before.text();
    expect((await issue('cancelled-before-issue')).status).toBe(409);
    await vi.advanceTimersByTimeAsync(1);
    expect((await inference()).status).toBe(401);
    expect((await issue('cancelled-before-issue')).status).toBe(201);
  } finally {
    service.close();
  }
});
