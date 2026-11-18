const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../public/static/parser.js");
const Q = require("../public/static/quality.js");
const D = require("../public/static/diff.js");

const parse = (t, phrase) => P.parse(t, { startPhrase: phrase === undefined ? "" : phrase });
const texts = (r) => r.chunks.map((c) => [c.n, c.text]);

test("labelled chunks: the code block under each label, numbered by the label", () => {
  const r = parse("## Step 1\n\n**Audio chunk 1**\n\n```\nFirst text.\n\nSecond paragraph.\n```\n\n---\n\n**Audio chunk 2**\n\n```\nSecond chunk.\n```\n");
  assert.deepEqual(texts(r), [[1, "First text.\n\nSecond paragraph."], [2, "Second chunk."]]);
  assert.equal(r.chunks[1].chars, "Second chunk.".length);
  assert.equal(r.stats.audioChunks, 2);
  assert.deepEqual(r.warnings, []);
});

test("labelled chunks: tolerant label forms (colon, no bold, heading, spacing, Persian digits, note before the block)", () => {
  const t = [
    "**Audio chunk 1:**", "```", "a one", "```",
    "Audio chunk 2", "```", "a two", "```",
    "### Audio chunk 3", "```", "a three", "```",
    "**Audio   chunk   ۴**", "", "(about 40 seconds, calm voice)", "", "```", "a four", "```",
    "**Audio chunk ٥:**", "~~~", "a five", "~~~",
  ].join("\n");
  assert.deepEqual(texts(parse(t)), [[1, "a one"], [2, "a two"], [3, "a three"], [4, "a four"], [5, "a five"]]);
});

test("labelled chunks: Persian narration in the block, CRLF line endings, numbers kept as written", () => {
  const t = ["**Audio chunk 2**", "", "```", "سلام دنیا.", "ادامه", "```", "", "**Audio chunk 7**", "```", "x", "```"].join("\r\n");
  const r = parse(t);
  assert.deepEqual(r.chunks.map((c) => c.n), [2, 7]);
  assert.equal(r.chunks[0].text, "سلام دنیا.\nادامه");
  assert.ok(!r.chunks[0].text.includes("\r"));
});

test("labelled chunks: without a code block the plain text up to the next label, heading or scene line", () => {
  const t = "**Audio chunk 1**\nPlain text one.\nStill one.\n\n**Audio chunk 2**\nPlain two.\n\n## Step 2\n\n**Scene Number: [01]**\n**Image Prompt:**\n```\nimg\n```\n";
  const r = parse(t);
  assert.deepEqual(texts(r), [[1, "Plain text one.\nStill one."], [2, "Plain two."]]);
  assert.equal(r.scenes.length, 1);
});

test("labelled chunks: a label with nothing under it is skipped, and a fence far below another section is not stolen", () => {
  const t = "**Audio chunk 1**\n\n## Step 2\n\n**Scene Number: [01]**\n**Image Prompt:**\n```\nimg prompt\n```\n";
  const r = parse(t);
  assert.equal(r.chunks.length, 0);
  assert.equal(r.scenes[0].imagePrompt, "img prompt");
  assert.match(r.warnings.join("|"), /No audio chunks found\. Expected \*\*Audio chunk 1\*\* labels/);
});

test("labelled chunks: a repeated number keeps the latest text", () => {
  const r = parse("**Audio chunk 1**\n```\nold\n```\n**Audio chunk 2**\n```\nb\n```\n**Audio chunk 1**\n```\nnew\n```\n");
  assert.deepEqual(texts(r), [[1, "new"], [2, "b"]]);
});

test("labelled chunks win over the start phrase; the phrase is the fallback for old conversations", () => {
  const labelled = "**Audio chunk 1**\n```\nHello there. Body.\n```\n";
  assert.deepEqual(texts(parse(labelled, "Hello there")), [[1, "Hello there. Body."]]);
  const old = "Hello there. One.\n\n---\n\nHello there. Two.";
  assert.equal(parse(old, "Hello there").stats.audioChunks, 2);
  assert.equal(parse(old, "").stats.audioChunks, 0);
  const oldLabels = "**Audio chunk 1**\n\nHello there. One.\n\n**Audio chunk 2**\n\nHello there. Two.";
  assert.deepEqual(texts(parse(oldLabels, "Hello there")), [[1, "Hello there. One."], [2, "Hello there. Two."]]);
});

