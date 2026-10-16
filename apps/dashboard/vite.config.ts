import { readFileSync } from 'node:fs';
import adapter from '@sveltejs/adapter-static';
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

export default defineConfig(async () => ({
  plugins: [
    stripCarbonRemoteFontFaces(),
    ...(await sveltekit({
      adapter: adapter({ fallback: 'index.html', strict: false }),
      prerender: { entries: [] },
      extensions: ['.svelte', '.md'],
      preprocess: [mdsvex({ extensions: ['.md'], rehypePlugins: [rehypeSlug] })],
    })),
  ],
}));
