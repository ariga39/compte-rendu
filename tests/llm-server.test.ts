import { request, createServer, type IncomingMessage } from 'node:http';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
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

const controlGet = (socketPath: string, path: string) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ socketPath, path, method: 'GET' }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (data: Buffer) => chunks.push(data));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
      );
    });
    req.on('error', reject);
    req.end();
  });

const eventually = async (check: () => Promise<boolean>, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition not met before timeout');
};

const installCatalogTransport = (catalogUrl: string, fixtureUrl: string) => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; headers: Headers; redirect: RequestRedirect | undefined }> =
    [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const target =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (target !== catalogUrl) return originalFetch(input, init);
    requests.push({
      url: target,
      headers: new Headers(init?.headers),
      redirect: init?.redirect,
    });
    return originalFetch(fixtureUrl, init);
  });
  return { requests, restore: () => spy.mockRestore() };
};

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

it('discovers backend models at startup and grants them without per-model routes', async () => {
  const { startConfiguredService } = await import('../apps/llm-service/src/bootstrap');
  const dir = await mkdtemp(join(tmpdir(), 'llm-discovery-startup-'));
  const credentialFile = join(dir, 'litellm-key');
  const config = join(dir, 'service.toml');
  const port = await probePort(dir);
  const received: Array<{
    url: string;
    authorization: string | undefined;
    model: string | undefined;
  }> = [];
  const upstream = createServer(async (incoming, outgoing) => {
    const body = incoming.url === '/v1/models' ? undefined : await readIncoming(incoming);
    received.push({
      url: incoming.url ?? '',
      authorization:
        typeof incoming.headers.authorization === 'string'
          ? incoming.headers.authorization
          : undefined,
      model: body === undefined ? undefined : (JSON.parse(body) as { model: string }).model,
    });
    if (incoming.url === '/v1/models') {
      outgoing.writeHead(200, { 'content-type': 'application/json' });
      outgoing.end(JSON.stringify({ data: [{ id: 'mimo-v2.6-flash' }] }));
      return;
    }
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
      `controlSocket = "${dir}/control.sock"\nport = ${port}\nroutes = []\n\n[upstream]\nbaseUrl = "http://127.0.0.1:${address.port}"\ncredentialFile = "${credentialFile}"\n\n[discovery]\nrefreshIntervalMs = 60000\n`,
    );
    const server = await startConfiguredService(config);
    try {
      expect(received).toEqual([
        { url: '/v1/models', authorization: 'Bearer backend-key', model: undefined },
      ]);
      const granted = await controlCall(join(dir, 'control.sock'), '/grants', {
        jobId: 'job-discovered',
        routes: ['mimo-v2.6-flash'],
      });
      expect(granted.status).toBe(201);
      const { token } = JSON.parse(granted.body) as { token: string };
      const response = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ model: 'mimo-v2.6-flash', messages: [] }),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('Ready');
      expect(received.at(-1)).toEqual({
        url: '/v1/chat/completions',
        authorization: 'Bearer backend-key',
        model: 'mimo-v2.6-flash',
      });
    } finally {
      await server.close();
    }
  } finally {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

it('refreshes discovered routes and exposes control metadata without restarting', async () => {
  const { startConfiguredService } = await import('../apps/llm-service/src/bootstrap');
  const dir = await mkdtemp(join(tmpdir(), 'llm-discovery-refresh-'));
  const credentialFile = join(dir, 'litellm-key');
  const config = join(dir, 'service.toml');
  const port = await probePort(dir);
  let models = ['model-a'];
  const received: string[] = [];
  const upstream = createServer(async (incoming, outgoing) => {
    if (incoming.url === '/v1/models') {
      outgoing.writeHead(200, { 'content-type': 'application/json' });
      outgoing.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
      return;
    }
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
  try {
    await writeFile(credentialFile, 'backend-key\n', { mode: 0o600 });
    await writeFile(
      config,
      `controlSocket = "${dir}/control.sock"\nport = ${port}\nroutes = []\n\n[upstream]\nbaseUrl = "http://127.0.0.1:${address.port}"\ncredentialFile = "${credentialFile}"\n\n[discovery]\nrefreshIntervalMs = 25\n`,
    );
    const server = await startConfiguredService(config);
    const infer = (token: string, model: string) =>
      fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ model, messages: [] }),
      });
    try {
      const initial = await controlGet(join(dir, 'control.sock'), '/models');
      expect(initial.status).toBe(200);
      expect(JSON.parse(initial.body)).toEqual({
        ids: ['model-a'],
        lastAttemptAt: expect.any(String),
        lastSuccessAt: expect.any(String),
        lastRefreshError: null,
      });
      const oldGrant = await controlCall(join(dir, 'control.sock'), '/grants', {
        jobId: 'job-refresh-old',
        routes: ['model-a'],
      });
      expect(oldGrant.status).toBe(201);
      const oldToken = (JSON.parse(oldGrant.body) as { token: string }).token;

      models = ['model-a', 'model-b'];
      await eventually(async () => {
        const current = await controlGet(join(dir, 'control.sock'), '/models');
        return (JSON.parse(current.body) as { ids: string[] }).ids.includes('model-b');
      });

      const newGrant = await controlCall(join(dir, 'control.sock'), '/grants', {
        jobId: 'job-refresh-new',
        routes: ['model-b'],
      });
      expect(newGrant.status).toBe(201);
      const newToken = (JSON.parse(newGrant.body) as { token: string }).token;
      const newResponse = await infer(newToken, 'model-b');
      expect(newResponse.status).toBe(200);
      await newResponse.text();
      expect(received).toEqual(['model-b']);
      expect((await infer(oldToken, 'model-b')).status).toBe(403);
      expect(
        (
          await controlCall(join(dir, 'control.sock'), '/grants', {
            jobId: 'job-refresh-unknown',
            routes: ['model-unseen'],
          })
        ).status,
      ).toBe(400);
      const current = await controlGet(join(dir, 'control.sock'), '/models');
      expect(JSON.parse(current.body)).toEqual({
        ids: ['model-a', 'model-b'],
        lastAttemptAt: expect.any(String),
        lastSuccessAt: expect.any(String),
        lastRefreshError: null,
      });
    } finally {
      await server.close();
    }
  } finally {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

it('retains known discovered routes on partial or failed refreshes', async () => {
  const { startConfiguredService } = await import('../apps/llm-service/src/bootstrap');
  const dir = await mkdtemp(join(tmpdir(), 'llm-discovery-retain-'));
  const credentialFile = join(dir, 'litellm-key');
  const config = join(dir, 'service.toml');
  const port = await probePort(dir);
  let models = ['model-a'];
  let mode: 'ok' | 'error' = 'ok';
  const received: string[] = [];
  const upstream = createServer(async (incoming, outgoing) => {
    if (incoming.url === '/v1/models') {
      if (mode === 'error') {
        outgoing.writeHead(500).end();
        return;
      }
      outgoing.writeHead(200, { 'content-type': 'application/json' });
      outgoing.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
      return;
    }
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
  try {
    await writeFile(credentialFile, 'backend-key\n', { mode: 0o600 });
    await writeFile(
      config,
      `controlSocket = "${dir}/control.sock"\nport = ${port}\nroutes = []\n\n[upstream]\nbaseUrl = "http://127.0.0.1:${address.port}"\ncredentialFile = "${credentialFile}"\n\n[discovery]\nrefreshIntervalMs = 20\n`,
    );
    const server = await startConfiguredService(config);
    const infer = (token: string, model: string) =>
      fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ model, messages: [] }),
      });
    try {
      const grant = await controlCall(join(dir, 'control.sock'), '/grants', {
        jobId: 'job-retain-a',
        routes: ['model-a'],
      });
      expect(grant.status).toBe(201);
      const token = (JSON.parse(grant.body) as { token: string }).token;

      mode = 'error';
      await eventually(async () => {
        const current = JSON.parse(
          (await controlGet(join(dir, 'control.sock'), '/models')).body,
        ) as { ids: string[]; lastRefreshError: string | null };
        return current.lastRefreshError === 'refresh failed';
      });
      const afterError = JSON.parse(
        (await controlGet(join(dir, 'control.sock'), '/models')).body,
      ) as { ids: string[]; lastRefreshError: string | null };
      expect(afterError.ids).toEqual(['model-a']);
      expect((await infer(token, 'model-a')).status).toBe(200);

      models = ['model-b'];
      mode = 'ok';
      await eventually(async () => {
        const current = JSON.parse(
          (await controlGet(join(dir, 'control.sock'), '/models')).body,
        ) as { ids: string[] };
        return current.ids.includes('model-b');
      });
      const afterPartial = JSON.parse(
        (await controlGet(join(dir, 'control.sock'), '/models')).body,
      ) as { ids: string[]; lastRefreshError: string | null };
      expect(afterPartial.ids).toEqual(['model-a', 'model-b']);
      expect(afterPartial.lastRefreshError).toBeNull();
      expect((await infer(token, 'model-a')).status).toBe(200);
      const newGrant = await controlCall(join(dir, 'control.sock'), '/grants', {
        jobId: 'job-retain-b',
        routes: ['model-b'],
      });
      expect(newGrant.status).toBe(201);
      const newToken = (JSON.parse(newGrant.body) as { token: string }).token;
      const newResponse = await infer(newToken, 'model-b');
      expect(newResponse.status).toBe(200);
      await newResponse.text();
      expect(received).toEqual(['model-a', 'model-a', 'model-b']);
    } finally {
      await server.close();
    }
  } finally {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

it('loads public HTTPS catalogs at the exact configured path without backend auth', async () => {
  const { startConfiguredService } = await import('../apps/llm-service/src/bootstrap');
  const dir = await mkdtemp(join(tmpdir(), 'llm-discovery-public-'));
  const credentialFile = join(dir, 'litellm-key');
  const config = join(dir, 'service.toml');
  const port = await probePort(dir);
  const publicUrl = 'https://public.example/zen/go/v1/models';
  const publicRequests: Array<{ url: string; authorization: string | undefined }> = [];
  const publicCatalog = createServer((incoming, outgoing) => {
    publicRequests.push({
      url: incoming.url ?? '',
      authorization:
        typeof incoming.headers.authorization === 'string'
          ? incoming.headers.authorization
          : undefined,
    });
    outgoing.writeHead(200, { 'content-type': 'application/json' });
    outgoing.end(JSON.stringify({ data: [{ id: 'mimo-v2.6-flash' }] }));
  });
  await new Promise<void>((resolve, reject) => {
    publicCatalog.once('error', reject);
    publicCatalog.listen(0, '127.0.0.1', resolve);
  });
  const publicAddress = publicCatalog.address();
  if (!publicAddress || typeof publicAddress === 'string')
    throw new Error('fake public catalog unavailable');
  const transport = installCatalogTransport(
    publicUrl,
    `http://127.0.0.1:${publicAddress.port}/zen/go/v1/models`,
  );
  const received: Array<{ authorization: string | undefined; model: string }> = [];
  const upstream = createServer(async (incoming, outgoing) => {
    if (incoming.url === '/v1/models') {
      outgoing.writeHead(200, { 'content-type': 'application/json' });
      outgoing.end(JSON.stringify({ data: [{ id: 'backend-model' }] }));
      return;
    }
    const body = JSON.parse(await readIncoming(incoming)) as { model: string };
    received.push({
      authorization:
        typeof incoming.headers.authorization === 'string'
          ? incoming.headers.authorization
          : undefined,
      model: body.model,
    });
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
      `controlSocket = "${dir}/control.sock"\nport = ${port}\nroutes = []\n\n[upstream]\nbaseUrl = "http://127.0.0.1:${address.port}"\ncredentialFile = "${credentialFile}"\n\n[discovery]\nrefreshIntervalMs = 60000\n\n[[discovery.publicCatalogs]]\nurl = "${publicUrl}"\nprefix = "opencode/"\n`,
    );
    const server = await startConfiguredService(config);
    try {
      expect(transport.requests).toHaveLength(1);
      expect(transport.requests[0]?.url).toBe(publicUrl);
      expect(transport.requests[0]?.headers.get('authorization')).toBeNull();
      expect(transport.requests[0]?.headers.get('user-agent')).toMatch(/^litellm\//);
      expect(transport.requests[0]?.redirect).toBe('error');
      expect(publicRequests).toEqual([{ url: '/zen/go/v1/models', authorization: undefined }]);
      const catalog = JSON.parse((await controlGet(join(dir, 'control.sock'), '/models')).body) as {
        ids: string[];
      };
      expect(catalog.ids).toEqual(['backend-model', 'opencode/mimo-v2.6-flash']);
      const grant = await controlCall(join(dir, 'control.sock'), '/grants', {
        jobId: 'job-public-catalog',
        routes: ['opencode/mimo-v2.6-flash'],
      });
      expect(grant.status).toBe(201);
      const { token } = JSON.parse(grant.body) as { token: string };
      const response = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ model: 'opencode/mimo-v2.6-flash', messages: [] }),
      });
      expect(response.status).toBe(200);
      await response.text();
      expect(received).toEqual([
        { authorization: 'Bearer backend-key', model: 'opencode/mimo-v2.6-flash' },
      ]);
      expect(transport.requests).toHaveLength(1);
    } finally {
      await server.close();
    }
  } finally {
    transport.restore();
    await new Promise<void>((resolve) => {
      publicCatalog.closeAllConnections();
      publicCatalog.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      upstream.closeAllConnections();
      upstream.close(() => resolve());
    });
    await rm(dir, { recursive: true, force: true });
  }
});

