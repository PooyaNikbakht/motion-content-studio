/*
 * Pre-flight checks on a parse result: things that make audio fail or prompts come out empty. Pure functions.
 * check(parsed, { model, startPhrase, lang }) returns [{ code, severity, target, msg }] ("error" means ElevenLabs
 * will refuse it, "warn" means it is probably a mistake). The UI lists them and never blocks generating.
 * target: "chunk:3", "scene:4", "cover", "reel:2", "reel:2:image:1", "reel:2:video:1", "reel:2:cover", "reel:2:audio".
 * UMD: window.MBSQuality in the browser, require() in Node.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./parser.js"), require("./estimate.js"));
  else root.MBSQuality = factory(root.MBSParser, root.MBSEstimate);
})(typeof self !== "undefined" ? self : this, function (P, E) {
  "use strict";

  const MODEL_LIMITS = { eleven_v4: 10000, eleven_v3: 5000, eleven_multilingual_v2: 10000, eleven_flash_v2_5: 40000 };
  const NAME = { eleven_v4: "Eleven v4", eleven_v3: "Eleven v3", eleven_multilingual_v2: "Multilingual v2", eleven_flash_v2_5: "Flash v2.5" };
  const PERSIAN = ["fa"];
  const pad = (n) => String(n).padStart(2, "0");

  /** Latin words (two letters or more) in narration, ignoring Eleven v3 audio tags such as [whispers]. */
  function latinWords(text) {
    return (String(text || "").replace(/\[[^\]]*\]/g, " ").match(/[A-Za-z][A-Za-z'-]+/g) || []).filter((w) => w.length >= 2);
  }

  function check(parsed, opts) {
    opts = opts || {};
    const out = [];
    if (!parsed) return out;
    const add = (code, severity, target, msg) => out.push({ code, severity, target, msg });
    const limit = MODEL_LIMITS[opts.model];
    const phrase = String(opts.startPhrase || "").trim();
    const lang = opts.lang || "";

    (parsed.chunks || []).forEach((c) => {
      const t = "chunk:" + c.n, label = "Chunk " + pad(c.n);
      const n = E.chars(c.text);
      if (limit && n > limit) add("chunk-limit", "error", t, label + " has " + E.fmt(n) + " characters; " + (NAME[opts.model] || opts.model) + " accepts at most " + E.fmt(limit) + " per request.");
      if (phrase && P && !P.splitWarmup(c.text, phrase).warm) add("no-warmup", "warn", t, label + " does not start with the warm-up phrase.");
      if (PERSIAN.includes(lang)) {
        const w = latinWords(c.text);
        if (w.length) add("latin-in-persian", "warn", t, label + " has Latin words in Persian narration: " + [...new Set(w)].slice(0, 4).join(", ") + (new Set(w).size > 4 ? ", ..." : "") + ".");
      }
    });

    const seen = new Map();
    (parsed.scenes || []).forEach((s) => {
      seen.set(s.number, (seen.get(s.number) || 0) + 1);
      if (!String(s.imagePrompt || "").trim()) add("empty-image-prompt", "warn", "scene:" + s.number, "Scene " + pad(s.number) + " has no image prompt.");
      if (s.hasVideo && !String(s.videoPrompt || "").trim()) add("empty-video-prompt", "warn", "scene:" + s.number, "Scene " + pad(s.number) + " has an animation but no video prompt.");
    });
    seen.forEach((count, n) => { if (count > 1) add("duplicate-scene", "warn", "scene:" + n, "Scene number " + pad(n) + " appears " + count + " times.");});

    if (parsed.thumbnail && !String(parsed.thumbnail.prompt || "").trim()) add("empty-cover-prompt", "warn", "cover", "The YouTube cover has no prompt.");

    (parsed.reels || []).forEach((r) => {
      const name = r.name || "Reel " + pad(r.id), t = "reel:" + r.id;
      if (!r.audio) add("reel-no-audio", "warn", t + ":audio", name + " has no audio chunk.");
      if (!(r.images || []).length) add("reel-no-images", "warn", t + ":image:1", name + " has no image prompts.");
      (r.images || []).forEach((im, i) => { if (!String(im.prompt || "").trim()) add("empty-image-prompt", "warn", t + ":image:" + (i + 1), name + ", " + (im.label || "image " + (i + 1)) + " has no image prompt."); });
      const vids = r.videos || (r.video ? [r.video] : []);
      vids.forEach((v, i) => { if (!String(v.prompt || "").trim()) add("empty-video-prompt", "warn", t + ":video:" + (i + 1), name + ", animation " + (i + 1) + " has no video prompt."); });
      if (!r.cover) add("reel-no-cover", "warn", t + ":cover", name + " has no cover prompt.");
      else if (!String(r.cover.prompt || "").trim()) add("empty-cover-prompt", "warn", t + ":cover", name + " has an empty cover prompt.");
    });
    return out;
  }

  return { MODEL_LIMITS, latinWords, check };
});
