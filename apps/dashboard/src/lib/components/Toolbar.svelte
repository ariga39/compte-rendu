<script lang="ts">
  import { onDestroy } from 'svelte';
  import { useRefresh } from '#lib/refresh.svelte.ts';

  let {
    lastGoodAt,
    onRefresh,
    priority = 0,
  }: { lastGoodAt: number; onRefresh: () => void; priority?: number } = $props();

  const handle = useRefresh();
  const owner = Symbol('refresh-toolbar');

  $effect(() => {
    handle?.register(owner, { lastGoodAt, refresh: onRefresh, priority });
  });

  onDestroy(() => handle?.unregister(owner));
</script>