it('stops discovery refreshes on close without waiting for a slow catalog', async () => {
  const { startConfiguredService } = await import('../apps/llm-service/src/bootstrap');
  const dir = await mkdtemp(join(tmpdir(), 'llm-discovery-shutdown-'));
  const credentialFile = join(dir, 'litellm-key');
  const config = join(dir, 'service.toml');
  const port = await probePort(dir);
  let catalogRequests = 0;
  let delayCatalog = 0;
  const upstream = createServer(async (incoming, outgoing) => {
    if (incoming.url === '/v1/models') {
      catalogRequests += 1;
      if (delayCatalog > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayCatalog));
      }
      outgoing.writeHead(200, { 'content-type': 'application/json' });
      outgoing.end(JSON.stringify({ data: [{ id: 'model-a' }] }));
      return;
    }
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
      `controlSocket = "${dir}/control.sock"\nport = ${port}\nroutes = []\n\n[upstream]\nbaseUrl = "http://127.0.0.1:${address.port}"\ncredentialFile = "${credentialFile}"\n\n[discovery]\nrefreshIntervalMs = 20\n`,
    );
    const server = await startConfiguredService(config);
    delayCatalog = 500;
    await eventually(async () => catalogRequests >= 2);
    const started = Date.now();
    await server.close();
    expect(Date.now() - started).toBeLessThan(400);
    const stoppedAt = catalogRequests;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(catalogRequests).toBe(stoppedAt);
  } finally {
    await new Promise<void>((resolve) => {
      upstream.closeAllConnections();
      upstream.close(() => resolve());
    });
    await rm(dir, { recursive: true, force: true });
  }
});

