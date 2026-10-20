import type {
  PublicHistoryPage,
  PublicMilestone,
  PublicOverview,
  PublicTaskDetail,
  PublicTaskIdentity,
  PublicTaskState,
} from '@compte-rendu/contracts';
import type { Page } from '@playwright/test';
import { expect, test, type ApiHandler, type ApiPayload } from './fixtures';

const NOW = '2026-10-16T12:00:00.000Z';

test.describe('consistent absolute timestamps', () => {
  test.use({ locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
  test('shows the same English UTC timestamp in a non-UTC browser', async ({
    page,
    harness,
    base,
  }) => {
    harness.setHandler(() => ok(detailData(task({ status: 'completed', dispatch: null }))));
    await page.goto(`${base}/jobs/run-1`);
    await expect(page.locator(`time[datetime="${NOW}"]`).first()).toHaveText(
      'Oct 16, 2026, 12:00:00 PM UTC',
    );
  });
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const reconnect = (page: Page) =>
  page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    window.dispatchEvent(new Event('offline'));
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
    window.dispatchEvent(new Event('online'));
  });
const setVisibility = (page: Page, state: 'hidden' | 'visible') =>
  page.evaluate((next) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => next === 'hidden' });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => next });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
const ok = (json: unknown): ApiPayload => ({ status: 200, json });

const overviewData = (
  counts: PublicOverview['counts'],
  cleanupAttention: number,
): PublicOverview & PublicHistoryPage => ({
  tasks: [],
  nextCursor: null,
  generatedAt: NOW,
  counts,
  cleanupAttention,
});

