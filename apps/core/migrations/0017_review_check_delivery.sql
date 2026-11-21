PRAGMA foreign_keys = ON;

-- Terminal Check delivery is retried independently of the run outcome. Only
-- runs that need a delivery have a row, so existing history is not re-swept.
CREATE TABLE review_check_deliveries (
  run_id TEXT PRIMARY KEY NOT NULL REFERENCES review_runs(run_id),
  check_run_id INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed')),
  created_at TEXT NOT NULL,
  attempted_at TEXT NOT NULL,
  confirmed_at TEXT
);

-- The sweep takes the least recently attempted rows first, so one permanently
-- unavailable Check cannot occupy every bounded batch.
CREATE INDEX review_check_deliveries_pending
  ON review_check_deliveries (attempted_at, created_at, run_id)
  WHERE status = 'pending';
