// The Input format guide's template must parse to exactly what the guide documents.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const P = require("../public/static/parser.js");
const T = require("../public/static/format-template.js");

test("template: parses to the documented counts with no warnings", () => {
  const r = P.parse(T.buildTemplate(P.DEFAULT_START_PHRASE));
  const e = T.EXPECTED;
  assert.equal(r.stats.audioChunks, e.audioChunks);
  assert.equal(r.stats.imageScenes, e.imageScenes);
  assert.equal(r.stats.animations, e.animations);
  assert.equal(r.stats.reels, e.reels);
  assert.equal(r.stats.reelAudio, e.reelAudio);
  assert.equal(!!r.thumbnail, e.thumbnail);
  assert.equal(r.warnings.length, e.warnings);
});

test("template: publishing text and the reel's cover, video and images are found", () => {
  const r = P.parse(T.buildTemplate(P.DEFAULT_START_PHRASE));
  assert.ok(r.coverHeadline && r.youtubeTitle && r.caption);
  const reel = r.reels[0];
  assert.ok(reel.cover && reel.cover.prompt);
  assert.equal(reel.videos.length, 1);
  assert.equal(reel.images.length, 3);
  assert.ok(reel.coverHeadline && reel.caption);
});

test("template: works with a custom start phrase", () => {
  const r = P.parse(T.buildTemplate("Welcome back"), { startPhrase: "Welcome back" });
  assert.equal(r.stats.audioChunks, 2);
  assert.equal(r.stats.reelAudio, 1);
});

test("guide page loads the shared template and the parser, and the demo copy is not needed", () => {
  const html = fs.readFileSync(path.join(__dirname, "../public/format/index.html"), "utf8");
  assert.match(html, /\/static\/format-template\.js/);
  assert.match(html, /\/static\/parser\.js/);
  assert.ok(!/—/.test(html), "no em dashes");
});