it('closes discovery when the inference listener cannot start', async () => {
  const { startConfiguredService } = await import('../apps/llm-service/src/bootstrap');
  const dir = await mkdtemp(join(tmpdir(), 'llm-discovery-listener-'));
  const credentialFile = join(dir, 'litellm-key');
  const config = join(dir, 'service.toml');
  let catalogRequests = 0;
  const upstream = createServer(async (incoming, outgoing) => {
    if (incoming.url === '/v1/models') {
      catalogRequests += 1;
      outgoing.writeHead(200, { 'content-type': 'application/json' });
      outgoing.end(JSON.stringify({ data: [{ id: 'model-a' }] }));
      return;
    }
    outgoing.writeHead(200, { 'content-type': 'text/event-stream' });
    outgoing.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve, reject) => {
    upstream.once('error', reject);
    upstream.listen(0, '127.0.0.1', resolve);
  });
  const address = upstream.address();
  if (!address || typeof address === 'string') throw new Error('fake LiteLLM unavailable');
  const occupied = await startLlmServer({
    controlSocket: join(dir, 'occupied.sock'),
    port: 0,
    service: {
      control: async () => new Response(),
      inference: async () => new Response(),
      close: () => {},
    },
  });
  try {
    await writeFile(credentialFile, 'backend-key\n', { mode: 0o600 });
    await writeFile(
      config,
      `controlSocket = "${dir}/control.sock"\nport = ${occupied.port}\nroutes = []\n\n[upstream]\nbaseUrl = "http://127.0.0.1:${address.port}"\ncredentialFile = "${credentialFile}"\n\n[discovery]\nrefreshIntervalMs = 20\n`,
    );
    await expect(startConfiguredService(config)).rejects.toThrow();
    const stoppedAt = catalogRequests;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(catalogRequests).toBe(stoppedAt);
  } finally {
    await occupied.close();
    await new Promise<void>((resolve) => {
      upstream.closeAllConnections();
      upstream.close(() => resolve());
    });
    await rm(dir, { recursive: true, force: true });
  }
});

