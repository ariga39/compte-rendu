CREATE TABLE grants (
  job_id TEXT PRIMARY KEY NOT NULL,
  token_hash TEXT UNIQUE,
  snapshot TEXT,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  latest_issue_deadline INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE INDEX grants_expires_at
  ON grants (expires_at);
