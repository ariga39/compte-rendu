<script lang="ts">
  import { Button } from 'carbon-components-svelte';
  import { absoluteTime } from '#lib/format.ts';

  let { lastGoodAt, onRefresh }: { lastGoodAt: number; onRefresh: () => void } = $props();
</script>

<div class="toolbar">
  <span data-testid="last-refresh" class="muted">
    Last updated: {lastGoodAt ? absoluteTime(new Date(lastGoodAt).toISOString()) : 'not yet'}
  </span>
  <Button size="small" data-testid="refresh" on:click={onRefresh}>Refresh now</Button>
</div>