const task = (overrides: Partial<PublicTaskState> = {}): PublicTaskState => ({
  runId: 'run-1',
  status: 'scheduled',
  dispatch: 'queued',
  stage: null,
  processing: null,
  decision: null,
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

const historyPage = (
  tasks: PublicTaskState[],
  nextCursor: string | null = null,
): PublicHistoryPage => ({ generatedAt: NOW, tasks, nextCursor });

const detailData = (
  single: PublicTaskState,
  milestones: PublicMilestone[] = [],
  processingMilestones: PublicTaskDetail['processingMilestones'] = [],
): PublicTaskDetail => ({ generatedAt: NOW, task: single, milestones, processingMilestones });

const publicIdentity: Extract<PublicTaskIdentity, { kind: 'public' }> = {
  kind: 'public',
  repositoryFullName: 'acme/widgets',
  pullRequestNumber: 7,
  pullRequestUrl: 'https://github.com/acme/widgets/pull/7',
  expiresAt: '2026-10-16T12:05:00.000Z',
  baseRef: 'main',
  headRef: 'feature/widgets',
  baseSha: '1'.repeat(40),
  headSha: '2'.repeat(40),
};

const defaultOverviewHandler: ApiHandler = (url) => {
  if (url.pathname === '/api/dashboard') {
    return ok({
      ...overviewData({ queued: 2, claimed: 1, publishedLast24h: 5, failedLast24h: 1 }, 3),
      ...historyPage([task({ runId: 'cur-1', dispatch: 'claimed', claimedAt: NOW })]),
    });
  }
  if (url.searchParams.get('view') === 'cleanup') {
    return ok(
      historyPage([
        task({ runId: 'clean-1', status: 'failed', dispatch: null, cleanup: 'failed' }),
      ]),
    );
  }
  return ok(historyPage([]));
};

const publicIdentityOverviewHandler: ApiHandler = (url) => {
  if (url.pathname === '/api/dashboard') {
    return ok({
      ...overviewData({ queued: 2, claimed: 1, publishedLast24h: 5, failedLast24h: 1 }, 0),
      ...historyPage([
        task({ runId: 'cur-1', dispatch: 'claimed', claimedAt: NOW, identity: publicIdentity }),
      ]),
    });
  }
  return ok(historyPage([]));
};

const expiringIdentity = (ms: number, name = 'acme/widgets') => ({
  ...publicIdentity,
  repositoryFullName: name,
  expiresAt: new Date(Date.parse(NOW) + ms).toISOString(),
});

test('overview requests its read-only endpoints and renders counts and lists', async ({
  page,
  harness,
  base,
}) => {
  harness.setHandler(defaultOverviewHandler);
  await page.goto(`${base}/`);
  await page.waitForSelector('[data-testid="stats"]');
  const requested = harness.state.requests.slice();
  expect(requested).toContain('/api/dashboard');
  expect(requested).not.toContain('/api/jobs?view=current');
  expect(requested).not.toContain('/api/jobs?view=cleanup');
  expect(await page.locator('[data-testid="stat"] strong').first().textContent()).toBe('2');
  const text = await page.locator('#content').textContent();
  expect(text).toContain('Anonymous review');
  expect(text).not.toContain('Cleanup needs attention');
});

test('overview links truncated current work to a status-filtered history view', async ({
  page,
  harness,
  base,
}) => {
  const current25 = Array.from({ length: 25 }, (_, index) => task({ runId: `cur-${index}` }));
  harness.setHandler((url) => {
    if (url.pathname === '/api/dashboard') {
      return ok({
        ...overviewData({ queued: 25, claimed: 0, publishedLast24h: 0, failedLast24h: 0 }, 2),
        ...historyPage(current25, 'CUR-CURSOR'),
      });
    }
    return ok(historyPage(current25, 'CUR-CURSOR'));
  });
  await page.goto(`${base}/`);
  await page.waitForSelector('[data-testid="view-all-current"]');
  await page.click('[data-testid="view-all-current"]');
  await page.waitForFunction(() => location.pathname === '/history' && location.search === '');
  await page.waitForSelector('[data-testid="next-page"]');
  expect(harness.state.requests[harness.state.requests.length - 1]).toBe('/api/jobs');
});

test('a same-day date filter includes the whole UTC day', async ({ page, harness, base }) => {
  harness.setHandler(() => ok(historyPage([task({ runId: 'h-1' })])));
  await page.goto(`${base}/history?from=2026-10-16&to=2026-10-16`);
  await page.waitForSelector('[data-testid="task"]');
  expect(await page.locator('input[name="from"]').inputValue()).toBe('2026-10-16');
  expect(await page.locator('input[name="to"]').inputValue()).toBe('2026-10-16');
  const requested = new URL(`${base}${harness.state.requests[harness.state.requests.length - 1]}`);
  expect(requested.searchParams.get('from')).toBe('2026-10-16T00:00:00.000Z');
  expect(requested.searchParams.get('to')).toBe('2026-10-16T23:59:59.999Z');
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
  expect(requested.searchParams.get('from')).toBe('2026-10-16T00:00:00.000Z');
  expect(requested.searchParams.get('to')).toBe('2026-10-16T23:59:59.999Z');
  expect(await page.locator('input[name="from"]').inputValue()).toBe('2026-10-16');
});

test('history applies filters, resets the cursor and drops malformed values', async ({
  page,
  harness,
  base,
}) => {
  harness.setHandler(() => ok(historyPage([task({ runId: 'h-1' })], 'CURSOR-1')));
  await page.goto(`${base}/history?status=nonsense&cursor=CURSOR-1`);
  await page.waitForSelector('[data-testid="task"]');
  expect(await page.evaluate(() => location.search)).not.toContain('nonsense');
  const initial = harness.state.requests[harness.state.requests.length - 1];
  expect(initial).not.toContain('status=nonsense');
  expect(await page.locator('select[name="status"]').inputValue()).toBe('all');
  await page.selectOption('select[name="status"]', 'failed');
  await page.click('[data-testid="apply"]');
  await page.waitForFunction(() => location.search.includes('status=failed'));
  await harness.waitFor(() =>
    harness.state.requests.some((request) => request.includes('status=failed')),
  );
  expect(harness.state.requests[harness.state.requests.length - 1]).toBe('/api/jobs?status=failed');
});

test('a refresh error clears identity and keeps operational context as stale', async ({
  page,
  harness,
  base,
}) => {
  harness.setHandler(publicIdentityOverviewHandler);
  await page.goto(`${base}/`);
  await page.waitForSelector('[data-testid="stats"]');
  expect(await page.locator('#content').textContent()).toContain('acme/widgets');
  harness.setHandler(() => ({ status: 503 }));
  await page.click('[data-testid="refresh"]');
  await page.waitForSelector('[data-testid="error-notice"]');
  const text = await page.locator('#content').textContent();
  expect(text).not.toContain('acme/widgets');
  expect(text).toContain('Anonymous review');
  expect(await page.locator('[data-testid="stat"] strong').first().textContent()).toBe('2');
});

test('a malformed 200 keeps the last-good timestamp and applies backoff', async ({
  page,
  harness,
  base,
}) => {
  harness.setHandler(defaultOverviewHandler);
  await page.clock.install();
  await page.goto(`${base}/`);
  await page.waitForSelector('[data-testid="stats"]');
  const before = await page.locator('[data-testid="last-refresh"]').textContent();
  harness.setHandler(() => ok({ generatedAt: NOW }));
  await page.click('[data-testid="refresh"]');
  await page.waitForSelector('[data-testid="error-notice"]');
  expect(await page.locator('[data-testid="last-refresh"]').textContent()).toBe(before);
  expect(await page.locator('[data-testid="stat"] strong').first().textContent()).toBe('2');
  const count = harness.state.requests.length;
  await page.clock.fastForward(20000);
  expect(harness.state.requests.length).toBe(count);
});

test('a failed refresh backs off before the next attempt', async ({ page, harness, base }) => {
  harness.setHandler(() => ({ status: 503 }));
  await page.clock.install();
  await page.goto(`${base}/`);
  await page.getByRole('button', { name: 'Retry' }).waitFor();
  const count = harness.state.requests.length;
  await page.clock.fastForward(20000);
  expect(harness.state.requests.length).toBe(count);
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
  await page.getByRole('button', { name: 'Retry' }).waitFor();
  const count = harness.state.requests.length;
  await page.clock.fastForward(35000);
  expect(harness.state.requests.length).toBe(count);
  await page.clock.fastForward(30000);
  await harness.waitFor(() => harness.state.requests.length > count, 4000);
});

test('consecutive failures keep backing off beyond 30 seconds', async ({ page, harness, base }) => {
  harness.setHandler(() => ({ status: 503 }));
  await page.clock.install({ time: new Date(NOW) });
  // Only explicit advances count toward the backoff, not host/CI scheduling time.
  await page.clock.pauseAt(new Date(Date.parse(NOW) + 1000));
  await page.goto(`${base}/`);
  await page.getByRole('button', { name: 'Retry' }).waitFor();
  const initialRequests = harness.state.requests.length;
  const initialSettled = harness.state.settled;

  // Jitter only lengthens the 30s base delay, so no retry can arrive by 25s.
  await page.clock.runFor(25000);
  expect(harness.state.requests.length).toBe(initialRequests);

  // Advance in bounded steps until the first retry's responses complete.
  let firstRetry = false;
  for (let step = 0; step < 10 && !firstRetry; step += 1) {
    await page.clock.runFor(1000);
    firstRetry = harness.state.settled > initialSettled;
  }
  expect(firstRetry).toBe(true);
  const afterFirstRetry = harness.state.requests.length;
  const afterFirstRetrySettled = harness.state.settled;
  expect(afterFirstRetry).toBeGreaterThan(initialRequests);

  // The second backoff starts at 60s; jitter only lengthens it, so no request
  // may arrive before 60s of virtual time have elapsed.
  for (let step = 0; step < 59; step += 1) {
    await page.clock.runFor(1000);
    expect(harness.state.requests.length).toBe(afterFirstRetry);
  }

  // The retry then arrives within the bounded 10% jitter window.
  let secondRetry = false;
  for (let step = 0; step < 15 && !secondRetry; step += 1) {
    await page.clock.runFor(1000);
    secondRetry = harness.state.settled > afterFirstRetrySettled;
  }
  expect(secondRetry).toBe(true);
});

test('a manual refresh is ignored while the tab is hidden', async ({ page, harness, base }) => {
  harness.setHandler(() => ok(historyPage([task({ runId: 'h-1' })])));
  await page.goto(`${base}/history`);
  await page.waitForSelector('[data-testid="task"]');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const before = harness.state.requests.length;
  await page.evaluate(() =>
    document.querySelector<HTMLElement>('[data-testid="refresh"]')?.click(),
  );
  await sleep(300);
  expect(harness.state.requests.length).toBe(before);
});

test('loading a route while the tab is hidden defers requests until visible', async ({
  page,
  harness,
  base,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  });
  harness.setHandler(() => ok(historyPage([task({ runId: 'h-1' })])));
  await page.goto(`${base}/history`);
  await sleep(500);
  expect(harness.state.requests).toEqual([]);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await harness.waitFor(() => harness.state.requests.length > 0);
  await page.waitForSelector('[data-testid="task"]');
});

test('returning to a visible tab before Retry-After does not request', async ({
  page,
  harness,
  base,
}) => {
  harness.setHandler(() => ({ status: 429, retryAfter: 60 }));
  await page.clock.install();
  await page.goto(`${base}/history`);
  await page.getByRole('button', { name: 'Retry' }).waitFor();
  const count = harness.state.requests.length;
  await setVisibility(page, 'hidden');
  await setVisibility(page, 'visible');
  await page.clock.runFor(1000);
  expect(harness.state.requests.length).toBe(count);
  await page.clock.fastForward(65000);
  await harness.waitFor(() => harness.state.requests.length > count, 4000);
});

test('returning to a visible tab after a terminal 404 does not request', async ({
  page,
  harness,
  base,
}) => {
  harness.setHandler(() => ({ status: 404 }));
  await page.goto(`${base}/jobs/missing-run`);
  await page.waitForSelector('text=Page not found');
  const count = harness.state.requests.length;
  await setVisibility(page, 'hidden');
  await setVisibility(page, 'visible');
  await page.waitForTimeout(400);
  expect(harness.state.requests.length).toBe(count);
});

test('reconnecting while hidden does not request until visible', async ({
  page,
  harness,
  base,
}) => {
  harness.setHandler(() => ok(historyPage([task({ runId: 'h-1' })])));
  await page.goto(`${base}/history`);
  await page.waitForSelector('[data-testid="task"]');
  await setVisibility(page, 'hidden');
  const count = harness.state.requests.length;
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    window.dispatchEvent(new Event('offline'));
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
    window.dispatchEvent(new Event('online'));
  });
  await page.waitForTimeout(400);
  expect(harness.state.requests.length).toBe(count);
  await setVisibility(page, 'visible');
  await harness.waitFor(() => harness.state.requests.length > count);
});

