import { describe, expect, it } from 'vitest';
import { createD1ReviewStateStore } from '../apps/core/src/index';
import { SqliteD1Database } from './support/d1-database';

const baseSha = '1111111111111111111111111111111111111111';
const headSha = '2222222222222222222222222222222222222222';

describe('Check delivery migration', () => {
  it('adds pending delivery work without sweeping historical completed Checks', async () => {
    const database = new SqliteD1Database('core', '0016_runner_claim_handoff.sql');
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
        check_run_id, check_setup_status, created_at, updated_at
      ) VALUES (
        'historical-run', 'historical-delivery', 7, 11, 42,
        '${baseSha}', '${headSha}', 'automatic', 'completed',
        321, 'ready', '2026-11-19T00:00:00.000Z', '2026-11-19T00:00:01.000Z'
      );
    `);

    try {
      database.migrateThrough('0017_review_check_delivery.sql');
      const store = createD1ReviewStateStore(database);
      await expect(store.listPendingCheckDeliveries!({ limit: 10 })).resolves.toEqual([]);

      await expect(
        store.claimCheckDelivery!({
          runId: 'historical-run',
          checkRunId: 321,
          occurredAt: '2026-11-19T00:02:00.000Z',
        }),
      ).resolves.toBe(true);
      await expect(store.listPendingCheckDeliveries!({ limit: 10 })).resolves.toEqual([
        { runId: 'historical-run', checkRunId: 321 },
      ]);
      await expect(
        store.confirmCheckDelivery!({
          runId: 'historical-run',
          checkRunId: 321,
          occurredAt: '2026-11-19T00:03:00.000Z',
        }),
      ).resolves.toBe(true);
      await expect(store.listPendingCheckDeliveries!({ limit: 10 })).resolves.toEqual([]);
    } finally {
      database.close();
    }
  });
});
