import { defineConfig } from 'vite-plus';

export default defineConfig({
  resolve: {
    conditions: ['workerd'],
  },
  build: {
    lib: {
      entry: 'src/worker.ts',
      formats: ['es'],
      fileName: 'worker',
    },
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      external: ['cloudflare:workers'],
    },
  },
});
