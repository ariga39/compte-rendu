import type {
  PublicHistoryPage,
  PublicOverview,
  PublicTaskDetail,
  PublicTaskState,
} from '@compte-rendu/contracts';
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
  counts: { queued: 0, claimed: 0, publishedLast24h: 0, failedLast24h: 0 },
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

test('signed-in mobile header keeps the account, sign-out and refresh usable', async ({
  page,
  harness,
  base,
}) => {
  harness.setSession(signedIn('octocat', true));
  harness.setHandler((url) =>
    url.pathname === '/api/dashboard' ? ok(overview()) : ok(historyPage()),
  );
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto(base + '/');
  await expect(page.getByTestId('stats')).toBeVisible();
  await expect(page.getByTestId('viewer-login')).toHaveText('octocat');
  const refresh = page.locator('.header-refresh [data-testid="refresh"]');
  await expect(page.getByTestId('sign-out')).toBeVisible();
  await expect(refresh).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
  await expect(page.getByTestId('viewer-login')).toBeInViewport({ ratio: 1 });
  await expect(page.getByTestId('sign-out')).toBeInViewport({ ratio: 1 });
  await expect(refresh).toBeInViewport({ ratio: 1 });
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
