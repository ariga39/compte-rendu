import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'vite-plus';
import { defineConfig } from 'vitest/config';

const outputDirectory = resolve('tests/runtime/.generated/inference');

await build({
  configFile: false,
  root: process.cwd(),
  resolve: {
    conditions: ['workerd'],
  },
  build: {
    lib: {
      entry: resolve('apps/inference-worker/src/worker.ts'),
      formats: ['es'],
      fileName: 'inference-worker',
    },
    outDir: outputDirectory,
    emptyOutDir: true,
    rollupOptions: {
      external: ['cloudflare:workers'],
    },
  },
});

await mkdir(outputDirectory, { recursive: true });
const migrations = await readD1Migrations(resolve('apps/inference-worker/migrations'));
await writeFile(
  resolve(outputDirectory, 'migrations.mjs'),
  `export default ${JSON.stringify(migrations)};\n`,
);

const workerPoolOptions = {
  wrangler: {
    configPath: 'tests/runtime/inference.wrangler.jsonc',
  },
  miniflare: {
    workers: [
      {
        name: 'compte-rendu-inference-worker',
        scriptPath: resolve(outputDirectory, 'inference-worker.mjs'),
        modules: true,
        compatibilityDate: '2026-08-22',
        d1Databases: { RELAY_DB: 'compte-rendu-inference-test' },
      },
    ],
  },
};

export default defineConfig({
  plugins: [cloudflareTest(workerPoolOptions)],
  test: {
    name: 'inference-worker-runtime',
    include: ['tests/runtime/inference-runtime.test.ts'],
    setupFiles: ['tests/runtime/inference-setup.ts'],
  },
});
