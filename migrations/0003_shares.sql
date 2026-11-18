-- Read-only share links (public GET /s/:token). Only the SHA-256 of the token is stored.
-- One live link per project: creating a new one sets revoked_at on the old one.
CREATE TABLE shares (
  token_hash TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX idx_shares_project ON shares(project_id);
