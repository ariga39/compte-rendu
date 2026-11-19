<script lang="ts">
  import 'carbon-components-svelte/css/g100.css';
  import '@fontsource/ibm-plex-mono/400.css';
  import '@fontsource/ibm-plex-mono/500.css';
  import '@fontsource/ibm-plex-mono/600.css';
  import '@fontsource/ibm-plex-mono/700.css';
  import '../app.css';
  import { QueryClientProvider, onlineManager } from '@tanstack/svelte-query';
  import { Button, Content, Header, HeaderNav, HeaderNavItem } from 'carbon-components-svelte';
  import { Option, Schema } from 'effect';
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { absoluteTime } from '#lib/format.ts';
  import { createDashboardQueryClient, installFocusTracking } from '#lib/query.svelte.ts';
  import { createRefreshState, provideRefresh } from '#lib/refresh.svelte.ts';
  import { provideOperator } from '#lib/dashboard-operator.ts';
  import { DashboardSession } from '#lib/session.ts';

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
    ['/settings', 'Settings'],
  ] as const;

  let path = $derived(page.url.pathname);
  let returnTo = $derived(encodeURIComponent(path + page.url.search));
  let signInHref = $derived('/auth/github?returnTo=' + returnTo);
  let signOutHref = $derived('/auth/logout?returnTo=' + returnTo);

  const anonymous: DashboardSession = { signedIn: false, account: null, operator: false };
  let viewer = $state<DashboardSession | null>(null);

  provideOperator(() => viewer?.operator === true);

  onMount(() => {
    let active = true;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch('/api/session', {
          headers: { accept: 'application/json' },
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!active) return;
        if (!response.ok) {
          viewer = anonymous;
          return;
        }
        const decoded = Schema.decodeUnknownOption(DashboardSession)(await response.json());
        viewer = Option.isSome(decoded) ? decoded.value : anonymous;
      } catch {
        if (active) viewer = anonymous;
      }
    })();
    return () => {
      active = false;
      controller.abort();
    };
  });

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
  <div class="header-actions">
    {#if refresh.state.active}
      <div class="header-refresh">
        <span data-testid="last-refresh" class="muted">
          <span class="refresh-prefix">Last updated:&nbsp;</span>{refresh.state.lastGoodAt
            ? absoluteTime(new Date(refresh.state.lastGoodAt).toISOString())
            : 'not yet'}
        </span>
        <Button
          kind="ghost"
          size="field"
          data-testid="refresh"
          on:click={() => refresh.state.refresh()}
        >
          Refresh<span class="refresh-now">&nbsp;now</span>
        </Button>
      </div>
    {/if}
    <div class="header-account">
      {#if viewer?.signedIn}
        <span class="muted" data-testid="viewer-login">{viewer.account.login}</span>
        <form method="POST" action={signOutHref}>
          <Button kind="ghost" size="field" type="submit" data-testid="sign-out">
            Sign out
          </Button>
        </form>
      {:else}
        <a
          class="bx--btn bx--btn--ghost"
          href={signInHref}
          data-sveltekit-reload
          data-testid="sign-in"
        >
          Sign in with GitHub
        </a>
      {/if}
    </div>
  </div>
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
