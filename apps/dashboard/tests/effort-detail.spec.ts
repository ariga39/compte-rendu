import type { EffortJobDetail, EffortRequestDetail } from '@compte-rendu/contracts';
import { detailData, expect, historyPage, NOW, ok, test, type ApiPayload } from './fixtures';
import { publicIdentity, publicTask } from './sample-task.ts';

const responsesRoute = 'openai-platform/gpt-6.1-terra';
const chatRoute = 'review-provider/deepseek-v4.1-flash';

const task = publicTask('run-effort', {
  identity: publicIdentity(),
  receivedAt: NOW,
});

const detail = {
  ...detailData(task),
  efforts: {
    selection: [
      { route: responsesRoute, name: 'low', generation: 0 },
      { route: chatRoute, name: 'high', generation: 0 },
    ],
    summary: null,
  },
};

const request = (
  overrides: Partial<EffortRequestDetail> & { requestId: string },
): EffortRequestDetail => ({
  route: responsesRoute,
  status: 'complete',
  selected: 'low',
  generation: 0,
  fallback: null,
  reason: null,
  attempts: [],
  ...overrides,
});

const page1 = (overrides: Partial<EffortJobDetail> = {}): EffortJobDetail => ({
  jobId: 'job-effort',
  nextCursor: null,
  requests: [
    request({
      requestId: 'req-responses',
      attempts: [
        {
          attempt: 1,
          sent: { reasoning: { effort: 'low' } },
          reported: { reasoning: { effort: 'low' } },
          result: 'complete',
        },
      ],
    }),
  ],
  ...overrides,
});

const operator = () => ({
  status: 200,
  json: { signedIn: true, account: { login: 'operator' }, operator: true },
});

test('shows a completed Responses request, its sent and reported effort, and expands details', async ({
  page,
  harness,
  base,
}) => {
  harness.setSession(operator());
  harness.setHandler((url) => {
    if (url.pathname === '/api/jobs/run-effort/effort-details') return ok(page1());
    if (url.pathname === '/api/jobs/run-effort') return ok(detail);
    return { status: 404 };
  });
  await page.goto(base + '/jobs/run-effort');

  await expect(page.getByTestId('effort-selection')).toContainText(responsesRoute);
  await page.getByTestId('load-effort-details').click();

  const requestRow = page.getByTestId('effort-request-req-responses');
  await expect(requestRow).toContainText(responsesRoute);
  await expect(requestRow).toContainText('Complete');
  await expect(requestRow).toContainText('configured low');
  const final = page.getByTestId('effort-final-req-responses');
  await expect(final).toContainText('Attempt 1');
  await expect(final).toContainText('Sent');
  await expect(final).toContainText('reasoning.effort=low');
  await expect(final).toContainText('Reported');
  await expect(requestRow).not.toContainText('Record incomplete');
  await expect(requestRow).not.toContainText('crash');
  await expect(requestRow).not.toContainText('No fallback');

  await expect(page.getByTestId('effort-request-id-req-responses')).toBeHidden();
  await page.getByTestId('effort-toggle-req-responses').click();
  await expect(page.getByTestId('effort-request-id-req-responses')).toHaveText('req-responses');
});

test('distinguishes a completed Chat request whose upstream omits effort', async ({
  page,
  harness,
  base,
}) => {
  harness.setSession(operator());
  harness.setHandler((url) => {
    if (url.pathname === '/api/jobs/run-effort/effort-details')
      return ok(
        page1({
          requests: [
            request({
              requestId: 'req-chat',
              route: chatRoute,
              selected: 'high',
              attempts: [
                {
                  attempt: 1,
                  sent: { reasoning_effort: 'high' },
                  reported: null,
                  result: 'complete',
                },
              ],
            }),
          ],
        }),
      );
    if (url.pathname === '/api/jobs/run-effort') return ok(detail);
    return { status: 404 };
  });
  await page.goto(base + '/jobs/run-effort');
  await page.getByTestId('load-effort-details').click();

  const requestRow = page.getByTestId('effort-request-req-chat');
  await expect(requestRow).toContainText('Complete');
  await expect(requestRow).toContainText('reasoning_effort=high');
  await expect(requestRow).toContainText('Not reported by upstream');
  await expect(requestRow).not.toContainText('Record incomplete');
  await expect(requestRow).not.toContainText('Attempt detail not recorded');
});

