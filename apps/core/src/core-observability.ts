import {
  sanitizeOperationalLogEvent,
  type OperationalLog,
  type OperationalLogEvent,
} from '@compte-rendu/contracts';
import { DateTime, Effect, Option, Schema } from 'effect';
import { ReviewTrigger, type ReviewOutcome } from './review-records';

const CoreLifecycleIdentifier = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9._:-]{1,128}$/)),
);
const CoreLifecycleMilliseconds = Schema.Natural;
export const CoreLifecycleFailureReason = Schema.Literals([
  'upstream',
  'checkout',
  'sandbox',
  'agent',
  'timeout',
  'invalid_output',
  'evidence',
  'cleanup',
  'callback',
  'marker_lookup_failed',
  'publication_uncertain',
  'completion_failed',
  'review_reset_failed',
  'configuration',
  'unknown',
]);
export type CoreLifecycleFailureReason = typeof CoreLifecycleFailureReason.Type;
const CoreLifecycleCommon = {
  runId: CoreLifecycleIdentifier,
  trigger: ReviewTrigger,
} as const;
const CoreLifecycleFinishedCommon = {
  event: Schema.Literal('review finished'),
  ...CoreLifecycleCommon,
  totalDurationMs: CoreLifecycleMilliseconds,
  queueWaitMs: Schema.optional(CoreLifecycleMilliseconds),
  cleanupStatus: Schema.Literals(['destroyed', 'failed', 'unknown']),
  evidenceStatus: Schema.Literals(['complete', 'incomplete', 'unknown']),
} as const;
const CoreLifecycleFailurePhase = Schema.Literals([
  'admission',
  'scheduling',
  'checkout',
  'sandbox',
  'agent',
  'output_validation',
  'evidence',
  'callback',
  'publication',
  'cleanup',
  'unknown',
]);
export const CoreLifecycleEvent = Schema.Union([
  Schema.Struct({
    event: Schema.Literal('review scheduled'),
    ...CoreLifecycleCommon,
  }),
  Schema.Struct({
    event: Schema.Literal('review claimed'),
    ...CoreLifecycleCommon,
    queueWaitMs: CoreLifecycleMilliseconds,
  }),
  Schema.Struct({
    ...CoreLifecycleFinishedCommon,
    outcome: Schema.Literal('completed'),
    published: Schema.Literal(true),
  }),
  Schema.Struct({
    ...CoreLifecycleFinishedCommon,
    outcome: Schema.Literal('superseded'),
    published: Schema.Literal(false),
  }),
  Schema.Struct({
    ...CoreLifecycleFinishedCommon,
    outcome: Schema.Literal('cancelled'),
    published: Schema.Literal(false),
  }),
  Schema.Struct({
    ...CoreLifecycleFinishedCommon,
    outcome: Schema.Literal('failed'),
    published: Schema.Literal(false),
    failurePhase: CoreLifecycleFailurePhase,
    failureReason: CoreLifecycleFailureReason,
  }),
]);
export type CoreLifecycleEvent = typeof CoreLifecycleEvent.Type;

export interface CoreLifecycleLog {
  readonly record: (event: CoreLifecycleEvent) => void;
}

export const currentIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

export const recordOperationalLog = (
  log: OperationalLog | undefined,
  event: OperationalLogEvent,
) =>
  log === undefined
    ? Effect.succeed(undefined)
    : Effect.tryPromise({
        try: async () => {
          await log.record(sanitizeOperationalLogEvent(event));
        },
        catch: () => undefined,
      }).pipe(Effect.catch(() => Effect.succeed(undefined)));

export const recordLifecycleLog = (log: CoreLifecycleLog | undefined, event: CoreLifecycleEvent) =>
  Effect.sync(() => {
    if (log === undefined) return;
    try {
      log.record(event);
    } catch {
      // Lifecycle capture is best effort and cannot affect product behavior.
    }
  });

export const recordSupersededLifecycle = (
  log: CoreLifecycleLog | undefined,
  runId: string,
  outcome: ReviewOutcome,
  finishedAt: string,
  cleanupStatus: 'destroyed' | 'unknown',
) => {
  const created = DateTime.make(outcome.createdAt);
  const finished = DateTime.make(finishedAt);
  const totalDurationMs =
    Option.isSome(created) && Option.isSome(finished)
      ? Math.max(0, finished.value.epochMilliseconds - created.value.epochMilliseconds)
      : 0;
  return recordLifecycleLog(log, {
    event: 'review finished',
    runId,
    trigger: outcome.trigger,
    outcome: 'superseded',
    published: false,
    totalDurationMs,
    cleanupStatus,
    evidenceStatus: 'unknown',
  });
};
