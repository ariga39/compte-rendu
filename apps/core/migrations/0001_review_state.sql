PRAGMA foreign_keys = ON;

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
      'scheduled', 'failed', 'completed', 'superseded'
    )
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE approvals (
  installation_id INTEGER NOT NULL,
  repository_id INTEGER NOT NULL,
  pull_request_number INTEGER NOT NULL,
  base_sha TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, repository_id, pull_request_number, head_sha)
);

CREATE TABLE review_runs (
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
  updated_at TEXT NOT NULL,
  UNIQUE (repository_id, pull_request_number, head_sha)
);

CREATE INDEX review_runs_active_pr
  ON review_runs (repository_id, pull_request_number, status);

CREATE TABLE finding_fingerprints (
  repository_id INTEGER NOT NULL,
  pull_request_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (repository_id, pull_request_number, head_sha, fingerprint)
);
