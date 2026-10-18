import { request } from 'node:http';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { startLlmServer } from '../apps/llm-service/src/http-server';

it('exposes control only on a private Unix socket and inference only on loopback HTTP', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'llm-server-'));
  const socket = join(dir, 'control.sock');
  const server = await startLlmServer({
    controlSocket: socket,
    port: 0,
    service: {
      control: async () => new Response('control'),
      inference: async () => new Response('inference'),
      close: () => {},
    },
  });
  try {
    expect((await stat(socket)).mode & 0o777).toBe(0o600);
    expect(await (await fetch(`http://127.0.0.1:${server.port}/grants`)).text()).toBe('inference');
    const control = await new Promise<string>((resolve, reject) => {
      const req = request({ socketPath: socket, path: '/grants', method: 'POST' }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (data: Buffer) => chunks.push(data));
        res.on('end', () => resolve(Buffer.concat(chunks).toString()));
      });
      req.on('error', reject);
      req.end();
    });
    expect(control).toBe('control');
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it('rejects invalid startup configuration before opening listeners', async () => {
  const { startConfiguredService } = await import('../apps/llm-service/src/bootstrap');
  const dir = await mkdtemp(join(tmpdir(), 'llm-config-'));
  try {
    const file = join(dir, 'config.toml');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, 'controlSocket = "relative.sock"\nport = 0\nroutes = []');
    await expect(startConfiguredService(file)).rejects.toThrow('invalid LLM service configuration');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('can restart on the same control socket after the inference port was occupied', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'llm-conflict-'));
  const service = {
    control: async () => new Response('control'),
    inference: async () => new Response('inference'),
    close: () => {},
  };
  const occupied = await startLlmServer({
    service,
    controlSocket: join(dir, 'first.sock'),
    port: 0,
  });
  const socket = join(dir, 'second.sock');
  try {
    await expect(
      startLlmServer({ service, controlSocket: socket, port: occupied.port }),
    ).rejects.toThrow();
    const restarted = await startLlmServer({ service, controlSocket: socket, port: 0 });
    try {
      expect(await (await fetch(`http://127.0.0.1:${restarted.port}/`)).text()).toBe('inference');
    } finally {
      await restarted.close();
    }
  } finally {
    await occupied.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it('excludes a second subscription service and login until the owner closes', async () => {
  const { startConfiguredService } = await import('../apps/llm-service/src/bootstrap');
  const { loginSubscription } = await import('../apps/llm-service/src/credentials');
  const { writeFile } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'llm-owner-'));
  const credentialFile = join(dir, 'oauth');
  const config = join(dir, 'service.toml');
  // Reserve an available port, then release it for configured startup.
  const probe = await startLlmServer({
    controlSocket: join(dir, 'probe.sock'),
    port: 0,
    service: {
      control: async () => new Response(),
      inference: async () => new Response(),
      close: () => {},
    },
  });
  const port = probe.port;
  await probe.close();
  await writeFile(credentialFile, '{}', { mode: 0o600 });
  await writeFile(
    config,
    `controlSocket = "${dir}/control.sock"\nport = ${port}\n[[routes]]\nid = "subscription"\nprotocol = "codex-responses"\nmodel = "gpt-6.1-sol"\nbaseUrl = "https://chatgpt.com/backend-api"\ncredentialFile = "${credentialFile}"\n`,
  );
  const owner = await startConfiguredService(config);
  try {
    await expect(
      loginSubscription(credentialFile, {
        prompt: async () => {
          throw new Error('login unexpectedly started');
        },
        notify: () => {},
      }),
    ).rejects.toThrow('subscription credential already owned');
    await expect(startConfiguredService(config)).rejects.toThrow(
      'subscription credential already owned',
    );
  } finally {
    await owner.close();
  }
  try {
    const restarted = await startConfiguredService(config);
    await restarted.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
