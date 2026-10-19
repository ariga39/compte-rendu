import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import adapter from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';
import { mdsvex } from 'mdsvex';
import rehypeSlug from 'rehype-slug';
import type { Plugin } from 'vite';
import { defineConfig } from 'vite-plus';

const stripCarbonRemoteFontFaces = (): Plugin => ({
  name: 'strip-carbon-remote-font-faces',
  enforce: 'pre',
  load(id) {
    const [file] = id.split('?');
    if (!file.includes('carbon-components-svelte/css/') || !file.endsWith('.css')) return null;
    return readFileSync(file, 'utf8').replace(/@font-face\s*\{[^}]*\}/g, '');
  },
});

const cloudflareAdapter = adapter({
  config: 'wrangler.build.jsonc',
  platformProxy: { configPath: 'wrangler.build.jsonc' },
});

const commitSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

export default defineConfig(async () => ({
  define: { __COMMIT_SHA__: JSON.stringify(commitSha) },
  plugins: [
    stripCarbonRemoteFontFaces(),
    ...(await sveltekit({
      adapter: {
        ...cloudflareAdapter,
        async adapt(builder) {
          // Browser interaction fixtures use SvelteKit's generated client shell.
          // It is outside the deployed assets; workerd tests exercise real SSR.
          await builder.generateFallback('.svelte-kit/client-shell.html');
          await cloudflareAdapter.adapt(builder);
        },
      },
      prerender: { entries: [] },
      extensions: ['.svelte', '.md'],
      preprocess: [mdsvex({ extensions: ['.md'], rehypePlugins: [rehypeSlug] })],
    })),
  ],
}));
