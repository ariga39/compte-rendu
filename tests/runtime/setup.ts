/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { applyD1Migrations, env } from 'cloudflare:test';
import migrations from './.generated/migrations.mjs';

await applyD1Migrations(env.REVIEW_DB, migrations);
