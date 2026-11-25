import { REVIEW_ATTEMPT_BUDGET_MS } from '@compte-rendu/contracts';

/**
 * Every Runner-owned Sandbox name starts with our reserved prefix and a
 * parseable creation epoch: `compte-rendu-<epoch-seconds>-<jobId>`. The epoch
 * is captured before the resource is created, so an age sweep can remove it
 * without a separate ownership record.
 */
export const SANDBOX_RESOURCE_PREFIX = 'compte-rendu-';

/**
 * A claimed review may use the full attempt budget and then finalization
 * (bounded archive plus destroy retries). The extra margin keeps an age sweep
 * strictly after the last possible live use under a host wall clock that
 * advances continuously. An arbitrary clock jump is outside this guarantee;
 * the Runner still skips jobs its own registry reports as live.
 */
export const SANDBOX_RESOURCE_MAX_AGE_MS = REVIEW_ATTEMPT_BUDGET_MS + 30 * 60 * 1000;

const timestamped = /^compte-rendu-(\d{10})-([a-z0-9][a-z0-9-]*)$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type SandboxResourceIdentity = {
  readonly jobId: string;
  readonly createdAtMs: number;
};

export const sandboxResourceName = (jobId: string, now = Date.now()): string =>
  `${SANDBOX_RESOURCE_PREFIX}${Math.floor(now / 1000)}-${jobId}`;

export const sandboxResourceIdentity = (name: string): SandboxResourceIdentity | undefined => {
  const match = timestamped.exec(name);
  if (match === null) return undefined;
  const epochSeconds = Number(match[1]);
  if (!Number.isSafeInteger(epochSeconds)) return undefined;
  return { createdAtMs: epochSeconds * 1000, jobId: match[2]! };
};

/**
 * Broad inventory sweeps only touch the exact shape this Runner allocates.
 * Exact cleanup from a trusted manifest may still use any job id.
 */
export const sweepableSandboxResource = (name: string, now = Date.now()): boolean => {
  const identity = sandboxResourceIdentity(name);
  return (
    identity !== undefined &&
    uuid.test(identity.jobId) &&
    now - identity.createdAtMs >= SANDBOX_RESOURCE_MAX_AGE_MS
  );
};
