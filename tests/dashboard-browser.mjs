import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const BUILD = fileURLToPath(new URL('../apps/dashboard/build', import.meta.url));
const NOW = '2026-10-16T12:00:00.000Z';
const CASE_TIMEOUT_MS = 12000;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
const ok = (json) => ({ status: 200, json });

const overviewData = (counts, cleanupAttention) => ({
  generatedAt: NOW,
  counts: {
    queued: counts.queued,
    claimed: counts.claimed,
    publishedLast24h: counts.publishedLast24h,
    failedLast24h: counts.failedLast24h,
  },
  cleanupAttention,
});

const task = (overrides) => ({
  runId: 'run-1',
  status: 'scheduled',
  dispatch: 'queued',
  stage: null,
  processing: null,
  identity: { kind: 'anonymous' },
  receivedAt: NOW,
  claimedAt: null,
  terminalAt: null,
  executionStartedAt: null,
  submissionCompletedAt: null,
  cleanupCompletedAt: null,
  resultReceivedAt: null,
  publicationStartedAt: null,
  lastProgressAt: null,
  queueWaitMs: null,
  totalDurationMs: null,
  cleanup: 'unknown',
  failure: null,
  ...overrides,
});

const historyPage = (tasks, nextCursor = null) => ({ generatedAt: NOW, tasks, nextCursor });
const detailData = (single, milestones = [], processingMilestones = []) => ({
  generatedAt: NOW,
  task: single,
  milestones,
  processingMilestones,
});

const publicIdentity = {
  kind: 'public',
  repositoryFullName: 'acme/widgets',
  pullRequestNumber: 7,
  pullRequestUrl: 'https://github.com/acme/widgets/pull/7',
  expiresAt: '2026-10-16T12:05:00.000Z',
};

const defaultOverviewHandler = (url) => {
  if (url.pathname === '/api/dashboard') {
    return ok(overviewData({ queued: 2, claimed: 1, publishedLast24h: 5, failedLast24h: 1 }, 3));
  }
  if (url.searchParams.get('view') === 'current') {
    return ok(historyPage([task({ runId: 'cur-1', dispatch: 'claimed', claimedAt: NOW })]));
  }
  if (url.searchParams.get('view') === 'cleanup') {
    return ok(historyPage([task({ runId: 'clean-1', status: 'failed', cleanup: 'failed' })]));
  }
  return ok(historyPage([]));
};

const publicIdentityOverviewHandler = (url) => {
  if (url.pathname === '/api/dashboard') {
    return ok(overviewData({ queued: 2, claimed: 1, publishedLast24h: 5, failedLast24h: 1 }, 0));
  }
  if (url.searchParams.get('view') === 'current') {
    return ok(
      historyPage([
        task({ runId: 'cur-1', dispatch: 'claimed', claimedAt: NOW, identity: publicIdentity }),
      ]),
    );
  }
  return ok(historyPage([]));
};

function respond(res, result) {
  const headers = { 'cache-control': 'no-store' };
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

async function serveStatic(pathname, res) {
  const relative = pathname === '/' ? '/index.html' : pathname;
  const filePath = resolve(BUILD, `.${relative}`);
  if (filePath !== BUILD && !filePath.startsWith(`${BUILD}/`)) {
    res.writeHead(403);
    res.end();
    return true;
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

function createHarness() {
  const state = { requests: [], settled: 0, active: 0, maxActive: 0, aborted: 0 };
  let handler = () => ({ status: 404 });
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        state.requests.push(url.pathname + url.search);
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
        let result;
        try {
          result = handler(url, req);
        } catch {
          finish();
          res.writeHead(500);
          res.end();
          return;
        }
        if (result && result.destroy) {
          res.destroy();
          return;
        }
        if (result && result.promise) {
          result.promise.then(
            (value) => {
              sent = true;
              respond(res, value);
              finish();
            },
            () => finish(),
          );
        } else {
          sent = true;
          respond(res, result);
          finish();
        }
        return;
      }
      if (await serveStatic(url.pathname, res)) return;
      await serveStatic('/index.html', res);
    })();
  });
  return {
    state,
    setHandler(handlerFn) {
      handler = handlerFn;
    },
    reset() {
      state.requests.length = 0;
      state.settled = 0;
      state.active = 0;
      state.maxActive = 0;
      state.aborted = 0;
    },
    waitFor(predicate, timeoutMs = 6000) {
      const started = Date.now();
      return new Promise((resolvePromise, reject) => {
        const poll = () => {
          if (predicate()) {
            resolvePromise();
            return;
          }
          if (Date.now() - started > timeoutMs) {
            reject(new Error(`condition not met within ${timeoutMs}ms`));
            return;
          }
          setTimeout(poll, 20);
        };
        poll();
      });
    },
    listen: () =>
      new Promise((resolvePromise) => {
        server.listen(0, '127.0.0.1', () => resolvePromise(server.address().port));
      }),
    close: () =>
      new Promise((resolvePromise) => {
        server.closeAllConnections?.();
        server.close(() => resolvePromise());
      }),
  };
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('overview requests its read-only endpoints and renders counts and lists', async ({
  page,
  harness,
  base,
}) => {
  harness.setHandler(defaultOverviewHandler);
  await page.goto(`${base}/`);
  await page.waitForSelector('[data-testid="stats"]');
  const requested = harness.state.requests.slice();
  assert.ok(requested.includes('/api/dashboard'));
  assert.ok(requested.includes('/api/jobs?view=current'));
  assert.ok(requested.includes('/api/jobs?view=cleanup'));
  assert.equal(await page.locator('[data-testid="stat"] strong').first().textContent(), '2');
  const text = await page.locator('#content').textContent();
  assert.ok(text.includes('Protected task'));
  assert.ok(text.includes('Cleanup needs attention'));
});