test('loading offline defers requests until reconnect', async ({ page, harness, base }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
  });
  harness.setHandler(() => ok(historyPage([task({ runId: 'h-1' })])));
  await page.goto(`${base}/history`);
  await page.waitForTimeout(500);
  expect(harness.state.requests).toEqual([]);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
    window.dispatchEvent(new Event('online'));
  });
  await harness.waitFor(() => harness.state.requests.length > 0);
  await page.waitForSelector('[data-testid="task"]');
});

test('going offline cancels the in-flight request', async ({ page, harness, base }) => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  harness.setHandler(() => ({
    promise: gate.then(() => ok(historyPage([task({ runId: 'x' })]))),
  }));
  await page.goto(`${base}/history`);
  await harness.waitFor(() => harness.state.active >= 1);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    window.dispatchEvent(new Event('offline'));
  });
  await harness.waitFor(() => harness.state.aborted >= 1, 4000);
  release();
});

test('navigation cancels the previous in-flight request', async ({ page, harness, base }) => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  harness.setHandler(() => ({
    promise: gate.then(() => ok(historyPage([task({ runId: 'x' })]))),
  }));
  await page.goto(`${base}/`);
  await harness.waitFor(() => harness.state.requests.length >= 1);
  await page.click('nav a[href="/history"]');
  await harness.waitFor(() => harness.state.aborted >= 1, 5000);
  expect(harness.state.active).toBeLessThanOrEqual(1);
  release();
});

test('a failed overview snapshot can be retried without overlapping refreshes', async ({
  page,
  harness,
  base,
}) => {
  harness.setHandler((url) => {
    if (url.pathname === '/api/dashboard') return { destroy: true };
    return { promise: new Promise<ApiPayload>(() => undefined) };
  });
  await page.goto(`${base}/`);
  await page.getByRole('button', { name: 'Retry' }).waitFor();
  await harness.waitFor(() => harness.state.aborted >= 1, 4000);
  const afterFailure = harness.state.requests.length;
  harness.setHandler(defaultOverviewHandler);
  await page.getByRole('button', { name: 'Retry' }).click();
  await page.waitForSelector('[data-testid="stats"]');
  expect(harness.state.requests.length).toBeGreaterThan(afterFailure);
  expect(harness.state.active).toBeLessThanOrEqual(1);
});

