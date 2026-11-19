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
    cloudflareTest({
      wrangler: { configPath: 'tests/runtime/application.wrangler.jsonc' },
      miniflare: {
        bindings: {
          DASHBOARD_ORIGIN: 'https://reviews.test',
          DASHBOARD_GITHUB_CLIENT_ID: 'test-client',
          DASHBOARD_GITHUB_CLIENT_SECRET: 'test-secret',
        },
        outboundService(request) {
          if (
            request.url === 'https://github.com/login/oauth/access_token' &&
            request.method === 'POST'
          )
            return Response.json({
              access_token: 'ghu_test',
              token_type: 'bearer',
              scope: '',
              expires_in: 28800,
            });
          return new Response(null, { status: 404 });
        },
      },
    }),
  ],
  test: { include: ['tests/runtime/ssr.test.ts'], setupFiles: ['tests/runtime/setup.ts'] },
});
