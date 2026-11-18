-- Motion Content Studio: server-side storage for /app (the demo never uses it).
-- Projects, folders, progress and project info live in D1; generated audio lives in R2.

CREATE TABLE folders (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  collapsed  INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  folder_id   TEXT,
  lang        TEXT NOT NULL DEFAULT 'auto',
  status      TEXT NOT NULL DEFAULT 'draft',
  text        TEXT NOT NULL DEFAULT '',
  parsed_json TEXT,
  -- { progress, reelProgress, audio, reelAudio } (audio entries are metadata only)
  state_json  TEXT NOT NULL DEFAULT '{}',
  -- { title, channel, notes, youtubeUrl, publishDate, reels: [{ id, url, platform }] }
  info_json   TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  server_at   INTEGER NOT NULL,
  bytes       INTEGER NOT NULL DEFAULT 0
);

-- One row per stored audio object. The bytes are in R2 under r2_key.
CREATE TABLE audio (
  project_id   TEXT NOT NULL,
  key          TEXT NOT NULL,
  r2_key       TEXT NOT NULL,
  bytes        INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (project_id, key)
);

CREATE INDEX idx_projects_folder ON projects(folder_id);
CREATE INDEX idx_projects_updated ON projects(updated_at);
