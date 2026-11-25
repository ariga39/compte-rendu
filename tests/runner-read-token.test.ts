import { describe, expect, it, vi } from 'vitest';
import {
  REVIEW_ATTEMPT_BUDGET_MS,
  type ReviewEvent,
  type RunnerJobInput,
} from '../packages/contracts/src';
import { createCoreWorker } from '../apps/core/src/core-worker';
import { createD1ReviewStateStore } from '../apps/core/src/index';
import { SqliteD1Database } from './support/d1-database';

const event: ReviewEvent = {
  deliveryId: 'delivery-read-renewal',
  event: 'pull_request',
  action: 'opened',
  repositoryId: 11,
  pullRequestNumber: 42,
  installationId: 7,
  repositoryVisibility: 'private',
  baseRepositoryId: 11,
  headRepositoryId: 11,
  draft: false,
  baseSha: '1'.repeat(40),
  headSha: '2'.repeat(40),
};

const claimedAt = '2026-09-01T00:00:00.000Z';

const readTokenRequest = (body: { runId: string; jobId: string; attempt: number }) =>
  new Request('https://reviews.test/runner-read-token', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

const createClaimedReview = async (
  database: SqliteD1Database,
  token: { current: string; expiresAt: string },
  mint?: (input: { installationId: number; repositoryId: number }) => Promise<void>,
) => {
  const mintCalls: Array<{ installationId: number; repositoryId: number }> = [];
  const worker = createCoreWorker(
    {
      REVIEW_DB: database,
      GITHUB_APP_ID: '1234567',
      GITHUB_APP_PRIVATE_KEY: 'test-private-key',
    },
    {
      github: {
        getRepositoryUrl: async () => 'https://github.com/acme/reviewed.git',
        loadReviewTarget: async () => ({ headSha: event.headSha }),
      },
      getReadInstallationToken: async (input) => {
        mintCalls.push(input);
        await mint?.(input);
        return { token: token.current, expiresAt: token.expiresAt };
      },
    },
  );
  const scheduled = await worker.submitReviewEvent(event);
  expect(scheduled).toBe('accepted');
  const claim = await worker.claimRunnerJob(
    new Request('https://reviews.test/runner-claim', {
      method: 'POST',
    }),
  );
  expect(claim.status).toBe(200);
  const input = (await claim.json()) as RunnerJobInput;
  return { worker, input, mintCalls };
};

describe('Runner read-token renewal', () => {
  it('renews an exact live claim with a fresh repository-scoped token and no-store response', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const database = new SqliteD1Database();
    const token = {
      current: 'initial-read-token',
      expiresAt: '2026-09-01T01:00:00.000Z',
    };
    try {
      vi.setSystemTime(new Date(claimedAt));
      const { worker, input, mintCalls } = await createClaimedReview(database, token);

      vi.setSystemTime(new Date('2026-09-01T00:50:00.000Z'));
      token.current = 'renewed-read-token';
      token.expiresAt = '2026-09-01T01:50:00.000Z';
      const response = await worker.renewRunnerReadToken(
        readTokenRequest({ runId: input.runId, jobId: input.id, attempt: input.attempt }),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({
        token: 'renewed-read-token',
        expiresAt: '2026-09-01T01:50:00.000Z',
      });
      expect(mintCalls.at(-1)).toEqual({ installationId: 7, repositoryId: 11 });
    } finally {
      database.close();
      vi.useRealTimers();
    }
  });

  it('rejects forged run, job, and attempt identities without minting a token', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const database = new SqliteD1Database();
    const token = {
      current: 'initial-read-token',
      expiresAt: '2026-09-01T01:00:00.000Z',
    };
    try {
      vi.setSystemTime(new Date(claimedAt));
      const { worker, input, mintCalls } = await createClaimedReview(database, token);
      const mintsBeforeRenewal = mintCalls.length;

      for (const body of [
        { runId: 'forged-run', jobId: input.id, attempt: input.attempt },
        { runId: input.runId, jobId: 'forged-job', attempt: input.attempt },
        { runId: input.runId, jobId: input.id, attempt: input.attempt + 1 },
      ]) {
        const response = await worker.renewRunnerReadToken(readTokenRequest(body));
        expect(response.status).toBe(409);
        expect(await response.text()).not.toContain('initial-read-token');
      }
      expect(mintCalls).toHaveLength(mintsBeforeRenewal);
    } finally {
      database.close();
      vi.useRealTimers();
    }
  });

  it.each(['completed', 'failed', 'superseded', 'cancelled', 'publication'] as const)(
    'rejects a claim that is no longer live after it becomes %s',
    async (disposition) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const database = new SqliteD1Database();
      const token = {
        current: 'initial-read-token',
        expiresAt: '2026-09-01T01:00:00.000Z',
      };
      try {
        vi.setSystemTime(new Date(claimedAt));
        const { worker, input } = await createClaimedReview(database, token);
        const store = createD1ReviewStateStore(database);
        const occurredAt = '2026-09-01T00:10:00.000Z';
        vi.setSystemTime(new Date(occurredAt));

        if (disposition === 'completed') {
          await store.markRunCompleted({ runId: input.runId, occurredAt });
        } else if (disposition === 'failed') {
          await store.markSchedulingFailed({ runId: input.runId, occurredAt });
        } else if (disposition === 'superseded') {
          await store.markRunSuperseded({ runId: input.runId, occurredAt });
        } else if (disposition === 'cancelled') {
          await store.cancelRun({ runId: input.runId, requestedByUid: 99, occurredAt });
        } else {
          await store.claimRunPublication({ runId: input.runId, occurredAt });
        }

        const response = await worker.renewRunnerReadToken(
          readTokenRequest({ runId: input.runId, jobId: input.id, attempt: input.attempt }),
        );
        expect(response.status).toBe(409);
        expect(await response.text()).not.toContain('initial-read-token');
      } finally {
        database.close();
        vi.useRealTimers();
      }
    },
  );

  it('rejects an original claim at and beyond the shared attempt budget', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const database = new SqliteD1Database();
    const token = {
      current: 'initial-read-token',
      expiresAt: '2026-09-01T03:00:00.000Z',
    };
    try {
      vi.setSystemTime(new Date(claimedAt));
      const { worker, input } = await createClaimedReview(database, token);

      vi.setSystemTime(new Date(Date.parse(claimedAt) + REVIEW_ATTEMPT_BUDGET_MS - 1));
      expect(
        (
          await worker.renewRunnerReadToken(
            readTokenRequest({ runId: input.runId, jobId: input.id, attempt: input.attempt }),
          )
        ).status,
      ).toBe(200);

      vi.setSystemTime(new Date(Date.parse(claimedAt) + REVIEW_ATTEMPT_BUDGET_MS));
      const expired = await worker.renewRunnerReadToken(
        readTokenRequest({ runId: input.runId, jobId: input.id, attempt: input.attempt }),
      );
      expect(expired.status).toBe(409);
      expect(await expired.text()).not.toContain('initial-read-token');
    } finally {
      database.close();
      vi.useRealTimers();
    }
  });

  it('rechecks the exact live claim after minting and withholds a cancelled token', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const database = new SqliteD1Database();
    const token = {
      current: 'initial-read-token',
      expiresAt: '2026-09-01T01:00:00.000Z',
    };
    let startMint!: () => void;
    const mintStarted = new Promise<void>((resolve) => {
      startMint = resolve;
    });
    let finishMint!: () => void;
    const mintGate = new Promise<void>((resolve) => {
      finishMint = resolve;
    });
    try {
      vi.setSystemTime(new Date(claimedAt));
      const { worker, input } = await createClaimedReview(database, token, async () => {
        if (token.current !== 'must-not-be-returned') return;
        startMint();
        await mintGate;
      });

      token.current = 'must-not-be-returned';
      token.expiresAt = '2026-09-01T01:50:00.000Z';
      const renewal = worker.renewRunnerReadToken(
        readTokenRequest({ runId: input.runId, jobId: input.id, attempt: input.attempt }),
      );
      await mintStarted;
      await createD1ReviewStateStore(database).cancelRun({
        runId: input.runId,
        requestedByUid: 99,
        occurredAt: '2026-09-01T00:05:00.000Z',
      });
      finishMint();

      const response = await renewal;
      expect(response.status).toBe(409);
      expect(await response.text()).not.toContain('must-not-be-returned');
    } finally {
      finishMint();
      database.close();
      vi.useRealTimers();
    }
  });

  it('rejects a near-expiring grant without minting a second token', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const database = new SqliteD1Database();
    let mintCount = 0;
    let grant = {
      token: 'initial-read-token',
      expiresAt: '2026-09-01T01:00:00.000Z',
    };
    try {
      vi.setSystemTime(new Date(claimedAt));
      const worker = createCoreWorker(
        {
          REVIEW_DB: database,
          GITHUB_APP_ID: '1234567',
          GITHUB_APP_PRIVATE_KEY: 'test-private-key',
        },
        {
          github: {
            getRepositoryUrl: async () => 'https://github.com/acme/reviewed.git',
            loadReviewTarget: async () => ({ headSha: event.headSha }),
          },
          getReadInstallationToken: async () => {
            mintCount += 1;
            return grant;
          },
        },
      );
      await worker.submitReviewEvent(event);
      const claim = await worker.claimRunnerJob(
        new Request('https://reviews.test/runner-claim', {
          method: 'POST',
        }),
      );
      const input = (await claim.json()) as RunnerJobInput;

      grant = {
        token: 'near-expiring-cached-token',
        expiresAt: '2026-09-01T00:50:30.000Z',
      };
      vi.setSystemTime(new Date('2026-09-01T00:50:00.000Z'));
      const response = await worker.renewRunnerReadToken(
        readTokenRequest({ runId: input.runId, jobId: input.id, attempt: input.attempt }),
      );

      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain('near-expiring-cached-token');
      expect(mintCount).toBe(2);
    } finally {
      database.close();
      vi.useRealTimers();
    }
  });

  it('rejects when the expiry margin is consumed while minting and rechecking', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const database = new SqliteD1Database();
    let mintCount = 0;
    let grant = {
      token: 'initial-read-token',
      expiresAt: '2026-09-01T01:00:00.000Z',
    };
    try {
      vi.setSystemTime(new Date(claimedAt));
      const worker = createCoreWorker(
        {
          REVIEW_DB: database,
          GITHUB_APP_ID: '1234567',
          GITHUB_APP_PRIVATE_KEY: 'test-private-key',
        },
        {
          github: {
            getRepositoryUrl: async () => 'https://github.com/acme/reviewed.git',
            loadReviewTarget: async () => ({ headSha: event.headSha }),
          },
          getReadInstallationToken: async () => {
            mintCount += 1;
            if (mintCount === 2) {
              vi.setSystemTime(new Date('2026-09-01T00:51:30.000Z'));
            }
            return grant;
          },
        },
      );
      await worker.submitReviewEvent(event);
      const claim = await worker.claimRunnerJob(
        new Request('https://reviews.test/runner-claim', {
          method: 'POST',
        }),
      );
      const input = (await claim.json()) as RunnerJobInput;

      grant = {
        token: 'expiring-during-mint-token',
        expiresAt: '2026-09-01T00:52:00.000Z',
      };
      vi.setSystemTime(new Date('2026-09-01T00:50:00.000Z'));
      const response = await worker.renewRunnerReadToken(
        readTokenRequest({ runId: input.runId, jobId: input.id, attempt: input.attempt }),
      );

      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain('expiring-during-mint-token');
      expect(mintCount).toBe(2);
    } finally {
      database.close();
      vi.useRealTimers();
    }
  });
});
