import { expect, test } from './fixtures';

test('changes the selected models and keeps a conflicting edit visible', async ({
  page,
  harness,
  base,
}) => {
  harness.setHandler((url, req) => {
    if (url.pathname !== '/api/model-settings') return { status: 404 };
    if (req.method === 'PUT') return { status: 409, json: { error: 'stale' } };
    return {
      status: 200,
      json: {
        routes: ['review/a', 'review/b'],
        configuration: {
          revision: 2,
          selection: { reviewers: ['review/a'], synthesis: 'review/a' },
        },
      },
    };
  });
  await page.goto(base + '/settings');
  await page.getByLabel('review/b', { exact: true }).check();
  await page.getByLabel('Synthesis model').selectOption('review/b');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('alert')).toContainText('changed');
  await expect(page.getByLabel('review/b', { exact: true })).toBeChecked();
});

test('saves a desired Runner concurrency and omits an untouched field', async ({
  page,
  harness,
  base,
}) => {
  harness.setHandler((url, req) => {
    if (url.pathname !== '/api/model-settings') return { status: 404 };
    if (req.method === 'PUT') return { status: 200, json: { revision: 3 } };
    return {
      status: 200,
      json: {
        routes: ['review/a'],
        configuration: {
          revision: 2,
          selection: { reviewers: ['review/a'], synthesis: 'review/a' },
          concurrency: 2,
        },
      },
    };
  });
  await page.goto(base + '/settings');
  await expect(page.getByLabel('Runner concurrency')).toHaveValue('2');

  const untouched = page.waitForRequest((request) => request.method() === 'PUT');
  await page.getByRole('button', { name: 'Save changes' }).click();
  expect((await untouched).postDataJSON()).toEqual({
    revision: 2,
    selection: { reviewers: ['review/a'], synthesis: 'review/a' },
  });

  await page.getByLabel('Runner concurrency').fill('4');
  const changed = page.waitForRequest((request) => request.method() === 'PUT');
  await page.getByRole('button', { name: 'Save changes' }).click();
  expect((await changed).postDataJSON()).toEqual({
    revision: 2,
    concurrency: 4,
  });
});

test('clears the desired Runner concurrency back to the startup fallback', async ({
  page,
  harness,
  base,
}) => {
  harness.setHandler((url, req) => {
    if (url.pathname !== '/api/model-settings') return { status: 404 };
    if (req.method === 'PUT') return { status: 200, json: { revision: 3 } };
    return {
      status: 200,
      json: {
        routes: ['review/a'],
        configuration: {
          revision: 2,
          selection: { reviewers: ['review/a'], synthesis: 'review/a' },
          concurrency: 3,
        },
      },
    };
  });
  await page.goto(base + '/settings');
  await page.getByLabel('Runner concurrency').fill('');
  const saved = page.waitForRequest((request) => request.method() === 'PUT');
  await page.getByRole('button', { name: 'Save changes' }).click();
  expect((await saved).postDataJSON()).toEqual({
    revision: 2,
    concurrency: null,
  });
});

test('rejects a non-integer desired Runner concurrency', async ({ page, harness, base }) => {
  harness.setHandler(() => ({
    status: 200,
    json: {
      routes: ['review/a'],
      configuration: {
        revision: 2,
        selection: { reviewers: ['review/a'], synthesis: 'review/a' },
        concurrency: 2,
      },
    },
  }));
  await page.goto(base + '/settings');
  await page.getByLabel('Runner concurrency').fill('1.5');
  await expect(page.getByRole('alert')).toContainText('positive whole number');
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeDisabled();
});

test('changes only concurrency when the catalog is unavailable', async ({
  page,
  harness,
  base,
}) => {
  harness.setHandler((url, req) => {
    if (url.pathname !== '/api/model-settings') return { status: 404 };
    if (req.method === 'PUT') return { status: 200, json: { revision: 2 } };
    return {
      status: 200,
      json: {
        routes: [],
        catalogUnavailable: true,
        catalogRefreshFailed: false,
        lastAttemptAt: null,
        configuration: {
          revision: 1,
          selection: { reviewers: ['review/a'], synthesis: 'review/a' },
          concurrency: 2,
        },
      },
    };
  });
  await page.goto(base + '/settings');
  await expect(page.getByText('The model catalog is unavailable')).toBeVisible();
  await expect(page.getByLabel('Runner concurrency')).toHaveValue('2');
  await page.getByLabel('Runner concurrency').fill('3');
  await expect(page.getByTestId('concurrency-only')).toBeVisible();
  const saved = page.waitForRequest((request) => request.method() === 'PUT');
  await page.getByRole('button', { name: 'Save changes' }).click();
  expect((await saved).postDataJSON()).toEqual({ revision: 1, concurrency: 3 });
});

