import { afterEach, expect, it, vi } from 'vitest';
import { createLlmService } from '../apps/llm-service/src/service';

// Exercise the public grant lifecycle with a shorter shared review budget.
vi.mock('../packages/contracts/src/index', () => ({ REVIEW_ATTEMPT_BUDGET_MS: 15 * 60 * 1000 }));

afterEach(() => vi.useRealTimers());

it('uses a one-hour grant and revocation lifetime for a fifteen-minute review budget', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-18T12:00:00Z'));
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
    expect(expiresAt).toBe('2026-10-18T13:00:00.000Z');
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
    await vi.advanceTimersByTimeAsync(3599999);
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
