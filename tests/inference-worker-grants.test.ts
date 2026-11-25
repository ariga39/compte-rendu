import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createGrantControl } from '../apps/inference-worker/src/grants';
import { authenticateGrant } from '../apps/inference-worker/src/ledger';
import { REVIEW_ATTEMPT_BUDGET_MS } from '../packages/contracts/src';
import { SqliteD1Database } from './support/d1-database';

const GRANT_TTL_MS = 4 * REVIEW_ATTEMPT_BUDGET_MS;
const snapshot = { routes: ['deepseek-review', 'step-review'] };
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

const setup = () => {
  const database = new SqliteD1Database('inference-worker');
  const insertCatalog = database.database.prepare(
    `INSERT INTO catalog_routes (route_id, upstream_model, provider_slug, credential_alias, profile)
    VALUES (?, ?, ?, ?, ?)`,
  );
  for (const route of [...snapshot.routes, 'other-review']) {
    insertCatalog.run(route, `${route}-native`, 'review-provider', 'default', 'chat');
  }
  return { database, control: createGrantControl(database) };
};

const mutationCounts = (database: SqliteD1Database) => ({
  grants: (
    database.database.prepare('SELECT COUNT(*) AS count FROM grants').get() as {
      readonly count: number;
    }
  ).count,
  requests: (
    database.database.prepare('SELECT COUNT(*) AS count FROM inference_requests').get() as {
      readonly count: number;
    }
  ).count,
});

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
      const issued = await control.issueV2({
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
      const issued = await control.issueV2({
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
        control.issueV2({
          jobId: 'job-delayed',
          snapshot,
          latestIssueDeadline: now,
        }),
      ).resolves.toEqual({ kind: 'deadline-exceeded' });
      await expect(
        control.issueV2({
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
        control.issueV2({ jobId: 'job-duplicate', snapshot, latestIssueDeadline: deadline }),
        control.issueV2({
          jobId: 'job-duplicate',
          snapshot: { routes: ['other-review'] },
          latestIssueDeadline: deadline,
        }),
      ]);

      expect(results.map((result) => result.kind).sort()).toEqual(['duplicate', 'issued']);
      await expect(
        control.issueV2({
          jobId: 'job-duplicate',
          snapshot,
          latestIssueDeadline: (await d1Now(database)) + 60_000,
        }),
      ).resolves.toEqual({ kind: 'duplicate' });
    } finally {
      database.close();
    }
  });

  it('rejects a snapshot route absent from the trusted catalog', async () => {
    const { database, control } = setup();
    try {
      await expect(
        control.issueV2({
          jobId: 'job-unknown-route',
          snapshot: { routes: ['deepseek-review', 'unknown-review'] },
          latestIssueDeadline: (await d1Now(database)) + 60_000,
        }),
      ).resolves.toEqual({ kind: 'invalid' });
      expect(
        database.database
          .prepare('SELECT COUNT(*) AS count FROM grants WHERE job_id = ?')
          .get('job-unknown-route'),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it('rejects empty, unknown and excess issue properties without mutation', async () => {
    const { database, control } = setup();
    try {
      const before = mutationCounts(database);
      const deadline = (await d1Now(database)) + 60_000;
      await expect(
        control.issueV2({ jobId: '', snapshot, latestIssueDeadline: deadline } as never),
      ).resolves.toEqual({ kind: 'invalid' });
      await expect(
        control.issueV2({
          jobId: 'job-empty-routes',
          snapshot: { routes: [] },
          latestIssueDeadline: deadline,
        } as never),
      ).resolves.toEqual({ kind: 'invalid' });
      await expect(
        control.issueV2({
          jobId: 'job-excess',
          snapshot,
          latestIssueDeadline: deadline,
          extra: true,
        } as never),
      ).resolves.toEqual({ kind: 'invalid' });
      expect(mutationCounts(database)).toEqual(before);
    } finally {
      database.close();
    }
  });

  it('returns only route descriptors from freeze-v2 and persists their profile and limit', async () => {
    const { database, control } = setup();
    try {
      database.database
        .prepare(`UPDATE catalog_routes SET profile = ?, limit_json = ? WHERE route_id = ?`)
        .run('responses', '{"context":100000,"output":8000}', 'deepseek-review');
      const issued = await control.issueV2({
        jobId: 'job-v2',
        snapshot: { routes: ['deepseek-review'] },
        latestIssueDeadline: (await d1Now(database)) + 60_000,
      });
      expect(issued).toMatchObject({
        kind: 'issued',
        descriptors: [
          {
            routeId: 'deepseek-review',
            profile: 'responses',
            limit: { context: 100000, output: 8000 },
          },
        ],
      });
      if (issued.kind !== 'issued') throw new Error('expected an issued grant');
      expect(issued.descriptors).toHaveLength(1);
      expect(issued.descriptors[0]).not.toHaveProperty('upstreamModel');
      expect(issued.descriptors[0]).not.toHaveProperty('credentialAlias');

      const grant = database.database
        .prepare('SELECT route_mapping FROM grants WHERE job_id = ?')
        .get('job-v2') as { readonly route_mapping: string };
      expect(JSON.parse(grant.route_mapping)).toEqual([
        {
          routeId: 'deepseek-review',
          upstreamModel: 'deepseek-review-native',
          providerSlug: 'review-provider',
          credentialAlias: 'default',
          profile: 'responses',
          limit: { context: 100000, output: 8000 },
        },
      ]);
    } finally {
      database.close();
    }
  });

  it('rejects a persisted retired profile instead of defaulting it to chat', async () => {
    const { database, control } = setup();
    try {
      database.database
        .prepare(`UPDATE catalog_routes SET profile = ? WHERE route_id = ?`)
        .run('messages', 'other-review');
      await expect(
        control.issueV2({
          jobId: 'job-retired-profile',
          snapshot: { routes: ['other-review'] },
          latestIssueDeadline: (await d1Now(database)) + 60_000,
        }),
      ).resolves.toEqual({ kind: 'invalid' });
    } finally {
      database.close();
    }
  });
});

describe('Inference Worker grant expiry', () => {
  it('rejects an issued grant at its fixed lifetime without requiring revocation', async () => {
    const { database, control } = setup();
    try {
      const issued = await control.issueV2({
        jobId: 'job-expiry',
        snapshot,
        latestIssueDeadline: (await d1Now(database)) + 60_000,
      });
      if (issued.kind !== 'issued') throw new Error('expected an issued grant');
      await expect(authenticateGrant(database, `Bearer ${issued.token}`)).resolves.toMatchObject({
        jobId: 'job-expiry',
      });

      database.database
        .prepare('UPDATE grants SET expires_at = ? WHERE job_id = ?')
        .run((await d1Now(database)) - 1, 'job-expiry');
      await expect(authenticateGrant(database, `Bearer ${issued.token}`)).resolves.toBeNull();
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
        control.issueV2({
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
        control.issueV2({
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
        control.issueV2({
          jobId: 'job-revoke',
          snapshot,
          latestIssueDeadline: (await d1Now(database)) + 60_000,
        }),
      ).resolves.toEqual({ kind: 'duplicate' });
    } finally {
      database.close();
    }
  });

  it('rejects empty and excess revoke properties without mutation', async () => {
    const { database, control } = setup();
    try {
      const before = mutationCounts(database);
      await expect(control.revoke({ jobId: '' } as never)).resolves.toEqual({ kind: 'invalid' });
      await expect(
        control.revoke({ jobId: 'job-excess-revoke', extra: true } as never),
      ).resolves.toEqual({ kind: 'invalid' });
      expect(mutationCounts(database)).toEqual(before);
    } finally {
      database.close();
    }
  });
});
