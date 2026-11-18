import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createGrantControl } from '../apps/inference-worker/src/grants';
import { REVIEW_ATTEMPT_BUDGET_MS } from '../packages/contracts/src';
import { SqliteD1Database } from './support/d1-database';

const GRANT_TTL_MS = 4 * REVIEW_ATTEMPT_BUDGET_MS;
const snapshot = { routes: ['deepseek-review', 'step-review'] };
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

const setup = () => {
  const database = new SqliteD1Database(
    ['0001_grants.sql'],
    '../../apps/inference-worker/migrations',
  );
  return { database, control: createGrantControl(database) };
};

const d1Now = async (database: SqliteD1Database) => {
  const row = database.database
    .prepare("SELECT CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER) AS now")
    .get();
  return (row as { readonly now: number }).now;
};

describe('Inference Worker grant issue', () => {
  it('issues a base64url bearer with the fixed lifetime derived from the D1 clock', async () => {
    const { database, control } = setup();
    try {
      const before = await d1Now(database);
      const issued = await control.issue({
        jobId: 'job-issue',
        snapshot,
        latestIssueDeadline: before + 60_000,
      });
      const after = await d1Now(database);

      expect(issued.kind).toBe('issued');
      if (issued.kind !== 'issued') throw new Error('expected an issued grant');
      expect(issued.token).toMatch(/^[A-Za-z0-9_-]{32,}$/);
      expect(issued.token).not.toContain('=');
      expect(Date.parse(issued.expiresAt)).toBeGreaterThanOrEqual(before + GRANT_TTL_MS);
      expect(Date.parse(issued.expiresAt)).toBeLessThanOrEqual(after + GRANT_TTL_MS);
    } finally {
      database.close();
    }
  });

  it('persists only the bearer digest', async () => {
    const { database, control } = setup();
    try {
      const now = await d1Now(database);
      const issued = await control.issue({
        jobId: 'job-hash',
        snapshot,
        latestIssueDeadline: now + 60_000,
      });
      if (issued.kind !== 'issued') throw new Error('expected an issued grant');

      const row = database.database
        .prepare('SELECT token_hash FROM grants WHERE job_id = ?')
        .get('job-hash') as { readonly token_hash: string };

      expect(row).toEqual({ token_hash: sha256(issued.token) });
      expect(row.token_hash).not.toBe(issued.token);
    } finally {
      database.close();
    }
  });

  it('rejects a deadline that is not strictly before the D1 issue time', async () => {
    const { database, control } = setup();
    try {
      const now = await d1Now(database);
      await expect(
        control.issue({
          jobId: 'job-delayed',
          snapshot,
          latestIssueDeadline: now,
        }),
      ).resolves.toEqual({ kind: 'deadline-exceeded' });
      await expect(
        control.issue({
          jobId: 'job-delayed',
          snapshot,
          latestIssueDeadline: (await d1Now(database)) + 60_000,
        }),
      ).resolves.toMatchObject({ kind: 'issued' });
    } finally {
      database.close();
    }
  });

  it('allows exactly one concurrent issue for a job and never renews it', async () => {
    const { database, control } = setup();
    try {
      const deadline = (await d1Now(database)) + 60_000;
      const results = await Promise.all([
        control.issue({ jobId: 'job-duplicate', snapshot, latestIssueDeadline: deadline }),
        control.issue({
          jobId: 'job-duplicate',
          snapshot: { routes: ['other-review'] },
          latestIssueDeadline: deadline,
        }),
      ]);

      expect(results.map((result) => result.kind).sort()).toEqual(['duplicate', 'issued']);
      await expect(
        control.issue({
          jobId: 'job-duplicate',
          snapshot,
          latestIssueDeadline: (await d1Now(database)) + 60_000,
        }),
      ).resolves.toEqual({ kind: 'duplicate' });
    } finally {
      database.close();
    }
  });
});

describe('Inference Worker grant revoke', () => {
  it('tombstones an unknown job and blocks its delayed issue', async () => {
    const { database, control } = setup();
    try {
      await expect(control.revoke({ jobId: 'job-tombstone' })).resolves.toEqual({
        kind: 'revoked',
      });
      await expect(
        control.issue({
          jobId: 'job-tombstone',
          snapshot,
          latestIssueDeadline: (await d1Now(database)) + 60_000,
        }),
      ).resolves.toEqual({ kind: 'duplicate' });
      await expect(control.revoke({ jobId: 'job-tombstone' })).resolves.toEqual({
        kind: 'revoked',
      });
    } finally {
      database.close();
    }
  });

  it('revokes an issued grant idempotently without issuing it again', async () => {
    const { database, control } = setup();
    try {
      await expect(
        control.issue({
          jobId: 'job-revoke',
          snapshot,
          latestIssueDeadline: (await d1Now(database)) + 60_000,
        }),
      ).resolves.toMatchObject({ kind: 'issued' });

      await expect(control.revoke({ jobId: 'job-revoke' })).resolves.toEqual({
        kind: 'revoked',
      });
      await expect(control.revoke({ jobId: 'job-revoke' })).resolves.toEqual({
        kind: 'revoked',
      });
      await expect(
        control.issue({
          jobId: 'job-revoke',
          snapshot,
          latestIssueDeadline: (await d1Now(database)) + 60_000,
        }),
      ).resolves.toEqual({ kind: 'duplicate' });
    } finally {
      database.close();
    }
  });
});
