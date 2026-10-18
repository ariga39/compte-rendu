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
