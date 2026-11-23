import {
  readBoundedBody,
  ModelUsageSummary,
  ModelRouteDescriptor,
  RUNNER_LLM_CONTROL_TIMEOUT_MS,
} from '@compte-rendu/contracts';
import { Effect, Schema } from 'effect';

const grantFields = {
  token: Schema.NonEmptyString.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/)),
  expiresAt: Schema.DateFromString,
};
const Grant = Schema.fromJsonString(Schema.Struct(grantFields));
const ProfiledGrant = Schema.fromJsonString(
  Schema.Struct({
    ...grantFields,
    descriptors: Schema.Array(ModelRouteDescriptor),
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
  readonly grantVersion?: 1 | 2;
  readonly origin: string | URL;
  readonly token: string;
  readonly fetch?: typeof fetch;
}

export interface LlmServiceClient {
  readonly issue: (
    job: LlmGrantIdentity,
    routes: readonly string[],
  ) => Promise<{
    token: string;
    expiresAt: number;
    descriptors?: readonly ModelRouteDescriptor[];
  }>;
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
      try: async (signal) => {
        const response = await (options.fetch ?? globalThis.fetch)(`${origin}${path}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${options.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(payload),
          redirect: 'error',
          signal,
        });
        if (response.status !== expectedStatus) {
          await response.body?.cancel().catch(() => undefined);
          throw new Error('control request rejected');
        }
        const body = await readBoundedBody(response.body, maxBytes);
        if (body.kind === 'too-large') throw new Error('control response too large');
        return body.text;
      },
      catch: (error) => error,
    }).pipe(
      Effect.timeout(RUNNER_LLM_CONTROL_TIMEOUT_MS),
      Effect.mapError(() => new Error('LLM service control request failed')),
    );
  });

export const createRelayLlmServiceClient = (
  options: RelayLlmServiceClientOptions,
): LlmServiceClient => {
  const post = relayPost(options);
  const issue = Effect.fn('RunnerLlmRelayControl.issue')(
    function* (job: LlmGrantIdentity, routes: readonly string[]) {
      const payload = {
        runId: job.runId,
        jobId: job.jobId,
        attempt: job.attempt,
        routes,
      };
      if (options.grantVersion === 2) {
        const body = yield* post('/runner-llm/issue-v2', payload, 201);
        const grant = yield* Schema.decodeUnknownEffect(ProfiledGrant, {
          onExcessProperty: 'error',
        })(body);
        const ids = new Set(grant.descriptors.map((d) => d.routeId));
        if (
          routes.length !== grant.descriptors.length ||
          ids.size !== routes.length ||
          routes.some((id) => !ids.has(id))
        )
          return yield* Effect.fail(new Error('frozen routes do not match'));
        return {
          token: grant.token,
          expiresAt: grant.expiresAt.getTime(),
          descriptors: grant.descriptors,
        };
      }
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
    issue: (job: LlmGrantIdentity, routes: readonly string[]) =>
      Effect.runPromise(issue(job, routes)),
    revoke: async (jobId: string): Promise<void> => {
      await Effect.runPromise(post('/runner-llm/revoke', { jobId }, 204));
    },
  };
};
