import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Effect, Option, Schema } from 'effect';
import {
  GitHubSha,
  MAX_RUNNER_CALLBACK_BYTES,
  RunnerResultCallback,
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
  cleanup: Schema.Struct({
    status: Schema.Literals(['destroyed', 'failed']),
  }),
  result: Schema.optional(StructuredReviewResult),
});

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
]);
export type CallbackRecoveryReason = typeof CallbackRecoveryReason.Type;

export class CallbackRecoveryError extends Schema.TaggedError<CallbackRecoveryError>()(
  'CallbackRecoveryError',
  { reason: CallbackRecoveryReason },
) {}

export type RecoveredCallback = {
  readonly body: string;
  readonly callback: typeof RunnerResultCallback.Type;
};

const fail = (reason: CallbackRecoveryReason) => Effect.fail(new CallbackRecoveryError({ reason }));

const readStat = (path: string, reason: CallbackRecoveryReason) =>
  Effect.tryPromise({
    try: () => stat(path),
    catch: () => new CallbackRecoveryError({ reason }),
  });

const artifactBytes = (artifact: {
  readonly content: string;
  readonly size: number;
  readonly sha256: string;
}): Buffer | undefined => {
  const decoded = Schema.decodeUnknownOption(Schema.Uint8ArrayFromBase64)(artifact.content);
  if (Option.isNone(decoded)) return undefined;
  const bytes = Buffer.from(decoded.value);
  if (bytes.byteLength !== artifact.size) return undefined;
  return createHash('sha256').update(bytes).digest('hex') === artifact.sha256.toLowerCase()
    ? bytes
    : undefined;
};

export const recoverCallback = Effect.fn('recoverCallback')(function* (
  evidenceRoot: string,
  request: ReplayCallbackRequest,
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

  const text = new TextDecoder().decode(body);
  const callback = Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.fromJsonString(RunnerResultCallback))(text),
  );
  if (callback === undefined) return yield* fail('invalid-callback');

  const included = [
    callback.evidence.manifest,
    callback.evidence.opencodeJsonl,
    callback.evidence.opencodeStderr,
    ...(callback.evidence.validatedReview === undefined ? [] : [callback.evidence.validatedReview]),
    ...(callback.evidence.opencodeSessionList === undefined
      ? []
      : [callback.evidence.opencodeSessionList]),
    ...(callback.evidence.opencodeExport === undefined
      ? []
      : [callback.evidence.opencodeExport.content]),
  ];
  if (included.some((artifact) => artifactBytes(artifact) === undefined)) {
    return yield* fail('integrity-mismatch');
  }

  const manifestBytes = artifactBytes(callback.evidence.manifest);
  if (manifestBytes === undefined) return yield* fail('integrity-mismatch');
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
    manifest.terminal.status !== callback.status ||
    manifest.evidence.status !== callback.evidence.status
  ) {
    return yield* fail('identity-mismatch');
  }

  if (manifest.cleanup.status !== 'destroyed' || callback.sandbox.cleanup !== 'destroyed') {
    return yield* fail('cleanup-not-confirmed');
  }

  if (callback.status === 'succeeded') {
    if (manifest.complete !== true) return yield* fail('result-mismatch');
    const reviewBytes = artifactBytes(callback.evidence.validatedReview);
    const result = callback.result;
    const markdown = typeof result === 'string' ? result : result.markdown;
    if (
      reviewBytes === undefined ||
      !reviewBytes.equals(Buffer.from(markdown)) ||
      (typeof result === 'string'
        ? manifest.result !== undefined
        : manifest.result === undefined ||
          manifest.result.decision !== result.decision ||
          manifest.result.markdown !== result.markdown)
    ) {
      return yield* fail('result-mismatch');
    }
  } else if (manifest.result !== undefined) {
    return yield* fail('result-mismatch');
  }

  return { body: text, callback };
});
