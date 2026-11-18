# Testing

## Unit and integration (375 tests)

```bash
npm test
```

Runs Node's built-in test runner on `tests/*.test.js` and `tests/*.test.mjs` (39 files). Coverage includes:

- Parser, diff, progress, tree, overview, project export and import, prompts, quality, queue, estimate, routing, vault, format template.
- Worker: `/api` guards and routes against in-memory D1 and R2 stubs (`api.test.mjs`), auth (`auth.test.mjs`), share links, daily backup.
- Client store and UI: `remote-store.test.js` (uses `fake-indexeddb`), save bar, setup, director, media and other `*-ui.test.js` files.
- Guards: `no-arabic-script.test.js` (no Arabic-script text in public pages), `no-native-select.test.js`.

The `*-ui.test.js` files load the real scripts into jsdom. Point `JSDOM_PATH` at a jsdom install; they skip without it:

```bash
JSDOM_PATH=/path/to/node_modules/jsdom npm test
```

`tests/format.test.js` parses the format guide template with the real parser and expects the documented counts, so update the template and its `EXPECTED` counts together with any parser change. A test also checks that `samples/sample-conversation.txt` matches `public/demo/sample-conversation.txt` (`npm run sync:sample`).

No ElevenLabs or Gemini key is used in tests.

## Browser tests (Playwright)

```bash
npm install
npx playwright install chromium   # once
npm run e2e
```

`npm run e2e` first applies local migrations and clears the local auth row (`scripts/e2e-reset-auth.mjs`, local D1 only), then starts `wrangler dev` on port 8799 (or reuses one) and runs `e2e/` in a desktop (1280x800) and a mobile (360x740) project. Specs cover `/demo`, `/app` sign-in and save flow, media upload and lightbox, and the Setup cards. `/app` specs need `RECOVERY_KEY` in `.dev.vars`; they use throwaway local passwords and leave a known password in local D1, so run them only against local state. The demo pages load Tailwind, fonts and Lucide from CDNs, so they need network access. E2e is not part of `npm test`.

## Not covered

File System Access saving and real ElevenLabs and Gemini calls are checked by hand, as is real Cloudflare CPU time.
