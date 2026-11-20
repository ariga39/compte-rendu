import type { PublicHistoryPage, PublicTaskDetail, PublicTaskState } from '@compte-rendu/contracts';
import { publicTask } from './sample-task.ts';
import { expect, test, type ApiHandler, type ApiPayload } from './fixtures';

const NOW = '2026-10-16T12:00:00.000Z';
const ok = (json: unknown): ApiPayload => ({ status: 200, json });

const historyPage = (tasks: PublicTaskState[]): PublicHistoryPage => ({
  generatedAt: NOW,
  tasks,
  nextCursor: null,
});

const detailData = (task: PublicTaskState): PublicTaskDetail => ({
  generatedAt: NOW,
  task,
  milestones: [],
  processingMilestones: [],
});

const listAndDetails =
  (tasks: PublicTaskState[]): ApiHandler =>
  (url) => {
    if (url.pathname.startsWith('/api/jobs/')) {
      const runId = url.pathname.slice('/api/jobs/'.length);
      const found = tasks.find((task) => task.runId === runId);
      return found === undefined ? { status: 404 } : ok(detailData(found));
    }
    return ok(historyPage(tasks));
  };

const statusOf = async (page: import('@playwright/test').Page) =>
  (await page.locator('.review-heading .bx--tag').textContent())?.trim() ?? '';

test('a cancelled review is distinct from failure and supersession', async ({
  page,
  harness,
  base,
}) => {
  const queued = publicTask('cancelled-queued', {
    status: 'cancelled',
    dispatch: null,
    claimedAt: null,
    terminalAt: NOW,
    cleanup: 'unknown',
    totalDurationMs: 0,
  });
  harness.setHandler(listAndDetails([queued]));

  await page.goto(`${base}/history`);
  const row = page.locator('[data-testid="task"][data-run-id="cancelled-queued"]');
  await expect(row).toContainText('Cancelled');
  await expect(row).not.toContainText('Failed');
  await expect(row).not.toContainText('Superseded');

  await page.goto(`${base}/jobs/cancelled-queued`);
  await expect.poll(() => statusOf(page)).toBe('Cancelled');
  const text = (await page.locator('#content').textContent())?.replace(/\s+/g, ' ') ?? '';
  expect(text).toContain('Review cancelled; no review was published.');
  await expect(page.getByRole('list', { name: 'Timeline' }).locator('li strong')).toHaveText([
    'Cancelled by operator',
  ]);
  expect(text).not.toContain('Did not finish successfully.');
  expect(text).not.toContain('A newer revision replaced this review.');
  await expect(page.locator('[data-testid="cancel-review"]')).toHaveCount(0);
});

test('timeline places the operator cancellation between review and teardown', async ({
  page,
  harness,
  base,
}) => {
  const task = publicTask('cancel-timeline', {
    status: 'cancelled',
    dispatch: null,
    claimedAt: NOW,
    terminalAt: '2026-10-16T12:00:05.000Z',
    cleanup: 'destroyed',
    cleanupCompletedAt: '2026-10-16T12:00:14.000Z',
    resultReceivedAt: '2026-10-16T12:00:15.000Z',
  });
  harness.setHandler(() =>
    ok({
      ...detailData(task),
      milestones: [
        { stage: 'agent', startedAt: NOW },
        { stage: 'cleanup', startedAt: '2026-10-16T12:00:10.000Z' },
      ],
    }),
  );
  await page.goto(`${base}/jobs/cancel-timeline`);
  const timeline = page.getByRole('list', { name: 'Timeline' });
  await expect(timeline.locator('li strong')).toHaveText([
    'Reviewing',
    'Cancelled by operator',
    'Finishing up',
    'Sandbox cleanup confirmed',
    'Runner callback received',
  ]);
  await expect(
    timeline.getByText('Cancelled by operator').locator('..').locator('time'),
  ).toHaveAttribute('datetime', task.terminalAt!);
});

