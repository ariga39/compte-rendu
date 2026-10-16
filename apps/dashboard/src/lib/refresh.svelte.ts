import { getContext, setContext } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';

export interface RefreshRegistration {
  lastGoodAt: number;
  refresh: () => void;
  priority: number;
}

export interface RefreshHandle {
  register: (owner: symbol, registration: RefreshRegistration) => void;
  unregister: (owner: symbol) => void;
}

export interface RefreshState {
  readonly active: boolean;
  readonly lastGoodAt: number;
  refresh: () => void;
}

const KEY = Symbol('dashboard:refresh-controls');

export function createRefreshState(): { state: RefreshState; handle: RefreshHandle } {
  const registrations = new SvelteMap<symbol, RefreshRegistration>();
  const current = $derived(
    [...registrations.values()].sort((left, right) => right.priority - left.priority)[0] ?? null,
  );

  const handle: RefreshHandle = {
    register(owner, registration) {
      registrations.set(owner, registration);
    },
    unregister(owner) {
      registrations.delete(owner);
    },
  };

  const state: RefreshState = {
    get active() {
      return current !== null;
    },
    get lastGoodAt() {
      return current?.lastGoodAt ?? 0;
    },
    refresh() {
      current?.refresh();
    },
  };

  return { state, handle };
}

export function provideRefresh(handle: RefreshHandle): void {
  setContext(KEY, handle);
}

export function useRefresh(): RefreshHandle | null {
  return getContext<RefreshHandle | undefined>(KEY) ?? null;
}
