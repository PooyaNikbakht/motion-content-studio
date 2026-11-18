const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const P = require("../public/static/parser.js");

const sample = fs.readFileSync(path.join(__dirname, "../samples/sample-conversation.txt"), "utf8");

test("sample: stats", () => {
  const r = P.parse(sample);
  assert.deepEqual(r.stats, { audioChunks: 6, imageScenes: 8, animations: 3, reels: 3, reelAudio: 3 });
  assert.deepEqual(r.warnings, []);
});

test("sample: chunks come from the Audio chunk labels (no phrase) and stop at markers", () => {
  const r = P.parse(sample);
  r.chunks.forEach((c, i) => {
    assert.equal(c.n, i + 1);
    assert.ok(!P.fold(c.text).startsWith(P.fold(P.DEFAULT_START_PHRASE)), "no warm-up phrase in the sample");
    assert.ok(!c.text.includes("```"));
    assert.ok(!c.text.includes("---"));
    assert.ok(!c.text.includes("Director"));
    assert.ok(!c.text.includes("**"));
    assert.equal(c.chars, [...c.text].length);
  });
  assert.ok(r.chunks[0].text.includes("\n\n"), "multi-paragraph chunk kept together");
});

test("sample: scenes, Persian digits, narration and English prompts", () => {
  const r = P.parse(sample);
  assert.deepEqual(r.scenes.map((s) => s.number), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.ok(r.scenes[0].narration.startsWith("The water lies"));
  assert.ok(!r.scenes[0].narration.includes('"'));
  assert.match(r.scenes[1].imagePrompt, /^Interior of a lighthouse/);
  assert.ok(r.scenes.every((s) => !/[؀-ۿ]/.test(s.imagePrompt)));
});

test("sample: video prompts only for chosen scenes", () => {
  const r = P.parse(sample);
  assert.deepEqual(r.scenes.filter((s) => s.hasVideo).map((s) => s.number), [2, 5, 8]);
  assert.match(r.scenes[1].videoPrompt, /Slow push-in/);
  assert.equal(r.scenes[0].videoPrompt, "");
});

test("sample: thumbnail", () => {
  const r = P.parse(sample);
  assert.match(r.thumbnail.prompt, /lighthouse beam/);
  assert.equal(r.reelIdeas, undefined);
});

test("sample: Step 6 reels stay apart from the main video", () => {
  const r = P.parse(sample);
  assert.deepEqual(r.reels.map((x) => [x.id, x.name]), [[1, "Reel 01"], [2, "Reel 02"], [3, "Reel 03"]]);
  r.reels.forEach((x) => {
    assert.ok(!P.fold(x.audio.text).startsWith(P.fold(P.DEFAULT_START_PHRASE)));
    assert.ok(!x.audio.text.includes("```"));
    assert.equal(x.images.length >= 3, true);
    assert.equal(x.audio.chars, [...x.audio.text].length);
    assert.ok(x.images.length >= 3 && x.images.length <= 4);
    x.images.forEach((i) => { assert.match(i.prompt, /9:16/); assert.ok(i.narration); assert.ok(!/[؀-ۿ]/.test(i.prompt)); });
    assert.match(x.video.prompt, /^Vertical 9:16/);
    assert.equal(x.video, x.videos[0]);
  });
  assert.deepEqual(r.reels.map((x) => x.images.length), [3, 4, 3]);
  assert.deepEqual(r.reels.map((x) => x.videos.length), [1, 2, 1]);
  assert.deepEqual(r.reels[0].images.map((i) => i.label), ["R01-01", "R01-02", "R01-03"]);
  assert.deepEqual(r.reels[1].images.map((i) => i.label), ["R02-01", "R02-02", "R02-03", "R02-04"]);
  assert.deepEqual(r.reels[1].images.map((i) => i.n), [1, 2, 3, 4]);
  assert.match(r.reels[1].videos[1].prompt, /switches off/);
  assert.equal(r.chunks.length, 6);
  assert.equal(r.scenes.length, 8);
  assert.ok(r.chunks.every((c) => !c.text.includes("Reel")));
  assert.ok(r.scenes.every((s) => !/9:16/.test(s.imagePrompt)));
  assert.equal(r.stats.animations, 3);
});

test("Step 6: explicit Reel Scene Number labels and several video prompts", () => {
  const text = "# Step 6 Reels and Shorts\n\nReel 02\nسلام الف\n\nReel Scene Number: [R02-05]\nNarration Part: x\nImage Prompt:\n```\nA 9:16\n```\nImage Prompt:\n```\nB 9:16\n```\n"
    + "Video Prompt 1:\n```\nV1 9:16\n```\nVideo Prompt 2:\n```\nV2 9:16\n```\n";
  const r = P.parse(text, { startPhrase: "سلام" });
  const x = r.reels[0];
  assert.deepEqual(x.images.map((i) => [i.label, i.n]), [["R02-05", 5], ["R02-02", 2]]);
  assert.deepEqual(x.videos.map((v) => v.prompt), ["V1 9:16", "V2 9:16"]);
  assert.equal(x.video.prompt, "V1 9:16");
});

test("splitWarmup", () => {
  const ph = "امروز هوا خیلی آرومه";
  const t = "امروز هوا خیلی آرومه. یک شب، مارتا";
  const s = P.splitWarmup(t, ph);
  assert.equal(s.warm, "امروز هوا خیلی آرومه. ");
  assert.equal(s.rest, "یک شب، مارتا");
  assert.equal(s.warm + s.rest, t);
  assert.equal(P.splitWarmup("امروز هوا خیلی آروم‌ه، ادامه", ph).rest, "ادامه");
  assert.deepEqual(P.splitWarmup("یک شب. " + ph, ph), { warm: "", rest: "یک شب. " + ph });
  assert.deepEqual(P.splitWarmup("abc", ""), { warm: "", rest: "abc" });
  assert.deepEqual(P.splitWarmup("", ph), { warm: "", rest: "" });
  assert.deepEqual(P.splitWarmup(ph, ph), { warm: ph, rest: "" });
  assert.equal(P.splitWarmup("  Hello world, then", "hello WORLD").rest, "then");
});

test("Step 6 tolerates Persian headings, digits and no step number", () => {
  const phrase = "سلام";
  const text = "سلام اصلی\n\n## ریلز و شورتز\n\n**ریل ۱**\nسلام یک\n**Image Prompt:**\n```\nA 9:16 a\n```\nشات ۲\n```\nA 9:16 b\n```\n```\nA 9:16 c\n```\n**Video Prompt:**\n```\nV 9:16\n```\n\n**ریل ۲**\nسلام دو\n";
  const r = P.parse(text, { startPhrase: phrase });
  assert.equal(r.chunks.length, 1);
  assert.equal(r.reels.length, 2);
  assert.equal(r.reels[0].audio.text, "سلام یک");
  assert.deepEqual(r.reels[0].images.map((i) => i.prompt), ["A 9:16 a", "A 9:16 b", "A 9:16 c"]);
  assert.equal(r.reels[0].video.prompt, "V 9:16");
  assert.equal(r.reels[1].images.length, 0);
  assert.equal(r.reels[1].video, null);
  assert.ok(r.warnings.some((w) => /Reel 02 has no vertical animation/.test(w)));
  const t2 = P.parse("سلام اصلی\n\n# مرحله ۶\n\nReel 1\nسلام الف\nReel 03\nسلام ب", { startPhrase: phrase });
  assert.deepEqual(t2.reels.map((x) => x.id), [1, 3]);
  assert.equal(t2.chunks.length, 1);
});

test("no Step 6: no reels, step 5 thumbnail still parses", () => {
  const r = P.parse("## Step 5\nThumbnail prompt:\n```\nT 16:9\n```\n**Reel 1:** Title\n**Cover Prompt:**\n```\nx\n```\n");
  assert.equal(r.reels.length, 0);
  assert.equal(r.thumbnail.prompt, "T 16:9");
});

test("custom start phrase and English content", () => {
  const text = "Welcome back. Tonight is quiet.\n\nWelcome back. Second part here.\nMore text.\n\n---\nWelcome back, third.";
  const r = P.parse(text, { startPhrase: "Welcome back" });
  assert.equal(r.chunks.length, 3);
  assert.equal(r.chunks[1].text, "Welcome back. Second part here.\nMore text.");
});

test("tolerant: ZWNJ, Arabic letter forms, bold, quote marker", () => {
  const withZwnj = "> **امروز هوا خیلی آروم‌ه** و کتاب باز شد\n\nادامه";
  const r = P.parse(withZwnj, { startPhrase: "امروز هوا خیلی آرومه" });
  assert.equal(r.chunks.length, 1);
  assert.equal(P.parse("امروز هوا خيلى آرومه. متن", { startPhrase: "امروز هوا خیلی آرومه" }).chunks.length, 1);
});

test("code fences hide chunk phrases and scenes", () => {
  const text = "```\nامروز هوا خیلی آرومه\nScene Number: [01]\n```";
  const r = P.parse(text, { startPhrase: "امروز هوا خیلی آرومه" });
  assert.equal(r.stats.audioChunks, 0);
  assert.equal(r.stats.imageScenes, 0);
  assert.ok(r.warnings.length > 0);
});

test("scene without a fenced block and with Persian digits", () => {
  const text = "Scene Number: [۱۲]\nNarration Part: «سلام دنیا»\nImage Prompt: A red door\n";
  const r = P.parse(text);
  assert.equal(r.scenes[0].number, 12);
  assert.equal(r.scenes[0].narration, "سلام دنیا");
  assert.equal(r.scenes[0].imagePrompt, "A red door");
});

test("animation listed without a prompt warns", () => {
  const text = "Scene Number: [01]\nImage Prompt:\n```\nx\n```\n\n## Step 4\nScenes: 1\n";
  const r = P.parse(text);
  assert.equal(r.stats.animations, 1);
  assert.ok(r.warnings.some((w) => /no Video Prompt/.test(w)));
});

test("empty input", () => {
  const r = P.parse("");
  assert.deepEqual(r.stats, { audioChunks: 0, imageScenes: 0, animations: 0, reels: 0, reelAudio: 0 });
  assert.deepEqual(r.warnings, []);
});

test("detectLanguage", () => {
  assert.equal(P.detectLanguage("امروز هوا خیلی آرومه، چای می‌خوریم"), "fa");
  assert.equal(P.detectLanguage("مرحبا بكم في هذا البرنامج الجميل"), "ar");
  assert.equal(P.detectLanguage("שלום עולם, מה שלומך היום"), "he");
  assert.equal(P.detectLanguage("Hello there"), "en");
  assert.equal(P.detectLanguage(""), "en");
  assert.ok(P.isRtlLang("fa") && !P.isRtlLang("en"));
});

test("demo sample copy matches samples/", () => {
  const copy = fs.readFileSync(path.join(__dirname, "../public/demo/sample-conversation.txt"), "utf8");
  assert.equal(copy, sample);
});

test("Step 6: Reel Cover Prompt per reel (sample, fenced, plain text, label variants, missing)", () => {
  const r = P.parse(sample);
  assert.deepEqual(r.warnings, []);
  r.reels.forEach((x) => { assert.match(x.cover.prompt, /^Vertical 9:16 reel cover/); assert.equal(x.images.every((i) => !/reel cover/.test(i.prompt)), true); });
  const head = "سلام اصلی\n\n# Step 6 Reels\n\nReel ۱\nسلام یک\n";
  const one = (body) => P.parse(head + body, { startPhrase: "سلام" }).reels[0];
  const img = "**Image Prompt:**\n```\nI 9:16\n```\n";
  assert.equal(one("**Reel Cover Prompt:**\n```\nC 9:16\n```\n" + img).cover.prompt, "C 9:16");
  assert.equal(one("**Reel Cover Prompt:**\n```\nC 9:16\n```\n" + img).images.length, 1);
  assert.equal(one("Reel Cover Prompt\n```\nC2\n```\n" + img).cover.prompt, "C2");
  assert.equal(one("**Reel Cover Prompt:** Plain text cover 9:16\n" + img).cover.prompt, "Plain text cover 9:16");
  assert.equal(one("**Reel Cover Prompt (9:16):**\nLine under label\n\n" + img).cover.prompt, "Line under label");
  assert.equal(one(img + "Cover Prompt:\n```\nC3\n```\n").cover.prompt, "C3");
  assert.equal(one(img + "Cover Prompt:\n```\nC3\n```\n").images.length, 1);
  const none = P.parse(head + img, { startPhrase: "سلام" });
  assert.equal(none.reels[0].cover, null);
  assert.ok(none.warnings.some((w) => /Reel 01 has no Reel Cover Prompt/.test(w)));
});

test("sample: Cover Headline, YouTube Title and per-reel captions", () => {
  const r = P.parse(sample);
  assert.equal(r.coverHeadline, "The Boat With No Light");
  assert.match(r.youtubeTitle, /^The Lighthouse Keeper's Ledger: /);
  assert.equal(r.caption, "");
  assert.deepEqual(r.reels.map((x) => x.coverHeadline), ["A Boat Without a Light", "Thirty Years, One Lamp", ""]);
  assert.match(r.reels[0].caption, /^One night/);
  assert.match(r.reels[0].caption, /#audiobook/, "hashtag lines stay in the caption");
  assert.equal(r.reels[1].caption.split("\n").length, 4, "multi-line caption with a blank line is kept");
  assert.equal(r.reels[2].caption, "Forty years in a box. Now, finally, it is being read.", "quotes removed");
  // publishing text does not leak into audio chunks or prompts
  r.reels.forEach((x) => { assert.ok(!/Caption|Headline|#/.test(x.audio.text)); assert.ok(!/Caption|Headline/.test(x.cover.prompt)); });
  assert.deepEqual(r.warnings, []);
});

test("publishing text: label variants, bold, fences, colon forms, Persian digits", () => {
  const t = "## Step 5\n**Cover Headline**： «تیتر ۱۲۳»\n**YouTube Title:**\n```\nMy Title\n```\n"
    + "- Caption: top level\nsecond line\n\nthird\n---\nafter\n";
  const r = P.parse(t);
  assert.equal(r.coverHeadline, "تیتر ۱۲۳");
  assert.equal(r.youtubeTitle, "My Title");
  assert.equal(r.caption, "top level\nsecond line\n\nthird");
  const r2 = P.parse("youtube title: \"Quoted\"\n**Caption 1:** `x`");
  assert.equal(r2.youtubeTitle, "Quoted");
  assert.equal(P.parse("کپشن: سلام\nعنوان یوتیوب: عنوان").caption, "سلام");
  assert.equal(P.parse("کپشن: سلام\nعنوان یوتیوب: عنوان").youtubeTitle, "عنوان");
});

test("publishing text: inside a Reel block it belongs to the reel, outside to the main video; none means empty", () => {
  const t = "Caption: main one\n\n# Step 6 Reels and Shorts\n\nReel 01\nسلام الف\nCaption: for reel 1\nmore\nCover Headline: H1\n\nReel 02\nسلام ب\n**Caption**\n```\nfor reel 2\n```\nYouTube Title: ignored inside reel\n";
  const r = P.parse(t, { startPhrase: "سلام" });
  assert.equal(r.caption, "main one");
  assert.equal(r.youtubeTitle, "");
  assert.equal(r.reels[0].caption, "for reel 1\nmore");
  assert.equal(r.reels[0].coverHeadline, "H1");
  assert.equal(r.reels[1].caption, "for reel 2");
  assert.equal(r.reels[0].audio.text, "سلام الف", "labels end the audio chunk");
  const none = P.parse("امروز هوا خیلی آرومه. متن");
  assert.deepEqual([none.coverHeadline, none.youtubeTitle, none.caption], ["", "", ""]);
});

test("publishing text: Step 5 reel idea captions are not the main caption", () => {
  const r = P.parse("## Step 5\n**Reel 1:** Idea\nCaption: idea caption\n## Step 6 Reels\nReel 01\nسلام\n", { startPhrase: "سلام" });
  assert.equal(r.caption, "");
});

test("duplicated audio chunk and scene numbers: the LATEST version is kept, order and count stay", () => {
  const P = require("../public/static/parser.js");
  const text = [
    "**Audio chunk 1**", "", "Today the sea is very calm. First draft one.", "",
    "**Audio chunk 2**", "", "Today the sea is very calm. Second chunk.", "",
    "**Audio chunk 1**", "", "Today the sea is very calm. Regenerated one.", "",
    "Scene Number: 1", "Narration Part 1: old narration", "Image Prompt: old image", "",
    "Scene Number: 2", "Narration Part 1: two", "Image Prompt: img two", "",
    "Scene Number: 1", "Narration Part 1: new narration", "Image Prompt: new image",
  ].join("\n");
  const r = P.parse(text, { startPhrase: "Today the sea is very calm" });
  assert.deepEqual(r.chunks.map((c) => c.n), [1, 2]);
  assert.match(r.chunks[0].text, /Regenerated one/);
  assert.match(r.chunks[1].text, /Second chunk/);
  assert.deepEqual(r.scenes.map((s) => [s.number, s.narration]), [[1, "new narration"], [2, "two"]]);
  assert.ok(r.warnings.some((w) => /Scene 1 appeared more than once. The latest version is used/.test(w)));
  assert.equal(r.stats.audioChunks, 2);
});
