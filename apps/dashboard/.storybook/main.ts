import type { StorybookConfig } from '@storybook/svelte-vite';
import { fileURLToPath } from 'node:url';

export default {
  framework: {
    name: '@storybook/svelte-vite',
    options: {
      builder: { viteConfigPath: fileURLToPath(new URL('./vite.config.ts', import.meta.url)) },
    },
  },
  stories: ['../stories/*.stories.ts'],
} satisfies StorybookConfig;