test('repeated manual refresh clicks stay single-flight', async ({ page, harness, base }) => {
  harness.setHandler(defaultOverviewHandler);
  await page.goto(`${base}/`);
  await page.waitForSelector('[data-testid="stats"]');
  const afterInitial = harness.state.requests.length;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  harness.setHandler(() => ({
    promise: gate.then(() =>
      ok(overviewData({ queued: 0, claimed: 0, publishedLast24h: 0, failedLast24h: 0 }, 0)),
    ),
  }));
  await page.click('[data-testid="refresh"]');
  await harness.waitFor(() => harness.state.requests.length >= afterInitial + 1);
  await page.click('[data-testid="refresh"]');
  await sleep(200);
  expect(harness.state.requests.length).toBe(afterInitial + 1);
  release();
});

test('a request beyond the 15s browser timeout surfaces an error', async ({
  page,
  harness,
  base,
}) => {
  harness.setHandler(() => ({ promise: new Promise<ApiPayload>(() => undefined) }));
  await page.clock.install();
  await page.goto(`${base}/`);
  await harness.waitFor(() => harness.state.requests.length >= 1, 4000);
  await page.clock.runFor(16000);
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible({ timeout: 4000 });
});

test('returning from a hidden tab refreshes immediately', async ({ page, harness, base }) => {
  harness.setHandler(() => ok(historyPage([task({ runId: 'h-1' })])));
  await page.goto(`${base}/history`);
  await page.waitForSelector('[data-testid="task"]');
  const before = harness.state.settled;
  harness.setHandler(() => ok(historyPage([task({ runId: 'h-1' }), task({ runId: 'h-2' })])));
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await harness.waitFor(() => harness.state.settled > before);
  await page.waitForSelector('[data-testid="task-link"][data-run-id="h-2"]');
});

test('window focus while the tab is visible refreshes immediately', async ({
  page,
  harness,
  base,
}) => {
  harness.setHandler(() => ok(historyPage([task({ runId: 'h-1' })])));
  await page.goto(`${base}/history`);
  await page.waitForSelector('[data-testid="task"]');
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  });
  const before = harness.state.settled;
  harness.setHandler(() => ok(historyPage([task({ runId: 'h-1' }), task({ runId: 'h-2' })])));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
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
  await reconnect(page);
  await harness.waitFor(() => harness.state.settled > before);
  await page.waitForSelector('[data-testid="task-link"][data-run-id="h-2"]');
  expect(await page.evaluate(() => document.activeElement?.getAttribute('name'))).toBe('status');
});

test('a data refresh preserves unapplied draft filter values', async ({ page, harness, base }) => {
  harness.setHandler(() => ok(historyPage([task({ runId: 'h-1' })])));
  await page.goto(`${base}/history`);
  await page.waitForSelector('select[name="status"]');
  await page.selectOption('select[name="status"]', 'failed');
  const before = harness.state.settled;
  harness.setHandler(() => ok(historyPage([task({ runId: 'h-1' }), task({ runId: 'h-2' })])));
  await reconnect(page);
  await harness.waitFor(() => harness.state.settled > before);
  await page.waitForSelector('[data-testid="task-link"][data-run-id="h-2"]');
  expect(await page.locator('select[name="status"]').inputValue()).toBe('failed');
  expect(await page.evaluate(() => location.search)).not.toContain('status=failed');
});

test('a data refresh keeps keyboard focus on the task link', async ({ page, harness, base }) => {
  harness.setHandler(() => ok(historyPage([task({ runId: 'h-1' })])));
  await page.goto(`${base}/history`);
  await page.waitForSelector('[data-testid="task-link"]');
  await page.focus('[data-testid="task-link"]');
  const before = harness.state.settled;
  harness.setHandler(() => ok(historyPage([task({ runId: 'h-1' }), task({ runId: 'h-2' })])));
  await reconnect(page);
  await harness.waitFor(() => harness.state.settled > before);
  await page.waitForSelector('[data-testid="task-link"][data-run-id="h-2"]');
  const href = await page.evaluate(() => document.activeElement?.getAttribute('href'));
  expect(href).toContain('/jobs/h-1');
});

test('a data refresh keeps the scroll position', async ({ page, harness, base }) => {
  const many: PublicTaskState[] = [];
  for (let index = 0; index < 40; index += 1) many.push(task({ runId: `h-${index}` }));
  harness.setHandler(() => ok(historyPage(many)));
  await page.goto(`${base}/history`);
  await page.waitForSelector('[data-testid="task"]');
  await page.evaluate(() => window.scrollTo(0, 600));
  const before = harness.state.settled;
  harness.setHandler(() => ok(historyPage([...many, task({ runId: 'h-40' })])));
  await reconnect(page);
  await harness.waitFor(() => harness.state.settled > before);
  await page.waitForSelector('[data-testid="task-link"][data-run-id="h-40"]');
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(300);
});

test('identity expires independently of network and navigation', async ({
  page,
  harness,
  base,
}) => {
  const expiring = expiringIdentity(400);
  harness.setHandler((url) => {
    if (url.pathname === '/api/dashboard') {
      return ok({
        ...overviewData({ queued: 1, claimed: 0, publishedLast24h: 0, failedLast24h: 0 }, 0),
        ...historyPage([task({ runId: 'r', identity: expiring })]),
      });
    }
    return ok(historyPage([]));
  });
  await page.clock.install();
  await page.goto(`${base}/`);
  await page.waitForSelector('[data-testid="task-link"]');
  expect(await page.locator('[data-testid="task-link"]').textContent()).toContain('acme/widgets');
  await page.clock.fastForward(2000);
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="task-link"]')?.textContent?.includes('Anonymous review'),
  );
});

