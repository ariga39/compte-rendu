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
