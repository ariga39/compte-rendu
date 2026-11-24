-- Operator-selected reasoning efforts. Parameters are protocol-validated,
-- trusted catalog data; browsers only submit route IDs and effort names.
ALTER TABLE catalog_routes ADD COLUMN efforts_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE catalog_sources ADD COLUMN route_efforts TEXT NOT NULL DEFAULT '{}';

-- Shared fallback state is one row per route in this relay D1 database. The
-- generation is advanced only by an explicit Core reset. A state row never
-- applies to a newer generation.
CREATE TABLE route_effort_state (
  route_id TEXT PRIMARY KEY NOT NULL,
  generation INTEGER NOT NULL,
  fallback_at INTEGER NOT NULL,
  reason TEXT NOT NULL
);

-- One client request still settles at most one accounting row. At most two
-- outbound attempts and their bounded observations are kept inline.
ALTER TABLE inference_requests ADD COLUMN effort_name TEXT;
ALTER TABLE inference_requests ADD COLUMN effort_generation INTEGER;
ALTER TABLE inference_requests ADD COLUMN effort_fallback_at INTEGER;
ALTER TABLE inference_requests ADD COLUMN effort_fallback_reason TEXT;
ALTER TABLE inference_requests ADD COLUMN attempt_one TEXT;
ALTER TABLE inference_requests ADD COLUMN attempt_two TEXT;
ALTER TABLE inference_requests ADD COLUMN fallback TEXT
  CHECK (fallback IS NULL OR fallback IN ('switched', 'shared', 'failed'));
ALTER TABLE inference_requests ADD COLUMN fallback_reason TEXT;
