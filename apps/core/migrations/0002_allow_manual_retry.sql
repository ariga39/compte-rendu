PRAGMA foreign_keys = ON;

CREATE TABLE review_runs_next (
  run_id TEXT PRIMARY KEY NOT NULL,
  delivery_id TEXT NOT NULL REFERENCES deliveries(delivery_id),
  installation_id INTEGER NOT NULL,
  repository_id INTEGER NOT NULL,
  pull_request_number INTEGER NOT NULL,
  base_sha TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('automatic', 'manual')),
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'failed', 'completed', 'superseded')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO review_runs_next (
  run_id, delivery_id, installation_id, repository_id,
  pull_request_number, base_sha, head_sha, trigger,
  status, created_at, updated_at
)
SELECT
  run_id, delivery_id, installation_id, repository_id,
  pull_request_number, base_sha, head_sha, trigger,
  status, created_at, updated_at
FROM review_runs;

DROP TABLE review_runs;
ALTER TABLE review_runs_next RENAME TO review_runs;

CREATE UNIQUE INDEX review_runs_active_head
  ON review_runs (repository_id, pull_request_number, head_sha)
  WHERE status IN ('scheduled', 'completed');

CREATE INDEX review_runs_active_pr
  ON review_runs (repository_id, pull_request_number, status);