test('overview links truncated lists to the matching filtered history view', async ({
  page,
  harness,
  base,
}) => {
  const current25 = Array.from({ length: 25 }, (_, index) => task({ runId: `cur-${index}` }));
  harness.setHandler((url) => {
    if (url.pathname === '/api/dashboard') {
      return ok(overviewData({ queued: 25, claimed: 0, publishedLast24h: 0, failedLast24h: 0 }, 2));
    }
    if (url.searchParams.get('view') === 'current') return ok(historyPage(current25, 'CUR-CURSOR'));
    if (url.searchParams.get('view') === 'cleanup')
      return ok(historyPage([task({ runId: 'c-1' })], 'CLN-CURSOR'));
    return ok(historyPage([]));
  });
  await page.goto(`${base}/`);
  await page.waitForSelector('[data-testid="view-all-current"]');
  await page.click('[data-testid="view-all-current"]');
  await page.waitForFunction(
    () => location.pathname === '/history' && location.search.includes('view=current'),
  );
  await page.waitForSelector('[data-testid="next-page"]');
  assert.equal(harness.state.requests[harness.state.requests.length - 1], '/api/jobs?view=current');
  await page.goto(`${base}/`);
  await page.waitForSelector('[data-testid="view-all-cleanup"]');
  await page.click('[data-testid="view-all-cleanup"]');
  await page.waitForFunction(
    () => location.pathname === '/history' && location.search.includes('view=cleanup'),
  );
  await page.waitForSelector('[data-testid="next-page"]');
  assert.equal(harness.state.requests[harness.state.requests.length - 1], '/api/jobs?view=cleanup');
});

test('a same-day date filter includes the whole UTC day', async ({ page, harness, base }) => {
  harness.setHandler(() => ok(historyPage([task({ runId: 'h-1' })])));
  await page.goto(`${base}/history?from=2026-10-16&to=2026-10-16`);
  await page.waitForSelector('[data-testid="task"]');
  assert.equal(await page.locator('input[name="from"]').inputValue(), '2026-10-16');
  assert.equal(await page.locator('input[name="to"]').inputValue(), '2026-10-16');
  const requested = new URL(`${base}${harness.state.requests[harness.state.requests.length - 1]}`);
  assert.equal(requested.searchParams.get('from'), '2026-10-16T00:00:00.000Z');
  assert.equal(requested.searchParams.get('to'), '2026-10-16T23:59:59.999Z');
});

test('applying date inputs sends day-inclusive UTC bounds', async ({ page, harness, base }) => {
  harness.setHandler(() => ok(historyPage([])));
  await page.goto(`${base}/history`);
  await page.waitForSelector('input[name="from"]');
  await page.fill('input[name="from"]', '2026-10-16');
  await page.fill('input[name="to"]', '2026-10-16');
  await page.click('[data-testid="apply"]');
  await harness.waitFor(() => harness.state.requests.some((request) => request.includes('from=')));
  const requested = new URL(`${base}${harness.state.requests[harness.state.requests.length - 1]}`);
  assert.equal(requested.searchParams.get('from'), '2026-10-16T00:00:00.000Z');
  assert.equal(requested.searchParams.get('to'), '2026-10-16T23:59:59.999Z');
  assert.equal(await page.locator('input[name="from"]').inputValue(), '2026-10-16');
});

test('history applies filters, resets the cursor and drops malformed values', async ({
  page,
  harness,
  base,
}) => {
  harness.setHandler(() => ok(historyPage([task({ runId: 'h-1' })], 'CURSOR-1')));
  await page.goto(`${base}/history?status=nonsense&cursor=CURSOR-1`);
  await page.waitForSelector('[data-testid="task"]');
  assert.ok(!(await page.evaluate(() => location.search)).includes('nonsense'));
  const initial = harness.state.requests[harness.state.requests.length - 1];
  assert.ok(!initial.includes('status=nonsense'));
  assert.equal(await page.locator('select[name="status"]').inputValue(), 'all');
  await page.selectOption('select[name="status"]', 'failed');
  await page.click('[data-testid="apply"]');
  await page.waitForFunction(() => location.search.includes('status=failed'));
  await harness.waitFor(() =>
    harness.state.requests.some((request) => request.includes('status=failed')),
  );
  const applied = harness.state.requests[harness.state.requests.length - 1];
  assert.equal(applied, '/api/jobs?status=failed');
});

