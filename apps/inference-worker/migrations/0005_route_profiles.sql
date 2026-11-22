ALTER TABLE catalog_routes ADD COLUMN profile TEXT NOT NULL DEFAULT 'chat';

ALTER TABLE catalog_routes ADD COLUMN limit_json TEXT;

ALTER TABLE catalog_sources ADD COLUMN route_profiles TEXT NOT NULL DEFAULT '{}';

ALTER TABLE catalog_sources ADD COLUMN route_limits TEXT NOT NULL DEFAULT '{}';
