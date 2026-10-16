<script lang="ts">
  import 'carbon-components-svelte/css/g100.css';
  import '@fontsource/ibm-plex-mono/400.css';
  import '@fontsource/ibm-plex-mono/500.css';
  import '@fontsource/ibm-plex-mono/600.css';
  import '@fontsource/ibm-plex-mono/700.css';
  import '../app.css';
  import { Content, Header, HeaderNav, HeaderNavItem } from 'carbon-components-svelte';
  import { page } from '$app/state';

  let { children } = $props();

  const links = [
    ['/', 'Overview'],
    ['/history', 'History'],
    ['/help', 'Help'],
  ] as const;

  let path = $derived(page.url.pathname);
</script>

<a class="skip-link" href="#content" data-testid="skip-link">Skip to content</a>

<Header>
  <a class="bx--header__name" href="/">Compte rendu</a>
  <HeaderNav aria-label="Primary">
    {#each links as [href, label] (href)}
      <HeaderNavItem {href} text={label} isSelected={path === href} />
    {/each}
  </HeaderNav>
  <div id="announce" class="sr-only" aria-live="polite"></div>
</Header>

<Content id="content" tabindex={-1}>
  {@render children()}
</Content>
