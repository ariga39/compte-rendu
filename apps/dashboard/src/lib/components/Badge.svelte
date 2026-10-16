<script lang="ts">
  import type { BadgeTone } from '#lib/format.ts';
  import type { Snippet } from 'svelte';

  let { tone = 'muted', children }: { tone?: BadgeTone; children: Snippet } = $props();
</script>

<span class="badge badge--{tone}">
  {@render children()}
</span>
