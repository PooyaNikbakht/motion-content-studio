# Deploy (Cloudflare Workers)

Config is in `wrangler.jsonc`: static assets from `public/`, the Worker runs first for `/app*`, `/login`, `/logout`, `/api/*` and `/s/*`, `workers_dev` and preview URLs are off, `cpu_ms` is 1000 (the daily backup parses the whole database in one pass), and the only route is the custom domain `motioncontent.pooya.website` (zone `pooya.website`). Bindings: D1 `DB`, R2 `AUDIO` and `BACKUP`, a daily Cron Trigger and the `API_LIMIT` rate limit.

Internal names are unchanged on purpose: the D1 database is `motion-books`, and the R2 buckets are `motion-books-audio` and `motion-books-backups`. Renaming them would orphan existing data.

1. Log in once: `npx wrangler login`.
2. Generate and set the secrets (values go to a git-ignored local file, nothing is printed):
   ```bash
   npm run gen:recovery
   npx wrangler secret put RECOVERY_KEY     # paste the value from .local/secrets.txt
   npx wrangler secret put SESSION_SECRET   # paste the value from .local/secrets.txt
   ```
3. Create the resources and put the printed database id into `wrangler.jsonc`:
   ```bash
   npx wrangler d1 create motion-books
   npx wrangler r2 bucket create motion-books-audio
   npx wrangler r2 bucket create motion-books-backups
   ```
4. Apply the migrations remotely (`0001_init` to `0006_project_version`): `npm run db:migrate:remote`.
5. Deploy: `npm run deploy`. The custom domain comes from the `routes` entry; the zone must be on your Cloudflare account.
6. Open `/login` and create the password with `RECOVERY_KEY`.

## Rate limits

Add a Cloudflare rate-limiting rule for `POST /login` on the zone. The in-Worker lockout is best effort (isolate memory), and `API_LIMIT` covers only `/api/*` and `/s/*`.

## Seed the Director Prompt vault

The Director Prompt is never part of the repository. Put it in `.local/master-prompt.txt` (git-ignored), then:

```bash
MBS_PASSWORD=... node scripts/seed-director-prompt.mjs                      # local wrangler dev
MBS_PASSWORD=... node scripts/seed-director-prompt.mjs --remote --base https://your-app
```

It loads the file through the running app and prints only the length and a SHA-256. You can also paste it in Setup.

## Checklist

- `DEV_LOGIN` must not be set anywhere in the deployed Worker: `npx wrangler secret list` must not show it and it must not be in `wrangler.jsonc`. See [development](development.md).
- The Workers Paid plan is assumed for `limits.cpu_ms`. On Free, a backup pass is limited to 50 subrequests (see [backups](backups.md)).
- A request body to a Worker is capped by the plan (100 MB on Free and Pro), so the 100 MB per-file upload cap sits at that edge limit.
