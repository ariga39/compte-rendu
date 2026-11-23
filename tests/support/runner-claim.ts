import { expect } from 'vitest';
import type { ReviewJob, ReviewStateStore } from '../../apps/core/src/index';

export const claimRunnerJob = async (
  store: Pick<ReviewStateStore, 'claimNextJob'>,
  input: {
    readonly runId: string;
    readonly jobId: string;
    readonly attempt?: number;
    readonly occurredAt?: string;
    readonly job?: Partial<ReviewJob>;
  },
) => {
  const attempt = input.attempt ?? 1;
  const occurredAt = input.occurredAt ?? '2026-09-01T00:00:00.500Z';
  const claimed = await store.claimNextJob({
    jobId: input.jobId,
    attempt,
    occurredAt,
  });
  if (claimed.kind !== 'claimed') throw new Error(`run was not claimable: ${claimed.kind}`);
  expect(claimed).toMatchObject({
    runId: input.runId,
    jobId: input.jobId,
    attempt,
    claimedAt: occurredAt,
    ...(input.job === undefined ? {} : { job: input.job }),
  });
  return claimed;
};
