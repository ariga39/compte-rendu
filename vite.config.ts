import { defineConfig } from 'vite-plus';

export default defineConfig({
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
    // Selected from ultracite/oxlint/core (8.3.1).
    rules: {
      'typescript/await-thenable': 'error',
      'typescript/no-floating-promises': 'error',
      'typescript/no-misused-spread': 'error',
      'typescript/switch-exhaustiveness-check': 'error',
    },
  },
  fmt: {
    semi: true,
    singleQuote: true,
  },
});
