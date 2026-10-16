declare const __COMMIT_SHA__: string;

declare module '*.md' {
  import type { Component } from 'svelte';

  const component: Component;
  export default component;
}
