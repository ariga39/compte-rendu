ALTER TABLE review_runs ADD COLUMN result_received_at TEXT;
ALTER TABLE review_runs ADD COLUMN publication_started_at TEXT;
ALTER TABLE review_runs ADD COLUMN failure_phase TEXT;
ALTER TABLE review_runs ADD COLUMN failure_reason TEXT;
ALTER TABLE review_runs ADD COLUMN claimed_at TEXT;
ALTER TABLE review_runs ADD COLUMN terminal_at TEXT;
ALTER TABLE review_runs ADD COLUMN repository_visibility_snapshot TEXT
  CHECK (repository_visibility_snapshot IN ('private', 'public'));
ALTER TABLE review_runs ADD COLUMN legacy_public_verified_at TEXT;
ALTER TABLE review_runs ADD COLUMN progress_sequence INTEGER;
ALTER TABLE review_runs ADD COLUMN progress_stage TEXT
  CHECK (progress_stage IN ('checkout', 'sandbox', 'agent', 'evidence', 'cleanup'));
ALTER TABLE review_runs ADD COLUMN progress_received_at TEXT;
ALTER TABLE review_runs ADD COLUMN progress_milestones TEXT;

CREATE TABLE repository_metadata (
  installation_id INTEGER NOT NULL,
  repository_id INTEGER NOT NULL,
  full_name TEXT,
  visibility TEXT NOT NULL DEFAULT 'unknown'
    CHECK (visibility IN ('public', 'private', 'unknown')),
  verified_at TEXT,
  identity_expires_at TEXT,
  next_refresh_at TEXT,
  refresh_claimed_at TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, repository_id)
);

CREATE INDEX repository_metadata_due
  ON repository_metadata (next_refresh_at, installation_id, repository_id);

CREATE TABLE dashboard_refresh_cooldown (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  next_allowed_at TEXT NOT NULL
);

CREATE INDEX review_runs_created_at
  ON review_runs (created_at, run_id);
