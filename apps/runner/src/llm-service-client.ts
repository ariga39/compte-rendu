import {
  readBoundedBody,
  ModelUsageSummary,
  RUNNER_LLM_CONTROL_TIMEOUT_MS,
} from '@compte-rendu/contracts';
import { request } from 'node:http';
import { Effect, Schema } from 'effect';

const Grant = Schema.fromJsonString(
  Schema.Struct({
    token: Schema.NonEmptyString.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/)),
    expiresAt: Schema.DateFromString,
  }),
);

const CONTROL_MAX_BYTES = 16 * 1024;
const USAGE_MAX_BYTES = 64 * 1024;

export interface LlmGrantIdentity {
  readonly runId: string;
  readonly jobId: string;
  readonly attempt: number;
}

export interface RelayLlmServiceClientOptions {
  readonly origin: string | URL;
  readonly token: string;
  readonly fetch?: typeof fetch;
}

export interface LlmServiceClient {
  readonly issue: (
    job: string | LlmGrantIdentity,
    routes: string | readonly string[],
  ) => Promise<{ token: string; expiresAt: number }>;
  readonly revoke: (jobId: string) => Promise<void>;
  readonly usage: (jobId: string) => Promise<ModelUsageSummary>;
}

const relayPost = (options: RelayLlmServiceClientOptions) =>
  Effect.fn('RunnerLlmRelayControl.post')(function* (
    path: string,
    payload: unknown,
    expectedStatus: number,
    maxBytes = CONTROL_MAX_BYTES,
  ) {
    const origin = options.origin.toString().replace(/\/+$/, '');
    return yield* Effect.tryPromise({
      try: async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), RUNNER_LLM_CONTROL_TIMEOUT_MS);
        try {
          const response = await (options.fetch ?? globalThis.fetch)(`${origin}${path}`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${options.token}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify(payload),
            redirect: 'error',
            signal: controller.signal,
          });
          if (response.status !== expectedStatus) {
            await response.body?.cancel().catch(() => undefined);
            throw new Error('control request rejected');
          }
          const body = await readBoundedBody(response.body, maxBytes);
          if (body.kind === 'too-large') throw new Error('control response too large');
          return body.text;
        } finally {
          clearTimeout(timeout);
        }
      },
      catch: () => new Error('LLM service control request failed'),
    });
  });

const createRelayClient = (options: RelayLlmServiceClientOptions): LlmServiceClient => {
  const post = relayPost(options);
  const issue = Effect.fn('RunnerLlmRelayControl.issue')(
    function* (job: string | LlmGrantIdentity, routes: string | readonly string[]) {
      if (typeof job === 'string')
        return yield* Effect.fail(new Error('relay grant requires run and attempt identity'));
      const requested = [...new Set(typeof routes === 'string' ? [routes] : routes)];
      const payload = {
        runId: job.runId,
        jobId: job.jobId,
        attempt: job.attempt,
        routes: requested,
      };
      const body = yield* post('/runner-llm/issue', payload, 201);
      const grant = yield* Schema.decodeUnknownEffect(Grant, { onExcessProperty: 'error' })(body);
      return { token: grant.token, expiresAt: grant.expiresAt.getTime() };
    },
    Effect.catch(() => Effect.fail(new Error('LLM service grant unavailable'))),
  );
  const usage = Effect.fn('RunnerLlmRelayControl.usage')(
    function* (jobId: string) {
      const body = yield* post('/runner-llm/usage', { jobId }, 200, USAGE_MAX_BYTES);
      return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ModelUsageSummary), {
        onExcessProperty: 'error',
      })(body);
    },
    Effect.catch(() => Effect.fail(new Error('LLM usage unavailable'))),
  );
  return {
    usage: (jobId: string) => Effect.runPromise(usage(jobId)),
    issue: (job: string | LlmGrantIdentity, routes: string | readonly string[]) =>
      Effect.runPromise(issue(job, routes)),
    revoke: async (jobId: string): Promise<void> => {
      await Effect.runPromise(post('/runner-llm/revoke', { jobId }, 204));
    },
  };
};

export const createRelayLlmServiceClient = (
  options: RelayLlmServiceClientOptions,
): LlmServiceClient => createRelayClient(options);

const createLocalClient = (socketPath: string): LlmServiceClient => {
  const post = Effect.fn('RunnerLlmControl.post')(function* (
    path: string,
    payload: unknown,
    expectedStatus: number,
    maxBytes = CONTROL_MAX_BYTES,
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
                if (size > maxBytes) {
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
          }, RUNNER_LLM_CONTROL_TIMEOUT_MS);
          req.on('error', () => finish(new Error('control request failed')));
          req.end(body);
        }),
      catch: () => new Error('LLM service control request failed'),
    });
  });
  const issue = Effect.fn('RunnerLlmControl.issue')(
    function* (job: string | LlmGrantIdentity, routes: string | readonly string[]) {
      const jobId = typeof job === 'string' ? job : job.jobId;
      const requested = [...new Set(typeof routes === 'string' ? [routes] : routes)];
      const body = yield* post('/grants', { jobId, routes: requested }, 201);
      const grant = yield* Schema.decodeUnknownEffect(Grant, { onExcessProperty: 'error' })(body);
      return { token: grant.token, expiresAt: grant.expiresAt.getTime() };
    },
    Effect.catch(() => Effect.fail(new Error('LLM service grant unavailable'))),
  );
  const usage = Effect.fn('RunnerLlmControl.usage')(
    function* (jobId: string) {
      const body = yield* post('/grants/usage', { jobId }, 200, USAGE_MAX_BYTES);
      return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ModelUsageSummary), {
        onExcessProperty: 'error',
      })(body);
    },
    Effect.catch(() => Effect.fail(new Error('LLM usage unavailable'))),
  );
  return {
    usage: (jobId: string) => Effect.runPromise(usage(jobId)),
    issue: (job: string | LlmGrantIdentity, routes: string | readonly string[]) =>
      Effect.runPromise(issue(job, routes)),
    revoke: async (jobId: string): Promise<void> => {
      await Effect.runPromise(post('/grants/revoke', { jobId }, 204));
    },
  };
};

export const createLlmServiceClient = (socketPath: string): LlmServiceClient =>
  createLocalClient(socketPath);
