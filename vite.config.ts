import { defineConfig } from 'vite-plus';
import { reviewContractBundle } from './scripts/review-contract-bundle.mts';

export default defineConfig({
  plugins: [reviewContractBundle()],
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/runtime/**'],
  },
  lint: {
    ignorePatterns: [
      'dist/**',
      'node_modules/**',
      'apps/dashboard/.svelte-kit/**',
      'apps/dashboard/build/**',
    ],
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {
    semi: true,
    singleQuote: true,
  },
});
