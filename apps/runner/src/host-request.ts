export type HostRequestAbortReason = 'timeout' | 'aborted';

export class HostRequestAbortError extends Error {
  constructor(readonly reason: HostRequestAbortReason) {
    super(reason === 'timeout' ? 'Host request timed out' : 'Host request aborted');
    this.name = 'HostRequestAbortError';
  }
}

export interface HostRequestDeadline {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | undefined;
}

/**
 * Run one host request with a real deadline. The transport always receives the
 * controller signal, and the race settles even when the transport ignores an
 * abort. A pre-aborted caller signal never starts the transport.
 */
export const runWithHostDeadline = async <T>(
  { timeoutMs, signal }: HostRequestDeadline,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> => {
  if (signal?.aborted === true) throw new HostRequestAbortError('aborted');
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener = () => {};
  const aborted = new Promise<never>((_, reject) => {
    const abort = (reason: HostRequestAbortReason) => {
      controller.abort();
      reject(new HostRequestAbortError(reason));
    };
    timeout = setTimeout(() => abort('timeout'), timeoutMs);
    if (signal === undefined) return;
    const onAbort = () => abort('aborted');
    signal.addEventListener('abort', onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener('abort', onAbort);
  });
  try {
    return await Promise.race([run(controller.signal), aborted]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    removeAbortListener();
  }
};
