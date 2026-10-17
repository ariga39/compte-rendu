import { createQuery } from '@tanstack/svelte-query';
import { fetchJson, NotFoundError, PollError, type ApiResult } from './api';
import { isPageVisible } from './query.svelte';

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
  let statsKey = '';
  let settledKey = '';
  let failures = 0;
  let jitter = 0;
  let nextAllowedAt = 0;

  function beginAttempt(key: string) {
    if (statsKey === key) return;
    statsKey = key;
    failures = 0;
    jitter = 0;
    nextAllowedAt = 0;
  }

  const query = createQuery<T>(() => {
    const key = options.key();
    return {
      queryKey: ['dashboard', key],
      enabled: isPageVisible() || settledKey === key,
      queryFn: async ({ signal }) => {
        beginAttempt(key);
        const urls = options.urls();
        const dispatchAt = performance.now();
        const controller = new AbortController();
        const onAbort = () => controller.abort(signal.reason);
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
        let timedOut = false;
        const timeout = setTimeout(() => {
          timedOut = true;
          controller.abort(new Error('request-timeout'));
        }, REQUEST_TIMEOUT_MS);
        let countedFailure = false;
        try {
          const results = await Promise.all(urls.map((url) => fetchJson(url, controller.signal)));
          const observedAt = performance.now();
          const failed = results.filter((result) => !result.ok);
          if (failed.length) {
            if (options.detail && results[0]?.status === 404) throw new NotFoundError();
            const retryAfterMs = failed.reduce(
              (max, result) => Math.max(max, result.retryAfterMs),
              0,
            );
            if (options.key() === key) {
              settledKey = key;
              failures += 1;
              jitter = Math.random() * 0.1;
              countedFailure = true;
              if (retryAfterMs) nextAllowedAt = Date.now() + retryAfterMs;
            }
            throw new PollError(retryAfterMs);
          }
          const candidate = options.build(results, { dispatchAt, observedAt });
          if (options.key() === key) {
            settledKey = key;
            failures = 0;
            jitter = Math.random() * 0.1;
            nextAllowedAt = 0;
          }
          return candidate;
        } catch (caught) {
          controller.abort(caught);
          const cancelled = signal.aborted && !timedOut;
          if (!cancelled && options.key() === key) {
            settledKey = key;
            if (!countedFailure) {
              jitter = Math.random() * 0.1;
              if (!(caught instanceof NotFoundError)) failures += 1;
            }
          }
          throw caught;
        } finally {
          clearTimeout(timeout);
          signal.removeEventListener('abort', onAbort);
        }
      },
      retry: false,
      staleTime: 0,
      gcTime: 0,
      refetchIntervalInBackground: false,
      refetchInterval: (activeQuery) => {
        if (activeQuery.state.error instanceof NotFoundError) return false;
        const currentFailures = statsKey === options.key() ? failures : 0;
        let base = POLL_IDLE_MS;
        if (currentFailures > 0)
          base = Math.min(MAX_BACKOFF_MS, 30000 * 2 ** (currentFailures - 1));
        else if (activeQuery.state.data !== undefined && options.isActive(activeQuery.state.data))
          base = POLL_ACTIVE_MS;
        let delay = base + base * jitter;
        const remaining = statsKey === options.key() ? nextAllowedAt - Date.now() : 0;
        if (remaining > 0) delay = Math.max(delay, remaining);
        return delay;
      },
      refetchOnWindowFocus: (activeQuery) =>
        isPageVisible() &&
        !(activeQuery.state.error instanceof NotFoundError) &&
        !(options.key() === key && Date.now() < nextAllowedAt),
      refetchOnReconnect: (activeQuery) =>
        isPageVisible() &&
        !(activeQuery.state.error instanceof NotFoundError) &&
        !(options.key() === key && Date.now() < nextAllowedAt),
    };
  });

  return {
    get data() {
      return query.error instanceof NotFoundError ? null : (query.data ?? null);
    },
    get error() {
      if (query.error instanceof NotFoundError) return 'notfound';
      if (!query.error) return null;
      return navigator.onLine === false ? 'offline' : 'unavailable';
    },
    get lastGoodAt() {
      return query.dataUpdatedAt;
    },
    get loading() {
      return query.isPending;
    },
    refresh() {
      if (document.hidden || navigator.onLine === false) return;
      if (statsKey === options.key() && Date.now() < nextAllowedAt) return;
      void query.refetch({ cancelRefetch: false });
    },
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
