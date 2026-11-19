CREATE TABLE catalog_sources (
  source_key TEXT PRIMARY KEY NOT NULL,
  models TEXT NOT NULL DEFAULT '{}',
  provider TEXT NOT NULL,
  credential TEXT NOT NULL,
  is_alias INTEGER NOT NULL,
  error TEXT,
  rejected INTEGER NOT NULL DEFAULT 0
);
