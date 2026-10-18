<script lang="ts">
  import 'carbon-components-svelte/css/g100.css';
  import '@fontsource/ibm-plex-mono/400.css';
  import '@fontsource/ibm-plex-mono/500.css';
  import '@fontsource/ibm-plex-mono/600.css';
  import '@fontsource/ibm-plex-mono/700.css';
  import '../app.css';
  import { QueryClientProvider, onlineManager } from '@tanstack/svelte-query';
  import { Button, Content, Header, HeaderNav, HeaderNavItem } from 'carbon-components-svelte';
  import { page } from '$app/state';
  import { absoluteTime } from '#lib/format.ts';
  import { createDashboardQueryClient, installFocusTracking } from '#lib/query.svelte.ts';
  import { createRefreshState, provideRefresh } from '#lib/refresh.svelte.ts';

  let { children, data } = $props();

  installFocusTracking();
  const queryClient = createDashboardQueryClient();

  $effect(() => {
    const unsubscribe = onlineManager.subscribe((online) => {
      if (!online) void queryClient.cancelQueries({ queryKey: ['dashboard'] });
    });
    return unsubscribe;
  });

  const links = [
    ['/', 'Overview'],
    ['/history', 'History'],
    ['/help', 'Help'],
  ] as const;

  let path = $derived(page.url.pathname);

  const refresh = createRefreshState();
  provideRefresh(refresh.handle);
</script>

<svelte:head>
  <title>{path === "/help" ? "Help | " : ""}{data.reviewName}</title>
</svelte:head>

<a class="skip-link" href="#content" data-testid="skip-link">Skip to content</a>

<Header uiShellAriaLabel={data.reviewName}>
  <a class="bx--header__name" href="/">{data.reviewName}</a>
  <HeaderNav aria-label="Primary">
    {#each links as [href, label] (href)}
      <HeaderNavItem {href} text={label} isSelected={path === href} />
    {/each}
  </HeaderNav>
  {#if refresh.state.active}
    <div class="header-refresh">
      <span data-testid="last-refresh" class="muted">
        Last updated: {refresh.state.lastGoodAt
          ? absoluteTime(new Date(refresh.state.lastGoodAt).toISOString())
          : 'not yet'}
      </span>
      <Button
        kind="ghost"
        size="field"
        data-testid="refresh"
        on:click={() => refresh.state.refresh()}
      >
        Refresh now
      </Button>
    </div>
  {/if}
  <div id="announce" class="sr-only" aria-live="polite"></div>
</Header>

<Content id="content" tabindex={-1}>
  <QueryClientProvider client={queryClient}>
    {@render children()}
  </QueryClientProvider>
</Content>

<footer class="app-footer">
  <a href="https://github.com/ariga39/compte-rendu" target="_blank" rel="noopener noreferrer">Compte-rendu</a>
  <a
    data-testid="commit-link"
    href={`https://github.com/ariga39/compte-rendu/commit/${__COMMIT_SHA__}`}
    target="_blank"
    rel="noopener noreferrer"
    title={__COMMIT_SHA__}
  >
    {__COMMIT_SHA__.slice(0, 7)}
  </a>
</footer>
