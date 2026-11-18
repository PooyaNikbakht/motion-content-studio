/*
 * "What should I do next?" for a project. Pure function over the project and a way to ask whether audio exists.
 * nextAction(proj, audioMeta) -> { label, view, target } or null when there is no project.
 *   view    "overview" | "import" | "youtube-audio" | "youtube-board" | "youtube-covers" | "reels:<id>:audio|visual|cover"
 *   target  a CSS selector for the card or button to focus after jumping there
 * audioMeta(key) is truthy when that audio exists: a chunk number, or "r<id>" for a reel.
 * opts.setupReady === false (and audio still to generate) makes the next step "fill in Setup"; opts.setupTarget is the field to focus.
 * UMD: window.MBSNext in the browser, require() in Node.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./progress.js"));
  else root.MBSNext = factory(root.MBSProgress);
})(typeof self !== "undefined" ? self : this, function (G) {
  "use strict";

  const pad = (n) => String(n).padStart(2, "0");

  function nextAction(proj, audioMeta, opts) {
    if (!proj) return null;
    const parsed = proj.parsed;
    if (!parsed) return { label: "Paste the conversation and press Parse", view: "import", target: "#paste" };
    const has = audioMeta || (() => false);
    const prog = proj.progress || {}, rprog = proj.reelProgress || {};
    const scenes = parsed.scenes || [], reels = parsed.reels || [], chunks = parsed.chunks || [];

    const missing = chunks.filter((c) => !has(c.n));
    if (missing.length && opts && opts.setupReady === false) return { label: "Add your ElevenLabs API key and voice ID in Setup", view: "setup", target: (opts && opts.setupTarget) || "#s-key" };
    if (missing.length) return { label: "Generate audio (" + missing.length + " chunk" + (missing.length === 1 ? "" : "s") + " left)", view: "youtube-audio", target: "#run" };

    const img = G.nextTodoImage(prog, scenes);
    if (img) return { label: "Copy next image prompt (Scene " + pad(img.number) + ")", view: "youtube-board", target: "#scene-" + img.number };
    const vid = scenes.find((s) => s.hasVideo && !G.isDone(prog, s, "video"));
    if (vid) return { label: "Generate the animation for Scene " + pad(vid.number), view: "youtube-board", target: "#scene-" + vid.number };
    const aud = scenes.find((s) => !G.isDone(prog, s, "audio"));
    if (aud) return { label: "Mark the audio for Scene " + pad(aud.number), view: "youtube-board", target: "#scene-" + aud.number };
    if (parsed.thumbnail && !proj.thumbnailDone) return { label: "Generate the YouTube cover", view: "youtube-covers", target: "#thumb-done" };

    for (const r of reels) {
      if (r.audio && !has("r" + r.id)) return { label: "Generate audio for " + r.name, view: "reels:" + r.id + ":audio", target: "#reel-" + r.id };
    }
    const rimg = G.nextTodoReelImage(rprog, reels);
    if (rimg) return { label: "Copy next reel image prompt (" + rimg.image.label + ")", view: "reels:" + rimg.reel.id + ":visual", target: "#rimg-" + rimg.reel.id + "-" + (rimg.index + 1) };
    for (const r of reels) {
      const vi = G.reelVideos(r).findIndex((_, i) => !G.reelVideoDone(rprog, r, i));
      if (vi >= 0) return { label: "Generate animation " + (vi + 1) + " for " + r.name, view: "reels:" + r.id + ":visual", target: "#rvid-" + r.id + "-" + (vi + 1) };
    }
    for (const r of reels) {
      if (r.cover && !G.reelCoverDone(rprog, r)) return { label: "Generate the cover for " + r.name, view: "reels:" + r.id + ":cover", target: "#rcov-" + r.id };
    }

    if (proj.status !== "ready" && proj.status !== "published") return { label: "Everything is ticked. Mark the project as Ready", view: "overview", target: "#ov-mark" };
    if (proj.status === "ready") return { label: "Publish it and add the YouTube link", view: "overview", target: "#ov-yt" };
    return { label: "All done. Nothing left to do", view: "overview", target: "#ov-status" };
  }

  return { nextAction };
});
