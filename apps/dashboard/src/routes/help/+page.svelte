<script lang="ts">
  import Help from '#lib/content/help.md';
</script>

<svelte:head>
  <title>Help | Compte rendu</title>
</svelte:head>

<article class="help">
  <Help />
</article>

<style>
  .help {
    max-width: 860px;
    margin: 0 auto;
    color: #f4f4f4;
  }
  .help :global(h1) {
    font-size: 1.4rem;
    font-weight: 600;
    margin: 0 0 16px;
  }
  .help :global(h2) {
    font-size: 1.1rem;
    font-weight: 600;
    margin: 28px 0 8px;
    scroll-margin-top: 4rem;
  }
  .help :global(p) {
    color: #c6c6c6;
    margin: 0 0 12px;
    overflow-wrap: anywhere;
  }
  .help :global(ul) {
    list-style: disc;
    padding-left: 20px;
    margin: 12px 0;
    color: #c6c6c6;
  }
  .help :global(li) {
    margin: 4px 0;
    overflow-wrap: anywhere;
  }
  .help :global(a) {
    color: #78a9ff;
  }
  .help :global(strong) {
    color: #f4f4f4;
  }
</style>
