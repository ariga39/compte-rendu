import type { PublicTaskState } from '@compte-rendu/contracts';
import { publicTask } from './sample-task.ts';
import {
  detailData,
  expect,
  historyPage,
  NOW,
  ok,
  test,
  type ApiHandler,
  type ApiPayload,
} from './fixtures';

const cancellable = () =>
  publicTask('run-1', {
    status: 'scheduled',
    dispatch: 'claimed',
    claimedAt: NOW,
    stage: 'agent',
    cleanup: 'pending',
  });

const withHeadRef = (runId: string, headRef: string): PublicTaskState => {
  const task = publicTask(runId, {
    status: 'scheduled',
    dispatch: 'claimed',
    claimedAt: NOW,
    stage: 'agent',
    cleanup: 'pending',
  });
  return task.identity.kind === 'public'
    ? { ...task, identity: { ...task.identity, headRef } }
    : task;
};

const signedIn = (operator: boolean): ApiPayload => ({
  status: 200,
  json: { signedIn: true, account: { login: operator ? 'octocat' : 'visitor' }, operator },
});

const statusOf = async (page: import('@playwright/test').Page) =>
  (await page.locator('.review-heading .bx--tag').first().textContent())?.trim() ?? '';

const activeTestId = (page: import('@playwright/test').Page) =>
  page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null);

const operatorHandler = (
  post: () => ApiPayload,
  task: () => PublicTaskState = cancellable,
  requests: string[] = [],
): ApiHandler => {
  return (url, request) => {
    if (url.pathname === '/api/jobs/run-1/cancel') {
      if (request.method !== 'POST') return { status: 405 };
      requests.push('POST');
      return post();
    }
    if (url.pathname === '/api/jobs/run-1') return ok(detailData(task()));
    return ok(historyPage([task()]));
  };
};

