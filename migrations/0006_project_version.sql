-- Optimistic concurrency for /app saves. Every write to a project row bumps version; a PUT carries the version it was loaded at
-- (baseVersion) and is refused with 409 when the row has moved on. Existing rows start at 1.
ALTER TABLE projects ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
