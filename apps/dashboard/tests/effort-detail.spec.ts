import { detailData, expect, NOW, ok, test } from './fixtures';
import { publicIdentity, publicTask } from './sample-task.ts';

const task = publicTask('run-effort', {
  identity: publicIdentity(),
  receivedAt: NOW,
});
const detail = {
  ...detailData(task),
  efforts: {
    selection: [{ route: 'review/a', name: 'high', generation: 0 }],
    summary: [
      {
        route: 'review/a',
        selected: 'high',
        generation: 0,
        outcomes: [{ kind: 'switched', reason: 'upstream rejected reasoning_effort', requests: 1 }],
      },
    ],
  },
};
const requestDetail = {
  jobId: 'job-effort',
  nextCursor: 'next-page',
  requests: [
    {
      requestId: 'request-1',
      route: 'review/a',
      selected: 'high',
      generation: 0,
      fallback: 'switched',
      reason: 'upstream rejected reasoning_effort',
      attempts: [
        { attempt: 1, sent: { reasoning_effort: 'high' }, reported: null, result: 'rejected' },
        { attempt: 2, sent: null, reported: null, result: 'complete' },
      ],
    },
  ],
};
const more = {
  jobId: 'job-effort',
  nextCursor: null,
  requests: [
    {
      requestId: 'request-2',
      route: 'review/a',
      selected: 'high',
      generation: 0,
      fallback: 'shared',
      reason: null,
      attempts: [{ attempt: 1, sent: null, reported: null, result: 'incomplete' }],
    },
    {
      requestId: 'request-3',
      route: 'review/a',
      selected: 'high',
      generation: 0,
      fallback: null,
      reason: null,
      attempts: [],
    },
  ],
};

test('shows configured and actual effort and loads authorized bounded request details', async ({
  page,
  harness,
  base,
}) => {
  harness.setSession({
    status: 200,
    json: { signedIn: true, account: { login: 'operator' }, operator: true },
  });
  const requested: string[] = [];
  harness.setHandler((url) => {
    if (url.pathname === '/api/jobs/run-effort/effort-details') {
      requested.push(url.pathname + url.search);
      return ok(url.searchParams.get('cursor') === 'next-page' ? more : requestDetail);
    }
    if (url.pathname === '/api/jobs/run-effort') return ok(detail);
    return { status: 404 };
  });
  await page.goto(base + '/jobs/run-effort');

  await expect(page.getByTestId('effort-selection')).toContainText('review/a');
  await expect(page.getByTestId('effort-selection')).toContainText('high');
  await expect(page.getByTestId('effort-summary')).toContainText('This run switched');
  await expect(page.getByTestId('effort-summary')).toContainText(
    'upstream rejected reasoning_effort',
  );

  await page.getByTestId('load-effort-details').click();
  await expect(page.getByTestId('effort-request-request-1')).toContainText('Request request-1');
  await expect(page.getByTestId('effort-request-request-1')).toContainText('Attempt 1');
  await expect(page.getByTestId('effort-request-request-1')).toContainText('Rejected');
  await expect(page.getByTestId('effort-request-request-1')).toContainText('reasoning_effort=high');
  await expect(page.getByTestId('effort-request-request-1')).toContainText('Not reported');

  await page.getByTestId('load-more-effort-details').click();
  await expect(page.getByTestId('effort-request-request-2')).toContainText('Record incomplete');
  await expect(page.getByTestId('effort-empty-attempts-request-3')).toContainText(
    'Record incomplete',
  );
  await expect(page.getByTestId('effort-empty-attempts-request-3')).toContainText('crash');
  expect(requested).toEqual([
    '/api/jobs/run-effort/effort-details',
    '/api/jobs/run-effort/effort-details?cursor=next-page',
  ]);
});

test('resets loaded request details when drawer navigation changes the task', async ({
  page,
  harness,
  base,
}) => {
  harness.setSession({
    status: 200,
    json: { signedIn: true, account: { login: 'operator' }, operator: true },
  });
  const first = publicTask('run-a', { identity: publicIdentity() });
  const second = publicTask('run-b', { identity: publicIdentity() });
  const withEfforts = (task: typeof first) => ({
    ...detailData(task),
    efforts: {
      selection: [{ route: 'review/a', name: 'high', generation: 0 }],
      summary: null,
    },
  });
  harness.setHandler((url) => {
    if (url.pathname === '/api/jobs/run-a/effort-details') return ok(requestDetail);
    if (url.pathname === '/api/jobs/run-a') return ok(withEfforts(first));
    if (url.pathname === '/api/jobs/run-b') return ok(withEfforts(second));
    if (url.pathname === '/api/jobs')
      return ok({ generatedAt: NOW, tasks: [first, second], nextCursor: null });
    return { status: 404 };
  });
  await page.goto(base + '/history');
  await page.click('[data-testid="task-link"][data-run-id="run-a"]');
  await page.getByTestId('load-effort-details').click();
  await expect(page.getByTestId('effort-request-request-1')).toBeVisible();
  await page.click('[data-testid="task-link"][data-run-id="run-b"]');
  await expect(page.getByTestId('load-effort-details')).toBeVisible();
  await expect(page.getByTestId('effort-request-request-1')).toHaveCount(0);
});

test('does not offer request-level details to a non-editor viewer', async ({
  page,
  harness,
  base,
}) => {
  harness.setHandler((url) =>
    url.pathname === '/api/jobs/run-effort' ? ok(detail) : { status: 404 },
  );
  await page.goto(base + '/jobs/run-effort');
  await expect(page.getByTestId('effort-summary')).toBeVisible();
  await expect(page.getByTestId('load-effort-details')).toHaveCount(0);
});
