const test = require("node:test");
const assert = require("node:assert/strict");
const D = require("../public/static/diff.js");

const chunk = (n, text) => ({ n, text, chars: text.length });
const scene = (number, narration, imagePrompt, videoPrompt = "") => ({ number, narration, imagePrompt, videoPrompt, hasVideo: !!videoPrompt });
const reel = (id, text) => ({ id, name: "Reel " + id, audio: { text }, images: [{ n: 1, prompt: "p" + id }], videos: [] });
const parsed = (chunks, scenes, reels = []) => ({ chunks, scenes, reels, thumbnail: { prompt: "t" } });

test("chunks match by content first, so inserting one renumbers the rest without losing them", () => {
  const a = parsed([chunk(1, "one"), chunk(2, "two"), chunk(3, "three")], []);
  const b = parsed([chunk(1, "new"), chunk(2, "one"), chunk(3, "two"), chunk(4, "three")], []);
  const d = D.diff(a, b);
  assert.deepEqual(d.chunks.unchanged.map((x) => [x.o.n, x.n.n]), [[1, 2], [2, 3], [3, 4]]);
  assert.deepEqual(d.chunks.added.map((x) => x.text), ["new"]);
  assert.deepEqual(D.summarize(d).chunks, { added: 1, edited: 0, removed: 0, unchanged: 3 });
});

test("leftover chunks pair by position as edited, extras are added or removed", () => {
  const a = parsed([chunk(1, "keep"), chunk(2, "old two"), chunk(3, "gone")], []);
  const b = parsed([chunk(1, "keep"), chunk(2, "new two")], []);
  const s = D.summarize(D.diff(a, b)).chunks;
  assert.deepEqual(s, { added: 0, edited: 1, removed: 1, unchanged: 1 });
});

test("identical duplicates match one to one", () => {
  const a = parsed([chunk(1, "same"), chunk(2, "same")], []);
  const b = parsed([chunk(1, "same"), chunk(2, "same"), chunk(3, "same")], []);
  assert.deepEqual(D.summarize(D.diff(a, b)).chunks, { added: 1, edited: 0, removed: 0, unchanged: 2 });
});

test("scenes match by content then by number; progress follows unchanged scenes through renumbering and drops edited ones", () => {
  const a = parsed([], [scene(1, "n1", "p1"), scene(2, "n2", "p2"), scene(3, "n3", "p3")]);
  const b = parsed([], [scene(1, "n1", "p1"), scene(2, "n2", "EDITED"), scene(3, "zzz", "new"), scene(4, "n3", "p3")]);
  const d = D.diff(a, b);
  assert.deepEqual(d.scenes.unchanged.map((x) => [x.o.number, x.n.number]), [[1, 1], [3, 4]]);
  assert.deepEqual(d.scenes.edited.map((x) => [x.o.number, x.n.number]), [[2, 2]]);
  assert.deepEqual(d.scenes.added.map((x) => x.number), [3]);
  const proj = { progress: { 1: { image: true }, 2: { image: true, video: true }, 3: { audio: true } }, parsed: a };
  const c = D.carry(proj, d, b);
  assert.deepEqual(c.progress, { 1: { image: true }, 4: { audio: true } });
});

test("reels match by id: unchanged keep ticks, edited lose them, removed vanish", () => {
  const a = parsed([], [], [reel(1, "a"), reel(2, "b"), reel(3, "c")]);
  const b = parsed([], [], [reel(1, "a"), reel(2, "b changed"), reel(4, "d")]);
  const d = D.diff(a, b);
  assert.deepEqual(D.summarize(d).reels, { added: 1, edited: 1, removed: 1, unchanged: 1 });
  const c = D.carry({ reelProgress: { 1: { cover: true }, 2: { img1: true }, 3: { img1: true } }, parsed: a }, d, b);
  assert.deepEqual(c.reelProgress, { 1: { cover: true } });
});

