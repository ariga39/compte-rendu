CREATE TABLE catalog_routes (
  route_id TEXT PRIMARY KEY NOT NULL,
  upstream_model TEXT NOT NULL,
  provider_slug TEXT NOT NULL,
  credential_alias TEXT NOT NULL
);

ALTER TABLE grants ADD COLUMN route_mapping TEXT;

CREATE TABLE inference_requests (
  request_id TEXT PRIMARY KEY NOT NULL,
  job_id TEXT NOT NULL,
  route TEXT NOT NULL,
  model TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'complete', 'incomplete')),
  input_tokens INTEGER,
  uncached_input_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  output_tokens INTEGER,
  reasoning_tokens INTEGER,
  created_at INTEGER NOT NULL,
  finalized_at INTEGER
);

CREATE INDEX inference_requests_job_created
  ON inference_requests (job_id, created_at, request_id);
