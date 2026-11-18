const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const P = require("../public/static/parser.js");
const M = require("../public/static/media.js");

const parsed = P.parse(fs.readFileSync(__dirname + "/../samples/sample-conversation.txt", "utf8"), { startPhrase: P.DEFAULT_START_PHRASE });
const key = (n) => { const m = M.match(n); return m && m.key; };

test("scene images and videos by number, prefix and extension", () => {
  assert.equal(key("03.png"), "s-3-image");
  assert.equal(key("3.JPG"), "s-3-image");
  assert.equal(key("scene_04.mp4"), "s-4-video");
  assert.equal(key("Scene 4.webp"), "s-4-image");
  assert.equal(key("scene-12.png"), "s-12-image");
  assert.equal(key("image_03.png"), "s-3-image");
  assert.equal(key("04_video.mp4"), "s-4-video");
  assert.equal(key("video_5.webm"), "s-5-video");
  assert.equal(key("/some/dir/07.jpeg"), "s-7-image");
  assert.deepEqual(M.match("03.png"), { key: "s-3-image", media: "image", kind: "scene", ext: "png", scene: 3 });
});

test("reel images, videos and covers", () => {
  assert.equal(key("R01-02.png"), "r-1-image-2");
  assert.equal(key("r1_2.jpg"), "r-1-image-2");
  assert.equal(key("R02-03.webp"), "r-2-image-3");
  assert.equal(key("R01-02.mp4"), "r-1-video-2");
  assert.equal(key("R01-V1.mp4"), "r-1-video-1");
  assert.equal(key("R03-video-2.webm"), "r-3-video-2");
  assert.equal(key("R01-cover.png"), "r-1-cover");
  assert.equal(key("reel_2_cover.jpg"), "r-2-cover");
  assert.equal(key("R01-cover.mp4"), null, "a cover is an image");
  assert.equal(key("R01-V1.png"), null, "a video name with an image extension means nothing");
});

test("the YouTube cover", () => {
  assert.equal(key("cover.png"), "yt-cover");
  assert.equal(key("Thumbnail.JPG"), "yt-cover");
  assert.equal(key("youtube-cover.webp"), "yt-cover");
  assert.equal(key("cover.mp4"), null);
});

test("names that mean nothing", () => {
  ["notes.txt", "photo.png", "IMG_20240101_123.png", "final.mp4", "scene.png", "", ".png", "r.png", "03", "03.gif"].forEach((n) => assert.equal(M.match(n), null, n));
  assert.equal(M.match(undefined), null);
});

test("keys are URL safe and fit the server pattern", () => {
  ["03.png", "scene_04.mp4", "R01-02.png", "R01-V1.mp4", "R01-cover.png", "cover.png"].forEach((n) => assert.match(M.match(n).key, M.KEY_RE, n));
});

test("applies: only targets that exist in the parse", () => {
  const flow = parsed.scenes.find((s) => s.hasVideo), still = parsed.scenes.find((s) => !s.hasVideo);
  assert.equal(M.applies(M.match(String(flow.number) + ".mp4"), parsed), true);
  assert.equal(M.applies(M.match(String(still.number) + ".mp4"), parsed), false, "no animation for that scene");
  assert.equal(M.applies(M.match("99.png"), parsed), false);
  assert.equal(M.applies(M.match("R01-01.png"), parsed), true);
  assert.equal(M.applies(M.match("R01-99.png"), parsed), false);
  assert.equal(M.applies(M.match("R09-01.png"), parsed), false);
  assert.equal(M.applies(M.match("R01-cover.png"), parsed), true);
  assert.equal(M.applies(M.match("cover.png"), parsed), true);
  assert.equal(M.applies(M.match("R01-V1.mp4"), parsed), true);
  assert.equal(M.applies(null, parsed), false);
});

test("limits", () => {
  assert.equal(M.MAX_FILE, 100000000);
  assert.equal(M.MAX_FILES, 200);
});

test("exportPlan: folders, names and the edit list", () => {
  const flow = parsed.scenes.find((s) => s.hasVideo);
  const proj = {
    parsed,
    audio: { 1: { ext: "mp3" }, 2: { ext: "mp3" } }, reelAudio: { 1: { ext: "mp3" } },
    ext: { media: {
      ["s-" + parsed.scenes[0].number + "-image"]: { name: "My Shot.PNG" },
      ["s-" + flow.number + "-image"]: { name: "x.jpg" },
      ["s-" + flow.number + "-video"]: { name: "x.mp4" },
      "r-1-image-1": { name: "a.webp" }, "r-1-video-1": { name: "a.mp4" }, "r-1-cover": { name: "c.png" }, "yt-cover": { name: "t.png" },
    } },
  };
  const full = M.exportPlan(proj);
  const paths = full.files.map((f) => f.path);
  assert.ok(paths.includes("Audio/01_audio.mp3") && paths.includes("Audio/02_audio.mp3"));
  assert.ok(paths.includes("Images/Scene_" + String(parsed.scenes[0].number).padStart(2, "0") + ".png"), "extension comes from the original name, lowercased");
  assert.ok(paths.includes("Video/Scene_" + String(flow.number).padStart(2, "0") + ".mp4"));
  assert.ok(paths.includes("Images/Cover.png"));
  assert.ok(paths.includes("Reels/Reel_01/Reel_01_audio.mp3") && paths.includes("Reels/Reel_01/R01-01.webp") && paths.includes("Reels/Reel_01/R01-video-1.mp4") && paths.includes("Reels/Reel_01/R01-cover.png"));
  assert.deepEqual(full.rows[0], ["order", "scene", "chunk", "audio", "image", "video"]);
  assert.equal(full.rows[1][0], 1);
  assert.equal(full.rows[1][1], "Scene " + String(parsed.scenes[0].number).padStart(2, "0"));
  assert.equal(full.rows[1][2], "01");
  assert.equal(full.rows[1][3], "Audio/01_audio.mp3");
  assert.match(full.rows[1][4], /^Images\/Scene_\d\d\.png$/);
  assert.equal(new Set(paths).size, paths.length, "no duplicate paths");
  assert.deepEqual(full.rows.map((r) => r[0]).slice(1), full.rows.slice(1).map((_, i) => i + 1), "order is 1..n");

  const noVideo = M.exportPlan(proj, { includeVideos: false });
  assert.ok(!noVideo.files.some((f) => /\.(mp4|webm)$/.test(f.path)));
  assert.ok(noVideo.rows.every((r) => !/\.(mp4|webm)$/.test(r[5])));
  const empty = M.exportPlan({ parsed, audio: {}, reelAudio: {}, ext: {} });
  assert.equal(empty.files.length, 0);
  assert.equal(empty.rows.length > 1, true);
});

