import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createLlmService } from '../apps/llm-service/src/service';
import { startLlmServer } from '../apps/llm-service/src/http-server';
import { createLlmServiceClient } from '../apps/runner/src/llm-service-client';

it('issues a usable job grant through the private socket and revokes its inference access', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runner-llm-client-'));
  const socket = join(root, 'control.sock');
  const service = createLlmService({
    routes: [{ id: 'review', path: '/v1/chat/completions' }],
    upstream: async () => new Response('review output'),
  });
  const server = await startLlmServer({ controlSocket: socket, port: 0, service });
  try {
    const client = createLlmServiceClient(socket);
    const before = Date.now();
    const grant = await client.issue('client-job', 'review');
    expect(grant.expiresAt).toBeGreaterThanOrEqual(before + 2 * 60 * 60 * 1000);
    const infer = () =>
      service.inference(
        new Request('http://service/v1/chat/completions', {
          method: 'POST',
          headers: { authorization: `Bearer ${grant.token}` },
          body: JSON.stringify({ model: 'review' }),
        }),
      );
    expect(await (await infer()).text()).toBe('review output');
    await client.revoke('client-job');
    expect((await infer()).status).toBe(401);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

it.each([
  [201, '{"token":"private-diagnostic","expiresAt":"not-a-date"}'],
  [201, '{"token":"private-diagnostic","expiresAt":"2030-01-01T00:00:00Z","extra":true}'],
  [503, 'private-diagnostic'],
  [201, 'private-diagnostic'.repeat(2000)],
])('rejects unusable control replies without exposing their content (%s)', async (status, body) => {
  const root = await mkdtemp(join(tmpdir(), 'runner-llm-reply-'));
  const socket = join(root, 'control.sock');
  const server = await startLlmServer({
    controlSocket: socket,
    port: 0,
    service: {
      control: async () => new Response(body, { status }),
      inference: async () => new Response(null, { status: 404 }),
      close: () => {},
    },
  });
  try {
    await expect(createLlmServiceClient(socket).issue('job', 'review')).rejects.toThrow(
      'LLM service grant unavailable',
    );
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('rejects an unavailable control socket with a sanitized error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runner-llm-missing-'));
  try {
    await expect(
      createLlmServiceClient(join(root, 'missing.sock')).issue('job', 'review'),
    ).rejects.toMatchObject({ message: 'LLM service grant unavailable' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('bounds a stalled grant response and closes the request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runner-llm-timeout-'));
  const socket = join(root, 'control.sock');
  let disconnected = false;
  const server = await startLlmServer({
    controlSocket: socket,
    port: 0,
    service: {
      control: async (request) =>
        new Promise<Response>((resolve) => {
          request.signal.addEventListener(
            'abort',
            () => {
              disconnected = true;
              resolve(new Response(null, { status: 503 }));
            },
            { once: true },
          );
        }),
      inference: async () => new Response(null, { status: 404 }),
      close: () => {},
    },
  });
  try {
    await expect(createLlmServiceClient(socket).issue('job', 'review')).rejects.toMatchObject({
      message: 'LLM service grant unavailable',
    });
    await vi.waitFor(() => expect(disconnected).toBe(true));
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}, 10000);
