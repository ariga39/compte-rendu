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
    max-width: 65ch;
    margin: 0 auto;
    color: #f4f4f4;
  }
  .help :global(h1) {
    font-size: 1.75rem;
    font-weight: 600;
    line-height: 1.3;
    margin: 0 0 24px;
  }
  .help :global(h2) {
    font-size: 1.25rem;
    font-weight: 600;
    line-height: 1.3;
    margin: 40px 0 16px;
    scroll-margin-top: 4rem;
  }
  .help :global(p) {
    margin: 0 0 16px;
    line-height: 1.6;
    color: #c6c6c6;
    overflow-wrap: anywhere;
  }
  .help :global(ul),
  .help :global(ol) {
    margin: 0 0 16px;
    padding-left: 24px;
    line-height: 1.6;
    color: #c6c6c6;
  }
  .help :global(ul) {
    list-style: disc;
  }
  .help :global(ol) {
    list-style: decimal;
  }
  .help :global(li) {
    margin: 0 0 8px;
    line-height: 1.6;
    overflow-wrap: anywhere;
  }
  .help :global(li > ul),
  .help :global(li > ol) {
    margin-top: 8px;
  }
  .help :global(a) {
    color: #78a9ff;
  }
  .help :global(strong) {
    color: #f4f4f4;
  }
  .help :global(code) {
    background: #262626;
    padding: 1px 4px;
  }
  .help :global(pre) {
    background: #262626;
    padding: 16px;
    overflow-x: auto;
    line-height: 1.6;
  }
  .help :global(pre code) {
    background: none;
    padding: 0;
  }
</style>
