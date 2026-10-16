import { pushState, replaceState } from '$app/navigation';
import { page } from '$app/state';

let savedScroll: number | null = null;

export function selectedTaskId(): string | null {
  const value = page.state.selectedTask;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function openTask(runId: string): void {
  if (selectedTaskId() === null) {
    void pushState(page.url.href, { ...page.state, selectedTask: runId });
  } else {
    void replaceState(page.url.href, { ...page.state, selectedTask: runId });
  }
}

export function recordListScroll(): void {
  savedScroll = typeof window === 'undefined' ? null : window.scrollY;
}

export function closeTask(): void {
  if (selectedTaskId() === null) return;
  history.back();
}

export function restoreListPosition(runId: string): void {
  requestAnimationFrame(() => {
    const link = document.querySelector<HTMLElement>(
      `[data-testid="task-link"][data-run-id="${CSS.escape(runId)}"]`,
    );
    link?.focus({ preventScroll: true });
    if (savedScroll !== null) {
      window.scrollTo(0, savedScroll);
      savedScroll = null;
    }
  });
}