test('each identity expires at its own deadline without a refresh', async ({
  page,
  harness,
  base,
}) => {
  const first = expiringIdentity(300, 'acme/one');
  const second = expiringIdentity(900, 'acme/two');
  harness.setHandler((url) => {
    if (url.pathname === '/api/dashboard') {
      return ok({
        ...overviewData({ queued: 2, claimed: 0, publishedLast24h: 0, failedLast24h: 0 }, 0),
        ...historyPage([
          task({ runId: 'one', identity: first }),
          task({ runId: 'two', identity: second }),
        ]),
      });
    }
    return ok(historyPage([]));
  });
  await page.clock.install();
  await page.goto(`${base}/`);
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="task-link"]').length === 2,
  );
  expect(await page.locator('#content').textContent()).toContain('acme/one');
  expect(await page.locator('#content').textContent()).toContain('acme/two');
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
  harness.setHandler((url) => {
    if (url.pathname === '/api/dashboard') {
      return ok({
        ...overviewData({ queued: 1, claimed: 0, publishedLast24h: 0, failedLast24h: 0 }, 0),
        ...historyPage([task({ runId: 'r', identity: { ...publicIdentity, expiresAt: NOW } })]),
      });
    }
    return ok(historyPage([]));
  });
  await page.goto(`${base}/`);
  await page.waitForSelector('[data-testid="task-link"]');
  const text = await page.locator('#content').textContent();
  expect(text).toContain('Anonymous review');
  expect(text).not.toContain('acme/widgets');
});

test('applying a filter cancels the previous in-flight refresh', async ({
  page,
  harness,
  base,
}) => {
  harness.setHandler(() => ok(historyPage([task({ runId: 'h-1' })])));
  await page.goto(`${base}/history`);
  await page.waitForSelector('[data-testid="task"]');
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
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
  expect(harness.state.requests).toContain('/api/jobs?status=failed');
  expect(await page.evaluate(() => location.search)).toContain('status=failed');
});

test('a valid identity expires while offline and does not return without a fresh response', async ({
  page,
  harness,
  base,
}) => {
  const expiring = expiringIdentity(400);
  harness.setHandler((url) => {
    if (url.pathname === '/api/dashboard') {
      return ok({
        ...overviewData({ queued: 1, claimed: 0, publishedLast24h: 0, failedLast24h: 0 }, 0),
        ...historyPage([task({ runId: 'r', identity: expiring })]),
      });
    }
    return ok(historyPage([]));
  });
  await page.goto(`${base}/`);
  await page.waitForSelector('[data-testid="task-link"]');
  expect(await page.locator('#content').textContent()).toContain('acme/widgets');
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    window.dispatchEvent(new Event('offline'));
  });
  await page.waitForFunction(
    () => (document.querySelector('#content')?.textContent || '').includes('Anonymous review'),
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
  expect(text).toContain('Anonymous review');
  expect(text).not.toContain('acme/widgets');
});

test('network delay is subtracted from the identity lifetime conservatively', async ({
  page,
  harness,
  base,
}) => {
  const lifetime = expiringIdentity(200);
  harness.setHandler((url) => {
    const delayed = sleep(300).then(() => {
      if (url.pathname === '/api/dashboard') {
        return ok({
          ...overviewData({ queued: 1, claimed: 0, publishedLast24h: 0, failedLast24h: 0 }, 0),
          ...historyPage([task({ runId: 'r', identity: lifetime })]),
        });
      }
      return ok(historyPage([]));
    });
    return { promise: delayed };
  });
  await page.goto(`${base}/`);
  await page.waitForSelector('[data-testid="task-link"]');
  expect(await page.locator('[data-testid="task-link"]').textContent()).toContain(
    'Anonymous review',
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
      return ok({
        ...overviewData({ queued: 1, claimed: 0, publishedLast24h: 0, failedLast24h: 0 }, 0),
        ...historyPage([
          task({
            runId: 'r',
            identity: {
              kind: 'public',
              repositoryFullName: '<img src=x onerror=alert(1)>',
              pullRequestNumber: 1,
              pullRequestUrl: 'https://github.com/x/y/pull/1',
              expiresAt: '2026-10-16T12:05:00.000Z',
              baseRef: null,
              headRef: null,
              baseSha: null,
              headSha: null,
            },
          }),
        ]),
      });
    }
    if (url.pathname.startsWith('/api/jobs/')) return ok(detailData(task({ runId: 'r' })));
    return ok(historyPage([]));
  });
  await page.goto(`${base}/`);
  await page.waitForSelector('[data-testid="task-link"]');
  expect(dialogShown).toBe(false);
  expect(await page.locator('#content img').count()).toBe(0);
  expect(await page.locator('#content').textContent()).toContain('<img src=x onerror=alert(1)>');
  await page.goto(`${base}/jobs/%22%3E%3Cscript%3Ealert(2)%3C%2Fscript%3E`);
  await page.waitForSelector('#content');
  expect(dialogShown).toBe(false);
  expect(await page.locator('#content script').count()).toBe(0);
});

test('browsing makes no requests to external hosts', async ({ page, harness, base }) => {
  const external: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).hostname !== '127.0.0.1') external.push(request.url());
  });
  harness.setHandler((url, request) =>
    url.pathname.startsWith('/api/jobs/')
      ? ok(detailData(task({ runId: 'run-9' })))
      : defaultOverviewHandler(url, request),
  );
  await page.goto(`${base}/`);
  await page.waitForSelector('[data-testid="stats"]');
  await page.goto(`${base}/history`);
  await page.waitForSelector('[data-testid="task"], .empty');
  await page.goto(`${base}/help`);
  await page.waitForSelector('#overview-counts');
  await page.goto(`${base}/jobs/run-9`);
  await page.waitForSelector('.detail');
  expect(external).toEqual([]);
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
          dispatch: null,
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
  expect(text).toContain('acme/widgets #7');
  expect(text).toContain('Fetching code');
  expect(text).toContain('Could not fetch the code');
  expect(await page.locator('.timeline li strong').first().textContent()).toBe('Reviewing');
  expect(await page.locator('.detail a[target="_blank"]').getAttribute('href')).toBe(
    'https://github.com/acme/widgets/pull/7',
  );
});