test("chunkOfScene finds the chunk that holds a scene's narration", () => {
  assert.equal(M.chunkOfScene(parsed.scenes[0], parsed.chunks), 1);
  assert.equal(M.chunkOfScene({ narration: "" }, parsed.chunks), 0);
  assert.equal(M.chunkOfScene({ narration: "not in any chunk at all, truly" }, parsed.chunks), 0);
});

test("usage sums stored originals only", () => {
  assert.deepEqual(M.usage({ ext: { media: { a: { bytes: 10, stored: true }, b: { bytes: 5 }, c: { bytes: 7, stored: true } } } }), { bytes: 17, files: 2 });
  assert.deepEqual(M.usage({}), { bytes: 0, files: 0 });
});

test("fromKey rebuilds the descriptor match() gives, for every key shape", () => {
  ["03.png", "scene_04.mp4", "R01-02.png", "R01-V2.mp4", "R02-cover.png", "cover.png"].forEach((n) => assert.deepEqual(M.fromKey(M.match(n).key), (({ ext, ...d }) => d)(M.match(n)), n));
  assert.equal(M.fromKey("s-x-image"), null);
  assert.equal(M.fromKey("nope"), null);
});

test("serverKey: the stored sk wins, older entries use the item key; newServerKey is unique and a valid key", () => {
  assert.equal(M.serverKey("s-4-image", { sk: "s-3-image-abc12" }), "s-3-image-abc12");
  assert.equal(M.serverKey("s-4-image", { name: "x" }), "s-4-image");
  const a = M.newServerKey("r-1-image-2"), b = M.newServerKey("r-1-image-2");
  assert.notEqual(a, b);
  assert.match(a, /^r-1-image-2-[a-z0-9]{5}$/);
  assert.ok(M.KEY_RE.test(a) && M.KEY_RE.test(M.newServerKey("r-12-video-3")) && M.KEY_RE.test(M.newServerKey("yt-cover")));
  assert.equal(M.newServerKey("s-1-image", () => 0), "s-1-image-00000");
});

test("slotCheck: type by slot kind, empty and over-size files", () => {
  const f = (name, size, type) => ({ name, size, type });
  assert.equal(M.slotCheck(f("a.png", 10, "image/png"), "image"), "");
  assert.equal(M.slotCheck(f("a.webp", 10, ""), "image"), "", "type from the extension when the browser gives none");
  assert.match(M.slotCheck(f("a.mp4", 10, "video/mp4"), "image"), /PNG, JPG or WebP/);
  assert.match(M.slotCheck(f("a.png", 10, "image/png"), "video"), /MP4 or WebM/);
  assert.match(M.slotCheck(f("a.gif", 10, "image/gif"), "image"), /image\/gif/);
  assert.match(M.slotCheck(f("a.mp4", 0, "video/mp4"), "video"), /empty/);
  assert.match(M.slotCheck(f("a.mp4", M.MAX_FILE + 1, "video/mp4"), "video"), /over 100 MB/);
  assert.equal(M.slotCheck(f("a.mp4", M.MAX_FILE, "video/mp4"), "video"), "");
});

test("exportPlan reads the R2 key and the size of each file; orphanList sorts by size", () => {
  const flow = parsed.scenes.find((s) => s.hasVideo);
  const plan = M.exportPlan({ parsed, audio: { 1: { ext: "mp3", bytes: 99 } }, reelAudio: {}, ext: { media: { ["s-" + flow.number + "-video"]: { name: "x.mp4", bytes: 5000, sk: "s-1-video-abcde" } } } });
  const v = plan.files.find((f) => /^Video\//.test(f.path));
  assert.deepEqual(v.from, { type: "media", key: "s-" + flow.number + "-video", sk: "s-1-video-abcde", bytes: 5000 });
  assert.equal(v.bytes, 5000);
  assert.equal(plan.files.find((f) => /^Audio\//.test(f.path)).bytes, 99);
  const o = M.orphanList({ ext: { orphans: { a: { bytes: 5 }, b: { bytes: 50 } } } });
  assert.deepEqual(o.list.map((x) => x.sk), ["b", "a"]);
  assert.equal(o.bytes, 55);
  assert.equal(M.outdatedCount({ ext: { media: { a: { outdated: true }, b: {} } } }), 1);
});
