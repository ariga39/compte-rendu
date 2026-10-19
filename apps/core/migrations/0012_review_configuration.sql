CREATE TABLE review_configuration (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL,
  selection TEXT
);

INSERT INTO review_configuration (id, revision, selection) VALUES (1, 0, NULL);

ALTER TABLE review_runs ADD COLUMN review_configuration TEXT;