test('shows a completed historical record without attempt evidence as neutral', async ({
  page,
  harness,
  base,
}) => {
  harness.setSession(operator());
  harness.setHandler((url) => {
    if (url.pathname === '/api/jobs/run-effort/effort-details')
      return ok(
        page1({
          requests: [
            request({
              requestId: 'req-historical',
              status: 'complete',
              attempts: [],
            }),
          ],
        }),
      );
    if (url.pathname === '/api/jobs/run-effort') return ok(detail);
    return { status: 404 };
  });
  await page.goto(base + '/jobs/run-effort');
  await page.getByTestId('load-effort-details').click();

  const requestRow = page.getByTestId('effort-request-req-historical');
  await expect(requestRow).toContainText('Complete');
  const empty = page.getByTestId('effort-empty-attempts-req-historical');
  await expect(empty).toContainText('Attempt detail not recorded');
  await expect(requestRow).not.toContainText('Record incomplete');
  await expect(requestRow).not.toContainText('crash');
});

test('separates incomplete records, missing attempt evidence and pending requests', async ({
  page,
  harness,
  base,
}) => {
  harness.setSession(operator());
  harness.setHandler((url) => {
    if (url.pathname === '/api/jobs/run-effort/effort-details')
      return ok(
        page1({
          requests: [
            request({
              requestId: 'req-incomplete-attempt',
              route: chatRoute,
              status: 'incomplete',
              selected: 'high',
              attempts: [
                {
                  attempt: 1,
                  sent: { reasoning_effort: 'high' },
                  reported: null,
                  result: 'incomplete',
                },
              ],
            }),
            request({
              requestId: 'req-incomplete-empty',
              status: 'incomplete',
              attempts: [],
            }),
            request({
              requestId: 'req-pending',
              status: 'pending',
              attempts: [],
            }),
          ],
        }),
      );
    if (url.pathname === '/api/jobs/run-effort') return ok(detail);
    return { status: 404 };
  });
  await page.goto(base + '/jobs/run-effort');
  await page.getByTestId('load-effort-details').click();

  const interrupted = page.getByTestId('effort-request-req-incomplete-attempt');
  await expect(interrupted).toContainText('Incomplete');
  await expect(page.getByTestId('effort-final-req-incomplete-attempt')).toContainText(
    'Interrupted',
  );
  await expect(page.getByTestId('effort-final-req-incomplete-attempt')).toContainText(
    'reasoning_effort=high',
  );

  const missing = page.getByTestId('effort-request-req-incomplete-empty');
  await expect(missing).toContainText('Incomplete');
  await expect(page.getByTestId('effort-empty-attempts-req-incomplete-empty')).toContainText(
    'No attempt record',
  );

  const pending = page.getByTestId('effort-request-req-pending');
  await expect(pending).toContainText('Pending');
  await expect(page.getByTestId('effort-empty-attempts-req-pending')).toContainText(
    'No completion record',
  );
  await expect(page.getByTestId('effort-empty-attempts-req-pending')).not.toContainText(
    'still in progress',
  );
});

test('shows a Chat fallback and an upstream effort that differs from what was sent', async ({
  page,
  harness,
  base,
}) => {
  harness.setSession(operator());
  harness.setHandler((url) => {
    if (url.pathname === '/api/jobs/run-effort/effort-details')
      return ok(
        page1({
          requests: [
            request({
              requestId: 'req-fallback',
              route: chatRoute,
              selected: 'minimal',
              fallback: 'switched',
              reason: 'upstream rejected reasoning_effort',
              attempts: [
                {
                  attempt: 1,
                  sent: { reasoning_effort: 'minimal' },
                  reported: null,
                  result: 'rejected',
                },
                { attempt: 2, sent: null, reported: null, result: 'complete' },
              ],
            }),
            request({
              requestId: 'req-differs',
              route: chatRoute,
              selected: 'high',
              attempts: [
                {
                  attempt: 1,
                  sent: { reasoning_effort: 'high' },
                  reported: { reasoning_effort: 'max' },
                  result: 'complete',
                },
              ],
            }),
          ],
        }),
      );
    if (url.pathname === '/api/jobs/run-effort') return ok(detail);
    return { status: 404 };
  });
  await page.goto(base + '/jobs/run-effort');
  await page.getByTestId('load-effort-details').click();

  const fallback = page.getByTestId('effort-request-req-fallback');
  await expect(fallback).toContainText('Switched to upstream default');
  const reason = fallback.getByText(/upstream rejected reasoning_effort/);
  await expect(reason).toBeHidden();
  const final = page.getByTestId('effort-final-req-fallback');
  await expect(final).toContainText('Attempt 2');
  await expect(final).toContainText('No allowlisted effort recorded');
  await page.getByTestId('effort-toggle-req-fallback').click();
  await expect(reason).toBeVisible();
  await expect(page.getByTestId('effort-attempt-req-fallback-1')).toContainText('Rejected');
  await expect(page.getByTestId('effort-attempt-req-fallback-1')).toContainText(
    'reasoning_effort=minimal',
  );
  await expect(page.getByTestId('effort-attempt-req-fallback-2')).toContainText('Complete');

  const differs = page.getByTestId('effort-request-req-differs');
  await expect(differs).toContainText('reasoning_effort=high');
  await expect(differs).toContainText('reasoning_effort=max');
  await expect(page.getByTestId('effort-final-req-differs')).toContainText('Differs from sent');
});

