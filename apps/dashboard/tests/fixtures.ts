import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type Page } from '@playwright/test';

const buildRoot = resolve(fileURLToPath(new URL('../build', import.meta.url)));

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export interface ApiPayload {
  status: number;
  json?: unknown;
  retryAfter?: number;
}

export type ApiResponse = ApiPayload | { promise: Promise<ApiPayload> } | { destroy: true };

export type ApiHandler = (url: URL, request: IncomingMessage) => ApiResponse;

export interface HarnessState {
  requests: string[];
  settled: number;
  active: number;
  maxActive: number;
  aborted: number;
}

export interface Harness {
  readonly base: string;
  readonly state: HarnessState;
  setHandler(handler: ApiHandler): void;
  waitFor(predicate: () => boolean, timeoutMs?: number): Promise<void>;
}

async function staticFile(pathname: string) {
  const relative = pathname === '/' ? '/index.html' : pathname;
  if (relative.includes('..')) return null;
  const candidate = resolve(buildRoot, `.${relative}`);
  if (candidate !== buildRoot && !candidate.startsWith(`${buildRoot}/`)) return null;
  try {
    const data = await readFile(candidate);
    return { data, type: contentTypes[extname(candidate)] ?? 'application/octet-stream' };
  } catch {
    return null;
  }
}

function respond(res: ServerResponse, result: ApiPayload) {
  const headers: Record<string, string> = { 'cache-control': 'no-store' };
  if (result.retryAfter !== undefined) headers['retry-after'] = String(result.retryAfter);
  if (result.json !== undefined) {
    headers['content-type'] = 'application/json';
    res.writeHead(result.status, headers);
    res.end(JSON.stringify(result.json));
    return;
  }
  res.writeHead(result.status, headers);
  res.end();
}

function trackApi(res: ServerResponse, state: HarnessState) {
  state.active += 1;
  state.maxActive = Math.max(state.maxActive, state.active);
  let settled = false;
  let sent = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    state.active -= 1;
    state.settled += 1;
  };
  res.on('close', () => {
    if (!sent) state.aborted += 1;
    finish();
  });
  return {
    send(result: ApiPayload) {
      sent = true;
      respond(res, result);
      finish();
    },
    finish,
  };
}

async function startHarness(): Promise<{ harness: Harness; server: Server }> {
  const state: HarnessState = { requests: [], settled: 0, active: 0, maxActive: 0, aborted: 0 };
  let handler: ApiHandler = () => ({ status: 404 });
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }
      // Polling metrics cover task data, not the one-time instance-name lookup.
      if (url.pathname === '/api/dashboard-config') {
        respond(res, { status: 200, json: { name: 'Compte-rendu review' } });
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        state.requests.push(url.pathname + url.search);
        const tracked = trackApi(res, state);
        let result: ApiResponse;
        try {
          result = handler(url, req);
        } catch {
          tracked.finish();
          res.writeHead(500);
          res.end();
          return;
        }
        if ('destroy' in result) {
          res.destroy();
          return;
        }
        if ('promise' in result) {
          result.promise.then(
            (value) => tracked.send(value),
            () => tracked.finish(),
          );
          return;
        }
        tracked.send(result);
        return;
      }
      const file = await staticFile(url.pathname);
      if (file) {
        res.writeHead(200, {
          'content-type': file.type,
          'cache-control': url.pathname.startsWith('/_app/') ? 'public, max-age=3600' : 'no-store',
        });
        res.end(file.data);
        return;
      }
      if (req.method === 'GET') {
        const fallback = await staticFile('/index.html');
        if (fallback) {
          res.writeHead(200, { 'content-type': fallback.type, 'cache-control': 'no-store' });
          res.end(fallback.data);
          return;
        }
      }
      res.writeHead(404);
      res.end();
    })();
  });

  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('harness failed to bind');
  const harness: Harness = {
    base: `http://127.0.0.1:${address.port}`,
    state,
    setHandler(next) {
      handler = next;
    },
    async waitFor(predicate, timeoutMs = 6000) {
      await expect.poll(predicate, { timeout: timeoutMs, intervals: [20, 50, 100] }).toBe(true);
    },
  };
  return { harness, server };
}

const pageGate = async (page: Page, run: () => Promise<void>) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (/Failed to load resource/i.test(text)) return;
    errors.push(text);
  });
  await run();
  expect(errors, `browser errors: ${errors.join(' | ')}`).toEqual([]);
};

interface DashboardFixtures {
  harness: Harness;
  base: string;
  consoleGate: void;
}

export const test = base.extend<DashboardFixtures>({
  consoleGate: [
    async ({ page }, use) => {
      await pageGate(page, () => use());
    },
    { auto: true },
  ],
  // Playwright requires the fixture dependencies argument to be destructured even when unused.
  // eslint-disable-next-line no-empty-pattern
  harness: async ({}, use) => {
    const started = await startHarness();
    await use(started.harness);
    await new Promise<void>((resolveClose) => {
      started.server.closeAllConnections();
      started.server.close(() => resolveClose());
    });
  },
  base: async ({ harness }, use) => {
    await use(harness.base);
  },
});

export { expect };
