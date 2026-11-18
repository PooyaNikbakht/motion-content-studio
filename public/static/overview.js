/*
 * Per-project Overview: status, publishing info (title, channel, notes, YouTube link, publish date,
 * one link per reel) and a checklist summary built from the progress counts. Works in both modes and
 * only edits proj.info and proj.status; the caller saves through the storage adapter.
 * UMD: window.MBSOverview in the browser, require() in Node.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./progress.js"));
  else root.MBSOverview = factory(root.MBSProgress);
})(typeof self !== "undefined" ? self : this, function (G) {
  "use strict";

  const STATUSES = [["draft", "Draft", "Draft"], ["in_production", "In production", "In production"], ["ready", "Ready", "Ready"], ["published", "Published", "Published"]];
  const PLATFORMS = [["instagram", "Instagram"], ["tiktok", "TikTok"], ["youtube", "YouTube Shorts"], ["facebook", "Facebook"], ["other", "Other"]];
  const statusIndex = (s) => Math.max(0, STATUSES.findIndex((x) => x[0] === s));
  const statusLabel = (s) => STATUSES[statusIndex(s)][1];

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /** Empty is fine; anything else must be a well-formed https URL. */
  function validUrl(v) {
    const s = String(v || "").trim();
    if (!s) return true;
    try { return new URL(s).protocol === "https:"; } catch { return false; }
  }

  const reelsOf = (proj) => (proj.parsed && proj.parsed.reels) || [];

  /**
   * What is left to do, as lines { id, group, label, done, total, pct } (lines with nothing to do are left out).
   * Mirrors the progress shown on the YouTube and Reels tabs.
   */
  function checklist(proj) {
    const parsed = proj.parsed;
    if (!parsed) return [];
    const out = [];
    const line = (id, group, label, done, total) => { if (total > 0) out.push({ id, group, label, done, total, pct: G.pct(done, total) }); };
    const audio = proj.audio || {};
    const chunks = parsed.chunks || [];
    const c = G.counts(proj.progress || {}, parsed.scenes || []);
    line("yt-narration", "YouTube", "Narration audio generated", chunks.filter((x) => audio[x.n]).length, chunks.length);
    line("yt-images", "YouTube", "Scene images", c.image.done, c.image.total);
    line("yt-videos", "YouTube", "Scene videos", c.video.done, c.video.total);
    line("yt-scene-audio", "YouTube", "Scene audio", c.audio.done, c.audio.total);
    line("yt-cover", "YouTube", "Cover", proj.thumbnailDone ? 1 : 0, parsed.thumbnail ? 1 : 0);
    const reelAudio = proj.reelAudio || {};
    const rc = G.reelCounts(proj.reelProgress || {}, reelsOf(proj), (r) => !!reelAudio[r.id]);
    line("reel-images", "Reels", "Reel images", rc.image.done, rc.image.total);
    line("reel-videos", "Reels", "Reel videos", rc.video.done, rc.video.total);
    line("reel-covers", "Reels", "Reel covers", rc.cover.done, rc.cover.total);
    line("reel-audio", "Reels", "Reel audio", rc.audio.done, rc.audio.total);
    return out;
  }

  /** True when there is something to do and every audio, image, video and cover item is ticked. */
  function suggestReady(proj) {
    const items = checklist(proj);
    return items.length > 0 && items.every((i) => i.done === i.total);
  }

  /** A project's info with every field present and typed. Does not mutate the input. */
  function normalizeInfo(info) {
    const i = info || {};
    const str = (v) => (typeof v === "string" ? v : "");
    return {
      title: str(i.title), channel: str(i.channel), notes: str(i.notes), youtubeUrl: str(i.youtubeUrl), publishDate: str(i.publishDate),
      reels: Array.isArray(i.reels) ? i.reels.filter((r) => r && r.id !== undefined).map((r) => ({ id: r.id, url: str(r.url), platform: str(r.platform) || "instagram" })) : [],
    };
  }

  const fmtDate = (t) => (t ? new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "Not yet");

  // Dropdowns come from the app (ui.js ddHtml/ddInit) so they look and behave like every other one.
  // Without them (unit tests) the markup carries an inert placeholder; there are no native selects.
  const NO_DD = { html: (id) => '<div class="dd" id="' + id + '-dd"><button type="button" class="dd-btn" id="' + id + '"></button></div>', init: () => ({ set() {}, get: () => "" }) };

  /** The page markup (pure, so it can be tested without a DOM). dd: { html(id, label, cls) } */
  function html(proj, dd) {
    dd = dd || NO_DD;
    const info = normalizeInfo(proj.info);
    const status = STATUSES[statusIndex(proj.status)][0];
    const reels = reelsOf(proj);
    const items = checklist(proj);
    const ready = suggestReady(proj) && statusIndex(status) < statusIndex("ready");
    const field = (id, label, value, o) => {
      o = o || {};
      return '<div class="field"><label for="' + id + '">' + label + '</label><input id="' + id + '" class="input" type="' + (o.type || "text") + '" value="' + esc(value) + '"' + (o.ph ? ' placeholder="' + esc(o.ph) + '"' : "") + ' autocomplete="off" data-1p-ignore data-lpignore="true" data-form-type="other"' + (o.url ? ' inputmode="url" aria-describedby="' + id + '-err"' : "") + ">" +
        (o.url ? '<span class="hint ov-err" id="' + id + '-err" role="alert" hidden>Use a full link that starts with https://</span>' : "") + "</div>";
    };
    const byId = new Map(info.reels.map((r) => [String(r.id), r]));
    const reelRows = reels.map((r) => {
      const cur = byId.get(String(r.id)) || { url: "", platform: "instagram" };
      return '<div class="ov-reel" data-reel="' + esc(r.id) + '"><strong class="ov-reel-name">' + esc(r.name) + "</strong>" +
        '<div class="field"><label for="ov-rp-' + esc(r.id) + '">Platform</label>' + dd.html("ov-rp-" + r.id, "", "") + "</div>" +
        field("ov-ru-" + esc(r.id), "Link", cur.url, { url: true, ph: "https://" }).replace("<input ", "<input data-reel-url ") + "</div>";
    }).join("");
    const groups = ["YouTube", "Reels"].map((g) => {
      const rows = items.filter((i) => i.group === g);
      if (!rows.length) return "";
      return '<div class="ov-group"><h4 class="sec">' + g + "</h4>" + rows.map((i) =>
        '<div class="meter"><div class="meter-top"><span>' + (i.done === i.total ? "Done: " : "") + esc(i.label) + "</span><b>" + i.done + "/" + i.total + ' <span class="muted">' + i.pct + '%</span></b></div><div class="progress" role="progressbar" aria-label="' + esc(i.label) + ": " + i.done + " of " + i.total + '" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + i.pct + '"><div style="width:' + i.pct + '%"></div></div></div>').join("") + "</div>";
    }).join("");

    return '<div class="page ov"><header class="pagehead"><h2>Overview</h2><p>Where this project stands, and where it was published.</p></header>' +
      '<div class="notebar" id="ov-ready"' + (ready ? "" : " hidden") + '><span>Every audio, image, video and cover item is ticked off. Mark as Ready?</span><button type="button" class="btn sm" id="ov-mark">Mark as Ready</button></div>' +
      '<section class="panel" aria-labelledby="ov-h1"><div class="sec-head"><h3 class="sec" id="ov-h1">Status</h3></div>' +
      '<div class="grid2"><div class="field"><label for="ov-status">Status</label>' + dd.html("ov-status", "", "") + "</div>" +
      '<dl class="ov-dates"><div><dt class="muted small">Created</dt><dd>' + esc(fmtDate(proj.createdAt)) + '</dd></div><div><dt class="muted small">Last updated</dt><dd id="ov-updated">' + esc(fmtDate(proj.updatedAt)) + "</dd></div></dl></div></section>" +
      '<section class="panel" aria-labelledby="ov-h2"><div class="sec-head"><h3 class="sec" id="ov-h2">Publishing</h3></div><div class="grid2">' +
      field("ov-title", "Title", info.title, { ph: (proj.parsed && proj.parsed.youtubeTitle) || "" }) + field("ov-channel", "Channel", info.channel) +
      field("ov-yt", "YouTube link", info.youtubeUrl, { url: true, ph: "https://youtube.com/watch?v=..." }) + field("ov-date", "Publish date", info.publishDate, { type: "date" }) +
      '</div><div class="field" style="margin-top:16px"><label for="ov-notes">Notes</label><textarea id="ov-notes" class="input" rows="4" maxlength="5000" spellcheck="true">' + esc(info.notes) + "</textarea></div></section>" +
      (reels.length ? '<section class="panel" aria-labelledby="ov-h3"><div class="sec-head"><h3 class="sec" id="ov-h3">Reel links</h3></div><div class="ov-reels">' + reelRows + "</div></section>" : "") +
      '<section aria-labelledby="ov-h4"><div class="sec-head"><h3 class="sec" id="ov-h4">Checklist</h3></div>' +
      (items.length ? '<div class="panel ov-check">' + groups + "</div>" : '<p class="hint" style="margin:0">Nothing to track yet. Paste a conversation on Import &amp; Parse to see progress here.</p>') + "</section></div>";
  }

  /**
   * Draws the page into el and wires it. opts.save(proj) is called after each valid change
   * (links that are not https are shown as errors and not stored).
   */
  function render(el, proj, opts) {
    const save = (opts && opts.save) || (() => {});
    const dd = (opts && opts.dd) || NO_DD;
    el.innerHTML = html(proj, dd);
    const $ = (sel) => el.querySelector(sel);
    const commit = () => save(proj);
    const info = () => (proj.info = normalizeInfo(proj.info));
    const text = (sel, key) => {
      const n = $(sel);
      n.addEventListener("change", () => { info()[key] = n.value.trim(); commit(); });
    };
    const url = (n, apply) => {
      const check = () => { const ok = validUrl(n.value); n.setAttribute("aria-invalid", ok ? "false" : "true"); const e = el.querySelector("#" + n.id + "-err"); if (e) e.hidden = ok; return ok; };
      n.addEventListener("input", () => { if (n.getAttribute("aria-invalid") === "true") check(); });
      n.addEventListener("change", () => { if (check()) { apply(n.value.trim()); commit(); } });
    };
    const refreshBanner = () => { $("#ov-ready").hidden = !(suggestReady(proj) && statusIndex(proj.status) < statusIndex("ready")); };

    const statusOpts = STATUSES.map((x) => [x[0], x[1]]);
    const sdd = dd.init("ov-status", statusOpts, STATUSES[statusIndex(proj.status)][0], (v) => { proj.status = v; refreshBanner(); commit(); });
    $("#ov-mark").addEventListener("click", () => { proj.status = "ready"; sdd.set(statusOpts, "ready"); refreshBanner(); commit(); });
    text("#ov-title", "title"); text("#ov-channel", "channel"); text("#ov-date", "publishDate");
    $("#ov-notes").addEventListener("change", (e) => { info().notes = e.target.value; commit(); });
    url($("#ov-yt"), (v) => { info().youtubeUrl = v; });
    el.querySelectorAll(".ov-reel").forEach((row) => {
      const id = row.dataset.reel;
      const entry = () => {
        const list = info().reels;
        let r = list.find((x) => String(x.id) === id);
        if (!r) { r = { id: Number.isNaN(Number(id)) ? id : Number(id), url: "", platform: "instagram" }; list.push(r); }
        return r;
      };
      const cur = (info().reels.find((x) => String(x.id) === id) || {}).platform || "instagram";
      dd.init("ov-rp-" + id, PLATFORMS, cur, (v) => { entry().platform = v; commit(); });
      url(row.querySelector("[data-reel-url]"), (v) => { entry().url = v; });
    });
  }

  return { STATUSES, PLATFORMS, statusLabel, statusIndex, validUrl, checklist, suggestReady, normalizeInfo, html, render };
});
