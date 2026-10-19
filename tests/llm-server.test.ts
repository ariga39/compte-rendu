import { request, createServer, type IncomingMessage } from 'node:http';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { startLlmServer } from '../apps/llm-service/src/http-server';

const controlCall = (socketPath: string, path: string, body: unknown) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (data: Buffer) => chunks.push(data));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });

const readIncoming = async (incoming: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
};

const probePort = async (dir: string) => {
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
  return port;
};

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

it('starts a normal service that forwards to the configured LiteLLM upstream', async () => {
  const { startConfiguredService } = await import('../apps/llm-service/src/bootstrap');
  const dir = await mkdtemp(join(tmpdir(), 'llm-upstream-wiring-'));
  const credentialFile = join(dir, 'litellm-key');
  const config = join(dir, 'service.toml');
  const port = await probePort(dir);
  let received:
    | { url: string; authorization: string | undefined; session: string | undefined; body: unknown }
    | undefined;
  const upstream = createServer(async (incoming, outgoing) => {
    const body = await readIncoming(incoming);
    received = {
      url: incoming.url ?? '',
      authorization:
        typeof incoming.headers.authorization === 'string'
          ? incoming.headers.authorization
          : undefined,
      session:
        typeof incoming.headers['x-opencode-session'] === 'string'
          ? incoming.headers['x-opencode-session']
          : undefined,
      body: JSON.parse(body) as unknown,
    };
    outgoing.writeHead(200, { 'content-type': 'text/event-stream' });
    outgoing.end(
      'data: {"choices":[{"index":0,"delta":{"content":"Ready"},"finish_reason":null}]}\n\n' +
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
        'data: [DONE]\n\n',
    );
  });
  await new Promise<void>((resolve, reject) => {
    upstream.once('error', reject);
    upstream.listen(0, '127.0.0.1', resolve);
  });
  const address = upstream.address();
  if (!address || typeof address === 'string') throw new Error('fake LiteLLM unavailable');
  try {
    await writeFile(credentialFile, 'backend-key\n', { mode: 0o600 });
    await writeFile(
      config,
      `controlSocket = "${dir}/control.sock"\nport = ${port}\n\n[upstream]\nbaseUrl = "http://127.0.0.1:${address.port}"\ncredentialFile = "${credentialFile}"\n\n[[routes]]\nid = "review"\nmodel = "deepseek-flash"\nprotocol = "chat-completions"\n`,
    );
    const server = await startConfiguredService(config);
    try {
      const granted = await controlCall(join(dir, 'control.sock'), '/grants', {
        jobId: 'job-wired',
        routes: ['review'],
      });
      expect(granted.status).toBe(201);
      const { token } = JSON.parse(granted.body) as { token: string };
      const response = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'x-opencode-session': 'client-spoof' },
        body: JSON.stringify({
          model: 'review',
          stream: true,
          messages: [{ role: 'user', content: 'Review this change' }],
          prompt_cache_key: 'client-cache-key',
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('Ready');
      expect(received?.url).toBe('/v1/chat/completions');
      expect(received?.authorization).toBe('Bearer backend-key');
      expect(received?.session).toBe('job-wired');
      expect(received?.body).toMatchObject({
        model: 'deepseek-flash',
        stream: true,
        store: false,
        prompt_cache_key: 'client-cache-key',
      });
    } finally {
      await server.close();
    }
  } finally {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

it('rejects obsolete provider routes and malformed upstream settings', async () => {
  const { startConfiguredService } = await import('../apps/llm-service/src/bootstrap');
  const dir = await mkdtemp(join(tmpdir(), 'llm-provider-'));
  const file = join(dir, 'service.toml');
  const key = join(dir, 'key');
  const port = await probePort(dir);
  const config = (options: { upstream?: string; route?: string }) =>
    `controlSocket = "${dir}/control.sock"\nport = ${port}\n\n${options.upstream ?? `[upstream]\nbaseUrl = "http://127.0.0.1:4000"\ncredentialFile = "${key}"\n`}\n${options.route ?? `[[routes]]\nid = "review"\nmodel = "example"\nprotocol = "chat-completions"\n`}`;
  try {
    await writeFile(key, 'private-test-key', { mode: 0o600 });
    for (const value of [
      config({
        route:
          '[[routes]]\nid = "review"\nmodel = "example"\nprotocol = "chat-completions"\nprovider = "openai-codex"\n',
      }),
      config({
        route: '[[routes]]\nid = "review"\nmodel = "example"\nprotocol = "codex-responses"\n',
      }),
      config({ route: '[[routes]]\nid = "review"\nmodel = "example"\n' }),
      config({ route: '[[routes]]\nid = "review"\nprotocol = "chat-completions"\n' }),
      config({
        upstream: `[upstream]\nbaseUrl = "http://127.0.0.1:4000/v1"\ncredentialFile = "${key}"\n`,
      }),
      config({
        upstream: `[upstream]\nbaseUrl = "http://litellm.example.com"\ncredentialFile = "${key}"\n`,
      }),
      config({
        upstream: `[upstream]\nbaseUrl = "https://user:pass@litellm.example.com"\ncredentialFile = "${key}"\n`,
      }),
      config({
        upstream: `[upstream]\nbaseUrl = "https://litellm.example.com/?target=evil"\ncredentialFile = "${key}"\n`,
      }),
      config({
        route:
          '[[routes]]\nid = "review"\nmodel = "example"\nprotocol = "chat-completions"\n\n[[routes]]\nid = "review"\nmodel = "other"\nprotocol = "responses"\n',
      }),
      `controlSocket = "${dir}/control.sock"\nport = ${port}\n[[routes]]\nid = "review"\nmodel = "example"\nprotocol = "chat-completions"\n`,
    ]) {
      await writeFile(file, value);
      await expect(startConfiguredService(file)).rejects.toThrow(
        'invalid LLM service configuration',
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('requires a private backend credential file', async () => {
  const { startConfiguredService } = await import('../apps/llm-service/src/bootstrap');
  const dir = await mkdtemp(join(tmpdir(), 'llm-key-'));
  const file = join(dir, 'service.toml');
  const key = join(dir, 'key');
  const port = await probePort(dir);
  const writeConfig = () =>
    writeFile(
      file,
      `controlSocket = "${dir}/control.sock"\nport = ${port}\n\n[upstream]\nbaseUrl = "http://127.0.0.1:4000"\ncredentialFile = "${key}"\n\n[[routes]]\nid = "review"\nmodel = "example"\nprotocol = "chat-completions"\n`,
    );
  try {
    await writeConfig();
    await expect(startConfiguredService(file)).rejects.toThrow('model credential unavailable');
    await writeFile(key, 'public-key', { mode: 0o644 });
    await expect(startConfiguredService(file)).rejects.toThrow('model credential must be private');
    await rm(key);
    await writeFile(key, '   \n', { mode: 0o600 });
    await expect(startConfiguredService(file)).rejects.toThrow('model credential unavailable');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
