import type { PublicHistoryPage, PublicTaskDetail, PublicTaskState } from '@compte-rendu/contracts';
import { expect, test, type ApiHandler, type ApiPayload } from './fixtures';

const NOW = '2026-10-16T12:00:00.000Z';
const SHA = (c: string) => c.repeat(40);
const ok = (json: unknown): ApiPayload => ({ status: 200, json });

const historyPage = (
  tasks: PublicTaskState[],
  nextCursor: string | null = null,
): PublicHistoryPage => ({ generatedAt: NOW, tasks, nextCursor });

const detailData = (single: PublicTaskState): PublicTaskDetail => ({
  generatedAt: NOW,
  task: single,
  milestones: [],
  processingMilestones: [],
});

const publicTask = (
  runId: string,
  overrides: Partial<Extract<PublicTaskState['identity'], { kind: 'public' }>> = {},
): PublicTaskState => ({
  runId,
  status: 'completed',
  dispatch: null,
  stage: null,
  processing: null,
  decision: null,
  identity: {
    kind: 'public',
    repositoryFullName: 'acme/widgets',
    pullRequestNumber: 7,
    pullRequestUrl: 'https://github.com/acme/widgets/pull/7',
    expiresAt: '2999-01-01T00:00:00.000Z',
    baseRef: 'main',
    headRef: 'feature/drawer',
    baseSha: SHA('1'),
    headSha: SHA('2'),
    ...overrides,
  },
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
  cleanup: 'destroyed',
  failure: null,
});

const listAndDetails =
  (tasks: PublicTaskState[]): ApiHandler =>
  (url) => {
    if (url.pathname.startsWith('/api/jobs/')) {
      const runId = url.pathname.slice('/api/jobs/'.length);
      const task = tasks.find((entry) => entry.runId === runId);
      return task === undefined ? { status: 404 } : ok(detailData(task));
    }
    return ok(historyPage(tasks));
  };

test('table shows the source to target branches and the reviewed head SHA', async ({
  page,
  harness,
  base,
}) => {
  const branches = publicTask('with-branches');
  const legacy = publicTask('legacy', { baseRef: null, headRef: null });
  harness.setHandler(listAndDetails([branches, legacy]));
  await page.goto(`${base}/history`);
  await page.waitForSelector('[data-testid="task"]');

  const branchLine = page.locator(
    '[data-testid="task"][data-run-id="with-branches"] [data-testid="task-branches"]',
  );
  await expect(branchLine).toBeVisible();
  const branchText = (await branchLine.textContent())?.replace(/\s+/g, ' ').trim();
  expect(branchText).toContain('feature/drawer');
  expect(branchText).toContain('main');
  expect(branchText).toContain('→');
  expect(branchText).toContain('2222222');

  const legacyLine = page.locator(
    '[data-testid="task"][data-run-id="legacy"] [data-testid="task-branches"]',
  );
  await expect(legacyLine).toBeVisible();
  const legacyText = (await legacyLine.textContent())?.replace(/\s+/g, ' ').trim();
  expect(legacyText).toContain('2222222');
  expect(legacyText).not.toContain('→');
});

test('opens a nonmodal drawer that keeps the list usable and follows selection', async ({
  page,
  harness,
  base,
}) => {
  const first = publicTask('h-1', { headRef: 'feature/one' });
  const second = publicTask('h-2', { headRef: 'feature/two' });
  harness.setHandler(listAndDetails([first, second]));
  await page.goto(`${base}/history`);
  await page.waitForSelector('[data-testid="task"]');

  await page.click('[data-testid="task-link"][data-run-id="h-1"]');
  const drawer = page.locator('[data-testid="detail-drawer"]');
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText('feature/one');
  expect(await drawer.getAttribute('role')).toBe('region');
  expect(await drawer.getAttribute('aria-label')).toBeTruthy();
  await expect(page.locator('table')).toBeVisible();
  await expect(page.locator('[data-testid="task"]').first()).toBeVisible();
  await expect(page.locator('[data-testid="drawer-refresh"]')).toBeHidden();
  const detailText = await drawer.textContent();
  expect(detailText).toContain('Source branch');
  expect(detailText).toContain('Target branch');
  expect(detailText).toContain('Reviewed commit');
  expect(detailText).toContain('Base commit');
  expect(detailText).toContain('feature/one');

  await page.click('[data-testid="task-link"][data-run-id="h-2"]');
  await expect(drawer).toContainText('feature/two');
  expect(new URL(page.url()).pathname).toBe('/history');
  await expect(page.locator('[data-testid="task"][data-run-id="h-2"]')).toBeVisible();

  await page.click('[data-testid="detail-close"]');
  await expect(drawer).toHaveCount(0);
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-run-id') === 'h-2');
});

