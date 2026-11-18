const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const P = require("../public/static/parser.js");
const N = require("../public/static/next.js");

const parsed = P.parse(fs.readFileSync(__dirname + "/../samples/sample-conversation.txt", "utf8"), { startPhrase: P.DEFAULT_START_PHRASE });
const mk = (extra) => Object.assign({ parsed, progress: {}, reelProgress: {}, status: "draft", thumbnailDone: false }, extra);
const allAudio = () => true;

test("no project, nothing parsed", () => {
  assert.equal(N.nextAction(null, allAudio), null);
  assert.deepEqual(N.nextAction({ parsed: null }, allAudio), { label: "Paste the conversation and press Parse", view: "import", target: "#paste" });
});

test("audio comes first and counts what is left", () => {
  const a = N.nextAction(mk(), (k) => k === 1);
  assert.equal(a.view, "youtube-audio");
  assert.match(a.label, /Generate audio \(5 chunks left\)/);
  assert.match(N.nextAction(mk(), (k) => k !== 6).label, /\(1 chunk left\)/);
});

test("then the first scene image, naming the scene", () => {
  const a = N.nextAction(mk(), allAudio);
  assert.deepEqual(a, { label: "Copy next image prompt (Scene " + String(parsed.scenes[0].number).padStart(2, "0") + ")", view: "youtube-board", target: "#scene-" + parsed.scenes[0].number });
});

function doneScenes() {
  const progress = {};
  parsed.scenes.forEach((s) => { progress[s.number] = { image: true, audio: true }; if (s.hasVideo) progress[s.number].video = true; });
  return progress;
}

test("then animations, scene audio ticks, the YouTube cover", () => {
  const p = doneScenes();
  const flow = parsed.scenes.find((s) => s.hasVideo);
  delete p[flow.number].video;
  assert.match(N.nextAction(mk({ progress: p }), allAudio).label, /^Generate the animation for Scene/);
  p[flow.number].video = true; delete p[parsed.scenes[1].number].audio;
  assert.match(N.nextAction(mk({ progress: p }), allAudio).label, /^Mark the audio for Scene/);
  p[parsed.scenes[1].number].audio = true;
  assert.deepEqual(N.nextAction(mk({ progress: p }), allAudio), { label: "Generate the YouTube cover", view: "youtube-covers", target: "#thumb-done" });
});

test("reels: audio, then image label like R01-01, then animations, then covers", () => {
  const base = { progress: doneScenes(), thumbnailDone: true };
  const a = N.nextAction(mk(base), (k) => !/^r/.test(String(k)) || k !== "r2");
  assert.deepEqual([a.view, a.target], ["reels:2:audio", "#reel-2"]);
  const b = N.nextAction(mk(base), allAudio);
  assert.match(b.label, /^Copy next reel image prompt \(R01-01\)$/);
  assert.deepEqual([b.view, b.target], ["reels:1:visual", "#rimg-1-1"]);
  const reelProgress = {};
  parsed.reels.forEach((r) => { reelProgress[r.id] = {}; r.images.forEach((_, i) => { reelProgress[r.id]["img" + (i + 1)] = true; }); });
  assert.match(N.nextAction(mk(Object.assign({ reelProgress }, base)), allAudio).label, /^Generate animation 1 for Reel 01/);
  parsed.reels.forEach((r) => { (r.videos || []).forEach((_, i) => { reelProgress[r.id]["vid" + (i + 1)] = true; }); });
  const c = N.nextAction(mk(Object.assign({ reelProgress }, base)), allAudio);
  assert.deepEqual([c.view, c.target], ["reels:1:cover", "#rcov-1"]);
});

test("everything done: mark Ready, then publish, then nothing", () => {
  const reelProgress = {};
  parsed.reels.forEach((r) => { reelProgress[r.id] = { cover: true }; r.images.forEach((_, i) => { reelProgress[r.id]["img" + (i + 1)] = true; }); (r.videos || []).forEach((_, i) => { reelProgress[r.id]["vid" + (i + 1)] = true; }); });
  const full = { progress: doneScenes(), reelProgress, thumbnailDone: true };
  assert.deepEqual(N.nextAction(mk(full), allAudio), { label: "Everything is ticked. Mark the project as Ready", view: "overview", target: "#ov-mark" });
  assert.equal(N.nextAction(mk(Object.assign({ status: "ready" }, full)), allAudio).target, "#ov-yt");
  assert.match(N.nextAction(mk(Object.assign({ status: "published" }, full)), allAudio).label, /All done/);
});

test("audio still to do but Setup incomplete: the next step is Setup", () => {
  const a = N.nextAction(mk(), () => false, { setupReady: false, setupTarget: "#s-voice" });
  assert.deepEqual(a, { label: "Add your ElevenLabs API key and voice ID in Setup", view: "setup", target: "#s-voice" });
  assert.equal(N.nextAction(mk(), () => false, { setupReady: true }).view, "youtube-audio");
  assert.equal(N.nextAction(mk(), allAudio, { setupReady: false }).view, "youtube-board", "no audio left to generate, so Setup is not asked for");
});
