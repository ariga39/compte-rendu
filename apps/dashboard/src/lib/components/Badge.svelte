<script lang="ts">
  import type { BadgeTone } from '#lib/format.ts';
  import type { Snippet } from 'svelte';

  let { tone = 'muted', children }: { tone?: BadgeTone; children: Snippet } = $props();

  const toneClass: Record<BadgeTone, string> = {
    info: 'text-blue',
    good: 'text-accent',
    bad: 'text-danger',
    warn: 'text-warn',
    muted: 'text-muted-ink',
  };
</script>

<span
  class="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-panel-2 px-2.5 py-1 text-xs {toneClass[tone]}"
>
  <span class="h-1.5 w-1.5 rounded-full bg-current"></span>
  {@render children()}
</span>
