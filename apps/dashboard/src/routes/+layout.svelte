<script lang="ts">
  import '../app.css';
  import { page } from '$app/state';

  let { children } = $props();

  let path = $derived(page.url.pathname);
  let isOverview = $derived(path === '/');
  let isHistory = $derived(path === '/history');
  let isHelp = $derived(path === '/help');
</script>

<div class="mx-auto max-w-[1180px] px-5 py-7 pb-16">
  <header class="mb-11 flex flex-wrap items-center justify-between gap-x-5 gap-y-3">
    <a class="font-extrabold tracking-wide text-ink" href="/">
      COMPTE RENDU<small class="mt-0.5 block font-medium tracking-normal text-muted-ink">Public review ledger</small>
    </a>
    <nav class="flex flex-wrap gap-[18px]" aria-label="Primary">
      <a href="/" aria-current={isOverview ? 'page' : undefined} class={isOverview ? 'font-bold text-ink' : ''}>Overview</a>
      <a href="/history" aria-current={isHistory ? 'page' : undefined} class={isHistory ? 'font-bold text-ink' : ''}>History</a>
      <a href="/help" aria-current={isHelp ? 'page' : undefined} class={isHelp ? 'font-bold text-ink' : ''}>Help</a>
    </nav>
    <div id="announce" class="sr-only" aria-live="polite"></div>
  </header>
  <main id="content">
    {@render children()}
  </main>
</div>
