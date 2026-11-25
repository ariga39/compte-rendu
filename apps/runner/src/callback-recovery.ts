import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Effect, Option, Schema } from 'effect';
import {
  GitHubSha,
  MAX_RUNNER_CALLBACK_BYTES,
  RunnerTerminalCallback,
  StructuredReviewResult,
} from '@compte-rendu/contracts';

const EvidenceId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
);

export const ReplayCallbackRequest = Schema.Struct({
  evidenceId: EvidenceId,
  jobId: Schema.NonEmptyString,
  runId: Schema.NonEmptyString,
  attempt: Schema.Int,
  baseSha: GitHubSha,
  headSha: GitHubSha,
});
export type ReplayCallbackRequest = typeof ReplayCallbackRequest.Type;

const RunnerManifest = Schema.Struct({
  jobId: Schema.NonEmptyString,
  runId: Schema.NonEmptyString,
  attempt: Schema.Int,
  evidenceId: Schema.NonEmptyString,
  baseSha: GitHubSha,
  headSha: GitHubSha,
  terminal: Schema.Struct({
    status: Schema.Literals(['succeeded', 'failed', 'aborted']),
  }),
  evidence: Schema.Struct({
    id: Schema.NonEmptyString,
    status: Schema.Literals(['complete', 'incomplete']),
  }),
  complete: Schema.Boolean,
  evidenceFailure: Schema.optional(Schema.String),
  cleanup: Schema.Struct({
    status: Schema.Literals(['destroyed', 'failed']),
  }),
  result: Schema.optional(StructuredReviewResult),
  recoveryProof: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  // Retained as a free-form string so records written by a retired backend
  // remain readable even though no new job can select that runtime.
  runtime: Schema.optional(Schema.String),
  sandboxName: Schema.optional(Schema.String),
  sandboxId: Schema.optional(Schema.String),
  hostCleanupConfirmed: Schema.optional(Schema.Boolean),
});
export type RecoveredManifest = typeof RunnerManifest.Type;

export const CallbackRecoveryReason = Schema.Literals([
  'missing-evidence',
  'missing-callback',
  'oversized-callback',
  'invalid-callback',
  'invalid-manifest',
  'identity-mismatch',
  'integrity-mismatch',
  'cleanup-not-confirmed',
  'result-mismatch',
  'unsupported-recovery',
]);
export type CallbackRecoveryReason = typeof CallbackRecoveryReason.Type;

export class CallbackRecoveryError extends Schema.TaggedError<CallbackRecoveryError>()(
  'CallbackRecoveryError',
  { reason: CallbackRecoveryReason },
) {}

export type RecoveredCallback = {
  readonly recoveryProof?: Readonly<Record<string, string>> | undefined;
  /** The callback body normalized to the current v2 wire shape. */
  readonly body: string;
  readonly callback: typeof RunnerTerminalCallback.Type;
  readonly manifest: RecoveredManifest;
};

const fail = (reason: CallbackRecoveryReason) => Effect.fail(new CallbackRecoveryError({ reason }));

const readStat = (path: string, reason: CallbackRecoveryReason) =>
  Effect.tryPromise({
    try: () => stat(path),
    catch: () => new CallbackRecoveryError({ reason }),
  });

/**
 * A pre-v2 archive has the same terminal shape but no version tag. Adding the
 * tag and decoding through the real v2 schema drops the six legacy inline
 * attachments automatically while preserving an old Markdown/string result.
 */
const decodeArchivedCallback = (text: string) => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const tagged =
    'version' in value ? value : { ...(value as Record<string, unknown>), version: 2 as const };
  return Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.fromJsonString(RunnerTerminalCallback))(
      JSON.stringify(tagged),
      { onExcessProperty: 'ignore' },
    ),
  );
};

const encodeForManifest = (
  callback: typeof RunnerTerminalCallback.Type,
  manifest: RecoveredManifest,
  overrides: { readonly cleanup?: 'destroyed'; readonly cleanupCompletedAt?: string } = {},
) => {
  const candidate = {
    ...callback,
    sandbox: { cleanup: overrides.cleanup ?? callback.sandbox.cleanup },
    timestamps: {
      ...callback.timestamps,
      ...(overrides.cleanupCompletedAt === undefined
        ? {}
        : { cleanupCompletedAt: overrides.cleanupCompletedAt }),
    },
    baseSha: manifest.baseSha,
    headSha: manifest.headSha,
  };
  const decoded = Schema.decodeUnknownOption(RunnerTerminalCallback)(candidate);
  return Option.isSome(decoded) ? JSON.stringify(decoded.value) : undefined;
};

/**
 * Build the real v2 failed callback sent after an exact cleanup confirmation.
 * The original failure, usage, lifecycle, evidence and timestamps are preserved;
 * only the cleanup state and completion time change.
 */
