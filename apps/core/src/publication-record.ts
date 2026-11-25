import { Option, Schema } from 'effect';
import { StructuredReviewResult } from '@compte-rendu/contracts';
import type { R2BucketLike } from './core-worker';

/**
 * Small authoritative record written before publication. Reconciliation uses
 * this instead of the larger, best-effort diagnostic archive.
 */
export const RunnerPublicationRecord = Schema.Struct({
  version: Schema.Literal(2),
  runId: Schema.NonEmptyString,
  jobId: Schema.NonEmptyString,
  attempt: Schema.Int,
  result: StructuredReviewResult,
});
export type RunnerPublicationRecord = typeof RunnerPublicationRecord.Type;

export interface PublicationRecordIdentity {
  readonly runId: string;
  readonly jobId: string;
  readonly attempt: number;
}

/**
 * The key is derived from the exact attempt, so an older attempt or a late
 * diagnostic archive can never occupy the current publication slot.
 */
export const publicationRecordKey = ({ runId, jobId, attempt }: PublicationRecordIdentity) =>
  `reviews/${runId}/publications/${jobId}/${attempt}.json`;

export type PublicationRecordRead =
  | { readonly kind: 'absent' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'valid'; readonly record: RunnerPublicationRecord };

export const readPublicationRecord = async (
  bucket: R2BucketLike | undefined,
  identity: PublicationRecordIdentity,
): Promise<PublicationRecordRead> => {
  const get = bucket?.get;
  if (get === undefined) return { kind: 'invalid' };
  const object = await get.call(bucket, publicationRecordKey(identity));
  if (object === null) return { kind: 'absent' };
  try {
    const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(RunnerPublicationRecord))(
      new TextDecoder().decode(await object.arrayBuffer()),
    );
    if (Option.isNone(decoded)) return { kind: 'invalid' };
    const record = decoded.value;
    if (
      record.runId !== identity.runId ||
      record.jobId !== identity.jobId ||
      record.attempt !== identity.attempt
    )
      return { kind: 'invalid' };
    return { kind: 'valid', record };
  } catch {
    return { kind: 'invalid' };
  }
};

export type PublicationRecordWrite =
  | { readonly kind: 'persisted'; readonly record: RunnerPublicationRecord }
  | { readonly kind: 'existing'; readonly record: RunnerPublicationRecord }
  | { readonly kind: 'unavailable' };

/**
 * Create the attempt key at most once. Concurrent callbacks for the same
 * attempt converge on the first persisted result; a stale attempt writes to a
 * different key. A write failure is retryable and must not claim publication.
 */
export const storePublicationRecord = async (
  bucket: R2BucketLike | undefined,
  record: RunnerPublicationRecord,
): Promise<PublicationRecordWrite> => {
  if (bucket === undefined) return { kind: 'unavailable' };
  const key = publicationRecordKey(record);
  let created: unknown;
  try {
    created = await bucket.put(key, JSON.stringify(record), {
      onlyIf: { etagDoesNotMatch: '*' },
    });
  } catch {
    return { kind: 'unavailable' };
  }
  if (created !== null) return { kind: 'persisted', record };
  const existing = await readPublicationRecord(bucket, record);
  return existing.kind === 'valid'
    ? { kind: 'existing', record: existing.record }
    : { kind: 'unavailable' };
};
