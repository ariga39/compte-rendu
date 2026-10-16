<script lang="ts">
  import Help from '#lib/content/help.md';
</script>

<svelte:head>
  <title>Help | Compte rendu</title>
</svelte:head>

<article class="help mx-auto max-w-[860px]">
  <Help />
</article>

<style>
  .help :global(h1) {
    font-size: clamp(1.6rem, 3.2vw, 2.35rem);
    font-weight: 800;
    letter-spacing: -0.03em;
    margin: 6px 0 16px;
  }
  .help :global(h2) {
    font-size: 1.25rem;
    font-weight: 700;
    margin: 2.25rem 0 0.75rem;
    scroll-margin-top: 1.5rem;
  }
  .help :global(p) {
    color: var(--color-muted-ink);
    margin: 0 0 0.75rem;
    overflow-wrap: anywhere;
  }
  .help :global(ul) {
    list-style: disc;
    padding-left: 1.25rem;
    margin: 0.75rem 0;
    color: var(--color-muted-ink);
  }
  .help :global(li) {
    margin: 0.25rem 0;
    overflow-wrap: anywhere;
  }
  .help :global(a) {
    color: var(--color-accent);
  }
  .help :global(strong) {
    color: var(--color-ink);
  }
</style>
