import sveltekit from './.svelte-kit/cloudflare/_worker.js';
import { runScheduledMetadataRefresh } from '../core/src/core-worker';
import type { ApplicationEnv } from './src/lib/server/application';

export default {
  fetch: sveltekit.fetch,
  async scheduled(_controller: unknown, env: ApplicationEnv): Promise<void> {
    await runScheduledMetadataRefresh(env);
  },
};
