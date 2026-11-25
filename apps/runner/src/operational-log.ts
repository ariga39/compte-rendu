import {
  sanitizeOperationalLogEvent,
  type OperationalLog,
  type OperationalLogEvent,
} from '@compte-rendu/contracts';

export type RecordLog = (event: OperationalLogEvent) => Promise<void>;

export type WarnLog = (message: string, fields?: Readonly<Record<string, string>>) => void;

/**
 * Operational logging is best effort: a sink failure never changes a Job
 * outcome. Warnings stay on the plain host logger so the execution path needs
 * no ad-hoc Effect bridge.
 */
export const createBestEffortLog = (
  sink: OperationalLog | undefined,
): { readonly record: RecordLog; readonly warn: WarnLog } => ({
  record: async (event) => {
    if (sink === undefined) return;
    try {
      await sink.record(sanitizeOperationalLogEvent(event));
    } catch {
      // Diagnostics must not change the Runner Job outcome.
    }
  },
  warn: (message, fields) => {
    try {
      console.warn(JSON.stringify({ level: 'warn', message, ...fields }));
    } catch {
      // Diagnostics must not change the Runner Job outcome.
    }
  },
});
