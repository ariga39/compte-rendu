import { defineConfig } from 'vite-plus';

export default defineConfig({
  build: {
    lib: {
      entry: 'src/server.ts',
      formats: ['es'],
      fileName: 'runner',
    },
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      external: [/^node:/],
    },
  },
});
