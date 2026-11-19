import { describe, expect, it } from 'vitest';
import { SqliteD1Database } from './support/d1-database';

const baseSha = '1111111111111111111111111111111111111111';
const headSha = '2222222222222222222222222222222222222222';

describe('cancellation migration', () => {
  it('upgrades existing runs and deliveries without losing rows or uniqueness rules', () => {
    const database = new SqliteD1Database([
      '0001_review_state.sql',
      '0002_allow_manual_retry.sql',
      '0003_runner_evidence.sql',
      '0004_runner_admission.sql',
      '0005_publication_claim.sql',
      '0006_review_check_runs.sql',
      '0007_check_setup_lease.sql',
      '0008_runner_cleanup.sql',
      '0009_dashboard_lifecycle.sql',
      '0010_review_branch_refs.sql',
      '0011_review_decision.sql',
      '0012_review_configuration.sql',
      '0013_model_usage.sql',
      '0014_failure_http_status.sql',
    ]);
    const legacyRunId = 'legacy-before-cancellation';
    database.database.exec(`
      INSERT INTO deliveries (
        delivery_id, installation_id, repository_id, pull_request_number,
        base_sha, head_sha, trigger, status, created_at, updated_at
      ) VALUES (
        'legacy-delivery', 7, 11, 42,
        '${baseSha}', '${headSha}', 'automatic', 'scheduled',
        '2026-11-19T00:00:00.000Z', '2026-11-19T00:00:00.000Z'
      );
      INSERT INTO review_runs (
        run_id, delivery_id, installation_id, repository_id,
        pull_request_number, base_sha, head_sha, trigger,
        status, created_at, updated_at
      ) VALUES (
        '${legacyRunId}', 'legacy-delivery', 7, 11, 42,
        '${baseSha}', '${headSha}', 'automatic', 'scheduled',
        '2026-11-19T00:00:00.000Z', '2026-11-19T00:00:00.000Z'
      );
    `);

    try {
      database.applyMigrations(['0015_review_cancellation.sql']);
      const db = database.database;
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(
        db
          .prepare('SELECT delivery_id, status, cancelled_at FROM review_runs WHERE run_id = ?')
          .get(legacyRunId),
      ).toMatchObject({
        delivery_id: 'legacy-delivery',
        status: 'scheduled',
        cancelled_at: null,
      });
      const duplicate = db.prepare(
        "INSERT INTO review_runs (run_id,delivery_id,installation_id,repository_id,pull_request_number,base_sha,head_sha,trigger,status,created_at,updated_at) SELECT 'replacement',delivery_id,installation_id,repository_id,pull_request_number,base_sha,head_sha,trigger,'scheduled',created_at,updated_at FROM review_runs WHERE run_id = ?",
      );
      expect(() => duplicate.run(legacyRunId)).toThrow(/UNIQUE/);
      db.prepare(
        "UPDATE review_runs SET status='cancelled', cancelled_by_uid=1001 WHERE run_id=?",
      ).run(legacyRunId);
      db.exec("UPDATE deliveries SET status='cancelled' WHERE delivery_id='legacy-delivery'");
      expect(duplicate.run(legacyRunId).changes).toBe(1);
    } finally {
      database.close();
    }
  });
});