test('detail renders uncertain publication neutrally', async ({ page, harness, base }) => {
  harness.setHandler(() =>
    ok(
      detailData(
        task({
          runId: 'run-pu',
          status: 'failed',
          dispatch: null,
          failure: { phase: 'publication', reason: 'publication_uncertain' },
        }),
      ),
    ),
  );
  await page.goto(`${base}/jobs/run-pu`);
  await page.waitForSelector('.detail');
  const text = (await page.locator('#content').textContent()) ?? '';
  expect(text).toContain('Publication could not be confirmed');
  expect(text).not.toContain('Publication failed');
  expect(text.toLowerCase()).not.toContain('not published');
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
          dispatch: null,
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
  expect(labels).toEqual(['Fetching code', 'Result received', 'Publishing']);
  expect(
    await page
      .locator('.fact', { hasText: 'Cleanup attempt finished' })
      .locator('time')
      .getAttribute('datetime'),
  ).toBe('2026-10-16T20:00:00.000Z');
  const text = await page.locator('#content').textContent();
  expect(text).toContain('Cleanup failed');
  expect(text).not.toContain('Cleaned up');
  expect(text).toContain('Result checks started');
  expect(text).not.toContain('Submission finished reported');
});

test('detail shows cleanup state in technical details', async ({ page, harness, base }) => {
  const cases: Array<{ value: PublicTaskState; label: string }> = [
    {
      value: task({
        runId: 'r',
        dispatch: 'claimed',
        claimedAt: NOW,
        stage: 'agent',
        cleanup: 'pending',
      }),
      label: 'Cleanup after review',
    },
    {
      value: task({
        runId: 'r',
        dispatch: 'claimed',
        claimedAt: NOW,
        stage: 'cleanup',
        cleanup: 'pending',
      }),
      label: 'Cleaning up',
    },
    {
      value: task({
        runId: 'r',
        status: 'completed',
        dispatch: null,
        terminalAt: NOW,
        cleanup: 'pending',
      }),
      label: 'Cleanup pending',
    },
    {
      value: task({
        runId: 'r',
        status: 'completed',
        dispatch: null,
        terminalAt: NOW,
        cleanup: 'unknown',
      }),
      label: 'Cleanup not recorded',
    },
  ];
  for (const item of cases) {
    harness.setHandler((url, request) =>
      url.pathname.startsWith('/api/jobs/')
        ? ok(detailData(item.value, [], []))
        : defaultOverviewHandler(url, request),
    );
    await page.goto(`${base}/jobs/r`);
    await page.waitForSelector('.detail');
    await page.locator('.bx--accordion__heading').click();
    await page.waitForSelector('.cleanup-block');
    expect(await page.locator('.cleanup-block').textContent()).toContain(item.label);
  }
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
          dispatch: null,
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
  expect(labels).toEqual(['Result received', 'Publishing']);
});

test('a missing task renders a neutral 404', async ({ page, harness, base }) => {
  harness.setHandler(() => ({ status: 404 }));
  await page.goto(`${base}/jobs/missing-run`);
  await page.waitForSelector('text=Page not found');
  expect(await page.locator('#content').textContent()).not.toContain('temporarily unavailable');
});

test('a direct deep link returns to history deterministically', async ({ page, harness, base }) => {
  harness.setHandler((url) => {
    if (url.pathname.startsWith('/api/jobs/')) return ok(detailData(task({ runId: 'run-9' })));
    return ok(historyPage([task({ runId: 'h-1' })]));
  });
  await page.goto(`${base}/jobs/run-9`);
  await page.waitForSelector('.detail');
  expect(await page.locator('[data-back]').getAttribute('href')).toBe('/history');
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
    if (url.pathname.startsWith('/api/jobs/')) return ok(detailData(task({ runId: 'run-9' })));
    return ok(historyPage([task({ runId: 'h-1' })]));
  });
  await page.goto(`${base}/history?status=failed`);
  await page.waitForSelector('[data-testid="task-link"]');
  await page.click('[data-testid="task-link"]');
  await page.click('[data-testid="open-full-page"]');
  await page.waitForFunction(() => location.pathname.startsWith('/jobs/'));
  await page.waitForSelector('.detail');
  expect(await page.locator('[data-back]').getAttribute('href')).toBe('/history?status=failed');
  await page.click('[data-back]');
  await page.waitForFunction(
    () => location.pathname === '/history' && location.search.includes('status=failed'),
  );
  await page.waitForSelector('[data-testid="task-link"]');
  expect(harness.state.requests).toContain('/api/jobs?status=failed');
});
test('back from a task restores the history scroll position', async ({ page, harness, base }) => {
  const many: PublicTaskState[] = [];
  for (let index = 0; index < 80; index += 1) many.push(task({ runId: `h-${index}` }));
  harness.setHandler((url) => {
    if (url.pathname.startsWith('/api/jobs/')) return ok(detailData(task({ runId: 'run-9' })));
    return ok(historyPage(many));
  });
  await page.goto(`${base}/history`);
  await page.waitForSelector('[data-testid="task"]');
  const link = page.locator('[data-testid="task-link"][data-run-id="h-40"]');
  await link.scrollIntoViewIfNeeded();
  const captured = await page.evaluate(() => window.scrollY);
  expect(captured).toBeGreaterThan(0);
  await link.click();
  await page.click('[data-testid="open-full-page"]');
  await page.waitForFunction(() => location.pathname.startsWith('/jobs/'));
  await page.waitForSelector('.detail');
  await page.click('[data-back]');
  await page.waitForFunction(() => location.pathname === '/history');
  await page.waitForSelector('[data-testid="task"]');
  await page.waitForFunction((y) => Math.abs(window.scrollY - y) <= 80, captured, {
    timeout: 4000,
  });
});