test('back closes and forward reopens the last selected task', async ({ page, harness, base }) => {
  const first = publicTask('h-1', { headRef: 'feature/one' });
  const second = publicTask('h-2', { headRef: 'feature/two' });
  harness.setHandler(listAndDetails([first, second]));
  await page.goto(`${base}/history`);
  await page.waitForSelector('[data-testid="task"]');

  await page.click('[data-testid="task-link"][data-run-id="h-1"]');
  await expect(page.locator('[data-testid="detail-drawer"]')).toBeVisible();
  await page.click('[data-testid="task-link"][data-run-id="h-2"]');
  await expect(page.locator('[data-testid="detail-drawer"]')).toContainText('feature/two');

  await page.goBack();
  await expect(page.locator('[data-testid="detail-drawer"]')).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe('/history');
  await expect(page.locator('[data-testid="task-link"][data-run-id="h-1"]')).toBeVisible();

  await page.goForward();
  await expect(page.locator('[data-testid="detail-drawer"]')).toContainText('feature/two');
  await page.click('[data-testid="detail-close"]');
  await expect(page.locator('[data-testid="detail-drawer"]')).toHaveCount(0);
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-run-id') === 'h-2');
});

test('focus moves into the full-screen dialog when the viewport narrows', async ({
  page,
  harness,
  base,
}) => {
  harness.setHandler(listAndDetails([publicTask('h-1'), publicTask('h-2')]));
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`${base}/history`);
  await page.waitForSelector('[data-testid="task"]');
  await page.click('[data-testid="task-link"][data-run-id="h-1"]');
  const drawer = page.locator('[data-testid="detail-drawer"]');
  await expect(drawer).toBeVisible();
  expect(await drawer.getAttribute('role')).toBe('region');

  await page.locator('[data-testid="task-link"][data-run-id="h-2"]').focus();
  await page.setViewportSize({ width: 360, height: 640 });
  await expect(drawer).toHaveAttribute('role', 'dialog');
  await page.waitForFunction(() => {
    const panel = document.querySelector('[data-testid="detail-drawer"]');
    return (
      panel !== null && document.activeElement !== null && panel.contains(document.activeElement)
    );
  });
  await page.keyboard.press('Tab');
  await page.waitForFunction(() => {
    const panel = document.querySelector('[data-testid="detail-drawer"]');
    return (
      panel !== null && document.activeElement !== null && panel.contains(document.activeElement)
    );
  });
});

test('Escape closes the drawer and restores focus to the selected row', async ({
  page,
  harness,
  base,
}) => {
  harness.setHandler(listAndDetails([publicTask('h-1', { headRef: 'feature/one' })]));
  await page.goto(`${base}/history`);
  await page.waitForSelector('[data-testid="task"]');
  await page.click('[data-testid="task-link"][data-run-id="h-1"]');
  await expect(page.locator('[data-testid="detail-drawer"]')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid="detail-drawer"]')).toHaveCount(0);
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-run-id') === 'h-1');
});

test('closing the drawer on the current list focuses the page heading when the row disappears', async ({
  page,
  harness,
  base,
}) => {
  const first: PublicTaskState = {
    ...publicTask('h-1', { headRef: 'feature/one' }),
    status: 'scheduled',
    dispatch: 'claimed',
    claimedAt: NOW,
    cleanup: 'unknown',
  };
  const second: PublicTaskState = {
    ...publicTask('h-2', { headRef: 'feature/two' }),
    status: 'scheduled',
    dispatch: 'claimed',
    claimedAt: NOW,
    cleanup: 'unknown',
  };
  const overview = (tasks: PublicTaskState[]): ApiPayload =>
    ok({
      generatedAt: NOW,
      counts: { queued: 0, claimed: tasks.length, publishedLast24h: 0, failedLast24h: 0 },
      cleanupAttention: 0,
      tasks,
      nextCursor: null,
    });
  const current =
    (tasks: PublicTaskState[]): ApiHandler =>
    (url) => {
      if (url.pathname === '/api/dashboard') return overview(tasks);
      if (url.pathname === '/api/jobs') return ok(historyPage(tasks));
      if (url.pathname.startsWith('/api/jobs/')) {
        const runId = url.pathname.slice('/api/jobs/'.length);
        const task = [first, second].find((entry) => entry.runId === runId);
        return task === undefined ? { status: 404 } : ok(detailData(task));
      }
      return { status: 404 };
    };
  harness.setHandler(current([first, second]));
  await page.goto(`${base}/`);
  await page.waitForSelector('[data-testid="task"]');
  await page.click('[data-testid="task-link"][data-run-id="h-1"]');
  const drawer = page.locator('[data-testid="detail-drawer"]');
  await expect(drawer).toContainText('feature/one');

  harness.setHandler(current([second]));
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    window.dispatchEvent(new Event('focus'));
  });
  await expect(page.locator('[data-testid="task-link"][data-run-id="h-1"]')).toHaveCount(0);
  await expect(drawer).toBeVisible();

  await page.click('[data-testid="detail-close"]');
  await expect(drawer).toHaveCount(0);
  await page.waitForFunction(
    () => document.activeElement?.getAttribute('data-testid') === 'list-heading',
  );
  expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe('Overview');
});