test('a refresh error clears identity and keeps operational context as stale', async ({
  page,
  harness,
  base,
}) => {
  harness.setHandler(publicIdentityOverviewHandler);
  await page.goto(`${base}/`);
  await page.waitForSelector('[data-testid="stats"]');
  assert.ok((await page.locator('#content').textContent()).includes('acme/widgets'));
  harness.setHandler(() => ({ status: 503 }));
  await page.click('[data-testid="refresh"]');
  await page.waitForSelector('[data-testid="error-notice"]');
  const text = await page.locator('#content').textContent();
  assert.ok(!text.includes('acme/widgets'));
  assert.ok(text.includes('Protected task'));
  assert.equal(await page.locator('[data-testid="stat"] strong').first().textContent(), '2');
});

test('a malformed 200 keeps the last-good timestamp and applies backoff', async ({
  page,
  harness,
  base,
}) => {
  harness.setHandler(defaultOverviewHandler);
  await page.goto(`${base}/`);
  await page.waitForSelector('[data-testid="stats"]');
  const before = await page.locator('[data-testid="last-refresh"]').textContent();
  harness.setHandler(() => ok({ generatedAt: NOW }));
  await page.click('[data-testid="refresh"]');
  await page.waitForSelector('[data-testid="error-notice"]');
  assert.equal(await page.locator('[data-testid="last-refresh"]').textContent(), before);
  assert.equal(await page.locator('[data-testid="stat"] strong').first().textContent(), '2');
  const count = harness.state.requests.length;
  await sleep(1200);
  assert.equal(harness.state.requests.length, count);
});

test('a failed refresh backs off before the next attempt', async ({ page, harness, base }) => {
  harness.setHandler(() => ({ status: 503 }));
  await page.clock.install();
  await page.goto(`${base}/`);
  await page.waitForSelector('[data-testid="error-notice"]');
  const count = harness.state.requests.length;
  await page.clock.fastForward(20000);
  assert.equal(harness.state.requests.length, count);
  await page.clock.fastForward(20000);
  await harness.waitFor(() => harness.state.requests.length > count, 4000);
});

test('a longer Retry-After deadline is honoured over the backoff', async ({
  page,
  harness,
  base,
}) => {
  harness.setHandler(() => ({ status: 429, retryAfter: 60 }));
  await page.clock.install();
  await page.goto(`${base}/`);
  await page.waitForSelector('[data-testid="error-notice"]');
  const count = harness.state.requests.length;
  await page.clock.fastForward(35000);
  assert.equal(harness.state.requests.length, count);
  await page.clock.fastForward(30000);
  await harness.waitFor(() => harness.state.requests.length > count, 4000);
});

test('navigation cancels the previous in-flight request', async ({ page, harness, base }) => {
  let release;
  const gate = new Promise((resolvePromise) => {
    release = resolvePromise;
  });
  harness.setHandler(() => ({ promise: gate.then(() => ok(historyPage([task({ runId: 'x' })]))) }));
  await page.goto(`${base}/`);
  await harness.waitFor(() => harness.state.requests.length >= 3);
  await page.click('nav a[href="/history"]');
  await harness.waitFor(() => harness.state.aborted >= 3, 5000);
  assert.ok(harness.state.active <= 3, `active=${harness.state.active}`);
  release();
});

test('a failed overview request aborts its stalled siblings and the next refresh does not overlap', async ({
  page,
  harness,
  base,
}) => {
  harness.setHandler((url) => {
    if (url.pathname === '/api/dashboard') return { destroy: true };
    return { promise: new Promise(() => {}) };
  });
  await page.goto(`${base}/`);
  await page.waitForSelector('[data-testid="error-notice"]');
  await harness.waitFor(() => harness.state.aborted >= 2, 4000);
  const afterFailure = harness.state.requests.length;
  harness.setHandler(defaultOverviewHandler);
  await page.click('[data-testid="error-notice"] button');
  await page.waitForSelector('[data-testid="stats"]');
  assert.ok(harness.state.requests.length > afterFailure);
  assert.ok(harness.state.active <= 3, `active=${harness.state.active}`);
});

