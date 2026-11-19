import { readBoundedBody } from '@compte-rendu/contracts';
import { Effect, Schema } from 'effect';

const ReadTokenResponse = Schema.fromJsonString(
  Schema.Struct({
    token: Schema.NonEmptyString,
    expiresAt: Schema.DateFromString,
  }),
);

const READ_TOKEN_RESPONSE_MAX_BYTES = 16 * 1024;
const READ_TOKEN_REQUEST_TIMEOUT_MS = 30 * 1000;

export interface ReadTokenIdentity {
  readonly runId: string;
  readonly jobId: string;
  readonly attempt: number;
}

export interface ReadTokenClientOptions {
  readonly url: string;
  readonly token: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface ReadTokenClient {
  readonly refresh: (
    identity: ReadTokenIdentity,
    signal?: AbortSignal,
  ) => Promise<{ readonly token: string; readonly expiresAt: number }>;
}

/**
 * Refresh the job-scoped GitHub read credential through the same trusted
 * callback origin and bearer token as terminal delivery. Errors never include
 * a response body, credential or lease value.
 */
export const createReadTokenClient = (options: ReadTokenClientOptions): ReadTokenClient => {
  const refresh = async (identity: ReadTokenIdentity, externalSignal?: AbortSignal) => {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, options.timeoutMs ?? READ_TOKEN_REQUEST_TIMEOUT_MS);
    const abort = () => controller.abort();
    if (externalSignal?.aborted === true) controller.abort();
    else externalSignal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await (options.fetch ?? globalThis.fetch)(options.url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(identity),
        redirect: 'error',
        signal: controller.signal,
      });
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error('read token refresh rejected');
      }
      const body = await readBoundedBody(response.body, READ_TOKEN_RESPONSE_MAX_BYTES);
      if (body.kind === 'too-large') throw new Error('read token refresh response too large');
      const decoded = await Effect.runPromise(
        Schema.decodeUnknownEffect(ReadTokenResponse, { onExcessProperty: 'error' })(body.text),
      );
      return { token: decoded.token, expiresAt: decoded.expiresAt.getTime() };
    } catch {
      // Do not retain transport, body or decoding text: it can contain a
      // credential or an untrusted response fragment.
      if (externalSignal?.aborted === true) throw new Error('read token refresh aborted');
      if (timedOut) throw new Error('read token refresh timed out');
      throw new Error('read token refresh failed');
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener('abort', abort);
    }
  };
  return { refresh };
};
