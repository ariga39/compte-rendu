ALTER TABLE review_runs ADD COLUMN runner_claim_request_id TEXT;
ALTER TABLE review_runs ADD COLUMN claim_prepared INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX review_runs_claim_request ON review_runs(runner_claim_request_id)
WHERE runner_claim_request_id IS NOT NULL;