it('keeps lastSuccessAt from advancing when one source fails and recovers additively', async () => {
  const { startConfiguredService } = await import('../apps/llm-service/src/bootstrap');
  const dir = await mkdtemp(join(tmpdir(), 'llm-discovery-partial-'));
  const credentialFile = join(dir, 'litellm-key');
  const config = join(dir, 'service.toml');
  const port = await probePort(dir);
  const publicUrl = 'https://public.example/zen/go/v1/models';
  let publicMode: 'error' | 'ok' = 'error';
  const publicCatalog = createServer((_incoming, outgoing) => {
    if (publicMode === 'error') {
      outgoing.writeHead(500).end();
      return;
    }
    outgoing.writeHead(200, { 'content-type': 'application/json' });
    outgoing.end(JSON.stringify({ data: [{ id: 'mimo-v2.6-flash' }] }));
  });
  await new Promise<void>((resolve, reject) => {
    publicCatalog.once('error', reject);
    publicCatalog.listen(0, '127.0.0.1', resolve);
  });
  const publicAddress = publicCatalog.address();
  if (!publicAddress || typeof publicAddress === 'string')
    throw new Error('fake public catalog unavailable');
  const transport = installCatalogTransport(
    publicUrl,
    `http://127.0.0.1:${publicAddress.port}/zen/go/v1/models`,
  );
  const upstream = createServer(async (incoming, outgoing) => {
    if (incoming.url === '/v1/models') {
      outgoing.writeHead(200, { 'content-type': 'application/json' });
      outgoing.end(JSON.stringify({ data: [{ id: 'backend-model' }] }));
      return;
    }
    outgoing.writeHead(200, { 'content-type': 'text/event-stream' });
    outgoing.end('data: [DONE]\n\n');
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
      `controlSocket = "${dir}/control.sock"\nport = ${port}\nroutes = []\n\n[upstream]\nbaseUrl = "http://127.0.0.1:${address.port}"\ncredentialFile = "${credentialFile}"\n\n[discovery]\nrefreshIntervalMs = 20\n\n[[discovery.publicCatalogs]]\nurl = "${publicUrl}"\nprefix = "opencode/"\n`,
    );
    const server = await startConfiguredService(config);
    try {
      const partial = JSON.parse((await controlGet(join(dir, 'control.sock'), '/models')).body) as {
        ids: string[];
        lastAttemptAt: string | null;
        lastSuccessAt: string | null;
        lastRefreshError: string | null;
      };
      expect(partial).toEqual({
        ids: ['backend-model'],
        lastAttemptAt: expect.any(String),
        lastSuccessAt: null,
        lastRefreshError: 'refresh failed',
      });

      publicMode = 'ok';
      await eventually(async () => {
        const current = JSON.parse(
          (await controlGet(join(dir, 'control.sock'), '/models')).body,
        ) as { lastRefreshError: string | null };
        return current.lastRefreshError === null;
      });
      const recovered = JSON.parse(
        (await controlGet(join(dir, 'control.sock'), '/models')).body,
      ) as { ids: string[]; lastSuccessAt: string | null };
      expect(recovered.ids).toEqual(['backend-model', 'opencode/mimo-v2.6-flash']);
      expect(recovered.lastSuccessAt).toEqual(expect.any(String));
    } finally {
      await server.close();
    }
  } finally {
    transport.restore();
    await new Promise<void>((resolve) => {
      publicCatalog.closeAllConnections();
      publicCatalog.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      upstream.closeAllConnections();
      upstream.close(() => resolve());
    });
    await rm(dir, { recursive: true, force: true });
  }
});

