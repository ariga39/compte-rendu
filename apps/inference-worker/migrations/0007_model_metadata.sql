-- Retain the provider's model entry alongside the trusted route mapping.
-- Consumers map only OpenCode-supported model information from it; the stored
-- entry never supplies transport settings, credentials or route identity.
ALTER TABLE catalog_routes ADD COLUMN metadata_json TEXT;
