import {
  readBoundedBody,
  ModelUsageSummary,
  ModelRouteDescriptor,
  RUNNER_LLM_CONTROL_TIMEOUT_MS,
} from '@compte-rendu/contracts';
import { Schema } from 'effect';
import { HostRequestAbortError, runWithHostDeadline } from './host-request.js';

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

const ControlFailureReason = Schema.Literals([
  'invalid-response',
  'http-error',
  'timeout',
  'transport-error',
]);

class RelayControlError extends Schema.TaggedError<RelayControlError>()('RelayControlError', {
  reason: ControlFailureReason,
  status: Schema.optional(Schema.Int),
}) {}

export const LlmGrantIssueFailure = ControlFailureReason;
export type LlmGrantIssueFailure = typeof LlmGrantIssueFailure.Type;

export class LlmGrantIssueError extends Schema.TaggedError<LlmGrantIssueError>()(
  'LlmGrantIssueError',
  {
    message: Schema.String,
    reason: ControlFailureReason,
    status: Schema.optional(Schema.Int),
  },
) {}

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

const relayPost =
  (options: RelayLlmServiceClientOptions) =>
  async (
    path: string,
    payload: unknown,
    expectedStatus: number,
    maxBytes = CONTROL_MAX_BYTES,
  ): Promise<string> => {
    const origin = options.origin.toString().replace(/\/+$/, '');
    try {
      return await runWithHostDeadline(
        { timeoutMs: RUNNER_LLM_CONTROL_TIMEOUT_MS },
        async (signal) => {
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
            throw new RelayControlError({ reason: 'http-error', status: response.status });
          }
          const body = await readBoundedBody(response.body, maxBytes);
          if (body.kind === 'too-large')
            throw new RelayControlError({ reason: 'invalid-response' });
          return body.text;
        },
      );
    } catch (error) {
      if (error instanceof HostRequestAbortError && error.reason === 'timeout')
        throw new RelayControlError({ reason: 'timeout' });
      if (error instanceof RelayControlError) throw error;
      throw new RelayControlError({ reason: 'transport-error' });
    }
  };

const grantUnavailable = (reason: LlmGrantIssueFailure, status?: number) =>
  new LlmGrantIssueError({
    message: 'LLM service grant unavailable',
    reason,
    ...(status === undefined ? {} : { status }),
  });

const issueFailure = (error: unknown): LlmGrantIssueError => {
  if (error instanceof LlmGrantIssueError) return error;
  return error instanceof RelayControlError
    ? grantUnavailable(error.reason, error.status)
    : grantUnavailable('transport-error');
};

export const createRelayLlmServiceClient = (
  options: RelayLlmServiceClientOptions,
): LlmServiceClient => {
  const post = relayPost(options);
  const issue = async (job: LlmGrantIdentity, routes: readonly string[]) => {
    try {
      const payload = {
        runId: job.runId,
        jobId: job.jobId,
        attempt: job.attempt,
        routes,
      };
      if (options.grantVersion === 2) {
        const body = await post('/runner-llm/issue-v2', payload, 201);
        const grant = await Schema.decodeUnknownPromise(ProfiledGrant, {
          onExcessProperty: 'error',
        })(body).catch(() => {
          throw grantUnavailable('invalid-response');
        });
        const ids = new Set(grant.descriptors.map((d) => d.routeId));
        if (
          routes.length !== grant.descriptors.length ||
          ids.size !== routes.length ||
          routes.some((id) => !ids.has(id))
        )
          throw grantUnavailable('invalid-response');
        return {
          token: grant.token,
          expiresAt: grant.expiresAt.getTime(),
          descriptors: grant.descriptors,
        };
      }
      const body = await post('/runner-llm/issue', payload, 201);
      const grant = await Schema.decodeUnknownPromise(Grant, {
        onExcessProperty: 'error',
      })(body).catch(() => {
        throw grantUnavailable('invalid-response');
      });
      return { token: grant.token, expiresAt: grant.expiresAt.getTime() };
    } catch (error) {
      throw issueFailure(error);
    }
  };
  return {
    usage: async (jobId: string) => {
      try {
        const body = await post('/runner-llm/usage', { jobId }, 200, USAGE_MAX_BYTES);
        return await Schema.decodeUnknownPromise(Schema.fromJsonString(ModelUsageSummary), {
          onExcessProperty: 'error',
        })(body);
      } catch {
        throw new Error('LLM usage unavailable');
      }
    },
    issue,
    revoke: async (jobId: string): Promise<void> => {
      try {
        await post('/runner-llm/revoke', { jobId }, 204);
      } catch {
        throw new Error('LLM service control request failed');
      }
    },
  };
};
