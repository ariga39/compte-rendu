import type {
  PublicHistoryPage,
  PublicOverview,
  PublicTaskDetail,
  PublicTaskState,
} from '@compte-rendu/contracts';
import type { Page } from '@playwright/test';
import { expect, test, type ApiPayload } from './fixtures';

const NOW = '2026-10-16T12:00:00.000Z';
const ok = (json: unknown): ApiPayload => ({ status: 200, json });

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

const historyPage = (tasks: PublicTaskState[] = []): PublicHistoryPage => ({
  generatedAt: NOW,
  tasks,
  nextCursor: null,
});

const overview = (): PublicOverview & PublicHistoryPage => ({
  ...historyPage(),
  counts: { queued: 0, claimed: 0, publishedLast24h: 0, failedLast24h: 0, cancelledLast24h: 0 },
  cleanupAttention: 0,
});

const detailData = (single: PublicTaskState): PublicTaskDetail => ({
  generatedAt: NOW,
  task: single,
  milestones: [],
  processingMilestones: [],
});

const signedIn = (login: string, operator: boolean): ApiPayload => ({
  status: 200,
  json: { signedIn: true, account: { login }, operator },
});

test('anonymous header offers sign-in on every public page', async ({ page, harness, base }) => {
  harness.setHandler((url) => {
    if (url.pathname === '/api/dashboard') return ok(overview());
    if (url.pathname.startsWith('/api/jobs/')) return ok(detailData(task({ runId: 'run-1' })));
    if (url.pathname === '/api/model-settings') return { status: 401 };
    return ok(historyPage());
  });

  for (const path of ['/', '/history', '/help', '/jobs/run-1', '/settings']) {
    await page.goto(base + path);
    await expect(page.getByTestId('sign-in')).toHaveText('Sign in with GitHub');
    await expect(page.getByTestId('viewer-login')).toHaveCount(0);
    await expect(page.getByTestId('sign-out')).toHaveCount(0);
  }
  await harness.waitFor(() => harness.state.sessionRequests > 0);
});