test('going back focuses the list heading when the selected row disappears', async ({
  page,
  harness,
  base,
}) => {
  const first = publicTask('h-1', { headRef: 'feature/one' });
  const second = publicTask('h-2', { headRef: 'feature/two' });
  harness.setHandler(listAndDetails([first, second]));
  await page.goto(`${base}/history`);
  await page.waitForSelector('[data-testid="task"]');
  await page.click('[data-testid="task-link"][data-run-id="h-1"]');
  const drawer = page.locator('[data-testid="detail-drawer"]');
  await expect(drawer).toContainText('feature/one');

  harness.setHandler((url) => {
    if (url.pathname.startsWith('/api/jobs/')) {
      const runId = url.pathname.slice('/api/jobs/'.length);
      const task = [first, second].find((entry) => entry.runId === runId);
      return task === undefined ? { status: 404 } : ok(detailData(task));
    }
    return ok(historyPage([second]));
  });
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    window.dispatchEvent(new Event('focus'));
  });
  await expect(page.locator('[data-testid="task-link"][data-run-id="h-1"]')).toHaveCount(0);
  await expect(drawer).toBeVisible();

  await page.goBack();
  await expect(drawer).toHaveCount(0);
  await page.waitForFunction(
    () => document.activeElement?.getAttribute('data-testid') === 'list-heading',
  );
  expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe(
    'Review history',
  );
});

test('narrow viewport shows a full-screen dialog with previous and next', async ({
  page,
  harness,
  base,
}) => {
  const first = publicTask('h-1', { headRef: 'feature/one' });
  const second = publicTask('h-2', { headRef: 'feature/two' });
  harness.setHandler(listAndDetails([first, second]));
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto(`${base}/history`);
  await page.waitForSelector('[data-testid="task"]');
  await page.click('[data-testid="task-link"][data-run-id="h-1"]');

  const drawer = page.locator('[data-testid="detail-drawer"]');
  await expect(drawer).toBeVisible();
  expect(await drawer.getAttribute('role')).toBe('dialog');
  expect(await drawer.getAttribute('aria-modal')).toBe('true');
  const box = await drawer.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(359);
  await expect(drawer.getByTestId('drawer-refresh')).toBeVisible();

  const next = page.locator('[data-testid="detail-next"]');
  await expect(next).toBeVisible();
  await next.click();
  await expect(drawer).toContainText('feature/two');
  await page.click('[data-testid="detail-prev"]');
  await expect(drawer).toContainText('feature/one');
});

