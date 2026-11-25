import { describe, expect, it, vi } from 'vitest';
import { createReadTokenClient } from '../apps/runner/src/read-token-client';

const identity = { runId: 'run-read-token', jobId: 'job-read-token', attempt: 1 };

describe('Runner read-token client', () => {
  it('does not start the transport when the caller signal is already aborted', async () => {
    let transports = 0;
    const client = createReadTokenClient({
      url: 'https://ingress.test/runner-read-token',
      token: 'callback-token',
      fetch: async () => {
        transports += 1;
        return Response.json({ token: 'read-token', expiresAt: new Date().toISOString() });
      },
    });
    const controller = new AbortController();
    controller.abort();

    await expect(client.refresh(identity, controller.signal)).rejects.toThrow(
      'read token refresh aborted',
    );
    expect(transports).toBe(0);
  });

  it('aborts a noncooperative transport when the caller cancels', async () => {
    let received: AbortSignal | undefined;
    const client = createReadTokenClient({
      url: 'https://ingress.test/runner-read-token',
      token: 'callback-token',
      fetch: async (_input, init) => {
        received = init?.signal ?? undefined;
        return new Promise<Response>(() => undefined);
      },
    });
    const controller = new AbortController();
    const pending = client.refresh(identity, controller.signal).catch((error: unknown) => error);
    await vi.waitFor(() => expect(received).toBeDefined());

    controller.abort();

    await expect(pending).resolves.toHaveProperty('message', 'read token refresh aborted');
    expect(received?.aborted).toBe(true);
  });

  it('times out a noncooperative transport without exposing its diagnostic', async () => {
    vi.useFakeTimers();
    try {
      const client = createReadTokenClient({
        url: 'https://ingress.test/runner-read-token',
        token: 'callback-token',
        timeoutMs: 25,
        fetch: async () => new Promise<Response>(() => undefined),
      });
      const pending = client.refresh(identity).catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(25);

      await expect(pending).resolves.toHaveProperty('message', 'read token refresh timed out');
    } finally {
      vi.useRealTimers();
    }
  });
});
