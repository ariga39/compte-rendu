import { Option, Schema } from 'effect';
import { MAX_REVIEW_RESULT_BYTES, RunnerFailureCause } from '@compte-rendu/contracts';
import type { RunnerProcessResult } from './sandbox-runtime.js';

const HTTPS_FQDN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;
const IPV4 = /^\d+(?:\.\d+){3}$/;
export const MAX_AGENT_OUTPUT_BYTES = MAX_REVIEW_RESULT_BYTES;
export type RunnerFailureCauseValue = typeof RunnerFailureCause.Type;

const ReviewModelDefinition = Schema.Struct({
  name: Schema.optional(Schema.NonEmptyString),
  reasoning: Schema.optional(Schema.Boolean),
  interleaved: Schema.optional(
    Schema.Struct({ field: Schema.Literals(['reasoning_content', 'reasoning_details']) }),
  ),
  limit: Schema.optional(
    Schema.Struct({
      context: Schema.Int.check(Schema.isGreaterThan(0)),
      output: Schema.Int.check(Schema.isGreaterThan(0)),
    }),
  ),
  cost: Schema.optional(
    Schema.Struct({
      input: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
      output: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
      cache_read: Schema.optional(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
    }),
  ),
});
// Managed relay inference uses the sandbox's credential proxy over HTTPS. Only
// the configured FQDN on port 443 with an exact /v1 base path is accepted.
const RelayServiceBaseUrl = Schema.URLFromString.check(
  Schema.makeFilter(
    (url) =>
      url.protocol === 'https:' &&
      url.port === '' &&
      HTTPS_FQDN.test(url.hostname) &&
      !IPV4.test(url.hostname) &&
      (url.pathname === '/v1' || url.pathname === '/v1/') &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === '',
    { expected: 'HTTPS FQDN on port 443 with /v1 path' },
  ),
);
// Legacy `id` and `definition` fields remain accepted from an already-deployed
// managed configuration but no longer select the model: Core freezes the route
// selection and the grant supplies its descriptor.
const ReviewModelConfig = Schema.Struct({
  id: Schema.optional(
    Schema.String.check(Schema.isPattern(/^opencode-go\/[A-Za-z0-9._:-]{1,128}$/)),
  ),
  baseUrl: RelayServiceBaseUrl,
  definition: Schema.optional(ReviewModelDefinition),
});
export type ReviewModelConfigValue = Schema.Schema.Type<typeof ReviewModelConfig>;

export const decodeReviewModelConfig = (
  raw: string | undefined,
): ReviewModelConfigValue | undefined =>
  raw === undefined
    ? undefined
    : Option.getOrUndefined(
        Schema.decodeUnknownOption(Schema.fromJsonString(ReviewModelConfig), {
          onExcessProperty: 'error',
        })(raw),
      );

// The agent uses native `agents`/`permissions` rules, and the command runner is
// `shell`, not `bash`. Rules are ordered and last-match-wins, so the catch-all
// deny comes first and the specific allow rules follow.
export const shellPermissionRules: ReadonlyArray<readonly [string, 'allow' | 'deny']> = [
  ['*', 'deny'],
  ['gh *', 'deny'],
  ['gh api graphql *', 'allow'],
  ['gh pr view *', 'allow'],
  ['git diff', 'allow'],
  ['git diff *', 'allow'],
  ['git grep', 'allow'],
  ['git grep *', 'allow'],
  ['git log', 'allow'],
  ['git log *', 'allow'],
  ['git log *--output*', 'deny'],
  ['git show', 'allow'],
  ['git show *', 'allow'],
  ['git diff *--no-index*', 'deny'],
  ['git diff *--output*', 'deny'],
  ['git show *--output*', 'deny'],
  ['git diff *--extcmd*', 'deny'],
  ['git diff *>*', 'deny'],
  ['git show *>*', 'deny'],
  ['git grep *>*', 'deny'],
  ['git grep *--open-files-in-pager*', 'deny'],
  ['git grep *-O*', 'deny'],
  ['gh *&*', 'deny'],
  ['gh *;*', 'deny'],
  ['gh *|*', 'deny'],
  ['gh *>*', 'deny'],
  ['gh *<*', 'deny'],
  ['gh *$(*', 'deny'],
  ['gh *`*', 'deny'],
  ['gh *\n*', 'deny'],
  ['git *&*', 'deny'],
  ['git *;*', 'deny'],
  ['git *|*', 'deny'],
  ['git *>*', 'deny'],
  ['git *<*', 'deny'],
  ['git *$(*', 'deny'],
  ['git *`*', 'deny'],
  ['git *\n*', 'deny'],
  ['npm *', 'deny'],
  ['pnpm *', 'deny'],
  ['python *', 'deny'],
  ['./*', 'deny'],
];

const OpenCodeErrorEvent = Schema.Struct({ type: Schema.Literal('error') });
const OpenCodeRecoverableError = Schema.Struct({
  type: Schema.Literal('error'),
  sessionID: Schema.NonEmptyString,
  error: Schema.Struct({
    type: Schema.Literal('provider.invalid-output'),
    status: Schema.Literal(200),
  }),
});
const OpenCodeProviderError = Schema.Struct({
  type: Schema.Literal('error'),
  error: Schema.Struct({
    type: Schema.String.check(Schema.isPattern(/^provider\.[A-Za-z0-9._:-]+$/)),
  }),
});
const OpenCodeProviderHttpStatus = Schema.Struct({
  error: Schema.Struct({
    status: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 400, maximum: 599 }))),
  }),
});
const OpenCodeSessionId = Schema.NonEmptyString.check(Schema.isPattern(/^[A-Za-z0-9._:-]+$/));
const OpenCodeSessionEvent = Schema.Struct({ sessionID: OpenCodeSessionId });
const OpenCodeSession = Schema.Struct({ id: OpenCodeSessionId });
const OpenCodeSessionList = Schema.Union([
  Schema.Array(OpenCodeSession),
  Schema.Struct({ sessions: Schema.Array(OpenCodeSession) }),
]);
// OpenCode 2 may not emit a terminal `step_finish` for a normal stop, so
// success is read from the exported session: matching identity, a succeeded
// outcome, a final terminal `idle` entry, and a final assistant `finish: stop`.
// A `stop` reason from anywhere in the stream is not accepted as completion.
export const OpenCodeSessionExport = Schema.Struct({
  info: Schema.Struct({ id: OpenCodeSessionId, outcome: Schema.optional(Schema.String) }),
  messages: Schema.Array(Schema.Unknown),
});
export type ParsedAgentResult = {
  readonly recoveredErrors?: number;
  readonly cause?: RunnerFailureCauseValue;
  readonly upstream?: { readonly httpStatus?: number };
};

