-- Internal, catalog-resolved effort snapshot. The public selection keeps only
-- route IDs and effort names; parameters are frozen here so admission can copy
-- the whole configuration in the same database statement.
ALTER TABLE review_configuration ADD COLUMN effort_snapshot TEXT;

-- Reset generations are per route and advance only through the explicit reset
-- action. Existing selections start at generation 0.
CREATE TABLE review_effort_generations (
  route_id TEXT PRIMARY KEY NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  reset_at TEXT
);
