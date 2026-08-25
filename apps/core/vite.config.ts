import { defineConfig } from 'vite-plus';

export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
      fileName: 'index',
    },
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      external: ['@cloudflare/sandbox', 'cloudflare:workers'],
    },
  },
});
