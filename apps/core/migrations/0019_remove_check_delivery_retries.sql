PRAGMA foreign_keys = ON;

-- Terminal and cancellation Check updates are best effort and are not retried
-- from a durable queue. Check creation and its setup lease stay in review_runs.
DROP TABLE review_check_deliveries;

ALTER TABLE review_runs DROP COLUMN check_cancel_attempted_at;
ALTER TABLE review_runs DROP COLUMN check_cancel_reconciled_at;
