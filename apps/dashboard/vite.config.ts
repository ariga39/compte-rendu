import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { mdsvex } from 'mdsvex';
import rehypeSlug from 'rehype-slug';
import { defineConfig } from 'vite-plus';

export default defineConfig(async () => ({
  plugins: [
    tailwindcss(),
    ...(await sveltekit({
      adapter: adapter({ fallback: 'index.html', strict: false }),
      prerender: { entries: [] },
      extensions: ['.svelte', '.md'],
      preprocess: [mdsvex({ extensions: ['.md'], rehypePlugins: [rehypeSlug] })],
    })),
  ],
}));
