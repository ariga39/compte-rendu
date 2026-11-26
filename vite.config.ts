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
  },
  fmt: {
    // Preserve vendored license texts byte-for-byte.
    ignorePatterns: ['apps/runner/skills/*/LICENSE.md'],
    semi: true,
    singleQuote: true,
  },
});
