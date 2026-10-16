<script lang="ts">
  import TaskDetail from './TaskDetail.svelte';
  import { openTask } from '#lib/task-drawer.svelte.ts';

  let {
    runId,
    taskIds,
    onClose,
  }: { runId: string; taskIds: string[]; onClose: () => void } = $props();

  let narrow = $state(false);
  let root = $state<HTMLElement | null>(null);

  $effect(() => {
    const query = window.matchMedia('(max-width: 1100px)');
    const update = () => {
      narrow = query.matches;
    };
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  });

  const index = $derived(taskIds.indexOf(runId));
  const nav = $derived({
    hasPrev: index > 0,
    hasNext: index >= 0 && index < taskIds.length - 1,
    prev: () => {
      if (index > 0) openTask(taskIds[index - 1]!);
    },
    next: () => {
      if (index >= 0 && index < taskIds.length - 1) openTask(taskIds[index + 1]!);
    },
  });

  function focusInside() {
    if (root === null) return;
    const target =
      root.querySelector<HTMLElement>('[data-testid="detail-close"]') ??
      root.querySelector<HTMLElement>('a[href], button:not([disabled])');
    target?.focus({ preventScroll: true });
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (!narrow || event.key !== 'Tab' || root === null) return;
    const focusable = root.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (!root.contains(document.activeElement)) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  $effect(() => {
    if (root === null) return;
    focusInside();
  });

  $effect(() => {
    if (!narrow || root === null) return;
    focusInside();
  });
</script>

<svelte:window onkeydown={onKeydown} />

<aside
  bind:this={root}
  class="detail-pane"
  class:narrow
  data-testid="detail-drawer"
  role={narrow ? 'dialog' : 'region'}
  aria-modal={narrow ? 'true' : undefined}
  aria-label="Review detail"
>
  <TaskDetail {runId} variant="drawer" {onClose} nav={nav} />
</aside>