export const cleanupConfirmedCallbackBody = (
  recovered: RecoveredCallback,
  confirmedAt: string,
): string | undefined =>
  encodeForManifest(recovered.callback, recovered.manifest, {
    cleanup: 'destroyed',
    cleanupCompletedAt: confirmedAt,
  });

export const recoverCallback = Effect.fn('recoverCallback')(function* (
  evidenceRoot: string,
  request: ReplayCallbackRequest,
  purpose:
    | 'replay'
    | {
        readonly cleanupRuntime: string;
      } = 'replay',
): Effect.fn.Return<RecoveredCallback, CallbackRecoveryError> {
  const directory = join(evidenceRoot, request.evidenceId);
  const directoryInfo = yield* readStat(directory, 'missing-evidence');
  if (!directoryInfo.isDirectory()) return yield* fail('missing-evidence');

  const callbackPath = join(directory, 'callback.json');
  const callbackInfo = yield* readStat(callbackPath, 'missing-callback');
  if (!callbackInfo.isFile()) return yield* fail('missing-callback');
  if (callbackInfo.size > MAX_RUNNER_CALLBACK_BYTES) return yield* fail('oversized-callback');

  const body = yield* Effect.tryPromise({
    try: () => readFile(callbackPath),
    catch: () => new CallbackRecoveryError({ reason: 'missing-callback' }),
  });
  if (body.byteLength > MAX_RUNNER_CALLBACK_BYTES) return yield* fail('oversized-callback');

  const callback = decodeArchivedCallback(new TextDecoder().decode(body));
  if (callback === undefined) return yield* fail('invalid-callback');

  // The local manifest is the retained ownership and cleanup record. Diagnostic
  // attachments are never decoded or hashed again: a legacy inline callback and
  // the slim v2 callback both replay from the same local identity.
  const manifestPath = join(directory, 'manifest.json');
  const manifestInfo = yield* readStat(manifestPath, 'invalid-manifest');
  if (!manifestInfo.isFile() || manifestInfo.size > MAX_RUNNER_CALLBACK_BYTES) {
    return yield* fail('invalid-manifest');
  }
  const manifestBytes = yield* Effect.tryPromise({
    try: () => readFile(manifestPath),
    catch: () => new CallbackRecoveryError({ reason: 'invalid-manifest' }),
  });
  if (manifestBytes.byteLength > MAX_RUNNER_CALLBACK_BYTES) {
    return yield* fail('invalid-manifest');
  }
  const manifest = Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.fromJsonString(RunnerManifest))(
      new TextDecoder().decode(manifestBytes),
    ),
  );
  if (manifest === undefined) return yield* fail('invalid-manifest');

  if (
    manifest.jobId !== request.jobId ||
    manifest.jobId !== callback.id ||
    manifest.runId !== request.runId ||
    manifest.runId !== callback.runId ||
    manifest.attempt !== request.attempt ||
    manifest.attempt !== callback.attempt ||
    manifest.evidenceId !== request.evidenceId ||
    manifest.evidence.id !== request.evidenceId ||
    callback.evidence.id !== request.evidenceId ||
    manifest.baseSha !== request.baseSha ||
    manifest.headSha !== request.headSha ||
    (callback.baseSha !== undefined && callback.baseSha !== manifest.baseSha) ||
    (callback.headSha !== undefined && callback.headSha !== manifest.headSha) ||
    manifest.terminal.status !== callback.status
  ) {
    return yield* fail('identity-mismatch');
  }

  if (purpose !== 'replay') {
    if (
      callback.status !== 'failed' ||
      manifest.runtime !== purpose.cleanupRuntime ||
      manifest.sandboxName !== `compte-rendu-${request.jobId}` ||
      manifest.cleanup.status !== 'failed' ||
      callback.sandbox.cleanup !== 'failed'
    ) {
      return yield* fail('unsupported-recovery');
    }
    if (manifest.hostCleanupConfirmed !== true) return yield* fail('unsupported-recovery');
  }

  if (
    purpose === 'replay' &&
    (manifest.cleanup.status !== 'destroyed' || callback.sandbox.cleanup !== 'destroyed')
  ) {
    return yield* fail('cleanup-not-confirmed');
  }

  if (callback.status === 'succeeded') {
    if (manifest.complete !== true) return yield* fail('result-mismatch');
    const result = callback.result;
    if (
      typeof result === 'string'
        ? manifest.result !== undefined
        : manifest.result === undefined ||
          manifest.result.decision !== result.decision ||
          manifest.result.markdown !== result.markdown
    ) {
      return yield* fail('result-mismatch');
    }
  } else if (
    manifest.result !== undefined ||
    (callback.status === 'failed' && callback.failure === undefined)
  ) {
    return yield* fail('result-mismatch');
  }

  const converted = encodeForManifest(callback, manifest);
  if (converted === undefined) return yield* fail('invalid-callback');

  return { body: converted, callback, recoveryProof: manifest.recoveryProof, manifest };
});
