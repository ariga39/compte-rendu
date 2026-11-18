<script lang="ts">
  import { QueryClientProvider } from '@tanstack/svelte-query';
  import TaskDetail from '#lib/components/TaskDetail.svelte';
  import TaskDrawer from '#lib/components/TaskDrawer.svelte';
  import { createDashboardQueryClient } from '#lib/query.svelte.ts';

  let { runId, variant }: { runId: string; variant: 'page' | 'drawer' } = $props();
  const client = createDashboardQueryClient();
  let view = $derived<'page' | 'drawer' | 'closed'>(variant);

  function followPreviewLink(event: MouseEvent) {
    const link = event.target instanceof Element && event.target.closest('a');
    if (!link || ![location.origin + '/jobs/' + runId, location.origin + '/history'].includes(link.href)) return;
    event.preventDefault();
    view = link.pathname === '/history' ? 'closed' : 'page';
  }
</script>

<svelte:window onclick={followPreviewLink} />
<QueryClientProvider {client}>
  {#if view === 'page'}
    <TaskDetail {runId} />
  {:else}
    <div class="list-detail" class:with-detail={view === 'drawer'}>
      <div><button onclick={() => view = 'drawer'}>Open review</button></div>
      {#if view === 'drawer'}
        <TaskDrawer {runId} taskIds={[runId]} onSelect={() => view = 'drawer'} onClose={() => view = 'closed'} />
      {/if}
    </div>
  {/if}
</QueryClientProvider>
