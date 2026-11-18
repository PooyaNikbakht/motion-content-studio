const test = require("node:test");
const assert = require("node:assert/strict");
const O = require("../public/static/overview.js");

const scenes = [{ number: 1, hasVideo: false }, { number: 2, hasVideo: true }];
const reel = { id: 1, name: "Reel 01", images: [{}, {}], videos: [{}], cover: { prompt: "c" }, audio: { text: "t" } };
const base = () => ({
  status: "draft", createdAt: 1, updatedAt: 2,
  parsed: { chunks: [{ n: 1 }, { n: 2 }], scenes, thumbnail: { prompt: "t" }, reels: [reel] },
  progress: {}, reelProgress: {}, audio: {}, reelAudio: {}, info: {},
});
const done = () => {
  const p = base();
  p.audio = { 1: {}, 2: {} };
  p.progress = { 1: { image: true, audio: true }, 2: { image: true, video: true, audio: true } };
  p.thumbnailDone = true;
  p.reelProgress = { 1: { img1: true, img2: true, vid1: true, cover: true } };
  p.reelAudio = { 1: {} };
  return p;
};

test("checklist lists only things that exist and counts them", () => {
  const c = O.checklist(base());
  assert.deepEqual(c.map((x) => x.id), ["yt-narration", "yt-images", "yt-videos", "yt-scene-audio", "yt-cover", "reel-images", "reel-videos", "reel-covers", "reel-audio"]);
  assert.deepEqual(c.find((x) => x.id === "yt-videos"), { id: "yt-videos", group: "YouTube", label: "Scene videos", done: 0, total: 1, pct: 0 });
  assert.deepEqual(O.checklist({ parsed: null }), []);
  assert.deepEqual(O.checklist({ parsed: { chunks: [], scenes: [], reels: [] } }), []);
});

test("suggestReady is true only when every item is ticked", () => {
  assert.equal(O.suggestReady(base()), false);
  assert.equal(O.suggestReady(done()), true);
  const p = done(); p.reelAudio = {};
  assert.equal(O.suggestReady(p), false);
  const q = done(); q.audio = { 1: {} };
  assert.equal(O.suggestReady(q), false);
  assert.equal(O.suggestReady({ parsed: null }), false);
});

test("validUrl accepts empty and https only", () => {
  assert.equal(O.validUrl(""), true);
  assert.equal(O.validUrl("https://youtu.be/x"), true);
  for (const bad of ["http://x.com", "javascript:alert(1)", "youtube.com/x", "ftp://a.b", "data:text/html,x"]) assert.equal(O.validUrl(bad), false, bad);
});

test("html shows the banner only when ready is suggested and status is below Ready, and escapes values", () => {
  assert.match(O.html(done()), /id="ov-ready">/);
  assert.match(O.html(base()), /id="ov-ready" hidden/);
  const r = done(); r.status = "ready";
  assert.match(O.html(r), /id="ov-ready" hidden/);
  const p = done(); p.info = { title: '"><script>x</script>', reels: [{ id: 1, url: "https://x.test/r", platform: "tiktok" }] };
  const h = O.html(p);
  assert.ok(!h.includes("<script>"));
  assert.match(h, /value="https:\/\/x.test\/r"/);
  assert.ok(!/<select|<option/i.test(h), "no native selects");
  assert.match(h, /id="ov-status"/);
  assert.match(h, /id="ov-rp-1"/);
});

test("normalizeInfo fills every field and keeps reel links", () => {
  assert.deepEqual(O.normalizeInfo(null), { title: "", channel: "", notes: "", youtubeUrl: "", publishDate: "", reels: [] });
  assert.deepEqual(O.normalizeInfo({ title: 5, reels: [{ id: 2, url: "https://a.b" }, null] }).reels, [{ id: 2, url: "https://a.b", platform: "instagram" }]);
});
