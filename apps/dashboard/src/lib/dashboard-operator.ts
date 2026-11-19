import { getContext, setContext } from 'svelte';

export type OperatorGetter = () => boolean;

const KEY = Symbol('dashboard:operator');

const anonymous: OperatorGetter = () => false;

/** Provide the signed-in viewer's operator capability to descendant controls. */
export function provideOperator(getter: OperatorGetter): void {
  setContext(KEY, getter);
}

/**
 * Read the viewer's operator capability. Anonymous readers, including the
 * Storybook preview, default to no operator controls.
 */
export function useOperator(): OperatorGetter {
  return getContext<OperatorGetter | undefined>(KEY) ?? anonymous;
}
