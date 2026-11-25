import { describe, expect, it } from 'vitest';
import { createD1ReviewStateStore } from '../apps/core/src/index';
import { SqliteD1Database } from './support/d1-database';

const baseSha = '1111111111111111111111111111111111111111';
const headSha = '2222222222222222222222222222222222222222';

describe('Check delivery retry removal migration', () => {
  it('drops durable Check work and cancellation retry state without losing runs', async () => {
    const database = new SqliteD1Database('core', '0018_effort_configuration.sql');
    database.database.exec(`
      INSERT INTO deliveries (
        delivery_id, installation_id, repository_id, pull_request_number,
        base_sha, head_sha, trigger, status, created_at, updated_at
      ) VALUES (
        'historical-delivery', 7, 11, 42,
        '${baseSha}', '${headSha}', 'automatic', 'completed',
        '2026-11-19T00:00:00.000Z', '2026-11-19T00:00:00.000Z'
      );
      INSERT INTO review_runs (
        run_id, delivery_id, installation_id, repository_id,
        pull_request_number, base_sha, head_sha, trigger, status,
        check_run_id, check_setup_status, check_cancel_attempted_at,
        check_cancel_reconciled_at, created_at, updated_at
      ) VALUES (
        'historical-run', 'historical-delivery', 7, 11, 42,
        '${baseSha}', '${headSha}', 'automatic', 'completed',
        321, 'ready', '2026-11-19T00:00:02.000Z',
        '2026-11-19T00:00:03.000Z', '2026-11-19T00:00:00.000Z',
        '2026-11-19T00:00:01.000Z'
      );
      INSERT INTO review_check_deliveries (
        run_id, check_run_id, status, created_at, attempted_at, confirmed_at
      ) VALUES (
        'historical-run', 321, 'pending', '2026-11-19T00:00:02.000Z',
        '2026-11-19T00:00:02.000Z', NULL
      );
    `);

    try {
      database.migrateThrough('0019_remove_check_delivery_retries.sql');
      const db = database.database;
      expect(
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get('review_check_deliveries'),
      ).toBeUndefined();
      expect(
        db
          .prepare('PRAGMA table_info(review_runs)')
          .all()
          .map((column) => (column as { name: string }).name),
      ).not.toEqual(
        expect.arrayContaining(['check_cancel_attempted_at', 'check_cancel_reconciled_at']),
      );
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

      const store = createD1ReviewStateStore(database);
      await expect(store.getRunOutcome('historical-run')).resolves.toMatchObject({
        status: 'completed',
        checkRunId: 321,
      });
    } finally {
      database.close();
    }
  });
});
