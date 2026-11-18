/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { applyD1Migrations, env } from 'cloudflare:test';
import migrations from './.generated/inference/migrations.mjs';

await applyD1Migrations(env.RELAY_DB, migrations);
