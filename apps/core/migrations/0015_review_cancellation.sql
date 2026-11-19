PRAGMA foreign_keys = ON;

-- SQLite cannot widen the status CHECK constraints in place. Rename the
-- referenced table first so review_runs follows the rename, then build fresh
-- tables with the cancelled disposition and copy the existing rows verbatim.
ALTER TABLE deliveries RENAME TO deliveries_before_cancellation;

CREATE TABLE deliveries (
  delivery_id TEXT PRIMARY KEY NOT NULL,
  installation_id INTEGER NOT NULL,
  repository_id INTEGER NOT NULL,
  pull_request_number INTEGER NOT NULL,
  base_sha TEXT,
  head_sha TEXT,
  trigger TEXT NOT NULL CHECK (trigger IN ('automatic', 'manual')),
  status TEXT NOT NULL CHECK (
    status IN (
      'claiming', 'ignored', 'awaiting approval', 'rejected',
      'scheduled', 'failed', 'completed', 'superseded', 'cancelled'
    )
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO deliveries (
  delivery_id, installation_id, repository_id, pull_request_number,
  base_sha, head_sha, trigger, status, created_at, updated_at
)
SELECT
  delivery_id, installation_id, repository_id, pull_request_number,
  base_sha, head_sha, trigger, status, created_at, updated_at
FROM deliveries_before_cancellation;

CREATE TABLE review_runs_next (
  run_id TEXT PRIMARY KEY NOT NULL,
  delivery_id TEXT NOT NULL REFERENCES deliveries(delivery_id),
  installation_id INTEGER NOT NULL,
  repository_id INTEGER NOT NULL,
  pull_request_number INTEGER NOT NULL,
  base_sha TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('automatic', 'manual')),
  status TEXT NOT NULL CHECK (
    status IN ('scheduled', 'failed', 'completed', 'superseded', 'cancelled')
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  evidence_key TEXT,
  evidence_status TEXT CHECK (evidence_status IN ('complete', 'incomplete')),
  evidence_size INTEGER,
  evidence_sha256 TEXT,
  evidence_uploaded_at TEXT,
  execution_started_at TEXT,
  submission_completed_at TEXT,
  cleanup_completed_at TEXT,
  runner_job_id TEXT,
  runner_attempt INTEGER,
  comment_id INTEGER,
  publication_claimed_at TEXT,
  check_run_id INTEGER,
  check_setup_status TEXT NOT NULL DEFAULT 'failed'
    CHECK (check_setup_status IN ('pending', 'ready', 'failed')),
  check_setup_claimed_at TEXT,
  runner_cleanup_status TEXT,
  result_received_at TEXT,
  publication_started_at TEXT,
  failure_phase TEXT,
  failure_reason TEXT,
  claimed_at TEXT,
  terminal_at TEXT,
  repository_visibility_snapshot TEXT
    CHECK (repository_visibility_snapshot IN ('private', 'public')),
  legacy_public_verified_at TEXT,
  progress_sequence INTEGER,
  progress_stage TEXT
    CHECK (progress_stage IN ('checkout', 'sandbox', 'agent', 'evidence', 'cleanup')),
  progress_received_at TEXT,
  progress_milestones TEXT,
  base_ref TEXT,
  head_ref TEXT,
  review_decision TEXT CHECK (review_decision IN ('approve', 'request_changes', 'comment')),
  review_configuration TEXT,
  model_usage TEXT,
  failure_http_status INTEGER,
  cancelled_at TEXT,
  cancelled_by_uid INTEGER CHECK (cancelled_by_uid IS NULL OR cancelled_by_uid > 0),
  runner_stop_attempted_at TEXT,
  check_cancel_attempted_at TEXT,
  check_cancel_reconciled_at TEXT
);

INSERT INTO review_runs_next (
  run_id, delivery_id, installation_id, repository_id,
  pull_request_number, base_sha, head_sha, trigger,
  status, created_at, updated_at,
  evidence_key, evidence_status, evidence_size, evidence_sha256, evidence_uploaded_at,
  execution_started_at, submission_completed_at, cleanup_completed_at,
  runner_job_id, runner_attempt, comment_id,
  publication_claimed_at, check_run_id, check_setup_status, check_setup_claimed_at,
  runner_cleanup_status, result_received_at, publication_started_at,
  failure_phase, failure_reason, claimed_at, terminal_at,
  repository_visibility_snapshot, legacy_public_verified_at,
  progress_sequence, progress_stage, progress_received_at, progress_milestones,
  base_ref, head_ref, review_decision, review_configuration, model_usage,
  failure_http_status
)
SELECT
  run_id, delivery_id, installation_id, repository_id,
  pull_request_number, base_sha, head_sha, trigger,
  status, created_at, updated_at,
  evidence_key, evidence_status, evidence_size, evidence_sha256, evidence_uploaded_at,
  execution_started_at, submission_completed_at, cleanup_completed_at,
  runner_job_id, runner_attempt, comment_id,
  publication_claimed_at, check_run_id, check_setup_status, check_setup_claimed_at,
  runner_cleanup_status, result_received_at, publication_started_at,
  failure_phase, failure_reason, claimed_at, terminal_at,
  repository_visibility_snapshot, legacy_public_verified_at,
  progress_sequence, progress_stage, progress_received_at, progress_milestones,
  base_ref, head_ref, review_decision, review_configuration, model_usage,
  failure_http_status
FROM review_runs;

DROP TABLE review_runs;
ALTER TABLE review_runs_next RENAME TO review_runs;

CREATE UNIQUE INDEX review_runs_active_head
  ON review_runs (repository_id, pull_request_number, head_sha)
  WHERE status IN ('scheduled', 'completed');

CREATE INDEX review_runs_active_pr
  ON review_runs (repository_id, pull_request_number, status);

CREATE INDEX review_runs_created_at
  ON review_runs (created_at, run_id);

CREATE INDEX review_runs_cancellation_work
  ON review_runs (cancelled_at, run_id)
  WHERE status = 'cancelled';

DROP TABLE deliveries_before_cancellation;
