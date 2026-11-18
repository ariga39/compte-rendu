/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { REVIEW_ATTEMPT_BUDGET_MS } from '../../packages/contracts/src';
import type {
  D1DatabaseLike,
  IssueGrantInput,
  IssueGrantResult,
  RevokeGrantInput,
  RevokeGrantResult,
} from '../../apps/inference-worker/src/grants';

const GRANT_TTL_MS = 4 * REVIEW_ATTEMPT_BUDGET_MS;

interface InferenceBinding {
  fetch(request: Request): Promise<Response>;
  issue(input: IssueGrantInput): Promise<IssueGrantResult>;
  revoke(input: RevokeGrantInput): Promise<RevokeGrantResult>;
}

interface RuntimeEnv {
  readonly RELAY_DB: D1DatabaseLike;
  readonly INFERENCE: InferenceBinding;
}

const runtime = env as unknown as RuntimeEnv;
const snapshot = { routes: ['deepseek-review', 'step-review'] };

const d1Now = async () => {
  const row = await runtime.RELAY_DB.prepare(
    "SELECT CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER) AS now",
  ).first<{ readonly now: number }>();
  if (row === null) throw new Error('missing D1 clock');
  return row.now;
};

describe('Inference Worker runtime boundaries', () => {
  it('keeps grant control off the public HTTP interface', async () => {
    const now = await d1Now();
    for (const path of ['/grants', '/grants/revoke', '/runner-llm/grants']) {
      const response = await runtime.INFERENCE.fetch(
        new Request(`https://inference.internal${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jobId: 'runtime-public',
            snapshot,
            latestIssueDeadline: now + 60_000,
          }),
        }),
      );

      expect(response.status).toBe(404);
    }
    await expect(
      runtime.INFERENCE.issue({
        jobId: 'runtime-public',
        snapshot,
        latestIssueDeadline: now + 60_000,
      }),
    ).resolves.toMatchObject({ kind: 'issued' });
  });

  it('issues and revokes through the service-binding RPC interface', async () => {
    const now = await d1Now();
    const issued = await runtime.INFERENCE.issue({
      jobId: 'runtime-rpc',
      snapshot,
      latestIssueDeadline: now + 60_000,
    });

    expect(issued.kind).toBe('issued');
    if (issued.kind !== 'issued') throw new Error('expected an issued grant');
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(Date.parse(issued.expiresAt)).toBeGreaterThanOrEqual(now + GRANT_TTL_MS);
    expect(Date.parse(issued.expiresAt)).toBeLessThanOrEqual((await d1Now()) + GRANT_TTL_MS);

    await expect(runtime.INFERENCE.revoke({ jobId: 'runtime-rpc' })).resolves.toEqual({
      kind: 'revoked',
    });
    await expect(
      runtime.INFERENCE.issue({
        jobId: 'runtime-rpc',
        snapshot,
        latestIssueDeadline: (await d1Now()) + 60_000,
      }),
    ).resolves.toEqual({ kind: 'duplicate' });
  });

  it('rejects an expired issue deadline over RPC', async () => {
    const now = await d1Now();
    await expect(
      runtime.INFERENCE.issue({
        jobId: 'runtime-expired',
        snapshot,
        latestIssueDeadline: now,
      }),
    ).resolves.toEqual({ kind: 'deadline-exceeded' });
  });
});
