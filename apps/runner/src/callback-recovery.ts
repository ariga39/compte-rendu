import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Option, Schema } from 'effect';
import {
  GitHubSha,
  MAX_RUNNER_CALLBACK_BYTES,
  RunnerTerminalCallback,
  StructuredReviewResult,
} from '@compte-rendu/contracts';
import { sandboxResourceIdentity } from './sandbox-resource-name.js';

const EvidenceId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
);

export const CleanupRecoveryRequest = Schema.Struct({
  evidenceId: EvidenceId,
  jobId: Schema.NonEmptyString,
  runId: Schema.NonEmptyString,
  attempt: Schema.Int,
  baseSha: GitHubSha,
  headSha: GitHubSha,
});
export type CleanupRecoveryRequest = typeof CleanupRecoveryRequest.Type;

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
  readonly callback: typeof RunnerTerminalCallback.Type;
  readonly manifest: RecoveredManifest;
};

const fail = (reason: CallbackRecoveryReason): never => {
  throw new CallbackRecoveryError({ reason });
};

const readStat = async (path: string, reason: CallbackRecoveryReason) => {
  try {
    return await stat(path);
  } catch {
    return fail(reason);
  }
};

const readRecoveryFile = async (path: string, reason: CallbackRecoveryReason) => {
  try {
    return await readFile(path);
  } catch {
    return fail(reason);
  }
};

const decodeArchivedCallback = (text: string) =>
  Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.fromJsonString(RunnerTerminalCallback))(text, {
      onExcessProperty: 'error',
    }),
  );

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

export const recoverCallback = async (
  evidenceRoot: string,
  request: CleanupRecoveryRequest,
  cleanupRuntime: string,
): Promise<RecoveredCallback> => {
  const directory = join(evidenceRoot, request.evidenceId);
  const directoryInfo = await readStat(directory, 'missing-evidence');
  if (!directoryInfo.isDirectory()) return fail('missing-evidence');

  const callbackPath = join(directory, 'callback.json');
  const callbackInfo = await readStat(callbackPath, 'missing-callback');
  if (!callbackInfo.isFile()) return fail('missing-callback');
  if (callbackInfo.size > MAX_RUNNER_CALLBACK_BYTES) return fail('oversized-callback');

  const body = await readRecoveryFile(callbackPath, 'missing-callback');
  if (body.byteLength > MAX_RUNNER_CALLBACK_BYTES) return fail('oversized-callback');

  const callback = decodeArchivedCallback(new TextDecoder().decode(body));
  if (callback === undefined) return fail('invalid-callback');

  // The local manifest binds the failed callback to its cleanup evidence.
  const manifestPath = join(directory, 'manifest.json');
  const manifestInfo = await readStat(manifestPath, 'invalid-manifest');
  if (!manifestInfo.isFile() || manifestInfo.size > MAX_RUNNER_CALLBACK_BYTES) {
    return fail('invalid-manifest');
  }
  const manifestBytes = await readRecoveryFile(manifestPath, 'invalid-manifest');
  if (manifestBytes.byteLength > MAX_RUNNER_CALLBACK_BYTES) {
    return fail('invalid-manifest');
  }
  const manifest = Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.fromJsonString(RunnerManifest))(
      new TextDecoder().decode(manifestBytes),
    ),
  );
  if (manifest === undefined) return fail('invalid-manifest');

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
    callback.baseSha !== manifest.baseSha ||
    callback.headSha !== manifest.headSha ||
    manifest.terminal.status !== callback.status
  ) {
    return fail('identity-mismatch');
  }

  const sandboxIdentity =
    manifest.sandboxName === undefined ? undefined : sandboxResourceIdentity(manifest.sandboxName);
  if (
    callback.status !== 'failed' ||
    manifest.runtime !== cleanupRuntime ||
    sandboxIdentity === undefined ||
    sandboxIdentity.jobId !== request.jobId ||
    manifest.cleanup.status !== 'failed' ||
    callback.sandbox.cleanup !== 'failed'
  ) {
    return fail('unsupported-recovery');
  }
  if (manifest.hostCleanupConfirmed !== true) return fail('unsupported-recovery');

  if (manifest.result !== undefined || callback.failure === undefined) {
    return fail('result-mismatch');
  }

  return { callback, recoveryProof: manifest.recoveryProof, manifest };
};
