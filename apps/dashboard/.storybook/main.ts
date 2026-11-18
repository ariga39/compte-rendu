import type { StorybookConfig } from '@storybook/svelte-vite';
import { fileURLToPath } from 'node:url';

export default {
  framework: '@storybook/svelte-vite',
  stories: ['../stories/*.stories.ts'],
  core: {
    builder: {
      name: '@storybook/builder-vite',
      options: {
        viteConfigPath: fileURLToPath(new URL('./vite.config.ts', import.meta.url)),
      },
    },
  },
} satisfies StorybookConfig;
