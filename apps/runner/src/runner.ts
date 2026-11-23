import type { ModelRouteDescriptor } from '@compte-rendu/contracts';
import type { ModelUsageSummary } from '@compte-rendu/contracts';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, readFileSync, type WriteStream } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DateTime, Effect, Option, Schema } from 'effect';
import {
  MAX_REVIEW_RESULT_BYTES,
  MAX_RUNNER_CALLBACK_BYTES,
  REVIEW_ATTEMPT_BUDGET_MS,
  RunnerFailureCause,
  RunnerJobInput,
  RunnerProcessErrorCode,
  RunnerResultCallback,
  StructuredReviewResult,
  type RunnerProgressSnapshot,
  type RunnerProgressStage,
  sanitizeOperationalLogEvent,
  type OperationalLog,
  type OperationalLogEvent,
  type RunnerJobResponse as RunnerJobResponseValue,
} from '@compte-rendu/contracts';
import {
  SandboxCreateError,
  resolveSandboxRuntimeConfig,
  type JobSandboxRuntime,
  type RunnerDiagnostic,
  type RunnerProcess,
  type RunnerProcessOptions,
  type RunnerProcessResult,
  type SandboxCommand,
  type SandboxOperation,
  type SandboxRuntimeFactory,
  type SandboxRuntimeKind,
} from './sandbox-runtime.js';
import { createTerminalJobHistory } from './terminal-job-history.js';
import {
  appendFileBytes,
  createBoundedFileSink,
  createCredentialObserver,
} from './bounded-file-capture.js';
import { confirmSbxCleanup } from './cleanup-recovery.js';
import {
  createMicrosandboxRuntimeFactory,
  confirmMicrosandboxAbsent,
  createMicrosandboxPreflight,
} from './sandbox-runtime-microsandbox.js';
import { createOpenSandboxRuntimeFactory } from './sandbox-runtime-opensandbox.js';
import { createSbxRuntimeFactory, reconcileSbxRestartResources } from './sandbox-runtime-sbx.js';
import { createRelayLlmServiceClient, type LlmGrantIdentity } from './llm-service-client.js';
import { createReadTokenClient, type ReadTokenClient } from './read-token-client.js';
import {
  MULTI_PROVIDER_ID,
  SUPERVISOR_AGENT_ID,
  decodeSessionExport,
  dedupedRoutes,
  extractReviewSubmission,
  modelReference,
  multiReviewConfig,
  participants,
  parseChildSessionPage,
  sessionSucceeded,
  type ChildSession,
  type MultiReviewSelection,
  type ReviewSubmission,
  type SessionIdentity,
} from './opencode-multi-review.js';
import {
  createOpenShellPreflight,
  createOpenShellRuntimeFactory,
} from './sandbox-runtime-openshell.js';
import { recoverCallback, ReplayCallbackRequest } from './callback-recovery.js';
import { reviewPrompt, reviewCorrectionPrompt } from './review-prompt.js';
import { reviewSkills } from './review-skill.js';
import {
  readRunnerSettingsSync,
  watchRunnerSettings,
  type RunnerSettingsWatcher,
} from './runner-settings.js';

export type {
  RunnerDiagnostic,
  RunnerProcess,
  RunnerProcessOptions,
  RunnerProcessResult,
  SandboxRuntimeKind,
} from './sandbox-runtime.js';

const MODEL_HOST = 'opencode.ai';
const MODEL_PORT = '443';
const OPENCODE_VERSION = '2.0.32';
const SANDBOX_TEMPLATE = `ghcr.io/ariga39/petit-chiba-opencode:${OPENCODE_VERSION}-gh2.98.0`;
const SETUP_TIMEOUT_MS = 2 * 60 * 1000;
const SUBMIT_REMINDER_BUDGET_MS = 2 * 60 * 1000;
const FINALIZATION_BUDGET_MS = 60 * 1000;
// Keep a clock-skew reserve before the upstream GitHub read credential expires.
const CREDENTIAL_EXPIRY_SAFETY_MARGIN_MS = FINALIZATION_BUDGET_MS;
// Refresh early enough to replace a long-lived run's credential before it
// expires, without shortening it to the finalization reserve.
const READ_TOKEN_REFRESH_LEAD_MS = 5 * 60 * 1000;
const OPENSANDBOX_RESOURCE_LIFETIME_SECONDS = 2 * 60 * 60;
const GRANT_REVOKE_ATTEMPTS = 2;
const GRANT_REVOKE_BUDGET_MS = 15 * 1000;
const CLEANUP_COMMAND_TIMEOUT_MS = 30 * 1000;
const ARCHIVE_COMMAND_TIMEOUT_MS = 30 * 1000;
const ARCHIVE_PHASE_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_CHILD_SESSION_PAGES = 100;
const MAX_DIAGNOSTIC_STDERR_BYTES = 4 * 1024;
const MAX_AGENT_OUTPUT_BYTES = MAX_REVIEW_RESULT_BYTES;
const MAX_REQUEST_BYTES = 64 * 1024;
const CALLBACK_REQUEST_TIMEOUT_MS = 30 * 1000;
const CLAIM_REQUEST_TIMEOUT_MS = 30 * 1000;
const DEFAULT_CONCURRENCY = 1;
const EMPTY_EVIDENCE_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const HTTPS_FQDN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;
const IPV4 = /^\d+(?:\.\d+){3}$/;

const nonEmpty = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
};

const isEnabled = (value: string | boolean | undefined): boolean =>
  value === true ||
  (typeof value === 'string' && ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase()));

const RunnerConcurrency = Schema.Union([
  Schema.Int.check(Schema.isGreaterThan(0)),
  Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThan(0)),
]);

const resolveConcurrency = (option: number | undefined, env: string | undefined): number => {
  const decoded = Schema.decodeUnknownOption(RunnerConcurrency)(
    option ?? env ?? DEFAULT_CONCURRENCY,
  );
  if (Option.isNone(decoded)) {
    throw new Error('RUNNER_CONCURRENCY must be a positive integer');
  }
  return decoded.value;
};

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
const ModelBaseUrl = Schema.URLFromString.check(
  Schema.makeFilter(
    (url) =>
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === '' &&
      !url.hostname.includes('*'),
    { expected: 'absolute HTTPS URL without credentials, query, fragment, or wildcard host' },
  ),
);
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
const ReviewModelConfig = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^opencode-go\/[A-Za-z0-9._:-]{1,128}$/)),
  baseUrl: Schema.optional(ModelBaseUrl),
  definition: Schema.optional(ReviewModelDefinition),
});
const RelayServiceReviewModelConfig = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^opencode-go\/[A-Za-z0-9._:-]{1,128}$/)),
  baseUrl: RelayServiceBaseUrl,
  definition: Schema.optional(ReviewModelDefinition),
});
const GrantMarkerIssuer = Schema.Struct({
  transport: Schema.Literal('relay'),
  origin: Schema.NonEmptyString,
  generation: Schema.NonEmptyString,
});
const GrantMarker = Schema.Struct({
  version: Schema.Literal(1),
  jobId: Schema.NonEmptyString,
  issuer: GrantMarkerIssuer,
});
type GrantIssuer = typeof GrantMarkerIssuer.Type;
type ReviewModelConfigValue = Schema.Schema.Type<typeof ReviewModelConfig>;
type ReviewModelDefinitionValue = Schema.Schema.Type<typeof ReviewModelDefinition>;

type ModelTransport = 'direct' | 'relay';

const decodeReviewModelConfig = (
  raw: string | undefined,
  transport: ModelTransport,
): ReviewModelConfigValue | undefined =>
  raw === undefined
    ? undefined
    : Option.getOrUndefined(
        Schema.decodeUnknownOption(
          Schema.fromJsonString(
            transport === 'relay' ? RelayServiceReviewModelConfig : ReviewModelConfig,
          ),
          { onExcessProperty: 'error' },
        )(raw),
      );

// Native OpenCode 2 configuration. The v1 `provider.options.baseURL` normalizer
// does not apply to this deployment's custom gateway, so the endpoint must be
// set through native `providers['opencode-go'].settings.baseURL`. The agent uses
// the native `agents`/`permissions` ruleset, and the command runner is `shell`,
// not `bash`. Rules are ordered and last-match-wins, so the catch-all deny comes
// first and the specific allow rules follow.
const shellPermissionRules: ReadonlyArray<readonly [string, 'allow' | 'deny']> = [
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

const nativeModelDefinition = (definition: ReviewModelDefinitionValue) => ({
  ...(definition.name === undefined ? {} : { name: definition.name }),
  ...(definition.reasoning === undefined
    ? {}
    : { capabilities: { reasoning: { supported: definition.reasoning } } }),
  ...(definition.limit === undefined ? {} : { limit: definition.limit }),
  ...(definition.cost === undefined
    ? {}
    : {
        cost: {
          input: definition.cost.input,
          output: definition.cost.output,
          ...(definition.cost.cache_read === undefined
            ? {}
            : { cache: { read: definition.cost.cache_read } }),
        },
      }),
});

const trustedOpenCodeConfig = (config: ReviewModelConfigValue) => {
  const baseURL = config.baseUrl?.toString();
  const nativeModel =
    config.definition === undefined ? undefined : nativeModelDefinition(config.definition);
  // A custom gateway needs an explicit provider package and settings; without
  // them the built-in `opencode-go` provider keeps its own opencode.ai endpoint.
  // The selected model already carries its own catalog URL, and the provider
  // overlay only clears it for new/changed models, so the model-level
  // `settings.baseURL` must be set too (even when the definition is absent).
  const nativeModelEntry =
    nativeModel === undefined && baseURL === undefined
      ? undefined
      : {
          ...nativeModel,
          ...(baseURL === undefined ? {} : { settings: { baseURL } }),
        };
  const providerEntry =
    baseURL === undefined && nativeModelEntry === undefined
      ? undefined
      : {
          'opencode-go': {
            ...(baseURL === undefined
              ? {}
              : {
                  package: '@opencode/ai/providers/openai-compatible',
                  settings: { baseURL, apiKey: '{env:OPENCODE_API_KEY}' },
                }),
            ...(nativeModelEntry === undefined
              ? {}
              : { models: { [config.id.slice('opencode-go/'.length)]: nativeModelEntry } }),
          },
        };
  const permissions = [
    { action: '*', resource: '*', effect: 'deny' as const },
    ...shellPermissionRules.map(([resource, effect]) => ({ action: 'shell', resource, effect })),
    { action: 'edit', resource: '*', effect: 'deny' as const },
    { action: 'external_directory', resource: '*', effect: 'allow' as const },
    { action: 'glob', resource: '*', effect: 'allow' as const },
    { action: 'grep', resource: '*', effect: 'allow' as const },
    { action: 'read', resource: '*', effect: 'allow' as const },
    { action: 'skill', resource: '*', effect: 'allow' as const },
    { action: 'webfetch', resource: '*', effect: 'deny' as const },
  ];
  return JSON.stringify({
    model: config.id,
    ...(providerEntry === undefined ? {} : { providers: providerEntry }),
    agents: {
      review: {
        description: 'Pull request reviewer',
        mode: 'primary',
        permissions,
      },
    },
  });
};

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
const OpenCodeSessionExport = Schema.Struct({
  info: Schema.Struct({ id: OpenCodeSessionId, outcome: Schema.optional(Schema.String) }),
  messages: Schema.Array(Schema.Unknown),
});
// A spawn failure or thrown process invocation is classified with a fixed
// Schema-decoded allowlist of Node codes rather than its raw message, so
// diagnostics stay safe and comparable. An unrecognized code is omitted
// instead of guessed.
const ProcessErrorCodeShape = Schema.Struct({ code: RunnerProcessErrorCode });
const safeProcessErrorCode = (error: unknown): RunnerProcessErrorCode | undefined => {
  const decoded = Schema.decodeUnknownOption(ProcessErrorCodeShape)(error);
  return Option.isSome(decoded) ? decoded.value.code : undefined;
};

const processFailure = (error: unknown): RunnerProcessResult => {
  const errorCode = safeProcessErrorCode(error);
  return {
    exitCode: 1,
    stdout: '',
    timedOut: false,
    truncated: false,
    processError: true,
    ...(errorCode === undefined ? {} : { errorCode }),
  };
};

const stop = (child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM') => {
  try {
    child.kill(signal);
  } catch {
    // The child may already have exited.
  }
};

/**
 * Local spawn implementation of the Runner process port. Evidence files share
 * the same byte budget as in-memory capture, including append rounds.
 */
export const runProcess: RunnerProcess = async (command, args, options = {}) => {
  const maxBytes = options.maxBytes ?? 0;
  const captureStdout = options.captureStdout === true || options.stdoutFilePath !== undefined;
  const captureStderr = options.captureStderr === true || options.stderrFilePath !== undefined;
  const stderrRedactions = (options.stderrRedactions ?? [])
    .filter((value) => value.length > 0)
    .sort((left, right) => right.length - left.length);
  const credentialValues = (options.credentialValues ?? []).filter((value) => value.length > 0);
  const fileRedactions = [...new Set([...stderrRedactions, ...credentialValues])].sort(
    (left, right) => right.length - left.length,
  );
  const credentialObserver = createCredentialObserver(credentialValues);
  const existingStdoutBytes =
    options.stdoutFilePath !== undefined && options.fileAppend === true && maxBytes > 0
      ? await appendFileBytes(options.stdoutFilePath)
      : 0;
  const existingStderrBytes =
    options.stderrFilePath !== undefined && options.fileAppend === true && maxBytes > 0
      ? await appendFileBytes(options.stderrFilePath)
      : 0;
  const failure = (streamError: boolean): RunnerProcessResult => ({
    exitCode: 1,
    stdout: '',
    ...(captureStderr ? { stderr: '' } : {}),
    ...(streamError ? { streamError: true } : {}),
    timedOut: false,
    truncated: false,
  });
  if (existingStdoutBytes === undefined || existingStderrBytes === undefined) {
    return failure(true);
  }
  if (options.signal?.aborted === true) return failure(false);

  const memoryLimit = maxBytes > 0 ? maxBytes : 0;
  const fileLimit = maxBytes > 0 ? maxBytes : Number.POSITIVE_INFINITY;

  return new Promise<RunnerProcessResult>((resolve) => {
    const chunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stderrPending = '';
    let stdoutRemaining =
      options.stdoutFilePath !== undefined && maxBytes > 0
        ? Math.max(0, memoryLimit - existingStdoutBytes)
        : memoryLimit;
    let stderrRemaining =
      options.stderrFilePath !== undefined && maxBytes > 0
        ? Math.max(0, memoryLimit - existingStderrBytes)
        : memoryLimit;
    let stderrTruncated = false;
    let streamError = false;
    let truncated = false;
    let timedOut = false;
    let processError = false;
    let errorCode: RunnerProcessErrorCode | undefined;
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let killTimeout: ReturnType<typeof setTimeout> | undefined;
    let child: ChildProcess;
    let stdoutHandle: WriteStream | undefined;
    let stderrHandle: WriteStream | undefined;
    let stdoutSink: ReturnType<typeof createBoundedFileSink> | undefined;
    let stderrSink: ReturnType<typeof createBoundedFileSink> | undefined;

    try {
      const fileFlags = options.fileAppend === true ? 'a' : 'w';
      if (options.stdoutFilePath !== undefined) {
        stdoutHandle = createWriteStream(options.stdoutFilePath, { flags: fileFlags, mode: 0o600 });
        stdoutSink = createBoundedFileSink({
          limit:
            options.fileAppend === true && maxBytes > 0
              ? Math.max(0, fileLimit - existingStdoutBytes)
              : fileLimit,
          secrets: fileRedactions,
          write: (chunk) => stdoutHandle?.write(chunk),
        });
      }
      if (options.stderrFilePath !== undefined) {
        stderrHandle = createWriteStream(options.stderrFilePath, { flags: fileFlags, mode: 0o600 });
        stderrSink = createBoundedFileSink({
          limit:
            options.fileAppend === true && maxBytes > 0
              ? Math.max(0, fileLimit - existingStderrBytes)
              : fileLimit,
          secrets: fileRedactions,
          write: (chunk) => stderrHandle?.write(chunk),
        });
      }
    } catch {
      // Evidence finalization fails closed if a stream cannot be created.
      streamError = true;
    }
    stdoutHandle?.on('error', () => {
      streamError = true;
    });
    stderrHandle?.on('error', () => {
      streamError = true;
    });

    const appendStdout = (buffer: Buffer) => {
      if (!truncated) {
        if (buffer.length > stdoutRemaining) {
          const kept = buffer.subarray(0, Math.max(0, stdoutRemaining));
          if (kept.length > 0) {
            chunks.push(Buffer.from(kept));
            stdoutRemaining -= kept.length;
          }
          truncated = true;
        } else {
          chunks.push(buffer);
          stdoutRemaining -= buffer.length;
        }
      }
      stdoutSink?.write(buffer);
      if (stdoutSink?.truncated === true) truncated = true;
    };

    const appendStderr = (value: string) => {
      if (value.length === 0) return;
      const buffer = new TextEncoder().encode(value);
      if (!stderrTruncated) {
        if (buffer.length > stderrRemaining) {
          const kept = buffer.subarray(0, Math.max(0, stderrRemaining));
          if (kept.length > 0) {
            stderrChunks.push(Buffer.from(kept));
            stderrRemaining -= kept.length;
          }
          stderrTruncated = true;
        } else {
          stderrChunks.push(Buffer.from(buffer));
          stderrRemaining -= buffer.length;
        }
      }
      stderrSink?.write(buffer);
      if (stderrSink?.truncated === true) stderrTruncated = true;
    };

    const flushStderr = (value: string, final: boolean) => {
      stderrPending += value;
      let keep = 0;
      if (!final) {
        for (const redaction of stderrRedactions) {
          const limit = Math.min(redaction.length, stderrPending.length);
          for (let length = limit; length > 0; length -= 1) {
            if (!stderrPending.endsWith(redaction.slice(0, length))) continue;
            const extendable =
              length < redaction.length ||
              stderrRedactions.some(
                (other) => other.length > length && other.startsWith(redaction),
              );
            if (extendable) keep = Math.max(keep, length);
            break;
          }
        }
      }
      const cut = stderrPending.length - keep;
      const processable = stderrPending.slice(0, cut);
      stderrPending = stderrPending.slice(cut);
      let redacted = processable;
      for (const valueToRedact of stderrRedactions) {
        redacted = redacted.replaceAll(valueToRedact, '[redacted]');
      }
      appendStderr(redacted);
    };

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      if (killTimeout !== undefined) clearTimeout(killTimeout);
      flushStderr('', true);
      stdoutSink?.finish();
      stderrSink?.finish();
      const finishStreams = () =>
        resolve({
          exitCode: exitCode ?? 1,
          stdout: Buffer.concat(chunks).toString('utf8'),
          stderr: captureStderr ? Buffer.concat(stderrChunks).toString('utf8') : undefined,
          stderrTruncated: captureStderr ? stderrTruncated : undefined,
          streamError,
          timedOut,
          truncated,
          ...(credentialObserver.observed ? { credentialObserved: true } : {}),
          ...(processError ? { processError: true } : {}),
          ...(errorCode === undefined ? {} : { errorCode }),
        });
      let streams = 0;
      const streamFinished = () => {
        streams -= 1;
        if (streams === 0) finishStreams();
      };
      if (stdoutHandle !== undefined) {
        streams += 1;
        stdoutHandle.end(streamFinished);
      }
      if (stderrHandle !== undefined) {
        streams += 1;
        stderrHandle.end(streamFinished);
      }
      if (streams === 0) finishStreams();
    };

    try {
      child = spawn(command, args, {
        env: options.env ?? process.env,
        stdio: ['ignore', captureStdout ? 'pipe' : 'ignore', captureStderr ? 'pipe' : 'ignore'],
      });
      options.onChild?.(child);
    } catch (error) {
      processError = true;
      errorCode = safeProcessErrorCode(error);
      finish(1);
      return;
    }

    if (captureStdout && child.stdout !== null) {
      child.stdout.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        credentialObserver.observeStdout(buffer);
        appendStdout(buffer);
      });
    }

    if (captureStderr && child.stderr !== null) {
      child.stderr.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        credentialObserver.observeStderr(buffer);
        flushStderr(new TextDecoder().decode(buffer), false);
      });
    }

    timeout = setTimeout(() => {
      timedOut = true;
      stop(child);
      killTimeout = setTimeout(() => stop(child, 'SIGKILL'), 5_000);
    }, options.timeoutMs ?? SETUP_TIMEOUT_MS);
    const handleSpawnError: (error: Error) => void = (error) => {
      processError = true;
      errorCode = safeProcessErrorCode(error);
      finish(1);
    };
    child.once('error', handleSpawnError);
    child.once('close', (exitCode) => finish(exitCode));
  });
};

