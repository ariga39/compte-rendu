<script lang="ts">
  import { absoluteTime } from '#lib/format.ts';

  let { lastGoodAt, onRefresh }: { lastGoodAt: number; onRefresh: () => void } = $props();
</script>

<div class="toolbar">
  <span data-testid="last-refresh" class="muted">
    Last updated: {lastGoodAt ? absoluteTime(new Date(lastGoodAt).toISOString()) : 'not yet'}
  </span>
  <button type="button" data-testid="refresh" class="btn" onclick={onRefresh}>Refresh now</button>
</div>
