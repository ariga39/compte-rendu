<script lang="ts">
  import { Tile } from 'carbon-components-svelte';

  let { label, sub, value }: { label: string; sub: string; value: number } = $props();
</script>

<div class="stat-card" data-testid="stat">
  <Tile>
    <span class="stat-label">{label}</span>
    <strong class="stat-value">{value}</strong>
    <span class="stat-sub">{sub}</span>
  </Tile>
</div>

<style>
  .stat-card,
  .stat-card :global(.bx--tile) {
    height: 100%;
  }
</style>
