-- Retain the provider's model entry alongside the trusted route mapping.
-- Consumers map only OpenCode-supported model information from it; the stored
-- entry never supplies transport settings, credentials or route identity.
ALTER TABLE catalog_routes ADD COLUMN metadata_json TEXT;

-- Distinguish provider-advertised limits (mutable metadata) from an operator's
-- explicit allowlist limit (part of the trusted, immutable route mapping).
ALTER TABLE catalog_routes ADD COLUMN limit_source TEXT
  CHECK (limit_source IS NULL OR limit_source IN ('explicit', 'discovered'));

-- Releases before this migration only stored limits supplied by explicit
-- configuration, so existing non-NULL values keep their trusted semantics.
UPDATE catalog_routes SET limit_source = 'explicit' WHERE limit_json IS NOT NULL;