test("audio is kept only for the same number and text; the rest is marked outdated, never dropped", () => {
  const a = parsed([chunk(1, "one"), chunk(2, "two")], [], [reel(1, "r")]);
  const b = parsed([chunk(1, "one"), chunk(2, "two edited")], [], [reel(1, "r")]);
  const proj = { parsed: a, audio: { 1: { hash: D.hash("one") }, 2: { hash: D.hash("two") } }, reelAudio: { 1: { hash: D.hash("r") } } };
  const c = D.carry(proj, D.diff(a, b), b);
  assert.equal(c.audio[1].outdated, undefined);
  assert.equal(c.audio[2].outdated, true);
  assert.equal(c.reelAudio[1].outdated, undefined);
  assert.equal(c.outdated, 1);
  assert.deepEqual(Object.keys(c.audio), ["1", "2"]);
});

test("impact counts ticks, matching audio and published info", () => {
  const a = parsed([chunk(1, "one")], []);
  const p = { parsed: a, progress: { 1: { image: true, audio: true } }, reelProgress: { 1: { cover: true } }, thumbnailDone: true, audio: { 1: { hash: D.hash("one") } }, reelAudio: {}, info: { youtubeUrl: "https://x.test" } };
  assert.deepEqual(D.impact(p), { audio: 1, ticks: 4, published: true });
  assert.deepEqual(D.impact({ parsed: null }), { audio: 0, ticks: 0, published: false });
});

test("no change is detected as no change; first parse is all added; clearing is all removed", () => {
  const a = parsed([chunk(1, "x")], [scene(1, "n", "p")]);
  assert.equal(D.isChange(D.summarize(D.diff(a, JSON.parse(JSON.stringify(a))))), false);
  assert.deepEqual(D.summarize(D.diff(null, a)).chunks, { added: 1, edited: 0, removed: 0, unchanged: 0 });
  assert.deepEqual(D.summarize(D.diff(a, null)).scenes, { added: 0, edited: 0, removed: 1, unchanged: 0 });
});

// ---------- media follows the item through a re-parse ----------
const mk = (name, bytes = 10) => ({ name, bytes, type: "image/png", stored: true });
const withReel = (id, images, videos = 0, cover = true) => ({ id, name: "Reel " + id, audio: { text: "r" + id }, images: Array.from({ length: images }, (_, i) => ({ n: i + 1, prompt: "p" + id + i })), videos: Array.from({ length: videos }, () => ({ prompt: "v" })), cover: cover ? { prompt: "c" + id } : null });

test("media: an unchanged scene keeps its files through renumbering, with the same R2 key (sk)", () => {
  const a = parsed([], [scene(1, "n1", "p1"), scene(2, "n2", "p2", "v2"), scene(3, "n3", "p3")]);
  const b = parsed([], [scene(1, "NEW", "x"), scene(2, "n1", "p1"), scene(3, "n2", "p2", "v2"), scene(4, "n3", "p3")]);
  const d = D.diff(a, b);
  const proj = { ext: { media: { "s-1-image": Object.assign(mk("one.png"), { sk: "s-1-image-aaaaa" }), "s-2-image": mk("two.png"), "s-2-video": mk("two.mp4"), "s-3-image": mk("three.png") } } };
  const c = D.carry(proj, d, b);
  assert.deepEqual(Object.keys(c.media).sort(), ["s-2-image", "s-3-image", "s-3-video", "s-4-image"]);
  assert.equal(c.media["s-2-image"].sk, "s-1-image-aaaaa", "the file kept its R2 object");
  assert.equal(c.media["s-2-image"].name, "one.png");
  assert.equal(c.media["s-3-video"].name, "two.mp4");
  assert.equal(c.media["s-4-image"].name, "three.png");
  assert.equal(c.mediaOrphaned, 0);
  assert.equal(c.mediaOutdated, 0);
  assert.deepEqual(c.orphans, {});
});

