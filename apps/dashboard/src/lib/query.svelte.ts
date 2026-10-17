import { QueryClient, focusManager, onlineManager } from '@tanstack/svelte-query';

let pageVisible = $state(typeof document === 'undefined' ? true : !document.hidden);

export function isPageVisible(): boolean {
  return pageVisible;
}

/**
 * The default TanStack focus listener only observes `visibilitychange` on the
 * window. Visibility events target the document, and the dashboard also
 * refreshes when the window regains focus while already visible, so observe
 * both events and re-evaluate the focus state on every one.
 */
export function installFocusTracking(): void {
  focusManager.setEventListener((handleFocus) => {
    if (typeof document === 'undefined') return;
    const listener = () => {
      pageVisible = !document.hidden;
      handleFocus();
    };
    document.addEventListener('visibilitychange', listener, false);
    window.addEventListener('focus', listener, false);
    return () => {
      document.removeEventListener('visibilitychange', listener);
      window.removeEventListener('focus', listener);
    };
  });
}

export function createDashboardQueryClient(): QueryClient {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    onlineManager.setOnline(false);
  }
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: 0,
        gcTime: 0,
        refetchOnMount: true,
        refetchIntervalInBackground: false,
      },
    },
  });
}
