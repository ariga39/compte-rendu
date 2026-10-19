import { defineConfig } from 'vite-plus';
import { reviewContractBundle } from '../../scripts/review-contract-bundle.mts';

export default defineConfig({
  plugins: [reviewContractBundle()],
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
