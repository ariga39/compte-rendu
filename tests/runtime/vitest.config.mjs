import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { build } from 'vite-plus';
import { defineConfig } from 'vitest/config';

const coreBundleDirectory = resolve('tests/runtime/.generated');

await build({
  configFile: false,
  root: process.cwd(),
  build: {
    lib: {
      entry: resolve('tests/runtime/core-entry.ts'),
      formats: ['es'],
      fileName: 'core-entry',
    },
    outDir: coreBundleDirectory,
    emptyOutDir: true,
    rollupOptions: {
      external: ['cloudflare:workers'],
    },
  },
});

await mkdir(coreBundleDirectory, { recursive: true });
const migrations = await readD1Migrations(resolve('apps/core/migrations'));
await writeFile(
  resolve(coreBundleDirectory, 'migrations.mjs'),
  `export default ${JSON.stringify(migrations)};\n`,
);

const workerPoolOptions = {
  wrangler: {
    configPath: 'tests/runtime/tracer.wrangler.jsonc',
  },
  miniflare: {
    workers: [
      {
        name: 'compte-rendu-tracer-core',
        scriptPath: `${coreBundleDirectory}/core-entry.mjs`,
        modules: true,
        compatibilityDate: '2026-08-22',
        d1Databases: { REVIEW_DB: 'compte-rendu-tracer-review-state' },
        bindings: {
          GITHUB_APP_ID: 'test-app-id',
          GITHUB_APP_PRIVATE_KEY: 'test-private-key',
          RUNNER_AUTH_TOKEN: 'test-runner-token',
        },
        serviceBindings: { RUNNER: 'compte-rendu-tracer-runner-capture' },
      },
      {
        name: 'compte-rendu-tracer-runner-capture',
        scriptPath: 'tests/runtime/runner-capture-entry.mjs',
        modules: true,
        compatibilityDate: '2026-08-22',
      },
    ],
  },
};

export default defineConfig({
  plugins: [cloudflareTest(workerPoolOptions)],
  test: {
    name: 'local-worker-runtime',
    include: ['tests/runtime/tracer-runtime.test.ts'],
    setupFiles: ['tests/runtime/setup.ts'],
  },
});
