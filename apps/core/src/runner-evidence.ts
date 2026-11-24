import { Option, Schema } from 'effect';
import { StructuredReviewResult, type RunnerResultCallback } from '@compte-rendu/contracts';

export const RunnerManifest = Schema.Struct({
  result: Schema.optional(StructuredReviewResult),
  jobId: Schema.NonEmptyString,
  runId: Schema.NonEmptyString,
  attempt: Schema.Int,
  evidenceId: Schema.NonEmptyString,
  sessionIds: Schema.Array(Schema.NonEmptyString),
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
});
export const RunnerSessionList = Schema.Union([
  Schema.Array(Schema.Struct({ id: Schema.NonEmptyString })),
  Schema.Struct({ sessions: Schema.Array(Schema.Struct({ id: Schema.NonEmptyString })) }),
]);
export const RunnerSessionExport = Schema.Struct({
  info: Schema.Struct({ id: Schema.NonEmptyString }),
  messages: Schema.Array(Schema.Unknown),
});

export const decodeArtifact = (content: string): Uint8Array | undefined => {
  const decoded = Schema.decodeUnknownOption(Schema.Uint8ArrayFromBase64)(content);
  return Option.isSome(decoded) ? decoded.value : undefined;
};

export const artifactMatchesMetadata = async (artifact: {
  readonly content: string;
  readonly size: number;
  readonly sha256: string;
}) => {
  const bytes = decodeArtifact(artifact.content);
  if (bytes === undefined || bytes.byteLength !== artifact.size) return false;
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  const sha256 = Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return sha256 === artifact.sha256.toLowerCase();
};

export const PublicationArchive = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    runId: Schema.NonEmptyString,
    jobId: Schema.NonEmptyString,
    evidence: Schema.Struct({
      manifest: Schema.Struct({
        content: Schema.String,
        size: Schema.Number,
        sha256: Schema.String,
      }),
      validatedReview: Schema.Struct({
        content: Schema.String,
        size: Schema.Number,
        sha256: Schema.String,
      }),
    }),
  }),
);

export const decodedJson = <A>(
  content: string,
  schema: Schema.ConstraintDecoder<A>,
): A | undefined => {
  const bytes = decodeArtifact(content);
  if (bytes === undefined) return undefined;
  const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(schema))(
    new TextDecoder().decode(bytes),
  );
  return Option.isSome(decoded) ? decoded.value : undefined;
};

export const completeCallbackEvidenceIsValid = async (
  callback: Extract<typeof RunnerResultCallback.Type, { status: 'succeeded' }>,
) => {
  const { evidence } = callback;
  const artifacts = [
    evidence.manifest,
    evidence.opencodeJsonl,
    evidence.opencodeStderr,
    evidence.validatedReview,
    evidence.opencodeSessionList,
    evidence.opencodeExport.content,
  ];
  if (
    !(await Promise.all(artifacts.map(artifactMatchesMetadata)).then((values) =>
      values.every(Boolean),
    ))
  ) {
    return false;
  }
  const manifest = decodedJson(evidence.manifest.content, RunnerManifest);
  const sessionList = decodedJson(evidence.opencodeSessionList.content, RunnerSessionList);
  const sessionExport = decodedJson(evidence.opencodeExport.content.content, RunnerSessionExport);
  if (manifest === undefined || sessionList === undefined || sessionExport === undefined)
    return false;
  const sessionIds = Array.isArray(sessionList)
    ? sessionList.map((session) => session.id)
    : 'sessions' in sessionList
      ? sessionList.sessions.map((session) => session.id)
      : [];
  if (
    sessionIds.length === 0 ||
    manifest.sessionIds.length !== sessionIds.length ||
    manifest.sessionIds.some((sessionId, index) => sessionId !== sessionIds[index]) ||
    !sessionIds.includes(evidence.opencodeExport.sessionId) ||
    sessionExport.info.id !== evidence.opencodeExport.sessionId ||
    manifest.jobId !== callback.id ||
    manifest.runId !== callback.runId ||
    manifest.attempt !== callback.attempt ||
    manifest.evidenceId !== evidence.id ||
    manifest.evidence.id !== evidence.id ||
    manifest.evidence.status !== 'complete' ||
    manifest.terminal.status !== 'succeeded' ||
    manifest.complete !== true ||
    manifest.cleanup.status !== 'destroyed'
  ) {
    return false;
  }
  const reviewBytes = decodeArtifact(evidence.validatedReview.content);
  if (typeof callback.result === 'string') {
    if (manifest.result !== undefined) return false;
  } else if (
    manifest.result === undefined ||
    manifest.result.decision !== callback.result.decision ||
    manifest.result.markdown !== callback.result.markdown
  )
    return false;
  const resultBytes = new TextEncoder().encode(
    typeof callback.result === 'string' ? callback.result : callback.result.markdown,
  );
  return (
    reviewBytes !== undefined &&
    reviewBytes.byteLength === resultBytes.byteLength &&
    reviewBytes.every((byte, index) => byte === resultBytes[index])
  );
};

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

export interface PublicationEvidenceInput {
  readonly runId: string;
  readonly runnerJobId?: string | undefined;
  readonly runnerAttempt?: number | undefined;
  readonly bytes: ArrayBuffer;
  readonly size: number;
  readonly sha256: string;
}

export type PublicationEvidence =
  | {
      readonly kind: 'valid';
      readonly archive: typeof PublicationArchive.Type;
      readonly manifest: typeof RunnerManifest.Type;
      readonly output: string | (typeof RunnerManifest.Type)['result'];
    }
  | { readonly kind: 'invalid' };

export const validatePublicationEvidence = async (
  input: PublicationEvidenceInput,
): Promise<PublicationEvidence> => {
  const bytes = new Uint8Array(input.bytes);
  if (bytes.byteLength !== input.size || (await sha256Hex(bytes)) !== input.sha256.toLowerCase())
    return { kind: 'invalid' };
  const archive = Schema.decodeUnknownOption(PublicationArchive)(new TextDecoder().decode(bytes));
  if (Option.isNone(archive)) return { kind: 'invalid' };
  const manifest = decodedJson(archive.value.evidence.manifest.content, RunnerManifest);
  if (
    manifest === undefined ||
    !manifest.complete ||
    manifest.terminal.status !== 'succeeded' ||
    archive.value.runId !== input.runId ||
    manifest.runId !== input.runId ||
    archive.value.jobId !== input.runnerJobId ||
    manifest.jobId !== archive.value.jobId ||
    manifest.attempt !== input.runnerAttempt ||
    !(await artifactMatchesMetadata(archive.value.evidence.manifest)) ||
    !(await artifactMatchesMetadata(archive.value.evidence.validatedReview))
  )
    return { kind: 'invalid' };
  const review = decodeArtifact(archive.value.evidence.validatedReview.content);
  if (review === undefined) return { kind: 'invalid' };
  const output = manifest.result ?? new TextDecoder().decode(review);
  if (manifest.result !== undefined) {
    const markdown = new TextEncoder().encode(manifest.result.markdown);
    if (
      markdown.byteLength !== review.byteLength ||
      markdown.some((byte, index) => byte !== review[index])
    )
      return { kind: 'invalid' };
  }
  return { kind: 'valid', archive: archive.value, manifest, output };
};