test('repeated manual refresh clicks stay single-flight', async ({ page, harness, base }) => {
  harness.setHandler(defaultOverviewHandler);
  await page.goto(`${base}/`);
  await page.waitForSelector('[data-testid="stats"]');
  const afterInitial = harness.state.requests.length;
  let release;
  const gate = new Promise((resolvePromise) => {
    release = resolvePromise;
  });
  harness.setHandler(() => ({
    promise: gate.then(() =>
      ok(overviewData({ queued: 0, claimed: 0, publishedLast24h: 0, failedLast24h: 0 }, 0)),
    ),
  }));
  await page.click('[data-testid="refresh"]');
  await harness.waitFor(() => harness.state.requests.length >= afterInitial + 3);
  await page.click('[data-testid="refresh"]');
  await sleep(200);
  assert.equal(harness.state.requests.length, afterInitial + 3);
  release();
});

test('a request beyond the 15s browser timeout surfaces an error', async ({
  page,
  harness,
  base,
}) => {
  harness.setHandler(() => ({ promise: new Promise(() => {}) }));
  await page.clock.install();
  await page.goto(`${base}/`);
  await harness.waitFor(() => harness.state.requests.length >= 3, 4000);
  await page.clock.runFor(16000);
  const deadline = Date.now() + 4000;
  while (
    Date.now() < deadline &&
    (await page.locator('[data-testid="error-notice"]').count()) === 0
  ) {
    await sleep(50);
  }
  assert.equal(await page.locator('[data-testid="error-notice"]').count(), 1);
});

test('returning from a hidden tab refreshes immediately', async ({ page, harness, base }) => {
  harness.setHandler(() => ok(historyPage([task({ runId: 'h-1' })])));
  await page.goto(`${base}/history`);
  await page.waitForSelector('[data-testid="task"]');
  const before = harness.state.settled;
  harness.setHandler(() => ok(historyPage([task({ runId: 'h-1' }), task({ runId: 'h-2' })])));
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await harness.waitFor(() => harness.state.settled > before);
  await page.waitForSelector('[data-testid="task-link"][data-run-id="h-2"]');
});

test('a data refresh keeps focus on the focused filter control', async ({
  page,
  harness,
  base,
}) => {
  harness.setHandler(() => ok(historyPage([task({ runId: 'h-1' })])));
  await page.goto(`${base}/history`);
  await page.waitForSelector('select[name="status"]');
  await page.focus('select[name="status"]');
  const before = harness.state.settled;
  harness.setHandler(() => ok(historyPage([task({ runId: 'h-1' }), task({ runId: 'h-2' })])));
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await harness.waitFor(() => harness.state.settled > before);
  await page.waitForSelector('[data-testid="task-link"][data-run-id="h-2"]');
  const focus = await page.evaluate(
    () => document.activeElement && document.activeElement.getAttribute('name'),
  );
  assert.equal(focus, 'status');
});

test('a data refresh preserves unapplied draft filter values', async ({ page, harness, base }) => {
  harness.setHandler(() => ok(historyPage([task({ runId: 'h-1' })])));
  await page.goto(`${base}/history`);
  await page.waitForSelector('select[name="status"]');
  await page.selectOption('select[name="status"]', 'failed');
  const before = harness.state.settled;
  harness.setHandler(() => ok(historyPage([task({ runId: 'h-1' }), task({ runId: 'h-2' })])));
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await harness.waitFor(() => harness.state.settled > before);
  await page.waitForSelector('[data-testid="task-link"][data-run-id="h-2"]');
  assert.equal(await page.locator('select[name="status"]').inputValue(), 'failed');
  assert.ok(!(await page.evaluate(() => location.search)).includes('status=failed'));
});

test('a data refresh keeps keyboard focus on the task link', async ({ page, harness, base }) => {
  harness.setHandler(() => ok(historyPage([task({ runId: 'h-1' })])));
  await page.goto(`${base}/history`);
  await page.waitForSelector('[data-testid="task-link"]');
  await page.focus('[data-testid="task-link"]');
  const before = harness.state.settled;
  harness.setHandler(() => ok(historyPage([task({ runId: 'h-1' }), task({ runId: 'h-2' })])));
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await harness.waitFor(() => harness.state.settled > before);
  await page.waitForSelector('[data-testid="task-link"][data-run-id="h-2"]');
  const href = await page.evaluate(
    () => document.activeElement && document.activeElement.getAttribute('href'),
  );
  assert.ok(href && href.includes('/jobs/h-1'), `href=${href}`);
});

test('a data refresh keeps the scroll position', async ({ page, harness, base }) => {
  const many = [];
  for (let index = 0; index < 40; index += 1) many.push(task({ runId: `h-${index}` }));
  harness.setHandler(() => ok(historyPage(many)));
  await page.goto(`${base}/history`);
  await page.waitForSelector('[data-testid="task"]');
  await page.evaluate(() => window.scrollTo(0, 600));
  const before = harness.state.settled;
  harness.setHandler(() => ok(historyPage([...many, task({ runId: 'h-40' })])));
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await harness.waitFor(() => harness.state.settled > before);
  await page.waitForSelector('[data-testid="task-link"][data-run-id="h-40"]');
  const scrollY = await page.evaluate(() => window.scrollY);
  assert.ok(scrollY > 300, `scrollY=${scrollY}`);
});

