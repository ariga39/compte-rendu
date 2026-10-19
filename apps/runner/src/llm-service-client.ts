import { request } from 'node:http';
import { Effect, Schema } from 'effect';

const Grant = Schema.fromJsonString(
  Schema.Struct({
    token: Schema.NonEmptyString.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/)),
    expiresAt: Schema.DateFromString,
  }),
);

export const createLlmServiceClient = (socketPath: string) => {
  const post = Effect.fn('RunnerLlmControl.post')(function* (
    path: string,
    payload: unknown,
    expectedStatus: number,
  ) {
    return yield* Effect.tryPromise({
      try: () =>
        new Promise<string>((resolve, reject) => {
          const body = JSON.stringify(payload);
          let settled = false;
          const finish = (error?: Error, value = '') => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (error) reject(error);
            else resolve(value);
          };
          const req = request(
            {
              socketPath,
              path,
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'content-length': new TextEncoder().encode(body).byteLength,
              },
            },
            (res) => {
              let size = 0;
              const chunks: Buffer[] = [];
              res.on('error', () => finish(new Error('control response interrupted')));
              res.on('data', (chunk: Buffer) => {
                size += chunk.byteLength;
                if (size > 16 * 1024) {
                  finish(new Error('control response too large'));
                  req.destroy();
                  return;
                }
                chunks.push(chunk);
              });
              res.on('end', () => {
                if (res.statusCode !== expectedStatus)
                  finish(new Error('control request rejected'));
                else finish(undefined, Buffer.concat(chunks).toString('utf8'));
              });
            },
          );
          const timeout = setTimeout(() => {
            finish(new Error('control request timed out'));
            req.destroy();
          }, 5000);
          req.on('error', () => finish(new Error('control request failed')));
          req.end(body);
        }),
      catch: () => new Error('LLM service control request failed'),
    });
  });
  const issue = Effect.fn('RunnerLlmControl.issue')(
    function* (jobId: string, routes: string | readonly string[]) {
      const requested = [...new Set(typeof routes === 'string' ? [routes] : routes)];
      const body = yield* post('/grants', { jobId, routes: requested }, 201);
      const grant = yield* Schema.decodeUnknownEffect(Grant, { onExcessProperty: 'error' })(body);
      return { token: grant.token, expiresAt: grant.expiresAt.getTime() };
    },
    Effect.catch(() => Effect.fail(new Error('LLM service grant unavailable'))),
  );
  return {
    issue: (jobId: string, routes: string | readonly string[]) =>
      Effect.runPromise(issue(jobId, routes)),
    revoke: async (jobId: string): Promise<void> => {
      await Effect.runPromise(post('/grants/revoke', { jobId }, 204));
    },
  };
};
