import {
  sanitizeOperationalLogEvent,
  type OperationalLog,
  type OperationalLogEvent,
} from '@compte-rendu/contracts';

export const createCloudflareOperationalLog = (
  sink: Pick<Console, 'log'> = console,
): OperationalLog => ({
  record: (event: OperationalLogEvent) => {
    sink.log(sanitizeOperationalLogEvent(event));
  },
});