it('starts with explicit aliases when initial discovery fails and retries in background', async () => {
  const { startConfiguredService } = await import('../apps/llm-service/src/bootstrap');
  const dir = await mkdtemp(join(tmpdir(), 'llm-discovery-startup-failure-'));
  const credentialFile = join(dir, 'litellm-key');
  const config = join(dir, 'service.toml');
  const port = await probePort(dir);
  let catalogMode: 'error' | 'ok' = 'error';
  let models = ['model-new'];
  const received: string[] = [];
  const upstream = createServer(async (incoming, outgoing) => {
    if (incoming.url === '/v1/models') {
      if (catalogMode === 'error') {
        outgoing.writeHead(500).end();
        return;
      }
      outgoing.writeHead(200, { 'content-type': 'application/json' });
      outgoing.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
      return;
    }
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
  try {
    await writeFile(credentialFile, 'backend-key\n', { mode: 0o600 });
    await writeFile(
      config,
      `controlSocket = "${dir}/control.sock"\nport = ${port}\n\n[upstream]\nbaseUrl = "http://127.0.0.1:${address.port}"\ncredentialFile = "${credentialFile}"\n\n[[routes]]\nid = "legacy-review"\nmodel = "legacy-model"\nprotocol = "chat-completions"\n\n[discovery]\nrefreshIntervalMs = 20\n`,
    );
    const server = await startConfiguredService(config);
    const infer = (token: string, model: string) =>
      fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ model, messages: [] }),
      });
    try {
      const initial = JSON.parse((await controlGet(join(dir, 'control.sock'), '/models')).body) as {
        ids: string[];
        lastSuccessAt: string | null;
        lastRefreshError: string | null;
      };
      expect(initial.ids).toEqual(['legacy-review']);
      expect(initial.lastSuccessAt).toBeNull();
      expect(initial.lastRefreshError).toBe('refresh failed');
      const legacyGrant = await controlCall(join(dir, 'control.sock'), '/grants', {
        jobId: 'job-legacy-discovery-failed',
        routes: ['legacy-review'],
      });
      expect(legacyGrant.status).toBe(201);
      const legacyToken = (JSON.parse(legacyGrant.body) as { token: string }).token;
      const legacyResponse = await infer(legacyToken, 'legacy-review');
      expect(legacyResponse.status).toBe(200);
      await legacyResponse.text();
      expect(received).toEqual(['legacy-model']);
      expect(
        (
          await controlCall(join(dir, 'control.sock'), '/grants', {
            jobId: 'job-unseen-before-retry',
            routes: ['model-new'],
          })
        ).status,
      ).toBe(400);

      catalogMode = 'ok';
      await eventually(async () => {
        const current = JSON.parse(
          (await controlGet(join(dir, 'control.sock'), '/models')).body,
        ) as { ids: string[] };
        return current.ids.includes('model-new');
      });
      const newGrant = await controlCall(join(dir, 'control.sock'), '/grants', {
        jobId: 'job-new-after-retry',
        routes: ['model-new'],
      });
      expect(newGrant.status).toBe(201);
      const newToken = (JSON.parse(newGrant.body) as { token: string }).token;
      const newResponse = await infer(newToken, 'model-new');
      expect(newResponse.status).toBe(200);
      await newResponse.text();
      expect(received).toEqual(['legacy-model', 'model-new']);
    } finally {
      await server.close();
    }
  } finally {
    await new Promise<void>((resolve) => {
      upstream.closeAllConnections();
      upstream.close(() => resolve());
    });
    await rm(dir, { recursive: true, force: true });
  }
});