const reelText = (audioLines) => ["## Step 6: Reels and Shorts", "", "### Reel 01", ""].concat(audioLines, ["", "**Reel Scene Number: [R01-01]**", "**Image Prompt:**", "```", "Vertical 9:16 a", "```", "", "**Reel Cover Prompt:**", "```", "Vertical 9:16 cover", "```", ""]).join("\n");

test("reel audio: the block under an Audio chunk label (number, parenthesis, colon and bold optional), never counted as an image", () => {
  [["**Audio chunk**", "```", "reel words", "```"], ["Audio chunk:", "```", "reel words", "```"], ["**Audio chunk 1** (about 30 s)", "", "```", "reel words", "```"], ["### Audio chunk ۱", "```", "reel words", "```"]].forEach((a) => {
    const r = parse(reelText(a)).reels[0];
    assert.equal(r.audio && r.audio.text, "reel words", a[0]);
    assert.equal(r.images.length, 1, "the audio block is not an image prompt");
    assert.equal(r.cover.prompt, "Vertical 9:16 cover");
  });
});

test("reel audio: CRLF, a missing block uses the plain text, nothing at all warns, the phrase still works as a fallback", () => {
  assert.equal(parse(reelText(["**Audio chunk**", "```", "crlf text", "```"]).replace(/\n/g, "\r\n")).reels[0].audio.text, "crlf text");
  assert.equal(parse(reelText(["**Audio chunk**", "Plain reel words."])).reels[0].audio.text, "Plain reel words.");
  const none = parse(reelText([]));
  assert.equal(none.reels[0].audio, null);
  assert.ok(none.warnings.some((w) => /Reel 01 has no audio chunk\. Expected an \*\*Audio chunk\*\* label/.test(w)));
  assert.equal(parse(reelText(["Hello there. Reel words."]), "Hello there").reels[0].audio.text, "Hello there. Reel words.");
});

test("main labelled chunks and reel audio together do not mix", () => {
  const t = "**Audio chunk 1**\n```\nmain\n```\n" + reelText(["**Audio chunk**", "```", "reel", "```"]);
  const r = parse(t);
  assert.deepEqual(texts(r), [[1, "main"]]);
  assert.equal(r.reels[0].audio.text, "reel");
  assert.deepEqual(r.stats, { audioChunks: 1, imageScenes: 0, animations: 0, reels: 1, reelAudio: 1 });
});

test("quality: no-warmup is skipped with no phrase and kept when a phrase is set", () => {
  const parsed = { chunks: [{ n: 1, text: "plain text" }] };
  assert.deepEqual(Q.check(parsed, { model: "eleven_v3", startPhrase: "" }), []);
  assert.deepEqual(Q.check(parsed, { model: "eleven_v3" }), []);
  assert.deepEqual(Q.check(parsed, { model: "eleven_v3", startPhrase: "Hello" }).map((x) => x.code), ["no-warmup"]);
});

test("re-parse: label numbers are the chunk keys, so audio and unchanged matching survive an inserted note or a reorder of unrelated text", () => {
  const a = parse("**Audio chunk 1**\n```\none\n```\n**Audio chunk 2**\n```\ntwo\n```\n**Audio chunk 3**\n```\nthree\n```\n");
  const b = parse("Some new intro.\n\n**Audio chunk 1**\n```\none\n```\n**Audio chunk 2**\n```\ntwo EDITED\n```\n**Audio chunk 3**\n```\nthree\n```\n");
  const d = D.diff(a, b);
  assert.deepEqual([d.chunks.unchanged.length, d.chunks.edited.length, d.chunks.added.length, d.chunks.removed.length], [2, 1, 0, 0]);
  assert.equal(d.chunks.edited[0].n.n, 2);
  const carried = D.carry({ audio: { 1: { hash: D.hash("one") }, 2: { hash: D.hash("two") }, 3: { hash: D.hash("three") } } }, d, b);
  assert.equal(carried.audio[1].outdated, undefined);
  assert.equal(carried.audio[2].outdated, true);
  assert.equal(carried.audio[3].outdated, undefined);
  assert.equal(carried.outdated, 1);
});
