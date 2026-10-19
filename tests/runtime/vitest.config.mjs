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
  resolve: {
    conditions: ['workerd'],
  },
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