test('changes only concurrency when the saved selection is no longer in the catalog', async ({
  page,
  harness,
  base,
}) => {
  harness.setHandler((url, req) => {
    if (url.pathname !== '/api/model-settings') return { status: 404 };
    if (req.method === 'PUT') return { status: 200, json: { revision: 2 } };
    return {
      status: 200,
      json: {
        routes: ['review/a'],
        efforts: { 'review/a': [{ name: 'high', controls: { reasoning_effort: 'high' } }] },
        lastAttemptAt: new Date(100).toISOString(),
        catalogRefreshFailed: false,
        configuration: {
          revision: 1,
          selection: {
            reviewers: ['review/a', 'review/retired'],
            synthesis: 'review/retired',
            efforts: { 'review/retired': 'removed' },
          },
          concurrency: 2,
        },
      },
    };
  });
  await page.goto(base + '/settings');
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  await page.getByLabel('Runner concurrency').fill('4');
  await expect(page.getByTestId('concurrency-only')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeEnabled();
  const saved = page.waitForRequest((request) => request.method() === 'PUT');
  await page.getByRole('button', { name: 'Save changes' }).click();
  expect((await saved).postDataJSON()).toEqual({ revision: 1, concurrency: 4 });
});

test('changes only concurrency when one reviewer keeps a dormant synthesis effort', async ({
  page,
  harness,
  base,
}) => {
  harness.setHandler((url, req) => {
    if (url.pathname !== '/api/model-settings') return { status: 404 };
    if (req.method === 'PUT') return { status: 200, json: { revision: 2 } };
    return {
      status: 200,
      json: {
        routes: ['review/a', 'review/b'],
        lastAttemptAt: new Date(100).toISOString(),
        catalogRefreshFailed: false,
        configuration: {
          revision: 1,
          selection: {
            reviewers: ['review/a'],
            synthesis: 'review/b',
            efforts: { 'review/b': 'high' },
          },
          concurrency: 2,
        },
      },
    };
  });
  await page.goto(base + '/settings');
  await expect(page.getByLabel('Thinking effort for review/b')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeEnabled();
  await page.getByLabel('Runner concurrency').fill('4');
  const saved = page.waitForRequest((request) => request.method() === 'PUT');
  await page.getByRole('button', { name: 'Save changes' }).click();
  expect((await saved).postDataJSON()).toEqual({ revision: 1, concurrency: 4 });
});

test('saves an explicit selection when switching from the instance default', async ({
  page,
  harness,
  base,
}) => {
  harness.setHandler((url, req) => {
    if (url.pathname !== '/api/model-settings') return { status: 404 };
    if (req.method === 'PUT') return { status: 200, json: { revision: 3 } };
    return {
      status: 200,
      json: { routes: ['review/a', 'review/b'], configuration: { revision: 2, selection: null } },
    };
  });
  await page.goto(base + '/settings');
  await page.getByLabel('Use the instance default').uncheck();
  await page.getByLabel('review/a', { exact: true }).check();
  await page.getByLabel('Synthesis model').selectOption('review/b');
  await expect(page.getByLabel('Thinking effort for review/a')).toBeVisible();
  await expect(page.getByLabel('Thinking effort for review/b')).toHaveCount(0);
  const sent = page.waitForRequest((request) => request.method() === 'PUT');
  await page.getByRole('button', { name: 'Save changes' }).click();
  expect((await sent).postDataJSON()).toEqual({
    revision: 2,
    selection: { reviewers: ['review/a'], synthesis: 'review/b' },
  });
  await expect(page.getByRole('status')).toContainText('Saved.');
});

test('explains when the account is not authorized and shows no editor', async ({
  page,
  harness,
  base,
}) => {
  harness.setHandler(() => ({
    status: 403,
    json: {
      error: 'This GitHub account is not authorized to edit review models.',
    },
  }));
  await page.goto(base + '/settings');
  await expect(
    page.getByText('This GitHub account is not authorized to edit review models.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
});

test('explains stale choices and lets the editor replace a retired synthesis model', async ({
  page,
  harness,
  base,
}) => {
  harness.setHandler(() => ({
    status: 200,
    json: {
      catalogRefreshFailed: true,
      routes: ['review/a'],
      configuration: {
        revision: 3,
        selection: { reviewers: ['review/a'], synthesis: 'review/retired' },
      },
    },
  }));
  await page.goto(base + '/settings');
  await expect(page.getByRole('status')).toContainText('refresh');
  const synthesis = page.getByLabel('Synthesis model');
  await expect(synthesis).toHaveValue('review/retired');
  await expect(synthesis.locator('option:checked')).toHaveText('review/retired (unavailable)');
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  await synthesis.selectOption('review/a');
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeEnabled();
});

test('shows an empty provider list after the last model is withdrawn', async ({
  page,
  harness,
  base,
}) => {
  harness.setHandler(() => ({
    status: 200,
    json: {
      routes: [],
      lastAttemptAt: new Date(100).toISOString(),
      catalogRefreshFailed: false,
      configuration: { revision: 1, selection: null },
    },
  }));
  await page.goto(base + '/settings');
  await expect(page.getByRole('status')).toHaveText('No models are currently listed.');
});

test('selects a per-route effort, saves it, shows the fallback marker and resets it', async ({
  page,
  harness,
  base,
}) => {
  let reset = false;
  harness.setHandler((url, req) => {
    if (url.pathname === '/api/model-settings/effort-reset' && req.method === 'POST') {
      reset = true;
      return { status: 200, json: { revision: 3 } };
    }
    if (url.pathname !== '/api/model-settings') return { status: 404 };
    if (req.method === 'PUT') return { status: 200, json: { revision: 3 } };
    return {
      status: 200,
      json: {
        routes: ['review/a'],
        efforts: { 'review/a': [{ name: 'high', controls: { reasoning_effort: 'high' } }] },
        effortStates: reset
          ? []
          : [
              {
                routeId: 'review/a',
                generation: 0,
                fallbackAt: '2026-10-16T12:00:00.000Z',
                reason: 'upstream rejected reasoning_effort',
              },
            ],
        configuration: {
          revision: 2,
          selection: { reviewers: ['review/a'], synthesis: 'review/a' },
        },
      },
    };
  });
  await page.goto(base + '/settings');
  await expect(page.getByTestId('effort-fallback-review/a')).toContainText(
    'using upstream default',
  );
  await page.getByLabel('Thinking effort for review/a').selectOption('high');
  const saved = page.waitForRequest((request) => request.method() === 'PUT');
  await page.getByRole('button', { name: 'Save changes' }).click();
  expect((await saved).postDataJSON()).toEqual({
    revision: 2,
    selection: {
      reviewers: ['review/a'],
      synthesis: 'review/a',
      efforts: { 'review/a': 'high' },
    },
  });
  const resetRequest = page.waitForRequest((request) =>
    request.url().endsWith('/api/model-settings/effort-reset'),
  );
  await page.getByTestId('effort-reset-review/a').click();
  expect((await resetRequest).postDataJSON()).toEqual({ revision: 2, route: 'review/a' });
  await expect(page.getByTestId('effort-fallback-review/a')).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText('re-enabled');
});

test('shows a saved effort that is no longer in the catalog and blocks saving', async ({
  page,
  harness,
  base,
}) => {
  harness.setHandler(() => ({
    status: 200,
    json: {
      routes: ['review/a'],
      efforts: { 'review/a': [{ name: 'high', controls: { reasoning_effort: 'high' } }] },
      configuration: {
        revision: 4,
        selection: {
          reviewers: ['review/a'],
          synthesis: 'review/a',
          efforts: { 'review/a': 'removed' },
        },
      },
    },
  }));
  await page.goto(base + '/settings');
  await expect(page.getByRole('alert')).toContainText('no longer available');
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  await page.getByLabel('Thinking effort for review/a').selectOption('high');
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeEnabled();
});

test('warns when the same effort name maps to different controls and adopts it only on save', async ({
  page,
  harness,
  base,
}) => {
  let resaved = false;
  harness.setHandler((url, req) => {
    if (url.pathname !== '/api/model-settings') return { status: 404 };
    if (req.method === 'PUT') {
      resaved = true;
      return { status: 200, json: { revision: 5 } };
    }
    return {
      status: 200,
      json: {
        routes: ['review/a'],
        efforts: { 'review/a': [{ name: 'high', controls: { reasoning_effort: 'low' } }] },
        effortDrift: resaved ? [] : ['review/a'],
        configuration: {
          revision: 4,
          selection: {
            reviewers: ['review/a'],
            synthesis: 'review/a',
            efforts: { 'review/a': 'high' },
          },
        },
      },
    };
  });
  await page.goto(base + '/settings');
  await expect(page.getByTestId('effort-drift')).toContainText('changed since this selection');
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeEnabled();
  const saved = page.waitForRequest((request) => request.method() === 'PUT');
  await page.getByRole('button', { name: 'Save changes' }).click();
  expect((await saved).postDataJSON()).toMatchObject({
    selection: { efforts: { 'review/a': 'high' } },
  });
  await expect(page.getByTestId('effort-drift')).toHaveCount(0);
});

test('distinguishes an uninitialized catalog from a complete empty list', async ({
  page,
  harness,
  base,
}) => {
  harness.setHandler(() => ({
    status: 200,
    json: {
      routes: [],
      lastAttemptAt: null,
      catalogRefreshFailed: false,
      configuration: { revision: 0, selection: null },
    },
  }));
  await page.goto(base + '/settings');
  await expect(page.getByRole('status')).toHaveText('Waiting for the first model list refresh.');
});
