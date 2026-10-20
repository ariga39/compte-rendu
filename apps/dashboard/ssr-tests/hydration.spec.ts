import { expect, test } from '@playwright/test';

test('SSR renders usable content and hydration reuses the query before a browser refresh', async ({
  page,
  request,
}) => {
  const response = await request.get('/');
  expect(response.status()).toBe(200);
  expect(await response.text()).toContain('No reviews in progress or waiting.');
  const errors: string[] = [];
  const requests: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path === '/api/dashboard' || path === '/api/jobs') requests.push(path);
  });
  await page.goto('/');
  await expect(page.getByText('No reviews in progress or waiting.')).toBeVisible();
  // Opening Help and returning proves client hydration/navigation completed.
  await page.getByRole('menuitem', { name: 'Help', exact: true }).click();
  await expect(page).toHaveURL(/\/help$/);
  expect(requests).toEqual([]);
  await page.getByRole('menuitem', { name: 'Overview', exact: true }).click();
  await expect(page.getByText('No reviews in progress or waiting.')).toBeVisible();
  const before = requests.length;
  await page.getByRole('button', { name: 'Refresh now', exact: true }).click();
  await expect.poll(() => requests.length).toBe(before + 1);
  expect(requests).not.toContain('/api/jobs');
  expect(errors).toEqual([]);
});
