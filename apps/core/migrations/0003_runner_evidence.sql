ALTER TABLE review_runs ADD COLUMN evidence_key TEXT;
ALTER TABLE review_runs ADD COLUMN evidence_status TEXT CHECK (evidence_status IN ('complete', 'incomplete'));
ALTER TABLE review_runs ADD COLUMN evidence_size INTEGER;
ALTER TABLE review_runs ADD COLUMN evidence_sha256 TEXT;
ALTER TABLE review_runs ADD COLUMN evidence_uploaded_at TEXT;
ALTER TABLE review_runs ADD COLUMN execution_started_at TEXT;
ALTER TABLE review_runs ADD COLUMN submission_completed_at TEXT;
ALTER TABLE review_runs ADD COLUMN cleanup_completed_at TEXT;