test('identity expires independently of network and navigation', async ({
  page,
  harness,
  base,
}) => {
  const expiring = { ...publicIdentity, expiresAt: new Date(Date.parse(NOW) + 400).toISOString() };
  harness.setHandler((url) => {
    if (url.pathname === '/api/dashboard') {
      return ok(overviewData({ queued: 1, claimed: 0, publishedLast24h: 0, failedLast24h: 0 }, 0));
    }
    if (url.searchParams.get('view') === 'current') {
      return ok(historyPage([task({ runId: 'r', identity: expiring })]));
    }
    return ok(historyPage([]));
  });
  await page.clock.install();
  await page.goto(`${base}/`);
  await page.waitForSelector('[data-testid="task-link"]');
  assert.ok(
    (await page.locator('[data-testid="task-link"]').textContent()).includes('acme/widgets'),
  );
  await page.clock.fastForward(2000);
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="task-link"]')?.textContent?.includes('Protected task'),
  );
});

test('each identity expires at its own deadline without a refresh', async ({
  page,
  harness,
  base,
}) => {
  const first = {
    ...publicIdentity,
    repositoryFullName: 'acme/one',
    expiresAt: new Date(Date.parse(NOW) + 300).toISOString(),
  };
  const second = {
    ...publicIdentity,
    repositoryFullName: 'acme/two',
    expiresAt: new Date(Date.parse(NOW) + 900).toISOString(),
  };
  harness.setHandler((url) => {
    if (url.pathname === '/api/dashboard') {
      return ok(overviewData({ queued: 2, claimed: 0, publishedLast24h: 0, failedLast24h: 0 }, 0));
    }
    if (url.searchParams.get('view') === 'current') {
      return ok(
        historyPage([
          task({ runId: 'one', identity: first }),
          task({ runId: 'two', identity: second }),
        ]),
      );
    }
    return ok(historyPage([]));
  });
  await page.clock.install();
  await page.goto(`${base}/`);
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="task-link"]').length === 2,
  );
  assert.ok((await page.locator('#content').textContent()).includes('acme/one'));
  assert.ok((await page.locator('#content').textContent()).includes('acme/two'));
  await page.clock.fastForward(500);
  await page.waitForFunction(() => {
    const texts = [...document.querySelectorAll('[data-testid="task-link"]')].map(
      (el) => el.textContent || '',
    );
    return (
      texts.some((text) => text.includes('acme/two')) &&
      !texts.some((text) => text.includes('acme/one'))
    );
  });
  await page.clock.fastForward(600);
  await page.waitForFunction(() => {
    const texts = [...document.querySelectorAll('[data-testid="task-link"]')].map(
      (el) => el.textContent || '',
    );
    return texts.length > 0 && !texts.some((text) => text.includes('acme/'));
  });
});

test('an already-expired public identity is not rendered', async ({ page, harness, base }) => {
  const expired = { ...publicIdentity, expiresAt: NOW };
  harness.setHandler((url) => {
    if (url.pathname === '/api/dashboard') {
      return ok(overviewData({ queued: 1, claimed: 0, publishedLast24h: 0, failedLast24h: 0 }, 0));
    }
    if (url.searchParams.get('view') === 'current') {
      return ok(historyPage([task({ runId: 'r', identity: expired })]));
    }
    return ok(historyPage([]));
  });
  await page.goto(`${base}/`);
  await page.waitForSelector('[data-testid="task-link"]');
  const text = await page.locator('#content').textContent();
  assert.ok(text.includes('Protected task'));
  assert.ok(!text.includes('acme/widgets'));
});

test('applying a filter cancels the previous in-flight refresh', async ({
  page,
  harness,
  base,
}) => {
  harness.setHandler(() => ok(historyPage([task({ runId: 'h-1' })])));
  await page.goto(`${base}/history`);
  await page.waitForSelector('[data-testid="task"]');
  let release;
  const gate = new Promise((resolvePromise) => {
    release = resolvePromise;
  });
  harness.setHandler(() => ({
    promise: gate.then(() => ok(historyPage([task({ runId: 'h-failed' })]))),
  }));
  await page.click('[data-testid="refresh"]');
  await harness.waitFor(() => harness.state.active >= 1);
  await page.selectOption('select[name="status"]', 'failed');
  await page.click('[data-testid="apply"]');
  await harness.waitFor(() => harness.state.aborted >= 1, 5000);
  release();
  await page.waitForSelector('[data-testid="task-link"][data-run-id="h-failed"]');
  assert.ok(harness.state.requests.includes('/api/jobs?status=failed'));
  assert.ok((await page.evaluate(() => location.search)).includes('status=failed'));
});