test('narrow drawer fills the viewport without document overflow', async ({
  page,
  harness,
  base,
}) => {
  harness.setHandler(listAndDetails([publicTask('h-1'), publicTask('h-2')]));
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto(`${base}/history`);
  await page.waitForSelector('[data-testid="task"]');
  await page.click('[data-testid="task-link"][data-run-id="h-1"]');
  const drawer = page.locator('[data-testid="detail-drawer"]');
  await expect(drawer).toBeVisible();
  const box = await drawer.boundingBox();
  expect(box?.x ?? -1).toBeLessThanOrEqual(1);
  expect(box?.y ?? -1).toBeLessThanOrEqual(1);
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(999);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(699);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test('header refresh targets the open drawer and returns to the list after close', async ({
  page,
  harness,
  base,
}) => {
  harness.setHandler(listAndDetails([publicTask('h-1'), publicTask('h-2')]));
  await page.goto(`${base}/history`);
  await page.waitForSelector('[data-testid="task"]');
  await page.click('[data-testid="task-link"][data-run-id="h-1"]');
  await expect(page.locator('[data-testid="detail-drawer"]')).toBeVisible();

  const refresh = page.locator('.header-refresh [data-testid="refresh"]');
  await expect(refresh).toBeVisible();
  let before = harness.state.requests.length;
  await refresh.click();
  await harness.waitFor(() => harness.state.requests.length > before);
  expect(harness.state.requests.at(-1)).toBe('/api/jobs/h-1');

  await page.click('[data-testid="detail-close"]');
  await expect(page.locator('[data-testid="detail-drawer"]')).toHaveCount(0);
  before = harness.state.requests.length;
  await refresh.click();
  await harness.waitFor(() => harness.state.requests.length > before);
  expect(harness.state.requests.at(-1)).toBe('/api/jobs');
});

test('a missing task in the drawer is neutral and never shows the previous task', async ({
  page,
  harness,
  base,
}) => {
  harness.setHandler((url) => {
    if (url.pathname === '/api/jobs/h-1') return ok(detailData(publicTask('h-1')));
    if (url.pathname.startsWith('/api/jobs/')) return { status: 404 };
    return ok(historyPage([publicTask('h-1'), publicTask('h-2')]));
  });
  await page.goto(`${base}/history`);
  await page.waitForSelector('[data-testid="task"]');
  await page.click('[data-testid="task-link"][data-run-id="h-1"]');
  const drawer = page.locator('[data-testid="detail-drawer"]');
  await expect(drawer).toContainText('feature/drawer');

  await page.click('[data-testid="task-link"][data-run-id="h-2"]');
  await expect(drawer).toContainText('not identify');
  expect(await drawer.textContent()).not.toContain('feature/drawer');
});

test('list navigation keeps filters, scroll and focus across open, switch, close and back', async ({
  page,
  harness,
  base,
}) => {
  const many = Array.from({ length: 80 }, (_, index) =>
    publicTask(`h-${index}`, { headRef: `feature/${index}` }),
  );
  harness.setHandler((url) => {
    if (url.pathname.startsWith('/api/jobs/')) {
      const runId = url.pathname.slice('/api/jobs/'.length);
      const task = many.find((entry) => entry.runId === runId);
      return task === undefined ? { status: 404 } : ok(detailData(task));
    }
    return ok(historyPage(many));
  });
  await page.goto(`${base}/history?status=failed&from=2026-01-01&cursor=CUR1`);
  await page.waitForSelector('[data-testid="task"]');
  const drawer = page.locator('[data-testid="detail-drawer"]');

  const row40 = page.locator('[data-testid="task-link"][data-run-id="h-40"]');
  await row40.scrollIntoViewIfNeeded();
  const captured = await page.evaluate(() => window.scrollY);
  expect(captured).toBeGreaterThan(0);
  await row40.click();
  await expect(drawer).toContainText('feature/40');
  await page.locator('[data-testid="task-link"][data-run-id="h-41"]').click();
  await expect(drawer).toContainText('feature/41');

  await page.click('[data-testid="detail-close"]');
  await expect(drawer).toHaveCount(0);
  const url = new URL(page.url());
  expect(url.pathname).toBe('/history');
  expect(url.searchParams.get('status')).toBe('failed');
  expect(url.searchParams.get('from')?.startsWith('2026-01-01')).toBe(true);
  expect(url.searchParams.get('cursor')).toBe('CUR1');
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-run-id') === 'h-41');
  await page.waitForFunction((y) => Math.abs(window.scrollY - y) <= 80, captured, {
    timeout: 4000,
  });

  const row50 = page.locator('[data-testid="task-link"][data-run-id="h-50"]');
  await row50.scrollIntoViewIfNeeded();
  const capturedBack = await page.evaluate(() => window.scrollY);
  await row50.click();
  await expect(drawer).toContainText('feature/50');
  await page.locator('[data-testid="task-link"][data-run-id="h-51"]').click();
  await expect(drawer).toContainText('feature/51');
  await page.goBack();
  await expect(drawer).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get('cursor')).toBe('CUR1');
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-run-id') === 'h-51');
  await page.waitForFunction((y) => Math.abs(window.scrollY - y) <= 80, capturedBack, {
    timeout: 4000,
  });
});
