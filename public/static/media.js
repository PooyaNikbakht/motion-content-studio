/*
 * Media files for the visual items: matching file names to scenes, reel items and covers, and the plan for the
 * "edit-ready folder" export. Pure functions, no DOM. UMD: window.MBSMedia in the browser, require() in Node.
 *
 * match(name) understands (case and separators do not matter):
 *   03.png  3.jpg  scene_04.mp4  Scene 4.webp  image_03.png  04_video.mp4     scene image or video (by extension)
 *   R01-02.png  r1_2.jpg                                                      reel 1, image 2
 *   R01-02.mp4  R01-V1.mp4  R01-video-2.webm                                  reel 1, video (animation) 2
 *   R01-cover.png  reel_1_cover.jpg                                           reel 1 cover
 *   cover.png  thumbnail.png  youtube-cover.jpg                               the YouTube cover
 * Keys are URL safe: s-4-image, s-4-video, r-1-image-2, r-1-video-1, r-1-cover, yt-cover. They are the scene number and the reel id,
 * so they follow the item (see diff.js carryMedia). A stored entry may add sk: the key of its R2 object, fixed at upload.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MBSMedia = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", mp4: "video/mp4", webm: "video/webm" };
  const IMAGE = ["png", "jpg", "jpeg", "webp"];
  const MAX_FILE = 100000000; // bytes (100 MB, decimal), the same cap as the server
  const MAX_FILES = 200;
  const KEY_RE = /^[a-z]{1,3}(?:-[a-z0-9]{1,12}){0,4}$/;
  const ACCEPT = { image: ["image/png", "image/jpeg", "image/webp"], video: ["video/mp4", "video/webm"] };
  const pad = (n, w) => String(n).padStart(w || 2, "0");

  const extOf = (name) => { const m = /\.([A-Za-z0-9]+)$/.exec(String(name || "")); return m ? m[1].toLowerCase() : ""; };
  const typeOf = (name) => TYPES[extOf(name)] || "";

  /** { key, media: "image"|"video", kind, ext, scene?, reel?, index? } or null when the name means nothing here. */
  function match(name) {
    const file = String(name || "").split(/[\\/]/).pop();
    const ext = extOf(file);
    if (!TYPES[ext]) return null;
    const media = IMAGE.includes(ext) ? "image" : "video";
    const base = file.slice(0, file.length - ext.length - 1).trim().toLowerCase().replace(/\s+/g, "_");
    const num = (v) => parseInt(v, 10);
    let m;
    if ((m = /^r(?:eel)?[_-]?0*(\d+)[_-](?:cover|thumb|thumbnail)$/.exec(base))) {
      return media === "image" ? { key: "r-" + num(m[1]) + "-cover", media, kind: "reel-cover", ext, reel: num(m[1]) } : null;
    }
    if ((m = /^r(?:eel)?[_-]?0*(\d+)[_-](?:v|vid|video|anim|animation)[_-]?0*(\d+)$/.exec(base))) {
      return media === "video" ? { key: "r-" + num(m[1]) + "-video-" + num(m[2]), media, kind: "reel-video", ext, reel: num(m[1]), index: num(m[2]) } : null;
    }
    if ((m = /^r(?:eel)?[_-]?0*(\d+)[_-]0*(\d+)$/.exec(base))) {
      const reel = num(m[1]), index = num(m[2]);
      return media === "image"
        ? { key: "r-" + reel + "-image-" + index, media, kind: "reel-image", ext, reel, index }
        : { key: "r-" + reel + "-video-" + index, media, kind: "reel-video", ext, reel, index };
    }
    if (/^(?:youtube[_-])?(?:cover|thumb|thumbnail)$/.test(base)) return media === "image" ? { key: "yt-cover", media, kind: "cover", ext } : null;
    if ((m = /^(?:scene|image|img|video|vid|clip)?[_-]?0*(\d+)(?:[_-](?:image|img|video|vid))?$/.exec(base))) {
      const scene = num(m[1]);
      return { key: "s-" + scene + "-" + media, media, kind: "scene", ext, scene };
    }
    return null;
  }

  /** The descriptor match() gives, rebuilt from an item key ("s-4-image", "r-1-video-2", "r-1-cover", "yt-cover"), or null. */
  function fromKey(key) {
    let m;
    if (key === "yt-cover") return { key, media: "image", kind: "cover" };
    if ((m = /^s-(\d+)-(image|video)$/.exec(key))) return { key, media: m[2], kind: "scene", scene: Number(m[1]) };
    if ((m = /^r-(\d+)-cover$/.exec(key))) return { key, media: "image", kind: "reel-cover", reel: Number(m[1]) };
    if ((m = /^r-(\d+)-(image|video)-(\d+)$/.exec(key))) return { key, media: m[2], kind: m[2] === "image" ? "reel-image" : "reel-video", reel: Number(m[1]), index: Number(m[3]) };
    return null;
  }

  /** The R2 key of a stored entry: its own sk, else the item key (files stored before sk existed). */
  const serverKey = (key, entry) => (entry && entry.sk) || key;

  /** A fresh sk for an item: the item key plus 5 random base36 characters (s-4-image-k3j9d). Never reused, so a renumbered scene cannot clobber a file. */
  function newServerKey(key, rnd) {
    const r = (rnd || Math.random)();
    return key + "-" + Math.floor(r * 36 ** 5).toString(36).padStart(5, "0");
  }

  /** Whether a file (name or MIME type) may go in a slot of this media kind ("image" or "video"). Returns "" when fine, else the reason. */
  function slotCheck(file, media) {
    const type = (file && file.type) || typeOf(file && file.name);
    const ok = ACCEPT[media].includes(type);
    if (!ok) return (media === "image" ? "Use a PNG, JPG or WebP image" : "Use an MP4 or WebM video") + (type ? " (this is " + type + ")" : "");
    if (file.size === 0) return "The file is empty";
    if (file.size > MAX_FILE) return "The file is over 100 MB (the limit is 100,000,000 bytes). Compress it (lower resolution or bitrate) and add it again";
    return "";
  }

  const videosOf = (r) => r.videos || (r.video ? [r.video] : []);

  /** Whether the matched target exists in this parse (so a stray 99.png is reported, not stored). */
  function applies(m, parsed) {
    if (!m || !parsed) return false;
    if (m.kind === "scene") {
      const s = (parsed.scenes || []).find((x) => x.number === m.scene);
      return !!s && (m.media === "image" || !!s.hasVideo);
    }
    if (m.kind === "cover") return !!parsed.thumbnail;
    const r = (parsed.reels || []).find((x) => x.id === m.reel);
    if (!r) return false;
    if (m.kind === "reel-cover") return !!r.cover;
    if (m.kind === "reel-image") return m.index >= 1 && m.index <= (r.images || []).length;
    return m.index >= 1 && m.index <= videosOf(r).length;
  }

  /** Human text for messages: "Scene 04 image". */
  function describe(m) {
    if (m.kind === "scene") return "Scene " + pad(m.scene) + " " + m.media;
    if (m.kind === "cover") return "YouTube cover";
    if (m.kind === "reel-cover") return "Reel " + pad(m.reel) + " cover";
    return "Reel " + pad(m.reel) + (m.kind === "reel-image" ? " image " : " animation ") + m.index;
  }

  /** Path inside the export for a matched file. */
  function exportPath(m, ext) {
    const e = ext || m.ext;
    if (m.kind === "scene") return (m.media === "video" ? "Video/" : "Images/") + "Scene_" + pad(m.scene) + "." + e;
    if (m.kind === "cover") return "Images/Cover." + e;
    const dir = "Reels/Reel_" + pad(m.reel) + "/", r = "R" + pad(m.reel);
    if (m.kind === "reel-cover") return dir + r + "-cover." + e;
    if (m.kind === "reel-image") return dir + r + "-" + pad(m.index) + "." + e;
    return dir + r + "-video-" + m.index + "." + e;
  }

  /** The chunk a scene's narration sits in (the first 24 characters, whitespace ignored), or 0. */
  function chunkOfScene(scene, chunks) {
    const squash = (t) => String(t || "").replace(/\s+/g, "");
    const probe = squash(scene.narration).slice(0, 24);
    if (!probe) return 0;
    const c = (chunks || []).find((x) => squash(x.text).includes(probe));
    return c ? c.n : 0;
  }

  const audioName = (n, total, ext) => pad(n, Math.max(2, String(total).length)) + "_audio." + ext;

  /**
   * The edit-ready export: files to write and edit-list.csv rows.
   * proj: { parsed, audio, reelAudio, ext: { media } }; opts.includeVideos false leaves video files (and their names) out; opts.skip (a Set of item keys) leaves those files out.
   * Returns { files: [{ path, from: { type: "audio"|"media", key } }], rows }. rows[0] is the header.
   */
  function exportPlan(proj, opts) {
    opts = opts || {};
    const includeVideos = opts.includeVideos !== false;
    const parsed = proj.parsed || { chunks: [], scenes: [], reels: [] };
    const media = (proj.ext && proj.ext.media) || {};
    const files = [], rows = [["order", "scene", "chunk", "audio", "image", "video"]];
    const seen = new Set();
    const add = (path, from) => { if (!seen.has(path)) { seen.add(path); files.push({ path, from, bytes: from.bytes || 0 }); } return path; };
    const mediaPath = (m) => {
      const meta = media[m.key];
      if (!meta || (m.media === "video" && !includeVideos) || (opts.skip && opts.skip.has(m.key))) return "";
      return add(exportPath(m, extOf(meta.name) || m.ext), { type: "media", key: m.key, sk: serverKey(m.key, meta), bytes: meta.bytes || 0 });
    };
    const chunks = parsed.chunks || [];
    const audioPath = (n) => {
      const a = (proj.audio || {})[n];
      return a ? add("Audio/" + audioName(n, chunks.length, a.ext || "mp3"), { type: "audio", key: n, bytes: a.bytes || 0 }) : "";
    };
    // Every chunk's audio goes in, even when no scene points at it.
    chunks.forEach((c) => audioPath(c.n));
    let order = 0;
    (parsed.scenes || []).forEach((s) => {
      const n = chunkOfScene(s, chunks);
      rows.push([++order, "Scene " + pad(s.number), n ? pad(n) : "", n ? audioPath(n) : "",
        mediaPath({ key: "s-" + s.number + "-image", kind: "scene", media: "image", scene: s.number, ext: "png" }),
        s.hasVideo ? mediaPath({ key: "s-" + s.number + "-video", kind: "scene", media: "video", scene: s.number, ext: "mp4" }) : ""]);
    });
    if (parsed.thumbnail) {
      const p = mediaPath({ key: "yt-cover", kind: "cover", media: "image", ext: "png" });
      if (p) rows.push([++order, "YouTube cover", "", "", p, ""]);
    }
    (parsed.reels || []).forEach((r) => {
      const ra = (proj.reelAudio || {})[r.id];
      const rap = ra ? add("Reels/Reel_" + pad(r.id) + "/Reel_" + pad(r.id) + "_audio." + (ra.ext || "mp3"), { type: "audio", key: "reel:" + r.id, bytes: ra.bytes || 0 }) : "";
      (r.images || []).forEach((im, i) => rows.push([++order, im.label || "R" + pad(r.id) + "-" + pad(i + 1), "Reel " + pad(r.id), rap,
        mediaPath({ key: "r-" + r.id + "-image-" + (i + 1), kind: "reel-image", media: "image", reel: r.id, index: i + 1, ext: "png" }), ""]));
      videosOf(r).forEach((_, i) => rows.push([++order, "R" + pad(r.id) + " animation " + (i + 1), "Reel " + pad(r.id), "", "",
        mediaPath({ key: "r-" + r.id + "-video-" + (i + 1), kind: "reel-video", media: "video", reel: r.id, index: i + 1, ext: "mp4" })]));
      if (r.cover) {
        const p = mediaPath({ key: "r-" + r.id + "-cover", kind: "reel-cover", media: "image", reel: r.id, ext: "png" });
        if (p) rows.push([++order, "R" + pad(r.id) + " cover", "Reel " + pad(r.id), "", p, ""]);
      }
    });
    return { files, rows };
  }

  /** Total stored bytes of a project's originals (from ext.media), and per type. */
  function usage(proj) {
    const media = (proj.ext && proj.ext.media) || {};
    let bytes = 0, files = 0;
    Object.keys(media).forEach((k) => { if (media[k].stored) { bytes += media[k].bytes || 0; files++; } });
    return { bytes, files };
  }

  /** The files that belong to no item any more (proj.ext.orphans), biggest first, with their total. */
  function orphanList(proj) {
    const o = (proj.ext && proj.ext.orphans) || {};
    const list = Object.keys(o).map((sk) => Object.assign({ sk }, o[sk])).sort((a, b) => (b.bytes || 0) - (a.bytes || 0));
    return { list, bytes: list.reduce((n, x) => n + (x.bytes || 0), 0) };
  }

  /** Count of stored files flagged outdated (their item was edited after the file was added). */
  const outdatedCount = (proj) => Object.values((proj.ext && proj.ext.media) || {}).filter((m) => m.outdated).length;

  return { ACCEPT, fromKey, serverKey, newServerKey, slotCheck, orphanList, outdatedCount, TYPES, MAX_FILE, MAX_FILES, KEY_RE, extOf, typeOf, match, applies, describe, exportPath, chunkOfScene, exportPlan, usage };
});
