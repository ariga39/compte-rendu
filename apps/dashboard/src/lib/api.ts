export interface ApiResult {
  ok: boolean;
  status: number;
  data?: unknown;
  retryAfterMs: number;
}

export class PollError extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs = 0) {
    super('poll-failed');
    this.name = 'PollError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class NotFoundError extends Error {
  constructor() {
    super('not-found');
    this.name = 'NotFoundError';
  }
}

export function parseRetryAfter(value: string | null | undefined): number {
  if (!value) return 0;
  const seconds = Number(value);
  if (!Number.isNaN(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const when = Date.parse(value);
  return Number.isNaN(when) ? 0 : Math.max(0, when - Date.now());
}

export async function fetchJson(url: string, signal: AbortSignal): Promise<ApiResult> {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    cache: 'no-store',
    signal,
  });
  if (response.ok) {
    return { ok: true, status: response.status, data: await response.json(), retryAfterMs: 0 };
  }
  return {
    ok: false,
    status: response.status,
    retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
  };
}
