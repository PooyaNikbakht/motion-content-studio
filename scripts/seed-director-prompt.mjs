#!/usr/bin/env node
// Loads your own Master Director Prompt into the vault (Setup > Master Director Prompt) from a git-ignored file.
//
//   MBS_PASSWORD=... node scripts/seed-director-prompt.mjs                 local: wrangler dev on http://localhost:8799
//   MBS_PASSWORD=... node scripts/seed-director-prompt.mjs --file path     another file (default .local/master-prompt.txt)
//   MBS_PASSWORD=... node scripts/seed-director-prompt.mjs --base URL      another local origin
//   MBS_PASSWORD=... node scripts/seed-director-prompt.mjs --remote --base https://your-app.example.com
//                                                                          the deployed app (deploy stage; needs the live password)
//
// It logs in like the browser does (POST /login, same-origin headers), PUTs the text as both the current text and your
// default (so "Reset to default" works), then reads it back and compares. It prints only the length and a SHA-256, never the text.
// The text is never written anywhere else: keep the file under .local/ (git-ignored).
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
const remote = args.includes("--remote");
const file = opt("--file", ".local/master-prompt.txt");
const base = opt("--base", remote ? "" : "http://localhost:8799").replace(/\/$/, "");
const password = process.env.MBS_PASSWORD;

const die = (m) => { console.error(m); process.exit(1); };
if (!base) die("--remote needs --base https://your-app-origin");
if (remote && !/^https:\/\//.test(base)) die("--remote needs an https:// --base");
if (!remote && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) die("Without --remote the base must be a local address. Use --remote for a deployed app.");
if (!password) die("Set MBS_PASSWORD (the password you created on /login).");

const text = await readFile(file, "utf8").catch(() => die("Cannot read " + file));
if (!text.trim()) die(file + " is empty.");
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");

const login = await fetch(base + "/login", {
  method: "POST", redirect: "manual",
  headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: base },
  body: new URLSearchParams({ password }),
});
const cookie = (login.headers.getSetCookie ? login.headers.getSetCookie() : []).map((c) => c.split(";")[0]).join("; ");
if (![302, 303].includes(login.status) || !cookie) die("Login failed (" + login.status + "). Check MBS_PASSWORD and that the app is running at " + base + ".");

const headers = { Cookie: cookie, Origin: base, "X-MBS": "1" };
const put = await fetch(base + "/api/settings/director-prompt", { method: "PUT", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ text, defaultText: text }) });
if (!put.ok) die("The server did not take the prompt (" + put.status + ").");

const got = await (await fetch(base + "/api/settings/director-prompt", { headers })).json();
const ok = got.text === text && got.defaultText === text;
console.log(JSON.stringify({ target: remote ? "remote" : "local", file: { length: text.length, sha256: sha(text) }, vault: { length: got.text.length, defaultLength: got.defaultText.length, sha256: sha(got.text) }, match: ok }));
if (!ok) process.exit(2);