test('a claimed cancellation stays Cancelling until cleanup is confirmed', async ({
  page,
  harness,
  base,
}) => {
  let cleanup: PublicTaskState['cleanup'] = 'pending';
  harness.setHandler((url) => {
    if (!url.pathname.startsWith('/api/jobs/')) return ok(historyPage([]));
    return ok(
      detailData(
        publicTask('cancelling', {
          status: 'cancelled',
          dispatch: null,
          claimedAt: NOW,
          terminalAt: NOW,
          cleanup,
          totalDurationMs: 5000,
        }),
      ),
    );
  });

  await page.goto(`${base}/jobs/cancelling`);
  await expect.poll(() => statusOf(page)).toBe('Cancelling');
  const pending = (await page.locator('#content').textContent())?.replace(/\s+/g, ' ') ?? '';
  expect(pending).toContain('Execution is stopping and cleanup is not yet confirmed.');
  await page.locator('.bx--accordion__heading').click();
  await expect(page.locator('.cleanup-block')).toContainText('Cleanup pending');

  cleanup = 'destroyed';
  await page.click('.header-refresh [data-testid="refresh"]');
  await expect.poll(() => statusOf(page)).toBe('Cancelled');
  const done = (await page.locator('#content').textContent())?.replace(/\s+/g, ' ') ?? '';
  expect(done).toContain('Review cancelled; no review was published.');
  await expect(page.locator('.cleanup-block')).toContainText('Cleaned up');
  expect(done).toContain('Cleanup was confirmed.');
});

test('a claimed cancellation with unrecorded cleanup stays unresolved and pollable', async ({
  page,
  harness,
  base,
}) => {
  let cleanup: PublicTaskState['cleanup'] = 'unknown';
  harness.setHandler((url) => {
    if (!url.pathname.startsWith('/api/jobs/')) return ok(historyPage([]));
    return ok(
      detailData(
        publicTask('unknown-cleanup', {
          status: 'cancelled',
          dispatch: null,
          claimedAt: NOW,
          terminalAt: NOW,
          cleanup,
          totalDurationMs: 5000,
        }),
      ),
    );
  });

  await page.clock.install();
  await page.goto(`${base}/jobs/unknown-cleanup`);
  await expect.poll(() => statusOf(page)).toBe('Cancelling');
  await expect(page.locator('.review-heading p')).toContainText(
    'Execution is stopping and cleanup is not yet confirmed.',
  );

  cleanup = 'destroyed';
  await page.clock.fastForward(20000);
  await expect.poll(() => statusOf(page)).toBe('Cancelled');
});

test('reloading a cancelling review keeps polling until cleanup is confirmed', async ({
  page,
  harness,
  base,
}) => {
  let cleanup: PublicTaskState['cleanup'] = 'pending';
  harness.setHandler((url) => {
    if (!url.pathname.startsWith('/api/jobs/')) return ok(historyPage([]));
    return ok(
      detailData(
        publicTask('reload-cancel', {
          status: 'cancelled',
          dispatch: null,
          claimedAt: NOW,
          terminalAt: NOW,
          cleanup,
          totalDurationMs: 5000,
        }),
      ),
    );
  });

  await page.clock.install();
  await page.goto(`${base}/jobs/reload-cancel`);
  await expect.poll(() => statusOf(page)).toBe('Cancelling');
  await page.reload();
  await expect.poll(() => statusOf(page)).toBe('Cancelling');
  cleanup = 'destroyed';
  await page.clock.fastForward(20000);
  await expect.poll(() => statusOf(page)).toBe('Cancelled');
});

test('cleanup failure is explained separately from cancellation', async ({
  page,
  harness,
  base,
}) => {
  harness.setHandler(
    listAndDetails([
      publicTask('cancelled-cleanup', {
        status: 'cancelled',
        dispatch: null,
        claimedAt: NOW,
        terminalAt: NOW,
        cleanup: 'failed',
        totalDurationMs: 5000,
      }),
    ]),
  );

  await page.goto(`${base}/history`);
  const row = page.locator('[data-testid="task"][data-run-id="cancelled-cleanup"]');
  await expect(row).toContainText('Cancelled');
  await expect(row).not.toContainText('Failed');

  await page.goto(`${base}/jobs/cancelled-cleanup`);
  await expect.poll(() => statusOf(page)).toBe('Cancelled');
  const text = (await page.locator('#content').textContent())?.replace(/\s+/g, ' ') ?? '';
  expect(text).toContain('Review cancelled. Cleanup failed and needs an operator.');
  expect(text).toContain('Cleanup failed and needs an operator.');
  await expect(page.locator('.review-heading .bx--tag')).not.toHaveText('Failed');
});

