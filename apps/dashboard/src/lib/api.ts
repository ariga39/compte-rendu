import { Option, Schema } from 'effect';

export interface ApiResult {
  ok: boolean;
  status: number;
  data?: unknown;
  retryAfterMs: number;
}

const CancellationAccepted = Schema.Struct({
  status: Schema.Literal('cancelled'),
  pendingCleanup: Schema.Boolean,
});

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

export type CancellationResult =
  | { kind: 'accepted'; status: 200 | 202; pendingCleanup: boolean }
  | { kind: 'conflict' }
  | { kind: 'unauthorized' }
  | { kind: 'notfound' }
  | { kind: 'failed'; status: number };

function acceptedCancellation(data: unknown): data is { pendingCleanup: boolean } {
  const decoded = Schema.decodeUnknownOption(CancellationAccepted)(data);
  return Option.isSome(decoded) && decoded.value.status === 'cancelled';
}

/**
 * Ask Core to stop one immutable review attempt. The same-origin request keeps
 * the private session cookie; displaying the control never grants authority.
 */
export async function requestCancellation(runId: string): Promise<CancellationResult> {
  let response: Response;
  try {
    response = await fetch(`/api/jobs/${encodeURIComponent(runId)}/cancel`, {
      method: 'POST',
      headers: { accept: 'application/json' },
      cache: 'no-store',
      credentials: 'same-origin',
    });
  } catch {
    return { kind: 'failed', status: 0 };
  }
  if (response.status === 401 || response.status === 403) return { kind: 'unauthorized' };
  if (response.status === 404) return { kind: 'notfound' };
  if (response.status === 409) return { kind: 'conflict' };
  if (response.status === 200 || response.status === 202) {
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      return { kind: 'failed', status: response.status };
    }
    if (!acceptedCancellation(data)) return { kind: 'failed', status: response.status };
    return {
      kind: 'accepted',
      status: response.status as 200 | 202,
      pendingCleanup: data.pendingCleanup,
    };
  }
  return { kind: 'failed', status: response.status };
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
