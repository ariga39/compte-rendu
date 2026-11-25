import { readBoundedBody } from '@compte-rendu/contracts';
import { Schema } from 'effect';
import { HostRequestAbortError, runWithHostDeadline } from './host-request.js';

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

class ReadTokenRefreshError extends Schema.TaggedError<ReadTokenRefreshError>()(
  'ReadTokenRefreshError',
  {},
) {}

/**
 * Refresh the job-scoped GitHub read credential through the same trusted
 * callback origin and bearer token as terminal delivery. Errors never include
 * a response body, credential or lease value.
 */
export const createReadTokenClient = (options: ReadTokenClientOptions): ReadTokenClient => ({
  async refresh(identity, externalSignal) {
    try {
      const text = await runWithHostDeadline(
        {
          timeoutMs: options.timeoutMs ?? READ_TOKEN_REQUEST_TIMEOUT_MS,
          signal: externalSignal,
        },
        async (signal) => {
          const response = await (options.fetch ?? globalThis.fetch)(options.url, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${options.token}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify(identity),
            redirect: 'error',
            signal,
          });
          if (response.status !== 200) {
            await response.body?.cancel().catch(() => undefined);
            throw new ReadTokenRefreshError();
          }
          const body = await readBoundedBody(response.body, READ_TOKEN_RESPONSE_MAX_BYTES);
          if (body.kind === 'too-large') throw new ReadTokenRefreshError();
          return body.text;
        },
      );
      const decoded = await Schema.decodeUnknownPromise(ReadTokenResponse, {
        onExcessProperty: 'error',
      })(text).catch(() => {
        throw new ReadTokenRefreshError();
      });
      return { token: decoded.token, expiresAt: decoded.expiresAt.getTime() };
    } catch (error) {
      if (error instanceof HostRequestAbortError)
        throw new Error(
          error.reason === 'timeout'
            ? 'read token refresh timed out'
            : 'read token refresh aborted',
        );
      throw new Error('read token refresh failed');
    }
  },
});