type RunnerJobState = RunnerJobResponseValue;
type RunnerFailureCauseValue = typeof RunnerFailureCause.Type;

type RunnerJobInputState = {
  claimDeadlineAt?: number;
  repositoryReadTokenExpiresAt?: number;
  reviewConfiguration?: RunnerJobInput['reviewConfiguration'];
  id: string;
  runId: string;
  attempt: number;
  repositoryUrl: string;
  repositoryName: string;
  pullRequestNumber: number;
  baseSha: string;
  headSha: string;
  repositoryReadToken: string;
};

type RunnerMultiReviewEvidence = {
  readonly revision: number;
  readonly selection: MultiReviewSelection;
  readonly rootSessionId: string;
  readonly reviewers: ReadonlyArray<{
    readonly participant: string;
    readonly route: string;
    readonly sessionId: string;
    readonly model: string;
  }>;
  readonly synthesis: ReviewSubmission;
};

type MaintenanceStatus = {
  readonly draining: boolean;
  readonly drained: boolean;
  readonly activeJobs: number;
  readonly claimInFlight: boolean;
  readonly claimPollingHalted: boolean;
  readonly cleanupBlockedJobs: number;
};

type RunnerJob = {
  usage?: ModelUsageSummary;
  readonly state: RunnerJobState;
  readonly admissionKey: string;
  readonly id: string;
  readonly sandboxName: string;
  readonly input: RunnerJobInputState;
  readonly done: Promise<void>;
  resolveDone: () => void;
  child?: ChildProcess;
  sdkController?: AbortController;
  abortRequested: boolean;
  sandboxAttempted: boolean;
  sandboxCreated: boolean;
  hostCleanupConfirmed?: boolean;
  sessionIds: string[];
  multiReview?: RunnerMultiReviewEvidence;
  sandboxRuntime?: JobSandboxRuntime;
  checkoutRoot?: string;
  configRoot?: string;
  grantIssuanceAttempted: boolean;
  grantRevoked: boolean;
  grantToken?: string;
  grantTokenPath?: string;
  grantRoot?: string;
  claimDeadlineAt: number;
  deadlineAt: number;
  deadlineLimit: 'claim' | 'credential';
  readTokenRotationEnabled: boolean;
  readTokenRefreshAt?: number;
  readTokenRefreshTimer?: ReturnType<typeof setTimeout>;
  readTokenDeadlineTimer?: ReturnType<typeof setTimeout>;
  readTokenRefreshController?: AbortController;
  readTokenRefreshInFlight?: Promise<void>;
  readTokenRefreshStopped: boolean;
  readTokenRefreshFailed: boolean;
  readTokenSecrets: string[];
  executionStartedAt?: string;
  submissionCompletedAt?: string;
  cleanupCompletedAt?: string;
  lifecycle?: RunnerProgressSnapshot;
  pendingProgress?: RunnerProgressSnapshot;
  progressController?: AbortController;
  progressStopped: boolean;
};

export interface RunnerOptions {
  readonly sbxPath?: string;
  readonly sandboxRuntime?: SandboxRuntimeKind;
  readonly sandboxCliPath?: string;
  readonly sandboxRuntimeFactory?: SandboxRuntimeFactory;
  /** Opt in to the remote relay control plane over the callback origin. */
  readonly llmRelay?: boolean;
  readonly llmGrantVersion?: 1 | 2;
  readonly llmRelayGeneration?: string;
  readonly microsandboxImage?: string;
  readonly opensandbox?: {
    readonly endpoint?: string;
    readonly apiKeyFile?: string;
    readonly image?: string;
  };
  readonly openshell?: {
    readonly gateway?: string;
    readonly gatewayEndpoint?: string;
    readonly modelProvider?: string;
    readonly image?: string;
    readonly githubProfile?: string;
    readonly insecure?: boolean;
  };
  readonly authToken?: string;
  readonly modelSecretCommand?: string;
  readonly modelConfig?: string;
  readonly evidenceRoot?: string;
  readonly process?: RunnerProcess;
  readonly log?: OperationalLog;
  readonly callbackUrl?: string;
  readonly callbackToken?: string;
  readonly callbackFetch?: typeof fetch;
  readonly progressFetch?: typeof fetch;
  /** Fetch for the authenticated read-token refresh; defaults to callbackFetch. */
  readonly readTokenFetch?: typeof fetch;
  readonly callbackTimeoutMs?: number;
  readonly claimUrl?: string;
  readonly claimFetch?: typeof fetch;
  readonly claimTimeoutMs?: number;
  readonly claimIntervalMs?: number;
  readonly concurrency?: number;
  readonly settingsFile?: string;
}

const authorized = (request: Request, token: string | undefined) => {
  if (token === undefined) return false;
  return request.headers.get('authorization') === `Bearer ${token}`;
};

const jsonResponse = (status: number, value: unknown) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

const readJson = async (request: Request) => {
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_REQUEST_BYTES) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    return undefined;
  }
};

type ParsedAgentResult = {
  readonly recoveredErrors?: number;
  readonly cause?: RunnerFailureCauseValue;
  readonly upstream?: { readonly httpStatus?: number };
};

const parseResult = (stdout: string, recoverySessionId?: string): ParsedAgentResult => {
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
const sessionIdsFrom = (stdout: string): string[] | undefined => {
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

const uniqueSessionIdFrom = (stdout: string): string | undefined => {
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

const mergedAgentResult = (
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

const secureEvidenceTree = async (root: string): Promise<void> => {
  await chmod(root, 0o700);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) {
      await rm(path, { force: true });
      continue;
    }
    if (entry.name === 'auth.json') {
      await rm(path, { force: true });
      continue;
    }
    if (entry.isDirectory()) {
      await secureEvidenceTree(path);
    } else {
      await chmod(path, 0o600);
    }
  }
};

// Redact only the known bounded text evidence surfaces this Runner writes.
// Sandbox databases remain placeholder-only and are never recursively scanned
// or rewritten. latin1 round-trips bytes so an unchanged file is left exact.
const redactEvidenceTextFiles = async (
  evidencePath: string,
  secrets: readonly string[],
  sessionIds: readonly string[],
): Promise<boolean> => {
  const active = secrets.filter((value) => value.length > 0);
  if (active.length === 0) return false;
  let found = false;
  for (const name of [
    'opencode.jsonl',
    'opencode.stderr',
    'validated-review.md',
    'opencode-session-list.json',
    'multi-review.json',
    ...(await readdir(evidencePath)).filter((name) =>
      /^opencode-child-sessions-[1-9]\d*\.json$/.test(name),
    ),
    ...sessionIds.map((id) => `opencode-export-${id}.json`),
  ]) {
    const path = join(evidencePath, name);
    let text: string;
    try {
      text = (await readFile(path)).toString('latin1');
    } catch (error) {
      if (Schema.is(Schema.Struct({ code: Schema.Literal('ENOENT') }))(error)) continue;
      throw error;
    }
    let redacted = text;
    for (const secret of active) redacted = redacted.replaceAll(secret, '[redacted]');
    if (redacted !== text) {
      found = true;
      await writeFile(path, Buffer.from(redacted, 'latin1'), { mode: 0o600 });
    }
  }
  return found;
};

const writeManifestAtomically = async (path: string, value: unknown) => {
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, path);
};

// Persist the exact final callback body before transmission. A local write
// failure must not suppress delivery; the archive is the recovery copy.
const persistCallbackBody = async (evidencePath: string, body: string) => {
  try {
    const path = join(evidencePath, 'callback.json');
    const temporaryPath = `${path}.tmp`;
    await writeFile(temporaryPath, body, { mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
  } catch {
    // Delivery still owns the terminal outcome when persistence is unavailable.
  }
};

const evidenceFiles = async (root: string, prefix = ''): Promise<string[]> => {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await evidenceFiles(join(root, entry.name), relative)));
    else files.push(relative);
  }
  return files.sort();
};

const askpassScript =
  '#!/bin/sh\ncase "$1" in *[Uu]sername*) printf %s x-access-token ;; *) printf %s "$CHECKOUT_TOKEN" ;; esac\n';

const currentIso = () => Effect.runPromise(DateTime.now.pipe(Effect.map(DateTime.formatIso)));
const currentEpochMillis = () =>
  Effect.runPromise(DateTime.now.pipe(Effect.map(DateTime.toEpochMillis)));
const remainingExecutionMs = (job: RunnerJob) => Math.max(0, job.deadlineAt - Date.now());
const deadlineFailure = (job: RunnerJob): NonNullable<RunnerJobState['failure']> => ({
  reason: 'timeout',
  deadline: job.deadlineLimit,
});

