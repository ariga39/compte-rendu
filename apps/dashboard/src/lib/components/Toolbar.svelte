<script lang="ts">
  import { onDestroy } from 'svelte';
  import { useRefresh } from '#lib/refresh.svelte.ts';

  let { lastGoodAt, onRefresh }: { lastGoodAt: number; onRefresh: () => void } = $props();

  const handle = useRefresh();

  $effect(() => {
    handle?.set(lastGoodAt, onRefresh);
  });

  onDestroy(() => handle?.clear());
</script>
