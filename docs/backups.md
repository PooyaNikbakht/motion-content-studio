# Backups

A Cron Trigger (`17 3 * * *`, 03:17 UTC) runs `src/backup.js` inside the Worker once a day. It writes to the private R2 bucket `motion-books-backups` (binding `BACKUP`):

- `db/YYYY-MM-DD.json`: every D1 table (projects, folders, media, shares, settings including the Master Prompt, auth hash and salt, found through `sqlite_master`), the latest migration name and row counts. A rerun on the same day overwrites it. Backups older than 30 days are deleted, but the 7 newest always stay.
- `media/<key>`: a copy of every object in the audio and media bucket that is not there yet (same key and size). Each run copies at most 40 objects or about 20 seconds, then continues the next day. Nothing is ever deleted from `media/`, so files removed in the app stay recoverable. If a file is replaced under the same key with a different size, the newer version replaces the copy.
- `status/last-run.json`: time, rows per table, media copied, remaining and failed keys, duration, errors. Setup shows it in the Backups card (`/app` only) with a Run backup now button (`POST /api/backup/run`, one bounded pass, refused within a minute of the last one). `GET /api/backup/status` returns the same file. Logs never contain row contents.

**Restore.** First option: D1 Time Travel (`npx wrangler d1 time-travel restore motion-books --timestamp=<ISO time>`), which rewinds the whole database. Second option, from a file backup:

```bash
npx wrangler r2 object get motion-books-backups/db/2026-11-18.json --file .local/db-2026-11-18.json --remote
node scripts/restore-db-from-backup.mjs .local/db-2026-11-18.json            # writes .local/restore-2026-11-18.sql (git-ignored), prints counts only
npx wrangler d1 execute motion-books --remote --file .local/restore-2026-11-18.sql
```

The SQL uses `INSERT OR REPLACE`; add `--wipe` to empty each table first. Run the migrations first on a fresh database. D1 limits one statement to about 100 KB, so a project with a very large text may need Time Travel instead. Media comes back by copying `media/<key>` to the same key in `motion-books-audio` (`wrangler r2 object get` then `put`).

**Cost.** The cron, the Worker run and the R2 operations stay inside the free Workers and R2 allowances at this size. The media backup roughly doubles stored media and shares the 10 GB R2 free storage with the app files. The first pass copies 40 objects per day, so a large bucket takes several days to catch up. On the Workers Free plan a pass is also limited to 50 subrequests, which stops it after about a dozen objects; the next run continues.