export const createRunner = (options: RunnerOptions = {}) => {
  const settingsFileRaw = options.settingsFile ?? process.env.RUNNER_SETTINGS_FILE;
  const settingsFile =
    settingsFileRaw === undefined || settingsFileRaw.trim().length === 0
      ? undefined
      : settingsFileRaw.trim();
  let effectiveConcurrency =
    settingsFile === undefined
      ? resolveConcurrency(options.concurrency, process.env.RUNNER_CONCURRENCY)
      : readRunnerSettingsSync(settingsFile).concurrency;
  const llmServiceSocketRaw = process.env.RUNNER_LLM_SERVICE_SOCKET;
  if (llmServiceSocketRaw !== undefined && llmServiceSocketRaw.trim().length > 0) {
    throw new Error(
      'RUNNER_LLM_SERVICE_SOCKET is no longer supported; use RUNNER_LLM_RELAY with an HTTPS inference origin',
    );
  }
  const sandboxRuntime = resolveSandboxRuntimeConfig({
    kind: options.sandboxRuntime ?? process.env.RUNNER_SANDBOX_RUNTIME,
    cliPath: options.sandboxCliPath ?? process.env.RUNNER_SANDBOX_CLI,
    microsandboxImage: options.microsandboxImage ?? process.env.MICROSANDBOX_IMAGE,
    opensandboxEndpoint: options.opensandbox?.endpoint ?? process.env.OPENSANDBOX_ENDPOINT,
    opensandboxApiKeyFile: options.opensandbox?.apiKeyFile ?? process.env.OPENSANDBOX_API_KEY_FILE,
    opensandboxImage: options.opensandbox?.image ?? process.env.OPENSANDBOX_IMAGE,
    openshellGateway: options.openshell?.gateway ?? process.env.OPENSHELL_GATEWAY,
    openshellEndpoint: options.openshell?.gatewayEndpoint ?? process.env.OPENSHELL_GATEWAY_ENDPOINT,
    openshellModelProvider:
      options.openshell?.modelProvider ?? process.env.OPENSHELL_MODEL_PROVIDER,
    openshellImage: options.openshell?.image ?? process.env.OPENSHELL_IMAGE,
    openshellGithubProfile:
      options.openshell?.githubProfile ?? process.env.OPENSHELL_GITHUB_PROFILE,
    openshellInsecure: options.openshell?.insecure ?? process.env.OPENSHELL_GATEWAY_INSECURE,
  });
  if (sandboxRuntime.kind === 'openshell' && sandboxRuntime.openshell === undefined) {
    throw new Error('OpenShell sandbox runtime configuration is incomplete');
  }
  const relayFlag = options.llmRelay ?? process.env.RUNNER_LLM_RELAY;
  const relayEnabled = isEnabled(relayFlag);
  if (sandboxRuntime.kind === 'microsandbox' && !relayEnabled) {
    throw new Error('Microsandbox requires the managed HTTPS LLM relay');
  }
  if (relayEnabled && sandboxRuntime.kind === 'openshell') {
    throw new Error('LLM service mode does not support the OpenShell sandbox runtime yet');
  }
  const relayCallbackUrl = nonEmpty(options.callbackUrl ?? process.env.RUNNER_CALLBACK_URL);
  const relayCallbackToken = nonEmpty(options.callbackToken ?? process.env.RUNNER_CALLBACK_TOKEN);
  const relayGeneration = nonEmpty(
    options.llmRelayGeneration ?? process.env.RUNNER_LLM_RELAY_GENERATION,
  );
  let relayOrigin: string | undefined;
  let relayToken: string | undefined;
  if (relayEnabled) {
    if (relayCallbackUrl === undefined || relayCallbackToken === undefined) {
      throw new Error('RUNNER_LLM_RELAY requires RUNNER_CALLBACK_URL and RUNNER_CALLBACK_TOKEN');
    }
    if (relayGeneration === undefined) {
      throw new Error('RUNNER_LLM_RELAY requires RUNNER_LLM_RELAY_GENERATION');
    }
    const controlUrl = new URL(relayCallbackUrl);
    if (
      controlUrl.protocol !== 'https:' ||
      controlUrl.username !== '' ||
      controlUrl.password !== '' ||
      controlUrl.search !== '' ||
      controlUrl.hash !== ''
    ) {
      throw new Error('RUNNER_LLM_RELAY requires an HTTPS callback origin');
    }
    relayOrigin = controlUrl.origin;
    relayToken = relayCallbackToken;
  }
  const relayFetch = options.callbackFetch ?? globalThis.fetch;
  const sbxPath = options.sbxPath ?? process.env.SBX_BIN ?? 'sbx';
  const sandboxPortPath =
    options.sandboxCliPath ??
    process.env.RUNNER_SANDBOX_CLI ??
    (sandboxRuntime.kind === 'sbx' ? sbxPath : sandboxRuntime.cliPath);
  const authToken = options.authToken ?? process.env.RUNNER_AUTH_TOKEN;
  const modelSecretCommand = relayEnabled
    ? undefined
    : (options.modelSecretCommand ?? process.env.MODEL_SECRET_COMMAND);
  let opensandboxOptions: Parameters<typeof createOpenSandboxRuntimeFactory>[0] | undefined;
  if (sandboxRuntime.opensandbox !== undefined) {
    if (!relayEnabled) throw new Error('OpenSandbox requires the managed HTTPS LLM relay');
    let apiKey: string;
    try {
      apiKey = readFileSync(sandboxRuntime.opensandbox.apiKeyFile, 'utf8').trim();
      if (apiKey.length === 0) throw new Error('empty');
    } catch {
      throw new Error('invalid OpenSandbox API key file');
    }
    opensandboxOptions = {
      endpoint: sandboxRuntime.opensandbox.endpoint,
      apiKey,
      image: sandboxRuntime.opensandbox.image,
      // A review and teardown fit in two hours. Relay grants retain their
      // separate four-times-budget lifetime.
      lifetimeSeconds: OPENSANDBOX_RESOURCE_LIFETIME_SECONDS,
    };
  }
  const evidenceRoot =
    options.evidenceRoot ??
    process.env.RUNNER_EVIDENCE_ROOT ??
    join(
      process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'),
      'compte-rendu',
      'reviews',
    );
  const sandboxOwnershipRoot = join(evidenceRoot, 'sandbox-owners');
  const executeProcess = options.process ?? runProcess;
  const sandboxRuntimeFactory =
    options.sandboxRuntimeFactory ??
    (sandboxRuntime.microsandboxImage !== undefined
      ? createMicrosandboxRuntimeFactory(
          sandboxRuntime.microsandboxImage,
          (args, _diagnostic, options) => executeProcess(sandboxPortPath, args, options),
          process.env.MICROSANDBOX_ALLOW_FAKE_IP === '1',
        )
      : opensandboxOptions !== undefined
        ? createOpenSandboxRuntimeFactory(opensandboxOptions)
        : sandboxRuntime.kind === 'openshell'
          ? createOpenShellRuntimeFactory(sandboxRuntime.openshell!)
          : createSbxRuntimeFactory({ modelSecretCommand, ownershipRoot: sandboxOwnershipRoot }));
  const modelResolverMissing =
    sandboxRuntime.kind === 'sbx' &&
    !relayEnabled &&
    (modelSecretCommand === undefined || modelSecretCommand.length === 0);
  const modelConfig = decodeReviewModelConfig(
    options.modelConfig ?? process.env.REVIEW_MODEL_CONFIG,
    relayEnabled ? 'relay' : 'direct',
  );
  if (
    relayEnabled &&
    (modelConfig === undefined ||
      modelConfig.baseUrl === undefined ||
      modelConfig.definition === undefined)
  ) {
    throw new Error(
      'LLM service mode requires REVIEW_MODEL_CONFIG with an explicit baseUrl and model definition',
    );
  }
  if (
    relayEnabled &&
    relayOrigin !== undefined &&
    modelConfig?.baseUrl !== undefined &&
    new URL(relayOrigin).hostname.toLowerCase() === modelConfig.baseUrl.hostname.toLowerCase()
  ) {
    throw new Error('Remote LLM relay requires a dedicated inference hostname');
  }
  const grantVersion = String(options.llmGrantVersion ?? process.env.RUNNER_LLM_GRANT_VERSION ?? 1);
  if (relayEnabled && grantVersion !== '1' && grantVersion !== '2')
    throw new Error('Invalid RUNNER_LLM_GRANT_VERSION');
  const llmServiceClient =
    relayEnabled && relayOrigin !== undefined && relayToken !== undefined
      ? createRelayLlmServiceClient({
          grantVersion: grantVersion === '2' ? 2 : 1,
          origin: relayOrigin,
          token: relayToken,
          fetch: relayFetch,
        })
      : undefined;
  const activeGrantIssuer: GrantIssuer | undefined =
    relayEnabled && relayOrigin !== undefined && relayGeneration !== undefined
      ? { transport: 'relay', origin: relayOrigin, generation: relayGeneration }
      : undefined;
  const modelId = modelConfig?.id;
  const serviceBaseUrl = modelConfig?.baseUrl;
  const modelResource = `${serviceBaseUrl?.hostname ?? MODEL_HOST}:${serviceBaseUrl?.port || MODEL_PORT}`;
  const openCodeConfig = modelConfig === undefined ? undefined : trustedOpenCodeConfig(modelConfig);
  // Issuer-bound durable markers. A marker is written before issuance and
  // removed only after confirmed revocation, so a crash leaves both the job
  // identity and the trusted transport/backend generation to revoke on the next
  // startup or maintenance call. The raw token is never persisted.
  const pendingGrantRoot = join(evidenceRoot, 'llm-grant-pending');
  const markerNameFor = (jobId: string) =>
    `${createHash('sha256').update(jobId).digest('hex')}.marker`;
  const grantMarkerPath = (jobId: string) => join(pendingGrantRoot, markerNameFor(jobId));
  type GrantMarkerRead =
    | { readonly kind: 'missing' }
    | { readonly kind: 'invalid' }
    | { readonly kind: 'present'; readonly jobId: string; readonly issuer: GrantIssuer };
  const readGrantMarker = async (path: string): Promise<GrantMarkerRead> => {
    let value: string;
    try {
      value = await readFile(path, 'utf8');
    } catch (error) {
      return Schema.is(Schema.Struct({ code: Schema.Literal('ENOENT') }))(error)
        ? { kind: 'missing' }
        : { kind: 'invalid' };
    }
    const decoded = Option.getOrUndefined(
      Schema.decodeUnknownOption(Schema.fromJsonString(GrantMarker), { onExcessProperty: 'error' })(
        value,
      ),
    );
    if (decoded === undefined || markerNameFor(decoded.jobId) !== basename(path))
      return { kind: 'invalid' };
    return { kind: 'present', jobId: decoded.jobId, issuer: decoded.issuer };
  };
  const writeGrantMarker = async (jobId: string) => {
    const issuer = activeGrantIssuer;
    if (!issuer) throw new Error('missing relay grant issuer');
    await mkdir(pendingGrantRoot, { recursive: true, mode: 0o700 });
    await writeFile(grantMarkerPath(jobId), `${JSON.stringify({ version: 1, jobId, issuer })}\n`, {
      mode: 0o600,
    });
  };
  const clearGrantMarker = async (jobId: string) => {
    try {
      await rm(grantMarkerPath(jobId), { force: true });
    } catch {
      // A stale marker only causes a redundant identity revocation next start.
    }
  };
  const revokeRecordedGrant = async (
    jobId: string,
    issuer: GrantIssuer | undefined,
  ): Promise<boolean> => {
    const client = llmServiceClient;
    if (
      !client ||
      !issuer ||
      !activeGrantIssuer ||
      activeGrantIssuer.origin !== issuer.origin ||
      activeGrantIssuer.generation !== issuer.generation
    )
      return false;
    const deadline = Date.now() + GRANT_REVOKE_BUDGET_MS;
    for (let attempt = 0; attempt < GRANT_REVOKE_ATTEMPTS; attempt += 1) {
      try {
        await client.revoke(jobId);
        await clearGrantMarker(jobId);
        return true;
      } catch {
        // A bounded retry keeps a transient control failure from losing revocation.
      }
      if (Date.now() >= deadline) break;
    }
    return false;
  };

  const log = options.log;
  const callbackUrl = options.callbackUrl ?? process.env.RUNNER_CALLBACK_URL;
  const callbackToken = options.callbackToken ?? process.env.RUNNER_CALLBACK_TOKEN;
  const callbackFetch = options.callbackFetch ?? globalThis.fetch;
  const progressFetch = options.progressFetch ?? globalThis.fetch;
  const callbackTimeoutMs = options.callbackTimeoutMs ?? CALLBACK_REQUEST_TIMEOUT_MS;
  const claimUrl =
    options.claimUrl ??
    (callbackUrl === undefined
      ? undefined
      : (() => {
          try {
            return new URL('/runner-claim', callbackUrl).toString();
          } catch {
            return undefined;
          }
        })());
  const claimFetch = options.claimFetch ?? globalThis.fetch;
  const claimTimeoutMs = options.claimTimeoutMs ?? CLAIM_REQUEST_TIMEOUT_MS;
  const claimIntervalMs = options.claimIntervalMs ?? 1000;
  const readTokenUrl =
    callbackUrl === undefined
      ? undefined
      : (() => {
          try {
            return new URL('/runner-read-token', callbackUrl).toString();
          } catch {
            return undefined;
          }
        })();
  const readTokenClient: ReadTokenClient | undefined =
    readTokenUrl === undefined || callbackToken === undefined
      ? undefined
      : createReadTokenClient({
          url: readTokenUrl,
          token: callbackToken,
          fetch: options.readTokenFetch ?? callbackFetch,
        });
  // sbx rereads the credential file on demand. microsandbox updates its live host-side secret.
  const readTokenRotationSupported =
    readTokenClient !== undefined &&
    (sandboxRuntime.kind === 'sbx' || sandboxRuntime.kind === 'microsandbox');
  const readTokenSecretValues = (job: RunnerJob): string[] =>
    [...new Set([job.input.repositoryReadToken, ...job.readTokenSecrets])].filter(
      (value) => value.length > 0,
    );
  const clearReadTokenRefreshTimer = (job: RunnerJob) => {
    if (job.readTokenRefreshTimer !== undefined) clearTimeout(job.readTokenRefreshTimer);
    job.readTokenRefreshTimer = undefined;
  };
  const clearReadTokenDeadlineTimer = (job: RunnerJob) => {
    if (job.readTokenDeadlineTimer !== undefined) clearTimeout(job.readTokenDeadlineTimer);
    job.readTokenDeadlineTimer = undefined;
  };
  const stopActiveExecution = (job: RunnerJob) => {
    job.sdkController?.abort();
    const child = job.child;
    if (child !== undefined) {
      stop(child);
      setTimeout(() => stop(child, 'SIGKILL'), 5_000);
    }
  };
  const reachCredentialDeadline = (job: RunnerJob) => {
    if (job.readTokenRefreshStopped) return;
    clearReadTokenRefreshTimer(job);
    clearReadTokenDeadlineTimer(job);
    if (Date.now() >= job.deadlineAt) stopActiveExecution(job);
  };
  const scheduleCredentialDeadline = (job: RunnerJob, deadlineAt: number) => {
    clearReadTokenDeadlineTimer(job);
    const delay = Math.max(0, deadlineAt - Date.now());
    if (delay === 0) {
      reachCredentialDeadline(job);
      return;
    }
    const timer = setTimeout(() => {
      if (job.readTokenDeadlineTimer !== timer) return;
      job.readTokenDeadlineTimer = undefined;
      reachCredentialDeadline(job);
    }, delay);
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      (timer as { unref: () => void }).unref();
    }
    job.readTokenDeadlineTimer = timer;
  };
  const readTokenRefreshLead = (expiresAt: number) => {
    const remaining = Math.max(0, expiresAt - Date.now());
    return Math.min(READ_TOKEN_REFRESH_LEAD_MS, Math.floor(remaining / 2));
  };
  const credentialExpiryNeedsRefresh = (job: RunnerJob) => {
    const expiresAt = job.input.repositoryReadTokenExpiresAt;
    return (
      expiresAt !== undefined &&
      expiresAt <= job.claimDeadlineAt + CREDENTIAL_EXPIRY_SAFETY_MARGIN_MS
    );
  };
  const applyCredentialFallback = (job: RunnerJob, fallbackAt: number) => {
    if (job.readTokenRefreshStopped || job.readTokenRefreshFailed) return;
    job.readTokenRefreshFailed = true;
    clearReadTokenRefreshTimer(job);
    if (fallbackAt < job.deadlineAt) {
      job.deadlineAt = fallbackAt;
      job.deadlineLimit = 'credential';
      scheduleCredentialDeadline(job, fallbackAt);
    }
    void Effect.runPromise(
      Effect.logWarning('runner.read-token.refresh-failed', { jobId: job.id }),
    ).catch(() => undefined);
  };
  const scheduleReadTokenRefresh = (job: RunnerJob) => {
    clearReadTokenRefreshTimer(job);
    if (
      !job.readTokenRotationEnabled ||
      job.readTokenRefreshStopped ||
      job.readTokenRefreshFailed ||
      !credentialExpiryNeedsRefresh(job)
    ) {
      job.readTokenRefreshAt = undefined;
      return;
    }
    const expiresAt = job.input.repositoryReadTokenExpiresAt!;
    const refreshAt = expiresAt - readTokenRefreshLead(expiresAt);
    job.readTokenRefreshAt = refreshAt;
    const delay = Math.max(0, refreshAt - Date.now());
    const timer = setTimeout(() => {
      if (job.readTokenRefreshTimer !== timer) return;
      job.readTokenRefreshTimer = undefined;
      void refreshReadToken(job)
        .then(() => scheduleReadTokenRefresh(job))
        .catch(() => undefined);
    }, delay);
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      (timer as { unref: () => void }).unref();
    }
    job.readTokenRefreshTimer = timer;
  };
  const refreshReadToken = async (job: RunnerJob): Promise<void> => {
    if (
      !job.readTokenRotationEnabled ||
      readTokenClient === undefined ||
      job.readTokenRefreshStopped ||
      job.readTokenRefreshFailed
    ) {
      return;
    }
    if (job.readTokenRefreshInFlight !== undefined) return job.readTokenRefreshInFlight;
    const expiresAt = job.input.repositoryReadTokenExpiresAt;
    if (expiresAt === undefined) return;
    const controller = new AbortController();
    job.readTokenRefreshController = controller;
    const refresh = (async () => {
      try {
        const refreshed = await readTokenClient.refresh(
          {
            runId: job.input.runId,
            jobId: job.id,
            attempt: job.input.attempt,
          },
          controller.signal,
        );
        if (job.readTokenRefreshStopped) return;
        const nextExpiresAt = refreshed.expiresAt;
        if (
          !Number.isFinite(nextExpiresAt) ||
          nextExpiresAt <= Date.now() ||
          nextExpiresAt <= expiresAt
        ) {
          applyCredentialFallback(job, expiresAt - CREDENTIAL_EXPIRY_SAFETY_MARGIN_MS);
          return;
        }
        // Register before installing the token so cleanup racing the rotation
        // also redacts it. The original claim token is retained at admission.
        if (!job.readTokenSecrets.includes(refreshed.token)) {
          job.readTokenSecrets.push(refreshed.token);
        }
        const runtime = job.sandboxRuntime;
        if (runtime !== undefined) {
          if (runtime.rotateGithubReadToken === undefined) {
            applyCredentialFallback(job, expiresAt - CREDENTIAL_EXPIRY_SAFETY_MARGIN_MS);
            return;
          }
          try {
            await runtime.rotateGithubReadToken(refreshed.token);
          } catch {
            if (!job.readTokenRefreshStopped) {
              applyCredentialFallback(job, expiresAt - CREDENTIAL_EXPIRY_SAFETY_MARGIN_MS);
            }
            return;
          }
        }
        if (job.readTokenRefreshStopped) return;
        job.input.repositoryReadToken = refreshed.token;
        job.input.repositoryReadTokenExpiresAt = nextExpiresAt;
      } catch {
        if (!job.readTokenRefreshStopped) {
          applyCredentialFallback(job, expiresAt - CREDENTIAL_EXPIRY_SAFETY_MARGIN_MS);
        }
      } finally {
        if (job.readTokenRefreshController === controller) {
          job.readTokenRefreshController = undefined;
        }
      }
    })();
    job.readTokenRefreshInFlight = refresh;
    try {
      await refresh;
    } finally {
      if (job.readTokenRefreshInFlight === refresh) job.readTokenRefreshInFlight = undefined;
    }
  };
  const ensureReadTokenFresh = async (job: RunnerJob) => {
    if (
      !job.readTokenRotationEnabled ||
      job.readTokenRefreshStopped ||
      job.readTokenRefreshFailed ||
      !credentialExpiryNeedsRefresh(job)
    ) {
      return;
    }
    const expiresAt = job.input.repositoryReadTokenExpiresAt!;
    const refreshAt =
      job.readTokenRefreshAt ??
      expiresAt - Math.min(READ_TOKEN_REFRESH_LEAD_MS, readTokenRefreshLead(expiresAt));
    if (Date.now() >= refreshAt) {
      await refreshReadToken(job);
      scheduleReadTokenRefresh(job);
    }
  };
  const stopReadTokenRefresh = (job: RunnerJob) => {
    job.readTokenRefreshStopped = true;
    clearReadTokenRefreshTimer(job);
    clearReadTokenDeadlineTimer(job);
    job.readTokenRefreshController?.abort();
  };
  const strippedSandboxEnvironment = {
    ...process.env,
    SSH_AUTH_SOCK: undefined,
    SSH_AGENT_PID: undefined,
    GH_TOKEN: undefined,
    GITHUB_TOKEN: undefined,
  };
  const recoveringCleanup = new Set<string>();
  const jobs = new Map<string, RunnerJob>();
  const jobsByRun = new Map<string, RunnerJob>();
  let history: ReturnType<typeof createTerminalJobHistory> | undefined;
  const retireDestroyedJob = (job: RunnerJob) => {
    if (job.state.sandbox.cleanup !== 'destroyed') return;
    try {
      history ??= createTerminalJobHistory();
      history.save(job.state, job.admissionKey);
    } catch {
      // Retain lookup and duplicate protection if temporary storage is unavailable.
      return;
    }
    jobs.delete(job.id);
    jobsByRun.delete(`${job.input.runId}:${job.input.attempt}`);
  };

  let claiming = false;
  let claimRequestId: string | undefined;
  const stopsDuringClaim = new Map<
    string,
    { deadline: number; timer: ReturnType<typeof setTimeout> }
  >();
  const forgetStops = () => {
    for (const stop of stopsDuringClaim.values()) clearTimeout(stop.timer);
    stopsDuringClaim.clear();
  };
  let claimPollingHalted = false;
  let draining = false;
  let claimGateFailureLogged = false;
  let requestNextJob: (() => void) | undefined;
  // Admission and claim stay gated until startup recovery has resolved every
  // own pending grant marker; an unresolved or foreign issuer keeps the gate
  // closed and is never cleared through another backend's success.
  const recoverPendingGrants = async () => {
    let names: string[] = [];
    try {
      names = await readdir(pendingGrantRoot);
    } catch (error) {
      // Only a missing directory means "no markers". Any other readdir error
      // must keep admission and claim gated rather than fail open.
      if (!Schema.is(Schema.Struct({ code: Schema.Literal('ENOENT') }))(error)) return false;
      names = [];
    }
    let unresolved = false;
    for (const name of names) {
      if (!name.endsWith('.marker')) continue;
      const marker = await readGrantMarker(join(pendingGrantRoot, name));
      if (marker.kind !== 'present') {
        unresolved = true;
        continue;
      }
      if (!(await revokeRecordedGrant(marker.jobId, marker.issuer))) unresolved = true;
    }
    return !unresolved;
  };
  let grantsRecovered: boolean | undefined;
  const startGrantRecovery = () => {
    grantsRecovered = undefined;
    return recoverPendingGrants()
      .catch(() => false)
      .then((recovered) => {
        grantsRecovered = recovered;
        return recovered;
      });
  };
  let grantRecovery = startGrantRecovery();
  let sandboxRecovered: boolean | undefined;
  const startSandboxRecovery = () => {
    sandboxRecovered = undefined;
    if (sandboxRuntime.kind !== 'sbx') {
      sandboxRecovered = true;
      return Promise.resolve(true);
    }
    const command: SandboxCommand = (args, _diagnostic, processOptions) =>
      executeProcess(sandboxPortPath, args, {
        ...processOptions,
        env: strippedSandboxEnvironment,
        captureStdout: true,
        captureStderr: true,
        maxBytes: 256 * 1024,
        timeoutMs: CLEANUP_COMMAND_TIMEOUT_MS,
      });
    return reconcileSbxRestartResources(sandboxOwnershipRoot, command)
      .catch(() => false)
      .then((recovered) => {
        sandboxRecovered = recovered;
        return recovered;
      });
  };
  const sandboxRecovery = startSandboxRecovery();
  const activeJobCount = () =>
    [...jobs.values()].filter(
      (candidate) => candidate.state.status === 'queued' || candidate.state.status === 'running',
    ).length;
  const cleanupBlockedJobCount = () =>
    [...jobs.values()].filter(
      (candidate) =>
        (candidate.state.status === 'succeeded' ||
          candidate.state.status === 'failed' ||
          candidate.state.status === 'aborted') &&
        candidate.state.sandbox.cleanup !== 'destroyed',
    ).length;
  const maintenanceStatus = (): MaintenanceStatus => {
    const activeJobs = activeJobCount();
    const cleanupBlockedJobs = cleanupBlockedJobCount();
    return {
      draining,
      drained:
        draining &&
        grantsRecovered === true &&
        sandboxRecovered === true &&
        activeJobs === 0 &&
        !claiming &&
        claimRequestId === undefined &&
        !claimPollingHalted &&
        cleanupBlockedJobs === 0 &&
        recoveringCleanup.size === 0,
      activeJobs,
      claimInFlight: claiming || (!claimPollingHalted && claimRequestId !== undefined),
      claimPollingHalted:
        claimPollingHalted || grantsRecovered === false || sandboxRecovered === false,
      cleanupBlockedJobs,
    };
  };
  const hasCapacity = () => activeJobCount() + (claiming ? 1 : 0) < effectiveConcurrency;
  const hasUnclearedSamePullRequest = (input: RunnerJobInputState) =>
    [...jobs.values()].some(
      (candidate) =>
        candidate.state.sandbox.cleanup !== 'destroyed' &&
        candidate.input.repositoryName === input.repositoryName &&
        candidate.input.pullRequestNumber === input.pullRequestNumber,
    );

  const sendProgress = async (job: RunnerJob) => {
    if (
      job.progressStopped ||
      job.progressController !== undefined ||
      callbackUrl === undefined ||
      callbackToken === undefined
    )
      return;
    const snapshot = job.pendingProgress;
    if (snapshot === undefined) return;
    job.pendingProgress = undefined;
    const controller = new AbortController();
    job.progressController = controller;
    const timeout = setTimeout(() => controller.abort(), 2_000);
    try {
      await Promise.race([
        progressFetch(new URL('/runner-progress', callbackUrl).toString(), {
          method: 'POST',
          headers: { authorization: `Bearer ${callbackToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            id: job.id,
            runId: job.input.runId,
            attempt: job.input.attempt,
            ...snapshot,
          }),
          signal: controller.signal,
        }).then(async (response) => {
          await response.body?.cancel();
        }),
        new Promise<void>((resolve) =>
          controller.signal.addEventListener('abort', () => resolve(), { once: true }),
        ),
      ]);
    } catch {
      // Progress is best effort; the terminal callback carries the cumulative snapshot.
    } finally {
      clearTimeout(timeout);
      job.progressController = undefined;
      if (!job.progressStopped && job.pendingProgress !== undefined) void sendProgress(job);
    }
  };

  const reportStage = (job: RunnerJob, stage: RunnerProgressStage) => {
    if (job.progressStopped || job.lifecycle?.milestones.some((entry) => entry.stage === stage))
      return;
    const snapshot: RunnerProgressSnapshot = {
      sequence: (job.lifecycle?.sequence ?? 0) + 1,
      stage,
      milestones: [
        ...(job.lifecycle?.milestones ?? []),
        {
          stage,
          ...(stage === 'sandbox'
            ? { runtime: job.sandboxRuntime?.metadata.runtime ?? sandboxRuntime.kind }
            : {}),
          startedAt: DateTime.formatIso(DateTime.nowUnsafe()),
        },
      ],
    };
    job.lifecycle = snapshot;
    job.pendingProgress = snapshot;
    void sendProgress(job);
  };

  const update = (job: RunnerJob, state: Partial<RunnerJobState>) => {
    Object.assign(job.state, state);
  };

  const boundedDiagnostic = (job: RunnerJob, value: string | undefined) => {
    if (value === undefined || value.length === 0) return undefined;
    let sanitized = value;
    for (const secret of [...readTokenSecretValues(job), modelSecretCommand, job.grantToken]) {
      if (secret !== undefined && secret.length > 0)
        sanitized = sanitized.replaceAll(secret, '[redacted]');
    }
    sanitized = sanitized.replaceAll(job.input.repositoryUrl, '[repository]');
    sanitized = Array.from(sanitized, (character) => {
      const code = character.charCodeAt(0);
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 126)
        ? character
        : '?';
    }).join('');
    const bytes = new TextEncoder().encode(sanitized);
    return bytes.length <= MAX_DIAGNOSTIC_STDERR_BYTES
      ? sanitized
      : new TextDecoder().decode(bytes.subarray(0, MAX_DIAGNOSTIC_STDERR_BYTES));
  };

  // A logger failure must never change the Runner Job outcome.
  const recordLog = async (event: OperationalLogEvent) => {
    if (log === undefined) return;
    try {
      await log.record(sanitizeOperationalLogEvent(event));
    } catch {
      // Diagnostics must not change the Runner Job outcome.
    }
  };

  const recordCommand = async (
    job: RunnerJob,
    diagnostic: RunnerDiagnostic,
    result: RunnerProcessResult,
  ) => {
    const event: OperationalLogEvent = {
      phase: 'runner',
      outcome: 'command',
      runId: job.input.runId,
      stage: diagnostic.stage,
      command: diagnostic.command,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      truncated: result.truncated === true,
      stderrTruncated: result.stderrTruncated === true,
      streamError: result.streamError === true,
      abortRequested: job.abortRequested,
      processError: result.processError === true,
      ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
      ...(diagnostic.includeStderr === true ||
      (diagnostic.stage === 'checkout' && (result.exitCode !== 0 || result.timedOut))
        ? (() => {
            const stderr = boundedDiagnostic(job, result.stderr);
            return stderr === undefined ? {} : { stderr };
          })()
        : {}),
    };
    await recordLog(event);
  };

  const runSdkOperation = async (
    job: RunnerJob,
    operation: SandboxOperation,
    diagnostic: RunnerDiagnostic | undefined,
    processOptions: RunnerProcessOptions = {},
    timeoutMs: number,
    abortable: boolean,
  ): Promise<RunnerProcessResult> => {
    const controller = new AbortController();
    let timedOut = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const failed = (): RunnerProcessResult => ({
      exitCode: 1,
      stdout: '',
      timedOut,
      truncated: false,
      streamError: true,
    });
    if (abortable && job.abortRequested) return failed();
    if (abortable) job.sdkController = controller;
    const stopped = new Promise<RunnerProcessResult>((resolve) => {
      controller.signal.addEventListener(
        'abort',
        () => {
          grace = setTimeout(() => resolve(failed()), 5_000);
        },
        { once: true },
      );
    });
    const timer = setTimeout(
      () => {
        timedOut = true;
        controller.abort();
      },
      Math.max(1, timeoutMs),
    );
    let result: RunnerProcessResult;
    try {
      result = await Promise.race([
        operation({
          ...processOptions,
          maxBytes:
            processOptions.maxBytes ??
            (diagnostic === undefined ? undefined : MAX_DIAGNOSTIC_STDERR_BYTES),
          signal: controller.signal,
          timeoutMs,
          captureStderr: processOptions.captureStderr ?? diagnostic !== undefined,
          stderrRedactions: [
            ...readTokenSecretValues(job),
            job.grantToken,
            ...(processOptions.stderrRedactions ?? []),
          ].filter((value): value is string => value !== undefined && value.length > 0),
          credentialValues: [
            ...readTokenSecretValues(job),
            job.grantToken,
            ...(processOptions.credentialValues ?? []),
          ].filter((value): value is string => value !== undefined && value.length > 0),
        }).catch(failed),
        stopped,
      ]);
      if (timedOut) result = { ...result, exitCode: 1, timedOut: true };
    } finally {
      clearTimeout(timer);
      if (grace !== undefined) clearTimeout(grace);
      if (job.sdkController === controller) job.sdkController = undefined;
    }
    if (diagnostic !== undefined) await recordCommand(job, diagnostic, result);
    return result;
  };

  const runTracked = async (
    job: RunnerJob,
    command: string,
    args: readonly string[],
    processOptions: RunnerProcessOptions = {},
    diagnostic?: RunnerDiagnostic,
  ) => {
    const requestedTimeout = processOptions.timeoutMs ?? SETUP_TIMEOUT_MS;
    const remaining = remainingExecutionMs(job);
    let result: RunnerProcessResult;
    try {
      const sandboxEnvironment =
        command === sandboxPortPath
          ? (processOptions.env ?? strippedSandboxEnvironment)
          : processOptions.env;
      result = await executeProcess(command, args, {
        ...processOptions,
        env: sandboxEnvironment,
        captureStderr: processOptions.captureStderr ?? diagnostic !== undefined,
        stderrRedactions:
          diagnostic === undefined
            ? processOptions.stderrRedactions
            : [
                ...readTokenSecretValues(job),
                modelSecretCommand,
                job.grantToken,
                job.input.repositoryUrl,
              ].filter((value): value is string => value !== undefined && value.length > 0),
        credentialValues: [
          ...readTokenSecretValues(job),
          job.grantToken,
          ...(processOptions.credentialValues ?? []),
        ].filter((value): value is string => value !== undefined && value.length > 0),
        maxBytes:
          diagnostic === undefined
            ? processOptions.maxBytes
            : (processOptions.maxBytes ?? MAX_DIAGNOSTIC_STDERR_BYTES),
        timeoutMs: Math.max(1, Math.min(requestedTimeout, remaining)),
        onChild: (child) => {
          job.child = child;
          processOptions.onChild?.(child);
          if (job.abortRequested) stop(child);
        },
      });
    } catch (error) {
      result = processFailure(error);
    }
    job.child = undefined;
    if (diagnostic !== undefined) await recordCommand(job, diagnostic, result);
    return result;
  };

  const runArchive = async (
    job: RunnerJob,
    command: string,
    args: readonly string[],
    deadlineAt: number,
    processOptions: RunnerProcessOptions = {},
    diagnostic?: RunnerDiagnostic,
  ) => {
    let remaining: number;
    try {
      remaining = deadlineAt - (await currentEpochMillis());
    } catch {
      return { exitCode: 1, stdout: '', timedOut: true, truncated: false };
    }
    if (remaining <= 0) {
      return { exitCode: 1, stdout: '', timedOut: true, truncated: false };
    }
    let result: RunnerProcessResult;
    try {
      result = await executeProcess(command, args, {
        ...processOptions,
        env:
          command === sandboxPortPath
            ? (processOptions.env ?? strippedSandboxEnvironment)
            : processOptions.env,
        captureStderr: processOptions.captureStderr ?? diagnostic !== undefined,
        timeoutMs: Math.max(
          1,
          Math.min(processOptions.timeoutMs ?? ARCHIVE_COMMAND_TIMEOUT_MS, remaining),
        ),
      });
    } catch (error) {
      result = processFailure(error);
    }
    if (diagnostic !== undefined) await recordCommand(job, diagnostic, result);
    return result;
  };

  const archiveEvidence = async (
    job: RunnerJob,
    evidencePath: string,
    agent: RunnerProcessResult | undefined,
    submissionSessionId: string | undefined,
    deadlineAt: number,
  ): Promise<{ readonly complete: boolean; readonly terminal: boolean }> => {
    let complete = agent?.streamError !== true;
    let terminal = false;
    const fileExists = async (path: string) => {
      try {
        await stat(path);
        return true;
      } catch {
        return false;
      }
    };
    const nonemptyFile = async (path: string) => {
      try {
        return (await stat(path)).size > 0;
      } catch {
        return false;
      }
    };
    const sessionExportMatches = async (path: string, sessionId: string) => {
      try {
        const decoded = Schema.decodeUnknownOption(OpenCodeSessionExport)(
          JSON.parse(await readFile(path, 'utf8')),
        );
        return Option.isSome(decoded) && decoded.value.info.id === sessionId;
      } catch {
        return false;
      }
    };
    const sessionExportSucceeded = async (path: string, sessionId: string) => {
      try {
        return sessionSucceeded(JSON.parse(await readFile(path, 'utf8')), sessionId);
      } catch {
        return false;
      }
    };
    if (!(await nonemptyFile(join(evidencePath, 'opencode.jsonl')))) complete = false;
    if (!(await fileExists(join(evidencePath, 'opencode.stderr')))) complete = false;

    const runtime = job.sandboxRuntime;
    const archiveCommand: SandboxCommand = Object.assign(
      (
        args: readonly string[],
        diagnostic?: RunnerDiagnostic,
        processOptions?: RunnerProcessOptions,
      ) => runArchive(job, sandboxPortPath, args, deadlineAt, processOptions, diagnostic),
      {
        execute: (
          operation: SandboxOperation,
          diagnostic?: RunnerDiagnostic,
          processOptions?: RunnerProcessOptions,
        ) =>
          runSdkOperation(
            job,
            operation,
            diagnostic,
            processOptions,
            Math.min(
              processOptions?.timeoutMs ?? ARCHIVE_COMMAND_TIMEOUT_MS,
              deadlineAt - Date.now(),
            ),
            false,
          ),
      },
    );
    if (runtime === undefined) {
      complete = false;
    } else {
      const evidenceRoot = runtime.metadata.evidenceRoot;
      const sessions = await runtime.exec(
        ['opencode', 'session', 'list', '--standalone', '--format', 'json'],
        archiveCommand,
        {
          captureStdout: true,
          maxBytes: MAX_AGENT_OUTPUT_BYTES,
        },
      );
      if (
        sessions.exitCode !== 0 ||
        sessions.timedOut ||
        sessions.truncated ||
        sessions.stdout.length === 0
      ) {
        complete = false;
      } else {
        await writeFile(join(evidencePath, 'opencode-session-list.json'), sessions.stdout, {
          mode: 0o600,
        });
        const sessionIds = sessionIdsFrom(sessions.stdout);
        if (sessionIds === undefined || sessionIds.length === 0) {
          complete = false;
        } else {
          job.sessionIds = [...sessionIds];
          const exportSession = async (sessionId: string): Promise<boolean> => {
            const exportPath = join(evidencePath, `opencode-export-${sessionId}.json`);
            const sandboxExportPath = `${evidenceRoot}/opencode-export-${sessionId}.json`;
            const exported = await runtime.exec(
              [
                'sh',
                '-c',
                `opencode session export --standalone ${sessionId} > ${sandboxExportPath}`,
              ],
              archiveCommand,
              {},
            );
            const copied = await runtime.copyOut(sandboxExportPath, exportPath, archiveCommand);
            const exportReadable =
              exported.exitCode === 0 &&
              !exported.timedOut &&
              exported.streamError !== true &&
              copied.exitCode === 0 &&
              !copied.timedOut &&
              copied.streamError !== true;
            return exportReadable && (await sessionExportMatches(exportPath, sessionId));
          };
          for (const sessionId of sessionIds) {
            if (!(await exportSession(sessionId))) {
              complete = false;
              continue;
            }
            if (sessionId === submissionSessionId) {
              terminal = await sessionExportSucceeded(
                join(evidencePath, `opencode-export-${sessionId}.json`),
                sessionId,
              );
            }
          }
          const multiSelection = job.input.reviewConfiguration?.selection ?? undefined;
          if (multiSelection !== undefined) {
            if (sessionIds.length !== 1) {
              complete = false;
            } else {
              const rootSessionId = sessionIds[0]!;
              // Follow native session.list pagination: request the parent
              // filter plus the previous page's next cursor, and keep going
              // until an empty page or an enumeration error. Child evidence is
              // best effort; duplicate records are skipped and repeated cursors
              // stop enumeration. Every readable raw page is retained.
              const listChildSessions = async (): Promise<readonly ChildSession[] | undefined> => {
                const collected: ChildSession[] = [];
                const seenIds = new Set<string>();
                const seenCursors = new Set<string>();
                let cursor: string | null = null;
                for (let page = 1; page <= MAX_CHILD_SESSION_PAGES; page += 1) {
                  const args = [
                    'opencode',
                    'api',
                    '--standalone',
                    'session.list',
                    '--param',
                    `parentID=${rootSessionId}`,
                  ];
                  if (cursor !== null) args.push('--param', `cursor=${cursor}`);
                  const listed = await runtime.exec(args, archiveCommand, {
                    captureStdout: true,
                    maxBytes: MAX_AGENT_OUTPUT_BYTES,
                  });
                  if (
                    listed.exitCode !== 0 ||
                    listed.timedOut ||
                    listed.truncated ||
                    listed.stdout.length === 0
                  ) {
                    return undefined;
                  }
                  await writeFile(
                    join(evidencePath, `opencode-child-sessions-${page}.json`),
                    listed.stdout,
                    { mode: 0o600 },
                  );
                  const parsed = parseChildSessionPage(listed.stdout);
                  if (parsed === undefined) return undefined;
                  for (const child of parsed.data) {
                    if (seenIds.has(child.id)) continue;
                    seenIds.add(child.id);
                    collected.push(child);
                  }
                  if (parsed.data.length === 0) return collected;
                  const next = parsed.cursor.next;
                  if (next === null) return collected;
                  if (next === cursor || seenCursors.has(next)) return collected;
                  seenCursors.add(next);
                  cursor = next;
                }
                return undefined;
              };
              // Child sessions are best-effort provenance. Unavailable or
              // extra children never fail the job and never cap the roster.
              const listed = await listChildSessions();
              if (listed !== undefined) {
                for (const child of listed) {
                  if (await exportSession(child.id)) job.sessionIds.push(child.id);
                }
              }
            }
          }
        }
      }
      for (const tree of ['data', 'state']) {
        const destination = join(evidencePath, `opencode-${tree}`);
        const copied = await runtime.copyOut(
          `${evidenceRoot}/${tree}`,
          destination,
          archiveCommand,
          { stage: 'sandbox', command: `archive-opencode-${tree}`, includeStderr: true },
        );
        if (copied.exitCode !== 0 || copied.timedOut) complete = false;
      }
    }
    await secureEvidenceTree(evidencePath);
    const files = await evidenceFiles(evidencePath);
    const hasNonemptyFile = async (predicate: (file: string) => boolean) => {
      for (const file of files) {
        if (predicate(file) && (await nonemptyFile(join(evidencePath, file)))) return true;
      }
      return false;
    };
    if (
      !(await hasNonemptyFile((file) => file.endsWith('/opencode.db') || file === 'opencode.db'))
    ) {
      complete = false;
    }
    if (!(await hasNonemptyFile((file) => file.endsWith('.log')))) complete = false;
    if (job.sessionIds.some((sessionId) => !files.includes(`opencode-export-${sessionId}.json`))) {
      complete = false;
    }
    return { complete, terminal };
  };

  const prepareCheckout = async (job: RunnerJob, root: string): Promise<string | undefined> => {
    const checkoutPath = join(root, 'checkout');
    const askpassPath = join(root, 'askpass');
    await writeFile(askpassPath, askpassScript, { mode: 0o700 });
    const env = {
      ...process.env,
      CHECKOUT_TOKEN: job.input.repositoryReadToken,
      GIT_ASKPASS: askpassPath,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_LFS_SKIP_SMUDGE: '1',
      GIT_TERMINAL_PROMPT: '0',
    };
    const clone = await runTracked(
      job,
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'submodule.recurse=false',
        '-c',
        'filter.lfs.smudge=:',
        'clone',
        '--quiet',
        '--no-checkout',
        '--no-recurse-submodules',
        job.input.repositoryUrl,
        checkoutPath,
      ],
      { env },
      { stage: 'checkout', command: 'clone' },
    );
    if (clone.exitCode !== 0 || clone.timedOut) return undefined;
    const fetch = await runTracked(
      job,
      'git',
      [
        '-C',
        checkoutPath,
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'submodule.recurse=false',
        'fetch',
        '--quiet',
        '--no-tags',
        '--no-recurse-submodules',
        'origin',
        `+${job.input.baseSha}:refs/remotes/origin/review-base`,
        `+${job.input.headSha}:refs/remotes/origin/review-head`,
      ],
      { env },
      { stage: 'checkout', command: 'fetch' },
    );
    if (fetch.exitCode !== 0 || fetch.timedOut) return undefined;
    const checkout = await runTracked(
      job,
      'git',
      [
        '-C',
        checkoutPath,
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'submodule.recurse=false',
        'checkout',
        '--quiet',
        '--detach',
        'refs/remotes/origin/review-head',
      ],
      { env },
      { stage: 'checkout', command: 'detach' },
    );
    if (checkout.exitCode !== 0 || checkout.timedOut) return undefined;
    const commits = await runTracked(
      job,
      'git',
      [
        '-C',
        checkoutPath,
        'rev-parse',
        'refs/remotes/origin/review-base^{commit}',
        'refs/remotes/origin/review-head^{commit}',
      ],
      { captureStdout: true, maxBytes: 4 * 1024, env },
      { stage: 'checkout', command: 'verify-revision' },
    );
    if (commits.exitCode !== 0 || commits.timedOut) return undefined;
    const reported = commits.stdout.trim().split(/\s+/);
    if (
      reported.length !== 2 ||
      reported[0] !== job.input.baseSha ||
      reported[1] !== job.input.headSha
    ) {
      return undefined;
    }
    const mergeBase = await runTracked(
      job,
      'git',
      [
        '-C',
        checkoutPath,
        'merge-base',
        'refs/remotes/origin/review-base^{commit}',
        'refs/remotes/origin/review-head^{commit}',
      ],
      { captureStdout: true, maxBytes: 4 * 1024, env },
      { stage: 'checkout', command: 'verify-merge-base' },
    );
    if (mergeBase.exitCode !== 0 || mergeBase.timedOut || mergeBase.truncated) return undefined;
    const mergeBaseSha = mergeBase.stdout.trim();
    if (!/^[0-9a-f]{40}$/i.test(mergeBaseSha)) return undefined;
    const removeRemote = await runTracked(
      job,
      'git',
      ['-C', checkoutPath, 'remote', 'remove', 'origin'],
      { env },
      { stage: 'checkout', command: 'remove-remote' },
    );
    if (removeRemote.exitCode !== 0) return undefined;
    const removeAskpass = await runTracked(
      job,
      'git',
      ['-C', checkoutPath, 'config', '--local', '--unset-all', 'credential.helper'],
      { env },
      { stage: 'checkout', command: 'remove-credential' },
    );
    if (removeAskpass.exitCode !== 0 && removeAskpass.exitCode !== 5) return undefined;
    const removeHook = await runTracked(
      job,
      'git',
      ['-C', checkoutPath, 'config', '--local', '--unset-all', 'core.askPass'],
      { env },
      { stage: 'checkout', command: 'remove-askpass' },
    );
    if (removeHook.exitCode !== 0 && removeHook.exitCode !== 5) return undefined;
    await rm(askpassPath, { force: true });
    return mergeBaseSha;
  };

  const removeHostDirectories = async (job: RunnerJob): Promise<boolean> => {
    let clean = true;
    for (const directory of [job.checkoutRoot, job.configRoot, job.grantRoot]) {
      if (directory === undefined) continue;
      try {
        await rm(directory, { recursive: true, force: true });
      } catch {
        clean = false;
      }
    }
    return clean;
  };

  const cleanup = async (job: RunnerJob) => {
    reportStage(job, 'cleanup');
    let sandboxClean = true;
    if (job.sandboxAttempted) update(job, { stage: 'cleanup' });
    const cleanupProcess = async (
      args: readonly string[],
      diagnostic?: RunnerDiagnostic,
      processOptions: RunnerProcessOptions = {},
    ) => {
      let result: RunnerProcessResult;
      try {
        result = await executeProcess(sandboxPortPath, args, {
          ...processOptions,
          env:
            sandboxRuntime.kind === 'microsandbox'
              ? (processOptions.env ?? {})
              : strippedSandboxEnvironment,
          captureStdout: processOptions.captureStdout ?? false,
          captureStderr: true,
          stderrRedactions: [
            ...readTokenSecretValues(job),
            modelSecretCommand,
            job.grantToken,
            job.input.repositoryUrl,
          ].filter((value): value is string => value !== undefined && value.length > 0),
          maxBytes: processOptions.maxBytes ?? MAX_DIAGNOSTIC_STDERR_BYTES,
          timeoutMs: CLEANUP_COMMAND_TIMEOUT_MS,
        });
      } catch (error) {
        result = processFailure(error);
      }
      if (diagnostic !== undefined) await recordCommand(job, diagnostic, result);
      return result;
    };
    if (job.sandboxAttempted && job.sandboxRuntime !== undefined) {
      try {
        await job.sandboxRuntime.destroy(
          Object.assign(cleanupProcess, {
            execute: (
              operation: SandboxOperation,
              diagnostic?: RunnerDiagnostic,
              processOptions?: RunnerProcessOptions,
            ) =>
              runSdkOperation(
                job,
                operation,
                diagnostic,
                processOptions,
                CLEANUP_COMMAND_TIMEOUT_MS,
                false,
              ),
          }),
        );
      } catch {
        sandboxClean = false;
      }
    }
    const hostClean = await removeHostDirectories(job);
    const clean = sandboxClean && hostClean;
    job.hostCleanupConfirmed =
      hostClean &&
      (!job.sandboxAttempted || job.sandboxRuntime?.metadata.hostCleanupConfirmed === true);
    update(job, { sandbox: { cleanup: clean ? 'destroyed' : 'failed' } });
    return clean;
  };

  const callbackEvidence = async (
    evidencePath: string,
    job: RunnerJob,
    includeValidatedReview: boolean,
  ) => {
    const encoded = async (name: string) => {
      try {
        const bytes = await readFile(join(evidencePath, name));
        const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
        return {
          content: bytes.toString('base64'),
          size: bytes.byteLength,
          sha256: Array.from(new Uint8Array(hash), (byte) =>
            byte.toString(16).padStart(2, '0'),
          ).join(''),
        };
      } catch {
        const hash = await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array());
        return {
          content: '',
          size: 0,
          sha256: Array.from(new Uint8Array(hash), (byte) =>
            byte.toString(16).padStart(2, '0'),
          ).join(''),
        };
      }
    };
    const sessionId = job.sessionIds[0];
    return {
      id: job.state.evidence.id,
      status: job.state.evidence.status,
      manifest: await encoded('manifest.json'),
      opencodeJsonl: await encoded('opencode.jsonl'),
      opencodeStderr: await encoded('opencode.stderr'),
      ...(includeValidatedReview === false
        ? {}
        : { validatedReview: await encoded('validated-review.md') }),
      opencodeSessionList: await encoded('opencode-session-list.json'),
      ...(sessionId === undefined
        ? {}
        : {
            opencodeExport: {
              sessionId,
              content: await encoded(`opencode-export-${sessionId}.json`),
            },
          }),
    };
  };

  const sendCallback = async (
    job: RunnerJob,
    evidencePath: string,
    status: RunnerJobState['status'],
    failure: RunnerJobState['failure'],
    result: RunnerJobState['result'],
  ): Promise<boolean> => {
    job.progressStopped = true;
    job.pendingProgress = undefined;
    job.progressController?.abort();
    if (callbackUrl === undefined || callbackToken === undefined) return false;
    if (status !== 'succeeded' && status !== 'failed' && status !== 'aborted') return false;
    const callback = {
      id: job.id,
      runId: job.input.runId,
      attempt: job.input.attempt,
      status,
      stage: job.state.stage,
      lifecycle: job.lifecycle,
      ...(job.usage === undefined ? {} : { usage: job.usage }),
      sandbox: job.state.sandbox,
      evidence: await callbackEvidence(evidencePath, job, result !== undefined),
      timestamps: {
        ...(job.executionStartedAt === undefined
          ? {}
          : { executionStartedAt: job.executionStartedAt }),
        ...(job.submissionCompletedAt === undefined
          ? {}
          : { submissionCompletedAt: job.submissionCompletedAt }),
        ...(job.cleanupCompletedAt === undefined
          ? {}
          : { cleanupCompletedAt: job.cleanupCompletedAt }),
      },
      ...(result === undefined ? {} : { result }),
      ...(failure === undefined ? {} : { failure }),
    };
    const decoded = await Schema.decodeUnknownPromise(RunnerResultCallback)(callback);
    const completeBody = JSON.stringify(decoded);
    const callbackTooLarge =
      new TextEncoder().encode(completeBody).byteLength > MAX_RUNNER_CALLBACK_BYTES;
    if (callbackTooLarge) {
      try {
        const manifest = JSON.parse(
          await readFile(join(evidencePath, 'manifest.json'), 'utf8'),
        ) as Record<string, unknown>;
        manifest.execution = { status: 'failed', reason: 'evidence' };
        manifest.terminal = { status: 'failed', reason: 'evidence' };
        manifest.evidence = { id: callback.evidence.id, status: 'incomplete' };
        manifest.complete = false;
        manifest.evidenceFailure = 'callback-too-large';
        // A reconciled terminal failure must not retain a validated result.
        delete manifest.result;
        await writeManifestAtomically(join(evidencePath, 'manifest.json'), manifest);
      } catch {
        // The original local evidence remains available if reconciliation fails.
      }
    }
    const body = callbackTooLarge
      ? JSON.stringify(
          await Schema.decodeUnknownPromise(RunnerResultCallback)({
            id: callback.id,
            runId: callback.runId,
            attempt: callback.attempt,
            status: 'failed',
            stage: callback.stage,
            sandbox: callback.sandbox,
            evidence: {
              id: callback.evidence.id,
              status: 'incomplete',
              manifest: { content: '', size: 0, sha256: EMPTY_EVIDENCE_SHA256 },
              opencodeJsonl: { content: '', size: 0, sha256: EMPTY_EVIDENCE_SHA256 },
              opencodeStderr: { content: '', size: 0, sha256: EMPTY_EVIDENCE_SHA256 },
            },
            timestamps: callback.timestamps,
            lifecycle: callback.lifecycle,
            failure: { reason: 'evidence' },
          }),
        )
      : completeBody;
    await persistCallbackBody(evidencePath, body);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      try {
        const response = await Promise.race([
          callbackFetch(callbackUrl, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${callbackToken}`,
              'content-type': 'application/json',
            },
            body,
            signal: controller.signal,
          }),
          new Promise<Response>((_, reject) => {
            timeout = setTimeout(() => {
              timedOut = true;
              controller.abort();
              reject(new Error('runner callback request timed out'));
            }, callbackTimeoutMs);
          }),
        ]);
        if (response.ok) {
          await recordLog({
            phase: 'runner',
            outcome: 'callback',
            runId: job.input.runId,
            jobId: job.id,
            attempt: attempt + 1,
            result: 'accepted',
            status: response.status,
          });
          return callbackTooLarge;
        }
        await recordLog({
          phase: 'runner',
          outcome: 'callback',
          runId: job.input.runId,
          jobId: job.id,
          attempt: attempt + 1,
          result: 'http-error',
          status: response.status,
        });
      } catch {
        // The local evidence remains the recovery copy when callback delivery is lost.
        await recordLog({
          phase: 'runner',
          outcome: 'callback',
          runId: job.input.runId,
          jobId: job.id,
          attempt: attempt + 1,
          result: timedOut ? 'timeout' : 'transport-error',
        });
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
      if (attempt === 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
    // Local terminal state is not Core delivery: make the exhausted delivery explicit.
    await recordLog({
      phase: 'runner',
      outcome: 'callback-delivery-failed',
      runId: job.input.runId,
      jobId: job.id,
    });
    return callbackTooLarge;
  };

  const revokeGrant = async (job: RunnerJob): Promise<boolean> => {
    if (llmServiceClient === undefined || job.grantRevoked) return true;
    if (!job.grantIssuanceAttempted) return true;
    const deadline = Date.now() + GRANT_REVOKE_BUDGET_MS;
    for (let attempt = 0; attempt < GRANT_REVOKE_ATTEMPTS; attempt += 1) {
      try {
        await llmServiceClient.revoke(job.id);
        job.grantRevoked = true;
        await clearGrantMarker(job.id);
        return true;
      } catch {
        // A bounded retry keeps a transient control failure from losing revocation.
      }
      if (Date.now() >= deadline) break;
    }
    return false;
  };

  const execute = async (job: RunnerJob) => {
    let failure: RunnerJobState['failure'];
    let executionCause: RunnerFailureCauseValue | undefined;
    let result: StructuredReviewResult | undefined;
    let agent: RunnerProcessResult | undefined;
    let agentEndedAt: number | undefined;
    let correctionTimeout = false;
    let agentParsed: ParsedAgentResult | undefined;
    let executionModel: string | undefined;
    let submissionIdentity: SessionIdentity | undefined;
    const evidenceId = job.state.evidenceId ?? job.id;
    const evidencePath = join(evidenceRoot, evidenceId);
    const multiConfiguration = job.input.reviewConfiguration;
    const multiSelection = multiConfiguration?.selection ?? undefined;
    const multi = multiSelection !== undefined;
    const directExecution = multiSelection !== undefined && multiSelection.reviewers.length === 1;
    let evidenceStartedAt: string | undefined;
    let evidenceReady = false;
    let evidenceComplete = false;
    let evidenceFailure: string | undefined;
    let revocationUnconfirmed = false;
    const validateMultiReview = async (): Promise<
      { readonly result: StructuredReviewResult } | { readonly cause: RunnerFailureCauseValue }
    > => {
      if (multiSelection === undefined) return { cause: 'result-schema-failure' };
      const rootSessionId = job.sessionIds[0];
      if (rootSessionId === undefined) return { cause: 'result-schema-failure' };
      const readExport = async (sessionId: string): Promise<unknown> => {
        try {
          return JSON.parse(
            await readFile(join(evidencePath, `opencode-export-${sessionId}.json`), 'utf8'),
          ) as unknown;
        } catch {
          return undefined;
        }
      };
      const root = await readExport(rootSessionId);
      if (root === undefined || !sessionSucceeded(root, rootSessionId)) {
        return { cause: 'missing-terminal-message' };
      }
      const rootIdentity = submissionIdentity;
      if (rootIdentity === undefined) return { cause: 'result-schema-failure' };
      const rootInfo = decodeSessionExport(root)?.info;
      if (
        rootInfo === undefined ||
        rootInfo.agent !== rootIdentity.agent ||
        rootInfo.model?.providerID !== rootIdentity.model.providerID ||
        rootInfo.model.id !== rootIdentity.model.id
      ) {
        return { cause: 'result-schema-failure' };
      }
      const synthesis = extractReviewSubmission(root, rootIdentity);
      if (synthesis.cause !== undefined) return { cause: synthesis.cause };
      const synthesisValue = synthesis.value;
      if (synthesisValue === undefined) return { cause: 'result-schema-failure' };

      // Child sessions are kept as provenance only. A reviewer that did not
      // submit, used a different completion path, or was retried never turns a
      // valid supervisor result into a failure.
      const reviewers: RunnerMultiReviewEvidence['reviewers'][number][] = [];
      for (const sessionId of job.sessionIds.slice(1)) {
        const info = decodeSessionExport(await readExport(sessionId))?.info;
        if (info === undefined || info.parentID !== rootSessionId) continue;
        reviewers.push({
          participant: info.agent ?? '',
          route: info.model?.id ?? '',
          sessionId,
          model: info.model === undefined ? '' : modelReference(info.model.id),
        });
      }
      job.multiReview = {
        revision: multiConfiguration!.revision,
        selection: multiSelection,
        rootSessionId,
        reviewers,
        synthesis: synthesisValue,
      };
      return {
        result: {
          version: 2,
          decision: synthesisValue.decision,
          markdown: synthesisValue.markdown,
        },
      };
    };
    try {
      evidenceStartedAt = await currentIso();
      job.executionStartedAt = evidenceStartedAt;
      if (
        !multi &&
        (modelResolverMissing || modelId === undefined || openCodeConfig === undefined)
      ) {
        failure = { reason: 'agent' };
        return;
      }
      await mkdir(evidencePath, { recursive: true, mode: 0o700 });
      await chmod(evidencePath, 0o700);
      evidenceReady = true;
      await writeManifestAtomically(join(evidencePath, 'manifest.json'), {
        evidenceId,
        runId: job.input.runId,
        attempt: job.input.attempt,
        repositoryName: job.input.repositoryName,
        pullRequestNumber: job.input.pullRequestNumber,
        baseSha: job.input.baseSha,
        headSha: job.input.headSha,
        startedAt: evidenceStartedAt,
        complete: false,
        cleanup: { status: 'pending' },
      });
      if (job.abortRequested) return;
      await ensureReadTokenFresh(job);
      if (job.deadlineAt <= Date.now()) {
        failure = deadlineFailure(job);
        return;
      }
      // Remote relay execution never infers a default route: Core must have
      // materialized the frozen selection at admission. Fail before checkout.
      if (relayEnabled && multiSelection === undefined) {
        failure = { reason: 'configuration' };
        return;
      }
      if (multi) {
        if (
          sandboxRuntime.kind === 'openshell' ||
          llmServiceClient === undefined ||
          serviceBaseUrl === undefined
        ) {
          failure = { reason: 'agent' };
          return;
        }
      }
      update(job, { status: 'running', stage: 'checkout' });
      reportStage(job, 'checkout');
      const checkoutRoot = await mkdtemp(join(tmpdir(), 'compte-rendu-review-'));
      job.checkoutRoot = checkoutRoot;
      const mergeBaseSha = await prepareCheckout(job, checkoutRoot);
      if (job.abortRequested) return;
      if (job.deadlineAt <= Date.now()) {
        failure = deadlineFailure(job);
        return;
      }
      if (mergeBaseSha === undefined) {
        failure = { reason: 'checkout' };
        return;
      }
      await ensureReadTokenFresh(job);
      if (job.deadlineAt <= Date.now()) {
        failure = deadlineFailure(job);
        return;
      }

      let descriptors: readonly ModelRouteDescriptor[] | undefined;
      if (llmServiceClient !== undefined && multiSelection !== undefined) {
        const grantRoutes = directExecution
          ? [multiSelection.reviewers[0]!]
          : dedupedRoutes(multiSelection);
        // Persist the issuer-bound marker before the call: an ambiguous response
        // must revoke by job identity and never retry issuance for this job.
        try {
          await writeGrantMarker(job.id);
        } catch {
          failure = { reason: 'agent' };
          return;
        }
        job.grantIssuanceAttempted = true;
        const grantIdentity: LlmGrantIdentity = {
          runId: job.input.runId,
          jobId: job.id,
          attempt: job.input.attempt,
        };
        let grant: Awaited<ReturnType<typeof llmServiceClient.issue>>;
        try {
          grant = await llmServiceClient.issue(grantIdentity, grantRoutes);
        } catch {
          failure = { reason: 'agent' };
          return;
        }
        if (grant.expiresAt < job.deadlineAt + FINALIZATION_BUDGET_MS) {
          failure = { reason: 'agent' };
          return;
        }
        descriptors = grant.descriptors;
        job.grantToken = grant.token;
        const grantRoot = await mkdtemp(join(tmpdir(), 'compte-rendu-llm-grant-'));
        job.grantRoot = grantRoot;
        const tokenPath = join(grantRoot, 'job-token');
        await writeFile(tokenPath, grant.token, { mode: 0o600 });
        job.grantTokenPath = tokenPath;
      }
      if (job.abortRequested) return;

      const promptReviewers = multi
        ? participants(multiSelection).map(({ participant, route }) => ({
            participant,
            model: modelReference(route),
          }))
        : modelId === undefined
          ? []
          : [{ participant: 'reviewer-0', model: modelId }];
      const agentPrompt = reviewPrompt({
        repositoryName: job.input.repositoryName,
        pullRequestNumber: job.input.pullRequestNumber,
        baseSha: job.input.baseSha,
        mergeBaseSha,
        headSha: job.input.headSha,
        reviewers: promptReviewers,
      });
      const configRoot = await mkdtemp(join(tmpdir(), 'compte-rendu-opencode-config-'));
      job.configRoot = configRoot;
      for (const skill of reviewSkills) {
        const directory = join(configRoot, 'opencode', 'skills', skill.name);
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, 'SKILL.md'), skill.body);
        await writeFile(join(directory, 'LICENSE.md'), skill.license);
        await writeFile(join(directory, 'NOTICE.md'), skill.notice);
      }
      const activeOpenCodeConfig = multi
        ? multiReviewConfig({
            selection: multiSelection,
            descriptors,
            serviceBaseUrl: serviceBaseUrl!.toString(),
            shellPermissionRules,
          })
        : openCodeConfig;

      const runtime = sandboxRuntimeFactory({
        id: job.id,
        name: job.sandboxName,
        imageRef: SANDBOX_TEMPLATE,
        cpu: '4',
        memoryGib: 8,
        env: [
          `OPENCODE_CONFIG_CONTENT=${activeOpenCodeConfig!}`,
          'OPENCODE_DISABLE_PROJECT_CONFIG=1',
        ],
        checkoutRoot: join(checkoutRoot, 'checkout'),
        configRoot,
        modelResource,
        ...(job.grantTokenPath === undefined ? {} : { modelTokenFile: job.grantTokenPath }),
        githubResource: 'api.github.com:443',
        githubReadToken: job.input.repositoryReadToken,
      });
      job.sandboxRuntime = runtime;
      job.sandboxAttempted = true;
      reportStage(job, 'sandbox');
      const setupCommand: SandboxCommand = Object.assign(
        (
          args: readonly string[],
          diagnostic?: RunnerDiagnostic,
          processOptions?: RunnerProcessOptions,
        ) =>
          runTracked(
            job,
            sandboxPortPath,
            args,
            sandboxRuntime.kind === 'openshell'
              ? {
                  ...processOptions,
                  env: { ...strippedSandboxEnvironment, ...processOptions?.env },
                }
              : processOptions,
            diagnostic,
          ),
        {
          execute: (
            operation: SandboxOperation,
            diagnostic?: RunnerDiagnostic,
            processOptions?: RunnerProcessOptions,
          ) =>
            runSdkOperation(
              job,
              operation,
              diagnostic,
              processOptions,
              Math.min(processOptions?.timeoutMs ?? SETUP_TIMEOUT_MS, remainingExecutionMs(job)),
              true,
            ),
        },
      );
      try {
        await runtime.setup(setupCommand);
      } catch (error) {
        job.sandboxCreated = runtime.metadata.created;
        if (
          error instanceof SandboxCreateError &&
          error.timedOut &&
          remainingExecutionMs(job) <= 0
        ) {
          // The create consumed the job's limiting clock rather than only its
          // ordinary per-command timeout. Report the actual exhausted deadline.
          failure = deadlineFailure(job);
          return;
        }
        executionCause =
          error instanceof SandboxCreateError
            ? error.timedOut
              ? 'timeout'
              : 'process-exit'
            : undefined;
        failure = {
          reason: 'agent',
          ...(executionCause === undefined ? {} : { cause: executionCause }),
        };
        return;
      }
      job.sandboxCreated = runtime.metadata.created;
      if (job.abortRequested) return;
      const githubPreflight = await runtime.exec(
        ['gh', 'api', '--silent', 'installation/repositories'],
        setupCommand,
        {},
        { stage: 'sandbox', command: 'github-preflight' },
      );
      await ensureReadTokenFresh(job);
      if (job.deadlineAt <= Date.now()) {
        failure = deadlineFailure(job);
        return;
      }
      if (githubPreflight.exitCode !== 0 || githubPreflight.timedOut) {
        failure = { reason: 'agent' };
        return;
      }
      const agentRemaining = remainingExecutionMs(job);
      if (agentRemaining <= 0) {
        failure = deadlineFailure(job);
        return;
      }
      update(job, { stage: 'agent' });
      reportStage(job, 'agent');
      const agentModel = multi
        ? modelReference(directExecution ? multiSelection.reviewers[0]! : multiSelection.synthesis)
        : modelId;
      const agentName = multi && !directExecution ? SUPERVISOR_AGENT_ID : 'review';
      executionModel = agentModel;
      submissionIdentity = multi
        ? directExecution
          ? {
              agent: 'review',
              model: {
                providerID: MULTI_PROVIDER_ID,
                id: multiSelection.reviewers[0]!,
              },
            }
          : {
              agent: SUPERVISOR_AGENT_ID,
              model: { providerID: MULTI_PROVIDER_ID, id: multiSelection.synthesis },
            }
        : {
            agent: 'review',
            model: (() => {
              const reference = modelId!;
              const slash = reference.indexOf('/');
              return slash === -1
                ? { providerID: 'opencode-go', id: reference }
                : {
                    providerID: reference.slice(0, slash),
                    id: reference.slice(slash + 1),
                  };
            })(),
          };
      agent = await runtime.exec(
        [
          'opencode',
          'run',
          '--standalone',
          '--format',
          'json',
          '--model',
          agentModel!,
          '--agent',
          agentName,
          agentPrompt,
        ],
        setupCommand,
        {
          captureStdout: true,
          captureStderr: true,
          maxBytes: MAX_AGENT_OUTPUT_BYTES,
          timeoutMs: agentRemaining,
          stdoutFilePath: join(evidencePath, 'opencode.jsonl'),
          stderrFilePath: join(evidencePath, 'opencode.stderr'),
        },
      );
      agentEndedAt = Date.now();
      const sessionId = uniqueSessionIdFrom(agent.stdout);
      const initialStdout = parseResult(agent.stdout, sessionId);
      const recoveredProvider = agent.exitCode === 1 && (initialStdout.recoveredErrors ?? 0) > 0;
      if (
        !job.abortRequested &&
        (agent.exitCode === 0 || recoveredProvider) &&
        !agent.timedOut &&
        !agent.truncated &&
        agent.streamError !== true &&
        initialStdout.cause === undefined &&
        initialStdout.upstream === undefined
      ) {
        // A normal exit with no valid final result is only eligible for the one
        // correction when the exact session reached an authoritative normal
        // completion. A length/content-filter/error finish, a non-succeeded
        // outcome, or an ambiguous session identity must not resume a truncated
        // session.
        let normalCompletion = false;
        let needsCorrection = false;
        const precheckRemaining = job.deadlineAt - (await currentEpochMillis());
        if (sessionId !== undefined && precheckRemaining > 0) {
          const exported = await runtime.exec(
            ['opencode', 'session', 'export', '--standalone', sessionId],
            setupCommand,
            {
              captureStdout: true,
              maxBytes: MAX_AGENT_OUTPUT_BYTES,
              timeoutMs: Math.min(precheckRemaining, SUBMIT_REMINDER_BUDGET_MS),
            },
          );
          if (exported.exitCode === 0 && !exported.timedOut && exported.truncated !== true) {
            try {
              const value: unknown = JSON.parse(exported.stdout);
              normalCompletion = sessionSucceeded(value, sessionId);
              if (normalCompletion)
                needsCorrection =
                  extractReviewSubmission(value, submissionIdentity).value === undefined;
            } catch {
              normalCompletion = false;
              needsCorrection = false;
            }
          }
        }
        // Recompute after the export: it consumes shared deadline time.
        const remaining = job.deadlineAt - (await currentEpochMillis());
        if (
          !job.abortRequested &&
          sessionId !== undefined &&
          remaining > 0 &&
          normalCompletion &&
          needsCorrection
        ) {
          agentEndedAt = undefined;
          const reminder = await runtime.exec(
            [
              'opencode',
              'run',
              '--standalone',
              '--session',
              sessionId,
              '--format',
              'json',
              '--model',
              agentModel!,
              '--agent',
              agentName,
              reviewCorrectionPrompt,
            ],
            setupCommand,
            {
              captureStdout: true,
              captureStderr: true,
              maxBytes: MAX_AGENT_OUTPUT_BYTES,
              timeoutMs: Math.min(SUBMIT_REMINDER_BUDGET_MS, remaining),
              stdoutFilePath: join(evidencePath, 'opencode.jsonl'),
              stderrFilePath: join(evidencePath, 'opencode.stderr'),
              fileAppend: true,
            },
          );
          agentEndedAt = Date.now();
          const reminderParsed = parseResult(reminder.stdout, sessionId);
          const reminderRecovered = (reminderParsed.recoveredErrors ?? 0) > 0;
          const recoveredErrors =
            (initialStdout.recoveredErrors ?? 0) + (reminderParsed.recoveredErrors ?? 0);
          agentParsed =
            reminderParsed.cause !== undefined || reminderParsed.upstream !== undefined
              ? reminderParsed
              : reminder.exitCode !== 0 && !reminderRecovered
                ? { cause: 'process-exit' }
                : uniqueSessionIdFrom(reminder.stdout) === sessionId
                  ? recoveredErrors === 0
                    ? reminderParsed
                    : { ...reminderParsed, recoveredErrors }
                  : { cause: 'zero-results' };
          correctionTimeout = reminder.timedOut && remaining > SUBMIT_REMINDER_BUDGET_MS;
          agent = mergedAgentResult(agent, reminder);
        }
      }
    } catch {
      failure = { reason: 'agent' };
    } finally {
      // Stop the refresh loop before evidence/cleanup removes the active token
      // destination. An in-flight response is ignored when it settles late.
      stopReadTokenRefresh(job);
      if (
        job.readTokenRefreshFailed &&
        job.deadlineLimit === 'credential' &&
        (agentEndedAt ?? Date.now()) >= job.deadlineAt
      ) {
        executionCause = 'timeout';
        failure = { reason: 'timeout', cause: 'timeout', deadline: 'credential' };
      }
      // Revoke as soon as agent work ends, before evidence/archive/cleanup, so a
      // still-running Sandbox cannot keep using a finished job's grant.
      if (job.grantIssuanceAttempted) {
        revocationUnconfirmed = !(await revokeGrant(job));
        try {
          job.usage = await llmServiceClient?.usage(job.id);
        } catch {
          // Usage is optional telemetry: preserve review/cleanup outcomes when unavailable.
          await Effect.runPromise(Effect.logWarning('llm.usage.unavailable', { jobId: job.id }));
        }
      }
      const submissionSessionId =
        agent === undefined ? undefined : uniqueSessionIdFrom(agent.stdout);
      let sessionTerminal = false;
      if (evidenceReady && job.sandboxCreated) {
        reportStage(job, 'evidence');
        try {
          const archived = await archiveEvidence(
            job,
            evidencePath,
            agent,
            submissionSessionId,
            await Effect.runPromise(
              DateTime.now.pipe(
                Effect.map((now) =>
                  DateTime.toEpochMillis(
                    DateTime.add(now, { milliseconds: ARCHIVE_PHASE_TIMEOUT_MS }),
                  ),
                ),
              ),
            ),
          );
          evidenceComplete = archived.complete;
          sessionTerminal = archived.terminal;
          if (!evidenceComplete) evidenceFailure = 'archive-incomplete';
        } catch {
          evidenceFailure = 'archive-incomplete';
        }
      } else {
        evidenceFailure = 'sandbox-not-created';
      }
      if (evidenceReady) {
        const evidenceSecrets = [
          ...readTokenSecretValues(job),
          ...(job.grantToken === undefined || job.grantToken.length === 0 ? [] : [job.grantToken]),
        ];
        if (evidenceSecrets.length > 0) {
          try {
            if (await redactEvidenceTextFiles(evidencePath, evidenceSecrets, job.sessionIds)) {
              failure ??= { reason: 'evidence' };
              evidenceComplete = false;
              evidenceFailure = 'credential-in-output';
            }
          } catch {
            evidenceFailure = 'archive-incomplete';
            evidenceComplete = false;
          }
        }
      }
      // Raw stream observation survives pre-write redaction: an actual job
      // credential in model output is never publishable even when the evidence
      // files no longer contain the secret.
      if (agent?.credentialObserved === true) {
        failure ??= { reason: 'evidence' };
        if (evidenceReady) {
          evidenceComplete = false;
          evidenceFailure = 'credential-in-output';
        }
      }
      // A process that echoed the grant into its output must fail closed: the
      // evidence copy is scrubbed, but a review carrying the token is never
      // published as a modified result.
      const echoedGrant =
        job.grantToken !== undefined &&
        job.grantToken.length > 0 &&
        (agent?.stdout.includes(job.grantToken) === true ||
          agent?.stderr?.includes(job.grantToken) === true);
      if (echoedGrant && failure === undefined) {
        failure = { reason: 'agent' };
      }
      if (agent !== undefined && failure === undefined) {
        job.submissionCompletedAt = await currentIso();
        const parsed = agentParsed ?? parseResult(agent.stdout, submissionSessionId);
        const recoveredProvider =
          agent.exitCode === 1 &&
          parsed.cause === undefined &&
          (parsed.recoveredErrors ?? 0) > 0 &&
          !agent.timedOut &&
          !agent.truncated &&
          agent.streamError !== true &&
          evidenceComplete &&
          sessionTerminal &&
          submissionSessionId !== undefined;
        if (agent.timedOut) {
          executionCause = 'timeout';
          failure = {
            reason: 'timeout',
            cause: executionCause,
            ...(correctionTimeout ? {} : { deadline: job.deadlineLimit }),
          };
        } else if (parsed.cause !== undefined) {
          executionCause = parsed.cause;
          failure = { reason: 'invalid-output', cause: executionCause };
        } else if (parsed.upstream !== undefined) {
          executionCause = 'upstream-error';
          failure = {
            reason: 'upstream',
            cause: executionCause,
            ...(parsed.upstream.httpStatus === undefined
              ? {}
              : { httpStatus: parsed.upstream.httpStatus }),
          };
        } else if (agent.exitCode !== 0 && !recoveredProvider) {
          executionCause = 'process-exit';
          failure = { reason: 'invalid-output', cause: executionCause };
        } else if (agent.truncated) {
          executionCause = 'output-truncated';
          failure = { reason: 'invalid-output', cause: executionCause };
        } else if (multi) {
          const validated = await validateMultiReview();
          if ('cause' in validated) {
            executionCause = validated.cause;
            failure = { reason: 'invalid-output', cause: executionCause };
          } else {
            result = validated.result;
          }
        } else if (submissionSessionId === undefined) {
          failure = { reason: 'invalid-output' };
        } else if (!sessionTerminal) {
          executionCause = 'missing-terminal-message';
          failure = { reason: 'invalid-output', cause: executionCause };
        } else {
          let exported: unknown;
          try {
            exported = JSON.parse(
              await readFile(
                join(evidencePath, `opencode-export-${submissionSessionId}.json`),
                'utf8',
              ),
            ) as unknown;
          } catch {
            exported = undefined;
          }
          const submission =
            exported === undefined
              ? undefined
              : extractReviewSubmission(exported, submissionIdentity);
          if (submission?.value === undefined) {
            executionCause = submission?.cause ?? 'missing-terminal-message';
            failure = { reason: 'invalid-output', cause: executionCause };
          } else {
            result = {
              version: 2,
              decision: submission.value.decision,
              markdown: submission.value.markdown,
            };
          }
        }
        if (recoveredProvider && result !== undefined) {
          await Effect.runPromise(
            Effect.logInfo('Runner accepted recovered OpenCode session', {
              jobId: job.input.id,
              sessionId: submissionSessionId,
              exitCode: agent.exitCode,
            }),
          );
        }
        if (result !== undefined && evidenceReady) {
          try {
            await writeFile(join(evidencePath, 'validated-review.md'), result.markdown, {
              mode: 0o600,
            });
          } catch {
            evidenceComplete = false;
            evidenceFailure = 'archive-incomplete';
          }
        }
      }
      // Retain the frozen selection and every available parent/child session as
      // a standalone provenance document, including partial child evidence when
      // validation failed. It is derived from the already-archived, redacted
      // exports.
      if (evidenceReady && multiSelection !== undefined) {
        try {
          const readSessionInfo = async (sessionId: string) => {
            try {
              const value = JSON.parse(
                await readFile(join(evidencePath, `opencode-export-${sessionId}.json`), 'utf8'),
              ) as unknown;
              return decodeSessionExport(value)?.info;
            } catch {
              return undefined;
            }
          };
          const sessions: unknown[] = [];
          for (const sessionId of job.sessionIds) {
            const info = await readSessionInfo(sessionId);
            sessions.push({
              sessionId,
              ...(info === undefined
                ? {}
                : {
                    parentID: info.parentID ?? null,
                    agent: info.agent ?? null,
                    model: info.model ?? null,
                    outcome: info.outcome ?? null,
                  }),
            });
          }
          const document =
            job.multiReview === undefined
              ? {
                  revision: multiConfiguration!.revision,
                  frozenSelection: {
                    reviewers: [...multiSelection.reviewers],
                    synthesis: multiSelection.synthesis,
                  },
                  rootSessionId: job.sessionIds[0] ?? null,
                  sessions,
                }
              : {
                  revision: job.multiReview.revision,
                  frozenSelection: {
                    reviewers: [...job.multiReview.selection.reviewers],
                    synthesis: job.multiReview.selection.synthesis,
                  },
                  rootSessionId: job.multiReview.rootSessionId,
                  sessions,
                  reviewers: job.multiReview.reviewers.map((reviewer) => ({
                    participant: reviewer.participant,
                    route: reviewer.route,
                    sessionId: reviewer.sessionId,
                    model: reviewer.model,
                  })),
                  synthesis: {
                    sessionId: job.multiReview.rootSessionId,
                    model: executionModel!,
                    decision: job.multiReview.synthesis.decision,
                    markdown: job.multiReview.synthesis.markdown,
                  },
                };
          await writeFile(
            join(evidencePath, 'multi-review.json'),
            JSON.stringify(document, null, 2) + '\n',
            { mode: 0o600 },
          );
        } catch {
          evidenceComplete = false;
          evidenceFailure = 'archive-incomplete';
        }
      }
      if (failure === undefined && result !== undefined && !evidenceComplete) {
        failure = { reason: 'evidence' };
      }
      job.input.repositoryReadToken = '';
      let cleaned = false;
      try {
        cleaned = await cleanup(job);
      } catch {
        cleaned = false;
      }
      job.cleanupCompletedAt = await currentIso();
      if (!cleaned) {
        failure = {
          reason: 'cleanup',
          ...(executionCause === undefined ? {} : { cause: executionCause }),
        };
      }
      if (revocationUnconfirmed) {
        // An unconfirmed revocation is a terminal failure with no vote; the
        // Sandbox cleanup status above still reports what actually happened.
        failure ??= { reason: 'agent' };
      }
      let finalStatus: RunnerJobState['status'] = revocationUnconfirmed
        ? 'failed'
        : job.abortRequested && cleaned
          ? 'aborted'
          : failure !== undefined
            ? 'failed'
            : 'succeeded';
      let finalFailure = finalStatus === 'failed' ? failure : undefined;
      let manifestFinalized = !evidenceReady;
      if (evidenceReady) {
        try {
          await secureEvidenceTree(evidencePath);
          const evidenceStatus = evidenceComplete ? 'complete' : 'incomplete';
          await writeManifestAtomically(join(evidencePath, 'manifest.json'), {
            jobId: job.id,
            sandboxName: job.sandboxName,
            sandboxId: job.sandboxRuntime?.metadata.id ?? job.sandboxName,
            catalogIdentity: job.sandboxRuntime?.metadata.catalogIdentity,
            sandboxRuntimeName: job.sandboxRuntime?.metadata.name ?? job.sandboxName,
            runtime: job.sandboxRuntime?.metadata.runtime ?? sandboxRuntime.kind,
            evidenceId,
            runId: job.input.runId,
            attempt: job.input.attempt,
            repositoryName: job.input.repositoryName,
            pullRequestNumber: job.input.pullRequestNumber,
            baseSha: job.input.baseSha,
            headSha: job.input.headSha,
            startedAt: evidenceStartedAt,
            finishedAt: await currentIso(),
            model: executionModel,
            ...(job.usage === undefined ? {} : { usage: job.usage }),
            image: job.sandboxRuntime?.metadata.imageRef ?? SANDBOX_TEMPLATE,
            openCodeVersion: OPENCODE_VERSION,
            agent: {
              exitCode: agent?.exitCode ?? null,
              timedOut: agent?.timedOut ?? false,
              truncated: agent?.truncated ?? false,
              stderrTruncated: agent?.stderrTruncated ?? false,
              streamError: agent?.streamError ?? false,
            },
            // The archived `opencode session list` enumerates roots only, and
            // Core requires the manifest list to match it exactly. A multi job
            // keeps every child in `job.sessionIds` for archive, validation and
            // redaction, but serializes only the root here; child provenance
            // remains in multiReview and multi-review.json.
            sessionIds: multiSelection === undefined ? job.sessionIds : job.sessionIds.slice(0, 1),
            ...(multiSelection === undefined
              ? {}
              : {
                  selection: {
                    revision: multiConfiguration!.revision,
                    reviewers: [...multiSelection.reviewers],
                    synthesis: multiSelection.synthesis,
                  },
                  // The admission-time frozen selection is recorded even when
                  // later validation fails, so a failed job still shows which
                  // roster was attempted.
                  frozenSelection: {
                    reviewers: [...multiSelection.reviewers],
                    synthesis: multiSelection.synthesis,
                  },
                  ...(job.multiReview === undefined
                    ? {}
                    : {
                        multiReview: {
                          revision: job.multiReview.revision,
                          frozenSelection: {
                            reviewers: [...job.multiReview.selection.reviewers],
                            synthesis: job.multiReview.selection.synthesis,
                          },
                          rootSessionId: job.multiReview.rootSessionId,
                          reviewers: job.multiReview.reviewers.map((reviewer) => ({
                            participant: reviewer.participant,
                            route: reviewer.route,
                            sessionId: reviewer.sessionId,
                            model: reviewer.model,
                          })),
                          synthesis: {
                            sessionId: job.multiReview.rootSessionId,
                            model: executionModel!,
                            decision: job.multiReview.synthesis.decision,
                            markdown: job.multiReview.synthesis.markdown,
                          },
                        },
                      }),
                }),
            validation: {
              status: agent === undefined ? 'not-run' : result === undefined ? 'invalid' : 'valid',
            },
            // Present only for a successful, validated version-2 submission.
            // Core checks this exact decision/version/markdown against the
            // callback result and the validated-review.md Markdown bytes. A
            // terminal failure (cleanup, evidence, abort) clears it.
            ...(finalStatus !== 'succeeded' || result === undefined ? {} : { result }),
            execution:
              finalStatus === 'aborted'
                ? { status: 'aborted', validation: 'not-run' }
                : finalFailure !== undefined
                  ? {
                      status: 'failed',
                      reason: finalFailure.reason,
                      ...(finalFailure.cause === undefined ? {} : { cause: finalFailure.cause }),
                      ...(finalFailure.deadline === undefined
                        ? {}
                        : { deadline: finalFailure.deadline }),
                      ...(finalFailure.httpStatus === undefined
                        ? {}
                        : { httpStatus: finalFailure.httpStatus }),
                    }
                  : { status: 'succeeded', validation: 'valid-review-result' },
            terminal: {
              status: finalStatus,
              ...(finalFailure === undefined ? {} : { reason: finalFailure.reason }),
              ...(finalFailure?.cause === undefined ? {} : { cause: finalFailure.cause }),
              ...(finalFailure?.deadline === undefined ? {} : { deadline: finalFailure.deadline }),
              ...(finalFailure?.httpStatus === undefined
                ? {}
                : { httpStatus: finalFailure.httpStatus }),
            },
            evidence: { id: evidenceId, status: evidenceStatus },
            complete: evidenceComplete && evidenceFailure === undefined,
            evidenceFailure,
            cleanup: { status: cleaned ? 'destroyed' : 'failed' },
            hostCleanupConfirmed: job.hostCleanupConfirmed === true,
            files: await evidenceFiles(evidencePath),
          });
          manifestFinalized = true;
        } catch {
          evidenceFailure = 'manifest-finalization-failed';
          evidenceComplete = false;
        }
      }
      if (!manifestFinalized && finalStatus === 'succeeded') {
        failure = { reason: 'evidence' };
        finalStatus = 'failed';
        finalFailure = failure;
      }
      update(job, {
        evidence: { id: evidenceId, status: evidenceComplete ? 'complete' : 'incomplete' },
      });
      let callbackTooLarge = false;
      try {
        callbackTooLarge = await sendCallback(job, evidencePath, finalStatus, finalFailure, result);
      } catch {
        // Callback serialization or transport failure must not discard local evidence.
      }
      if (callbackTooLarge) {
        finalStatus = 'failed';
        finalFailure = { reason: 'evidence' };
        evidenceComplete = false;
        update(job, { evidence: { id: evidenceId, status: 'incomplete' } });
      }
      update(
        job,
        finalStatus === 'aborted'
          ? { status: 'aborted', failure: undefined, result: undefined }
          : finalStatus === 'failed'
            ? { status: 'failed', failure: finalFailure, result: undefined }
            : { status: 'succeeded', result, failure: undefined },
      );
      const terminalStatus = job.state.status;
      if (
        terminalStatus === 'succeeded' ||
        terminalStatus === 'failed' ||
        terminalStatus === 'aborted'
      ) {
        // One terminal diagnostic after callback and cleanup so operators can
        // tell a local terminal state (and its cleanup result) apart from a
        // delivery or inspection problem.
        await recordLog({
          phase: 'runner',
          outcome: 'terminal',
          runId: job.input.runId,
          jobId: job.id,
          status: terminalStatus,
          cleanup: job.state.sandbox.cleanup,
        });
      }
      job.grantToken = '';
      job.readTokenSecrets = [];
      job.sandboxRuntime = undefined;
      job.multiReview = undefined;
      job.sessionIds = [];
      retireDestroyedJob(job);
      job.resolveDone();
      requestNextJob?.();
    }
  };

  const publicState = (job: RunnerJob) => ({ ...job.state });

  const admitJob = async (input: RunnerJobInputState, claimed: boolean): Promise<Response> => {
    const admissionKey = createHash('sha256')
      .update(
        JSON.stringify([
          input.id,
          input.runId,
          input.attempt,
          input.repositoryUrl,
          input.repositoryName,
          input.pullRequestNumber,
          input.baseSha,
          input.headSha,
          input.repositoryReadToken,
        ]),
      )
      .digest('hex');
    const existingById = jobs.get(input.id);
    if (existingById !== undefined)
      return jsonResponse(
        existingById.admissionKey === admissionKey ? 202 : 409,
        publicState(existingById),
      );
    const existing = jobsByRun.get(`${input.runId}:${input.attempt}`);
    if (existing !== undefined) return jsonResponse(409, publicState(existing));
    const retired = history?.find(input.id, input.runId, input.attempt);
    if (retired)
      return new Response(retired.state, {
        status: retired.admission_key === admissionKey ? 202 : 409,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    if (!claimed && draining) {
      return jsonResponse(503, { error: 'runner draining' });
    }
    if (!claimed && !hasCapacity()) {
      return jsonResponse(409, { error: 'runner is busy' });
    }
    const contradictsSamePullRequest = hasUnclearedSamePullRequest(input);
    if (contradictsSamePullRequest && !claimed) {
      return jsonResponse(409, { error: 'runner is busy' });
    }
    let resolveDone = () => {};
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const id = input.id;
    const stop = claimed ? stopsDuringClaim.get(id) : undefined;
    if (stop) {
      clearTimeout(stop.timer);
      stopsDuringClaim.delete(id);
    }
    const evidenceId = randomUUID();
    const admittedAt = Date.now();
    const claimDeadlineAt = input.claimDeadlineAt ?? admittedAt + REVIEW_ATTEMPT_BUDGET_MS;
    const credentialDeadlineAt =
      input.repositoryReadTokenExpiresAt === undefined
        ? undefined
        : input.repositoryReadTokenExpiresAt - CREDENTIAL_EXPIRY_SAFETY_MARGIN_MS;
    // A supported rotation replaces the credential in place, so the initial
    // expiry does not cap the job. On outage the old expiry-minus-margin becomes
    // the fallback deadline. Legacy claims and unsupported backends keep the
    // original hard cap.
    const rotatingCredential =
      readTokenRotationSupported &&
      input.repositoryReadTokenExpiresAt !== undefined &&
      input.repositoryReadTokenExpiresAt > admittedAt;
    const deadlineLimit =
      !rotatingCredential &&
      credentialDeadlineAt !== undefined &&
      credentialDeadlineAt < claimDeadlineAt
        ? 'credential'
        : 'claim';
    const job: RunnerJob = {
      admissionKey,
      state: {
        id,
        runId: input.runId,
        attempt: input.attempt,
        evidenceId,
        evidence: { id: evidenceId, status: 'pending' },
        status: 'queued',
        stage: 'admission',
        sandbox: { cleanup: 'pending' },
      },
      input: { ...input },
      id,
      sandboxName: `compte-rendu-${id}`,
      done,
      resolveDone,
      abortRequested:
        contradictsSamePullRequest || (stop !== undefined && stop.deadline > Date.now()),
      progressStopped: false,
      sandboxAttempted: false,
      sandboxCreated: false,
      grantIssuanceAttempted: false,
      grantRevoked: false,
      sessionIds: [],
      claimDeadlineAt,
      deadlineAt: rotatingCredential
        ? claimDeadlineAt
        : Math.min(claimDeadlineAt, credentialDeadlineAt ?? Number.POSITIVE_INFINITY),
      deadlineLimit,
      readTokenRotationEnabled: rotatingCredential,
      readTokenRefreshStopped: false,
      readTokenRefreshFailed: false,
      readTokenSecrets: [input.repositoryReadToken],
    };
    jobs.set(id, job);
    jobsByRun.set(`${input.runId}:${input.attempt}`, job);
    scheduleReadTokenRefresh(job);
    void execute(job);
    return jsonResponse(202, publicState(job));
  };

  const openshellConfiguration =
    sandboxRuntime.kind === 'openshell' ? sandboxRuntime.openshell : undefined;
  const runtimePreflight =
    sandboxRuntime.microsandboxImage !== undefined
      ? createMicrosandboxPreflight(sandboxRuntime.microsandboxImage)
      : openshellConfiguration === undefined
        ? undefined
        : createOpenShellPreflight(openshellConfiguration);
  let preflightPromise: Promise<boolean> | undefined;
  const ensurePreflight = async (): Promise<boolean> => {
    if (runtimePreflight === undefined) return true;
    preflightPromise ??= runtimePreflight((args, _diagnostic, options) =>
      executeProcess(sandboxPortPath, args, {
        env: options?.env ?? strippedSandboxEnvironment,
        captureStdout: options?.captureStdout ?? false,
        captureStderr: true,
        timeoutMs: 30 * 1000,
        maxBytes: MAX_DIAGNOSTIC_STDERR_BYTES * 64,
      }),
    );
    return preflightPromise;
  };

  const handle = async (request: Request): Promise<Response> => {
    if (!authorized(request, authToken)) return jsonResponse(401, { error: 'unauthorized' });
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && path === '/maintenance') {
      return jsonResponse(200, maintenanceStatus());
    }
    if (request.method === 'POST' && path === '/maintenance/drain') {
      draining = true;
      return jsonResponse(200, maintenanceStatus());
    }
    if (request.method === 'POST' && path === '/maintenance/resume') {
      if (draining) {
        draining = false;
        requestNextJob?.();
      }
      return jsonResponse(200, maintenanceStatus());
    }
    if (request.method === 'POST' && path === '/maintenance/recover-cleanup') {
      if (!callbackUrl || !callbackToken)
        return jsonResponse(503, { error: 'callback unavailable' });
      const input = await Schema.decodeUnknownPromise(ReplayCallbackRequest)(
        await readJson(request),
      ).catch(() => undefined);
      if (input === undefined) return jsonResponse(400, { error: 'invalid recovery request' });
      if (
        recoveringCleanup.has(input.jobId) ||
        [...jobs.values()].some(
          (job) =>
            (job.state.status === 'queued' || job.state.status === 'running') &&
            (job.id === input.jobId ||
              job.input.runId === input.runId ||
              job.state.evidenceId === input.evidenceId),
        )
      ) {
        return jsonResponse(409, { error: 'job is active' });
      }
      recoveringCleanup.add(input.jobId);
      try {
        const kind = sandboxRuntime.kind;
        if (kind !== 'sbx' && kind !== 'microsandbox')
          return jsonResponse(409, { error: 'cleanup recovery rejected' });
        const recovered = await Effect.runPromise(
          recoverCallback(evidenceRoot, input, { cleanupRuntime: kind }).pipe(Effect.option),
        );
        if (Option.isNone(recovered))
          return jsonResponse(409, { error: 'cleanup recovery rejected' });
        const sandboxName = `compte-rendu-${input.jobId}`;
        const recoveryCommand: SandboxCommand = (args, _diagnostic, options) =>
          executeProcess(sandboxPortPath, args, {
            ...options,
            env: options?.env ?? strippedSandboxEnvironment,
            captureStdout: true,
            captureStderr: true,
            maxBytes: 256 * 1024,
            timeoutMs: CLEANUP_COMMAND_TIMEOUT_MS,
          });
        if (kind === 'microsandbox')
          await confirmMicrosandboxAbsent(
            recoveryCommand,
            sandboxName,
            recovered.value.catalogIdentity,
          );
        else await Effect.runPromise(confirmSbxCleanup(sandboxName, input.jobId, recoveryCommand));
        const marker = await readGrantMarker(grantMarkerPath(input.jobId));
        if (marker.kind === 'invalid') throw new Error('grant recovery marker invalid');
        if (marker.kind === 'present' || llmServiceClient !== undefined) {
          const recordedJobId = marker.kind === 'present' ? marker.jobId : input.jobId;
          const issuer = marker.kind === 'present' ? marker.issuer : activeGrantIssuer;
          if (!(await revokeRecordedGrant(recordedJobId, issuer)))
            throw new Error('grant revocation not confirmed');
          const previousRecovery = grantRecovery;
          if (
            previousRecovery !== undefined &&
            !(await previousRecovery) &&
            grantRecovery === previousRecovery
          ) {
            grantRecovery = startGrantRecovery();
          }
        }
        const report = { ...input, sandboxName, confirmedAt: await currentIso() };
        await writeManifestAtomically(
          join(evidenceRoot, input.evidenceId, 'cleanup-recovery.json'),
          report,
        );
        const controller = new AbortController();
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          const response = await Promise.race([
            callbackFetch(new URL('/runner-cleanup-recovery', callbackUrl).href, {
              method: 'POST',
              headers: {
                authorization: `Bearer ${callbackToken}`,
                'content-type': 'application/json',
              },
              body: JSON.stringify(report),
              signal: controller.signal,
            }),
            new Promise<Response>((_, reject) => {
              timeout = setTimeout(() => {
                controller.abort();
                reject(new Error('delivery timeout'));
              }, callbackTimeoutMs);
            }),
          ]);
          await response.body?.cancel().catch(() => undefined);
          if (response.status !== 202)
            return jsonResponse(502, { error: 'cleanup recovery delivery rejected' });
          const job = jobs.get(input.jobId);
          if (job !== undefined) {
            update(job, { sandbox: { cleanup: 'destroyed' } });
            if (job.state.status === 'failed' || job.state.status === 'aborted')
              retireDestroyedJob(job);
          }
          requestNextJob?.();
          return jsonResponse(202, { accepted: true });
        } finally {
          if (timeout !== undefined) clearTimeout(timeout);
        }
      } catch {
        return jsonResponse(502, { error: 'cleanup recovery not confirmed' });
      } finally {
        recoveringCleanup.delete(input.jobId);
      }
    }
    if (request.method === 'POST' && path === '/maintenance/replay-callback') {
      if (
        callbackUrl === undefined ||
        callbackUrl.length === 0 ||
        callbackToken === undefined ||
        callbackToken.length === 0
      ) {
        return jsonResponse(503, {
          accepted: false,
          error: 'callback unavailable',
          reason: 'callback-unavailable',
        });
      }
      const input = await Schema.decodeUnknownPromise(ReplayCallbackRequest)(
        await readJson(request),
      ).catch(() => undefined);
      if (input === undefined) {
        return jsonResponse(400, {
          accepted: false,
          error: 'invalid replay request',
          reason: 'invalid-request',
        });
      }
      const active = [...jobs.values()].some((job) => {
        if (job.state.status !== 'queued' && job.state.status !== 'running') return false;
        return (
          job.id === input.jobId ||
          (job.input.runId === input.runId && job.input.attempt === input.attempt) ||
          job.state.evidenceId === input.evidenceId
        );
      });
      if (active) {
        return jsonResponse(409, {
          accepted: false,
          error: 'job is active',
          reason: 'active-job',
        });
      }

      const recovered = await Effect.runPromise(
        recoverCallback(evidenceRoot, input).pipe(
          Effect.match({
            onFailure: (error) => ({ ok: false as const, reason: error.reason }),
            onSuccess: (value) => ({ ok: true as const, value }),
          }),
        ),
      );
      if (!recovered.ok) {
        const status =
          recovered.reason === 'missing-evidence'
            ? 404
            : recovered.reason === 'oversized-callback'
              ? 413
              : 409;
        return jsonResponse(status, {
          accepted: false,
          error: 'callback recovery rejected',
          reason: recovered.reason,
        });
      }

      const controller = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      try {
        const response = await Promise.race([
          callbackFetch(callbackUrl, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${callbackToken}`,
              'content-type': 'application/json',
            },
            body: recovered.value.body,
            signal: controller.signal,
          }),
          new Promise<Response>((_, reject) => {
            timeout = setTimeout(() => {
              timedOut = true;
              controller.abort();
              reject(new Error('runner callback replay timed out'));
            }, callbackTimeoutMs);
          }),
        ]);
        await response.body?.cancel().catch(() => undefined);
        if (response.status === 202) {
          await recordLog({
            phase: 'runner',
            outcome: 'callback',
            runId: input.runId,
            jobId: input.jobId,
            attempt: 1,
            result: 'accepted',
            status: response.status,
          });
          return jsonResponse(202, { accepted: true });
        }
        await recordLog({
          phase: 'runner',
          outcome: 'callback',
          runId: input.runId,
          jobId: input.jobId,
          attempt: 1,
          result: 'http-error',
          status: response.status,
        });
        return jsonResponse(502, {
          accepted: false,
          error: 'callback delivery rejected',
          reason: 'http-error',
        });
      } catch {
        await recordLog({
          phase: 'runner',
          outcome: 'callback',
          runId: input.runId,
          jobId: input.jobId,
          attempt: 1,
          result: timedOut ? 'timeout' : 'transport-error',
        });
        return jsonResponse(timedOut ? 504 : 502, {
          accepted: false,
          error: timedOut ? 'callback delivery timed out' : 'callback delivery failed',
          reason: timedOut ? 'timeout' : 'transport-error',
        });
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
    }
    if (request.method === 'POST' && path === '/jobs') {
      if (
        callbackUrl === undefined ||
        callbackUrl.length === 0 ||
        callbackToken === undefined ||
        callbackToken.length === 0
      ) {
        return jsonResponse(503, { error: 'callback unavailable' });
      }
      if (modelResolverMissing) {
        return jsonResponse(503, { error: 'runner unavailable' });
      }
      if (modelConfig === undefined) {
        return jsonResponse(503, { error: 'runner unavailable' });
      }
      if (grantRecovery !== undefined && !(await grantRecovery)) {
        return jsonResponse(503, { error: 'runner unavailable' });
      }
      if (!(await sandboxRecovery)) {
        return jsonResponse(503, { error: 'runner unavailable' });
      }
      if (!(await ensurePreflight())) {
        return jsonResponse(503, { error: 'runner unavailable' });
      }
      const input = await Schema.decodeUnknownPromise(RunnerJobInput)(
        await readJson(request),
      ).catch(() => undefined);
      if (input === undefined) return jsonResponse(400, { error: 'invalid job' });
      return admitJob(input, false);
    }
    const match = /^\/jobs\/([^/]+)$/.exec(path);
    if (match === null) return jsonResponse(404, { error: 'not found' });
    const job = jobs.get(match[1]);
    if (job === undefined) {
      if (request.method === 'GET' || request.method === 'DELETE') {
        const retired = history?.find(match[1]);
        if (retired)
          return new Response(retired.state, {
            headers: { 'content-type': 'application/json; charset=utf-8' },
          });
      }
      const deadline = Number(request.headers.get('x-compte-rendu-claim-deadline'));
      if (
        request.method === 'DELETE' &&
        claiming &&
        Number.isSafeInteger(deadline) &&
        deadline > Date.now()
      ) {
        const id = match[1];
        if (!stopsDuringClaim.has(id)) {
          const timer = setTimeout(
            () => stopsDuringClaim.delete(id),
            Math.min(deadline - Date.now(), REVIEW_ATTEMPT_BUDGET_MS),
          );
          if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
            (timer as { unref: () => void }).unref();
          }
          stopsDuringClaim.set(id, { deadline, timer });
        }
        return jsonResponse(202, { status: 'stop requested' });
      }
      return jsonResponse(404, { error: 'not found' });
    }
    if (request.method === 'GET') return jsonResponse(200, publicState(job));
    if (request.method === 'DELETE') {
      if (job.state.status === 'queued' || job.state.status === 'running') {
        job.abortRequested = true;
        job.sdkController?.abort();
        const child = job.child;
        if (child !== undefined) {
          stop(child);
          setTimeout(() => stop(child, 'SIGKILL'), 5_000);
        }
        await revokeGrant(job);
        await job.done;
      }
      return jsonResponse(200, publicState(job));
    }
    return jsonResponse(404, { error: 'not found' });
  };

  const scheduleClaim = () => {
    const timer = setTimeout(() => void claimNextJob(), claimIntervalMs);
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      (timer as { unref: () => void }).unref();
    }
  };

  // A startup gate that stops claiming is a real queue-stall reason. Record it
  // once, not on every poll, and keep the existing gate behavior unchanged.
  const recordClaimGateFailure = async (
    reason: 'grant-recovery-failed' | 'sandbox-recovery-failed' | 'runtime-preflight-failed',
  ) => {
    if (claimGateFailureLogged) return;
    claimGateFailureLogged = true;
    await recordLog({ phase: 'runner', outcome: 'claim', reason, pollingHalted: true });
  };

  const claimNextJob = async () => {
    if (grantRecovery !== undefined && !(await grantRecovery)) {
      await recordClaimGateFailure('grant-recovery-failed');
      return;
    }
    if (!(await sandboxRecovery)) {
      await recordClaimGateFailure('sandbox-recovery-failed');
      return;
    }
    if (draining) return;
    if (
      claiming ||
      claimPollingHalted ||
      claimUrl === undefined ||
      claimUrl.length === 0 ||
      authToken === undefined ||
      authToken.length === 0 ||
      callbackUrl === undefined ||
      callbackUrl.length === 0 ||
      callbackToken === undefined ||
      callbackToken.length === 0 ||
      modelResolverMissing ||
      modelConfig === undefined ||
      !hasCapacity()
    ) {
      return;
    }

    if (!(await ensurePreflight())) {
      claimPollingHalted = true;
      await recordClaimGateFailure('runtime-preflight-failed');
      return;
    }
    if (claiming || claimPollingHalted || draining || !hasCapacity()) return;

    claiming = true;
    claimRequestId ??= randomUUID();
    let continuePolling = true;
    let admittedJob = false;
    let claimFailure:
      | {
          readonly reason:
            | 'http-error'
            | 'timeout'
            | 'transport-error'
            | 'invalid-response'
            | 'oversized-response'
            | 'malformed-response'
            | 'admission-rejected';
          readonly status?: number;
        }
      | undefined;
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      const response = await Promise.race([
        claimFetch(claimUrl, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${callbackToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ requestId: claimRequestId }),
          signal: controller.signal,
        }),
        new Promise<Response>((_, reject) => {
          timeout = setTimeout(() => {
            timedOut = true;
            controller.abort();
            reject(new Error('Runner claim request timed out'));
          }, claimTimeoutMs);
        }),
      ]);
      if (response.status === 200) {
        continuePolling = false;
        claimPollingHalted = true;
        const body = await response.arrayBuffer();
        if (body.byteLength > MAX_REQUEST_BYTES) {
          claimFailure = { reason: 'oversized-response' };
          throw new Error('Claimed Runner Job exceeded the request bound');
        }
        let payload: unknown;
        try {
          payload = JSON.parse(new TextDecoder().decode(body));
        } catch {
          claimFailure = { reason: 'malformed-response' };
          throw new Error('Claimed Runner Job was not JSON');
        }
        const input = await Schema.decodeUnknownPromise(RunnerJobInput)(payload).catch(
          () => undefined,
        );
        if (input === undefined) {
          claimFailure ??= { reason: 'invalid-response' };
          throw new Error('Claimed Runner Job failed schema validation');
        }
        const admitted = await admitJob(input, true);
        if (admitted.status !== 202) {
          claimFailure ??= { reason: 'admission-rejected' };
          throw new Error('Claimed Runner Job could not be admitted');
        }
        claimPollingHalted = false;
        admittedJob = true;
        claimRequestId = undefined;
      } else if (response.status === 204) {
        claimRequestId = undefined;
      } else {
        claimFailure = { reason: 'http-error', status: response.status };
      }
    } catch {
      // The next idle poll is the bounded transport retry for claim availability.
      claimFailure ??= { reason: timedOut ? 'timeout' : 'transport-error' };
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      claiming = false;
      if (claimRequestId === undefined) forgetStops();
      if (claimFailure !== undefined) {
        await recordLog({
          phase: 'runner',
          outcome: 'claim',
          reason: claimFailure.reason,
          ...(claimFailure.status === undefined ? {} : { status: claimFailure.status }),
          pollingHalted: claimPollingHalted,
        });
      }
      if ((continuePolling || admittedJob) && hasCapacity()) {
        scheduleClaim();
      }
    }
  };

  requestNextJob = () => void claimNextJob();
  let settingsWatcher: RunnerSettingsWatcher | undefined;
  if (settingsFile !== undefined) {
    settingsWatcher = watchRunnerSettings(settingsFile, {
      onSettings: (next) => {
        const previous = effectiveConcurrency;
        effectiveConcurrency = next.concurrency;
        void Effect.runPromise(
          Effect.logInfo(`runner settings reloaded concurrency=${next.concurrency}`),
        ).catch(() => undefined);
        if (next.concurrency > previous && hasCapacity()) requestNextJob?.();
      },
      onError: () => {
        void Effect.runPromise(
          Effect.logWarning('runner settings update ignored; keeping last valid settings'),
        ).catch(() => undefined);
      },
    });
  }
  if (claimUrl !== undefined && claimUrl.length > 0) void claimNextJob();

  return {
    handle,
    close: async () => {
      forgetStops();
      history?.close();
      history = undefined;
      await settingsWatcher?.close();
    },
  };
};