test('a valid identity expires while offline and does not return without a fresh response', async ({
  page,
  harness,
  base,
}) => {
  const expiring = { ...publicIdentity, expiresAt: new Date(Date.parse(NOW) + 400).toISOString() };
  harness.setHandler((url) => {
    if (url.pathname === '/api/dashboard') {
      return ok(overviewData({ queued: 1, claimed: 0, publishedLast24h: 0, failedLast24h: 0 }, 0));
    }
    if (url.searchParams.get('view') === 'current') {
      return ok(historyPage([task({ runId: 'r', identity: expiring })]));
    }
    return ok(historyPage([]));
  });
  await page.goto(`${base}/`);
  await page.waitForSelector('[data-testid="task-link"]');
  assert.ok((await page.locator('#content').textContent()).includes('acme/widgets'));
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    window.dispatchEvent(new Event('offline'));
  });
  await page.waitForFunction(
    () => (document.querySelector('#content')?.textContent || '').includes('Protected task'),
    null,
    { timeout: 4000 },
  );
  harness.setHandler(() => ({ status: 503 }));
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
    window.dispatchEvent(new Event('online'));
  });
  await page.waitForSelector('[data-testid="error-notice"]');
  const text = await page.locator('#content').textContent();
  assert.ok(text.includes('Protected task'));
  assert.ok(!text.includes('acme/widgets'));
});

test('network delay is subtracted from the identity lifetime conservatively', async ({
  page,
  harness,
  base,
}) => {
  const lifetime = { ...publicIdentity, expiresAt: new Date(Date.parse(NOW) + 200).toISOString() };
  harness.setHandler((url) => {
    const delayed = sleep(300).then(() => {
      if (url.pathname === '/api/dashboard') {
        return ok(
          overviewData({ queued: 1, claimed: 0, publishedLast24h: 0, failedLast24h: 0 }, 0),
        );
      }
      if (url.searchParams.get('view') === 'current') {
        return ok(historyPage([task({ runId: 'r', identity: lifetime })]));
      }
      return ok(historyPage([]));
    });
    return { promise: delayed };
  });
  await page.goto(`${base}/`);
  await page.waitForSelector('[data-testid="task-link"]');
  assert.ok(
    (await page.locator('[data-testid="task-link"]').textContent()).includes('Protected task'),
  );
});

test('hostile route and task fields cannot inject markup or run scripts', async ({
  page,
  harness,
  base,
}) => {
  let dialogShown = false;
  page.on('dialog', async (dialog) => {
    dialogShown = true;
    await dialog.dismiss();
  });
  harness.setHandler((url) => {
    if (url.pathname === '/api/dashboard') {
      return ok(overviewData({ queued: 1, claimed: 0, publishedLast24h: 0, failedLast24h: 0 }, 0));
    }
    if (url.searchParams.get('view') === 'current') {
      return ok(
        historyPage([
          task({
            runId: 'r',
            identity: {
              kind: 'public',
              repositoryFullName: '<img src=x onerror=alert(1)>',
              pullRequestNumber: 1,
              pullRequestUrl: 'https://github.com/x/y/pull/1',
              expiresAt: '2026-10-16T12:05:00.000Z',
            },
          }),
        ]),
      );
    }
    if (url.pathname.startsWith('/api/jobs/')) return ok(detailData(task({ runId: 'r' }), [], []));
    return ok(historyPage([]));
  });
  await page.goto(`${base}/`);
  await page.waitForSelector('[data-testid="task-link"]');
  assert.equal(dialogShown, false);
  assert.equal(await page.locator('#content img').count(), 0);
  assert.ok(
    (await page.locator('#content').textContent()).includes('<img src=x onerror=alert(1)>'),
  );
  await page.goto(`${base}/jobs/%22%3E%3Cscript%3Ealert(2)%3C%2Fscript%3E`);
  await page.waitForSelector('#content');
  assert.equal(dialogShown, false);
  assert.equal(await page.locator('#content script').count(), 0);
});

test('browsing makes no requests to external hosts', async ({ page, harness, base }) => {
  const external = [];
  page.on('request', (request) => {
    if (new URL(request.url()).hostname !== '127.0.0.1') external.push(request.url());
  });
  harness.setHandler(defaultOverviewHandler);
  await page.goto(`${base}/`);
  await page.waitForSelector('[data-testid="stats"]');
  await page.goto(`${base}/history`);
  await page.waitForSelector('[data-testid="task"], .border-dashed');
  assert.deepEqual(external, []);
});

