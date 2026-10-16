<script lang="ts">
  import { afterNavigate } from '$app/navigation';
  import { page } from '$app/state';
  import TaskDetail from '#lib/components/TaskDetail.svelte';

  const runId = $derived(page.params.runId ?? '');

  let backHref = $state('/history');
  let knownPredecessor = $state(false);

  afterNavigate(({ from }) => {
    const fromUrl = from?.url;
    if (fromUrl && fromUrl.pathname === '/history') {
      backHref = `${fromUrl.pathname}${fromUrl.search}`;
      knownPredecessor = true;
    } else {
      backHref = '/history';
      knownPredecessor = false;
    }
  });

  function onBack(event: MouseEvent) {
    if (!knownPredecessor) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    window.history.back();
  }
</script>

<TaskDetail {runId} variant="page" back={{ href: backHref, onBack }} />