test('anonymous readers cannot open a cancellation confirmation', async ({
  page,
  harness,
  base,
}) => {
  const cancellable = publicTask('still-running', {
    status: 'scheduled',
    dispatch: 'claimed',
    claimedAt: NOW,
    stage: 'agent',
    terminalAt: null,
    cleanup: 'pending',
  });
  harness.setHandler(listAndDetails([cancellable]));

  await page.goto(`${base}/jobs/still-running`);
  await expect.poll(() => statusOf(page)).toBe('In progress');
  await expect(page.locator('[data-testid="cancel-review"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="cancel-confirm"]')).toHaveCount(0);

  await page.goto(`${base}/history`);
  await page.click('[data-testid="task-link"][data-run-id="still-running"]');
  await expect(page.locator('[data-testid="detail-drawer"]')).toBeVisible();
  await expect(page.locator('[data-testid="cancel-review"]')).toHaveCount(0);
});

test('an unauthorized direct cancel POST has no effect on the page', async ({
  page,
  harness,
  base,
}) => {
  let posts = 0;
  const cancellable = publicTask('direct-post', {
    status: 'scheduled',
    dispatch: 'queued',
    claimedAt: null,
    cleanup: 'unknown',
  });
  harness.setHandler((url, request) => {
    if (url.pathname === '/api/jobs/direct-post/cancel') {
      if (request.method !== 'POST') return { status: 405 };
      posts += 1;
      return { status: 403 };
    }
    if (url.pathname === '/api/jobs/direct-post') return ok(detailData(cancellable));
    return ok(historyPage([]));
  });

  await page.goto(`${base}/jobs/direct-post`);
  await expect.poll(() => statusOf(page)).toBe('Queued');
  const status = await page.evaluate(async () => {
    const response = await fetch('/api/jobs/direct-post/cancel', { method: 'POST' });
    return response.status;
  });
  expect(status).toBe(403);
  expect(posts).toBe(1);
  await expect.poll(() => statusOf(page)).toBe('Queued');
  await expect(page.locator('[data-testid="cancel-review"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="cancel-confirm"]')).toHaveCount(0);
});

test('a cancelled private review keeps the privacy projection', async ({ page, harness, base }) => {
  const privateCancelled = publicTask('cancelled-private', {
    status: 'cancelled',
    dispatch: null,
    claimedAt: NOW,
    terminalAt: NOW,
    cleanup: 'destroyed',
    identity: { kind: 'anonymous' },
  });
  harness.setHandler(listAndDetails([privateCancelled]));

  await page.goto(`${base}/history`);
  const row = page.locator('[data-testid="task"][data-run-id="cancelled-private"]');
  await expect(row).toContainText('Cancelled');
  await expect(row).toContainText('Anonymous review');
  expect(await row.textContent()).not.toContain('acme/widgets');

  await page.goto(`${base}/jobs/cancelled-private`);
  await expect.poll(() => statusOf(page)).toBe('Cancelled');
  const text = await page.locator('#content').textContent();
  expect(text).toContain('Anonymous review');
  expect(text).not.toContain('acme/widgets');
});

test('help explains cancellation, its states and its history filter', async ({
  page,
  harness,
  base,
}) => {
  harness.setHandler(() => ok(historyPage([])));
  await page.goto(`${base}/help`);
  const text = (await page.locator('#content').textContent())?.replace(/\s+/g, ' ') ?? '';
  expect(text).toContain('Cancelling a review');
  expect(text).toContain('publish no review');
  expect(text).toContain('Cancelled');
  expect(text).toContain('published, failed, superseded, or cancelled');
  expect(text).toContain('Cleanup failed');
});