export const parseResult = (stdout: string, recoverySessionId?: string): ParsedAgentResult => {
  if (new TextEncoder().encode(stdout).byteLength > MAX_AGENT_OUTPUT_BYTES) {
    return { cause: 'output-truncated' };
  }
  let recoveredErrors = 0;
  for (const line of stdout.split(/\r?\n/).filter((value) => value.length > 0)) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return { cause: 'malformed-jsonl' };
    }
    if (Option.isSome(Schema.decodeUnknownOption(OpenCodeErrorEvent)(event))) {
      const recoverable = Schema.decodeUnknownOption(OpenCodeRecoverableError)(event);
      if (
        recoverySessionId !== undefined &&
        Option.isSome(recoverable) &&
        recoverable.value.sessionID === recoverySessionId
      ) {
        recoveredErrors += 1;
        continue;
      }
      if (Option.isSome(Schema.decodeUnknownOption(OpenCodeProviderError)(event))) {
        const status = Schema.decodeUnknownOption(OpenCodeProviderHttpStatus)(event);
        const httpStatus = Option.isSome(status) ? status.value.error.status : undefined;
        return {
          upstream: httpStatus === undefined ? {} : { httpStatus },
        };
      }
      return { cause: 'agent-error' };
    }
  }
  return recoveredErrors === 0 ? {} : { recoveredErrors };
};

// OpenCode 2 can recover a provider stream error but retain exit code 1.
// Only this observed error class can be reconciled, using the full export as
// independent evidence of both terminal success and the exact unique result.
export const sessionIdsFrom = (stdout: string): string[] | undefined => {
  try {
    const decoded = Schema.decodeUnknownOption(OpenCodeSessionList)(JSON.parse(stdout));
    if (Option.isNone(decoded)) return undefined;
    const sessions = Array.isArray(decoded.value)
      ? decoded.value
      : (decoded.value as { readonly sessions: ReadonlyArray<{ readonly id: string }> }).sessions;
    return sessions.map((session) => session.id);
  } catch {
    return undefined;
  }
};

export const uniqueSessionIdFrom = (stdout: string): string | undefined => {
  const sessionIds = new Set<string>();
  for (const line of stdout.split(/\r?\n/).filter((value) => value.length > 0)) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return undefined;
    }
    const decoded = Schema.decodeUnknownOption(OpenCodeSessionEvent)(event);
    if (Option.isSome(decoded)) sessionIds.add(decoded.value.sessionID);
  }
  return sessionIds.size === 1 ? [...sessionIds][0] : undefined;
};

export const mergedAgentResult = (
  first: RunnerProcessResult,
  reminder: RunnerProcessResult,
): RunnerProcessResult => {
  const stdout = first.stdout + reminder.stdout;
  return {
    exitCode: reminder.exitCode === 0 ? first.exitCode : reminder.exitCode,
    stdout,
    stderr: (first.stderr ?? '') + (reminder.stderr ?? ''),
    stderrTruncated: first.stderrTruncated === true || reminder.stderrTruncated === true,
    credentialObserved: first.credentialObserved === true || reminder.credentialObserved === true,
    streamError: first.streamError === true || reminder.streamError === true,
    timedOut: first.timedOut || reminder.timedOut,
    truncated:
      first.truncated ||
      reminder.truncated ||
      new TextEncoder().encode(stdout).byteLength > MAX_AGENT_OUTPUT_BYTES,
  };
};
