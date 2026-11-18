-- The single login password (first-run setup, then change/reset). One row, id = 1, so "set once" is the primary key.
-- hash and salt are base64url; hash is PBKDF2-SHA256 of the password with that salt and `iterations`.
-- epoch is part of the signed session cookie: bumping it (change or reset) signs every existing session out.
CREATE TABLE auth (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  hash       TEXT NOT NULL,
  salt       TEXT NOT NULL,
  iterations INTEGER NOT NULL,
  epoch      INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