test('an authorized operator confirms cancellation with contained focus', async ({
  page,
  harness,
  base,
}) => {
  harness.setSession(signedIn(true));
  harness.setHandler(
    operatorHandler(() => ({ status: 202, json: { status: 'cancelled', pendingCleanup: true } })),
  );
  await page.goto(`${base}/jobs/run-1`);
  await expect.poll(() => statusOf(page)).toBe('In progress');
  await expect(page.getByTestId('viewer-login')).toHaveText('octocat');
  const trigger = page.locator('[data-testid="cancel-review"]');
  await expect(trigger).toBeVisible();
  await trigger.click();

  const dialog = page.locator('[data-testid="cancel-confirm"]');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Cancel this review?');
  await expect(dialog).toContainText('run-1');
  await expect(dialog).toContainText('publish no review');
  await expect(dialog).toHaveAttribute('role', 'alertdialog');
  expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  expect(await activeTestId(page)).toBe('cancel-confirm-dismiss');

  await page.keyboard.press('Tab');
  expect(await activeTestId(page)).toBe('cancel-confirm-submit');
  await page.keyboard.press('Tab');
  expect(await activeTestId(page)).toBe('cancel-confirm-dismiss');
  await page.keyboard.press('Shift+Tab');
  expect(await activeTestId(page)).toBe('cancel-confirm-submit');

  await page.screenshot({ path: '/tmp/cr-step3-cancel-confirm.png', fullPage: true });

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('accepting a claimed cancellation shows Cancelling until cleanup', async ({
  page,
  harness,
  base,
}) => {
  const requests: string[] = [];
  harness.setSession(signedIn(true));
  harness.setHandler(
    operatorHandler(
      () => ({ status: 202, json: { status: 'cancelled', pendingCleanup: true } }),
      cancellable,
      requests,
    ),
  );
  await page.goto(`${base}/jobs/run-1`);
  await expect.poll(() => statusOf(page)).toBe('In progress');
  await page.locator('[data-testid="cancel-review"]').click();
  await page.locator('[data-testid="cancel-confirm-submit"]').click();

  await expect.poll(() => statusOf(page)).toBe('Cancelling');
  await expect(page.locator('.review-heading p')).toContainText(
    'Execution is stopping and cleanup is not yet confirmed.',
  );
  await expect(page.locator('[data-testid="cancel-review"]')).toHaveCount(0);
  expect(requests).toEqual(['POST']);
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('H1');
  await page.screenshot({ path: '/tmp/cr-step3-cancelling.png', fullPage: true });
});

test('a cancellation without outstanding cleanup becomes Cancelled', async ({
  page,
  harness,
  base,
}) => {
  harness.setSession(signedIn(true));
  harness.setHandler(
    operatorHandler(() => ({ status: 200, json: { status: 'cancelled', pendingCleanup: false } })),
  );
  await page.goto(`${base}/jobs/run-1`);
  await expect.poll(() => statusOf(page)).toBe('In progress');
  await page.locator('[data-testid="cancel-review"]').click();
  await page.locator('[data-testid="cancel-confirm-submit"]').click();

  await expect.poll(() => statusOf(page)).toBe('Cancelled');
  await expect(page.locator('.review-heading p')).toContainText('no review was published');
  await expect(page.locator('[data-testid="cancel-review"]')).toHaveCount(0);
});

test('authoritative server cleanup replaces the local acceptance', async ({
  page,
  harness,
  base,
}) => {
  harness.setSession(signedIn(true));
  let current = cancellable();
  harness.setHandler((url, request) => {
    if (url.pathname === '/api/jobs/run-1/cancel') {
      if (request.method !== 'POST') return { status: 405 };
      current = publicTask('run-1', {
        status: 'cancelled',
        dispatch: null,
        claimedAt: NOW,
        terminalAt: NOW,
        stage: 'agent',
        cleanup: 'pending',
        totalDurationMs: 5000,
      });
      return { status: 202, json: { status: 'cancelled', pendingCleanup: true } };
    }
    if (url.pathname === '/api/jobs/run-1') return ok(detailData(current));
    return ok(historyPage([current]));
  });

  await page.goto(`${base}/jobs/run-1`);
  await expect.poll(() => statusOf(page)).toBe('In progress');
  await page.locator('[data-testid="cancel-review"]').click();
  await page.locator('[data-testid="cancel-confirm-submit"]').click();
  await expect.poll(() => statusOf(page)).toBe('Cancelling');
  await expect(page.getByTestId('cancel-announcement')).toContainText('Cancellation accepted');

  current = publicTask('run-1', {
    status: 'cancelled',
    dispatch: null,
    claimedAt: NOW,
    terminalAt: NOW,
    stage: 'agent',
    cleanup: 'failed',
    totalDurationMs: 5000,
  });
  await page.click('.header-refresh [data-testid="refresh"]');

  await expect.poll(() => statusOf(page)).toBe('Cancelled');
  await expect(page.locator('.review-heading p')).toContainText(
    'Cleanup failed and needs an operator.',
  );
  await page.locator('.bx--accordion__heading').click();
  await expect(page.locator('.cleanup-block')).toContainText('Cleanup failed');
  await expect(page.getByTestId('cancel-announcement')).toContainText('Cleanup failed');
});

test('a pending cancellation can be dismissed without losing focus', async ({
  page,
  harness,
  base,
}) => {
  harness.setSession(signedIn(true));
  let release: () => void = () => undefined;
  const reply = new Promise<ApiPayload>((resolve) => {
    release = () => resolve({ status: 202, json: { status: 'cancelled', pendingCleanup: true } });
  });
  harness.setHandler((url, request) => {
    if (url.pathname === '/api/jobs/run-1/cancel') {
      if (request.method !== 'POST') return { status: 405 };
      return { promise: reply };
    }
    if (url.pathname === '/api/jobs/run-1') return ok(detailData(cancellable()));
    return ok(historyPage([cancellable()]));
  });

  await page.goto(`${base}/jobs/run-1`);
  await expect.poll(() => statusOf(page)).toBe('In progress');
  await page.locator('[data-testid="cancel-review"]').click();
  await page.locator('[data-testid="cancel-confirm-submit"]').click();

  const dialog = page.locator('[data-testid="cancel-confirm"]');
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.detail h1')).toBeFocused();

  release();
  await expect.poll(() => statusOf(page)).toBe('Cancelling');
  await expect(page.getByTestId('cancel-announcement')).toContainText('Cancellation accepted');
  await expect(page.locator('.detail h1')).toBeFocused();
});

test('a stalled cancellation request is bounded and refreshed', async ({ page, harness, base }) => {
  await page.clock.install();
  harness.setSession(signedIn(true));
  let current = cancellable();
  harness.setHandler((url, request) => {
    if (url.pathname === '/api/jobs/run-1/cancel') {
      if (request.method !== 'POST') return { status: 405 };
      current = publicTask('run-1', {
        status: 'cancelled',
        dispatch: null,
        claimedAt: NOW,
        terminalAt: NOW,
        stage: 'agent',
        cleanup: 'pending',
        totalDurationMs: 5000,
      });
      return { promise: new Promise<ApiPayload>(() => undefined) };
    }
    if (url.pathname === '/api/jobs/run-1') return ok(detailData(current));
    return ok(historyPage([current]));
  });

  await page.goto(`${base}/jobs/run-1`);
  await expect.poll(() => statusOf(page)).toBe('In progress');
  await page.locator('[data-testid="cancel-review"]').click();
  await page.locator('[data-testid="cancel-confirm-submit"]').click();
  await expect(page.locator('[data-testid="cancel-confirm"]')).toBeVisible();

  await page.clock.fastForward(16000);

  await expect(page.locator('[data-testid="cancel-confirm"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="cancel-error"]')).toHaveCount(0);
  await expect.poll(() => statusOf(page)).toBe('Cancelling');
  await expect(page.getByTestId('cancel-notice')).toHaveCount(0);
  await expect(page.getByTestId('cancel-announcement')).toContainText(
    'Waiting for cleanup confirmation',
  );
});

test('a publication conflict refreshes the detail without claiming success', async ({
  page,
  harness,
  base,
}) => {
  harness.setSession(signedIn(true));
  harness.setHandler(operatorHandler(() => ({ status: 409 })));
  await page.goto(`${base}/jobs/run-1`);
  await expect.poll(() => statusOf(page)).toBe('In progress');
  await page.locator('[data-testid="cancel-review"]').click();
  await page.locator('[data-testid="cancel-confirm-submit"]').click();

  await expect(page.locator('[data-testid="cancel-error"]')).toContainText(
    'can no longer be cancelled',
  );
  await expect.poll(() => statusOf(page)).toBe('In progress');
  await expect(page.locator('[data-testid="cancel-review"]')).toBeVisible();
  await expect(page.locator('[data-testid="cancel-review"]')).toBeFocused();
});

test('a forbidden reply is explained as permission rather than an expired session', async ({
  page,
  harness,
  base,
}) => {
  harness.setSession(signedIn(true));
  harness.setHandler(operatorHandler(() => ({ status: 403 })));
  await page.goto(`${base}/jobs/run-1`);
  await expect.poll(() => statusOf(page)).toBe('In progress');
  await page.locator('[data-testid="cancel-review"]').click();
  await page.locator('[data-testid="cancel-confirm-submit"]').click();

  await expect(page.locator('[data-testid="cancel-error"]')).toContainText('not allowed to cancel');
  await expect(page.locator('[data-testid="cancel-error"]')).not.toContainText('session expired');
  await expect.poll(() => statusOf(page)).toBe('In progress');
  await expect(page.locator('[data-testid="cancel-review"]')).toBeVisible();
});

test('an expired session refreshes the viewer and asks for sign-in', async ({
  page,
  harness,
  base,
}) => {
  harness.setSession(signedIn(true));
  harness.setHandler((url, request) => {
    if (url.pathname === '/api/jobs/run-1/cancel') {
      if (request.method !== 'POST') return { status: 405 };
      harness.setSession({ status: 401, json: { error: 'Session expired.' } });
      return { status: 401 };
    }
    if (url.pathname === '/api/jobs/run-1') return ok(detailData(cancellable()));
    return ok(historyPage([cancellable()]));
  });

  await page.goto(`${base}/jobs/run-1`);
  await expect.poll(() => statusOf(page)).toBe('In progress');
  await expect(page.getByTestId('viewer-login')).toHaveText('octocat');
  await page.locator('[data-testid="cancel-review"]').click();
  await page.locator('[data-testid="cancel-confirm-submit"]').click();

  await expect(page.locator('[data-testid="cancel-error"]')).toContainText('session expired');
  await expect(page.getByTestId('sign-in')).toBeVisible();
  await expect(page.getByTestId('viewer-login')).toHaveCount(0);
  await expect(page.locator('[data-testid="cancel-review"]')).toHaveCount(0);
});

test('a signed-in non-operator does not see operator controls', async ({ page, harness, base }) => {
  harness.setSession(signedIn(false));
  harness.setHandler(operatorHandler(() => ({ status: 403 })));
  await page.goto(`${base}/jobs/run-1`);
  await expect.poll(() => statusOf(page)).toBe('In progress');
  await expect(page.getByTestId('viewer-login')).toHaveText('visitor');
  await expect(page.locator('[data-testid="cancel-review"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="cancel-confirm"]')).toHaveCount(0);
});

test('the drawer confirmation keeps focus and Escape does not close the drawer', async ({
  page,
  harness,
  base,
}) => {
  harness.setSession(signedIn(true));
  harness.setHandler(
    operatorHandler(() => ({ status: 202, json: { status: 'cancelled', pendingCleanup: true } })),
  );
  await page.goto(`${base}/history`);
  await page.locator('[data-testid="task-link"][data-run-id="run-1"]').click();
  const drawer = page.locator('[data-testid="detail-drawer"]');
  await expect(drawer).toBeVisible();
  await expect.poll(() => statusOf(page)).toBe('In progress');

  const trigger = drawer.locator('[data-testid="cancel-review"]');
  await trigger.click();
  const dialog = page.locator('[data-testid="cancel-confirm"]');
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(drawer).toBeVisible();
  await expect(trigger).toBeFocused();
});

test('a delayed cancellation reply cannot update a different review after navigation', async ({
  page,
  harness,
  base,
}) => {
  harness.setSession(signedIn(true));
  const first = withHeadRef('run-1', 'feature/one');
  const second = withHeadRef('run-2', 'feature/two');
  let release: () => void = () => undefined;
  const reply = new Promise<ApiPayload>((resolve) => {
    release = () => resolve({ status: 202, json: { status: 'cancelled', pendingCleanup: true } });
  });
  let postStarted = false;
  harness.setHandler((url, request) => {
    if (url.pathname === '/api/jobs/run-1/cancel') {
      if (request.method !== 'POST') return { status: 405 };
      postStarted = true;
      return { promise: reply };
    }
    if (url.pathname === '/api/jobs/run-1') return ok(detailData(first));
    if (url.pathname === '/api/jobs/run-2') return ok(detailData(second));
    return ok(historyPage([first, second]));
  });

  await page.goto(`${base}/history`);
  await page.click('[data-testid="task-link"][data-run-id="run-1"]');
  const drawer = page.locator('[data-testid="detail-drawer"]');
  await expect(drawer).toContainText('feature/one');
  await drawer.locator('[data-testid="cancel-review"]').click();
  await page.locator('[data-testid="cancel-confirm-submit"]').click();
  await expect.poll(() => postStarted).toBe(true);

  // The modal blocks pointer input. Dispatch the selection directly to model a
  // delayed reply racing with the drawer moving to another review.
  await page.evaluate(() => {
    document
      .querySelector<HTMLElement>('[data-testid="task-link"][data-run-id="run-2"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await expect(drawer).toContainText('feature/two');
  release();

  await expect.poll(() => statusOf(page)).toBe('In progress');
  await expect(page.locator('[data-testid="cancel-error"]')).toHaveCount(0);
  await expect(drawer).toContainText('feature/two');
  await expect(drawer.locator('[data-testid="cancel-review"]')).toBeVisible();
});

test('an unauthorized direct POST cannot reveal or change operator state', async ({
  page,
  harness,
  base,
}) => {
  harness.setSession(signedIn(false));
  let posts = 0;
  const task = cancellable();
  harness.setHandler((url, request) => {
    if (url.pathname === '/api/jobs/run-1/cancel') {
      if (request.method !== 'POST') return { status: 405 };
      posts += 1;
      return { status: 403 };
    }
    if (url.pathname === '/api/jobs/run-1') return ok(detailData(task));
    return ok(historyPage([task]));
  });
  await page.goto(`${base}/jobs/run-1`);
  await expect.poll(() => statusOf(page)).toBe('In progress');
  const status = await page.evaluate(async () => {
    const response = await fetch('/api/jobs/run-1/cancel', { method: 'POST' });
    return response.status;
  });
  expect(status).toBe(403);
  expect(posts).toBe(1);
  await expect.poll(() => statusOf(page)).toBe('In progress');
  await expect(page.locator('[data-testid="cancel-review"]')).toHaveCount(0);
});