test('signed-in header shows the account and sign-out while Settings still rechecks authorization', async ({
  page,
  harness,
  base,
}) => {
  harness.setSession(signedIn('octocat', true));
  harness.setHandler((url) => {
    if (url.pathname !== '/api/model-settings') return { status: 404 };
    return ok({
      routes: ['review/a'],
      configuration: { revision: 0, selection: null },
      catalogRefreshFailed: false,
      lastAttemptAt: null,
    });
  });
  await page.goto(base + '/settings');
  await expect(page.getByTestId('viewer-login')).toHaveText('octocat');
  await expect(page.getByTestId('sign-out')).toBeVisible();
  await expect(page.getByTestId('sign-in')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeVisible();

  harness.setSession(signedIn('visitor', false));
  harness.setHandler(() => ({
    status: 403,
    json: { error: 'This GitHub account is not authorized to edit review models.' },
  }));
  await page.reload();
  await expect(page.getByTestId('viewer-login')).toHaveText('visitor');
  await expect(page.getByTestId('sign-out')).toBeVisible();
  await expect(
    page.getByText('This GitHub account is not authorized to edit review models.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
});

test('signing in returns to the job permalink that started it', async ({ page, harness, base }) => {
  harness.setHandler((url) => {
    if (url.pathname.startsWith('/api/jobs/')) return ok(detailData(task({ runId: 'run-1' })));
    return ok(historyPage());
  });
  await page.goto(base + '/jobs/run-1');
  await page.waitForSelector('.detail');
  const login = page.waitForRequest(
    (request) => new URL(request.url()).pathname === '/auth/github',
  );
  await page.getByTestId('sign-in').click();
  const request = await login;
  expect(new URL(request.url()).searchParams.get('returnTo')).toBe('/jobs/run-1');
  await expect(page.getByTestId('viewer-login')).toHaveText('octocat');
  await expect(page).toHaveURL(new RegExp('/jobs/run-1$'));
  await page.waitForSelector('.detail');
});

test('signing in returns to the supported history filters that started it', async ({
  page,
  harness,
  base,
}) => {
  harness.setHandler(() => ok(historyPage([task({ runId: 'h-1' })])));
  await page.goto(base + '/history?status=failed&cursor=CURSOR-1');
  await page.waitForSelector('[data-testid="task"]');
  const login = page.waitForRequest(
    (request) => new URL(request.url()).pathname === '/auth/github',
  );
  await page.getByTestId('sign-in').click();
  const request = await login;
  expect(new URL(request.url()).searchParams.get('returnTo')).toBe(
    '/history?status=failed&cursor=CURSOR-1',
  );
  await expect(page.getByTestId('viewer-login')).toHaveText('octocat');
  await page.waitForFunction(
    () => location.pathname === '/history' && location.search.includes('status=failed'),
  );
});

test('signing out POSTs to the same origin and clears the viewer', async ({
  page,
  harness,
  base,
}) => {
  harness.setSession(signedIn('octocat', true));
  harness.setHandler(() => ok(historyPage([task({ runId: 'h-1' })])));
  await page.goto(base + '/history?status=failed');
  await expect(page.getByTestId('viewer-login')).toHaveText('octocat');
  const logout = page.waitForRequest(
    (request) => new URL(request.url()).pathname === '/auth/logout',
  );
  await page.getByTestId('sign-out').click();
  const request = await logout;
  expect(request.method()).toBe('POST');
  expect(new URL(request.url()).searchParams.get('returnTo')).toBe('/history?status=failed');
  await expect(page.getByTestId('sign-in')).toBeVisible();
  await expect(page.getByTestId('viewer-login')).toHaveCount(0);
  await page.waitForFunction(
    () => location.pathname === '/history' && location.search.includes('status=failed'),
  );
});

const headerGeometry = (page: Page) =>
  page.evaluate(() => {
    const rect = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error('Missing ' + selector);
      const bounds = element.getBoundingClientRect();
      return {
        top: bounds.top,
        right: bounds.right,
        bottom: bounds.bottom,
        left: bounds.left,
        width: bounds.width,
        height: bounds.height,
      };
    };
    const navItems = [...document.querySelectorAll('.bx--header__menu-item')].map((element) => {
      const bounds = element.getBoundingClientRect();
      return { text: element.textContent?.trim() ?? '', top: bounds.top, bottom: bounds.bottom };
    });
    const timestamp = document.querySelector<HTMLElement>('[data-testid="last-refresh"]');
    return {
      header: rect('.bx--header'),
      name: rect('.bx--header__name'),
      nav: rect('.bx--header__nav'),
      navItems,
      account: rect('.header-account'),
      viewer: rect('[data-testid="viewer-login"]'),
      signOut: rect('[data-testid="sign-out"]'),
      refresh: rect('.header-refresh [data-testid="refresh"]'),
      timestamp: rect('[data-testid="last-refresh"]'),
      timestampFits: timestamp ? timestamp.scrollWidth <= timestamp.clientWidth + 1 : false,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });

const expectInside = (
  child: { top: number; right: number; bottom: number; left: number },
  parent: { top: number; right: number; bottom: number; left: number },
) => {
  expect(child.top).toBeGreaterThanOrEqual(parent.top - 0.5);
  expect(child.left).toBeGreaterThanOrEqual(parent.left - 0.5);
  expect(child.bottom).toBeLessThanOrEqual(parent.bottom + 0.5);
  expect(child.right).toBeLessThanOrEqual(parent.right + 0.5);
};

test('desktop header keeps the account and refresh timestamp inside the 48px bar', async ({
  page,
  harness,
  base,
}) => {
  harness.setSession(signedIn('KagamiChan', true));
  harness.setHandler((url) =>
    url.pathname === '/api/dashboard' ? ok(overview()) : ok(historyPage()),
  );
  await page.setViewportSize({ width: 1280, height: 640 });
  await page.goto(base + '/');
  await page.addStyleTag({ content: 'html { overflow-y: scroll; }' });
  await expect(page.getByTestId('stats')).toBeVisible();
  await expect(page.getByTestId('viewer-login')).toHaveText('KagamiChan');
  const geometry = await headerGeometry(page);
  expect(geometry.header.height).toBe(48);
  expect(geometry.nav.right).toBeLessThanOrEqual(geometry.account.left);
  for (const element of [
    geometry.account,
    geometry.viewer,
    geometry.signOut,
    geometry.timestamp,
    geometry.refresh,
  ])
    expectInside(element, geometry.header);
  expect(geometry.timestampFits).toBe(true);
  expect(geometry.overflow).toBeLessThanOrEqual(1);
});

test('mobile header groups title with account, nav on one row and refresh below', async ({
  page,
  harness,
  base,
}) => {
  harness.setSession(signedIn('KagamiChan', true));
  harness.setHandler((url) =>
    url.pathname === '/api/dashboard' ? ok(overview()) : ok(historyPage()),
  );
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto(base + '/');
  await expect(page.getByTestId('stats')).toBeVisible();
  await expect(page.getByTestId('viewer-login')).toHaveText('KagamiChan');
  const geometry = await headerGeometry(page);
  expect(geometry.header.height).toBeLessThanOrEqual(150);
  expect(geometry.overflow).toBeLessThanOrEqual(1);
  expect(geometry.navItems).toHaveLength(4);
  expect(new Set(geometry.navItems.map((item) => Math.round(item.top))).size).toBe(1);
  expect(geometry.navItems.map((item) => item.text)).toEqual([
    'Overview',
    'History',
    'Help',
    'Settings',
  ]);
  expect(geometry.timestampFits).toBe(true);
  expect(geometry.name.bottom).toBeLessThanOrEqual(geometry.nav.top + 0.5);
  expect(geometry.account.bottom).toBeLessThanOrEqual(geometry.nav.top + 0.5);
  expect(geometry.refresh.top).toBeGreaterThanOrEqual(geometry.nav.bottom - 0.5);
  for (const element of [
    geometry.name,
    geometry.account,
    geometry.viewer,
    geometry.signOut,
    geometry.nav,
    geometry.timestamp,
    geometry.refresh,
  ])
    expectInside(element, geometry.header);
});

test('a GitHub outage or expired session leaves public browsing usable', async ({
  page,
  harness,
  base,
}) => {
  harness.setHandler((url) =>
    url.pathname === '/api/dashboard' ? ok(overview()) : ok(historyPage()),
  );
  harness.setSession({ status: 503, json: { error: 'Could not retrieve your account.' } });
  await page.goto(base + '/');
  await expect(page.getByTestId('stats')).toBeVisible();
  await expect(page.getByTestId('sign-in')).toBeVisible();

  harness.setSession({ status: 401, json: { error: 'Session expired.' } });
  await page.reload();
  await expect(page.getByTestId('stats')).toBeVisible();
  await expect(page.getByTestId('sign-in')).toBeVisible();
});
