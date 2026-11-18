# Development

Requires Node 22 (`.nvmrc`); Node 20+ works.

```bash
nvm use
npm install
npm run gen:recovery        # writes RECOVERY_KEY and SESSION_SECRET to .local/secrets.txt and .dev.vars (git-ignored, not printed)
npm run db:migrate:local    # once: creates local D1 tables under .wrangler/state
npm run dev                 # wrangler dev --infer-origin-from-routes=false
```

- Routes: `/`, `/demo`, `/format`, and `/app` (redirects to `/login` until you sign in; on first run `/login` asks you to create the password with `RECOVERY_KEY`). `npm run gen:recovery -- --force` replaces the values. `.dev.vars.example` lists the variables.
- `--infer-origin-from-routes=false` matters: without it wrangler rewrites the request host to the route host, so the localhost-only Dev sign in never shows. The e2e config starts the server on port 8799.
- Local D1 and R2 live under `.wrangler/state` (git-ignored). `wrangler dev` ignores the `database_id` in `wrangler.jsonc` and uses a local database; nothing is created in Cloudflare.
- Never commit `.dev.vars` or anything in `.local/`.

## DEV_LOGIN (local only)

With `DEV_LOGIN=1` in `.dev.vars` and the page opened on `localhost` or `127.0.0.1`, `/login` shows an extra "Dev sign in (local only)" button. It POSTs `action=dev`, creates the password with a fixed local dev password if none exists (no `RECOVERY_KEY` needed), and issues the normal session cookie. With the flag unset or on any other host the button is not rendered and the request returns 404.

**Warning: never set `DEV_LOGIN` as a Worker secret or var, and never put it in `wrangler.jsonc`.** The e2e helpers match the button named exactly "Sign in", so the extra button does not interfere.

## Cache busting

`public/app/index.html` and `public/demo/index.html` load scripts and the stylesheet with a version query string (`?v=...`). Bump it in both files whenever you change anything under `public/static/`, so browsers do not keep serving an old `ui.js` or `parser.js`.

## Project layout

```
src/worker.js            login, logout, session cookie, gate for /app, routes /api/* and /s/*
src/api.js               /api handlers: D1 projects and folders, R2 audio and media, guards
src/share.js             read-only share links
src/auth.js              password hashing and sessions
src/backup.js            daily backup (Cron Trigger)
scripts/                 gen-recovery, seed-director-prompt, restore-db-from-backup, e2e-reset-auth
migrations/              D1 schema (0001 to 0006)
public/index.html        landing page
public/format/           Input format guide page
public/demo/             demo shell and sample conversation copy
public/app/              real app shell (served only after login)
public/static/           client scripts and styles (parser, store, remote-store, ui, audio, estimate, director, gemini, media ...)
samples/                 fictional sample conversation
tests/, e2e/             unit and Playwright tests
wrangler.jsonc           Worker, assets, bindings and domain config
```

CDN libraries are pinned with integrity hashes: Tailwind browser build 4.1.11 (jsDelivr), Lucide 0.469.0 (unpkg), JSZip 3.10.1 (cdnjs). Fonts come from Google Fonts.
