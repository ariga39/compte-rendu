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
          DASHBOARD_MODEL_EDITOR_IDS: '[42]',
          DASHBOARD_GITHUB_CLIENT_ID: 'test-client',
          DASHBOARD_GITHUB_CLIENT_SECRET: 'test-secret',
        },
        serviceBindings: { INFERENCE_RELAY: { name: 'settings-test-relay' } },
        workers: [
          {
            name: 'settings-test-relay',
            modules: true,
            compatibilityDate: '2026-08-22',
            script: `import { WorkerEntrypoint } from 'cloudflare:workers';
            export default class extends WorkerEntrypoint { catalog() { return { routes: ['review/a'] }; } }`,
          },
        ],
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
          if (
            request.url === 'https://api.github.com/user' &&
            request.headers.get('authorization') === 'Bearer ghu_test'
          )
            return Response.json({ id: 42 });
          return new Response(null, { status: 404 });
        },
      },
    }),
  ],
  test: { include: ['tests/runtime/ssr.test.ts'], setupFiles: ['tests/runtime/setup.ts'] },
});
