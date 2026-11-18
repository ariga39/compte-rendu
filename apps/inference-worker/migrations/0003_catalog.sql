CREATE TABLE catalog_refresh (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_attempt INTEGER,
  last_complete INTEGER,
  rejected INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
INSERT INTO catalog_refresh (id) VALUES (1);