it('uses current explicit aliases on the control catalog and prefers them over discovery', async () => {
  const { startConfiguredService } = await import('../apps/llm-service/src/bootstrap');
  const dir = await mkdtemp(join(tmpdir(), 'llm-discovery-explicit-'));
  const credentialFile = join(dir, 'litellm-key');
  const config = join(dir, 'service.toml');
  const port = await probePort(dir);
  const received: string[] = [];
  const upstream = createServer(async (incoming, outgoing) => {
    if (incoming.url === '/v1/models') {
      outgoing.writeHead(200, { 'content-type': 'application/json' });
      outgoing.end(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }] }));
      return;
    }
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
  const writeConfig = (routes: string) =>
    writeFile(
      config,
      `controlSocket = "${dir}/control.sock"\nport = ${port}\n\n${routes}\n[upstream]\nbaseUrl = "http://127.0.0.1:${address.port}"\ncredentialFile = "${credentialFile}"\n\n[discovery]\nrefreshIntervalMs = 60000\n`,
    );
  try {
    await writeFile(credentialFile, 'backend-key\n', { mode: 0o600 });
    await writeConfig('routes = []\n');
    const server = await startConfiguredService(config);
    const infer = (token: string, model: string) =>
      fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ model, messages: [] }),
      });
    try {
      expect(
        (
          JSON.parse((await controlGet(join(dir, 'control.sock'), '/models')).body) as {
            ids: string[];
          }
        ).ids,
      ).toEqual(['model-a', 'model-b']);

      await writeFile(config, 'routes = [\n');
      const invalid = await controlGet(join(dir, 'control.sock'), '/models');
      expect(invalid.status).toBe(503);
      expect(JSON.parse(invalid.body)).toEqual({
        error: { message: 'service unavailable' },
      });
      await writeConfig('routes = []\n');

      await writeConfig(
        '[[routes]]\nid = "legacy-review"\nmodel = "legacy-model"\nprotocol = "chat-completions"\n',
      );
      expect(
        (
          JSON.parse((await controlGet(join(dir, 'control.sock'), '/models')).body) as {
            ids: string[];
          }
        ).ids,
      ).toEqual(['legacy-review', 'model-a', 'model-b']);

      await writeConfig(
        '[[routes]]\nid = "model-a"\nmodel = "legacy-model"\nprotocol = "chat-completions"\n',
      );
      const grant = await controlCall(join(dir, 'control.sock'), '/grants', {
        jobId: 'job-explicit-wins',
        routes: ['model-a'],
      });
      expect(grant.status).toBe(201);
      const { token } = JSON.parse(grant.body) as { token: string };
      const response = await infer(token, 'model-a');
      expect(response.status).toBe(200);
      await response.text();
      expect(received).toEqual(['legacy-model']);

      await writeConfig('routes = []\n');
      expect(
        (
          JSON.parse((await controlGet(join(dir, 'control.sock'), '/models')).body) as {
            ids: string[];
          }
        ).ids,
      ).toEqual(['model-a', 'model-b']);
      expect((await infer(token, 'model-a')).status).toBe(200);
    } finally {
      await server.close();
    }
  } finally {
    await new Promise<void>((resolve) => {
      upstream.closeAllConnections();
      upstream.close(() => resolve());
    });
    await rm(dir, { recursive: true, force: true });
  }
});

