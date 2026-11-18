#!/usr/bin/env node
// Writes a fresh RECOVERY_KEY and SESSION_SECRET to .local/secrets.txt (git-ignored) and .dev.vars if it has none. Prints no values.
//   npm run gen:recovery            refuses to overwrite an existing .local/secrets.txt
//   npm run gen:recovery -- --force replaces it (and the values in .dev.vars)
// Deploy: npx wrangler secret put RECOVERY_KEY, then SESSION_SECRET, pasting each value from .local/secrets.txt.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";

const force = process.argv.includes("--force");
const file = ".local/secrets.txt";
if (existsSync(file) && !force) { console.error(file + " exists. Use --force to replace it (this changes the recovery key and signs everyone out)."); process.exit(1); }

const recovery = randomBytes(24).toString("base64url");
const session = randomBytes(48).toString("base64url");
mkdirSync(".local", { recursive: true });
writeFileSync(file, `RECOVERY_KEY=${recovery}\nSESSION_SECRET=${session}\n`, { mode: 0o600 });

// Local dev reads .dev.vars; keep it in step.
const dev = ".dev.vars";
const keep = existsSync(dev) ? readFileSync(dev, "utf8").split("\n").filter((l) => l && !/^(RECOVERY_KEY|SESSION_SECRET)=/.test(l)) : [];
writeFileSync(dev, keep.concat([`RECOVERY_KEY=${recovery}`, `SESSION_SECRET=${session}`]).join("\n") + "\n", { mode: 0o600 });
console.log("Wrote " + file + " and " + dev + " (values not shown).");