test('resuming a detail page does not restore identity without a fresh public response', async ({
  page,
  harness,
  base,
}) => {
  harness.setHandler(() => ok(detailData(task({ runId: 'r', identity: publicIdentity }))));
  await page.goto(`${base}/jobs/r`);
  await page.waitForSelector('.detail');
  expect(await page.locator('#content').textContent()).toContain('acme/widgets');
  const before = harness.state.settled;
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  harness.setHandler(() => ({ status: 503 }));
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await harness.waitFor(() => harness.state.settled > before);
  await page.waitForSelector('.notice.error');
  const text = await page.locator('#content').textContent();
  expect(text).toContain('Anonymous review');
  expect(text).not.toContain('acme/widgets');
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
  expect(await page.locator('nav a[href="/help"]').getAttribute('aria-current')).toBe('page');
  await page.click('a[href="#technical-details"]');
  await page.waitForFunction(() => location.hash === '#technical-details');
  expect(await page.locator('#technical-details').isVisible()).toBe(true);
  await page.goto(`${base}/help`);
  await page.waitForSelector('#overview-counts');
  expect(await page.locator('nav a[href="/help"]').getAttribute('aria-current')).toBe('page');
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
  expect(overflow).toBeLessThanOrEqual(1);
  expect(await page.locator('nav a[href="/help"]').isVisible()).toBe(true);
  await page.click('nav a[href="/help"]');
  await page.waitForFunction(() => location.pathname === '/help');
});

test('primary navigation is operable by keyboard', async ({ page, harness, base }) => {
  harness.setHandler(defaultOverviewHandler);
  await page.goto(`${base}/`);
  await page.waitForSelector('[data-testid="stats"]');
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe(
    'skip-link',
  );
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('content');
  await page.locator('nav a[href="/history"]').focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => location.pathname === '/history');
  await page.waitForSelector('[data-testid="apply"]');
  await page.setViewportSize({ width: 360, height: 640 });
  for (const href of ['/', '/history', '/help']) {
    await expect(page.locator(`nav a[href="${href}"]`)).toBeInViewport({ ratio: 1 });
  }
});

test('footer links the deployed commit', async ({ page, harness, base }) => {
  harness.setHandler(defaultOverviewHandler);
  await page.goto(`${base}/`);
  await page.waitForSelector('[data-testid="stats"]');
  const link = page.locator('[data-testid="commit-link"]');
  await expect(link).toBeVisible();
  expect(await link.getAttribute('href')).toMatch(
    /^https:\/\/github\.com\/ariga39\/compte-rendu\/commit\/[0-9a-f]{40}$/,
  );
  expect((await link.textContent())?.trim().length).toBe(7);
});

test('top-banner refresh follows the current data page and hides on Help', async ({
  page,
  harness,
  base,
}) => {
  harness.setHandler((url, request) =>
    url.pathname.startsWith('/api/jobs/')
      ? ok(detailData(task({ runId: 'run-9' })))
      : url.pathname === '/api/jobs' && url.search === ''
        ? ok(historyPage([task({ runId: 'run-9' })]))
        : defaultOverviewHandler(url, request),
  );
  const bannerRefresh = page.locator('.header-refresh [data-testid="refresh"]');
  await page.goto(`${base}/`);
  await page.waitForSelector('[data-testid="stats"]');
  await expect(bannerRefresh).toBeVisible();
  const overviewRequests = harness.state.requests.length;
  await bannerRefresh.click();
  await harness.waitFor(() => harness.state.requests.length > overviewRequests);
  expect(harness.state.requests.slice(overviewRequests)).toContain('/api/dashboard');

  await page.click('nav a[href="/history"]');
  await page.waitForFunction(() => location.pathname === '/history');
  await page.waitForSelector('[data-testid="task"]');
  const historyRequests = harness.state.requests.length;
  await bannerRefresh.click();
  await harness.waitFor(() => harness.state.requests.length > historyRequests);
  expect(harness.state.requests.at(-1)).toBe('/api/jobs');

  await page.click('[data-testid="task-link"]');
  await page.waitForSelector('.detail');
  await expect(bannerRefresh).toBeVisible();
  const detailRequests = harness.state.requests.length;
  await bannerRefresh.focus();
  await page.keyboard.press('Enter');
  await harness.waitFor(() => harness.state.requests.length > detailRequests);
  expect(harness.state.requests.at(-1)).toBe('/api/jobs/run-9');
  await expect(bannerRefresh).toBeFocused();

  await page.click('nav a[href="/help"]');
  await page.waitForSelector('#overview-counts');
  await expect(page.locator('.header-refresh')).toHaveCount(0);

  await page.click('nav a[href="/"]');
  await page.waitForSelector('[data-testid="stats"]');
  await expect(bannerRefresh).toBeVisible();
});

test('history controls align and table rows are readable', async ({ page, harness, base }) => {
  harness.setHandler((url, request) =>
    url.pathname === '/api/jobs' && url.search === ''
      ? ok(
          historyPage([
            task({ runId: 'h-1', dispatch: 'claimed', claimedAt: NOW }),
            task({ runId: 'h-2', dispatch: 'claimed', claimedAt: NOW }),
          ]),
        )
      : defaultOverviewHandler(url, request),
  );
  await page.goto(`${base}/history`);
  await page.waitForSelector('[data-testid="apply"]');
  const apply = await page.locator('[data-testid="apply"]').boundingBox();
  const select = await page.locator('select[name="status"]').boundingBox();
  expect(apply).not.toBeNull();
  expect(select).not.toBeNull();
  expect(Math.abs((apply?.height ?? 0) - (select?.height ?? 0))).toBeLessThanOrEqual(2);
  expect(apply?.height ?? 0).toBeGreaterThanOrEqual(38);
  const rows = page.locator('[data-testid="task"]');
  const first = await rows.nth(0).boundingBox();
  const second = await rows.nth(1).boundingBox();
  expect(first?.height ?? 0).toBeGreaterThanOrEqual(60);
  expect(second?.y ?? 0).toBeGreaterThanOrEqual((first?.y ?? 0) + (first?.height ?? 0));
});