it('skips invalid catalog entries while retaining valid sibling models', async () => {
  const { startConfiguredService } = await import('../apps/llm-service/src/bootstrap');
  const dir = await mkdtemp(join(tmpdir(), 'llm-discovery-invalid-entries-'));
  const credentialFile = join(dir, 'litellm-key');
  const config = join(dir, 'service.toml');
  const port = await probePort(dir);
  const publicUrl = 'https://public.example/zen/go/v1/models';
  const overlongId = 'a'.repeat(120);
  let releaseRefresh = () => {};
  const refreshGate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  let initialCatalog = true;
  let publicBody: unknown = {
    data: [
      { id: 'valid-a' },
      { id: 'valid-b' },
      { id: 'bad id' },
      {},
      { id: 42 },
      { id: overlongId },
    ],
  };
  const publicCatalog = createServer(async (_incoming, outgoing) => {
    if (!initialCatalog) await refreshGate;
    initialCatalog = false;
    outgoing.writeHead(200, { 'content-type': 'application/json' });
    outgoing.end(JSON.stringify(publicBody));
  });
  await new Promise<void>((resolve, reject) => {
    publicCatalog.once('error', reject);
    publicCatalog.listen(0, '127.0.0.1', resolve);
  });
  const publicAddress = publicCatalog.address();
  if (!publicAddress || typeof publicAddress === 'string')
    throw new Error('fake public catalog unavailable');
  const transport = installCatalogTransport(
    publicUrl,
    `http://127.0.0.1:${publicAddress.port}/zen/go/v1/models`,
  );
  const received: Array<{ authorization: string | undefined; model: string }> = [];
  const upstream = createServer(async (incoming, outgoing) => {
    if (incoming.url === '/v1/models') {
      outgoing.writeHead(200, { 'content-type': 'application/json' });
      outgoing.end(JSON.stringify({ data: [{ id: 'backend-ok' }] }));
      return;
    }
    const body = JSON.parse(await readIncoming(incoming)) as { model: string };
    received.push({
      authorization:
        typeof incoming.headers.authorization === 'string'
          ? incoming.headers.authorization
          : undefined,
      model: body.model,
    });
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
      `controlSocket = "${dir}/control.sock"\nport = ${port}\nroutes = []\n\n[upstream]\nbaseUrl = "http://127.0.0.1:${address.port}"\ncredentialFile = "${credentialFile}"\n\n[discovery]\nrefreshIntervalMs = 25\n\n[[discovery.publicCatalogs]]\nurl = "${publicUrl}"\nprefix = "opencode/"\n`,
    );
    const server = await startConfiguredService(config);
    const catalog = async () =>
      JSON.parse((await controlGet(join(dir, 'control.sock'), '/models')).body) as {
        ids: string[];
        lastRefreshError: string | null;
        lastSuccessAt: string | null;
      };
    try {
      const initial = await catalog();
      expect(initial.ids).toEqual(['backend-ok', 'opencode/valid-a', 'opencode/valid-b']);
      expect(initial.lastRefreshError).toBeNull();
      expect(initial.lastSuccessAt).toEqual(expect.any(String));

      const grant = await controlCall(join(dir, 'control.sock'), '/grants', {
        jobId: 'job-invalid-entry-valid',
        routes: ['opencode/valid-a'],
      });
      expect(grant.status).toBe(201);
      const { token } = JSON.parse(grant.body) as { token: string };
      const infer = (model: string) =>
        fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({ model, messages: [] }),
        });
      const response = await infer('opencode/valid-a');
      expect(response.status).toBe(200);
      await response.text();
      expect(received).toEqual([
        { authorization: 'Bearer backend-key', model: 'opencode/valid-a' },
      ]);

      for (const skipped of ['opencode/bad id', `opencode/${overlongId}`]) {
        expect(
          (
            await controlCall(join(dir, 'control.sock'), '/grants', {
              jobId: `job-invalid-entry-${skipped.length}`,
              routes: [skipped],
            })
          ).status,
        ).toBe(400);
        expect((await infer(skipped)).status).toBe(403);
      }

      publicBody = { data: 'not-an-array' };
      releaseRefresh();
      await eventually(async () => (await catalog()).lastRefreshError === 'refresh failed');
      const retained = await catalog();
      expect(retained.ids).toEqual(['backend-ok', 'opencode/valid-a', 'opencode/valid-b']);
      expect(retained.lastSuccessAt).toEqual(initial.lastSuccessAt);
      const afterMalformed = await infer('opencode/valid-a');
      expect(afterMalformed.status).toBe(200);
      await afterMalformed.text();
    } finally {
      releaseRefresh();
      await server.close();
    }
  } finally {
    transport.restore();
    await new Promise<void>((resolve) => {
      publicCatalog.closeAllConnections();
      publicCatalog.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      upstream.closeAllConnections();
      upstream.close(() => resolve());
    });
    await rm(dir, { recursive: true, force: true });
  }
});

