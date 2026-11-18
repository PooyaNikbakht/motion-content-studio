const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const P = require("../public/static/parser.js");
const Q = require("../public/static/quality.js");

const PHRASE = P.DEFAULT_START_PHRASE;
const sample = P.parse(fs.readFileSync(__dirname + "/../samples/sample-conversation.txt", "utf8"), { startPhrase: PHRASE });
const codes = (l) => l.map((x) => x.code);

test("the sample passes every check", () => {
  assert.deepEqual(Q.check(sample, { model: "eleven_v3", startPhrase: PHRASE, lang: "en" }), []);
});

test("Eleven v4 allows 10,000 characters per request and flags 10,001", () => {
  assert.deepEqual(Q.check({ chunks: [{ n: 1, text: "a".repeat(10000), chars: 10000 }] }, { model: "eleven_v4" }), []);
  const r = Q.check({ chunks: [{ n: 1, text: "a".repeat(10001), chars: 10001 }] }, { model: "eleven_v4" });
  assert.match(r[0].msg, /Eleven v4.*10,000/);
});

test("chunk over the model limit is an error that names the model", () => {
  const parsed = { chunks: [{ n: 1, text: "a".repeat(5001), chars: 5001 }] };
  const r = Q.check(parsed, { model: "eleven_v3" });
  assert.deepEqual(r.map((x) => [x.code, x.severity, x.target]), [["chunk-limit", "error", "chunk:1"]]);
  assert.match(r[0].msg, /Eleven v3.*5,000/);
  assert.deepEqual(Q.check(parsed, { model: "eleven_multilingual_v2" }), []);
  assert.deepEqual(Q.check(parsed, { model: "eleven_flash_v2_5" }), []);
});

test("missing warm-up phrase", () => {
  const r = Q.check({ chunks: [{ n: 1, text: PHRASE + " ok" }, { n: 2, text: "no phrase here" }] }, { model: "eleven_v3", startPhrase: PHRASE });
  assert.deepEqual(r.map((x) => [x.code, x.target]), [["no-warmup", "chunk:2"]]);
  assert.deepEqual(Q.check({ chunks: [{ n: 2, text: "x" }] }, { model: "eleven_v3", startPhrase: "" }), []);
});

test("empty image, video and cover prompts; duplicate scene numbers", () => {
  const parsed = {
    scenes: [{ number: 1, imagePrompt: "", hasVideo: true, videoPrompt: " " }, { number: 1, imagePrompt: "x" }, { number: 2, imagePrompt: "y" }],
    thumbnail: { prompt: "" },
    reels: [{ id: 1, name: "Reel 01", audio: { text: "t" }, images: [{ label: "R01-01", prompt: "" }], videos: [{ prompt: "" }], cover: { prompt: "" } }],
  };
  const r = Q.check(parsed, {});
  assert.deepEqual(codes(r).sort(), ["duplicate-scene", "empty-cover-prompt", "empty-cover-prompt", "empty-image-prompt", "empty-image-prompt", "empty-video-prompt", "empty-video-prompt"]);
  assert.ok(r.find((x) => x.target === "reel:1:cover"));
  assert.ok(r.find((x) => x.target === "reel:1:video:1"));
});

test("reel missing audio, images and cover", () => {
  const r = Q.check({ reels: [{ id: 2, name: "Reel 02", images: [], videos: [] }] }, {});
  assert.deepEqual(codes(r), ["reel-no-audio", "reel-no-images", "reel-no-cover"]);
});

test("Latin words in Persian narration are flagged, v3 tags and other languages are not", () => {
  const mk = (text) => ({ chunks: [{ n: 1, text }] });
  const fa = (text) => Q.check(mk(text), { lang: "fa" });
  assert.deepEqual(codes(fa("این یک test است")), ["latin-in-persian"]);
  assert.match(fa("این یک test و hello است")[0].msg, /test, hello/);
  assert.deepEqual(fa("[whispers] سلام [short pause] دنیا"), []);
  assert.deepEqual(Q.check(mk("this is English"), { lang: "en" }), []);
  assert.deepEqual(Q.latinWords("a [tag word] b ok"), ["ok"]);
});