test('filters request details by route and resets pagination', async ({ page, harness, base }) => {
  harness.setSession(operator());
  const asked: string[] = [];
  harness.setHandler((url) => {
    if (url.pathname === '/api/jobs/run-effort/effort-details') {
      asked.push(url.pathname + url.search);
      if (url.searchParams.get('route') === responsesRoute)
        return ok(page1({ requests: [request({ requestId: 'req-responses' })] }));
      return ok(
        page1({
          nextCursor: 'next-page',
          requests: [request({ requestId: 'req-chat', route: chatRoute, selected: 'high' })],
        }),
      );
    }
    if (url.pathname === '/api/jobs/run-effort') return ok(detail);
    return { status: 404 };
  });
  await page.goto(base + '/jobs/run-effort');
  await page.getByTestId('load-effort-details').click();

  await expect(page.getByTestId('effort-request-req-chat')).toBeVisible();
  const filter = page.getByTestId('effort-route-filter');
  await expect(filter.locator('option')).toHaveCount(3);
  await filter.selectOption(responsesRoute);
  await expect(page.getByTestId('effort-request-req-responses')).toBeVisible();
  await expect(page.getByTestId('effort-request-req-chat')).toHaveCount(0);
  await expect(page.getByTestId('load-more-effort-details')).toHaveCount(0);
  expect(asked).toEqual([
    '/api/jobs/run-effort/effort-details',
    '/api/jobs/run-effort/effort-details?route=' + encodeURIComponent(responsesRoute),
  ]);

  await filter.selectOption('');
  await expect(page.getByTestId('effort-request-req-chat')).toBeVisible();
  await expect(page.getByTestId('effort-request-req-responses')).toHaveCount(0);
  expect(asked.at(-1)).toBe('/api/jobs/run-effort/effort-details');
});

test('resets loaded request details when drawer navigation changes the task', async ({
  page,
  harness,
  base,
}) => {
  harness.setSession(operator());
  const first = publicTask('run-a', { identity: publicIdentity() });
  const second = publicTask('run-b', { identity: publicIdentity() });
  const withEfforts = (task: typeof first) => ({
    ...detailData(task),
    efforts: {
      selection: [{ route: chatRoute, name: 'high', generation: 0 }],
      summary: null,
    },
  });
  const row = (requestId: string) =>
    page1({
      requests: [
        request({
          requestId,
          route: chatRoute,
          selected: 'high',
          attempts: [
            {
              attempt: 1,
              sent: { reasoning_effort: 'high' },
              reported: null,
              result: 'complete',
            },
          ],
        }),
      ],
    });
  harness.setHandler((url) => {
    if (url.pathname === '/api/jobs/run-a/effort-details') return ok(row('request-a'));
    if (url.pathname === '/api/jobs/run-b/effort-details') return ok(row('request-b'));
    if (url.pathname === '/api/jobs/run-a') return ok(withEfforts(first));
    if (url.pathname === '/api/jobs/run-b') return ok(withEfforts(second));
    if (url.pathname === '/api/jobs') return ok(historyPage([first, second]));
    return { status: 404 };
  });
  await page.goto(base + '/history');
  await page.click('[data-testid="task-link"][data-run-id="run-a"]');
  await page.getByTestId('load-effort-details').click();
  await expect(page.getByTestId('effort-request-request-a')).toBeVisible();
  await page.click('[data-testid="task-link"][data-run-id="run-b"]');
  await expect(page.getByTestId('load-effort-details')).toBeVisible();
  await expect(page.getByTestId('effort-request-request-a')).toHaveCount(0);
  await page.getByTestId('load-effort-details').click();
  await expect(page.getByTestId('effort-request-request-b')).toBeVisible();
});

