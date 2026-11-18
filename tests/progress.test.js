const test = require("node:test");
const assert = require("node:assert/strict");
const G = require("../public/static/progress.js");

const scenes = [
  { number: 1, hasVideo: false },
  { number: 2, hasVideo: true },
  { number: 3, hasVideo: false },
  { number: 4, hasVideo: true },
];

test("setFlag sets and clears without mutating", () => {
  const a = {};
  const b = G.setFlag(a, 2, "image", true);
  assert.deepEqual(a, {});
  assert.deepEqual(b, { 2: { image: true } });
  assert.deepEqual(G.setFlag(b, 2, "image", false), {});
});

test("merge keeps states for surviving scenes and drops removed ones", () => {
  const p = { 1: { image: true }, 3: { audio: true }, 9: { image: true } };
  const m = G.merge(p, scenes.filter((s) => s.number !== 3));
  assert.deepEqual(m, { 1: { image: true } });
  assert.deepEqual(G.merge(p, scenes), { 1: { image: true }, 3: { audio: true } });
  assert.deepEqual(G.merge(undefined, scenes), {});
});

test("kindsFor: video only for animated scenes", () => {
  assert.deepEqual(G.kindsFor(scenes[0]), ["image", "audio"]);
  assert.deepEqual(G.kindsFor(scenes[1]), ["image", "video", "audio"]);
});

test("status: todo, progress, done", () => {
  assert.equal(G.status({}, scenes[0]), "todo");
  assert.equal(G.status({ 1: { image: true } }, scenes[0]), "progress");
  assert.equal(G.status({ 1: { image: true, audio: true } }, scenes[0]), "done");
  assert.equal(G.status({ 2: { image: true, audio: true } }, scenes[1]), "progress");
  assert.equal(G.status({ 2: { image: true, audio: true, video: true } }, scenes[1]), "done");
});

test("counts and percent", () => {
  const p = { 1: { image: true, audio: true }, 2: { image: true, video: true }, 3: { video: true } };
  const c = G.counts(p, scenes);
  assert.deepEqual(c.image, { done: 2, total: 4, pct: 50 });
  assert.deepEqual(c.video, { done: 1, total: 2, pct: 50 });
  assert.deepEqual(c.audio, { done: 1, total: 4, pct: 25 });
  assert.deepEqual(c.total, { done: 4, total: 10, pct: 40 });
});

test("counts: empty and rounding", () => {
  assert.deepEqual(G.counts({}, []).total, { done: 0, total: 0, pct: 0 });
  assert.equal(G.pct(1, 3), 33);
  assert.equal(G.pct(2, 3), 67);
});

test("nextTodoImage returns the first scene without an image", () => {
  assert.equal(G.nextTodoImage({ 1: { image: true } }, scenes).number, 2);
  const all = { 1: { image: true }, 2: { image: true }, 3: { image: true }, 4: { image: true } };
  assert.equal(G.nextTodoImage(all, scenes), null);
});

test("filterScenes combines status filter and only-animated", () => {
  const p = { 1: { image: true, audio: true } };
  assert.deepEqual(G.filterScenes(scenes, p, "done", false).map((s) => s.number), [1]);
  assert.deepEqual(G.filterScenes(scenes, p, "todo", false).map((s) => s.number), [2, 3, 4]);
  assert.deepEqual(G.filterScenes(scenes, p, "todo", true).map((s) => s.number), [2, 4]);
  assert.deepEqual(G.filterScenes(scenes, p, "all", true).map((s) => s.number), [2, 4]);
});

const reels = [
  { id: 1, audio: { text: "a" }, images: [{}, {}], videos: [{}] },
  { id: 2, audio: null, images: [{}, {}, {}], videos: [{}, {}] },
];

test("reel flags are per image and per video index", () => {
  let p = G.setReelFlag({}, reels[1], "image", 1, true);
  p = G.setReelFlag(p, reels[1], "video", 1, true);
  assert.deepEqual(p, { 2: { img2: true, vid2: true } });
  assert.ok(G.reelImageDone(p, reels[1], 1) && !G.reelImageDone(p, reels[1], 0));
  assert.ok(G.reelVideoDone(p, reels[1], 1) && !G.reelVideoDone(p, reels[1], 0));
  assert.deepEqual(G.setReelFlag(p, reels[1], "video", 1, false), { 2: { img2: true } });
});

test("legacy image/video flags still count and expand on edit", () => {
  const legacy = { 1: { image: true, video: true } };
  assert.ok(G.reelImageDone(legacy, reels[0], 1) && G.reelVideoDone(legacy, reels[0], 0));
  assert.ok(!G.reelVideoDone(legacy, reels[1], 1));
  const p = G.setReelFlag(legacy, reels[0], "image", 0, false);
  assert.deepEqual(p, { 1: { img2: true, video: true } });
  assert.deepEqual(legacy, { 1: { image: true, video: true } });
});

