import { test as base, expect, type Page } from '@playwright/test';
import { startHarness, type Harness as ServerHarness } from './fixture-server.ts';
export type { ApiHandler, ApiPayload } from './fixture-server.ts';

interface Harness extends ServerHarness {
  waitFor(predicate: () => boolean, timeoutMs?: number): Promise<void>;
}

const pageGate = async (page: Page, run: () => Promise<void>) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (/Failed to load resource/i.test(text)) return;
    errors.push(text);
  });
  await run();
  expect(errors, `browser errors: ${errors.join(' | ')}`).toEqual([]);
};

interface DashboardFixtures {
  harness: Harness;
  base: string;
  consoleGate: void;
}

export const test = base.extend<DashboardFixtures>({
  consoleGate: [
    async ({ page }, use) => {
      await pageGate(page, () => use());
    },
    { auto: true },
  ],
  // Playwright requires the fixture dependencies argument to be destructured even when unused.
  // eslint-disable-next-line no-empty-pattern
  harness: async ({}, use) => {
    const started = await startHarness();
    await use({
      ...started.harness,
      async waitFor(predicate, timeoutMs = 6000) {
        await expect.poll(predicate, { timeout: timeoutMs, intervals: [20, 50, 100] }).toBe(true);
      },
    });
    await new Promise<void>((resolveClose) => {
      started.server.closeAllConnections();
      started.server.close(() => resolveClose());
    });
  },
  base: async ({ harness }, use) => {
    await use(harness.base);
  },
});

export { expect };
