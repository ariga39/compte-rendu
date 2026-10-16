<script lang="ts">
  import { Tag } from 'carbon-components-svelte';
  import type { BadgeTone } from '#lib/format.ts';
  import type { Snippet } from 'svelte';

  let { tone = 'muted', children }: { tone?: BadgeTone; children: Snippet } = $props();

  const tagType: Record<BadgeTone, 'blue' | 'green' | 'red' | 'gray' | 'magenta'> = {
    info: 'blue',
    good: 'green',
    bad: 'red',
    warn: 'magenta',
    muted: 'gray',
  };
</script>

<Tag type={tagType[tone]}>{@render children()}</Tag>
