import { getContext, setContext } from 'svelte';

export interface RefreshHandle {
  set: (lastGoodAt: number, refresh: () => void) => void;
  clear: () => void;
}

export interface RefreshState {
  readonly active: boolean;
  readonly lastGoodAt: number;
  refresh: () => void;
}

const KEY = Symbol('dashboard:refresh-controls');

export function createRefreshState(): { state: RefreshState; handle: RefreshHandle } {
  let active = $state(false);
  let lastGoodAt = $state(0);
  let refresh = () => {};

  const handle: RefreshHandle = {
    set(nextLastGoodAt, nextRefresh) {
      lastGoodAt = nextLastGoodAt;
      refresh = nextRefresh;
      active = true;
    },
    clear() {
      active = false;
      refresh = () => {};
    },
  };

  const state: RefreshState = {
    get active() {
      return active;
    },
    get lastGoodAt() {
      return lastGoodAt;
    },
    refresh() {
      refresh();
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
