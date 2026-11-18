<script lang="ts">
  import { QueryClientProvider } from '@tanstack/svelte-query';
  import TaskDetail from '#lib/components/TaskDetail.svelte';
  import { createDashboardQueryClient } from '#lib/query.svelte.ts';

  let { runId, variant }: { runId: string; variant: 'page' | 'drawer' } = $props();
  const client = createDashboardQueryClient();
</script>

<QueryClientProvider {client}>
  <div class:detail-pane={variant === 'drawer'} style:max-width={variant === 'drawer' ? '32rem' : undefined}>
    <TaskDetail {runId} {variant} />
  </div>
</QueryClientProvider>