test('detail renders milestones, failure category and the public PR link', async ({
  page,
  harness,
  base,
}) => {
  harness.setHandler(() =>
    ok(
      detailData(
        task({
          runId: 'run-9',
          status: 'failed',
          identity: publicIdentity,
          failure: { phase: 'checkout', reason: 'checkout' },
          cleanup: 'failed',
          terminalAt: '2026-10-16T12:01:00.000Z',
        }),
        [
          { stage: 'checkout', startedAt: '2026-10-16T12:00:30.000Z' },
          { stage: 'agent', startedAt: '2026-10-16T12:00:20.000Z' },
        ],
      ),
    ),
  );
  await page.goto(`${base}/jobs/run-9`);
  await page.waitForSelector('.timeline');
  const text = await page.locator('#content').textContent();
  assert.ok(text.includes('acme/widgets #7'));
  assert.ok(text.includes('Failure category: checkout'));
  assert.equal(await page.locator('.timeline li strong').first().textContent(), 'Reviewing');
  assert.equal(
    await page.locator('.detail a[target="_blank"]').getAttribute('href'),
    'https://github.com/acme/widgets/pull/7',
  );
});

test('detail shows DB processing milestones and neutral legacy observations', async ({
  page,
  harness,
  base,
}) => {
  harness.setHandler(() =>
    ok(
      detailData(
        task({
          runId: 'run-sup',
          status: 'superseded',
          terminalAt: '2026-10-16T10:00:00.000Z',
          cleanup: 'failed',
          cleanupCompletedAt: '2026-10-16T20:00:00.000Z',
        }),
        [{ stage: 'checkout', startedAt: '2026-10-16T12:00:30.000Z' }],
        [
          { stage: 'received', startedAt: '2026-10-16T12:02:00.000Z' },
          { stage: 'publishing', startedAt: '2026-10-16T12:03:00.000Z' },
        ],
      ),
    ),
  );
  await page.goto(`${base}/jobs/run-sup`);
  await page.waitForSelector('.timeline');
  const labels = await page.locator('.timeline li strong').allTextContents();
  assert.deepEqual(labels, ['Checkout', 'Result received', 'Publishing']);
  assert.equal(
    await page
      .locator('.fact', { hasText: 'Cleanup attempt finished' })
      .locator('time')
      .getAttribute('datetime'),
    '2026-10-16T20:00:00.000Z',
  );
  const text = await page.locator('#content').textContent();
  assert.ok(text.includes('Cleanup failed'));
  assert.ok(!text.includes('Cleanup complete'));
  assert.ok(text.includes('Result processing observed'));
  assert.ok(!text.includes('Submission finished reported'));
});

test('detail timeline falls back to DB processing timestamps when the milestone array is empty', async ({
  page,
  harness,
  base,
}) => {
  harness.setHandler(() =>
    ok(
      detailData(
        task({
          runId: 'run-s',
          status: 'completed',
          resultReceivedAt: '2026-10-16T12:02:00.000Z',
          publicationStartedAt: '2026-10-16T12:03:00.000Z',
        }),
        [],
        [],
      ),
    ),
  );
  await page.goto(`${base}/jobs/run-s`);
  await page.waitForSelector('.timeline');
  const labels = await page.locator('.timeline li strong').allTextContents();
  assert.deepEqual(labels, ['Result received', 'Publishing']);
});

test('a missing task renders a neutral 404', async ({ page, harness, base }) => {
  harness.setHandler(() => ({ status: 404 }));
  await page.goto(`${base}/jobs/missing-run`);
  await page.waitForSelector('text=Page not found');
  assert.ok(!(await page.locator('#content').textContent()).includes('temporarily unavailable'));
});

test('a direct deep link returns to history deterministically', async ({ page, harness, base }) => {
  harness.setHandler((url) => {
    if (url.pathname.startsWith('/api/jobs/'))
      return ok(detailData(task({ runId: 'run-9' }), [], []));
    return ok(historyPage([task({ runId: 'h-1' })]));
  });
  await page.goto(`${base}/jobs/run-9`);
  await page.waitForSelector('.detail');
  assert.equal(await page.locator('[data-back]').getAttribute('href'), '/history');
  await page.click('[data-back]');
  await page.waitForFunction(() => location.pathname === '/history');
  await page.waitForSelector('[data-testid="task"]');
});

test('back from a task returns to the same-page filtered history', async ({
  page,
  harness,
  base,
}) => {
  harness.setHandler((url) => {
    if (url.pathname.startsWith('/api/jobs/'))
      return ok(detailData(task({ runId: 'run-9' }), [], []));
    return ok(historyPage([task({ runId: 'h-1' })]));
  });
  await page.goto(`${base}/history?status=failed`);
  await page.waitForSelector('[data-testid="task-link"]');
  await page.click('[data-testid="task-link"]');
  await page.waitForSelector('.detail');
  assert.equal(await page.locator('[data-back]').getAttribute('href'), '/history?status=failed');
  await page.click('[data-back]');
  await page.waitForFunction(
    () => location.pathname === '/history' && location.search.includes('status=failed'),
  );
  assert.equal(
    harness.state.requests[harness.state.requests.length - 1],
    '/api/jobs?status=failed',
  );
});

