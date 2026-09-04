import { defineConfig } from 'vite-plus';

export default defineConfig({
  resolve: {
    conditions: ['workerd'],
  },
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
      external: ['cloudflare:workers'],
    },
  },
});
