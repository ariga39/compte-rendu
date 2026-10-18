import { expect, test } from './fixtures';

for (const name of ['Compte-rendu review', 'Ariga39 AI Review']) {
  test(`instance title and project attribution: ${name}`, async ({ page, harness, base }) => {
    harness.setHandler(() => ({ status: 404 }));
    await page.route('**/api/dashboard-config', (route) => route.fulfill({ json: { name } }));
    await page.goto(`${base}/help`);
    await expect(page.locator('.bx--header__name')).toHaveText(name);
    await expect(page).toHaveTitle(`Help | ${name}`);
    const project = page.locator('footer a', { hasText: 'Compte-rendu' });
    await expect(project).toHaveAttribute('href', 'https://github.com/ariga39/compte-rendu');
    await expect(page.getByTestId('commit-link')).toBeVisible();
    await project.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `/tmp/cr-brand-footer-${name.startsWith('Ariga') ? 'custom' : 'default'}.png`,
    });
    await page.setViewportSize({ width: 360, height: 800 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(page.locator('nav a[href="/help"]')).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: `/tmp/cr-brand-${name.startsWith('Ariga') ? 'custom' : 'default'}.png`,
    });
  });
}
