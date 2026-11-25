export type HostLogFields = Readonly<Record<string, string | number | null>>;

/**
 * Relay diagnostics are best effort: a host logger failure never changes a
 * stream or accounting outcome. Keeping them on the plain host logger avoids
 * launching the Effect runtime from inside the SSE relay.
 */
const emit = (level: 'info' | 'warn', event: string, fields?: HostLogFields): void => {
  try {
    const line = JSON.stringify({ level, message: event, ...fields });
    if (level === 'warn') console.warn(line);
    else console.info(line);
  } catch {
    // Diagnostics must not change the relay response or settlement.
  }
};

export const logInfo = (event: string, fields?: HostLogFields): void => emit('info', event, fields);

export const logWarning = (event: string): void => emit('warn', event);
