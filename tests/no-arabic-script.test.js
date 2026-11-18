// Everything a visitor sees in /demo, /format, the landing page and the sample must be free of Arabic-script text.
// Parser regexes still know Persian and Arabic words, written as \uXXXX escapes. Persian fixtures live in tests/ only (not served).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ARABIC = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/;
const root = path.join(__dirname, "..");
// Explicit allowlist (path relative to the repo, with a reason). Empty on purpose: the Vazirmatn font is referenced by its ASCII name.
const ALLOW = [];

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|mjs|html|css|txt|md|json|svg|xml|jsonc|sql)$/.test(e.name)) out.push(p);
  }
  return out;
}

test("public/, src/, samples/ and migrations/ contain no Arabic-script characters", () => {
  const files = ["public", "src", "samples", "migrations"].flatMap((d) => walk(path.join(root, d), []));
  files.push(path.join(root, "wrangler.jsonc"));
  assert.ok(files.length > 20);
  const bad = files.filter((f) => !ALLOW.includes(path.relative(root, f)) && ARABIC.test(fs.readFileSync(f, "utf8"))).map((f) => path.relative(root, f));
  assert.deepEqual(bad, []);
});

test("the demo sample is byte-identical to samples/ and parses clean with the demo phrase", () => {
  const P = require("../public/static/parser.js");
  const a = fs.readFileSync(path.join(root, "samples/sample-conversation.txt"), "utf8");
  assert.equal(fs.readFileSync(path.join(root, "public/demo/sample-conversation.txt"), "utf8"), a);
  const r = P.parse(a);
  assert.deepEqual(r.stats, { audioChunks: 6, imageScenes: 8, animations: 3, reels: 3, reelAudio: 3 });
  assert.deepEqual(r.warnings, []);
  assert.equal(P.DEFAULT_START_PHRASE, "Today the sea is very calm");
  assert.deepEqual(r.reels.map((x) => [x.images.length, x.videos.length]), [[3, 1], [4, 2], [3, 1]]);
});

test("the language names in the UI are English", () => {
  const ui = fs.readFileSync(path.join(root, "public/static/ui.js"), "utf8");
  assert.match(ui, /\["fa", "Persian"\]/);
  assert.match(ui, /\["ar", "Arabic"\]/);
  assert.match(ui, /\["he", "Hebrew"\]/);
});
