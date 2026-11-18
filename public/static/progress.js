/*
 * Visual Board progress. Plain JS, no dependencies, works in the browser
 * (window.MBSProgress) and in Node (require). State is a plain object keyed by
 * scene number: { "3": { image: true, video: false, audio: true } }.
 * Audio chunks and scenes are not 1:1 in the parser, so audio is a manual toggle.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MBSProgress = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const KINDS = ["image", "video", "audio"];

  /** Kinds that apply to a scene (video only when it has a Flow animation). */
  function kindsFor(scene) {
    return KINDS.filter((k) => k !== "video" || scene.hasVideo);
  }

  function isDone(progress, scene, kind) {
    const s = progress && progress[scene.number];
    return !!(s && s[kind]);
  }

  /** Returns a new state with one flag set. Does not mutate the input. */
  function setFlag(progress, number, kind, value) {
    const next = Object.assign({}, progress);
    const cur = Object.assign({}, next[number]);
    if (value) cur[kind] = true; else delete cur[kind];
    if (Object.keys(cur).length) next[number] = cur; else delete next[number];
    return next;
  }

  /** Keeps states for scenes that still exist after a re-parse; drops the rest. */
  function merge(progress, scenes) {
    const live = new Set((scenes || []).map((s) => String(s.number)));
    const out = {};
    Object.keys(progress || {}).forEach((k) => { if (live.has(k)) out[k] = Object.assign({}, progress[k]); });
    return out;
  }

  /** "todo" (nothing done), "progress" (some), "done" (every applicable kind). */
  function status(progress, scene) {
    const kinds = kindsFor(scene);
    const n = kinds.filter((k) => isDone(progress, scene, k)).length;
    return n === 0 ? "todo" : n === kinds.length ? "done" : "progress";
  }

  const pct = (done, total) => (total ? Math.round((done / total) * 100) : 0);

  /** Per-kind and overall counts: { image: {done,total,pct}, video, audio, total }. */
  function counts(progress, scenes) {
    const out = { total: { done: 0, total: 0, pct: 0 } };
    KINDS.forEach((k) => {
      const list = (scenes || []).filter((s) => kindsFor(s).includes(k));
      const done = list.filter((s) => isDone(progress, s, k)).length;
      out[k] = { done, total: list.length, pct: pct(done, list.length) };
      out.total.done += done;
      out.total.total += list.length;
    });
    out.total.pct = pct(out.total.done, out.total.total);
    return out;
  }

  /** First scene (in list order) whose image is not done, or null. */
  function nextTodoImage(progress, scenes) {
    return (scenes || []).find((s) => !isDone(progress, s, "image")) || null;
  }

  /** filter: "all" | "todo" | "done"; onlyAnim keeps scenes with a Flow animation. */
  function filterScenes(scenes, progress, filter, onlyAnim) {
    return (scenes || []).filter((s) => {
      if (onlyAnim && !s.hasVideo) return false;
      if (filter === "todo") return status(progress, s) !== "done";
      if (filter === "done") return status(progress, s) === "done";
      return true;
    });
  }

  // ---------- Reels (9:16) ----------
  // State per reel id: { img1: true, img2: true, vid1: true }, one key per image and per video prompt
  // (by position). Older saves used { image: true, video: true }: image covers every image, video covers vid1.
  const imgKey = (i) => "img" + (i + 1);
  const vidKey = (i) => "vid" + (i + 1);
  const reelVideos = (reel) => reel.videos || (reel.video ? [reel.video] : []);

  function reelImageDone(progress, reel, i) {
    const s = progress && progress[reel.id];
    return !!(s && (s[imgKey(i)] || s.image));
  }

  function reelVideoDone(progress, reel, i) {
    const s = progress && progress[reel.id];
    return !!(s && (s[vidKey(i)] || (i === 0 && s.video)));
  }

  // The cover is one flag per reel ("cover"). Reels without a cover prompt (or saved before covers existed) simply do not count it.
  const hasCover = (reel) => !!(reel && reel.cover);
  function reelCoverDone(progress, reel) {
    const s = progress && progress[reel.id];
    return !!(s && s.cover);
  }

  /** Sets one image ("image") or video ("video") flag by position, or the reel's "cover" flag. Does not mutate the input. */
  function setReelFlag(progress, reel, kind, i, value) {
    const next = Object.assign({}, progress);
    const cur = Object.assign({}, next[reel.id]);
    if (kind === "image" && cur.image) { reel.images.forEach((_, k) => { cur[imgKey(k)] = true; }); delete cur.image; }
    if (kind === "video" && cur.video) { cur[vidKey(0)] = true; delete cur.video; }
    const key = kind === "image" ? imgKey(i) : kind === "video" ? vidKey(i) : kind;
    if (value) cur[key] = true; else delete cur[key];
    if (Object.keys(cur).length) next[reel.id] = cur; else delete next[reel.id];
    return next;
  }

  /** Keeps states for reels that still exist, and drops image/video keys beyond the new counts. */
  function mergeReels(progress, reels) {
    const out = {};
    (reels || []).forEach((r) => {
      const cur = progress && progress[r.id];
      if (!cur) return;
      const nv = reelVideos(r).length;
      const keep = {};
      Object.keys(cur).forEach((k) => {
        const m = /^(img|vid)(\d+)$/.exec(k);
        if (k === "cover") { if (hasCover(r)) keep[k] = cur[k]; }
        else if (!m) keep[k] = cur[k];
        else if (Number(m[2]) <= (m[1] === "img" ? r.images.length : nv)) keep[k] = cur[k];
      });
      if (Object.keys(keep).length) out[r.id] = keep;
    });
    return out;
  }

  /** First reel image (reels in order, then images in order) not marked done: { reel, index, image } or null. */
  function nextTodoReelImage(progress, reels) {
    for (const reel of reels || []) {
      for (let i = 0; i < reel.images.length; i++) {
        if (!reelImageDone(progress, reel, i)) return { reel, index: i, image: reel.images[i] };
      }
    }
    return null;
  }

  /** "todo" | "progress" | "done" over images, videos, the cover (when it has one) and (when the reel has audio) the audio file. */
  function reelStatus(progress, reel, audioDone) {
    const flags = reel.images.map((_, i) => reelImageDone(progress, reel, i))
      .concat(reelVideos(reel).map((_, i) => reelVideoDone(progress, reel, i)));
    if (hasCover(reel)) flags.push(reelCoverDone(progress, reel));
    if (reel.audio) flags.push(!!audioDone);
    const n = flags.filter(Boolean).length;
    return n === 0 ? "todo" : n === flags.length ? "done" : "progress";
  }

  /** { image, video, cover, audio, total } each { done, total, pct }. audioDone(reel) says whether its audio exists. */
  function reelCounts(progress, reels, audioDone) {
    const out = { image: { done: 0, total: 0 }, video: { done: 0, total: 0 }, cover: { done: 0, total: 0 }, audio: { done: 0, total: 0 } };
    (reels || []).forEach((r) => {
      r.images.forEach((_, i) => { out.image.total++; if (reelImageDone(progress, r, i)) out.image.done++; });
      reelVideos(r).forEach((_, i) => { out.video.total++; if (reelVideoDone(progress, r, i)) out.video.done++; });
      if (hasCover(r)) { out.cover.total++; if (reelCoverDone(progress, r)) out.cover.done++; }
      if (r.audio) { out.audio.total++; if (audioDone && audioDone(r)) out.audio.done++; }
    });
    out.total = { done: out.image.done + out.video.done + out.cover.done + out.audio.done, total: out.image.total + out.video.total + out.cover.total + out.audio.total };
    ["image", "video", "cover", "audio", "total"].forEach((k) => { out[k].pct = pct(out[k].done, out[k].total); });
    return out;
  }

  return { reelVideos, reelImageDone, reelVideoDone, reelCoverDone, setReelFlag, mergeReels, nextTodoReelImage, reelStatus, reelCounts, KINDS, kindsFor, isDone, setFlag, merge, status, counts, nextTodoImage, filterScenes, pct };
});
