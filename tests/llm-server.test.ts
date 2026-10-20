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

it('snapshots rewritten routes for new grants without restarting or changing old grants', async () => {
  const { startConfiguredService } = await import('../apps/llm-service/src/bootstrap');
  const dir = await mkdtemp(join(tmpdir(), 'llm-hot-routes-'));
  const credentialFile = join(dir, 'litellm-key');
  const config = join(dir, 'service.toml');
  const port = await probePort(dir);
  const received: Array<{ url: string; model: string }> = [];
  const upstream = createServer(async (incoming, outgoing) => {
    const body = JSON.parse(await readIncoming(incoming)) as { model: string };
    received.push({ url: incoming.url ?? '', model: body.model });
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
  const route = (id: string, model: string) =>
    `[[routes]]\nid = "${id}"\nmodel = "${model}"\nprotocol = "chat-completions"\n`;
  const writeConfig = (routes: string) =>
    writeFile(
      config,
      `controlSocket = "${dir}/control.sock"\nport = ${port}\n\n[upstream]\nbaseUrl = "http://127.0.0.1:${address.port}"\ncredentialFile = "${credentialFile}"\n\n${routes}`,
    );
  try {
    await writeFile(credentialFile, 'backend-key\n', { mode: 0o600 });
    await writeConfig(route('deepseek-review', 'deepseek-flash'));
    const server = await startConfiguredService(config);
    const infer = (token: string, model: string) =>
      fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ model, messages: [] }),
      });
    try {
      const oldGrant = await controlCall(join(dir, 'control.sock'), '/grants', {
        jobId: 'job-old-snapshot',
        routes: ['deepseek-review'],
      });
      expect(oldGrant.status).toBe(201);
      const oldToken = (JSON.parse(oldGrant.body) as { token: string }).token;
      const oldBefore = await infer(oldToken, 'deepseek-review');
      expect(oldBefore.status).toBe(200);
      await oldBefore.text();
      expect(received.at(-1)).toEqual({
        url: '/v1/chat/completions',
        model: 'deepseek-flash',
      });

      await writeConfig(
        route('deepseek-review', 'deepseek-flash') + route('step-review', 'step-5-preview'),
      );
      const newGrant = await controlCall(join(dir, 'control.sock'), '/grants', {
        jobId: 'job-new-snapshot',
        routes: ['step-review'],
      });
      expect(newGrant.status).toBe(201);
      const newToken = (JSON.parse(newGrant.body) as { token: string }).token;
      const newResponse = await infer(newToken, 'step-review');
      expect(newResponse.status).toBe(200);
      await newResponse.text();
      expect(received.at(-1)).toEqual({
        url: '/v1/chat/completions',
        model: 'step-5-preview',
      });
      expect((await infer(newToken, 'deepseek-review')).status).toBe(403);

      await writeConfig(route('step-review', 'step-5-preview'));
      const oldAfter = await infer(oldToken, 'deepseek-review');
      expect(oldAfter.status).toBe(200);
      await oldAfter.text();
      expect(received.at(-1)).toEqual({
        url: '/v1/chat/completions',
        model: 'deepseek-flash',
      });
      expect((await infer(oldToken, 'step-review')).status).toBe(403);

      await rm(credentialFile);
      const duringRotation = await controlCall(join(dir, 'control.sock'), '/grants', {
        jobId: 'job-during-key-rotation',
        routes: ['step-review'],
      });
      expect(duringRotation.status).toBe(201);
      const rotationToken = (JSON.parse(duringRotation.body) as { token: string }).token;
      expect((await infer(rotationToken, 'step-review')).status).toBe(502);
      await writeFile(credentialFile, 'replacement-backend-key\n', { mode: 0o600 });
      const afterRotation = await infer(rotationToken, 'step-review');
      expect(afterRotation.status).toBe(200);
      await afterRotation.text();
    } finally {
      await server.close();
    }
  } finally {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

it('rejects new grants while routes are invalid and recovers without restarting', async () => {
  const { startConfiguredService } = await import('../apps/llm-service/src/bootstrap');
  const dir = await mkdtemp(join(tmpdir(), 'llm-invalid-routes-'));
  const credentialFile = join(dir, 'litellm-key');
  const config = join(dir, 'service.toml');
  const port = await probePort(dir);
  const received: string[] = [];
  const upstream = createServer(async (incoming, outgoing) => {
    const body = JSON.parse(await readIncoming(incoming)) as { model: string };
    received.push(body.model);
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
  const route = (id: string, model: string) =>
    `[[routes]]\nid = "${id}"\nmodel = "${model}"\nprotocol = "chat-completions"\n`;
  const writeConfig = (routes: string) =>
    writeFile(
      config,
      `controlSocket = "${dir}/control.sock"\nport = ${port}\n\n[upstream]\nbaseUrl = "http://127.0.0.1:${address.port}"\ncredentialFile = "${credentialFile}"\n\n${routes}`,
    );
  try {
    await writeFile(credentialFile, 'backend-key\n', { mode: 0o600 });
    await writeConfig(route('deepseek-review', 'deepseek-flash'));
    const server = await startConfiguredService(config);
    const infer = (token: string, model: string) =>
      fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ model, messages: [] }),
      });
    try {
      const oldGrant = await controlCall(join(dir, 'control.sock'), '/grants', {
        jobId: 'job-before-invalid',
        routes: ['deepseek-review'],
      });
      expect(oldGrant.status).toBe(201);
      const oldToken = (JSON.parse(oldGrant.body) as { token: string }).token;

      await writeFile(config, 'routes = [\n');
      const rejected = await controlCall(join(dir, 'control.sock'), '/grants', {
        jobId: 'job-invalid',
        routes: ['deepseek-review'],
      });
      expect(rejected.status).toBe(503);
      expect(JSON.parse(rejected.body)).toEqual({
        error: { message: 'service unavailable' },
      });

      const oldAfterInvalid = await infer(oldToken, 'deepseek-review');
      expect(oldAfterInvalid.status).toBe(200);
      await oldAfterInvalid.text();
      expect(received).toEqual(['deepseek-flash']);

      await writeConfig(
        route('deepseek-review', 'deepseek-flash') + route('step-review', 'step-5-preview'),
      );
      const recovered = await controlCall(join(dir, 'control.sock'), '/grants', {
        jobId: 'job-recovered',
        routes: ['step-review'],
      });
      expect(recovered.status).toBe(201);
      const recoveredToken = (JSON.parse(recovered.body) as { token: string }).token;
      const recoveredResponse = await infer(recoveredToken, 'step-review');
      expect(recoveredResponse.status).toBe(200);
      await recoveredResponse.text();
      expect(received).toEqual(['deepseek-flash', 'step-5-preview']);

      await writeFile(
        config,
        `controlSocket = "${dir}/control.sock"\nport = ${port}\n\n[upstream]\nbaseUrl = "http://127.0.0.1:1"\ncredentialFile = "${credentialFile}"\n\n${route('step-review', 'step-5-preview')}`,
      );
      const changedBackend = await controlCall(join(dir, 'control.sock'), '/grants', {
        jobId: 'job-changed-backend',
        routes: ['step-review'],
      });
      expect(changedBackend.status).toBe(503);
      const recoveredStill = await infer(recoveredToken, 'step-review');
      expect(recoveredStill.status).toBe(200);
      await recoveredStill.text();
      expect(received).toEqual(['deepseek-flash', 'step-5-preview', 'step-5-preview']);
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

it('requires a loopback LiteLLM backend for both HTTP and HTTPS', async () => {
  const { readLlmConfig } = await import('../apps/llm-service/src/bootstrap');
  const dir = await mkdtemp(join(tmpdir(), 'llm-loopback-'));
  const file = join(dir, 'service.toml');
  const key = join(dir, 'key');
  const port = await probePort(dir);
  const config = (baseUrl: string) =>
    `controlSocket = "${dir}/control.sock"\nport = ${port}\n\n[upstream]\nbaseUrl = "${baseUrl}"\ncredentialFile = "${key}"\n\n[[routes]]\nid = "review"\nmodel = "example"\nprotocol = "chat-completions"\n`;
  try {
    await writeFile(key, 'private-test-key', { mode: 0o600 });
    for (const baseUrl of [
      'https://litellm.example.com',
      'http://litellm.example.com',
      'https://litellm.example.com:4000',
    ]) {
      await writeFile(file, config(baseUrl));
      await expect(readLlmConfig(file)).rejects.toThrow('invalid LLM service configuration');
    }
    for (const baseUrl of [
      'http://127.0.0.1:4000',
      'https://127.0.0.1:4000',
      'http://localhost:4000',
      'https://localhost:4000',
    ]) {
      await writeFile(file, config(baseUrl));
      await expect(readLlmConfig(file)).resolves.toBeDefined();
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