test('back from a task restores the history scroll position', async ({ page, harness, base }) => {
  const many = [];
  for (let index = 0; index < 40; index += 1) many.push(task({ runId: `h-${index}` }));
  harness.setHandler((url) => {
    if (url.pathname.startsWith('/api/jobs/'))
      return ok(detailData(task({ runId: 'run-9' }), [], []));
    return ok(historyPage(many));
  });
  await page.goto(`${base}/history`);
  await page.waitForSelector('[data-testid="task"]');
  await page.evaluate(() => window.scrollTo(0, 700));
  await page.click('[data-testid="task-link"][data-run-id="h-8"]');
  await page.waitForSelector('.detail');
  await page.click('[data-back]');
  await page.waitForFunction(() => location.pathname === '/history');
  await page.waitForSelector('[data-testid="task"]');
  await page.waitForFunction(() => window.scrollY > 400, null, { timeout: 4000 });
});

test('resuming a detail page does not restore identity without a fresh public response', async ({
  page,
  harness,
  base,
}) => {
  harness.setHandler(() => ok(detailData(task({ runId: 'r', identity: publicIdentity }), [], [])));
  await page.goto(`${base}/jobs/r`);
  await page.waitForSelector('.detail');
  assert.ok((await page.locator('#content').textContent()).includes('acme/widgets'));
  const before = harness.state.settled;
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  harness.setHandler(() => ({ status: 503 }));
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await harness.waitFor(() => harness.state.settled > before);
  await page.waitForSelector('.notice.error');
  const text = await page.locator('#content').textContent();
  assert.ok(text.includes('Protected task'));
  assert.ok(!text.includes('acme/widgets'));
});

test('help page is reachable from the primary nav, survives a reload and anchors work', async ({
  page,
  harness,
  base,
}) => {
  harness.setHandler(defaultOverviewHandler);
  await page.goto(`${base}/`);
  await page.waitForSelector('[data-testid="stats"]');
  await page.click('nav a[href="/help"]');
  await page.waitForFunction(() => location.pathname === '/help');
  await page.waitForSelector('#overview-counts');
  assert.equal(await page.locator('nav a[href="/help"]').getAttribute('aria-current'), 'page');
  await page.click('a[href="#cleanup-attention"]');
  await page.waitForFunction(() => location.hash === '#cleanup-attention');
  assert.equal(await page.locator('#cleanup-attention').isVisible(), true);
  await page.goto(`${base}/help`);
  await page.waitForSelector('#overview-counts');
  assert.equal(await page.locator('nav a[href="/help"]').getAttribute('aria-current'), 'page');
});

test('help page is usable on a narrow viewport without horizontal overflow', async ({
  page,
  harness,
  base,
}) => {
  harness.setHandler(defaultOverviewHandler);
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto(`${base}/help`);
  await page.waitForSelector('#overview-counts');
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  assert.ok(overflow <= 1, `horizontal overflow=${overflow}`);
  assert.equal(await page.locator('nav a[href="/help"]').isVisible(), true);
  await page.click('nav a[href="/help"]');
  await page.waitForFunction(() => location.pathname === '/help');
});

try {
  await access(join(BUILD, 'index.html'));
} catch {
  process.stderr.write(
    `dashboard build not found at ${BUILD}. Run: (cd apps/dashboard && vp build)\n`,
  );
  process.exit(1);
}

const harness = createHarness();
const port = await harness.listen();
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
  headless: true,
  args: ['--no-sandbox'],
  timeout: 30000,
});

let failed = 0;
for (const entry of tests) {
  const page = await browser.newPage();
  page.setDefaultTimeout(6000);
  page.setDefaultNavigationTimeout(8000);
  const pageErrors = [];
  page.on('pageerror', (error) =>
    pageErrors.push(String(error && error.message ? error.message : error)),
  );
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (/Failed to load resource/i.test(text)) return;
    pageErrors.push(text);
  });
  harness.reset();
  const started = Date.now();
  try {
    await Promise.race([
      entry.fn({ page, harness, base }),
      sleep(CASE_TIMEOUT_MS).then(() => {
        throw new Error(`case exceeded ${CASE_TIMEOUT_MS}ms`);
      }),
    ]);
    if (pageErrors.length) throw new Error(`browser errors: ${pageErrors.join(' | ')}`);
    process.stdout.write(`ok - ${entry.name} (${Date.now() - started}ms)\n`);
  } catch (error) {
    failed += 1;
    const detail = pageErrors.length ? `\n    browser errors: ${pageErrors.join(' | ')}` : '';
    process.stderr.write(`FAIL - ${entry.name}\n    ${error && error.message}${detail}\n`);
  }
  await page.close();
}

await browser.close();
await harness.close();
process.stdout.write(
  failed ? `\n${failed} browser check(s) failed\n` : '\nall dashboard browser checks passed\n',
);
process.exit(failed ? 1 : 0);
