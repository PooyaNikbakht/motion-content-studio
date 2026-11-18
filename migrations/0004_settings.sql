-- Account-level settings for /app (single user). One row per key; value is JSON.
-- director-prompt: { text, defaultText }, written by PUT /api/settings/director-prompt.
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
