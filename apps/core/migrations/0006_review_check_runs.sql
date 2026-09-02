ALTER TABLE review_runs ADD COLUMN check_run_id INTEGER;
ALTER TABLE review_runs ADD COLUMN check_setup_status TEXT NOT NULL DEFAULT 'failed'
  CHECK (check_setup_status IN ('pending', 'ready', 'failed'));
