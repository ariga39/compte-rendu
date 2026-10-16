import { fetchJson, PollError, type ApiResult } from './api';

export type DashboardError = 'unavailable' | 'offline' | 'notfound' | null;

export interface DashboardOptions<T> {
  key: () => string;
  urls: () => string[];
  build: (results: ApiResult[], timing: { dispatchAt: number; observedAt: number }) => T;
  isActive: (value: T) => boolean;
  detail?: boolean;
}

export interface Dashboard<T> {
  readonly data: T | null;
  readonly error: DashboardError;
  readonly lastGoodAt: number;
  readonly loading: boolean;
  refresh: () => void;
}

const POLL_ACTIVE_MS = 15000;
const POLL_IDLE_MS = 60000;
const REQUEST_TIMEOUT_MS = 15000;
const MAX_BACKOFF_MS = 300000;

export function createDashboard<T>(options: DashboardOptions<T>): Dashboard<T> {
  let data = $state<T | null>(null);
  let error = $state<DashboardError>(null);
  let lastGoodAt = $state(0);
  let loading = $state(true);

  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;
  let nextAllowedAt = 0;
  let generation = 0;

  function clearTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function abort() {
    if (controller) {
      controller.abort();
      controller = null;
    }
  }

  function cleanup() {
    generation += 1;
    abort();
    clearTimer();
  }

  function pause() {
    return document.hidden || navigator.onLine === false;
  }

  function schedule(active: boolean) {
    clearTimer();
    if (pause()) return;
    const base =
      failures > 0
        ? Math.min(MAX_BACKOFF_MS, 30000 * 2 ** (failures - 1))
        : active
          ? POLL_ACTIVE_MS
          : POLL_IDLE_MS;
    let delay = base + base * Math.random() * 0.1;
    if (nextAllowedAt) delay = Math.max(delay, nextAllowedAt - Date.now());
    timer = setTimeout(() => void run(), Math.max(0, delay));
  }

  async function run() {
    clearTimer();
    if (pause()) return;
    if (controller) return;
    if (nextAllowedAt && Date.now() < nextAllowedAt) {
      schedule(false);
      return;
    }
    const local = new AbortController();
    controller = local;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      local.abort();
    }, REQUEST_TIMEOUT_MS);
    const localGeneration = ++generation;
    const dispatchAt = performance.now();
    try {
      const results = await Promise.all(options.urls().map((url) => fetchJson(url, local.signal)));
      if (localGeneration !== generation) return;
      const observedAt = performance.now();
      controller = null;
      clearTimeout(timeout);
      const failed = results.filter((result) => !result.ok);
      if (failed.length) {
        if (options.detail && results[0]?.status === 404) {
          data = null;
          error = 'notfound';
          loading = false;
          return;
        }
        const retryAfterMs = failed.reduce((max, result) => Math.max(max, result.retryAfterMs), 0);
        throw new PollError(retryAfterMs);
      }
      const candidate = options.build(results, { dispatchAt, observedAt });
      failures = 0;
      nextAllowedAt = 0;
      lastGoodAt = Date.now();
      error = null;
      loading = false;
      data = candidate;
      schedule(options.isActive(candidate));
    } catch (caught) {
      if (localGeneration !== generation) return;
      controller = null;
      clearTimeout(timeout);
      const cancelled = local.signal.aborted && !timedOut;
      local.abort();
      if (cancelled) return;
      failures += 1;
      if (caught instanceof PollError && caught.retryAfterMs) {
        nextAllowedAt = Date.now() + caught.retryAfterMs;
      }
      error = navigator.onLine === false ? 'offline' : 'unavailable';
      loading = false;
      schedule(false);
    }
  }

  function refresh() {
    void run();
  }

  $effect(() => {
    options.key();
    options.urls();
    cleanup();
    data = null;
    error = null;
    loading = true;
    void run();
    return cleanup;
  });

  $effect(() => {
    const onVisible = () => {
      if (!document.hidden) void run();
    };
    const onOnline = () => void run();
    const onOffline = () => cleanup();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  });

  return {
    get data() {
      return data;
    },
    get error() {
      return error;
    },
    get lastGoodAt() {
      return lastGoodAt;
    },
    get loading() {
      return loading;
    },
    refresh,
  };
}

export interface ExpiryClock {
  readonly now: number;
  schedule: (deadlines: number[]) => void;
  clear: () => void;
}

export function createExpiryClock(): ExpiryClock {
  let now = $state(performance.now());
  let timer: ReturnType<typeof setTimeout> | null = null;
  let deadlines: number[] = [];

  function earliestAfter(current: number): number {
    let soonest = Infinity;
    for (const deadline of deadlines) {
      if (deadline > current && deadline < soonest) soonest = deadline;
    }
    return soonest;
  }

  function clear() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    deadlines = [];
  }

  function arm() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const current = performance.now();
    now = current;
    const soonest = earliestAfter(current);
    if (soonest === Infinity) return;
    timer = setTimeout(arm, Math.max(0, soonest - current + 1));
  }

  function schedule(next: number[]) {
    deadlines = next;
    arm();
  }

  $effect(() => () => clear());

  return {
    get now() {
      return now;
    },
    schedule,
    clear,
  };
}
