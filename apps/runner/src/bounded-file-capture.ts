import { stat } from 'node:fs/promises';

const isEnoent = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { readonly code?: unknown }).code === 'ENOENT';

/**
 * Size of an existing append target. A missing file starts at zero, while any
 * other stat failure is returned as undefined so the caller can fail closed.
 */
export const appendFileBytes = async (path: string): Promise<number | undefined> => {
  try {
    return (await stat(path)).size;
  } catch (error) {
    return isEnoent(error) ? 0 : undefined;
  }
};

export type CredentialObserver = {
  readonly observed: boolean;
  observeStdout(chunk: Uint8Array): void;
  observeStderr(chunk: Uint8Array): void;
};

const createObservedStream = (
  credentials: readonly Buffer[],
  overlap: number,
): { readonly observed: boolean; observe(chunk: Uint8Array): void } => {
  let pending = Buffer.alloc(0);
  let observed = false;
  return {
    get observed() {
      return observed;
    },
    observe(chunk) {
      if (observed || credentials.length === 0 || chunk.length === 0) return;
      const combined =
        pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([pending, Buffer.from(chunk)]);
      for (const credential of credentials) {
        if (combined.includes(credential)) {
          observed = true;
          return;
        }
      }
      pending = Buffer.from(combined.subarray(Math.max(0, combined.length - overlap)));
    },
  };
};

/**
 * Detects complete credential values across arbitrary chunk boundaries on each
 * stream independently before redaction. Callers pass only real job
 * credentials, not diagnostic URLs or other best-effort redaction strings.
 */
export const createCredentialObserver = (values: readonly string[]): CredentialObserver => {
  const credentials = values
    .filter((value) => value.length > 0)
    .map((value) => Buffer.from(value, 'utf8'));
  const overlap = Math.max(0, ...credentials.map((value) => value.length - 1));
  const stdout = createObservedStream(credentials, overlap);
  const stderr = createObservedStream(credentials, overlap);
  return {
    get observed() {
      return stdout.observed || stderr.observed;
    },
    observeStdout(chunk) {
      stdout.observe(chunk);
    },
    observeStderr(chunk) {
      stderr.observe(chunk);
    },
  };
};

export type BoundedFileSink = {
  readonly truncated: boolean;
  write(chunk: Uint8Array): void;
  finish(): void;
};

/**
 * Writes at most `limit` bytes while holding back a trailing prefix of any
 * known secret. A truncating write drops the held prefix, so the persisted
 * file cannot end with a partial credential. A normal finish flushes it.
 */
export const createBoundedFileSink = (options: {
  readonly limit: number;
  readonly secrets: readonly string[];
  readonly write: (chunk: Uint8Array) => void;
}): BoundedFileSink => {
  const secretPrefixes = options.secrets
    .filter((value) => value.length > 0)
    .map((value) => Buffer.from(value, 'utf8'))
    .sort((left, right) => right.length - left.length);
  let remaining = options.limit;
  let pending = Buffer.alloc(0);
  let truncated = false;

  const heldLength = (): number => {
    let keep = 0;
    for (const secret of secretPrefixes) {
      const limit = Math.min(secret.length, pending.length);
      for (let length = limit; length > keep; length -= 1) {
        if (pending.subarray(pending.length - length).equals(secret.subarray(0, length))) {
          keep = length;
          break;
        }
      }
    }
    return keep;
  };

  const flush = (final: boolean): void => {
    const keep = final ? 0 : heldLength();
    const length = pending.length - keep;
    if (length <= 0) return;
    options.write(pending.subarray(0, length));
    pending = Buffer.from(pending.subarray(length));
  };

  return {
    get truncated() {
      return truncated;
    },
    write(chunk) {
      if (truncated || chunk.length === 0) return;
      if (chunk.length > remaining) {
        const kept = chunk.subarray(0, Math.max(0, remaining));
        remaining = 0;
        truncated = true;
        if (kept.length > 0) {
          pending =
            pending.length === 0 ? Buffer.from(kept) : Buffer.concat([pending, Buffer.from(kept)]);
          flush(false);
        }
        pending = Buffer.alloc(0);
        return;
      }
      remaining -= chunk.length;
      pending =
        pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([pending, Buffer.from(chunk)]);
      flush(false);
    },
    finish() {
      if (!truncated) flush(true);
      pending = Buffer.alloc(0);
    },
  };
};
