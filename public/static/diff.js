/*
 * Compares two parse results so a re-parse can keep what did not change. Pure functions, no DOM.
 * UMD: window.MBSDiff in the browser, require() in Node.
 *
 * Matching: chunks by content hash first (so inserting a chunk renumbers the rest without losing
 * anything), then leftovers by position. Scenes by hash of narration plus prompts first, then by number.
 * Reels by id. Unchanged items keep their progress ticks; edited, new and removed ones do not.
 * Audio is stored per chunk number with the hash of its text, so it is kept only when the chunk keeps
 * its number and text; anything else is marked outdated (the audio file itself is never deleted here).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MBSDiff = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /** Same hash the audio metadata uses (djb2 plus length). */
  function hash(s) {
    s = String(s == null ? "" : s);
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return h.toString(36) + ":" + s.length;
  }

  /**
   * Generic matcher. olds/news: arrays; hashOf(item) content hash; idOf(item) identity for the fallback
   * ("position" uses the array index, "id" uses idOf equality).
   * Returns { unchanged: [{o, n}], edited: [{o, n}], added: [n], removed: [o] } with o/n as items.
   */
  function match(olds, news, hashOf, fallback) {
    const usedO = new Set(), usedN = new Set();
    const unchanged = [], edited = [];
    const byHash = new Map();
    olds.forEach((o, i) => { const h = hashOf(o); (byHash.get(h) || byHash.set(h, []).get(h)).push(i); });
    news.forEach((n, j) => {
      const list = byHash.get(hashOf(n));
      if (!list || !list.length) return;
      // Prefer the old item at the same position when several are identical.
      let k = list.indexOf(j);
      if (k < 0) k = 0;
      const i = list.splice(k, 1)[0];
      usedO.add(i); usedN.add(j);
      unchanged.push({ o: olds[i], n: news[j] });
    });
    news.forEach((n, j) => {
      if (usedN.has(j)) return;
      const i = fallback === "position" ? (j < olds.length && !usedO.has(j) ? j : -1) : olds.findIndex((o, x) => !usedO.has(x) && fallback(o) === fallback(n));
      if (i < 0) return;
      usedO.add(i); usedN.add(j);
      edited.push({ o: olds[i], n });
    });
    return {
      unchanged, edited,
      added: news.filter((_, j) => !usedN.has(j)),
      removed: olds.filter((_, i) => !usedO.has(i)),
    };
  }

  const chunkHash = (c) => hash(c.text);
  const sceneHash = (s) => hash([s.narration, s.imagePrompt, s.videoPrompt].join("\u0001"));
  const reelHash = (r) => hash(JSON.stringify(r));

  /**
   * @returns {{chunks, scenes, reels}} each from match(): items are the parsed objects (chunk, scene, reel).
   */
  function diff(oldParsed, newParsed) {
    const o = oldParsed || { chunks: [], scenes: [], reels: [] }, n = newParsed || { chunks: [], scenes: [], reels: [] };
    const reelsMatch = (() => {
      // Reels are matched by id: same id and same content is unchanged, same id with other content is edited.
      const oldById = new Map((o.reels || []).map((r) => [r.id, r]));
      const out = { unchanged: [], edited: [], added: [], removed: [] };
      (n.reels || []).forEach((r) => {
        const prev = oldById.get(r.id);
        if (!prev) out.added.push(r);
        else (reelHash(prev) === reelHash(r) ? out.unchanged : out.edited).push({ o: prev, n: r });
      });
      const nowIds = new Set((n.reels || []).map((r) => r.id));
      out.removed = (o.reels || []).filter((r) => !nowIds.has(r.id));
      return out;
    })();
    return {
      chunks: match(o.chunks || [], n.chunks || [], chunkHash, "position"),
      scenes: match(o.scenes || [], n.scenes || [], sceneHash, (s) => s.number),
      reels: reelsMatch,
      thumbnailSame: !!(o.thumbnail && n.thumbnail && o.thumbnail.prompt === n.thumbnail.prompt),
    };
  }

  /** { chunks: {added, edited, removed, unchanged}, scenes: {...}, reels: {...} } counts. */
  function summarize(d) {
    const c = (m) => ({ added: m.added.length, edited: m.edited.length, removed: m.removed.length, unchanged: m.unchanged.length });
    return { chunks: c(d.chunks), scenes: c(d.scenes), reels: c(d.reels) };
  }

  const isChange = (s) => ["chunks", "scenes", "reels"].some((k) => s[k].added || s[k].edited || s[k].removed);

  /** The same lists as numbers and ids, small enough to keep in the project ("Changes since last parse"). */
  function listChanges(d) {
    const key = (k) => (x) => x[k];
    const l = (m, f) => ({ added: m.added.map(f), edited: m.edited.map((e) => f(e.n)), removed: m.removed.map(f) });
    return { chunks: l(d.chunks, key("n")), scenes: l(d.scenes, key("number")), reels: l(d.reels, key("id")) };
  }

  const countTrue = (obj) => Object.values(obj || {}).reduce((a, s) => a + Object.keys(s || {}).filter((k) => s[k]).length, 0);

  /** What a replace puts at risk: progress ticks and audio files that currently match their text. */
  function impact(proj) {
    const parsed = proj.parsed;
    const audio = Object.keys(proj.audio || {}).filter((n) => {
      const c = parsed && (parsed.chunks || []).find((x) => String(x.n) === n);
      return c && proj.audio[n] && proj.audio[n].hash === hash(c.text);
    }).length + Object.keys(proj.reelAudio || {}).length;
    const ticks = countTrue(proj.progress) + countTrue(proj.reelProgress) + (proj.thumbnailDone ? 1 : 0);
    const info = proj.info || {};
    const published = !!(proj.status === "published" || info.youtubeUrl || info.publishDate || (info.reels || []).some((r) => r && r.url));
    return { audio, ticks, published };
  }

  /**
   * Where each stored media file goes after a re-parse. Media is keyed by item (s-4-image, r-1-video-2, r-1-cover, yt-cover) in
   * proj.ext.media; every entry may carry sk, the key of its R2 object, which never changes (so a moved file keeps its object).
   *   unchanged scene (same content, maybe renumbered)  its files follow it to the new number
   *   edited scene, reel or cover                       its files stay, flagged outdated: the prompt changed since they were added
   *   removed scene or reel, or an index that is gone   the file becomes an orphan (proj.ext.orphans, keyed by sk)
   * Nothing is deleted here; R2 files are only removed by "Remove unused media". Returns { media, orphans, outdated, orphaned }.
   */
  function carryMedia(proj, d, newParsed) {
    const old = (proj.ext && proj.ext.media) || {};
    const media = {}, orphans = Object.assign({}, proj.ext && proj.ext.orphans);
    const used = new Set();
    let outdated = 0, orphaned = 0;
    const videosOf = (r) => r.videos || (r.video ? [r.video] : []);
    const place = (from, to, flag) => {
      const e = old[from];
      if (!e || used.has(from) || media[to]) return; // a second file for one slot is orphaned below
      used.add(from);
      media[to] = Object.assign({}, e);
      if (flag && !e.outdated) { media[to].outdated = true; outdated++; }
    };
    const sKey = (n, k) => "s-" + n + "-" + k;
    d.scenes.unchanged.forEach(({ o, n }) => ["image", "video"].forEach((k) => { if (k === "image" || n.hasVideo) place(sKey(o.number, k), sKey(n.number, k), false); }));
    d.scenes.edited.forEach(({ o, n }) => ["image", "video"].forEach((k) => { if (k === "image" || n.hasVideo) place(sKey(o.number, k), sKey(n.number, k), true); }));
    d.reels.unchanged.forEach(({ n }) => Object.keys(old).forEach((k) => { if (k.indexOf("r-" + n.id + "-") === 0) place(k, k, false); }));
    d.reels.edited.forEach(({ n }) => {
      const has = (k) => {
        const m = /^r-\d+-(image|video|cover)(?:-(\d+))?$/.exec(k);
        if (!m) return false;
        if (m[1] === "cover") return !!n.cover;
        return Number(m[2]) >= 1 && Number(m[2]) <= (m[1] === "image" ? (n.images || []).length : videosOf(n).length);
      };
      Object.keys(old).forEach((k) => { if (k.indexOf("r-" + n.id + "-") === 0 && has(k)) place(k, k, true); });
    });
    if (newParsed && newParsed.thumbnail) place("yt-cover", "yt-cover", !d.thumbnailSame);
    const at = Date.now();
    Object.keys(old).forEach((k) => {
      if (used.has(k)) return;
      const sk = old[k].sk || k;
      orphans[sk] = Object.assign({}, old[k], { sk, from: k, orphanedAt: at });
      delete orphans[sk].outdated;
      orphaned++;
    });
    return { media, orphans, outdated, orphaned };
  }

  /**
   * The state that follows the new parse. Input: the old project fields. Does not mutate.
   * Returns { progress, reelProgress, thumbnailDone, audio, reelAudio, outdated, media, orphans, mediaOutdated, mediaOrphaned } (see carryMedia).
   */
  function carry(proj, d, newParsed) {
    const progress = {};
    d.scenes.unchanged.forEach(({ o, n }) => { if (proj.progress && proj.progress[o.number]) progress[n.number] = Object.assign({}, proj.progress[o.number]); });
    const reelProgress = {};
    d.reels.unchanged.forEach(({ o, n }) => { if (proj.reelProgress && proj.reelProgress[o.id]) reelProgress[n.id] = Object.assign({}, proj.reelProgress[o.id]); });
    let outdated = 0;
    const audio = {};
    Object.keys(proj.audio || {}).forEach((k) => {
      const c = ((newParsed && newParsed.chunks) || []).find((x) => String(x.n) === k);
      const m = Object.assign({}, proj.audio[k]);
      if (!(c && m.hash === hash(c.text))) { if (!m.outdated) outdated++; m.outdated = true; } else delete m.outdated;
      audio[k] = m;
    });
    const reelAudio = {};
    Object.keys(proj.reelAudio || {}).forEach((k) => {
      const r = ((newParsed && newParsed.reels) || []).find((x) => String(x.id) === k);
      const m = Object.assign({}, proj.reelAudio[k]);
      if (!(r && r.audio && m.hash === hash(r.audio.text))) { if (!m.outdated) outdated++; m.outdated = true; } else delete m.outdated;
      reelAudio[k] = m;
    });
    const cm = carryMedia(proj, d, newParsed);
    return { progress, reelProgress, thumbnailDone: !!(proj.thumbnailDone && d.thumbnailSame), audio, reelAudio, outdated, media: cm.media, orphans: cm.orphans, mediaOutdated: cm.outdated, mediaOrphaned: cm.orphaned };
  }

  return { hash, match, diff, summarize, isChange, listChanges, impact, carry, carryMedia };
});
