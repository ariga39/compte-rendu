import type { PublicHistoryPage, PublicTaskDetail, PublicTaskState } from '@compte-rendu/contracts';
import { expect, test, type ApiHandler, type ApiPayload } from './fixtures';

const NOW = '2026-10-16T12:00:00.000Z';
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

const publicTask = (runId: string, overrides: Partial<PublicTaskState> = {}): PublicTaskState => ({
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
    headRef: 'feature/decision',
    baseSha: '1'.repeat(40),
    headSha: '2'.repeat(40),
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
  ...overrides,
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

test('history table shows the exact decision labels and an em dash when unknown', async ({
  page,
  harness,
  base,
}) => {
  harness.setHandler(
    listAndDetails([
      publicTask('approved', { decision: 'approve' }),
      publicTask('changes', { decision: 'request_changes' }),
      publicTask('commented', { decision: 'comment' }),
      publicTask('unknown', { decision: null }),
    ]),
  );
  await page.goto(`${base}/history`);
  await page.waitForSelector('[data-testid="task"]');

  const decisionOf = async (runId: string) =>
    (
      await page
        .locator(`[data-testid="task"][data-run-id="${runId}"] [data-testid="task-decision"]`)
        .textContent()
    )?.trim();

  expect(await decisionOf('approved')).toBe('Approve');
  expect(await decisionOf('changes')).toBe('Request changes');
  expect(await decisionOf('commented')).toBe('Comment');
  expect(await decisionOf('unknown')).toBe('—');
});

test('the detail drawer shows the decision and separates it from merge eligibility', async ({
  page,
  harness,
  base,
}) => {
  harness.setHandler(listAndDetails([publicTask('changes', { decision: 'request_changes' })]));
  await page.goto(`${base}/history`);
  await page.waitForSelector('[data-testid="task"]');

  await page.click('[data-testid="task-link"][data-run-id="changes"]');
  const drawer = page.locator('[data-testid="detail-drawer"]');
  await expect(drawer).toBeVisible();

  const decision = drawer.locator('[data-testid="detail-decision"]');
  await expect(decision).toHaveText('Request changes');

  const text = (await drawer.textContent())?.replace(/\s+/g, ' ') ?? '';
  expect(text).toContain('Published');
  expect(text).toContain('original conclusion');
  expect(text.toLowerCase()).toContain('merge eligibility');
});

test('a request_changes decision still reports the review as Published', async ({
  page,
  harness,
  base,
}) => {
  harness.setHandler(
    listAndDetails([publicTask('changes', { decision: 'request_changes', status: 'completed' })]),
  );
  await page.goto(`${base}/history`);
  await page.waitForSelector('[data-testid="task"]');

  const row = page.locator('[data-testid="task"][data-run-id="changes"]');
  expect((await row.textContent())?.replace(/\s+/g, ' ')).toContain('Published');
  await expect(row.locator('[data-testid="task-decision"]')).toHaveText('Request changes');
});

test('an unknown decision shows an em dash in the detail without hiding public identity', async ({
  page,
  harness,
  base,
}) => {
  harness.setHandler(listAndDetails([publicTask('unknown', { decision: null })]));
  await page.goto(`${base}/history`);
  await page.waitForSelector('[data-testid="task"]');

  await page.click('[data-testid="task-link"][data-run-id="unknown"]');
  const drawer = page.locator('[data-testid="detail-drawer"]');
  await expect(drawer).toBeVisible();
  await expect(drawer.locator('[data-testid="detail-decision"]')).toHaveText('—');
  expect(await drawer.textContent()).toContain('acme/widgets #7');
  await expect(drawer.getByRole('region', { name: 'Models and tokens' })).toContainText(
    'Usage not recorded for this review.',
  );
});

test('an anonymous review still shows its decision without exposing identity', async ({
  page,
  harness,
  base,
}) => {
  harness.setHandler(
    listAndDetails([
      publicTask('private', { decision: 'approve', identity: { kind: 'anonymous' } }),
    ]),
  );
  await page.goto(`${base}/history`);
  await page.waitForSelector('[data-testid="task"]');

  const row = page.locator('[data-testid="task"][data-run-id="private"]');
  await expect(row.locator('[data-testid="task-decision"]')).toHaveText('Approve');
  const text = (await row.textContent()) ?? '';
  expect(text).toContain('Anonymous review');
  expect(text).not.toContain('acme/widgets');
});

test('detail shows reported model usage, partial totals and unknown fields for an anonymous review', async ({
  page,
  harness,
  base,
}) => {
  const task = publicTask('usage', { identity: { kind: 'anonymous' }, status: 'failed' });
  harness.setHandler(() =>
    ok({
      ...detailData(task),
      usage: {
        version: 1,
        models: [
          {
            route: 'reviewer',
            model: 'deepseek-v4.1-flash',
            requests: 2,
            incompleteRequests: 1,
            inputTokens: { total: 1200, reportedRequests: 2 },
            uncachedInputTokens: { total: 300, reportedRequests: 2 },
            cacheReadTokens: { total: 900, reportedRequests: 2 },
            cacheWriteTokens: null,
            outputTokens: { total: 80, reportedRequests: 1 },
            reasoningTokens: { total: 30, reportedRequests: 1 },
          },
        ],
      },
    }),
  );
  await page.goto(`${base}/jobs/usage`);
  const usage = page.getByRole('region', { name: 'Models and tokens' });
  const disclosure = usage.getByRole('button', { name: 'deepseek-v4.1-flash' });
  await expect(disclosure).toBeVisible();
  await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
  await expect(usage.getByText('Route: reviewer')).toBeHidden();
  await expect(usage.getByText('1,200')).toBeHidden();

  await disclosure.click();
  await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
  await expect(usage).toContainText('Route: reviewer');
  await expect(usage).toContainText('1,200');
  await expect(usage).toContainText('300');
  await expect(usage).toContainText('900');
  await expect(usage).toContainText('Cache write');
  await expect(usage).toContainText('Not reported');
  await expect(usage).toContainText('1 of 2 requests');
  await expect(usage).toContainText('1 interrupted request');
  await expect(page.getByRole('heading', { name: 'Anonymous review' })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(usage).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await disclosure.click();
  await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
  await expect(usage.getByText('Route: reviewer')).toBeHidden();
  await expect(usage.getByText('1,200')).toBeHidden();
});

test('detail shows bare model names and collapses request and token details after Timing', async ({
  page,
  harness,
  base,
}) => {
  const model = (route: string, name: string, overrides = {}) => ({
    route,
    model: name,
    requests: 1,
    incompleteRequests: 0,
    inputTokens: null,
    uncachedInputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    ...overrides,
  });
  harness.setHandler(() =>
    ok({
      ...detailData(publicTask('bare-model')),
      usage: {
        version: 1,
        models: [
          model('reviewer', 'openai/deepseek-v4.1-flash', {
            requests: 2,
            incompleteRequests: 1,
            inputTokens: { total: 1200, reportedRequests: 2 },
            outputTokens: { total: 80, reportedRequests: 1 },
          }),
          model('compte-rendu', 'compte-rendu/qwen3-coder'),
        ],
      },
    }),
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${base}/jobs/bare-model`);
  const usage = page.getByRole('region', { name: 'Models and tokens' });
  const disclosure = usage.getByRole('button', { name: 'deepseek-v4.1-flash' });
  await expect(disclosure).toBeVisible();
  await expect(usage.getByRole('button', { name: 'qwen3-coder' })).toBeVisible();
  await expect(usage).not.toContainText('openai/deepseek-v4.1-flash');
  await expect(usage).not.toContainText('compte-rendu/qwen3-coder');

  const followsTiming = await page.evaluate(() => {
    const timing = [...document.querySelectorAll('h2')].find(
      (heading) => heading.textContent?.trim() === 'Timing',
    );
    const models = document.querySelector('section[aria-label="Models and tokens"]');
    return (
      timing !== undefined &&
      models !== null &&
      (timing.compareDocumentPosition(models) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
    );
  });
  expect(followsTiming).toBe(true);

  await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
  await expect(usage.getByText('Route: reviewer')).toBeHidden();
  await expect(usage.getByText('1,200')).toBeHidden();
  await page.screenshot({
    path: test.info().outputPath('model-usage-collapsed-desktop.png'),
    fullPage: true,
  });

  await disclosure.focus();
  await page.keyboard.press('Enter');
  await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
  await expect(usage.getByText('Route: reviewer · 2 requests')).toBeVisible();
  await expect(usage.getByText('1,200')).toBeVisible();
  await expect(usage.getByText('1 interrupted request')).toBeVisible();
  await expect(usage.getByText('1 of 2 requests')).toBeVisible();
  await expect(usage.getByText('Cache write').first()).toBeVisible();
  await expect(usage.getByText('Not reported').first()).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath('model-usage-expanded-desktop.png'),
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(usage).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: test.info().outputPath('model-usage-expanded-mobile.png'),
    fullPage: true,
  });

  await page.keyboard.press('Space');
  await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
  await expect(usage.getByText('Route: reviewer')).toBeHidden();
  await expect(usage.getByText('1,200')).toBeHidden();
  await page.screenshot({
    path: test.info().outputPath('model-usage-collapsed-mobile.png'),
    fullPage: true,
  });
});

test('detail shows cache-read percentage only for complete comparable totals', async ({
  page,
  harness,
  base,
}) => {
  const model = (route: string, name: string, overrides = {}) => ({
    route,
    model: name,
    requests: 1,
    incompleteRequests: 0,
    inputTokens: null,
    uncachedInputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    ...overrides,
  });
  harness.setHandler(() =>
    ok({
      ...detailData(publicTask('cache-percent')),
      usage: {
        version: 1,
        models: [
          model('reviewer', 'openai/cache-75', {
            requests: 2,
            inputTokens: { total: 1200, reportedRequests: 2 },
            cacheReadTokens: { total: 900, reportedRequests: 2 },
          }),
          model('zero-cache', 'compte-rendu/zero-cache', {
            inputTokens: { total: 1000, reportedRequests: 1 },
            cacheReadTokens: { total: 0, reportedRequests: 1 },
          }),
          model('missing-cache', 'missing-cache', {
            inputTokens: { total: 1000, reportedRequests: 1 },
          }),
          model('missing-input', 'missing-input', {
            cacheReadTokens: { total: 900, reportedRequests: 1 },
          }),
          model('zero-input', 'zero-input', {
            inputTokens: { total: 0, reportedRequests: 1 },
            cacheReadTokens: { total: 0, reportedRequests: 1 },
          }),
          model('partial-cache', 'partial-cache', {
            requests: 2,
            inputTokens: { total: 1200, reportedRequests: 1 },
            cacheReadTokens: { total: 900, reportedRequests: 1 },
          }),
        ],
      },
    }),
  );
  await page.goto(`${base}/jobs/cache-percent`);
  const usage = page.getByRole('region', { name: 'Models and tokens' });
  const open = async (name: string) => {
    const disclosure = usage.getByRole('button', { name, exact: true });
    await disclosure.click();
    await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    return usage.getByRole('region', { name });
  };

  await expect(await open('cache-75')).toContainText('900 (75%)');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: test.info().outputPath('model-usage-cache-percent-expanded-mobile.png'),
    fullPage: true,
  });
  await expect(await open('zero-cache')).toContainText('0 (0%)');

  const missing = await open('missing-cache');
  await expect(missing).toContainText('1,000');
  await expect(missing).toContainText('Not reported');
  await expect(missing).not.toContainText('%');

  const missingInput = await open('missing-input');
  await expect(missingInput).toContainText('900');
  await expect(missingInput).toContainText('Not reported');
  await expect(missingInput).not.toContainText('%');

  const zeroInput = await open('zero-input');
  await expect(zeroInput).toContainText('0');
  await expect(zeroInput).not.toContainText('%');

  const partial = await open('partial-cache');
  await expect(partial).toContainText('1,200');
  await expect(partial).toContainText('900');
  await expect(partial).toContainText('Reported for 1 of 2 requests');
  await expect(partial).not.toContainText('%');
});

test('detail keeps distinct route and model pairs when their names contain colons', async ({
  page,
  harness,
  base,
}) => {
  const models = [
    { route: 'a:b', model: null },
    { route: 'a', model: 'b:null' },
  ].map((identity) => ({
    ...identity,
    requests: 1,
    incompleteRequests: 0,
    inputTokens: null,
    uncachedInputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    outputTokens: null,
    reasoningTokens: null,
  }));
  harness.setHandler(() =>
    ok({ ...detailData(publicTask('colon-models')), usage: { version: 1, models } }),
  );
  await page.goto(`${base}/jobs/colon-models`);
  const usage = page.getByRole('region', { name: 'Models and tokens' });
  const notReported = usage.getByRole('button', { name: 'Model not reported' });
  const colonModel = usage.getByRole('button', { name: 'b:null', exact: true });
  await expect(notReported).toBeVisible();
  await expect(colonModel).toBeVisible();
  await expect(notReported).toHaveAttribute('aria-expanded', 'false');
  await expect(colonModel).toHaveAttribute('aria-expanded', 'false');
  await notReported.click();
  await colonModel.click();
  await expect(usage).toContainText('Route: a:b');
  await expect(usage).toContainText('Route: a ·');
});
