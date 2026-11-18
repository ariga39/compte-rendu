/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { applyD1Migrations, env } from 'cloudflare:test';
import migrations from './.generated/inference/migrations.mjs';

await applyD1Migrations(env.RELAY_DB, migrations);

const route = env.RELAY_DB.prepare(
  `INSERT OR REPLACE INTO catalog_routes
  (route_id, upstream_model, provider_slug, credential_alias)
  VALUES (?, ?, ?, ?)`,
);
for (const routeId of ['deepseek-review', 'step-review', 'other-review']) {
  await route.bind(routeId, `${routeId}-native`, 'review-provider', 'review-alias').run();
}
