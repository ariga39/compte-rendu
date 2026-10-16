<script lang="ts">
  import { absoluteTime } from '#lib/format.ts';

  let { lastGoodAt, onRefresh }: { lastGoodAt: number; onRefresh: () => void } = $props();
</script>

<div class="my-[18px] flex flex-wrap items-end justify-between gap-2.5">
  <span data-testid="last-refresh" class="text-muted-ink">
    Last successful refresh: {lastGoodAt ? absoluteTime(new Date(lastGoodAt).toISOString()) : 'not yet'}
  </span>
  <button
    type="button"
    data-testid="refresh"
    class="cursor-pointer rounded-[9px] border border-line bg-panel px-3 py-2 text-ink hover:border-accent"
    onclick={onRefresh}
  >
    Refresh now
  </button>
</div>
