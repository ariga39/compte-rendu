import sveltekit from './.svelte-kit/cloudflare/_worker.js';
import { runApplicationScheduled } from './src/lib/server/application';

export default {
  fetch: sveltekit.fetch,
  scheduled: runApplicationScheduled,
};
