import {
  sanitizeOperationalLogEvent,
  type OperationalLog,
  type OperationalLogEvent,
} from '@compte-rendu/contracts';
import { DateTime, Effect } from 'effect';

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