test('ignores a late reply from the previous run in a reused drawer', async ({
  page,
  harness,
  base,
}) => {
  harness.setSession(operator());
  const first = publicTask('run-a', { identity: publicIdentity() });
  const second = publicTask('run-b', { identity: publicIdentity() });
  const deferredA: { release?: (payload: ApiPayload) => void } = {};
  const pendingA = new Promise<ApiPayload>((resolve) => {
    deferredA.release = resolve;
  });
  harness.setHandler((url) => {
    if (url.pathname === '/api/jobs/run-a/effort-details') return { promise: pendingA };
    if (url.pathname === '/api/jobs/run-b/effort-details')
      return ok(
        page1({
          requests: [request({ requestId: 'request-b', route: chatRoute, selected: 'high' })],
        }),
      );
    if (url.pathname === '/api/jobs/run-a') return ok(detailData(first));
    if (url.pathname === '/api/jobs/run-b') return ok(detailData(second));
    if (url.pathname === '/api/jobs') return ok(historyPage([first, second]));
    return { status: 404 };
  });
  await page.goto(base + '/history');
  await page.click('[data-testid="task-link"][data-run-id="run-a"]');
  await page.getByTestId('load-effort-details').click();
  await page.click('[data-testid="task-link"][data-run-id="run-b"]');
  await page.getByTestId('load-effort-details').click();
  await expect(page.getByTestId('effort-request-request-b')).toBeVisible();

  deferredA.release?.(
    ok(
      page1({
        requests: [
          request({
            requestId: 'request-a',
            route: chatRoute,
            selected: 'high',
          }),
        ],
      }),
    ),
  );
  await expect(page.getByTestId('effort-request-request-b')).toBeVisible();
  await expect(page.getByTestId('effort-request-request-a')).toHaveCount(0);
});

test('keeps the compact request view readable in a narrow drawer and on the page', async ({
  page,
  harness,
  base,
}) => {
  harness.setSession(operator());
  const narrow = publicTask('run-narrow', { identity: publicIdentity() });
  const longRoute = 'openai-platform/gpt-6.1-terra-with-a-very-long-route-suffix';
  const narrowDetail = {
    ...detailData(narrow),
    efforts: {
      selection: [
        { route: longRoute, name: 'low', generation: 0 },
        { route: chatRoute, name: 'high', generation: 0 },
      ],
      summary: null,
    },
  };
  const narrowRequests = page1({
    requests: [
      request({
        requestId: 'request-with-a-long-identifier-for-wrapping',
        route: longRoute,
        attempts: [
          {
            attempt: 1,
            sent: { reasoning: { effort: 'low' } },
            reported: { reasoning: { effort: 'max' } },
            result: 'complete',
          },
        ],
      }),
    ],
  });
  harness.setHandler((url) => {
    if (url.pathname === '/api/jobs/run-narrow/effort-details') return ok(narrowRequests);
    if (url.pathname === '/api/jobs/run-narrow') return ok(narrowDetail);
    if (url.pathname === '/api/jobs') return ok(historyPage([narrow]));
    return { status: 404 };
  });

  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto(base + '/history');
  await page.click('[data-testid="task-link"][data-run-id="run-narrow"]');
  await page.getByTestId('load-effort-details').click();
  await expect(page.getByTestId('effort-route-filter')).toBeVisible();
  await page.getByTestId('effort-toggle-request-with-a-long-identifier-for-wrapping').click();
  await expect(
    page.getByTestId('effort-request-id-request-with-a-long-identifier-for-wrapping'),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(1);

  await page.setViewportSize({ width: 524, height: 900 });
  await page.goto(base + '/jobs/run-narrow');
  await page.getByTestId('load-effort-details').click();
  await expect(page.getByTestId('effort-route-filter')).toBeVisible();
  await expect(
    page.getByTestId('effort-final-request-with-a-long-identifier-for-wrapping'),
  ).toContainText('Differs from sent');
  await page.getByTestId('effort-toggle-request-with-a-long-identifier-for-wrapping').click();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(1);
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
  await expect(page.getByTestId('effort-selection')).toBeVisible();
  await expect(page.getByTestId('load-effort-details')).toHaveCount(0);
});
