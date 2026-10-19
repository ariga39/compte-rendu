import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { mkdir, writeFile } from 'node:fs/promises';
import { defineConfig } from 'vitest/config';
const migrations = await readD1Migrations('apps/core/migrations');
await mkdir('tests/runtime/.generated', { recursive: true });
await writeFile(
  'tests/runtime/.generated/migrations.mjs',
  `export default ${JSON.stringify(migrations)};\n`,
);
export default defineConfig({
  plugins: [
    cloudflareTest({ wrangler: { configPath: 'tests/runtime/application.wrangler.jsonc' } }),
  ],
  test: { include: ['tests/runtime/ssr.test.ts'], setupFiles: ['tests/runtime/setup.ts'] },
});
