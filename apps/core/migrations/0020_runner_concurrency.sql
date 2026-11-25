-- Per-deployment desired Runner concurrency. NULL keeps each Runner's
-- RUNNER_CONCURRENCY startup fallback; a positive integer is delivered to
-- claim responses and authenticated HEAD reads as x-compte-rendu-concurrency.
ALTER TABLE review_configuration ADD COLUMN runner_concurrency INTEGER
  CHECK (runner_concurrency IS NULL OR runner_concurrency > 0);
