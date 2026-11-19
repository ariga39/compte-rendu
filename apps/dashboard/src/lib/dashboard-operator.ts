import { getContext, setContext } from 'svelte';

export type OperatorGetter = () => boolean;
export type ViewerRefresh = () => Promise<void>;

const KEY = Symbol('dashboard:operator');
const REFRESH_KEY = Symbol('dashboard:viewer-refresh');

const anonymous: OperatorGetter = () => false;
const noRefresh: ViewerRefresh = async () => undefined;

/** Provide the signed-in viewer's operator capability to descendant controls. */
export function provideOperator(
  getter: OperatorGetter,
  refreshViewer: ViewerRefresh = noRefresh,
): void {
  setContext(KEY, getter);
  setContext(REFRESH_KEY, refreshViewer);
}

/**
 * Read the viewer's operator capability. Anonymous readers, including the
 * Storybook preview, default to no operator controls.
 */
export function useOperator(): OperatorGetter {
  return getContext<OperatorGetter | undefined>(KEY) ?? anonymous;
}

/**
 * Refresh the header's private viewer state after a protected operation
 * discovers that the session or allowlist changed.
 */
export function useViewerRefresh(): ViewerRefresh {
  return getContext<ViewerRefresh | undefined>(REFRESH_KEY) ?? noRefresh;
}
