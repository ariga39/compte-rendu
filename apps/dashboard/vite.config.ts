import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite-plus';

export default defineConfig(async () => ({
  plugins: [
    tailwindcss(),
    ...(await sveltekit({
      adapter: adapter({ fallback: 'index.html', strict: false }),
      prerender: { entries: [] },
    })),
  ],
}));
