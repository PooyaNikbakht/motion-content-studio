# Deploy (Cloudflare Workers)

Config is in `wrangler.jsonc`: static assets from `public/`, the Worker runs first for `/app*`, `/login`, `/logout`, `/auth/*`, `/api/*` and `/s/*`, `workers_dev` and preview URLs are off, `cpu_ms` is 1000 (the daily backup parses the whole database in one pass), and the only route is the custom domain `motioncontent.pooya.website` (zone `pooya.website`). Bindings: D1 `DB`, R2 `AUDIO` and `BACKUP`, a daily Cron Trigger and the `API_LIMIT` and `LOGIN_LIMIT` rate limits.

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

## Optional: Sign in with Google

Off by default. The "Continue with Google" button and the `/auth/google` routes exist only when `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `ALLOWED_EMAIL` are all set; otherwise the button is hidden and the routes return 404.

1. In Google Cloud Console open APIs & Services > OAuth consent screen. Choose External. Add your own email as a test user, or publish the app.
2. APIs & Services > Credentials > Create credentials > OAuth client ID > Web application.
3. Authorized redirect URIs: `https://motioncontent.pooya.website/auth/google/callback`, and for local dev `http://127.0.0.1:8799/auth/google/callback`.
4. Set the values (never commit them):
   ```
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   npx wrangler secret put ALLOWED_EMAIL
   ```
   `ALLOWED_EMAIL` may be a comma-separated list, compared case-insensitively. Locally, uncomment the placeholders in `.dev.vars` (see `.dev.vars.example`).

Fallback: the password and recovery key flow is unchanged and always works, so a Google outage or a lost Google account never locks you out. Google sign-in does not create the password: until one exists it shows "Create the password first." because sessions depend on the auth row. It issues the same session cookie as the password flow, so changing or resetting the password signs Google sessions out too.

Security notes: authorization code flow with PKCE (S256), `state` and `nonce` held in a signed, 10 minute, `HttpOnly`, `SameSite=Lax` cookie. The code is exchanged server side with the client secret, and the ID token is read straight from Google over TLS. The Worker checks issuer, audience, expiry, nonce, `email_verified` and the allowed list. Every failure shows the same message ("Google sign-in was not allowed."), and tokens, codes and emails are never logged. `/auth/google` and the callback share the `LOGIN_LIMIT` budget and send `no-store`.

## Rate limits

Every `POST /login` (all actions), `GET /auth/google` and its callback are limited per IP (`CF-Connecting-IP`) by the `LOGIN_LIMIT` Workers Rate Limiting binding in `wrangler.jsonc`: 10 per 60 seconds, then 429 with `Retry-After: 60`, checked before any hashing or D1 work. No dashboard rule is needed. This matters on the Free plan, where the zone has a single WAF rate-limiting rule and it may already be used. The in-Worker lockout (5 misses in 15 minutes, isolate memory) stays as a second layer. `API_LIMIT` (120 per minute) covers `/api/*` and `/s/*`.

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
