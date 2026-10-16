<script lang="ts">
  import '../app.css';
  import { page } from '$app/state';

  let { children } = $props();

  let path = $derived(page.url.pathname);
  let isOverview = $derived(path === '/');
  let isHistory = $derived(path === '/history');
</script>

<div class="mx-auto max-w-[1180px] px-5 py-7 pb-16">
  <header class="mb-11 flex items-center justify-between gap-5">
    <a class="font-extrabold tracking-wide text-ink" href="/">
      COMPTE RENDU<small class="mt-0.5 block font-medium tracking-normal text-muted-ink">Public review ledger</small>
    </a>
    <nav class="flex gap-[18px]" aria-label="Primary">
      <a href="/" aria-current={isOverview ? 'page' : undefined} class={isOverview ? 'font-bold text-ink' : ''}>Overview</a>
      <a href="/history" aria-current={isHistory ? 'page' : undefined} class={isHistory ? 'font-bold text-ink' : ''}>History</a>
    </nav>
    <div id="announce" class="sr-only" aria-live="polite"></div>
  </header>
  <main id="content">
    {@render children()}
  </main>
</div>