it('bounds the retained catalog across refreshes', async () => {
  const { startConfiguredService } = await import('../apps/llm-service/src/bootstrap');
  const dir = await mkdtemp(join(tmpdir(), 'llm-discovery-cap-'));
  const credentialFile = join(dir, 'litellm-key');
  const config = join(dir, 'service.toml');
  const port = await probePort(dir);
  const firstBatch = Array.from({ length: 600 }, (_value, index) => `model-a-${index}`);
  const secondBatch = Array.from({ length: 600 }, (_value, index) => `model-b-${index}`);
  let models = firstBatch;
  const upstream = createServer(async (incoming, outgoing) => {
    if (incoming.url === '/v1/models') {
      outgoing.writeHead(200, { 'content-type': 'application/json' });
      outgoing.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
      return;
    }
    outgoing.writeHead(200, { 'content-type': 'text/event-stream' });
    outgoing.end('data: [DONE]\n\n');
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
      `controlSocket = "${dir}/control.sock"\nport = ${port}\nroutes = []\n\n[upstream]\nbaseUrl = "http://127.0.0.1:${address.port}"\ncredentialFile = "${credentialFile}"\n\n[discovery]\nrefreshIntervalMs = 20\n`,
    );
    const server = await startConfiguredService(config);
    try {
      models = secondBatch;
      await eventually(async () => {
        const current = JSON.parse(
          (await controlGet(join(dir, 'control.sock'), '/models')).body,
        ) as { ids: string[]; lastRefreshError: string | null };
        return current.ids.length === 1000 && current.lastRefreshError === 'catalog limit reached';
      });
      const current = JSON.parse((await controlGet(join(dir, 'control.sock'), '/models')).body) as {
        ids: string[];
        lastAttemptAt: string | null;
        lastSuccessAt: string | null;
        lastRefreshError: string | null;
      };
      expect(current.ids).toHaveLength(1000);
      expect(current.ids).toContain('model-a-599');
      expect(current.ids).toContain('model-b-399');
      expect(current.ids).not.toContain('model-b-400');
      expect(current.lastSuccessAt).toEqual(expect.any(String));
      await eventually(async () => {
        const next = JSON.parse((await controlGet(join(dir, 'control.sock'), '/models')).body) as {
          lastAttemptAt: string | null;
        };
        return next.lastAttemptAt !== current.lastAttemptAt;
      });
      const after = JSON.parse((await controlGet(join(dir, 'control.sock'), '/models')).body) as {
        ids: string[];
        lastSuccessAt: string | null;
        lastRefreshError: string | null;
      };
      expect(after.lastRefreshError).toBe('catalog limit reached');
      expect(after.lastSuccessAt).toBe(current.lastSuccessAt);
      expect(after.ids).toEqual(current.ids);
    } finally {
      await server.close();
    }
  } finally {
    await new Promise<void>((resolve) => {
      upstream.closeAllConnections();
      upstream.close(() => resolve());
    });
    await rm(dir, { recursive: true, force: true });
  }
});

it('bounds discovery interval and public prefix configuration', async () => {
  const { readLlmConfig } = await import('../apps/llm-service/src/bootstrap');
  const dir = await mkdtemp(join(tmpdir(), 'llm-discovery-bounds-'));
  const config = join(dir, 'service.toml');
  const writeConfig = (interval: number, prefix: string) =>
    writeFile(
      config,
      `controlSocket = "${dir}/control.sock"\nport = 8090\nroutes = []\n\n[upstream]\nbaseUrl = "http://127.0.0.1:4000"\ncredentialFile = "${dir}/key"\n\n[discovery]\nrefreshIntervalMs = ${interval}\n\n[[discovery.publicCatalogs]]\nurl = "https://example.com/zen/go/v1/models"\nprefix = "${prefix}"\n`,
    );
  try {
    await writeConfig(2_147_483_648, 'opencode/');
    await expect(readLlmConfig(config)).rejects.toThrow('invalid LLM service configuration');
    await writeConfig(2_147_483_647, `${'a'.repeat(127)}/`);
    await expect(readLlmConfig(config)).rejects.toThrow('invalid LLM service configuration');
    await writeConfig(2_147_483_647, 'opencode/');
    await expect(readLlmConfig(config)).resolves.toBeDefined();
  } finally {
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
