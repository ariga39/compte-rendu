<script lang="ts">
  import '../app.css';
  import { page } from '$app/state';

  let { children } = $props();

  const links = [
    ['/', 'Overview'],
    ['/history', 'History'],
    ['/help', 'Help'],
  ] as const;

  let path = $derived(page.url.pathname);
  let contextTitle = $derived(
    path === '/'
      ? 'Overview'
      : path === '/history'
        ? 'History'
        : path === '/help'
          ? 'Help'
          : path.startsWith('/jobs/')
            ? 'Review details'
            : 'Overview',
  );
</script>

<a class="skip-link" href="#content" data-testid="skip-link">Skip to content</a>

<div class="app-shell">
  <aside class="sidebar">
    <a class="brand" href="/">
      Compte rendu<small>Review dashboard</small>
    </a>
    <nav aria-label="Primary">
      {#each links as [href, label] (href)}
        <a class="nav-link" {href} aria-current={path === href ? 'page' : undefined}>{label}</a>
      {/each}
    </nav>
  </aside>
  <div class="app-main">
    <header class="contextbar">
      <span class="context-title">{contextTitle}</span>
      <div id="announce" class="sr-only" aria-live="polite"></div>
    </header>
    <main id="content" tabindex="-1">
      {@render children()}
    </main>
  </div>
</div>
