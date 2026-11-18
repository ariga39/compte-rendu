import { expect, it, vi } from 'vitest';

import { runApplicationScheduled } from '../apps/dashboard/src/lib/server/application';
import type { CoreWorkerEnv } from '../apps/core/src/core-worker';
import { SqliteD1Database } from './support/d1-database';

const env = (database: SqliteD1Database): CoreWorkerEnv => ({
  REVIEW_DB: database,
  GITHUB_APP_ID: '1',
  GITHUB_APP_PRIVATE_KEY: 'test-key',
  INFERENCE_RELAY: {
    refreshCatalog: async () => {
      throw new Error('private relay detail');
    },
    catalog: async () => ({
      routes: [],
      lastAttemptAt: null,
      lastSuccessAt: null,
      rejected: 0,
      lastRefreshError: null,
    }),
    issue: async () => ({ kind: 'invalid' }),
    revoke: async () => ({ kind: 'revoked' }),
    usage: async () => null,
  },
});

it('logs a fixed relay failure and still waits for metadata refresh', async () => {
  const database = new SqliteD1Database();
  const events: unknown[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((event) => {
    events.push(event);
  });
  try {
    await runApplicationScheduled({ scheduledTime: Date.now() }, env(database));
    expect(events).toEqual(
      expect.arrayContaining([
        { phase: 'relay', outcome: 'refresh_failed' },
        expect.objectContaining({ phase: 'core', outcome: 'metadata_refresh' }),
      ]),
    );
    expect(JSON.stringify(events)).not.toContain('private relay detail');
  } finally {
    spy.mockRestore();
    database.close();
  }
});

it('keeps a metadata refresh failure visible when the relay refresh is rejected', async () => {
  const database = new SqliteD1Database();
  const events: unknown[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((event) => {
    events.push(event);
  });
  database.database.exec(
    'ALTER TABLE repository_metadata RENAME TO unavailable_repository_metadata',
  );
  try {
    const failure = await runApplicationScheduled(
      { scheduledTime: Date.now() },
      env(database),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeDefined();
    expect(String(failure)).not.toContain('private relay detail');
    expect(events).toEqual(expect.arrayContaining([{ phase: 'relay', outcome: 'refresh_failed' }]));
    expect(JSON.stringify(events)).not.toContain('private relay detail');
  } finally {
    database.database.exec(
      'ALTER TABLE unavailable_repository_metadata RENAME TO repository_metadata',
    );
    spy.mockRestore();
    database.close();
  }
});
