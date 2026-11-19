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