test("mergeReels drops removed reels and out-of-range keys", () => {
  const p = { 1: { img1: true, img3: true, vid2: true, audio: true }, 9: { img1: true } };
  assert.deepEqual(G.mergeReels(p, reels), { 1: { img1: true, audio: true } });
});

test("nextTodoReelImage walks reels in order", () => {
  const first = G.nextTodoReelImage({}, reels);
  assert.deepEqual([first.reel.id, first.index], [1, 0]);
  let p = { 1: { img1: true } };
  assert.deepEqual([G.nextTodoReelImage(p, reels).reel.id, G.nextTodoReelImage(p, reels).index], [1, 1]);
  p = { 1: { image: true }, 2: { img1: true } };
  const n = G.nextTodoReelImage(p, reels);
  assert.deepEqual([n.reel.id, n.index], [2, 1]);
  assert.equal(G.nextTodoReelImage({ 1: { image: true }, 2: { img1: true, img2: true, img3: true } }, reels), null);
  assert.equal(G.nextTodoReelImage({}, []), null);
});

test("reelStatus and reelCounts include derived audio", () => {
  assert.equal(G.reelStatus({}, reels[0], false), "todo");
  assert.equal(G.reelStatus({ 1: { img1: true } }, reels[0], false), "progress");
  assert.equal(G.reelStatus({ 1: { img1: true, img2: true, vid1: true } }, reels[0], false), "progress");
  assert.equal(G.reelStatus({ 1: { img1: true, img2: true, vid1: true } }, reels[0], true), "done");
  assert.equal(G.reelStatus({ 2: { image: true, video: true, vid2: true } }, reels[1], false), "done");
  const c = G.reelCounts({ 1: { img1: true, vid1: true } }, reels, (r) => r.id === 1);
  assert.deepEqual(c.image, { done: 1, total: 5, pct: 20 });
  assert.deepEqual(c.video, { done: 1, total: 3, pct: 33 });
  assert.deepEqual(c.audio, { done: 1, total: 1, pct: 100 });
  assert.deepEqual(c.total, { done: 3, total: 9, pct: 33 });
});

test("reel cover flag: status, counts, merge, set and legacy compatibility", () => {
  const rc = [{ id: 1, audio: null, images: [{}], videos: [{}], cover: { prompt: "c" } }, { id: 2, audio: null, images: [{}], videos: [], cover: null }];
  assert.ok(!G.reelCoverDone({}, rc[0]));
  const p = G.setReelFlag({}, rc[0], "cover", 0, true);
  assert.deepEqual(p, { 1: { cover: true } });
  assert.ok(G.reelCoverDone(p, rc[0]));
  assert.deepEqual(G.setReelFlag(p, rc[0], "cover", 0, false), {});
  assert.equal(G.reelStatus({ 1: { img1: true, vid1: true } }, rc[0], false), "progress");
  assert.equal(G.reelStatus({ 1: { img1: true, vid1: true, cover: true } }, rc[0], false), "done");
  assert.equal(G.reelStatus({ 2: { img1: true } }, rc[1], false), "done");
  const c = G.reelCounts({ 1: { img1: true, cover: true } }, rc, null);
  assert.deepEqual(c.cover, { done: 1, total: 1, pct: 100 });
  assert.deepEqual(c.total, { done: 2, total: 4, pct: 50 });
  assert.deepEqual(G.mergeReels({ 1: { cover: true, img1: true }, 2: { cover: true, img1: true } }, rc), { 1: { cover: true, img1: true }, 2: { img1: true } });
  // reels parsed before covers existed have no cover and are unaffected
  assert.deepEqual(G.reelCounts({}, reels, null).cover, { done: 0, total: 0, pct: 0 });
});

test("reel cover is one shared flag: Reels > Cover & Captions and the Reels badge read and write the same state", () => {
  const rc = [{ id: 1, audio: null, images: [], videos: [], cover: { prompt: "c" } }, { id: 2, audio: null, images: [], videos: [], cover: { prompt: "d" } }];
  // tick from the cover tab, read from the Visual Board counts (same functions, same key)
  let p = G.setReelFlag({}, rc[1], "cover", 0, true);
  assert.deepEqual(p, { 2: { cover: true } });
  assert.ok(G.reelCoverDone(p, rc[1]) && !G.reelCoverDone(p, rc[0]));
  assert.deepEqual(G.reelCounts(p, rc, null).cover, { done: 1, total: 2, pct: 50 });
  assert.equal(G.reelStatus(p, rc[1], false), "done");
  // untick from the reel: both views and counters follow
  p = G.setReelFlag(p, rc[1], "cover", 0, false);
  assert.deepEqual(p, {});
  assert.deepEqual(G.reelCounts(p, rc, null).cover, { done: 0, total: 2, pct: 0 });
});
