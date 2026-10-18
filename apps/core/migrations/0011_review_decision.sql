ALTER TABLE review_runs ADD COLUMN review_decision TEXT CHECK (review_decision IN ('approve', 'request_changes', 'comment'));
