import { defineConfig } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
execFileSync(
  process.execPath,
  [
    'apps/dashboard/node_modules/wrangler/bin/wrangler.js',
    'd1',
    'migrations',
    'apply',
    'REVIEW_DB',
    '--local',
    '--config',
    'tests/runtime/application.wrangler.jsonc',
  ],
  { cwd: root, stdio: 'pipe' },
);

export default defineConfig({
  testDir: './ssr-tests',
  outputDir: './test-results-ssr',
  workers: 1,
  webServer: {
    command:
      'node apps/dashboard/node_modules/wrangler/bin/wrangler.js dev --local --config tests/runtime/application.wrangler.jsonc --port 4187',
    cwd: root,
    url: 'http://127.0.0.1:4187',
    timeout: 60000,
  },
  use: {
    baseURL: 'http://127.0.0.1:4187',
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH, args: ['--no-sandbox'] },
  },
});