test("media: an edited scene keeps its files flagged outdated, a removed scene's files become orphans (never dropped)", () => {
  const a = parsed([], [scene(1, "n1", "p1"), scene(2, "n2", "p2"), scene(3, "n3", "p3")]);
  const b = parsed([], [scene(1, "n1", "p1"), scene(2, "n2", "EDITED")]);
  const d = D.diff(a, b);
  const proj = { ext: { media: { "s-1-image": mk("1.png"), "s-2-image": mk("2.png", 20), "s-3-image": Object.assign(mk("3.png", 30), { sk: "s-3-image-zzzzz" }) } } };
  const c = D.carry(proj, d, b);
  assert.deepEqual(Object.keys(c.media).sort(), ["s-1-image", "s-2-image"]);
  assert.equal(c.media["s-1-image"].outdated, undefined);
  assert.equal(c.media["s-2-image"].outdated, true);
  assert.equal(c.mediaOutdated, 1);
  assert.equal(c.mediaOrphaned, 1);
  assert.equal(c.orphans["s-3-image-zzzzz"].name, "3.png");
  assert.equal(c.orphans["s-3-image-zzzzz"].from, "s-3-image");
  assert.equal(c.orphans["s-3-image-zzzzz"].bytes, 30);
  // the input is not mutated and a second re-parse does not count the same file as outdated again
  assert.equal(proj.ext.media["s-2-image"].outdated, undefined);
  const again = D.carry({ ext: { media: c.media, orphans: c.orphans } }, D.diff(b, parsed([], [scene(1, "n1", "p1"), scene(2, "n2", "EDITED AGAIN")])), parsed([], [scene(1, "n1", "p1"), scene(2, "n2", "EDITED AGAIN")]));
  assert.equal(again.mediaOutdated, 0);
  assert.ok(again.orphans["s-3-image-zzzzz"], "earlier orphans are kept");
});

test("media: a scene that lost its Flow video orphans the video file; a collision never overwrites a file", () => {
  const a = parsed([], [scene(1, "n1", "p1", "v1"), scene(2, "n2", "p2")]);
  const b = parsed([], [scene(1, "n1", "p1X"), scene(2, "n2", "p2")]);
  const c = D.carry({ ext: { media: { "s-1-image": mk("a.png"), "s-1-video": mk("a.mp4") } } }, D.diff(a, b), b);
  assert.deepEqual(Object.keys(c.media), ["s-1-image"]);
  assert.equal(c.mediaOrphaned, 1);
  assert.equal(Object.values(c.orphans)[0].name, "a.mp4");
});

test("media: reels by id. Unchanged keep every file, edited keep those that still have a slot (outdated), removed reels orphan all", () => {
  const a = parsed([], [], [withReel(1, 2, 1), withReel(2, 3, 1), withReel(3, 1, 0)]);
  const b = parsed([], [], [withReel(1, 2, 1), withReel(2, 2, 1)]);
  const proj = { ext: { media: {
    "r-1-image-2": mk("x"), "r-1-video-1": mk("y"), "r-1-cover": mk("z"),
    "r-2-image-1": mk("p"), "r-2-image-3": mk("q"), "r-2-cover": mk("c"),
    "r-3-image-1": mk("gone"),
  } } };
  const c = D.carry(proj, D.diff(a, b), b);
  assert.deepEqual(Object.keys(c.media).sort(), ["r-1-cover", "r-1-image-2", "r-1-video-1", "r-2-cover", "r-2-image-1"]);
  assert.equal(c.media["r-1-image-2"].outdated, undefined);
  assert.equal(c.media["r-2-image-1"].outdated, true);
  assert.equal(c.mediaOutdated, 2);
  assert.deepEqual(Object.values(c.orphans).map((o) => o.from).sort(), ["r-2-image-3", "r-3-image-1"]);
});

test("media: the YouTube cover follows the thumbnail, outdated when its prompt changed, orphaned when there is none", () => {
  const a = { chunks: [], scenes: [], reels: [], thumbnail: { prompt: "t" } };
  const proj = { ext: { media: { "yt-cover": mk("c.png") } } };
  assert.equal(D.carry(proj, D.diff(a, a), a).media["yt-cover"].outdated, undefined);
  const edited = { ...a, thumbnail: { prompt: "new" } };
  assert.equal(D.carry(proj, D.diff(a, edited), edited).media["yt-cover"].outdated, true);
  const none = { chunks: [], scenes: [], reels: [] };
  const c = D.carry(proj, D.diff(a, none), none);
  assert.deepEqual(c.media, {});
  assert.equal(c.mediaOrphaned, 1);
});

test("media: clearing the parse orphans everything and loses nothing", () => {
  const a = parsed([], [scene(1, "n1", "p1")], [withReel(1, 1)]);
  const proj = { ext: { media: { "s-1-image": mk("a"), "r-1-image-1": mk("b"), "yt-cover": mk("c") } } };
  const c = D.carry(proj, D.diff(a, null), null);
  assert.deepEqual(c.media, {});
  assert.equal(Object.keys(c.orphans).length, 3);
});