test('result processing takes precedence over the last execution stage', async ({
  page,
  harness,
  base,
}) => {
  harness.setHandler((url, request) =>
    url.pathname === '/api/jobs' && url.search === ''
      ? ok(
          historyPage([
            task({
              runId: 'h-1',
              dispatch: 'claimed',
              claimedAt: NOW,
              stage: 'cleanup',
              processing: 'publishing',
              cleanup: 'pending',
            }),
          ]),
        )
      : defaultOverviewHandler(url, request),
  );
  await page.goto(`${base}/history`);
  await page.waitForSelector('[data-testid="task"]');
  const status = await page
    .locator('[data-testid="task"]')
    .first()
    .locator('td')
    .nth(1)
    .textContent();
  expect(status).toContain('Publishing');
  expect(status).not.toContain('Finishing up');
});

test('history keeps a readable review column on narrow screens', async ({
  page,
  harness,
  base,
}) => {
  harness.setHandler((url, request) =>
    url.pathname === '/api/jobs' && url.search === ''
      ? ok(
          historyPage([
            task({
              runId: 'h-1',
              dispatch: 'claimed',
              claimedAt: NOW,
              identity: {
                kind: 'public',
                repositoryFullName: 'example/very-long-repository-name-here',
                pullRequestNumber: 12345,
                pullRequestUrl:
                  'https://github.com/example/very-long-repository-name-here/pull/12345',
                expiresAt: '2026-10-16T12:05:00.000Z',
                baseRef: 'main',
                headRef: 'a-very-long-feature-branch-name-here',
                baseSha: '1'.repeat(40),
                headSha: '2'.repeat(40),
              },
            }),
          ]),
        )
      : defaultOverviewHandler(url, request),
  );
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto(`${base}/history`);
  await page.waitForSelector('[data-testid="task"]');
  const cell = page.locator('[data-testid="task"]').first().locator('td').first();
  const cellBox = await cell.boundingBox();
  expect(cellBox?.width ?? 0).toBeGreaterThanOrEqual(200);
  const titleBox = await page.locator('[data-testid="task-link"]').boundingBox();
  expect(titleBox?.width ?? 0).toBeGreaterThanOrEqual(120);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test('history renders a semantic table with named columns', async ({ page, harness, base }) => {
  await page.clock.install({ time: new Date(NOW) });
  harness.setHandler((url, request) =>
    url.pathname === '/api/jobs' && url.search === ''
      ? ok(
          historyPage([
            task({
              runId: 'h-1',
              identity: {
                ...publicIdentity,
                repositoryFullName: `acme/${'repository'.repeat(10)}`,
              },
            }),
          ]),
        )
      : defaultOverviewHandler(url, request),
  );
  await page.goto(`${base}/history`);
  await page.waitForSelector('[data-testid="task"]');
  await expect(page.locator('table')).toHaveCount(1);
  expect(await page.locator('thead th').allTextContents()).toEqual([
    'Review',
    'Status',
    'Decision',
    'Received',
    'Pull request',
  ]);
  await expect(page.locator('[data-testid="task"]').first().locator('td')).toHaveCount(5);
  for (const header of await page.getByRole('columnheader').all()) {
    await expect(header).toBeInViewport({ ratio: 1 });
  }
});

test('dashboard uses the IBM Plex Mono family across text and controls', async ({
  page,
  harness,
  base,
}) => {
  const fontHandler: ApiHandler = (url, request) =>
    url.pathname.startsWith('/api/jobs/')
      ? ok(detailData(task({ runId: 'run-9' })))
      : defaultOverviewHandler(url, request);
  harness.setHandler(fontHandler);
  const fontState = () =>
    page.evaluate(async () => {
      const faces = await document.fonts.load('16px "IBM Plex Mono"', 'Ag');
      const firstFamily = (el: Element | null) => {
        if (!el) return null;
        const raw = getComputedStyle(el).fontFamily;
        return raw
          .split(',')[0]
          .trim()
          .replace(/^["']|["']$/g, '');
      };
      const code = document.querySelector('code, pre');
      return {
        loaded: faces.length > 0 && faces.every((face) => face.status === 'loaded'),
        body: firstFamily(document.body),
        h1: firstFamily(document.querySelector('h1')),
        button: firstFamily(document.querySelector('button')),
        select: firstFamily(document.querySelector('select')),
        dateInput: firstFamily(document.querySelector('input[name="from"]')),
        code: firstFamily(code),
        strong: firstFamily(document.querySelector('strong')),
      };
    });

  await page.goto(`${base}/`);
  await page.waitForSelector('[data-testid="stats"]');
  const overview = await fontState();
  expect(overview.loaded).toBe(true);
  expect(overview.body).toBe('IBM Plex Mono');
  expect(overview.h1).toBe('IBM Plex Mono');
  expect(overview.button).toBe('IBM Plex Mono');

  await page.goto(`${base}/history`);
  await page.waitForSelector('[data-testid="apply"]');
  const history = await fontState();
  expect(history.select).toBe('IBM Plex Mono');
  expect(history.dateInput).toBe('IBM Plex Mono');
  expect(history.button).toBe('IBM Plex Mono');

  await page.goto(`${base}/help`);
  await page.waitForSelector('#overview-counts');
  const help = await fontState();
  expect(help.h1).toBe('IBM Plex Mono');
  expect(help.strong).toBe('IBM Plex Mono');
  if (help.code) expect(help.code).toBe('IBM Plex Mono');

  await page.goto(`${base}/jobs/run-9`);
  await page.waitForSelector('.detail');
  const detail = await fontState();
  expect(detail.h1).toBe('IBM Plex Mono');
});
