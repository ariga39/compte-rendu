import { defineConfig } from 'vite-plus';

export default defineConfig({
  build: {
    lib: { entry: 'src/server.ts', formats: ['es'], fileName: 'llm-service' },
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: { external: [/^node:/] },
  },
});
