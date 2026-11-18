-- Original images and videos for a project's visual items (Visual Board, Reels, covers).
-- The bytes are in R2 (binding AUDIO) under r2_key = media/<project>/<key>, the 320 px thumbnail under thumb_key = media/<project>/thumb/<key>.
-- key: s-4-image, s-4-video, r-1-image-2, r-1-video-1, r-1-cover, yt-cover (see public/static/media.js).
CREATE TABLE media (
  project_id   TEXT NOT NULL,
  key          TEXT NOT NULL,
  r2_key       TEXT NOT NULL,
  thumb_key    TEXT,
  name         TEXT NOT NULL,
  content_type TEXT NOT NULL,
  bytes        INTEGER NOT NULL,
  thumb_bytes  INTEGER NOT NULL DEFAULT 0,
  thumb_type   TEXT,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (project_id, key)
);
