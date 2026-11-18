/* Motion Content Studio UI. Runs in two modes: window.MBS_MODE = "app" or "demo". */
(function () {
  "use strict";

  const DEMO = window.MBS_MODE === "demo";
  const P = window.MBSParser;
  const A = window.MBSAudio;
  const G = window.MBSProgress;
  const T = window.MBSTree;
  const O = window.MBSOverview;
  const D = window.MBSDiff;
  const E = window.MBSEstimate;
  const Q = window.MBSQuality;
  const V = window.MBSVault;
  const QU = window.MBSQueue;
  const NX = window.MBSNext;
  const PR = window.MBSPrompts;
  const MM = window.MBSMedia;
  const GM = window.MBSGemini;
  const MBSD = window.MBSDirector;
  const MBSDR = window.MBSDirectorRun;
  const MBSG = window.MBSGuide;
  // /demo is fully local (and still saves each edit as it happens). /app keeps projects only on the server (remote-store.js): it loads
  // a project when it is opened and saves it when the person presses Save (Ctrl/Cmd+S) or one of the immediate actions below runs.
  const store = DEMO ? window.MBSStore.create("mbs_demo") : window.MBSRemoteStore.create("mbs_app");
  const root = document.getElementById("root");
  const vault = V.create({ demo: DEMO, prefix: DEMO ? "mbs_demo" : "mbs_app" });

  const LANGS = [
    ["fa", "Persian"], ["ar", "Arabic"], ["he", "Hebrew"], ["ur", "Urdu"], ["en", "English"], ["other", "Other (left to right)"],
  ];
  // Main tabs: Overview and Import & Parse on top, YouTube and Reels (three sub-tabs each) below. The hash mirrors them: #overview, #import, #youtube/audio, #reels/covers.
  const TABS = [
    ["overview", "Overview", "layout-dashboard"],
    ["setup", "Setup", "settings"],
    ["import", "Import & Parse", "file-text"],
    ["youtube", "YouTube (16:9)", "monitor-play", "h"],
    ["reels", "Reels (9:16)", "smartphone", "v"],
  ];
  const YT_SUBS = [["audio", "Audio", "audio-lines"], ["board", "Visual Board", "layout-grid"], ["covers", "Cover & SEO", "image"]];
  // YouTube has fixed sub-tabs; Reels has one per parsed reel (key = reel id, so the hash is #reels/1).
  const subsOf = (m) => (m === "youtube" ? YT_SUBS : m === "reels" ? reels().map((r) => [String(r.id), r.name, "smartphone"]) : null);
  const hasSubs = (m) => !!(subsOf(m) || []).length;
  const GAP_MS = DEMO ? 400 : 2000;
  const MAX_ATTEMPTS = 3;
  const STATUS_LABEL = { waiting: "Waiting", generating: "Generating...", saved: "Saved to disk", ready: "Ready (in browser)", error: "Error" };

  let settings = store.getSettings();
  let projects = [];
  let folders = [];
  let proj = null;
  let tab = "import";
  const subOf = { youtube: "audio", reels: "" };
  // Inside each reel: Audio | Visual Board | Cover & Captions. One choice for all reels, so Reel 01 > Visual Board then Reel 02 opens its Visual Board.
  const RSUBS = [["audio", "Audio", "audio-lines"], ["visual", "Visual Board", "layout-grid"], ["cover", "Cover & Captions", "image"]];
  let reelSub = "audio";
  const rt = { status: {}, errors: {}, urls: {}, dir: null, run: { active: false, stopping: false, abort: null, kind: "main" }, onlyAnim: false, boardFilter: "all", open: {}, settingsOpen: null, q: "", sbCollapsed: store.getSidebarCollapsed(), drawer: false, treeFocus: null, dragId: null, menu: null, sub: null, previews: {}, previewBusy: null, pipe: { running: false, timer: null }, ovr: null, tabId: null, thumbs: {}, origs: {}, uploads: {}, strays: null, warnedAllowance: false, warnedSoft: false, storage: null };
  try { rt.tabId = sessionStorage.getItem("mbs:tab") || (sessionStorage.setItem("mbs:tab", "t" + Math.random().toString(36).slice(2, 10)), sessionStorage.getItem("mbs:tab")); } catch { /* storage blocked */ }
  rt.tabId = rt.tabId || "t" + Math.random().toString(36).slice(2, 10);
  let copyList = [];
  let langDd = null, modelDd = null;
  const langOpts = () => [["auto", "Auto-detect (now: " + langName(P.detectLanguage(proj.text)) + ")"]].concat(LANGS);

  // ---------- small helpers ----------
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const $ = (sel, el) => (el || document).querySelector(sel);
  const $$ = (sel, el) => Array.from((el || document).querySelectorAll(sel));
  const icons = () => { if (window.lucide) window.lucide.createIcons(); };
  const icon = (name) => '<i data-lucide="' + name + '" aria-hidden="true"></i>';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const hash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(36) + ":" + s.length; };
  const pad = (n) => String(n).padStart(2, "0");
  // guide: id of the matching section in the full guide; adds a small "?" link beside the title.
  const pageHead = (title, text, guide) => '<header class="pagehead"><h2>' + esc(title) + (guide ? ' <button type="button" class="guide-help" data-guide="' + guide + '" aria-haspopup="dialog" aria-label="Open the guide for ' + esc(title) + '" title="Open the guide for ' + esc(title) + '">?</button>' : "") + "</h2><p>" + esc(text) + "</p></header>";
  const secHead = (label, extra) => '<div class="sec-head"><h3 class="sec">' + esc(label) + "</h3>" + (extra ? '<span class="small muted">' + extra + "</span>" : "") + "</div>";
  // Long text is clamped to 3 lines with a Show more toggle; the open state survives re-renders via rt.open.
  function clampHtml(id, text, extra, warm) {
    const long = text.length > 240 || text.split("\n").length > 3, open = !!rt.open[id];
    return '<div class="clamp ' + contentClass() + (extra ? " " + extra : "") + (long ? " long" : "") + (open ? " open" : "") + '" dir="' + dirAttr() + '">' + (warm ? warmHtml(text) : esc(text)) + "</div>" +
      (long ? '<button type="button" class="more" data-more="' + id + '" aria-expanded="' + open + '">' + (open ? "Show less" : "Show more") + "</button>" : "");
  }

  let toastTimer;
  function toast(msg, action, ms) {
    const t = $("#toast");
    t.textContent = msg;
    if (action) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "btn sm"; b.style.marginInlineStart = "12px"; b.textContent = action.label;
      b.onclick = () => { t.textContent = ""; action.run(); };
      t.append(b);
    }
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.textContent = ""), ms || 3500);
  }

  function lang() { return proj.lang === "auto" ? P.detectLanguage(proj.text) : proj.lang; }
  function langName(code) { const l = LANGS.find((x) => x[0] === code); return l ? l[1] : code; }
  // Pasted and generated text mixes scripts (English labels, Persian narration), so each paragraph picks its own direction.
  // The content language only chooses the font (see contentClass).
  function dirAttr() { return "auto"; }
  function contentClass() { return "content" + (["fa", "ar", "ur"].includes(lang()) ? " script-arabic" : ""); }
  // The phrase every chunk starts with. /demo falls back to the English sample phrase; /app uses only what the user saved
  // (set once in Setup), so there is no built-in phrase in a public file. Empty means no chunks are found, and the UI says so.
  // Per project (proj.ext.startPhrase, saved and exported with the project); the Setup default is only the fallback and the value new projects start from.
  const projPhrase = () => ((proj && proj.ext && proj.ext.startPhrase) || "").trim();
  function startPhrase() { return projPhrase() || settings.startPhrase.trim() || (DEMO ? P.DEFAULT_START_PHRASE : ""); }
  function setProjPhrase(v) { proj.ext = Object.assign({}, proj.ext, { startPhrase: v }); adSaveSoon(); }
  // The sample and the templates use the sample's phrase: set it for this project only, leaving the global default and the user's own phrase alone.
  function useSamplePhrase() { setProjPhrase(P.DEFAULT_START_PHRASE); rt.phraseNote = proj.id; }
  // No phrase in /app: say so where the phrase is set instead of quietly finding 0 chunks.
  function phraseNeeded() {
    rt.phraseErr = proj.id;
    const f = $("#phrase");
    if (tab === "import" && f) { const e = $("#phrase-err"); if (e) e.hidden = false; f.focus(); }
    else toast("Set the chunk start phrase (step 1) to find audio chunks.");
  }
  const chunks = () => (proj.parsed ? proj.parsed.chunks : []);
  const scenes = () => (proj.parsed ? proj.parsed.scenes : []);
  const prog = () => proj.progress || (proj.progress = {});
  const counts = () => G.counts(prog(), scenes());
  // Reels package (step 6). Old projects have none of these fields, so every accessor falls back to an empty value.
  const reels = () => (proj.parsed && proj.parsed.reels) || [];
  const reelsWithAudio = () => reels().filter((r) => r.audio);
  const rKey = (id) => "r" + id;
  const rprog = () => proj.reelProgress || (proj.reelProgress = {});

  // Leading start phrase rendered as a muted span (display only: the text sent to ElevenLabs and the counts stay whole).
  function warmHtml(text) {
    if (!settings.dimWarmup) return esc(text);
    const s = P.splitWarmup(text, startPhrase());
    return s.warm ? '<span class="warmup" title="Warm-up phrase. Still sent to ElevenLabs.">' + esc(s.warm) + "</span>" + esc(s.rest) : esc(text);
  }
  const dimToggle = () => '<label class="row small dimtoggle"><input type="checkbox" data-dim' + (settings.dimWarmup ? " checked" : "") + "> Dim warm-up phrase</label>";
  function bindDim(p) {
    $$("[data-dim]", p).forEach((box) => box.addEventListener("change", () => {
      settings.dimWarmup = box.checked;
      store.saveSettings(settings);
      renderTab();
      const again = $("[data-dim]");
      if (again) again.focus();
    }));
  }

  function copyBtn(text, label) {
    copyList.push(text);
    return '<button type="button" class="btn sm copybtn" data-copy="' + (copyList.length - 1) + '">' + icon("copy") + "<span>" + (label || "Copy") + "</span></button>";
  }

  /** Small icon-only copy button for a prompt label; bindCopy swaps the icon to a check for 1.5 s after a copy. */
  function copyIconBtn(text, label) {
    copyList.push(text);
    return '<button type="button" class="copyico" data-copy="' + (copyList.length - 1) + '" aria-label="' + esc(label) + '" title="' + esc(label) + '">' + icon("copy") + "</button>";
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back */ }
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { /* ignore */ }
    ta.remove();
    return ok;
  }

  function bindCopy(scope) {
    $$("[data-copy]", scope).forEach((b) => {
      b.addEventListener("click", async () => {
        const ok = await copyText(copyList[Number(b.dataset.copy)]);
        if (b.classList.contains("copyico")) {
          const before = b.innerHTML;
          b.dataset.state = ok ? "copied" : "";
          b.innerHTML = icon(ok ? "check" : "copy"); icons();
          toast(ok ? "Copied to the clipboard." : "Could not copy. Select the text and copy it by hand.");
          clearTimeout(b._t);
          b._t = setTimeout(() => { delete b.dataset.state; b.innerHTML = icon("copy"); icons(); }, 1500);
          return;
        }
        const span = $("span", b);
        const before = span.textContent;
        b.dataset.state = ok ? "copied" : "";
        span.textContent = ok ? "Copied" : "Copy failed";
        toast(ok ? "Copied to the clipboard." : "Could not copy. Select the text and copy it by hand.");
        setTimeout(() => { span.textContent = before; delete b.dataset.state; }, 1600);
      });
    });
  }

  // ---------- dropdown (button + listbox) ----------
  function ddHtml(id, label, cls) {
    return '<div class="dd ' + (cls || "") + '" id="' + id + '-dd">' +
      '<button type="button" class="dd-btn" id="' + id + '" aria-haspopup="listbox" aria-expanded="false" aria-controls="' + id + '-list"' + (label ? ' aria-label="' + esc(label) + '"' : "") + '><span class="dd-val"></span>' + icon("chevron-down") + "</button>" +
      '<ul class="dd-list" id="' + id + '-list" role="listbox" tabindex="-1" aria-label="' + esc(label || "Options") + '" hidden></ul></div>';
  }
  // Wires a dropdown rendered by ddHtml. options: [[value, label], ...]. Returns { set(options, value), get() }.
  function ddInit(id, options, value, onChange) {
    const wrap = $("#" + id + "-dd"), btn = $("#" + id), list = $("#" + id + "-list");
    let opts = options, val = value, active = -1;
    const idx = () => Math.max(0, opts.findIndex((o) => o[0] === val));
    const render = () => {
      const cur = opts.find((o) => o[0] === val) || opts[0];
      $(".dd-val", btn).textContent = cur ? cur[1] : "";
      list.innerHTML = opts.map((o, i) => '<li role="option" id="' + id + "-o" + i + '" data-i="' + i + '" aria-selected="' + (o[0] === val) + '">' + esc(o[1]) + "</li>").join("");
    };
    const mark = (i) => {
      active = Math.max(0, Math.min(opts.length - 1, i));
      $$("li", list).forEach((li, k) => li.classList.toggle("active", k === active));
      list.setAttribute("aria-activedescendant", id + "-o" + active);
      const li = $("#" + id + "-o" + active);
      if (li && li.scrollIntoView) li.scrollIntoView({ block: "nearest" });
    };
    const outside = (e) => { if (!wrap.contains(e.target)) close(false); };
    const open = () => {
      if (!list.hidden || btn.disabled) return;
      list.hidden = false; btn.setAttribute("aria-expanded", "true");
      mark(idx()); list.focus({ preventScroll: true });
      document.addEventListener("pointerdown", outside, true);
    };
    function close(back) {
      if (list.hidden) return;
      list.hidden = true; btn.setAttribute("aria-expanded", "false");
      document.removeEventListener("pointerdown", outside, true);
      if (back) btn.focus();
    }
    const pick = (i) => {
      const o = opts[i];
      close(true);
      if (!o || o[0] === val) return;
      val = o[0]; render(); onChange(val);
    };
    btn.addEventListener("click", () => (list.hidden ? open() : close(true)));
    btn.addEventListener("keydown", (e) => {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) { e.preventDefault(); open(); }
    });
    list.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") mark(active + 1);
      else if (e.key === "ArrowUp") mark(active - 1);
      else if (e.key === "Home") mark(0);
      else if (e.key === "End") mark(opts.length - 1);
      else if (e.key === "Enter" || e.key === " ") pick(active);
      else if (e.key === "Escape") close(true);
      else if (e.key === "Tab") { close(false); return; }
      else return;
      e.preventDefault();
      e.stopPropagation();
    });
    list.addEventListener("click", (e) => { const li = e.target.closest("li"); if (li) pick(+li.dataset.i); });
    list.addEventListener("mousemove", (e) => { const li = e.target.closest("li"); if (li && +li.dataset.i !== active) mark(+li.dataset.i); });
    render();
    return { set(o, v) { opts = o; val = v; render(); }, get: () => val };
  }

  // ---------- dialogs ----------
  // Actions: the confirm button (primary, or red when danger) and Cancel in one row; foot = optional rarely used actions as
  // low-emphasis links under a hairline: [{ label, value, danger }]. Resolves true (or the name), null for Cancel, or the foot value.
  function ask({ title, text, lines, input, confirm, danger, foot }) {
    return new Promise((resolve) => {
      const d = $("#dlg");
      const opener = document.activeElement;
      d.setAttribute("aria-labelledby", "dlg-title");
      d.innerHTML =
        '<form method="dialog"><h2 id="dlg-title">' + esc(title) + "</h2>" +
        (text ? '<p class="muted" style="margin:0 0 12px">' + esc(text) + "</p>" : "") +
        (lines && lines.length ? '<ul class="fmt-list" style="margin:0 0 4px">' + lines.map((l) => "<li>" + esc(l) + "</li>").join("") + "</ul>" : "") +
        (input !== undefined ? '<div class="field"><label for="dlg-in">Name</label><input id="dlg-in" class="input" maxlength="80" autocomplete="off" data-1p-ignore data-lpignore="true" data-form-type="other" value="' + esc(input) + '" required></div>' : "") +
        '<div class="dlg-actions"><button class="btn ' + (danger ? "danger" : "primary") + '" data-x="ok">' + esc(confirm) + '</button><button type="button" class="btn" data-x="cancel">Cancel</button></div>' +
        (foot && foot.length ? '<div class="dlg-foot">' + foot.map((f, i) => '<button type="button" class="linkact' + (f.danger ? " danger" : "") + '" data-foot="' + i + '">' + esc(f.label) + "</button>").join("") + "</div>" : "") + "</form>";
      const done = (v) => { d.close(); if (opener && opener.focus && document.contains(opener)) opener.focus(); resolve(v); };
      $('[data-x="cancel"]', d).onclick = () => done(null);
      $$("[data-foot]", d).forEach((b) => { b.onclick = () => done(foot[Number(b.dataset.foot)].value); });
      $("form", d).onsubmit = (e) => { e.preventDefault(); done(input !== undefined ? $("#dlg-in").value.trim() || null : true); };
      d.oncancel = (e) => { e.preventDefault(); done(null); };
      d.onclick = (e) => { if (e.target === d) done(null); };
      d.showModal();
      const f = $("#dlg-in", d);
      if (f) f.select();
    });
  }

  // ---------- saving (app) ----------
  // Two ways to change what the server holds. saveProject() is for edits (chips, text, notes, Overview fields, director settings): in /app it
  // only marks the open project as having unsaved changes, and the Save button sends it. persist() sends the whole project now; it is used
  // by Parse, each director reply, and generated audio (the file is already on the server, so the project must say so). In /demo both
  // write to the browser at once, as before. A project carries `version`; a save of a stale version is refused with 409 (see conflict below).
  const sv = { dirty: false, rev: 0, status: "clean", error: "", errStatus: 0, conflict: false, chain: Promise.resolve(), inflight: 0, setupDirty: false, setupStatus: "clean", setupError: "" };
  const draftPending = () => !DEMO && !!proj && getDraft() !== proj.text; // text typed in the paste box and not parsed yet
  const vaultDraftPending = () => !DEMO && vs.editing && vs.draft !== undefined && !!vs.state && vs.draft !== vs.state.text;
  const unsaved = () => !DEMO && !!proj && (sv.dirty || draftPending());
  const setupUnsaved = () => !DEMO && (sv.setupDirty || vaultDraftPending());
  const uploading = () => Object.keys(rt.uploads || {}).length > 0;
  // Used by beforeunload: anything that would be lost or cut short by leaving the page.
  const leaveBlocked = () => !DEMO && (unsaved() || setupUnsaved() || sv.inflight > 0 || sv.setupStatus === "saving" || uploading());

  function markDirty() {
    if (DEMO || !proj) return;
    sv.dirty = true; sv.rev++;
    if (sv.status !== "saving") sv.status = "clean";
    syncSave();
  }
  async function saveProject() {
    if (DEMO) { await store.putProject(proj); return; }
    markDirty();
  }

  // Sends P (default: the open project) to the server now. Resolves true when saved, false when not (the error or conflict is on screen).
  // Saves are queued one after another so two never race on the version.
  function persist(P, o) {
    P = P || proj;
    if (DEMO) return store.putProject(P).then(() => true, (e) => { toast("Could not save: " + e.message); return false; });
    const run = async () => {
      const cur = () => P === proj;
      if (cur() && sv.conflict && !(o && o.overwrite)) return false;
      const rev = sv.rev;
      sv.inflight++;
      if (cur()) { sv.status = "saving"; sv.error = ""; syncSave(); }
      try {
        await store.putProject(P, o);
        if (cur()) { if (rev === sv.rev) sv.dirty = false; sv.status = sv.dirty ? "clean" : "saved"; sv.conflict = false; sv.error = ""; sv.errStatus = 0; }
        return true;
      } catch (e) {
        if (!cur()) toast("Could not save \"" + P.name + "\": " + e.message);
        else {
          sv.dirty = true; // whatever was being saved is still only here
          if (e.status === 409) { sv.conflict = true; sv.status = "clean"; }
          else { sv.status = "error"; sv.error = e.message; sv.errStatus = e.status || 0; }
        }
        return false;
      } finally {
        sv.inflight--;
        if (cur()) { syncSave(); renderTree(); }
      }
    };
    const next = sv.chain.then(run, run);
    sv.chain = next.catch(() => {});
    return next;
  }
  const persistNow = () => persist(proj);

  // The header Save button and Ctrl/Cmd+S: unparsed pasted text goes through Parse first, then the project is saved, then Setup.
  async function saveNow() {
    if (DEMO || !proj) return true;
    if (draftPending() && !(await requestParse(getDraft()))) return false;
    if (sv.dirty || sv.status === "error") return persist(proj);
    return true;
  }
  async function saveSetup() {
    if (DEMO || sv.setupStatus === "saving") return true;
    sv.setupStatus = "saving"; sv.setupError = ""; syncSave();
    try {
      store.saveSettings(settings);
      if (vaultDraftPending()) { vs.state = await vault.save({ text: vs.draft, defaultText: vs.state.defaultText }); vs.editing = false; vs.draft = undefined; renderVault(); }
      sv.setupDirty = false; sv.setupStatus = "saved";
      return true;
    } catch (e) {
      sv.setupStatus = "error"; sv.setupError = e.message || "Could not save.";
      return false;
    } finally { syncSave(); }
  }
  async function saveEverything() {
    if (DEMO) return;
    const a = proj ? await saveNow() : true, b = setupUnsaved() ? await saveSetup() : true;
    if (a && b) toast("Saved.");
  }
  // Marks Setup as edited (keys, voice, model, rates, routing). In /demo these write straight away.
  function setupChanged() {
    if (DEMO) { store.saveSettings(settings); return; }
    sv.setupDirty = true;
    if (sv.setupStatus !== "saving") sv.setupStatus = "clean";
    syncSave();
  }

  // One sticky bar at the top of the content shows the state of the project, or of Setup while the Setup tab is open. The dot or check always comes with text so colour is never the only cue.
  function saveView(kind) {
    const setup = kind === "setup";
    const status = setup ? sv.setupStatus : sv.status, err = setup ? sv.setupError : sv.error;
    const dirty = setup ? setupUnsaved() : unsaved();
    if (status === "saving") return { label: "Saving...", disabled: true, note: "Saving...", state: "saving" };
    if (status === "error") return { label: "Retry", disabled: false, note: (setup ? "Not saved. " : "Not saved. ") + err, state: "error", signin: !setup && sv.errStatus === 401 };
    if (!setup && sv.conflict) return { label: "Save", disabled: true, note: "This project changed elsewhere. Reload to get the latest, or overwrite it with what you have here.", state: "error" };
    if (dirty) return { label: "Save", disabled: false, note: "Unsaved changes", state: "dirty" };
    if (status === "saved") return { label: "Saved", disabled: true, note: "All changes saved", state: "saved" };
    return { label: "Save", disabled: true, note: "All changes saved", state: "clean" };
  }
  function syncSave() {
    if (DEMO) return;
    const bar = $("#savebar");
    if (!bar) return;
    const setup = tab === "setup";
    bar.hidden = !setup && !proj;
    const v = saveView(setup ? "setup" : "project");
    bar.dataset.state = v.state;
    $("#save-ctx").hidden = !setup;
    const btn = $("#save-btn"), note = $("#save-note");
    btn.disabled = v.disabled;
    btn.dataset.state = v.state;
    btn.innerHTML = icon(v.state === "saving" ? "loader" : v.state === "saved" ? "check" : v.state === "error" ? "rotate-cw" : "save") + "<span>" + esc(v.label) + "</span>";
    note.dataset.state = v.state;
    note.setAttribute("role", v.state === "error" ? "alert" : "status");
    note.innerHTML = esc(v.note) + (v.signin ? ' <a href="/login" target="_blank" rel="noopener">Sign in</a>' : "");
    $("#conflict").hidden = setup || !sv.conflict;
    icons();
    const when = $(".ph-meta");
    if (when && proj) when.textContent = proj.updatedAt ? "Updated " + new Date(proj.updatedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "";
  }

  // 409: the server copy moved on (another tab or device saved it). Reload drops the local edits and loads the server copy; Overwrite saves this copy over it.
  async function conflictReload() {
    try { await loadProject(proj.id); } catch (e) { toast("Could not reload: " + e.message); return; }
    refreshAll();
    toast("Loaded the latest version from the server.");
  }
  async function conflictOverwrite() {
    if (await persist(proj, { overwrite: true })) toast("Saved. The other change was overwritten.");
  }

  // Leaving the open project (another project, a new one, an import): when it has unsaved changes ask Save / Discard / Cancel.
  // Returns { go, discard }; call afterLeave(result) once the next project is loaded.
  async function confirmLeave() {
    if (!unsaved()) return { go: true };
    const r = await ask({ title: "Unsaved changes", text: "\"" + proj.name + "\" has changes that are not saved to the server yet.", confirm: "Save", foot: [{ label: "Discard changes", danger: true, value: "discard" }] });
    if (r === "discard") return { go: true, discard: proj };
    if (r !== true) return { go: false };
    return { go: (await saveNow()) && !unsaved() };
  }
  async function afterLeave(l) {
    if (!l || !l.discard) return;
    try { localStorage.removeItem(store.prefix + ":draft:" + l.discard.id); } catch { /* blocked */ }
    try { projects = (await store.listProjects()).map((x) => (proj && x.id === proj.id ? proj : x)); renderTree(); } catch { /* the list refreshes on the next change */ }
  }

  // ---------- projects ----------
  // /app: the list holds summaries; opening a project loads it from the server (so what is on screen is never a stale local copy).
  async function loadProject(id) {
    const want = projects.find((p) => p.id === id) || projects[0];
    let full = want;
    if (!DEMO) {
      full = await store.getProject(want.id);
      if (!full) throw new Error("That project no longer exists on the server.");
      sv.dirty = false; sv.status = "clean"; sv.error = ""; sv.errStatus = 0; sv.conflict = false;
    }
    adLeave();
    projects = projects.map((p) => (p.id === full.id ? full : p));
    proj = full;
    store.setCurrent(proj.id);
    if (!proj.audio) proj.audio = {};
    if (!proj.reelAudio) proj.reelAudio = {};
    if (!proj.reelProgress) proj.reelProgress = {};
    if (!proj.status) proj.status = "draft";
    if (!proj.info) proj.info = {};
    if (!proj.ext) proj.ext = {};
    // Projects parsed before the Reels package, multi-prompt reels or reel covers existed: parse again to fill them in.
    if (proj.text && proj.parsed && (!proj.parsed.reels || proj.parsed.reels.some((r) => !r.videos || r.cover === undefined || r.caption === undefined) || proj.parsed.youtubeTitle === undefined)) {
      proj.parsed = P.parse(proj.text, { startPhrase: startPhrase() });
      proj.reelProgress = G.mergeReels(rprog(), reels());
      if (DEMO) await saveProject().catch(() => {}); // /app: not a person's edit, so it does not count as unsaved; it is redone on the next open
    }
    Object.values(rt.urls).forEach((u) => URL.revokeObjectURL(u));
    Object.values(rt.previews).forEach((u) => URL.revokeObjectURL(u));
    Object.values(rt.thumbs).forEach((u) => URL.revokeObjectURL(u));
    Object.values(rt.origs).forEach((u) => URL.revokeObjectURL(u));
    rt.urls = {}; rt.status = {}; rt.errors = {}; rt.previews = {}; rt.thumbs = {}; rt.origs = {}; rt.strays = null;
    rt.dir = null;
    try { rt.dir = (await store.getHandle(proj.id)) || null; } catch { /* handle not usable */ }
  }

  async function addProject(name, text, folderId) {
    const p = store.newProject(name);
    if (folderId) p.folderId = folderId;
    if (text) { p.text = text; p.parsed = P.parse(text, { startPhrase: startPhrase() }); }
    await store.putProject(p);
    projects.push(p);
    syncSave();
    return p;
  }

  // Earlier versions of the sample text (they lack the reel cover prompts). Matched by their opening line plus the missing label.
  const OLD_SAMPLES = [{ start: 'Director: Here is the full package for "The Lighthouse Keeper\'s Ledger"', lacks: /Reel Cover Prompt/i }];
  const isOldSample = (text) => { const t = (text || "").trim(); return OLD_SAMPLES.some((o) => t.startsWith(o.start) && !o.lacks.test(t)); };

  async function fetchSample() {
    const r = await fetch("/demo/sample-conversation.txt");
    if (!r.ok) throw new Error("sample not found");
    return r.text();
  }

  function guardRunning() {
    if (rt.run.active || rt.pipe.running) { toast("Stop audio generation first."); return true; }
    return false;
  }

  // ---------- shell ----------
  const logo = '<span class="mark" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#0B0F19" stroke-width="2.6" stroke-linecap="round"><path d="M4 8v8M9 5v14M14 9v6M19 7v10"/></svg></span>';

  // Main tabs in two rows: Import & Parse on top, the two workspaces (YouTube, Reels) nested under it. Every row stays visible on every screen.
  const tabBtn = (t) => '<button class="tab" role="tab" id="tab-' + t[0] + '" aria-controls="panel" data-tab="' + t[0] + '">' + icon(t[2]) + "<span>" + t[1] + "</span>" + (t[3] ? '<span class="badge plain tab-ratio ' + (t[3] === "h" ? "hbadge" : "vbadge") + '" aria-hidden="true"></span>' : "") + '<span class="count" id="count-' + t[0] + '"></span></button>';
  const tabRow = (label, list, cls) => '<div class="tabs' + cls + '" role="tablist" aria-label="' + label + '">' + list.map(tabBtn).join("") + "</div>";

  function renderShell() {
    root.innerHTML =
      '<a href="#panel" class="sr-only">Skip to content</a>' +
      '<header class="topbar" id="topbar"><div class="bar">' +
      '<button class="btn sm ghost iconbtn" id="sb-toggle" type="button" aria-controls="sidebar" aria-expanded="true" aria-label="Hide project list">' + icon("panel-left") + "</button>" +
      '<a class="brand" href="/">' + logo + '<span class="brand-name">Motion Content Studio</span></a>' +
      '<span class="bar-spacer"></span>' +
      '<button type="button" class="btn sm ghost" id="guide-open" aria-haspopup="dialog">' + icon("circle-help") + '<span class="hide-sm">Guide</span></button>' +
      '<button type="button" class="btn sm ghost" id="dp-open" aria-haspopup="dialog">' + icon("scroll-text") + '<span class="hide-sm">Director Prompt</span></button>' +
      (DEMO ? '<span class="demo-tag">Demo</span>' : '<div class="acct"><button type="button" class="btn sm ghost iconbtn acct-btn" id="acct-btn" aria-haspopup="menu" aria-expanded="false" aria-controls="acct-menu" aria-label="Account menu">' + icon("user-round") + '</button>' +
        '<div class="acct-menu" id="acct-menu" role="menu" aria-label="Account" hidden><a class="sb-mi" role="menuitem" tabindex="-1" href="/login?mode=change">' + icon("key-round") + '<span>Change password</span></a><a class="sb-mi" role="menuitem" tabindex="-1" href="/logout">' + icon("log-out") + '<span>Sign out</span></a></div></div>') +
      "</div></header>" +
      (DEMO ? '<div class="banner" role="note"><div class="wrap"><strong>Demo with fictional sample content.</strong> Audio generation is simulated: no API calls, and the files are short placeholder tones. Your data stays in this browser.</div></div>' : "") +
      '<div class="layout" id="layout">' +
      '<aside class="sidebar" id="sidebar" aria-label="Projects" data-open="true">' +
      '<div class="sb-head"><h2 class="sec">Projects</h2><span class="sb-count" id="sb-count"></span><button class="btn sm ghost iconbtn" id="sb-close" type="button" aria-label="Hide project list">' + icon("panel-left-close") + "</button></div>" +
      '<div class="sb-search">' + icon("search") + '<input id="sb-q" class="input" type="search" placeholder="Search projects" aria-label="Search projects" autocomplete="off" data-1p-ignore data-lpignore="true" data-form-type="other"></div>' +
      '<div class="sb-actions"><button class="btn primary" id="p-new" type="button">' + icon("plus") + 'New project</button><button class="btn sm" id="f-new" type="button">' + icon("folder-plus") + 'New folder</button><button class="btn sm" id="p-import" type="button">' + icon("upload") + 'Import</button><input type="file" id="p-file" accept=".zip,application/zip" hidden></div>' +
      '<div class="sb-tree" id="sb-tree" role="tree" aria-label="Projects and folders"></div>' +
      '<div class="sb-foot" id="sb-foot"></div>' +
      "</aside>" +
      '<div class="sb-scrim" id="sb-scrim" hidden></div>' +
      '<div class="content" id="content">' +
      (DEMO ? "" : '<div class="savebar" id="savebar" data-state="clean" hidden><div class="wrap savebar-in"><span class="save-ctx" id="save-ctx" hidden>Setup</span><span class="save-note" id="save-note" role="status" aria-live="polite"></span>' +
        '<span class="savebar-actions"><span class="conflict-actions" id="conflict" hidden><button type="button" class="btn sm" id="conflict-reload">' + icon("refresh-cw") + 'Reload latest</button><button type="button" class="btn sm danger" id="conflict-overwrite">Overwrite</button></span>' +
        '<button type="button" class="btn sm primary" id="save-btn"></button></span></div></div>') +
      '<main class="wrap">' +
      '<div class="projhead" id="projhead"></div>' +
      '<div class="tabs-host">' + tabRow("Project", TABS.slice(0, 3), "") + tabRow("Workspaces", TABS.slice(3), " tabs-ws") +
      '</div><div id="runstat" class="runstat" role="status" aria-live="polite" hidden><span id="runstat-text"></span><button type="button" class="btn sm" data-stop>Stop</button></div><div id="nextbar" class="nextbar" role="region" aria-label="Next step" hidden></div><div id="pipe" class="pipe" role="region" aria-label="Generate everything" hidden></div><div id="panel" role="tabpanel" tabindex="-1"></div></main>' +
      '<footer class="footer"><div class="wrap"><span>' +
      (DEMO ? 'Fictional content. Demo by <a href="https://pooya.website">Pooya Nikbakht</a>.' : "Motion Content Studio. Projects and audio live on the server and are saved when you press Save (Ctrl or Cmd+S). The API key stays in this browser.") +
      '</span><span><a href="/">Home</a>' + (DEMO ? ' &middot; <a href="https://github.com/PooyaNikbakht/motion-content-studio">Source</a>' : "") + "</span></div></footer></div></div>" +
      '<dialog id="fmt-dlg" class="fmt-dlg" aria-label="Input format guide"><div class="fmt-dlg-bar"><strong>Input format guide</strong><button type="button" class="btn sm" id="fmt-close">' + icon("x") + 'Close</button></div><div id="fmt-body" class="fmt page"><p class="muted">Loading the guide...</p></div></dialog>' +
      '<dialog id="guide-dlg" class="fmt-dlg guide-dlg" aria-labelledby="guide-title"><div class="fmt-dlg-bar"><strong id="guide-title">' + esc(MBSG.GUIDE.title) + '</strong><button type="button" class="btn sm" id="guide-close">' + icon("x") + 'Close</button></div><div id="guide-body" class="guide">' + MBSG.html({ demo: DEMO }) + "</div></dialog>" +
      '<dialog id="dp-dlg" class="fmt-dlg dp-dlg" aria-label="Director Prompt"><div class="fmt-dlg-bar"><strong>Director Prompt</strong><button type="button" class="btn sm" id="dp-close">' + icon("x") + 'Close</button></div><div id="dp-body" class="dp"></div></dialog>' +
      '<dialog id="dlg" aria-modal="true"></dialog><div id="toast" class="toast" role="status" aria-live="polite"></div>';

    if (!DEMO) {
      $("#save-btn").addEventListener("click", () => (tab === "setup" ? saveSetup() : saveNow()));
      $("#conflict-reload").addEventListener("click", conflictReload);
      $("#conflict-overwrite").addEventListener("click", conflictOverwrite);
    }
    $$(".tab").forEach((b) => {
      b.addEventListener("click", () => setTab(b.dataset.tab));
      b.addEventListener("keydown", (e) => {
        const ids = TABS.map((t) => t[0]);
        let i = ids.indexOf(b.dataset.tab);
        if (e.key === "ArrowRight") i = (i + 1) % ids.length;
        else if (e.key === "ArrowLeft") i = (i - 1 + ids.length) % ids.length;
        else if (e.key === "Home") i = 0;
        else if (e.key === "End") i = ids.length - 1;
        else return;
        e.preventDefault();
        setTab(ids[i]);
        $("#tab-" + ids[i]).focus();
      });
    });
    $("#runstat").addEventListener("click", (e) => { if (e.target.closest("[data-stop]")) stopQueue(); });
    $("#nextbar").addEventListener("click", (e) => { if (e.target.closest("#next-go")) goNext(); });
    $("#pipe").addEventListener("click", (e) => { const b = e.target.closest("[data-pipe]"); if (b) pipeAction(b.dataset.pipe); });

    $("#panel").addEventListener("click", (e) => {
      const b = e.target.closest("[data-more]");
      if (!b) return;
      const open = b.getAttribute("aria-expanded") !== "true";
      rt.open[b.dataset.more] = open;
      b.setAttribute("aria-expanded", String(open));
      b.textContent = open ? "Show less" : "Show more";
      b.previousElementSibling.classList.toggle("open", open);
    });

    bindSlots();
    bindSidebar();
    applySidebar();
    bindFormat();
    bindVault();
    if (!DEMO) bindAccount();
  }

  // Account menu under the avatar button (app only): Change password and Sign out. Arrow keys move, Esc and outside clicks close it.
  function bindAccount() {
    const btn = $("#acct-btn"), menu = $("#acct-menu");
    if (!btn || !menu) return;
    const items = () => $$('[role="menuitem"]', menu);
    const outside = (e) => { if (!menu.contains(e.target) && !btn.contains(e.target)) close(false); };
    function close(back) {
      if (menu.hidden) return;
      menu.hidden = true;
      btn.setAttribute("aria-expanded", "false");
      document.removeEventListener("pointerdown", outside, true);
      if (back) btn.focus();
    }
    const open = (last) => {
      menu.hidden = false;
      btn.setAttribute("aria-expanded", "true");
      document.addEventListener("pointerdown", outside, true);
      const l = items();
      l[last ? l.length - 1 : 0].focus();
    };
    btn.addEventListener("click", () => { if (menu.hidden) open(false); else close(true); });
    btn.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); open(false); }
      else if (e.key === "ArrowUp") { e.preventDefault(); open(true); }
    });
    menu.addEventListener("keydown", (e) => {
      const l = items(), i = l.indexOf(document.activeElement);
      if (e.key === "ArrowDown") { e.preventDefault(); l[(i + 1) % l.length].focus(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); l[(i - 1 + l.length) % l.length].focus(); }
      else if (e.key === "Home") { e.preventDefault(); l[0].focus(); }
      else if (e.key === "End") { e.preventDefault(); l[l.length - 1].focus(); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(true); }
      else if (e.key === "Tab") close(false);
    });
  }

  // ---------- sidebar: projects and folders ----------
  const mq = window.matchMedia ? window.matchMedia("(max-width: 899px)") : null;
  const isMobile = () => !!(mq && mq.matches);
  const sbOpen = () => (isMobile() ? rt.drawer : !rt.sbCollapsed);
  const keyOf = (kind, id) => (kind === "folder" ? "f:" : "p:") + id;
  const folderById = (id) => folders.find((f) => f.id === id);
  const projectById = (id) => projects.find((p) => p.id === id);

  function applySidebar() {
    const open = sbOpen(), mobile = isMobile(), aside = $("#sidebar"), t = $("#sb-toggle");
    aside.dataset.open = String(open);
    aside.toggleAttribute("inert", !open);
    if (mobile && open) { aside.setAttribute("role", "dialog"); aside.setAttribute("aria-modal", "true"); }
    else { aside.removeAttribute("role"); aside.removeAttribute("aria-modal"); }
    // While the drawer is open the rest of the page is inert, so focus stays inside it.
    ["topbar", "content"].forEach((id) => $("#" + id).toggleAttribute("inert", mobile && open));
    $("#sb-scrim").hidden = !(mobile && open);
    $("#sb-close").setAttribute("aria-label", mobile ? "Close project list" : "Hide project list");
    t.setAttribute("aria-expanded", String(open));
    t.setAttribute("aria-label", open ? "Hide project list" : "Show project list");
  }

  function openDrawer() { rt.drawer = true; applySidebar(); $("#sb-q").focus(); }
  function closeDrawer(back) {
    if (!rt.drawer) return;
    rt.drawer = false;
    applySidebar();
    if (back) $("#sb-toggle").focus();
  }
  function toggleSidebar() {
    if (isMobile()) { if (rt.drawer) closeDrawer(true); else openDrawer(); return; }
    rt.sbCollapsed = !rt.sbCollapsed;
    store.setSidebarCollapsed(rt.sbCollapsed);
    applySidebar();
  }

  // Sidebar rows show the status as a dot (the label is read by screen readers and in the tooltip).
  const statusDot = (s) => '<span class="st-badge dot" data-status="' + esc(O.STATUSES[O.statusIndex(s)][0]) + '" title="Status: ' + esc(O.statusLabel(s)) + '"><i aria-hidden="true"></i><span class="sr-only">' + esc(O.statusLabel(s)) + "</span></span>";
  // Status dot plus a short label, so the state is never colour only.
  const statusBadge = (s) => '<span class="st-badge" data-status="' + esc(O.STATUSES[O.statusIndex(s)][0]) + '" title="Status: ' + esc(O.statusLabel(s)) + '"><i aria-hidden="true"></i>' + esc(O.STATUSES[O.statusIndex(s)][2]) + "</span>";

  function treeRowHtml(kind, o, level, active) {
    const key = keyOf(kind, o.id), tab0 = key === rt.treeFocus ? "0" : "-1";
    const menu = '<button type="button" class="tr-menu" tabindex="-1" data-menu aria-haspopup="menu" aria-label="Actions for ' + esc(o.name) + '">' + icon("more-horizontal") + "</button>";
    const base = '<div class="tr" role="treeitem" id="tr-' + (kind === "folder" ? "f-" : "p-") + o.id + '" data-key="' + key + '" data-kind="' + kind + '" data-id="' + o.id + '" aria-level="' + level + '" tabindex="' + tab0 + '"';
    if (kind === "folder") {
      return base + ' aria-expanded="' + o.expanded + '"' + (o.projects.some((p) => p.id === (proj && proj.id)) ? ' data-has-active="true"' : "") + ">" +
        icon(o.expanded ? "chevron-down" : "chevron-right") + icon(o.expanded ? "folder-open" : "folder") +
        '<span class="tr-name">' + esc(o.name) + '</span><span class="tr-count" title="' + o.total + ' project(s)">' + o.total + "</span>" + menu + "</div>";
    }
    return base + ' aria-selected="' + active + '" draggable="true"' + (active ? ' data-active="true"' : "") + ">" +
      icon("file-text") + '<span class="tr-name">' + esc(o.name) + "</span>" + statusDot(o.status) + menu + "</div>";
  }

  function renderTree() {
    const host = $("#sb-tree");
    if (!host) return;
    const inTree = document.activeElement && host.contains(document.activeElement) ? document.activeElement.closest(".tr") : null;
    const t = T.buildTree(folders, projects, rt.q);
    const act = (p) => !!proj && p.id === proj.id;
    const rows = [];
    t.folders.forEach((f) => {
      rows.push(["folder", f, 1]);
      if (f.expanded) f.projects.forEach((p) => rows.push(["project", p, 2]));
    });
    t.root.forEach((p) => rows.push(["project", p, 1]));
    const keys = rows.map((r) => keyOf(r[0], r[1].id));
    if (!keys.includes(rt.treeFocus)) rt.treeFocus = (proj && keys.includes(keyOf("project", proj.id)) ? keyOf("project", proj.id) : keys[0]) || null;
    const html = rows.map((r) => treeRowHtml(r[0], r[1], r[2], r[0] === "project" && act(r[1]))).join("");
    host.innerHTML = html + (t.empty ? '<p class="hint sb-empty" role="status">' + (rt.q.trim() ? 'No projects match "' + esc(rt.q.trim()) + '".' : "No projects yet.") + "</p>" : "") +
      '<div class="sb-rootdrop" aria-hidden="true">Drop here to move to the top level</div>';
    const n = projects.length;
    $("#sb-count").textContent = String(n);
    $("#sb-foot").textContent = n + (n === 1 ? " project. " : " projects. ") + (DEMO ? "Stored in this browser." : "Saved to your account.") + (rt.storage ? " " + storageShort() : "");
    $("#sb-foot").classList.toggle("warn-text", !!(rt.storage && storageNear()));
    renderProjHead();
    icons();
    if (inTree) { const again = $('[data-key="' + inTree.dataset.key + '"]', host); if (again) again.focus(); }
  }

  function focusRow(key) {
    rt.treeFocus = key;
    renderTree();
    const r = $('[data-key="' + key + '"]', $("#sb-tree"));
    if (r) r.focus();
  }

  async function selectProject(id) {
    if (guardRunning()) return;
    if (!proj || id !== proj.id) {
      const l = await confirmLeave();
      if (!l.go) return;
      try { await loadProject(id); } catch (e) { toast("Could not open that project: " + e.message); return; }
      await afterLeave(l);
      if (tab === "import" || tab === "overview") { tab = landingTab(); syncNav(true); }
      refreshAll();
    }
    if (isMobile() && rt.drawer) { closeDrawer(false); $("#panel").focus(); }
  }

  async function createProject(folderId) {
    if (guardRunning()) return;
    const name = await ask({ title: "New project", input: "Untitled project", confirm: "Create" });
    if (!name) return;
    const f = folderId && folderById(folderId);
    let p;
    const l = await confirmLeave();
    if (!l.go) return;
    try {
      if (f && f.collapsed) { await store.putFolder(Object.assign({}, f, { collapsed: false })); f.collapsed = false; }
      p = await addProject(name, "", folderId);
      await loadProject(p.id);
    } catch (e) { toast("Could not create the project: " + e.message); return; }
    await afterLeave(l);
    tab = "import";
    syncNav();
    rt.treeFocus = keyOf("project", p.id);
    refreshAll();
    if (isMobile() && rt.drawer) closeDrawer(false);
  }

  async function createFolder() {
    const name = await ask({ title: "New folder", input: "New folder", confirm: "Create" });
    if (!name) return;
    const f = store.newFolder(name);
    try { await store.putFolder(f); } catch (e) { toast("Could not create the folder: " + e.message); return; }
    folders.push(f);
    focusRow(keyOf("folder", f.id));
  }

  // Page title above the tabs: the project name (click or pencil to rename in place), its status and when it was updated.
  function renderProjHead() {
    const h = $("#projhead");
    if (!h || (h.querySelector("input"))) return;
    if (!proj) { h.innerHTML = ""; return; }
    const when = proj.updatedAt ? new Date(proj.updatedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "";
    h.innerHTML = '<div class="ph-row"><h1 class="ph-title"><button type="button" class="ph-name" id="ph-name" title="' + esc(proj.name) + '" aria-label="Rename project: ' + esc(proj.name) + '"><span>' + esc(proj.name) + "</span>" + icon("pencil") + "</button></h1>" + statusBadge(proj.status) + (DEMO ? "" : '<button type="button" class="btn sm" id="share-open" aria-haspopup="dialog">' + icon("share-2") + "Share</button>") + "</div>" +
      '<p class="ph-meta">' + (when ? "Updated " + esc(when) : "") + "</p>";
    icons();
    $("#ph-name").addEventListener("click", () => editTitle());
    const sh = $("#share-open", h);
    if (sh) sh.addEventListener("click", openShare);
    syncSave();
  }

  function editTitle() {
    const h = $("#projhead"), row = $(".ph-row", h);
    if (!proj || !row || $("input", row)) return;
    const input = document.createElement("input");
    input.className = "input ph-input"; input.value = proj.name; input.maxLength = 80; input.setAttribute("aria-label", "Project name");
    input.setAttribute("data-1p-ignore", ""); input.autocomplete = "off";
    const btn = $("#ph-name"), holder = btn.parentElement;
    holder.replaceChild(input, btn);
    input.focus(); input.select();
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      if (save && name && name !== proj.name) await patchMeta(proj, { name });
      input.remove();
      refreshAll();
      const b = $("#ph-name"); if (b) b.focus();
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); finish(true); } else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); } });
    input.addEventListener("blur", () => finish(true));
  }

  // Rename or move a project on the server without sending the rest of it (the open project may have unsaved edits). Returns true when done.
  // Another save moving the version in between leaves the local version stale on purpose, so the next Save reports the conflict.
  async function patchMeta(o, fields) {
    try {
      const r = await store.patchProject(o.id, fields);
      Object.assign(o, fields);
      if (r && r.version !== undefined) { if (!o.version || r.version === o.version + 1) o.version = r.version; }
      return true;
    } catch (e) { toast("Could not save that change: " + e.message); return false; }
  }

  async function renameItem(kind, id) {
    const o = kind === "folder" ? folderById(id) : projectById(id);
    if (!o) return;
    const name = await ask({ title: kind === "folder" ? "Rename folder" : "Rename project", input: o.name, confirm: "Save" });
    if (!name) return;
    if (kind === "folder") {
      const prev = o.name;
      o.name = name;
      try { await store.putFolder(o); } catch (e) { o.name = prev; toast("Could not rename: " + e.message); }
    } else await patchMeta(o, { name });
    refreshAll();
    focusRow(keyOf(kind, id));
  }

  async function deleteProjectItem(id) {
    if (guardRunning()) return;
    const p = projectById(id);
    if (!p) return;
    const ok = await ask({ title: "Delete project?", text: "\"" + p.name + "\" and its generated audio will be removed" + (DEMO ? " from this browser" : " from the server and this browser") + ". Files already saved to your folder stay there.", confirm: "Delete", danger: true });
    if (!ok) return;
    try {
      await store.deleteProject(id);
      projects = projects.filter((x) => x.id !== id);
      if (!projects.length) await addProject("My project");
      if (proj && proj.id === id) await loadProject(projects[0].id);
    } catch (e) { toast("Could not delete the project: " + e.message); renderTree(); return; }
    refreshAll();
  }

  async function deleteFolderItem(id) {
    const f = folderById(id);
    if (!f) return;
    const n = T.countIn(projects, id);
    const ok = await ask({ title: "Delete folder?", text: "\"" + f.name + "\" will be removed." + (n ? " Its " + n + " project" + (n === 1 ? "" : "s") + " will move to the top level. No projects are deleted." : " It has no projects."), confirm: "Delete folder", danger: true });
    if (!ok) return;
    try { await store.deleteFolder(id); } catch (e) { toast("Could not delete the folder: " + e.message); return; }
    const r = T.deleteFolder(folders, projects, id);
    folders = r.folders;
    r.projects.forEach((np, i) => { projects[i].folderId = np.folderId; });
    refreshAll();
    toast(n ? "Folder deleted. " + n + " project" + (n === 1 ? "" : "s") + " moved to the top level." : "Folder deleted.");
  }

  async function moveProjectTo(id, folderId) {
    const p = projectById(id);
    if (!p) return;
    const moved = T.moveProject(projects, id, folderId, folders).find((x) => x.id === id);
    if (moved.folderId === (p.folderId || null)) return;
    if (!(await patchMeta(p, { folderId: moved.folderId }))) return;
    const f = moved.folderId && folderById(moved.folderId);
    if (f && f.collapsed) { f.collapsed = false; try { await store.putFolder(f); } catch { /* shown as collapsed on the next load */ } }
    renderTree();
    toast("Moved \"" + p.name + "\" to " + (f ? f.name : "the top level") + ".");
  }

  async function toggleFolder(id, want) {
    const f = folderById(id);
    if (!f || rt.q.trim()) return;
    const collapsed = want === undefined ? !f.collapsed : !want;
    if (collapsed === !!f.collapsed) return;
    f.collapsed = collapsed;
    renderTree();
    try { await store.putFolder(f); } catch { /* state shown, saved on the next change */ }
  }

  // ---------- export and import (a .mbsproj.zip through the storage adapter, both modes) ----------
  async function exportProjectItem(id) {
    const p0 = projectById(id);
    if (!p0) return;
    try {
      const p = proj && proj.id === id ? proj : (await store.getProject(id)) || p0; // the list holds summaries in /app
      const r = await window.MBSProjectIO.exportProject(store, p, folders);
      toast("Exported " + r.name + (r.missing.length ? ". Audio not available: " + r.missing.join(", ") + "." : "."));
    } catch (e) { toast("Could not export: " + e.message); }
  }

  function pickImport(folderId) {
    if (guardRunning()) return;
    rt.importInto = folderId;
    $("#p-file").click();
  }

  async function importProjectFile(file, folderId) {
    const l = await confirmLeave();
    if (!l.go) return;
    try {
      const r = await window.MBSProjectIO.importFile(store, file, { projects, folders, folderId: folderId || null });
      if (r.folder && !folderById(r.folder.id)) folders.push(r.folder);
      projects.push(r.project);
      await loadProject(r.project.id);
      await afterLeave(l);
      tab = landingTab();
      syncNav();
      refreshAll();
      toast("Imported \"" + r.project.name + "\" as a new project." + (r.skipped.length ? " Skipped: " + r.skipped.join(", ") + "." : ""));
    } catch (e) { toast(e.message || "Could not import that file."); }
  }

  // ---------- "..." menu ----------
  function closeMenu(back) {
    const m = rt.menu;
    if (!m) return;
    rt.menu = null;
    m.el.remove();
    document.removeEventListener("pointerdown", m.outside, true);
    if (back && m.opener && document.contains(m.opener)) m.opener.focus();
  }

  function openMenu(anchor, items, opener) {
    const prev = rt.menu;
    if (prev) { prev.el.remove(); document.removeEventListener("pointerdown", prev.outside, true); rt.menu = null; }
    const el = document.createElement("div");
    el.className = "sb-menu";
    el.setAttribute("role", "menu");
    el.innerHTML = items.map((it, i) => '<button type="button" role="menuitem" class="sb-mi' + (it.danger ? " danger" : "") + '" data-i="' + i + '"' + (it.current ? ' aria-current="true"' : "") + ">" + (it.icon ? icon(it.icon) : "") + "<span>" + esc(it.label) + "</span>" + (it.current ? icon("check") : "") + "</button>").join("");
    document.body.appendChild(el);
    icons();
    const r = anchor.getBoundingClientRect();
    const w = el.offsetWidth, h = el.offsetHeight;
    el.style.left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)) + "px";
    el.style.top = (r.bottom + 4 + h > window.innerHeight ? Math.max(8, r.top - h - 4) : r.bottom + 4) + "px";
    const m = { el, opener: opener || anchor, outside: (e) => { if (!el.contains(e.target)) closeMenu(false); } };
    rt.menu = m;
    document.addEventListener("pointerdown", m.outside, true);
    const btns = $$(".sb-mi", el);
    const focusAt = (i) => btns[(i + btns.length) % btns.length].focus();
    el.addEventListener("click", (e) => {
      const b = e.target.closest(".sb-mi");
      if (!b) return;
      const it = items[Number(b.dataset.i)];
      if (it.submenu) { openMenu(anchor, it.submenu(), m.opener); return; }
      closeMenu(false);
      it.run();
    });
    el.addEventListener("keydown", (e) => {
      const i = btns.indexOf(document.activeElement);
      if (e.key === "ArrowDown") focusAt(i + 1);
      else if (e.key === "ArrowUp") focusAt(i - 1);
      else if (e.key === "Home") focusAt(0);
      else if (e.key === "End") focusAt(btns.length - 1);
      else if (e.key === "Escape") closeMenu(true);
      else if (e.key === "Tab") closeMenu(true);
      else return;
      e.preventDefault();
      e.stopPropagation();
    });
    focusAt(0);
  }

  function menuFor(row, anchor) {
    const kind = row.dataset.kind, id = row.dataset.id;
    if (kind === "folder") {
      return openMenu(anchor, [
        { label: "New project here", icon: "plus", run: () => createProject(id) },
        { label: "Rename", icon: "pencil", run: () => renameItem("folder", id) },
        { label: "Import project here...", icon: "upload", run: () => pickImport(id) },
        { label: "Delete folder", icon: "trash-2", danger: true, run: () => deleteFolderItem(id) },
      ], row);
    }
    const p = projectById(id);
    const moveItems = () => [{ label: "Back", icon: "arrow-left", submenu: () => menuItems(), }, { label: "No folder", icon: "folder-x", current: !p.folderId, run: () => moveProjectTo(id, null) }]
      .concat(folders.slice().sort(T.byName).map((f) => ({ label: f.name, icon: "folder", current: p.folderId === f.id, run: () => moveProjectTo(id, f.id) })));
    const menuItems = () => [
      { label: "Rename", icon: "pencil", run: () => renameItem("project", id) },
      { label: "Move to...", icon: "folder-input", submenu: moveItems },
      { label: "Export project", icon: "download", run: () => exportProjectItem(id) },
      { label: "Import project...", icon: "upload", run: () => pickImport(p.folderId || null) },
      { label: "Delete", icon: "trash-2", danger: true, run: () => deleteProjectItem(id) },
    ];
    openMenu(anchor, menuItems(), row);
  }

  // ---------- sidebar events ----------
  function bindSidebar() {
    const host = $("#sb-tree");
    $("#sb-toggle").addEventListener("click", toggleSidebar);
    $("#sb-close").addEventListener("click", () => (isMobile() ? closeDrawer(true) : toggleSidebar()));
    $("#sb-scrim").addEventListener("click", () => closeDrawer(true));
    $("#p-new").addEventListener("click", () => createProject(null));
    $("#f-new").addEventListener("click", createFolder);
    $("#p-import").addEventListener("click", () => pickImport(null));
    $("#p-file").addEventListener("change", (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) importProjectFile(f, rt.importInto); });
    $("#sb-q").addEventListener("input", (e) => { rt.q = e.target.value; renderTree(); });
    $("#sb-q").addEventListener("keydown", (e) => {
      if (e.key === "Escape" && e.target.value) { e.target.value = ""; rt.q = ""; renderTree(); e.stopPropagation(); }
      else if (e.key === "ArrowDown") { const r = $(".tr", host); if (r) { e.preventDefault(); r.focus(); } }
    });
    if (mq && mq.addEventListener) mq.addEventListener("change", () => { rt.drawer = false; applySidebar(); });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && rt.drawer && !rt.menu && !$("#dlg").open) closeDrawer(true);
    });

    host.addEventListener("click", (e) => {
      const row = e.target.closest(".tr");
      if (!row) return;
      const mb = e.target.closest("[data-menu]");
      if (mb) { menuFor(row, mb); return; }
      rt.treeFocus = row.dataset.key;
      if (row.dataset.kind === "folder") toggleFolder(row.dataset.id); else selectProject(row.dataset.id);
    });
    host.addEventListener("contextmenu", (e) => {
      const row = e.target.closest(".tr");
      if (!row) return;
      e.preventDefault();
      menuFor(row, $("[data-menu]", row));
    });
    host.addEventListener("focusin", (e) => {
      const row = e.target.closest(".tr");
      if (!row || row.dataset.key === rt.treeFocus) return;
      rt.treeFocus = row.dataset.key;
      $$(".tr", host).forEach((r) => (r.tabIndex = r === row ? 0 : -1));
    });
    host.addEventListener("keydown", (e) => {
      const row = e.target.closest(".tr");
      if (!row || e.target !== row) return;
      const rows = $$(".tr", host), i = rows.indexOf(row), kind = row.dataset.kind, id = row.dataset.id;
      const go = (k) => { const r = rows[Math.max(0, Math.min(rows.length - 1, k))]; if (r) r.focus(); };
      const expanded = row.getAttribute("aria-expanded") === "true";
      if (e.key === "ArrowDown") go(i + 1);
      else if (e.key === "ArrowUp") go(i - 1);
      else if (e.key === "Home") go(0);
      else if (e.key === "End") go(rows.length - 1);
      else if (e.key === "ArrowRight" && kind === "folder") { if (!expanded) toggleFolder(id, true); else if (rows[i + 1] && rows[i + 1].getAttribute("aria-level") === "2") go(i + 1); }
      else if (e.key === "ArrowLeft") {
        if (kind === "folder" && expanded) toggleFolder(id, false);
        else if (row.getAttribute("aria-level") === "2") { const p = projectById(id); const fr = p && $('[data-key="f:' + p.folderId + '"]', host); if (fr) fr.focus(); }
      }
      else if (e.key === "Enter" || e.key === " ") { if (kind === "folder") toggleFolder(id); else selectProject(id); }
      else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) menuFor(row, $("[data-menu]", row));
      else if (e.key === "F2") renameItem(kind, id);
      else return;
      e.preventDefault();
    });

    // Drag and drop: projects onto a folder, or onto empty space / a top-level project for "no folder".
    const dropTarget = (e) => {
      const row = e.target.closest(".tr");
      if (!row) return null;
      if (row.dataset.kind === "folder") return row.dataset.id;
      const p = projectById(row.dataset.id);
      return (p && p.folderId) || null;
    };
    const clearDrop = () => { $$(".drop", host).forEach((r) => r.classList.remove("drop")); host.classList.remove("drop-root"); };
    host.addEventListener("dragstart", (e) => {
      const row = e.target.closest && e.target.closest('.tr[data-kind="project"]');
      if (!row) return;
      rt.dragId = row.dataset.id;
      host.dataset.dragging = "true";
      if (e.dataTransfer) { e.dataTransfer.setData("text/plain", row.dataset.id); e.dataTransfer.effectAllowed = "move"; }
    });
    host.addEventListener("dragover", (e) => {
      if (!rt.dragId) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      clearDrop();
      const t = dropTarget(e);
      if (t) { const fr = $('[data-key="f:' + t + '"]', host); if (fr) fr.classList.add("drop"); } else host.classList.add("drop-root");
    });
    host.addEventListener("dragleave", (e) => { if (!host.contains(e.relatedTarget)) clearDrop(); });
    host.addEventListener("drop", (e) => {
      if (!rt.dragId) return;
      e.preventDefault();
      const id = rt.dragId, t = dropTarget(e);
      clearDrop();
      rt.dragId = null;
      delete host.dataset.dragging;
      moveProjectTo(id, t);
    });
    host.addEventListener("dragend", () => { rt.dragId = null; delete host.dataset.dragging; clearDrop(); });
  }

  // Aggregate progress per mode: everything that can be ticked or generated in it.
  function youtubeTotals() {
    const c = counts().total, cv = coverTotals();
    return { done: c.done + cv.done + doneCount(), total: c.total + cv.total + chunks().length };
  }
  const pctText = (t) => (t.total ? G.pct(t.done, t.total) + "%" : "");

  function refreshCounts() {
    renderNextBar();
    const st = proj.parsed ? proj.parsed.stats : null;
    const set = (id, txt, title) => {
      const el = $("#count-" + id);
      if (!el) return;
      el.textContent = txt ? String(txt) : "";
      if (title) el.title = title; else el.removeAttribute("title");
    };
    set("import", st ? st.audioChunks : "");
    set("setup", setupState().ok ? "" : "!", setupState().ok ? "" : "Setup is incomplete: " + setupState().reason);
    // Before anything is parsed the workspace tabs look disabled but stay clickable (they show an empty state with a link back to Import).
    const mark = (id, empty) => { const b = $("#tab-" + id); if (b) { b.dataset.empty = String(empty); if (empty) b.title = "Nothing parsed yet. Open Import & Parse first."; else b.removeAttribute("title"); } };
    mark("youtube", !chunks().length && !scenes().length && !coverTotals().total);
    mark("reels", !reels().length);
    const y = youtubeTotals(), rc = reelCounts().total;
    set("youtube", pctText(y), y.total ? "YouTube progress: " + y.done + " of " + y.total + " done" : "");
    set("reels", pctText(rc), rc.total ? "Reels progress: " + rc.done + " of " + rc.total + " done" : "");
    const sub = (id, txt) => { const el = $("#subcount-" + id); if (el) el.textContent = txt ? String(txt) : ""; };
    const frac = (t) => (t.total ? t.done + "/" + t.total : "");
    if (tab === "youtube") {
      const cv = coverTotals(), bc = counts().total;
      sub("audio", frac({ done: doneCount(), total: chunks().length }));
      sub("board", pctText(bc));
      sub("covers", cv.total ? (cv.done === cv.total ? "✓" : frac(cv)) : "");
    } else if (tab === "reels") {
      reels().forEach((r) => sub(String(r.id), frac(G.reelCounts(rprog(), [r], (x) => !!meta(rKey(x.id))).total)));
      const cur = currentReel();
      RSUBS.forEach((x) => { const el = $("#rcount-" + x[0]); if (el && cur) el.textContent = frac(reelViewCounts(cur, x[0])); });
    }
  }

  function refreshAll() {
    renderTree();
    renderTab();
  }

  // ---------- navigation: main tab + sub-tab, remembered per mode and mirrored in the URL hash ----------
  const view = () => (tab === "youtube" ? "youtube-" + subOf.youtube : tab);
  const isAudioView = () => view() === "youtube-audio" || (tab === "reels" && reelSub === "audio");
  const hashFor = () => "#" + tab + (hasSubs(tab) && subOf[tab] ? "/" + subOf[tab] + (tab === "reels" ? "/" + reelSub : "") : "");
  const navState = () => ({ tab, sub: Object.assign({}, subOf), reelSub });
  const validRsub = (k) => RSUBS.some((x) => x[0] === k);
  const validSub = (m, s) => (subsOf(m) || []).some((x) => x[0] === s);
  // #import, #youtube/audio, #reels/1 (Audio), #reels/1/visual, #reels/1/cover
  function parseHash(h) {
    const m = /^#([a-z]+)(?:\/([a-z0-9]+))?(?:\/([a-z]+))?$/.exec(h || "");
    if (!m || !TABS.some((t) => t[0] === m[1])) return null;
    const t = m[1];
    return { tab: t, sub: subsOf(t) ? (validSub(t, m[2]) ? m[2] : subOf[t]) : null, rsub: t === "reels" ? (validRsub(m[3]) ? m[3] : "audio") : null };
  }
  // Saves the position and puts it in the hash (a new history entry, so Back returns to the previous tab).
  function syncNav(replace) {
    store.setNav(navState());
    const h = hashFor();
    if (location.hash === h) return;
    if (replace) history.replaceState(null, "", h); else location.hash = h;
  }
  function go(t, s, rs) {
    tab = t;
    if (s && validSub(t, s)) subOf[t] = s;
    if (rs && validRsub(rs)) reelSub = rs;
    syncNav();
    renderTab();
  }
  const setTab = (id) => go(id);
  window.addEventListener("hashchange", () => {
    if (location.hash === "#format") { openFormat(); return; }
    if ($("#fmt-dlg") && $("#fmt-dlg").open) closeFormat(true);
    const n = parseHash(location.hash);
    if (!n || !proj || (n.tab === tab && (!subsOf(n.tab) || n.sub === subOf[n.tab]) && (n.tab !== "reels" || n.rsub === reelSub))) return;
    tab = n.tab;
    if (n.sub) subOf[n.tab] = n.sub;
    if (n.rsub) reelSub = n.rsub;
    store.setNav(navState());
    renderTab();
  });

  const subsSig = (m) => subsOf(m).map((x) => x[0]).join(",") + (m === "reels" ? ":" + proj.id : "");
  // Segmented tab strip shared by every sub-tab level. lvl 1: sub-tabs of the main tab (YouTube sections, or the reels); lvl 2: sections of one reel.
  function subtabsHtml(lvl, items, label) {
    const id1 = lvl === 1;
    return '<div class="subbar' + (id1 && tab === "reels" ? " folder" : "") + '" id="' + (id1 ? "subbar" : "rsubbar") + '"' + (id1 ? ' data-mode="' + tab + '" data-sig="' + subsSig(tab) + '"' : "") + '><div class="subtabs" role="tablist" aria-label="' + esc(label) + '">' +
      items.map((x) => '<button type="button" class="subtab" role="tab" id="' + (id1 ? "subtab-" + tab + "-" : "rsubtab-") + x[0] + '" aria-controls="' + (id1 ? "subpanel" : "rpanel") + '" data-' + (id1 ? "sub" : "rsub") + '="' + x[0] + '">' + (id1 && tab === "reels" ? "" : icon(x[2])) + "<span>" + x[1] + '</span><span class="count" id="' + (id1 ? "subcount-" : "rcount-") + x[0] + '"></span></button>').join("") + "</div></div>";
  }
  function bindSubtabs(root, lvl) {
    $$(lvl === 1 ? "#subbar .subtab" : "#rsubbar .subtab", root).forEach((b) => {
      const key = lvl === 1 ? b.dataset.sub : b.dataset.rsub;
      const open = (k) => (lvl === 1 ? go(tab, k) : go("reels", subOf.reels, k));
      b.addEventListener("click", () => open(key));
      b.addEventListener("keydown", (e) => {
        const ids = (lvl === 1 ? subsOf(tab) : RSUBS).map((x) => x[0]);
        let i = ids.indexOf(key);
        if (e.key === "ArrowRight") i = (i + 1) % ids.length;
        else if (e.key === "ArrowLeft") i = (i - 1 + ids.length) % ids.length;
        else if (e.key === "Home") i = 0;
        else if (e.key === "End") i = ids.length - 1;
        else return;
        e.preventDefault();
        open(ids[i]);
        $((lvl === 1 ? "#subtab-" + tab + "-" : "#rsubtab-") + ids[i]).focus();
      });
    });
  }

  function renderTab() {
    $$(".tab").forEach((b) => {
      const on = b.dataset.tab === tab;
      b.setAttribute("aria-selected", on ? "true" : "false");
      b.tabIndex = on ? 0 : -1;
    });
    $("#panel").setAttribute("aria-labelledby", "tab-" + tab);
    syncSave();
    copyList = [];
    const p = $("#panel");
    let host = p;
    if (tab === "reels" && !hasSubs("reels")) {
      p.innerHTML = reelsEmpty();
      bindGoto(p);
      refreshCounts();
      bindCopy(p);
      icons();
      updateRunStat();
      return;
    }
    if (hasSubs(tab)) {
      if (!validSub(tab, subOf[tab])) { subOf[tab] = subsOf(tab)[0][0]; store.setNav(navState()); if (location.hash !== hashFor()) history.replaceState(null, "", hashFor()); }
      const bar = $("#subbar", p);
      if (!bar || bar.dataset.mode !== tab || bar.dataset.sig !== subsSig(tab)) {
        // Reels: reel tabs as folder tabs, attached to one panel whose top strip holds the section tabs. YouTube: the same panel, its strip holds the section tabs.
        const tabs = subtabsHtml(1, subsOf(tab), TABS.find((t) => t[0] === tab)[1] + " sections");
        p.innerHTML = (tab === "reels" ? tabs + '<div class="attached"><div class="attach-strip" id="rstrip"></div>' : '<div class="attached"><div class="attach-strip">' + tabs + "</div>") + '<div id="subpanel" class="attach-body" role="tabpanel" tabindex="-1"></div></div>';
        bindSubtabs(p, 1);
      }
      $$("#subbar .subtab", p).forEach((b) => {
        const on = b.dataset.sub === subOf[tab];
        b.setAttribute("aria-selected", on ? "true" : "false");
        b.tabIndex = on ? 0 : -1;
      });
      host = $("#subpanel", p);
      host.setAttribute("aria-labelledby", "subtab-" + tab + "-" + subOf[tab]);
    }
    refreshCounts();
    ({ overview: renderOverview, setup: renderSetup, import: renderImport, "youtube-audio": renderAudio, "youtube-board": renderBoard, "youtube-covers": renderCovers, reels: renderReels })[view()](host);
    bindCopy(host);
    bindDim(host);
    bindDrop(host);
    icons();
    updateRunStat();
    loadThumbs();
  }

  // While a queue runs, any tab other than its own Audio tab shows a one-line status with Stop.
  function updateRunStat() {
    const el = $("#runstat");
    if (!el) return;
    const k = rt.run.kind, v = view();
    const here = (k === "main" && v === "youtube-audio") || (k === "reels" && v === "reels" && reelSub === "audio") || (k === "single" && isAudioView());
    el.hidden = !rt.run.active || here || rt.pipe.running;
    updatePipe();
    if (el.hidden) return;
    const state = rt.run.stopping ? " (stopping...)" : " (running)";
    $("#runstat-text").textContent = (k === "reels" ? "Reel audio: " + reelDoneCount() + " of " + reelsWithAudio().length + " ready" : k === "main" ? "Audio: " + doneCount() + " of " + chunks().length + " ready" : "Generating one audio file") + state;
  }

  function emptyState(msg) {
    return '<div class="empty"><p>' + esc(msg) + '</p><button class="btn primary" type="button" data-goto="import">Go to Import &amp; Parse</button></div>';
  }
  function reelsEmpty() {
    return '<div class="empty"><p>No reels yet. They come from step 6 (Reels and Shorts) of the conversation. The format guide shows how to write it.</p><div class="row" style="justify-content:center">' +
      '<a class="btn" data-fmt href="/format?from=' + (DEMO ? "demo" : "app") + '">' + icon("book-open") + 'Open the format guide</a><button class="btn primary" type="button" data-goto="import">Go to Import &amp; Parse</button></div></div>';
  }
  function bindGoto(p) { $$("[data-goto]", p).forEach((b) => b.addEventListener("click", () => setTab(b.dataset.goto))); }

  // ---------- Import & Parse ----------
  function folderRow() {
    if (!A.canPickFolder) {
      return '<p class="hint folder-note">This browser cannot save straight into a folder (File System Access API). Use "Download ZIP" in the YouTube or Reels Audio tab, or open the app in Chrome or Edge on desktop.</p>';
    }
    const ext = DEMO ? "wav" : "mp3";
    return '<div class="folderrow">' + icon("folder") + '<span class="folder-label">Output folder</span>' +
      '<span class="small folder-status" id="folder-name">' + (rt.dir ? "<strong>" + esc(rt.dir.name) + "</strong>" : '<span class="muted">Not chosen (optional)</span>') + "</span>" +
      '<button class="btn sm" id="pick-folder" type="button">' + icon("folder-open") + "Choose folder</button>" +
      '<button class="btn sm ghost" id="clear-folder" type="button"' + (rt.dir ? "" : " hidden") + ">" + icon("x") + "Clear</button></div>" +
      '<p class="hint folder-note">File System Access is available in this browser. This folder is remembered for this project. Saved as 01_audio.' + ext + ", 02_audio." + ext + " and so on. Reel audio goes into a Reels subfolder. Without a folder, use the ZIP download.</p>";
  }

  function bindFolder(p) {
    const b = $("#pick-folder", p);
    if (!b) return;
    const cf = $("#clear-folder", p);
    if (cf) cf.addEventListener("click", async () => {
      rt.dir = null;
      try { await store.deleteHandle(proj.id); } catch { /* nothing stored */ }
      $$("#folder-name").forEach((el) => (el.innerHTML = '<span class="muted">Not chosen (optional)</span>'));
      cf.hidden = true;
      toast("Output folder cleared.");
    });
    b.addEventListener("click", async () => {
      try {
        rt.dir = await window.showDirectoryPicker({ mode: "readwrite" });
        await store.putHandle(proj.id, rt.dir);
        $$("#folder-name").forEach((el) => (el.innerHTML = "<strong>" + esc(rt.dir.name) + "</strong>"));
        const cf = $("#clear-folder"); if (cf) cf.hidden = false;
        toast("Folder selected: " + rt.dir.name);
        if (isAudioView()) renderTab();
      } catch (e) {
        if (e && e.name !== "AbortError") toast("Could not open that folder: " + e.message);
      }
    });
  }

  function resultHtml() {
    const r = proj.parsed;
    const head3 = '<div class="step-head step-head-plain"><span class="step-chip" aria-hidden="true">3</span><h3>Parsed result</h3>' +
      (canUndo() ? '<span class="step-tools"><button type="button" class="btn sm ghost" id="undo-parse">' + icon("undo-2") + "Undo last parse</button></span>" : "") + "</div>";
    if (!r) return '<section class="step">' + head3 + '<div class="empty">Paste a conversation above and press Parse.</div></section>';
    const s = r.stats;
    const stat = (n, label) => '<div class="stat"><b>' + n + "</b><span class=\"muted small\">" + label + "</span></div>";
    return '<section class="step">' + head3 + changesHtml() + '<div class="stats">' + stat(s.audioChunks, "Audio chunks") + stat(s.imageScenes, "Image scenes") + stat(s.animations, "Animations") + stat(s.reels, "Reels (9:16)") + stat(s.reelAudio, "Reel audio") + "</div>" +
      (s.imageScenes ? '<div class="miniprogress"><div class="meter-top"><span>Visual Board progress</span><b>' + counts().total.pct + "%</b></div>" + barHtml("Overall", counts().total) + "</div>" : "") +
      (r.warnings.length ? '<div class="warn" role="status"><strong>Check the paste:</strong><ul>' + r.warnings.map((w) => "<li>" + esc(w) + (/start phrase/i.test(w) ? ' <button type="button" class="btn sm" data-focus-phrase>Set start phrase</button>' : "") + "</li>").join("") + "</ul></div>" : "") + "</section>" +
      (r.chunks.length
        ? "<section>" + secHead("Audio chunks", r.chunks.length) + '<div class="list">' + r.chunks.map((c) =>
            '<article class="item"><div class="item-head"><span class="num" aria-hidden="true">' + pad(c.n) + '</span><h3 class="item-title">Chunk ' + pad(c.n) + '</h3><span class="muted small">' + c.chars.toLocaleString() + " characters</span></div>" + clampHtml("imp-" + c.n, c.text) + "</article>").join("") + "</div></section>"
        : "");
  }

  function renderOverview(p) {
    O.render(p, proj, { dd: { html: ddHtml, init: ddInit }, save: async () => { await saveProject(); renderTree(); } });
    const page = $(".ov", p);
    if (page) {
      page.insertAdjacentHTML("beforeend", filesPanelHtml());
      $("#export-edit", page).addEventListener("click", exportEditReady);
      page.addEventListener("click", (e) => { if (e.target.closest("#unused-remove")) removeUnused(); });
    }
    loadStorage();
    loadStrays();
  }

  // Projects with parsed content open on Overview, empty ones on Import.
  const landingTab = () => (proj && proj.parsed ? "overview" : "import");

  // ---------- Parse: the paste box is a draft, the Parse button commits it ----------
  rt.undo = {}; rt.phraseDirty = {};
  const draftKey = () => store.prefix + ":draft:" + proj.id;
  const getDraft = () => { try { const d = localStorage.getItem(draftKey()); return d === null ? proj.text : d; } catch { return proj.text; } };
  const setDraft = (t) => { try { if (t === proj.text) localStorage.removeItem(draftKey()); else localStorage.setItem(draftKey(), t); } catch { /* storage blocked: the draft stays in the box */ } };
  const undoKey = () => store.prefix + ":undo:" + proj.id;
  const getUndo = () => {
    if (rt.undo[proj.id]) return rt.undo[proj.id];
    try { const u = JSON.parse(localStorage.getItem(undoKey()) || "null"); if (u) rt.undo[proj.id] = u; return u; } catch { return null; }
  };
  const canUndo = () => !!(proj && getUndo());
  const parseState = (draft) => (!proj.parsed || (!proj.text.trim() && draft.trim()) ? "none" : draft !== proj.text || rt.phraseDirty[proj.id] ? "changed" : "parsed");
  const PARSE_TEXT = { none: "Not parsed yet", changed: "Text changed since last parse", parsed: "Parsed" };

  const listText = (l) => ["added", "edited", "removed"].filter((k) => l[k].length).map((k) => ({ added: "new ", edited: "edited ", removed: "removed " }[k]) + l[k].join(", ")).join("; ");
  function changesHtml() {
    const c = proj.ext && proj.ext.changes;
    if (!c) return "";
    const rows = [["Chunks", c.lists.chunks], ["Scenes", c.lists.scenes], ["Reels", c.lists.reels]].filter((r) => listText(r[1]));
    if (!rows.length) return "";
    return '<div class="notebar" id="changes" role="status"><span>' + icon("git-compare") + "<span><strong>Changes since last parse.</strong> " + rows.map((r) => esc(r[0] + ": " + listText(r[1]))).join(" &middot; ") + '</span></span><button type="button" class="btn sm" id="changes-dismiss">Dismiss</button></div>';
  }

  // A re-parse keeps media: files follow unchanged items, edited ones are flagged outdated, removed ones become unused (never deleted here).
  function carryMediaInto(c) {
    const ext = proj.ext;
    if (Object.keys(c.media).length) ext.media = c.media; else delete ext.media;
    if (Object.keys(c.orphans).length) ext.orphans = c.orphans; else delete ext.orphans;
  }

  /** Parses `text` into the project. Asks first when that would cost progress, audio or publishing info. Returns false when cancelled. */
  async function requestParse(text) {
    if (guardRunning()) return false;
    const next = text.trim() ? P.parse(text, { startPhrase: startPhrase() }) : null;
    const d = D.diff(proj.parsed, next), sum = D.summarize(d), imp = D.impact(proj);
    if (proj.parsed && text === proj.text && !D.isChange(sum) && !rt.phraseDirty[proj.id]) { setDraft(text); toast("Nothing changed."); if (text.trim() && !startPhrase()) phraseNeeded(); return true; }
    const mediaN = Object.keys((proj.ext && proj.ext.media) || {}).length;
    if (proj.parsed && (imp.ticks || imp.audio || imp.published || mediaN)) {
      const c = D.carry(proj, d, next);
      const part = (label, m) => label + ": " + m.added + " new, " + m.edited + " edited, " + m.removed + " removed";
      const ok = await ask({
        title: "Replace the parsed content?",
        text: "This project has " + imp.audio + " audio file" + (imp.audio === 1 ? "" : "s") + " and " + imp.ticks + " tick" + (imp.ticks === 1 ? "" : "s") + (imp.published ? " and publishing info" : "") + ". Scenes and chunks whose content did not change keep their progress; changed ones lose it.",
        lines: [part("Chunks", sum.chunks), part("Scenes", sum.scenes), part("Reels", sum.reels)].concat(c.outdated ? [c.outdated + " audio file" + (c.outdated === 1 ? "" : "s") + " will be marked outdated (not deleted)"] : []).concat(c.mediaOutdated ? [c.mediaOutdated + " media file" + (c.mediaOutdated === 1 ? "" : "s") + " will be marked outdated (kept)"] : []).concat(c.mediaOrphaned ? [c.mediaOrphaned + " media file" + (c.mediaOrphaned === 1 ? "" : "s") + " will become unused (kept until you remove them in Overview)"] : []),
        confirm: "Replace",
      });
      if (!ok) return false;
    }
    const had = !!proj.parsed;
    if (had) {
      const snap = { at: Date.now(), text: proj.text, parsed: proj.parsed, progress: proj.progress, reelProgress: proj.reelProgress, thumbnailDone: proj.thumbnailDone, audio: proj.audio, reelAudio: proj.reelAudio, ext: proj.ext };
      rt.undo[proj.id] = snap;
      try { localStorage.setItem(undoKey(), JSON.stringify(snap)); } catch { /* too big for localStorage: undo lasts until the page is closed */ }
    }
    const c = D.carry(proj, d, next);
    proj.text = text; proj.parsed = next;
    proj.progress = c.progress; proj.reelProgress = c.reelProgress; proj.thumbnailDone = c.thumbnailDone; proj.audio = c.audio; proj.reelAudio = c.reelAudio;
    proj.ext = Object.assign({}, proj.ext);
    carryMediaInto(c);
    proj.ext.history = [{ at: Date.now(), textHash: D.hash(text), counts: sum }].concat((proj.ext.history || [])).slice(0, 5);
    if (had && D.isChange(sum)) proj.ext.changes = { at: Date.now(), lists: D.listChanges(d) }; else delete proj.ext.changes;
    delete rt.phraseDirty[proj.id];
    setDraft(text);
    if (DEMO) await saveProject(); else await persistNow();
    if (had && (imp.ticks || imp.audio || imp.published || mediaN)) toast("Replaced.", { label: "Undo", run: undoParse }, 10000); else toast(next ? "Parsed." : "Cleared.");
    renderTree();
    if (tab === "import") renderTab(); else refreshCounts();
    if (text.trim() && !startPhrase()) phraseNeeded();
    return true;
  }

  async function undoParse() {
    const u = getUndo();
    if (!u || guardRunning()) return;
    proj.text = u.text; proj.parsed = u.parsed; proj.progress = u.progress || {}; proj.reelProgress = u.reelProgress || {}; proj.thumbnailDone = u.thumbnailDone;
    proj.audio = u.audio || {}; proj.reelAudio = u.reelAudio || {}; proj.ext = Object.assign({}, u.ext); delete proj.ext.changes;
    delete rt.undo[proj.id]; delete rt.phraseDirty[proj.id];
    try { localStorage.removeItem(undoKey()); } catch { /* ignore */ }
    setDraft(proj.text);
    if (DEMO) await saveProject(); else await persistNow();
    toast("Restored the previous parse.");
    renderTab();
  }

  // Puts text in the project through the same replace flow as the Parse button (sample, template).
  async function commitText(text) {
    setDraft(text);
    const ok = await requestParse(text);
    if (!ok) { if (tab === "import") renderTab(); }
    return ok;
  }

  // "How it works": three steps from the Director Prompt to finished files. Expanded for new projects, collapsed once something is parsed;
  // the choice is remembered per mode (localStorage) once the user makes it.
  const howKey = () => store.prefix + ":howto";
  function howtoOpen() {
    let v = null;
    try { v = localStorage.getItem(howKey()); } catch { /* blocked */ }
    return v === "open" ? true : v === "closed" ? false : DEMO || !(proj && proj.parsed);
  }
  function howtoHtml() {
    const open = howtoOpen();
    const step = (n, ico, title, body, action) => '<li class="how-step"><span class="how-chip" aria-hidden="true">' + n + "</span>" + icon(ico) + "<h4>" + title + "</h4><p>" + body + "</p>" + action + "</li>";
    return '<section class="howto" aria-labelledby="how-h"><div class="how-head"><h3 id="how-h">How it works</h3><button type="button" class="btn sm ghost" data-guide="setup">' + icon("circle-help") + 'Open full guide</button>' +
      '<button type="button" class="btn sm ghost" id="how-toggle" aria-expanded="' + open + '" aria-controls="how-body">' + (open ? "Hide guide" : "Show guide") + "</button></div>" +
      '<ol class="how-steps" id="how-body"' + (open ? "" : " hidden") + ">" +
      step(1, "scroll-text", "Get the Director Prompt", "Save your Master Prompt in Setup (the Director Prompt button in the header opens it too). Run it right here with your Gemini key, or copy it into a new Gemini chat or Gem." + (DEMO ? " In this demo the prompt shown is a short generic English sample; in the real app it holds your own prompt." : ""), '<button type="button" class="btn sm" id="how-dp">' + icon("scroll-text") + "Open Director Prompt</button>") +
      step(2, "messages-square", "Generate the Book Package", "Choose AI Director below and the app runs the director for you: pick the language, add the book PDF or a title, then Start Project and Auto-Run all 6 stages (Script, 16:9 scenes, Flow animations, Thumbnail, 9:16 Reels). Or do it by hand in Gemini: send the language and the book, then reply \"Continue\" at each checkpoint." + (DEMO ? " In this demo the AI Director run is simulated, so no key is needed." : ""), '<a class="btn sm" data-fmt href="/format?from=' + (DEMO ? "demo" : "app") + '">' + icon("book-open") + "See the expected format</a>") +
      step(3, "clipboard-paste", "Paste and Produce", "The AI Director fills in the project as it goes. If you used Gemini yourself, choose Paste Conversation, paste the whole chat and click Parse. Set your ElevenLabs key and output folder in Setup, then generate the audio, copy each prompt, and upload the finished images and videos into the slot on its card." + (DEMO ? " In this demo the files stay in your browser." : ""), "") +
      "</ol></section>";
  }
  function bindHowto(p) {
    const t = $("#how-toggle", p);
    if (!t) return;
    t.addEventListener("click", () => {
      const open = t.getAttribute("aria-expanded") !== "true";
      try { localStorage.setItem(howKey(), open ? "open" : "closed"); } catch { /* blocked */ }
      t.setAttribute("aria-expanded", String(open));
      t.textContent = open ? "Hide guide" : "Show guide";
      $("#how-body", p).hidden = !open;
    });
    $("#how-dp", p).addEventListener("click", openVault);
  }

  // Paste Conversation mode: the original Import & Parse screen (language and start phrase, paste box, parse, result).
  function renderPaste(p) {
    const draft = getDraft();
    p.innerHTML =
      '<section class="step step-setup" aria-labelledby="imp1"><div class="step-head"><span class="step-chip" aria-hidden="true">1</span><h3 id="imp1">Language and start phrase</h3></div><div class="grid2">' +
      '<div class="field"><label for="lang">Content language</label>' + ddHtml("lang", "", "") + '<span class="hint">Sets the font for narration only; each line picks its own direction. Prompts stay left to right.</span></div>' +
      '<div class="field"><label for="phrase">Chunk start phrase</label>' +
      '<input id="phrase" class="input script-arabic" dir="auto" autocomplete="off" data-1p-ignore data-lpignore="true" data-form-type="other" value="' + esc(projPhrase() || settings.startPhrase) + '" placeholder="' + esc(DEMO ? P.DEFAULT_START_PHRASE : "The phrase every chunk starts with") + '" aria-describedby="phrase-err phrase-note">' +
      '<span class="field-err" id="phrase-err" role="alert"' + (rt.phraseErr === proj.id && !startPhrase() ? "" : " hidden") + '>Set the chunk start phrase (step 1) to find audio chunks</span>' +
      '<span class="hint" id="phrase-note"' + (rt.phraseNote === proj.id ? "" : " hidden") + ">Start phrase set to the sample's phrase for this project</span>" +
      '<span class="hint">' + (DEMO ? "Every chunk starts with this phrase. Leave empty for the demo phrase shown. Saved with this project. Press Parse after changing it." : "Every chunk starts with this phrase, so it is required: without it no chunks are found. It is saved with this project; the first phrase you set also becomes the default for new projects. Press Parse after changing it.") + '</span></div>' +
      '</div></section>' +
      '<section class="step step-generate" aria-labelledby="imp2"><div class="step-head"><span class="step-chip" aria-hidden="true">2</span><h3 id="imp2">Paste the conversation</h3><span class="step-tools"><button type="button" class="btn sm ghost" data-fmt>' + icon("book-open") + "Input format guide</button></span></div>" +
      '<div class="field"><label for="paste" class="sr-only">Full reply from your AI director</label>' +
      '<textarea id="paste" class="input ' + contentClass().replace("content", "") + '" dir="auto" spellcheck="false" placeholder="Paste the full reply from your AI director here..."></textarea></div>' +
      '<div class="row" style="margin-top:12px">' +
      '<button class="btn primary" id="parse-btn" type="button">' + icon("scan-text") + 'Parse<span class="sr-only"> (Ctrl or Cmd plus Enter)</span></button>' +
      '<span class="state-badge" id="parse-badge" role="status" aria-live="polite"></span>' +
      '<button class="btn" id="load-sample" type="button">' + icon("file-down") + "Load sample</button>" +
      '<a class="btn" id="format-guide" data-fmt href="/format?from=' + (DEMO ? "demo" : "app") + '">' + icon("book-open") + "Input format guide</a>" +
      '<button class="btn" id="clear" type="button">' + icon("eraser") + "Clear</button></div>" +
      '<p class="small muted" id="parse-preview" style="margin:10px 0 0" aria-live="polite"></p>' +
      '<div class="notebar" id="old-sample" hidden><span>' + icon("info") + 'This is an older version of the sample, without cover prompts.</span><button class="btn sm" id="update-sample" type="button">Update to latest sample</button></div></section>' +
      '<div id="result" class="page" aria-live="polite"></div>';
    const ta = $("#paste", p);
    ta.value = draft;
    const bindResult = () => {
      const u = $("#undo-parse", p); if (u) u.addEventListener("click", undoParse);
      $$("[data-focus-phrase]", p).forEach((b) => b.addEventListener("click", () => { const f = $("#phrase", p); if (f) { f.scrollIntoView({ block: "center" }); f.focus(); } }));
      const d = $("#changes-dismiss", p);
      if (d) d.addEventListener("click", async () => { delete proj.ext.changes; await saveProject(); $("#result", p).innerHTML = resultHtml(); bindResult(); icons(); });
    };
    $("#result", p).innerHTML = resultHtml();
    bindResult();
    const oldHint = () => { $("#old-sample", p).hidden = !isOldSample(ta.value); };
    // Typing only updates this badge and a read-only preview. Nothing is written to the project.
    const refreshDraft = () => {
      const st = parseState(ta.value), badge = $("#parse-badge", p);
      badge.textContent = PARSE_TEXT[st];
      badge.className = "state-badge " + (st === "parsed" ? "ready" : "needs");
      const pre = $("#parse-preview", p);
      if (ta.value.trim() && st !== "parsed") {
        const r = P.parse(ta.value, { startPhrase: startPhrase() }).stats;
        pre.textContent = "Preview (not saved): " + r.audioChunks + " chunks, " + r.imageScenes + " scenes, " + r.reels + " reels.";
      } else pre.textContent = "";
      oldHint();
    };
    refreshDraft();
    let timer;
    ta.addEventListener("input", () => { setDraft(ta.value); syncSave(); clearTimeout(timer); timer = setTimeout(refreshDraft, 300); });
    const doParse = () => requestParse(ta.value);
    $("#parse-btn", p).addEventListener("click", doParse);
    ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doParse(); } });
    langDd = ddInit("lang", langOpts(), proj.lang, async (v) => { proj.lang = v; await saveProject(); renderTab(); });
    $("#phrase", p).addEventListener("input", (e) => {
      setProjPhrase(e.target.value);
      if (!settings.startPhrase.trim()) { settings.startPhrase = e.target.value; store.saveSettings(settings); }
      rt.phraseDirty[proj.id] = true;
      if (e.target.value.trim()) { $("#phrase-err", p).hidden = true; $("#phrase-note", p).hidden = true; delete rt.phraseNote; }
      clearTimeout(timer);
      timer = setTimeout(refreshDraft, 300);
    });
    const loadLatest = async () => {
      try { const t = await fetchSample(); useSamplePhrase(); await commitText(t); toast("Sample loaded. All content in it is fictional."); } catch { toast("Could not load the sample."); }
    };
    $("#load-sample", p).addEventListener("click", loadLatest);
    $("#update-sample", p).addEventListener("click", loadLatest);
    $("#clear", p).addEventListener("click", async () => {
      const imp = D.impact(proj);
      if (!imp.ticks && !imp.audio && ta.value && !(await ask({ title: "Clear the pasted text?", text: "Generated audio stays until you regenerate it.", confirm: "Clear", danger: true }))) return;
      await commitText("");
    });
  }

  // ---------- AI Director (Import & Parse, first mode): Gemini writes the book package here ----------
  // The run itself is director-run.js on top of director.js; this section is the screen, the Gemini or simulated turn, and saving into the project.
  // Settings come from Setup (key, model, rates); the Master Prompt comes from the vault. /demo runs a simulated director and never calls an API.
  const ad = { runner: null, file: null, b64: null, info: null, base: null, upload: null, saveTimer: null, sim: null, auto: false, lastState: null, open: true, busy: "", stream: "", retry: null, expectProj: null, editing: false };
  const dirUi = () => (proj.ext.dirUi || (proj.ext.dirUi = {}));
  const impMode = () => dirUi().mode || (proj.parsed ? "paste" : "ai");
  const adLang = () => dirUi().lang || (!DEMO && settings.startPhrase.trim() ? "fa" : "en");
  // A change to the director settings or run state: unsaved in /app (the Save button), written after a short pause in /demo.
  const adSaveSoon = () => { if (!DEMO) { markDirty(); return; } clearTimeout(ad.saveTimer); ad.saveTimer = setTimeout(() => { saveProject().catch(() => {}); }, 800); };
  const adStatus = () => (ad.runner && ad.runner.state ? ad.runner.state.status : "idle");
  const adHasInput = () => !!(ad.file || (dirUi().title || "").trim() || (dirUi().summary || "").trim());
  const adFirstText = () => GM.firstMessage({ language: adLang(), title: dirUi().title, summary: dirUi().summary, hasPdf: !!(ad.file || (proj.ext.director && proj.ext.director.pdf)) });
  const adRateFor = (model) => E.geminiRateFor(model, settings.geminiRates);
  const adRoute = () => MBSD.normalizeRoute(settings.geminiRoute);
  const adStageModel = (n) => MBSD.stageModel(adRoute(), n, settings.geminiModel);
  /** The model the next turn will use, and why: a pick made in the panel, else the routing for the current stage. */
  function adNextModel() {
    const st = ad.runner && ad.runner.state;
    if (st && st.modelOverride) return { id: st.modelOverride, by: "your pick" };
    const n = st ? st.stage || 1 : 1;
    return { id: MBSD.pickModel(st || { stage: 1 }, adRoute(), settings.geminiModel), by: "routing for stage " + n };
  }
  const simMs = () => Number(window.MBS_SIM_MS) || 700;

  /** Tokens sent on the first turn: measured by Gemini's countTokens when it ran, else a rough count of the prompt, the first message and the PDF pages. */
  function adBaseTokens() {
    if (ad.base) return ad.base;
    const pages = ad.info ? ad.info.pages || Math.ceil(ad.info.size / 60000) : 0;
    return E.approxTokens(vs.state ? vs.state.text : "") + E.approxTokens(adFirstText()) + pages * GM.PDF_TOKENS_PER_PAGE;
  }

  function adCostHtml() {
    const st = ad.runner && ad.runner.state, p = E.projectGeminiRun(adBaseTokens(), (i, n) => adRateFor(st && st.modelOverride ? st.modelOverride : adStageModel(Math.floor((i * 6) / n) + 1))), a = E.DIRECTOR_ASSUMPTIONS, u = (x) => E.usdText(x);
    const sofar = st ? st.tokens : { prompt: 0, output: 0 };
    return "<strong>" + (DEMO ? "Simulated: " : "") + "Estimated about " + u(p.expected.usd) + " (range " + u(p.low.usd) + " to " + u(p.high.usd) + ") for a full run, actual so far " + u(st ? st.cost : 0) + ".</strong>" +
      '<span class="small muted">Assumes about ' + a.expected.turns + " turns (" + a.low.turns + " to " + a.high.turns + "), each reply about " + E.fmt(a.expected.reply) + " tokens plus thinking. The whole conversation is sent again every turn, so input grows: about " + E.kTokens(p.expected.prompt) + " input and " + E.kTokens(p.expected.output) + " output tokens in all. So far " + E.kTokens(sofar.prompt) + " in, " + E.kTokens(sofar.output) + " out. " +
      (DEMO ? "Default rates, not a real charge. " : "Rates and models are from Setup. ") + "Each turn is priced at the model that runs it. " + "An estimate only: after each turn the real token counts from Gemini are used.</span>";
  }
  function refreshCostBadge() { const el = $("#ad-cost"); if (el) el.innerHTML = adCostHtml(); }

  // Why Start is blocked, or "".
  function adBlock() {
    if (!DEMO && !settings.geminiKey) return "Add your Gemini API key in Setup first.";
    if (!DEMO && vs.loaded && !vs.state.text.trim()) return "The Master Director Prompt is empty. Add it in Setup first.";
    if (!DEMO && !adHasInput()) return "Add a PDF, a title or a summary first.";
    return "";
  }

  const AD_BTN = { start: "ad-start", next: "ad-next", auto: "ad-auto", pause: "ad-pause", resume: "ad-resume", stop: "ad-stop", over: "ad-over" };
  function adStatusLine(st) {
    const stage = st ? "Stage " + st.stage + " of 6: " + MBSD.STAGES[st.stage - 1].label : "";
    if (ad.busy) return ad.busy;
    if (!st || st.status === "idle") return "Ready. Fill in the book, then press Start Project.";
    if (st.status === "running") return ad.retry ? "Gemini is busy (" + (ad.retry.status || ad.retry.kind) + "). Retrying in " + Math.round(ad.retry.delayMs / 1000) + " s (attempt " + ad.retry.attempt + ")." : "Turn " + (st.turns + 1) + ": " + (DEMO ? "the simulated director is" : "Gemini is") + " writing. " + stage + ".";
    if (st.status === "waiting") return "Reply received. " + stage + ". Press Next Step, or Auto-Run to go on by itself.";
    if (st.status === "paused") return (st.pause && st.pause.message) || "Paused.";
    if (st.status === "error") return "Stopped by an error: " + st.error + " Press Resume to try again.";
    if (st.status === "stopped") return "Stopped after " + st.turns + " turn" + (st.turns === 1 ? "" : "s") + ". Press Resume to go on, or Start over.";
    return "All 6 stages are complete. Your project is filled in: open the YouTube and Reels tabs.";
  }

  // Refreshes everything on the AI Director screen from the runner state: buttons, status, counters, cost, the live reply, the log.
  function adSync() {
    const root = $("#ad-root");
    if (!root) return;
    const st = ad.runner && ad.runner.state, status = adStatus(), block = adBlock(), vsOk = DEMO || vs.loaded;
    const idle = status === "idle";
    const has = {
      start: idle, next: status === "waiting", auto: idle || status === "waiting", pause: status === "running", resume: ["paused", "error", "stopped"].includes(status),
      stop: ["running", "waiting", "paused", "error"].includes(status), over: !!st && status !== "running",
    };
    Object.keys(AD_BTN).forEach((k) => {
      const b = $("#" + AD_BTN[k]);
      if (!b) return;
      b.hidden = (k === "pause" && status !== "running") || (k === "resume" && !["paused", "error", "stopped"].includes(status)) || (k === "over" && !st);
      b.disabled = !has[k] || ((k === "start" || k === "auto") && idle && (!!block || !vsOk));
    });
    const reason = idle && block ? block : "";
    $("#ad-reason").hidden = !reason; $("#ad-reason-text").textContent = reason;
    const key = $("#ad-keynote"); if (key) key.hidden = DEMO || !!settings.geminiKey;
    const vn = $("#ad-vaultnote"); if (vn) vn.hidden = DEMO || !vs.loaded || !!vs.state.text.trim();
    $("#ad-status").textContent = adStatusLine(st);
    const stage = st ? MBSD.STAGES[st.stage - 1] : MBSD.STAGES[0];
    $("#ad-turns").textContent = "Turn " + (st ? st.turns : 0) + " of up to " + (st ? st.maxTurns : dirUi().maxTurns || MBSD.DEFAULT_MAX_TURNS);
    $("#ad-stage").textContent = "Stage " + stage.n + " of 6: " + stage.label;
    $$("#ad-steps li", root).forEach((li, i) => { const fin = status === "done"; li.classList.toggle("on", !fin && i + 1 === stage.n && !!st); li.classList.toggle("past", !!st && (fin || i + 1 < stage.n)); });
    refreshCostBadge();
    const lastModel = ad.runner ? [...ad.runner.history].reverse().find((m) => m.role === "model") : null;
    const stream = $("#ad-stream");
    if (stream) { const txt = status === "running" ? ad.stream : lastModel ? lastModel.text : ""; if (stream.textContent !== txt) stream.textContent = txt; stream.setAttribute("aria-busy", String(status === "running")); }
    const log = $("#ad-log");
    if (log) log.innerHTML = st ? st.log.slice(-8).map((t) => "<li>Turn " + t.n + (t.model ? " (" + esc(t.model) + ")" : "") + ": " + E.fmt(t.prompt) + " in, " + E.fmt(t.output) + " out, " + E.usdText(t.usd) + (t.finish && t.finish !== "STOP" ? " (" + esc(t.finish) + ")" : "") + (DEMO ? " (simulated)" : "") + "</li>").join("") : "";
    const tot = $("#ad-total");
    if (tot) {
      const by = {};
      if (st) st.log.forEach((t) => { const k = t.model || "model"; by[k] = (by[k] || 0) + t.usd; });
      tot.textContent = st ? "Total: " + E.usdText(st.cost) + " over " + st.turns + " turn" + (st.turns === 1 ? "" : "s") + (Object.keys(by).length > 1 ? " (" + Object.keys(by).map((k) => k + " " + E.usdText(by[k])).join(", ") + ")" : "") + (DEMO ? " (simulated)" : "") : "";
    }
    const nm = adNextModel(), note = $("#ad-model-note");
    if (note) note.textContent = (st && ["done"].includes(status) ? "The run is complete." : "Next turn: " + nm.id + " (" + nm.by + ").");
    if (ad.modelDd) { const want = st && st.modelOverride ? st.modelOverride : ""; if (ad.modelDd.get() !== want) ad.modelDd.set(adModelOpts(), want); }
    const q = $("#ad-reply-box"); if (q) q.hidden = !(st && status === "paused" && st.pause && st.pause.reason === "question");
    const fb = $("#ad-fb-box");
    if (fb) {
      const canFb = !!lastModel && ["waiting", "paused", "stopped", "error", "done"].includes(status) && !ad.busy;
      fb.hidden = !canFb;
      if (!canFb && ad.editing) { ad.editing = false; $("#ad-edit-box").hidden = true; }
      $("#ad-fb-send").disabled = status === "done" || (!!q && !q.hidden);
      $("#ad-edit").hidden = !!ad.editing;
    }
    const pn = $("#ad-pdfnote");
    if (pn) { const need = st && st.pdf && !ad.file && !(st.pdf.uri && st.pdf.expiresAt > Date.now()); pn.hidden = !need; }
    const sc = $("#ad-found"), ps = proj.parsed && proj.parsed.stats;
    if (sc) { sc.hidden = !(st && ps && (ps.audioChunks || ps.imageScenes || ps.reels)); if (ps) $("#ad-found-text").textContent = "Found so far: " + ps.audioChunks + " chunks, " + ps.imageScenes + " scenes, " + ps.reels + " reels."; }
    const live = $("#ad-live"); if (live) live.hidden = !st;
    adConvoSync();
  }

  // Full conversation card: every turn from the runner history (replies whole; your messages as saved, see MBSD.conversation).
  // It is rebuilt when a turn finishes (not while a reply streams), and the open turns stay open.
  const adTurns = () => (ad.runner && ad.runner.state ? MBSD.conversation(ad.runner.history, ad.runner.state.meta) : []);
  function adConvoSync() {
    const card = $("#ad-convo"), body = $("#ad-convo-body");
    if (!card || !body) return;
    const turns = adTurns();
    card.hidden = !turns.length;
    $("#ad-convo-count").textContent = turns.length ? turns.length + " turn" + (turns.length === 1 ? "" : "s") : "";
    const key = turns.length + ":" + (turns.length ? turns[turns.length - 1].reply.length : 0);
    if (body.dataset.key === key) return;
    body.dataset.key = key;
    const open = new Set($$("details.ad-turn[open]", body).map((d) => d.dataset.n));
    body.innerHTML = '<p class="hint" style="margin:0 0 10px">Replies are kept whole. Your own messages are saved as one line cut at 400 characters (the book input is kept whole).</p>' +
      turns.map((t) => '<details class="ad-turn" data-n="' + t.n + '"' + (open.has(String(t.n)) ? " open" : "") + '><summary><strong>Turn ' + t.n + "</strong>" + (t.stage ? " &middot; Stage " + t.stage + ": " + esc(t.stageLabel) : "") + (t.model ? " &middot; " + esc(t.model) : "") + '</summary>' +
        '<div class="row ad-turn-tools"><button type="button" class="btn sm" data-ad-copy="' + (t.n - 1) + '">' + icon("copy") + "<span>Copy turn " + t.n + "</span></button></div>" +
        '<p class="label">You' + (t.userCut ? " (cut at 400 characters)" : "") + '</p><div class="ad-stream ad-turn-user" dir="auto" tabindex="0">' + esc(t.user) + '</div>' +
        '<p class="label">Model</p><div class="ad-stream" dir="auto" tabindex="0">' + esc(t.reply) + "</div></details>").join("");
    $$("[data-ad-copy]", body).forEach((b) => b.addEventListener("click", async () => {
      const ok = await copyText(MBSD.turnText(adTurns()[Number(b.dataset.adCopy)]));
      toast(ok ? "Turn copied to the clipboard." : "Could not copy. Select the text and copy it by hand.");
    }));
  }
  function syncRunGates() { adSync(); }

  // ----- turns -----
  async function adPdfRef(signal) {
    const meta = ad.runner.state.pdf;
    if (ad.file) {
      if (ad.file.size <= GM.INLINE_MAX_BYTES) return { inline: ad.b64 || (ad.b64 = await GM.blobToBase64(ad.file)) };
      if (ad.upload && ad.upload.expiresAt > Date.now()) return { uri: ad.upload.uri };
      ad.busy = "Uploading the PDF to Gemini..."; adSync();
      try { ad.upload = await GM.uploadFile({ key: settings.geminiKey, blob: ad.file, name: ad.file.name, signal }); } finally { ad.busy = ""; }
      return { uri: ad.upload.uri };
    }
    if (meta && meta.uri && meta.expiresAt > Date.now()) return { uri: meta.uri };
    return null;
  }

  async function adGeminiTurn(req) {
    const model = req.model, pdf = await adPdfRef(req.signal);
    const body = GM.buildBody({ system: vs.state.text, contents: GM.toContents(req.history, pdf), temperature: settings.geminiTemp, model });
    const r = await GM.streamTurn({ key: settings.geminiKey, model, body, signal: req.signal, onText: req.onText, onRetry: req.onRetry });
    if (!r.usage) r.usage = { prompt: E.approxTokens(vs.state.text + req.history.map((m) => m.text).join("")), output: E.approxTokens(r.text) };
    return r;
  }

  const simWait = (ms, sig) => new Promise((res, rej) => {
    if (sig.aborted) return rej({ kind: "aborted" });
    const t = setTimeout(res, ms);
    sig.addEventListener("abort", () => { clearTimeout(t); rej({ kind: "aborted" }); }, { once: true });
  });
  // /demo: the sample conversation split into about 8 replies, streamed with delays. Tokens are made up from the text sizes. No network.
  async function adSimTurn(req) {
    if (!ad.sim) ad.sim = MBSD.splitSample(await fetchSample(), 8);
    const n = req.history.filter((m) => m.role === "model").length, reply = ad.sim[Math.min(n, ad.sim.length - 1)];
    const pieces = Math.max(4, Math.ceil(reply.length / 80)), size = Math.ceil(reply.length / pieces);
    let full = "";
    for (let i = 0; i < pieces; i++) {
      await simWait(Math.max(5, Math.round(simMs() / pieces)), req.signal);
      const part = reply.slice(i * size, (i + 1) * size);
      full += part;
      req.onText(part, full);
    }
    const prompt = adBaseTokens() + E.approxTokens(req.history.map((m) => m.text).join(""));
    return { text: reply, usage: { prompt, output: E.approxTokens(reply) + 600 }, finishReason: "STOP", blockReason: "" };
  }

  // After each reply: put the conversation into the project through the same diff and carry as a parse, without asking (progress, audio and ticks are kept).
  async function adOnTurn(x) {
    if (!proj || proj.id !== ad.expectProj) return;
    const d = D.diff(proj.parsed, x.parsed), sum = D.summarize(d), c = D.carry(proj, d, x.parsed);
    proj.text = x.text; proj.parsed = x.parsed;
    proj.progress = c.progress; proj.reelProgress = c.reelProgress; proj.thumbnailDone = c.thumbnailDone; proj.audio = c.audio; proj.reelAudio = c.reelAudio;
    proj.ext = Object.assign({}, proj.ext, { director: x.state });
    carryMediaInto(c);
    proj.ext.history = [{ at: Date.now(), textHash: D.hash(x.text), counts: sum }].concat((proj.ext.history || [])).slice(0, 5);
    delete proj.ext.changes;
    setDraft(x.text);
    if (DEMO) adSaveSoon(); else persistNow(); // each director reply is saved to the server as it arrives
    renderTree();
    refreshCounts();
  }

  // While a reply streams the state object stays the same: only the text and the status line change.
  function adOnChange(v) {
    const same = v.state === ad.lastState;
    ad.lastState = v.state;
    ad.stream = v.stream; ad.retry = v.retry;
    if (same) {
      const s = $("#ad-stream"), line = $("#ad-status");
      if (s && adStatus() === "running") s.textContent = ad.stream;
      if (line) line.textContent = adStatusLine(v.state);
      return;
    }
    if (proj && proj.id === ad.expectProj) {
      proj.ext = Object.assign({}, proj.ext, { director: v.state });
      if (v.state.status !== "running") { if (DEMO) adSaveSoon(); else persistNow(); } // the run ended or paused: keep its state on the server
    }
    adSync();
  }

  function adRunner() {
    if (ad.runner) return ad.runner;
    ad.expectProj = proj.id;
    ad.runner = MBSDR.createRunner({
      turn: (req) => (DEMO ? adSimTurn(req) : adGeminiTurn(req)),
      parse: (t) => P.parse(t, { startPhrase: startPhrase() }),
      cost: (u, model) => E.geminiCost(u, adRateFor(model)),
      route: () => settings.geminiRoute,
      pauseEach: () => !!dirUi().pauseEach,
      onChange: adOnChange, onTurn: adOnTurn,
    });
    const saved = proj.ext.director;
    if (saved && saved.v === 1 && proj.text) ad.runner.load({ state: saved, text: proj.text });
    return ad.runner;
  }

  // Leaving the project: a reply in flight is dropped and the run is saved as paused.
  function adLeave() {
    if (!ad.runner) return;
    if (adStatus() === "running") ad.runner.pause();
    clearTimeout(ad.saveTimer);
    // /app: the last reply was already saved and a saved "running" run reopens as paused, so nothing is written here.
    if (DEMO && proj && proj.id === ad.expectProj) saveProject().catch(() => {});
    ad.runner.detach(); ad.runner = null; ad.file = null; ad.b64 = null; ad.info = null; ad.base = null; ad.upload = null; ad.busy = ""; ad.stream = ""; ad.retry = null; ad.lastState = null; ad.auto = false;
  }

  async function adStart(auto) {
    const block = adBlock();
    if (block) { toast(block); return; }
    await ensureVault();
    if (!DEMO && !vs.loaded) { toast("Could not load the Master Prompt, so the run cannot start. Open Setup and retry."); return; }
    if (proj.parsed && (proj.parsed.chunks.length || proj.parsed.scenes.length || (proj.parsed.reels || []).length)) {
      if (!(await ask({ title: "Replace the parsed content?", text: "This project already has parsed content. The AI Director run will replace it as it writes. Progress and audio for unchanged items are kept.", confirm: "Replace and start" }))) return;
    }
    const lang = adLang(), first = adFirstText();
    let pdf = null;
    if (ad.file) {
      pdf = { name: ad.file.name, size: ad.file.size, pages: ad.info ? ad.info.pages : null, mode: ad.file.size <= GM.INLINE_MAX_BYTES ? "inline" : "file" };
    }
    ad.expectProj = proj.id;
    if (!ad.runner) adRunner();
    ad.base = null;
    if (!DEMO) {
      try {
        if (ad.file && pdf.mode === "file") {
          ad.busy = "Uploading the PDF to Gemini..."; adSync();
          try { ad.upload = await GM.uploadFile({ key: settings.geminiKey, blob: ad.file, name: ad.file.name }); } finally { ad.busy = ""; }
          pdf.uri = ad.upload.uri; pdf.expiresAt = ad.upload.expiresAt;
        }
        const inlineRef = ad.file && pdf.mode === "inline" ? { inline: ad.b64 || (ad.b64 = await GM.blobToBase64(ad.file)) } : pdf && pdf.uri ? { uri: pdf.uri } : null;
        try { ad.base = await GM.countTokens({ key: settings.geminiKey, model: adStageModel(1), system: vs.state.text, contents: GM.toContents([{ role: "user", text: first }], inlineRef) }); } catch { /* the estimate falls back to a rough count */ }
      } catch (e) { ad.busy = ""; toast(e.message); adSync(); return; }
    }
    if (proj.lang === "auto") proj.lang = lang;
    ad.runner.start({ language: lang, model: adStageModel(1), maxTurns: dirUi().maxTurns || MBSD.DEFAULT_MAX_TURNS, first, pdf }, auto).catch((e) => toast(e.message));
  }

  async function adReset() {
    if (!(await ask({ title: "Start over?", text: "This clears the AI Director run (its turns, tokens and cost). The project's parsed content stays until the next run replaces it.", confirm: "Start over", danger: true }))) return;
    if (ad.runner) { ad.runner.stop(); ad.runner.detach(); ad.runner = null; }
    proj.ext = Object.assign({}, proj.ext); delete proj.ext.director;
    ad.stream = ""; ad.busy = ""; ad.retry = null; ad.base = null;
    await saveProject();
    renderTab();
  }

  async function adPick(file) {
    if (!file) return;
    if (!/\.pdf$/i.test(file.name) && !/pdf/i.test(file.type)) { toast("Choose a PDF file."); return; }
    let pages = null;
    if (file.size <= 30 * 1048576) { try { pages = GM.countPdfPages(await file.arrayBuffer()); } catch { /* unknown */ } }
    const problem = GM.pdfProblem(file.size, pages);
    if (problem) { toast(problem); return; }
    ad.file = file; ad.b64 = null; ad.upload = null; ad.base = null; ad.info = { name: file.name, size: file.size, pages };
    adPdfLine();
    adSync();
  }
  const sizeText = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");
  function adPdfLine() {
    const el = $("#ad-pdfinfo");
    if (!el) return;
    el.hidden = !ad.info;
    if (ad.info) {
      $("#ad-pdfname").textContent = ad.info.name + " (" + sizeText(ad.info.size) + (ad.info.pages ? ", " + ad.info.pages + " pages" : "") + ")";
      $("#ad-pdfhow").textContent = ad.info.size <= GM.INLINE_MAX_BYTES ? "Sent with every turn as part of the conversation." : "Uploaded once to Gemini and reused by every turn.";
    }
  }

  function renderDirector(p) {
    const u = dirUi(), saved = proj.ext.director;
    const stepRow = '<ol class="ad-steps" id="ad-steps" aria-label="Stages">' + MBSD.STAGES.map((s) => "<li>" + esc(s.label) + "</li>").join("") + "</ol>";
    p.innerHTML =
      '<div id="ad-root" class="page">' +
      '<section class="step step-setup" aria-labelledby="ad1"><div class="step-head"><span class="step-chip" aria-hidden="true">1</span><h3 id="ad1">Output language</h3></div>' +
      '<div class="grid2"><div class="field"><label for="ad-lang">Language of the book package</label>' + ddHtml("ad-lang", "", "") + '<span class="hint">' + (DEMO ? "The demo director always answers in English." : "Sent to the director in the first message.") + '</span></div>' +
      '<div class="field"><span class="label">Start phrase</span><span class="hint" id="ad-phrase-note" style="margin:0"></span></div></div></section>' +
      '<section class="step step-setup" aria-labelledby="ad2"><div class="step-head"><span class="step-chip" aria-hidden="true">2</span><h3 id="ad2">The book</h3></div>' +
      '<div class="dropzone" id="ad-drop" tabindex="0" role="button" aria-label="Add the book as a PDF. Drop it here or press Enter to choose it." style="margin:0 0 8px">' + icon("file-up") + '<div><strong>Drop the book PDF here, or choose a file</strong><span class="hint">Up to 50 MB or 1,000 pages. ' + (DEMO ? "In this demo the file is not sent anywhere." : "Under about 14 MB it is sent inline; larger files are uploaded once to Gemini.") + '</span></div><input type="file" id="ad-file" hidden accept="application/pdf,.pdf"></div>' +
      '<p class="small" id="ad-pdfinfo" hidden><span id="ad-pdfname"></span> <button type="button" class="btn sm ghost" id="ad-pdfrm">Remove</button><br><span class="hint" id="ad-pdfhow"></span></p>' +
      '<p class="hint" id="ad-pdfnote" hidden style="margin:0 0 8px">The saved run used a PDF that is no longer attached. Choose it again to send it with the next turns, or go on without it.</p>' +
      '<div class="grid2"><div class="field"><label for="ad-title">Book title</label><input id="ad-title" class="input" dir="auto" maxlength="200" autocomplete="off" data-1p-ignore data-lpignore="true" data-form-type="other" value="' + esc(u.title || "") + '"></div>' +
      '<div class="field"><label for="ad-sum">Summary or notes</label><textarea id="ad-sum" class="input" dir="auto" maxlength="20000" style="min-height:120px" spellcheck="false" placeholder="A PDF, a title or a summary is enough. Add more than one if you like."></textarea></div></div></section>' +
      '<section class="step step-generate" aria-labelledby="ad3"><div class="step-head"><span class="step-chip" aria-hidden="true">3</span><h3 id="ad3">Run the director</h3><span class="state-badge ' + (geminiState().ok ? "ready" : "needs") + '">' + esc(DEMO ? "Simulated" : geminiState().text) + "</span></div>" +
      '<p class="hint" id="ad-keynote" hidden style="margin:0 0 8px"><a href="#setup" data-ad-setup>Configure your Gemini API key in Setup to run directly here.</a></p>' +
      '<p class="hint" id="ad-vaultnote" hidden style="margin:0 0 8px">The Master Director Prompt is empty. <a href="#setup" data-ad-setup>Add it in Setup.</a></p>' +
      '<div class="row ad-btns"><button type="button" class="btn primary" id="ad-start">' + icon("play") + 'Start Project</button><button type="button" class="btn" id="ad-next">' + icon("skip-forward") + 'Next Step</button><button type="button" class="btn" id="ad-auto">' + icon("fast-forward") + 'Auto-Run All 6 Stages</button>' +
      '<button type="button" class="btn" id="ad-pause" hidden>' + icon("pause") + 'Pause</button><button type="button" class="btn" id="ad-resume" hidden>' + icon("play") + 'Resume</button><button type="button" class="btn danger" id="ad-stop">' + icon("square") + 'Stop</button><button type="button" class="btn ghost" id="ad-over" hidden>' + icon("rotate-ccw") + "Start over</button></div>" +
      '<p class="gen-reason" id="ad-reason" hidden><span id="ad-reason-text"></span></p>' +
      '<div class="ad-meta"><span class="ad-chip" id="ad-turns"></span><span class="ad-chip" id="ad-stage"></span><label class="small ad-max"><input type="checkbox" id="ad-pause-each"' + (u.pauseEach ? " checked" : "") + '> Pause after each stage</label><label class="small ad-max">Max turns <input id="ad-max" class="input mono" type="number" min="1" max="200" inputmode="numeric" value="' + (saved ? saved.maxTurns : u.maxTurns || MBSD.DEFAULT_MAX_TURNS) + '"></label></div>' +
      '<div class="field ad-model"><label for="ad-model">Model for the next stage</label>' + ddHtml("ad-model", "", "") + '<span class="hint" id="ad-model-note"></span></div>' +
      stepRow + '<p class="ad-status" id="ad-status" role="status" aria-live="polite"></p>' +
      '<div class="ad-cost" id="ad-cost"></div>' +
      '<p class="small" id="ad-found" hidden><span id="ad-found-text"></span> <button type="button" class="btn sm" id="ad-yt">' + icon("monitor-play") + 'Open YouTube tab</button> <button type="button" class="btn sm" id="ad-rl">' + icon("smartphone") + "Open Reels tab</button></p></section>" +
      '<section class="step step-setup" id="ad-live" aria-labelledby="ad4" hidden><div class="step-head"><span class="step-chip" aria-hidden="true">4</span><h3 id="ad4">Live reply</h3><span class="step-tools"><button type="button" class="btn sm ghost" id="ad-toggle" aria-expanded="' + ad.open + '" aria-controls="ad-stream">' + (ad.open ? "Hide" : "Show") + "</button></span></div>" +
      '<div class="ad-stream content" id="ad-stream" dir="auto" tabindex="0" role="region" aria-label="Latest reply from the director"' + (ad.open ? "" : " hidden") + "></div>" +
      '<ul class="ad-log small muted" id="ad-log"></ul><p class="small" id="ad-total"></p>' +
      '<details class="ad-convo" id="ad-convo" hidden><summary>Full conversation <span class="muted small" id="ad-convo-count"></span></summary>' +
      '<div class="row" style="margin:10px 0"><button type="button" class="btn sm" id="ad-convo-copy">' + icon("copy") + 'Copy whole conversation</button><button type="button" class="btn sm" id="ad-convo-dl">' + icon("download") + 'Download .txt</button></div><div id="ad-convo-body"></div></details>' +
      '<div id="ad-fb-box" class="ad-fb" hidden><label for="ad-fb" class="label">Feedback for the director</label><textarea id="ad-fb" class="input" dir="auto" style="min-height:80px" placeholder="Reply to the model about this stage, for example what to change. It is sent as your next message."></textarea>' +
      '<div class="row" style="margin-top:8px"><button type="button" class="btn primary" id="ad-fb-send">' + icon("send") + 'Send feedback</button><button type="button" class="btn" id="ad-regen">' + icon("refresh-cw") + 'Regenerate</button><button type="button" class="btn" id="ad-edit">' + icon("pencil") + 'Edit reply</button></div>' +
      '<div id="ad-edit-box" hidden style="margin-top:10px"><label for="ad-edit-text" class="label">Edit the reply, then accept it</label><textarea id="ad-edit-text" class="input" dir="auto" style="min-height:200px" spellcheck="false"></textarea><div class="row" style="margin-top:8px"><button type="button" class="btn primary" id="ad-edit-ok">Accept edit</button><button type="button" class="btn ghost" id="ad-edit-cancel">Cancel</button></div></div></div>' +
      '<div id="ad-reply-box" hidden><label for="ad-reply" class="label">Your answer to the director</label><textarea id="ad-reply" class="input" dir="auto" style="min-height:90px"></textarea><div class="row" style="margin-top:8px"><button type="button" class="btn primary" id="ad-send">Send reply</button><button type="button" class="btn" id="ad-send-auto">Send and Auto-Run</button></div></div></section></div>';
    const ta = $("#ad-sum", p); ta.value = u.summary || "";
    ddInit("ad-lang", [["fa", "Persian"], ["en", "English"]], adLang(), (v) => { dirUi().lang = v; ad.base = null; adSaveSoon(); adPhraseNote(); adSync(); });
    ad.modelDd = ddInit("ad-model", adModelOpts(), saved && saved.modelOverride ? saved.modelOverride : "", (v) => { if (ad.runner && ad.runner.state) { ad.runner.setModel(v); } else { toast("Pick the model after Start Project. Until then Setup decides."); ad.modelDd.set(adModelOpts(), ""); } adSync(); });
    adPhraseNote(); adPdfLine();
    $("#ad-title", p).addEventListener("input", (e) => { dirUi().title = e.target.value; adSaveSoon(); adSync(); });
    ta.addEventListener("input", () => { dirUi().summary = ta.value; adSaveSoon(); adSync(); });
    const drop = $("#ad-drop", p), fileIn = $("#ad-file", p);
    drop.addEventListener("click", () => fileIn.click());
    drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileIn.click(); } });
    fileIn.addEventListener("click", (e) => e.stopPropagation());
    fileIn.addEventListener("change", () => { const f = fileIn.files[0]; fileIn.value = ""; adPick(f); });
    ["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); }));
    ["dragleave", "drop"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
    drop.addEventListener("drop", (e) => adPick(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]));
    $("#ad-pdfrm", p).addEventListener("click", () => { ad.file = null; ad.b64 = null; ad.info = null; ad.upload = null; ad.base = null; adPdfLine(); adSync(); });
    $$("[data-ad-setup]", p).forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); go("setup"); }));
    $("#ad-max", p).addEventListener("change", (e) => {
      const v = Math.max(1, Math.min(200, Math.floor(Number(e.target.value)) || MBSD.DEFAULT_MAX_TURNS));
      e.target.value = v; dirUi().maxTurns = v; if (ad.runner && ad.runner.state) ad.runner.setMaxTurns(v);
      adSaveSoon();
    });
    $("#ad-start", p).addEventListener("click", () => { ad.auto = false; adStart(false); });
    $("#ad-auto", p).addEventListener("click", () => { ad.auto = true; if (adStatus() === "idle") adStart(true); else ad.runner.auto().catch((e) => toast(e.message)); });
    $("#ad-next", p).addEventListener("click", () => { ad.auto = false; ad.runner.next().catch((e) => toast(e.message)); });
    $("#ad-pause", p).addEventListener("click", () => ad.runner.pause());
    $("#ad-resume", p).addEventListener("click", () => ad.runner.resume(ad.auto).catch((e) => toast(e.message)));
    $("#ad-stop", p).addEventListener("click", () => ad.runner.stop());
    $("#ad-over", p).addEventListener("click", adReset);
    $("#ad-toggle", p).addEventListener("click", (e) => { ad.open = !ad.open; e.target.textContent = ad.open ? "Hide" : "Show"; e.target.setAttribute("aria-expanded", String(ad.open)); $("#ad-stream").hidden = !ad.open; });
    $("#ad-convo-copy", p).addEventListener("click", async () => {
      const ok = await copyText(MBSD.conversationText(adTurns()));
      toast(ok ? "Whole conversation copied to the clipboard." : "Could not copy. Select the text and copy it by hand.");
    });
    $("#ad-convo-dl", p).addEventListener("click", () => {
      const slug = proj.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
      A.download(new Blob([MBSD.conversationText(adTurns())], { type: "text/plain;charset=utf-8" }), slug + "-director-conversation.txt");
    });
    $("#ad-send", p).addEventListener("click", () => { const t = $("#ad-reply").value.trim(); if (t) { $("#ad-reply").value = ""; ad.runner.reply(t, false).catch((e) => toast(e.message)); } });
    $("#ad-send-auto", p).addEventListener("click", () => { const t = $("#ad-reply").value.trim(); if (t) { $("#ad-reply").value = ""; ad.runner.reply(t, true).catch((e) => toast(e.message)); } });
    $("#ad-pause-each", p).addEventListener("change", (e) => { dirUi().pauseEach = e.target.checked; adSaveSoon(); });
    $("#ad-fb-send", p).addEventListener("click", () => { const t = $("#ad-fb").value.trim(); if (!t) { toast("Write your feedback first."); return; } $("#ad-fb").value = ""; ad.auto = false; ad.runner.reply(t, false).catch((e) => toast(e.message)); });
    $("#ad-regen", p).addEventListener("click", () => { ad.auto = false; ad.editing = false; $("#ad-edit-box").hidden = true; ad.runner.regenerate().catch((e) => toast(e.message)); });
    $("#ad-edit", p).addEventListener("click", () => {
      const m = [...ad.runner.history].reverse().find((x) => x.role === "model");
      if (!m) return;
      ad.editing = true; $("#ad-edit-text").value = m.text; $("#ad-edit-box").hidden = false; $("#ad-edit").hidden = true; $("#ad-edit-text").focus();
    });
    $("#ad-edit-cancel", p).addEventListener("click", () => { ad.editing = false; $("#ad-edit-box").hidden = true; $("#ad-edit").hidden = false; });
    $("#ad-edit-ok", p).addEventListener("click", async () => {
      const ok = await ad.runner.editLast($("#ad-edit-text").value);
      if (!ok) { toast("The reply cannot be empty."); return; }
      ad.editing = false; $("#ad-edit-box").hidden = true; $("#ad-edit").hidden = false; toast("Edit accepted. The director will see your version.");
      adSync();
    });
    $("#ad-yt", p).addEventListener("click", () => go("youtube", "audio"));
    $("#ad-rl", p).addEventListener("click", () => go("reels"));
    if (saved && saved.v === 1 && proj.text) adRunner();
    ensureVault().then(() => { adSync(); });
    adSync();
  }

  const adModelOpts = () => [["", "Follow routing"]].concat(GM.MODELS.map((m) => [m.id, m.id + " - " + m.label]));

  function adPhraseNote() {
    const el = $("#ad-phrase-note");
    if (!el) return;
    const ph = startPhrase();
    if (adLang() === "en" && !ph) { el.textContent = "English runs need no start phrase unless your prompt makes every chunk start with one."; return; }
    el.innerHTML = ph
      ? "Chunks are found by this phrase: <span class=\"mono\" dir=\"auto\">" + esc(ph) + "</span>" + (DEMO ? "" : ". It comes from your start phrase setting.") + ""
      : "No start phrase is set, so no audio chunks can be found yet. <button type=\"button\" class=\"btn sm\" id=\"ad-phrase-go\">Set it in Paste Conversation, step 1</button> (once; it is saved in this browser)";
    const b = $("#ad-phrase-go");
    if (b) b.addEventListener("click", () => { dirUi().mode = "paste"; adSaveSoon(); renderTab(); const f = $("#phrase"); if (f) f.focus(); });
  }

  const modeBtn = (id, on, label) => '<button type="button" class="btn" id="mode-' + id + '" aria-pressed="' + on + '">' + label + "</button>";
  function renderImport(p) {
    const ai = impMode() === "ai";
    p.innerHTML =
      '<div class="page">' + pageHead("Import & Parse", "Let the AI Director write the book package here, or paste a Gemini conversation. Either way it is split into audio chunks, scenes, reels, covers and publishing text.", "import") +
      howtoHtml() +
      '<div class="seg imp-mode" role="group" aria-label="How to get the conversation">' + modeBtn("ai", ai, "AI Director (Auto-Generate)") + modeBtn("paste", !ai, "Paste Conversation") + "</div>" +
      '<div id="imp-mode" class="page"></div></div>';
    bindHowto(p);
    $$(".imp-mode .btn", p).forEach((b) => b.addEventListener("click", () => {
      const want = b.id === "mode-ai" ? "ai" : "paste";
      if (want === impMode()) return;
      dirUi().mode = want; adSaveSoon(); renderTab();
    }));
    (ai ? renderDirector : renderPaste)($("#imp-mode", p));
  }

  // ---------- Audio (YouTube chunks and Reels audio share the settings, folder and queue) ----------
  // The settings a run uses: the global defaults from Setup, with this page session's "Custom for this run" overrides on top.
  const eff = () => Object.assign({}, settings, rt.ovr || {});
  const stabilityText = (model, v) => (model === "eleven_v3" ? v.toFixed(1) + " (" + A.V3_PRESETS[v] + ")" : v.toFixed(2));

  // Collapsible Setup cards. The open or closed choice is kept per card in this browser (localStorage, by mode); until a card has a choice,
  // everything is open on a first run (nothing configured yet) and later only the cards that still need something are open.
  const cardsKey = () => store.prefix + ":setupcards";
  const cardsRead = () => { try { return JSON.parse(localStorage.getItem(cardsKey()) || "{}") || {}; } catch { return {}; } };
  const setupFirstRun = () => DEMO || (!settings.apiKey && !settings.geminiKey);
  function cardOpen(id, dflt) { const v = cardsRead()[id]; return typeof v === "boolean" ? v : !!dflt; }
  const cardToggle = (id, title, open) => '<button type="button" class="btn sm ghost card-toggle" data-card="' + id + '" aria-expanded="' + open + '" aria-controls="' + id + '-body" aria-label="' + (open ? "Collapse " : "Expand ") + esc(title.replace(/<[^>]*>/g, "")) + '">' + icon("chevron-down") + "</button>";
  function bindCards(p) {
    $$(".card-toggle", p).forEach((b) => b.addEventListener("click", () => {
      const open = b.getAttribute("aria-expanded") !== "true", id = b.dataset.card, label = b.getAttribute("aria-label").replace(/^(Collapse|Expand) /, "");
      const all = cardsRead(); all[id] = open;
      try { localStorage.setItem(cardsKey(), JSON.stringify(all)); } catch { /* blocked: the choice lasts until the page is closed */ }
      b.setAttribute("aria-expanded", String(open)); b.setAttribute("aria-label", (open ? "Collapse " : "Expand ") + label);
      $("#" + id + "-body", p).hidden = !open;
    }));
  }

  // The Setup tab: every global setting once. Three numbered cards: ElevenLabs, rates and plan, output folder and display.
  function setupPanelHtml() {
    const v3 = settings.model === "eleven_v3", st = setupState(), gst = geminiState();
    const first = setupFirstRun();
    const card = (n, title, extra, body, ready) => {
      const open = cardOpen("set" + n, first || ready === false);
      return '<section class="step step-setup" aria-labelledby="set' + n + '"><div class="step-head"><span class="step-chip" aria-hidden="true">' + n + '</span><h3 id="set' + n + '">' + title + "</h3>" + (extra || "") + cardToggle("set" + n, title, open) + "</div>" +
        '<div class="card-body" id="set' + n + '-body"' + (open ? "" : " hidden") + ">" + body + "</div></section>";
    };
    return '<span id="settings"></span>' +
      card(1, "ElevenLabs", '<span class="state-badge ' + (st.ok ? "ready" : "needs") + '" id="s-state">' + esc(st.text) + '</span><span class="step-sum" id="s-summary">' + esc(settingsSummary()) + "</span>",
        (DEMO
          ? '<p class="hint" style="margin:0 0 12px">Demo: audio is simulated. No key or voice is needed and nothing leaves your browser. The real app calls ElevenLabs with your own key.</p>'
          : '<p class="hint" style="margin:0 0 12px">The key is stored only in this browser (localStorage) and sent only to api.elevenlabs.io. It is never saved to your account.</p>') +
        '<div class="grid2">' +
        '<div class="field"><label for="s-key">API key</label><input id="s-key" class="input mono" type="password" autocomplete="off" data-1p-ignore data-lpignore="true" spellcheck="false" ' + (DEMO ? 'disabled placeholder="Not needed in the demo"' : 'value="' + esc(settings.apiKey) + '" placeholder="sk_..."') + "></div>" +
        '<div class="field"><label for="s-voice">Voice ID</label><input id="s-voice" class="input mono" autocomplete="off" data-1p-ignore data-lpignore="true" data-form-type="other" spellcheck="false" ' + (DEMO ? 'disabled placeholder="Not needed in the demo"' : 'value="' + esc(settings.voiceId) + '"') + "></div>" +
        '<div class="field"><label for="s-model">Default model</label>' + ddHtml("s-model", "", "") +
        '<span class="hint" id="s-model-hint">' + A.MODELS[settings.model].maxChars.toLocaleString() + " characters per chunk at most.</span></div>" +
        '<div class="field"><label for="s-stab">Default stability: <output id="s-stab-out">' + stabilityText(settings.model, settings.stability) + '</output></label>' +
        '<input id="s-stab" type="range" min="0" max="1" step="' + (v3 ? "0.5" : "0.05") + '" value="' + settings.stability + '">' +
        '<span class="hint" id="s-stab-hint">' + (v3 ? "Eleven v3 only accepts 0.0 (Creative), 0.5 (Natural) or 1.0 (Robust)." : "Lower is more expressive, higher is more even.") + "</span></div></div>" +
        '<p class="hint" style="margin:12px 0 0">These are the defaults. A single run or one chunk can use other settings from the Generate card without changing them.</p>' +
        '<div class="subsec">' + ratesHtml() +
        '<div class="plan" id="plan"><div class="plan-top"><strong>Your plan</strong><button type="button" class="btn sm" id="sub-refresh">' + icon("refresh-cw") + 'Refresh</button></div><p id="sub-panel" class="small" role="status" aria-live="polite"></p></div></div>', st.ok) +
      card(2, "Gemini AI Director", '<span class="state-badge ' + (gst.ok ? "ready" : "needs") + '" id="g-state">' + esc(gst.text) + '</span><span class="step-sum" id="g-summary">' + esc(geminiSummary()) + "</span>", geminiCardHtml(), gst.ok) +
      card(3, "Output folder and audio preferences", "", '<div class="step-row">' + folderRow() + "</div>" + '<div style="margin-top:12px">' + dimToggle() + "</div>", true) +
      card(4, "Master Director Prompt", "", '<div id="sv-body"><p class="hint">Loading...</p></div>', true);
  }

  function renderSetup(p) {
    p.innerHTML = '<div class="page">' + pageHead("Setup", "One card per service: ElevenLabs and Gemini with their rates, then output and preferences and the Master Director Prompt. Set once for every screen. Press Save to keep your changes: keys and rates stay in this browser, the Master Prompt goes to your account." , "setup") + setupPanelHtml() + "</div>";
    bindCards(p);
    syncSave();
    bindSettings(p);
    bindGemini(p);
    ensureVault().then(() => renderVault());
    bindFolder(p);
    syncSetupState();
    syncSubPanel();
    loadSub(false);
    localCopiesRow(p);
    backupRow(p);
  }

  // "Local copies from before server storage": only when the old browser-only database still has projects (/app only).
  function localCopiesRow(p) {
    if (DEMO || !window.MBSMigrate) return;
    window.MBSMigrate.summary(store).then((sum) => {
      const page = $(".page", p);
      if (!sum || !page || tab !== "setup" || $("#set-local", p)) return;
      const sec = document.createElement("section");
      sec.className = "step step-setup"; sec.id = "set-local"; sec.setAttribute("aria-labelledby", "set5");
      sec.innerHTML = '<div class="step-head"><span class="step-chip" aria-hidden="true">5</span><h3 id="set5">Local copies from before server storage</h3>' + cardToggle("set5", "Local copies from before server storage", cardOpen("set5", true)) + "</div>" +
        '<div class="card-body" id="set5-body"' + (cardOpen("set5", true) ? "" : " hidden") + '><p class="hint" style="margin:0 0 12px">' + sum.count + " project" + (sum.count === 1 ? "" : "s") + " (" + (sum.bytes / 1048576).toFixed(1) + " MB audio) still kept only in this browser" + (sum.pending ? ", " + sum.pending + " not on the server yet." : ". All of them are already on the server, so you can delete the local copies.") + '</p>' +
        '<div class="row"><button type="button" class="btn" id="loc-up">' + icon("upload") + 'Upload</button><button type="button" class="btn danger" id="loc-del">' + icon("trash-2") + "Delete local copies</button></div></div>";
      page.append(sec);
      bindCards(sec);
      icons();
      $("#loc-up", sec).addEventListener("click", async () => { await window.MBSMigrate.openDialog(store); if (tab === "setup") renderTab(); });
      $("#loc-del", sec).addEventListener("click", async () => {
        if (!(await ask({ title: "Delete local copies?", text: window.MBSMigrate.CONFIRM_DELETE, confirm: "Delete local copies", danger: true }))) return;
        await window.MBSMigrate.removeLocal();
        try { localStorage.setItem("mbs_app:migrated", "1"); } catch { /* blocked */ }
        const f = $(".footer .linkbtn"); if (f) f.remove();
        toast("Deleted the local copies.");
        sec.remove();
      });
    }).catch(() => {});
  }

  // "Backups": last daily backup (D1 dump and the incremental media copy, see src/backup.js) and a button for one more bounded pass (/app only).
  function backupRow(p) {
    if (DEMO) return;
    const when = (iso) => { const d = new Date(iso); return isNaN(d) ? "unknown" : d.toLocaleString(); };
    const summary = (r) => {
      if (!r) return "No backup has run yet. The first one runs at the next daily schedule, or press Run backup now.";
      const rows = r.db ? r.db.totalRows + " database rows" : "database not saved";
      const m = r.media ? r.media.copied + " media files copied this run, " + r.media.remaining + " still to copy" + (r.media.failed.length ? ", " + r.media.failed.length + " failed" : "") : "media not checked";
      return "Last run " + when(r.startedAt) + (r.ok ? "" : " (with errors)") + ": " + rows + ", " + m + ".";
    };
    apiFetch("/api/backup/status").then((res) => (res.ok ? res.json() : null)).then((data) => {
      const page = $(".page", p);
      if (!data || typeof data.configured !== "boolean" || !page || tab !== "setup" || $("#set-backup", p)) return;
      const n = $$(".step-setup", p).length + 1, id = "set" + n, title = "Backups";
      const sec = document.createElement("section");
      sec.className = "step step-setup"; sec.id = "set-backup"; sec.setAttribute("aria-labelledby", id);
      sec.innerHTML = '<div class="step-head"><span class="step-chip" aria-hidden="true">' + n + '</span><h3 id="' + id + '">' + title + "</h3>" + cardToggle(id, title, cardOpen(id, true)) + "</div>" +
        '<div class="card-body" id="' + id + '-body"' + (cardOpen(id, true) ? "" : " hidden") + '><p class="hint" style="margin:0 0 12px" id="bk-sum" role="status" aria-live="polite"></p>' +
        '<div class="row"><button type="button" class="btn" id="bk-run"' + (data.configured ? "" : " disabled") + ">" + icon("database-backup") + "Run backup now</button></div></div>";
      page.append(sec);
      bindCards(sec);
      icons();
      const sum = $("#bk-sum", sec), btn = $("#bk-run", sec);
      sum.textContent = data.configured ? summary(data.lastRun) : "Backups are not set up on this server yet.";
      btn.addEventListener("click", async () => {
        btn.disabled = true; sum.textContent = "Running a backup pass...";
        try {
          const res = await apiFetch("/api/backup/run", { method: "POST" });
          const body = await res.json().catch(() => ({}));
          if (!res.ok) sum.textContent = res.status === 429 ? "A backup ran a moment ago. Try again in a minute." : "The backup could not run.";
          else sum.textContent = summary(body.lastRun);
        } catch { sum.textContent = "The backup could not run."; }
        btn.disabled = false;
      });
    }).catch(() => {});
  }

  // ---------- Gemini AI Director settings (Setup card) ----------
  const geminiReady = () => DEMO || !!settings.geminiKey;
  function geminiState() { return DEMO ? { ok: true, text: "Simulated" } : settings.geminiKey ? { ok: true, text: "Ready" } : { ok: false, text: "Needs API key" }; }
  const routeText = () => { const id = MBSD.routeLabelId(settings.geminiRoute); return id === "custom" ? "Custom routing" : MBSD.ROUTE_PRESETS.find((p) => p.id === id).label; };
  function geminiSummary() { return DEMO ? "Simulated director, nothing leaves your browser" : routeText() + " · " + (settings.geminiKey ? "Key saved" : "No API key"); }
  const geminiModelHint = (id) => { const m = GM.MODELS.find((x) => x.id === id); return m ? m.label + ". Up to " + m.maxOutput.toLocaleString() + " output tokens per reply." + (m.note ? " " + m.note : "") : ""; };
  function geminiRatesHtml() {
    const cur = E.normalizeGeminiRates(settings.geminiRates), f = (m, k, label) => '<label>' + label + ' <input class="input mono" type="number" min="0" step="0.01" inputmode="decimal" data-grate="' + m + '" data-f="' + k + '" value="' + cur[m][k] + '"></label>';
    return '<fieldset class="rates"><legend>Token rates (estimates)</legend><p class="hint">USD per 1M tokens, paid tier, from the Gemini pricing page (checked 17 Nov 2026). Output includes thinking tokens. Gemini 2.5 Pro charges more when a single prompt is over 200k tokens; the last two fields set that price. Rates change: edit them if yours differ. gemini-4-carbon is $2 / $10 until 30 Nov 2026 and $4 / $20 after: edit it then.</p>' +
      GM.MODELS.map((m) => '<div class="rate-row"><span class="rate-name">' + esc(m.id) + "</span>" + f(m.id, "in", "Input") + f(m.id, "out", "Output") + f(m.id, "inHi", "Input over 200k") + f(m.id, "outHi", "Output over 200k") + "</div>").join("") +
      '<button type="button" class="btn sm ghost" id="grates-reset">Reset to defaults</button></fieldset>';
  }
  function geminiCardHtml() {
    const dis = ' disabled placeholder="Not needed in the demo"';
    return (DEMO
      ? '<p class="hint" style="margin:0 0 12px">Demo: the AI Director is simulated with a canned fictional conversation. No key is needed and nothing is sent anywhere. The real app calls Gemini with your own key.</p>'
      : '<p class="hint" style="margin:0 0 12px">The key is stored only in this browser (localStorage) and sent only to generativelanguage.googleapis.com. It is never saved to your account. Use a key with a spending limit.</p>') +
      '<div class="grid2">' +
      '<div class="field"><label for="g-key">Gemini API key</label><input id="g-key" class="input mono" type="password" autocomplete="off" data-1p-ignore data-lpignore="true" spellcheck="false"' + (DEMO ? dis : ' value="' + esc(settings.geminiKey) + '" placeholder="AIza..."') + "></div>" +
      '<div class="field"><label for="g-model">Fallback model</label>' + ddHtml("g-model", "", "") + '<span class="hint" id="g-model-hint">' + esc(geminiModelHint(settings.geminiModel)) + "</span></div>" +
      '<div class="field"><label for="g-temp">Temperature</label><input id="g-temp" class="input mono" type="number" min="0" max="2" step="0.1" inputmode="decimal" value="' + settings.geminiTemp + '"' + (DEMO ? " disabled" : "") + '><span class="hint">0 is the most literal, 2 the most random. 0.7 is a moderate default.</span></div>' +
      '<div class="field"><span class="label">Check the key</span><div class="row"><button type="button" class="btn" id="g-test"' + (DEMO ? " disabled" : "") + ">" + icon("plug-zap") + 'Test key</button><span class="small muted" id="g-test-out" role="status" aria-live="polite"></span></div></div></div>' +
      '<div class="subsec"><fieldset class="rates" id="g-route"><legend>Model routing</legend><p class="hint">Each stage of a run can use its own model. Pick a preset, then change single stages if you like. You can also switch models during a run, in the AI Director panel.</p>' +
      '<div class="field"><label for="g-preset">Preset</label>' + ddHtml("g-preset", "", "") + '<span class="hint" id="g-preset-hint"></span></div>' +
      '<div class="grid2">' + MBSD.STAGES.map((s) => '<div class="field"><label for="g-stage-' + s.n + '">Stage ' + s.n + ": " + esc(s.label) + "</label>" + ddHtml("g-stage-" + s.n, "", "") + "</div>").join("") + "</div></fieldset></div>" +
      '<p class="hint" style="margin:12px 0 0">gemini-2.5-pro and gemini-2.5-flash are deprecated and may return 404 for new API keys. They stay selectable in case your key still has them.</p>' +
      '<div class="subsec">' + geminiRatesHtml() + "</div>";
  }
  function syncGeminiState() {
    const st = geminiState(), badge = $("#g-state");
    if (badge) { badge.className = "state-badge " + (st.ok ? "ready" : "needs"); badge.textContent = st.text; }
    const sum = $("#g-summary");
    if (sum) sum.textContent = geminiSummary();
    syncRunGates();
  }
  // Model routing: a preset sets all six stage models, a stage dropdown overrides one (the preset then reads "Custom").
  function bindRouting(p, save) {
    const modelOpts = GM.MODELS.map((m) => [m.id, m.id + " - " + m.label]), stageDd = {};
    const presetOpts = () => MBSD.ROUTE_PRESETS.map((x) => [x.id, x.label]).concat(MBSD.routeLabelId(settings.geminiRoute) === "custom" ? [["custom", "Custom (per stage)"]] : []);
    const hint = () => { const id = MBSD.routeLabelId(settings.geminiRoute), x = MBSD.ROUTE_PRESETS.find((q) => q.id === id); $("#g-preset-hint", p).textContent = x ? x.hint + "." : "Your own choice for each stage."; };
    const sync = () => { presetDd.set(presetOpts(), MBSD.routeLabelId(settings.geminiRoute)); hint(); syncGeminiState(); refreshCostBadge(); };
    const presetDd = ddInit("g-preset", presetOpts(), MBSD.routeLabelId(settings.geminiRoute), (v) => {
      if (v === "custom") return;
      settings.geminiRoute = { preset: v, stages: {} }; save();
      MBSD.STAGES.forEach((s) => stageDd[s.n].set(modelOpts, adStageModel(s.n)));
      sync();
    });
    MBSD.STAGES.forEach((s) => {
      stageDd[s.n] = ddInit("g-stage-" + s.n, modelOpts, adStageModel(s.n), (v) => {
        const r = adRoute(), base = MBSD.ROUTE_PRESETS.find((q) => q.id === r.preset);
        const stages = Object.assign({}, r.stages);
        if (base.models[s.n - 1] === v) delete stages[s.n]; else stages[s.n] = v;
        settings.geminiRoute = { preset: r.preset, stages }; save();
        sync();
      });
    });
    hint();
  }
  function bindGemini(p) {
    const save = setupChanged;
    const key = $("#g-key", p);
    if (key) key.addEventListener("input", () => { settings.geminiKey = key.value.trim(); save(); syncGeminiState(); $("#g-test-out").textContent = ""; });
    ddInit("g-model", GM.MODELS.map((m) => [m.id, m.id + " - " + m.label]), settings.geminiModel, (v) => { settings.geminiModel = v; save(); $("#g-model-hint", p).textContent = geminiModelHint(v); syncGeminiState(); refreshCostBadge(); });
    bindRouting(p, save);
    const temp = $("#g-temp", p);
    temp.addEventListener("change", () => { const v = Number(temp.value); settings.geminiTemp = temp.value.trim() !== "" && v >= 0 && v <= 2 ? v : GM.DEFAULT_TEMPERATURE; temp.value = settings.geminiTemp; save(); });
    $$("[data-grate]", p).forEach((inp) => inp.addEventListener("change", () => {
      const r = Object.assign({}, settings.geminiRates), m = inp.dataset.grate;
      r[m] = Object.assign({}, r[m]);
      const v = Number(inp.value);
      if (inp.value.trim() === "" || !(v >= 0)) delete r[m][inp.dataset.f]; else r[m][inp.dataset.f] = v;
      settings.geminiRates = r; save();
      const n = E.normalizeGeminiRates(r)[m];
      $$('[data-grate="' + m + '"]', p).forEach((x) => { x.value = n[x.dataset.f]; });
      refreshCostBadge();
    }));
    $("#grates-reset", p).addEventListener("click", () => {
      settings.geminiRates = {}; save();
      const d = E.normalizeGeminiRates({});
      $$("[data-grate]", p).forEach((x) => { x.value = d[x.dataset.grate][x.dataset.f]; });
      refreshCostBadge();
    });
    $("#g-test", p).addEventListener("click", async () => {
      const out = $("#g-test-out", p), btn = $("#g-test", p);
      if (!settings.geminiKey) { out.textContent = "Add an API key first."; key.focus(); return; }
      btn.disabled = true; out.textContent = "Testing...";
      try { await GM.testKey({ key: settings.geminiKey }); out.textContent = "The key works."; }
      catch (e) { out.textContent = e.message || "The test failed."; }
      btn.disabled = false;
    });
  }

  // Plan panel: what the account has left (the key's subscription), or the demo's assumption.
  function syncSubPanel() {
    const el = $("#sub-panel");
    if (!el) return;
    const btn = $("#sub-refresh");
    if (btn) btn.hidden = DEMO;
    if (DEMO) { el.textContent = "Demo: assumes the Free plan, " + E.fmt(E.FREE_PLAN_CREDITS) + " credits a month (an estimate). Nothing is read from ElevenLabs."; return; }
    if (!settings.apiKey) { el.textContent = "Add an API key to read your plan. Until then every number is an estimate only."; return; }
    const sub = rt.sub;
    if (!sub) { el.textContent = "Reading your plan..."; return; }
    if (sub.error) { el.textContent = "Could not read the plan (the key may lack permission, or you are offline). Estimates still work, as estimate only."; return; }
    el.textContent = (sub.tier ? "Plan: " + sub.tier + ". " : "") + E.fmt(sub.used) + " of " + E.fmt(sub.limit) + " credits used; " + E.fmt(Math.max(0, sub.limit - sub.used)) + " left" + (sub.resetUnix ? ", resets " + E.resetText(sub.resetUnix) : "") + ".";
  }

  // A compact line at the top of each audio screen: state, a summary and a way into Setup.
  function setupLineHtml() {
    const st = setupState();
    return '<p class="setup-line" id="setup-line"><span class="state-badge ' + (st.ok ? "ready" : "needs") + '" id="s-state">' + esc(st.text) + '</span><span class="step-sum" id="s-summary">' + esc(settingsSummary()) + '</span><button type="button" class="btn sm" data-open-setup>' + icon("settings") + "Open Setup</button></p>";
  }

  const settingsReady = () => DEMO || !!(settings.apiKey && settings.voiceId);
  // Ready, or what is missing: { ok, text (badge), reason (shown next to the disabled Generate button) }.
  function setupState() {
    if (settingsReady()) return { ok: true, text: "Ready", reason: "" };
    const miss = !settings.apiKey && !settings.voiceId ? "API key and voice ID" : !settings.apiKey ? "API key" : "voice ID";
    return { ok: false, text: "Needs " + miss, reason: "Add your " + miss + " in Setup." };
  }
  // Goes to the Setup tab and focuses the first missing field.
  function focusMissing() {
    go("setup");
    const f = $(!settings.apiKey && !DEMO ? "#s-key" : "#s-voice");
    if (f) f.focus();
  }
  // Keeps the badge, the summary, the inline reason and the blocked look of the Generate button in step with the settings.
  function syncSetupState() {
    const st = setupState(), badge = $("#s-state");
    if (badge) { badge.className = "state-badge " + (st.ok ? "ready" : "needs"); badge.textContent = st.text; }
    const sum = $("#s-summary");
    if (sum) sum.textContent = settingsSummary();
    const reason = $("#gen-reason");
    if (reason) { reason.hidden = st.ok; $("#gen-reason-text").textContent = st.reason; }
    const run = $("#run") || $("#run-reels");
    if (run) { run.classList.toggle("is-blocked", !st.ok); if (st.ok) run.removeAttribute("aria-disabled"); else run.setAttribute("aria-disabled", "true"); }
  }
  function settingsSummary() {
    if (DEMO) return "Simulated audio, nothing to set up";
    const v = settings.voiceId;
    return settings.model + " \u00b7 " + (v ? "Voice " + (v.length > 8 ? v.slice(0, 6) + "..." : v) : "No voice ID") + " \u00b7 " + (settings.apiKey ? "Key saved" : "No API key");
  }
  // Credit rates are editable estimates (defaults in estimate.js). Empty or invalid input falls back to the default.
  function ratesHtml() {
    const cur = E.normalizeRates(settings.rates);
    return '<fieldset class="rates"><legend>Credit rates (estimates)</legend><p class="hint">Used for every estimate on this page. Defaults are the published figures: 1 credit per character for v3 and Multilingual v2, 0.5 for Flash v2.5; about $0.08 and $0.04 per 1,000 characters on the pay-as-you-go API. Check your own plan and change them if they differ.</p>' +
      Object.keys(A.MODELS).map((m) => '<div class="rate-row"><span class="rate-name">' + esc(m) + '</span>' +
        '<label>Credits per character <input class="input mono" type="number" min="0" step="0.05" inputmode="decimal" data-rate="' + m + '" data-f="credits" value="' + cur[m].credits + '"></label>' +
        '<label>USD per 1,000 characters <input class="input mono" type="number" min="0" step="0.01" inputmode="decimal" data-rate="' + m + '" data-f="usd" value="' + cur[m].usd + '"></label></div>').join("") +
      '<button type="button" class="btn sm ghost" id="rates-reset">Reset to defaults</button></fieldset>';
  }
  // Re-computes the two estimate lines on every audio card and the batch line (model, rates or overrides changed).
  function refreshCredits() {
    $$("[data-key]").forEach((card) => {
      const k = parseKey(card.dataset.key), t = target(k), a = $("[data-est-a]", card), b = $("[data-est-b]", card);
      if (!t.text || !a || !b) return;
      const x = estParts(t.text);
      a.textContent = x.first; b.textContent = x.full;
    });
    syncGenInfo();
  }
  function bindRates(p) {
    $$("[data-rate]", p).forEach((inp) => inp.addEventListener("change", () => {
      const r = Object.assign({}, settings.rates);
      r[inp.dataset.rate] = Object.assign({}, r[inp.dataset.rate]);
      const v = Number(inp.value);
      if (inp.value.trim() === "" || !(v >= 0)) delete r[inp.dataset.rate][inp.dataset.f]; else r[inp.dataset.rate][inp.dataset.f] = v;
      settings.rates = r;
      setupChanged();
      inp.value = E.normalizeRates(r)[inp.dataset.rate][inp.dataset.f];
      refreshCredits();
    }));
    const reset = $("#rates-reset", p);
    if (reset) reset.addEventListener("click", () => {
      settings.rates = {};
      setupChanged();
      $$("[data-rate]", p).forEach((inp) => { inp.value = E.DEFAULT_RATES[inp.dataset.rate][inp.dataset.f]; });
      refreshCredits();
    });
  }

  function bindSettings(p) {
    const refresh = syncSetupState;
    const sr = $("#sub-refresh", p);
    if (sr) sr.addEventListener("click", () => { rt.sub = null; syncSubPanel(); loadSub(true); });
    const save = setupChanged;
    const key = $("#s-key", p), voice = $("#s-voice", p);
    if (key) key.addEventListener("input", () => { settings.apiKey = key.value.trim(); save(); refresh(); rt.sub = null; clearTimeout(rt.subTimer); rt.subTimer = setTimeout(() => loadSub(false), 700); });
    if (voice) voice.addEventListener("input", () => { settings.voiceId = voice.value.trim(); save(); refresh(); });
    const stab = $("#s-stab", p);
    modelDd = ddInit("s-model", Object.keys(A.MODELS).map((k) => [k, k + " - " + A.MODELS[k].label]), settings.model, (val) => {
      settings.model = val;
      settings.stability = A.snapStability(settings.model, settings.stability);
      save();
      refresh();
      const v3 = settings.model === "eleven_v3";
      stab.step = v3 ? "0.5" : "0.05";
      stab.value = settings.stability;
      $("#s-stab-out", p).textContent = stabilityText(settings.model, settings.stability);
      $("#s-stab-hint", p).textContent = v3 ? "Eleven v3 only accepts 0.0 (Creative), 0.5 (Natural) or 1.0 (Robust)." : "Lower is more expressive, higher is more even.";
      $("#s-model-hint", p).textContent = A.MODELS[settings.model].maxChars.toLocaleString() + " characters per chunk at most.";
      refreshCredits();
    });
    bindRates(p);
    stab.addEventListener("input", () => {
      settings.stability = A.snapStability(settings.model, stab.value);
      stab.value = settings.stability; // snaps the thumb to a valid step
      $("#s-stab-out", p).textContent = stabilityText(settings.model, settings.stability);
      save();
    });
  }

  // A key is a chunk number (main video) or "r<id>" (a reel's audio).
  function target(key) {
    if (typeof key === "string") {
      const id = Number(key.slice(1)), r = reels().find((x) => x.id === id);
      return {
        reel: r, id, text: r && r.audio ? r.audio.text : "", store: "reel:" + id, label: (r ? r.name : "Reel " + pad(id)) + " audio", simN: 10 + id,
        file: (ext) => A.reelFileName(id, ext), save: (m) => { proj.reelAudio[id] = m; }, get m() { return proj.reelAudio[id]; },
      };
    }
    const c = chunks()[key - 1];
    return {
      text: c ? c.text : "", store: key, label: "Chunk " + pad(key), simN: key,
      file: (ext) => A.fileName(key, chunks().length, ext), save: (m) => { proj.audio[key] = m; }, get m() { return proj.audio[key]; },
    };
  }
  const meta = (key) => {
    const t = target(key);
    return t.text && t.m && t.m.hash === hash(t.text) ? t.m : null;
  };
  const statusOf = (key) => rt.status[key] || (meta(key) ? meta(key).status : "waiting");
  const doneCount = () => chunks().filter((c) => meta(c.n)).length;
  const reelDoneCount = () => reelsWithAudio().filter((r) => meta(rKey(r.id))).length;

  function rowHtml(c) {
    return rowView(c.n, "chunk-" + c.n, "Chunk " + pad(c.n), c.chars, c.text);
  }
  // The two estimate lines every audio card shows: the first 10 s (the preview) and the full chunk, with the effective model and the editable rates.
  function estParts(text) {
    const e = eff(), pv = E.previewText(text, E.PREVIEW_CHARS, startPhrase());
    const a = E.estimate([pv], e.model, settings.rates), b = E.estimate([text], e.model, settings.rates);
    const line = (x, approx) => (approx ? "~" : "") + E.fmt(x.chars) + " chars, " + (approx ? "~" : "") + E.fmt(x.credits) + " credits, " + E.usdApprox(x.usd);
    return { first: "First 10 s: " + line(a, true), full: "Full chunk: " + line(b, false) };
  }
  const settingsLabel = (m) => (m && m.model ? m.model + ", stability " + (m.stability !== undefined ? stabilityText(m.model, m.stability) : "default") : "");

  // One card per audio item (main chunk or reel), the same itemCardHtml as every other item:
  // header (title, size, status), script, two estimate lines, footer actions (Generate or Regenerate with a different-settings caret, save), players below.
  function rowView(key, id, label, chars, text) {
    const st = statusOf(key), busy = rt.run.active, have = !!meta(key), url = have && rt.urls[key];
    const isReel = typeof key === "string", reel = isReel ? reels().find((x) => x.id === Number(key.slice(1))) : null;
    const previewing = rt.previewBusy === String(key), x = estParts(text), used = have ? settingsLabel(meta(key)) : "";
    return itemCardHtml({
      id, attrs: ' data-status="' + st + '" data-key="' + key + '"', title: label,
      meta: chars.toLocaleString() + " characters",
      pill: '<span class="pill ' + st + '" role="status">' + STATUS_LABEL[st] + "</span>",
      body: clampHtml(id, text, "", true) +
        (st === "error" && rt.errors[key] ? '<div class="errtext" role="alert">' + esc(rt.errors[key]) + "</div>" : "") +
        '<div class="est-lines"><div class="est-line"><span data-est-a>' + esc(x.first) + '</span><button type="button" class="btn sm ghost" data-preview="' + key + '"' + (busy || previewing ? " disabled" : "") + ' title="Generates only the warm-up phrase and the first sentence. Not saved.">' + icon("play") + (previewing ? "Generating preview..." : "Preview first 10 s") + '</button></div><div class="est-line"><span data-est-b>' + esc(x.full) + "</span></div></div>" +
        (used ? '<div class="hint used" data-used>Generated with ' + esc(used) + "</div>" : "") +
        (reel ? '<div class="hint rnote" role="status">' + esc(reelAudioNote(reel)) + "</div>" : ""),
      actions: '<button type="button" class="btn sm" data-regen="' + key + '"' + (busy ? " disabled" : "") + ">" + icon("refresh-cw") + (have ? "Regenerate" : "Generate") + "</button>" +
        '<button type="button" class="btn sm iconbtn" data-gen-more="' + key + '" aria-haspopup="dialog" aria-label="Generate with different settings..." title="Generate with different settings..."' + (busy ? " disabled" : "") + ">" + icon("chevron-down") + "</button>" +
        '<button type="button" class="btn sm ghost" data-save="' + key + '"' + (have && !busy ? "" : " disabled") + ">" + icon("hard-drive-download") + "Save to folder</button>",
      after: (url ? '<audio controls preload="none" src="' + url + '" aria-label="Audio for ' + esc(label) + '"></audio>' : "") +
        (rt.previews[key] ? '<div class="preview-row"><span class="hint">Preview, not saved</span><audio controls src="' + rt.previews[key] + '" aria-label="Preview of ' + esc(label) + '"></audio></div>' : ""),
    });
  }

  // A reel's audio row (same card as a chunk), or a notice when the reel has no audio chunk.
  const reelAudioRowHtml = (r) => (r.audio ? rowView(rKey(r.id), "reel-" + r.id, r.name + " audio", r.audio.chars, r.audio.text) : '<div class="warn" id="reel-' + r.id + '">No audio chunk found for ' + esc(r.name) + ". Check the start phrase on the Import tab.</div>");

  function swapHtml(el, html) {
    const wrap = document.createElement("div");
    wrap.innerHTML = html;
    el.replaceWith(wrap.firstChild);
    icons();
  }

  function patchRow(key) {
    if (typeof key === "string") { patchReel(Number(key.slice(1))); return; }
    const el = $("#chunk-" + key);
    if (!el || view() !== "youtube-audio") return;
    swapHtml(el, rowHtml(chunks()[key - 1]));
    bindRow(key);
  }

  // The open reel's card is swapped in place; other reels re-read the state when their tab is opened.
  function patchReel(id) {
    const r = reels().find((x) => x.id === id);
    if (!r || tab !== "reels" || String(id) !== subOf.reels || reelSub !== "audio") return;
    const el = $("#reel-" + id);
    if (!el) return;
    swapHtml(el, reelSub === "audio" ? reelAudioRowHtml(r) : reelCardHtml(r));
    const fresh = $("#reel-" + id);
    bindCopy(fresh);
    bindReelCard(fresh);
  }

  const parseKey = (k) => (/^r/.test(String(k)) ? String(k) : Number(k));
  function bindRow(key) {
    const k = parseKey(key);
    const on = (attr, fn) => { const b = $("[" + attr + '="' + key + '"]'); if (b) b.addEventListener("click", fn); };
    on("data-regen", () => regenerate(k));
    on("data-save", () => saveOne(k));
    on("data-preview", () => previewChunk(k));
    on("data-gen-more", () => openRunSettings(k));
  }

  function patchProgress() {
    $$("[data-regen]").forEach((b) => (b.disabled = rt.run.active));
    $$("[data-save]").forEach((b) => (b.disabled = rt.run.active || !meta(parseKey(b.dataset.save))));
    $$("[data-preview]").forEach((b) => (b.disabled = rt.run.active || !!rt.previewBusy));
    $$("[data-gen-more]").forEach((b) => (b.disabled = rt.run.active));
    syncGenInfo();
    refreshCounts();
    updateRunStat();
    const v = view();
    if (tab === "reels") updateReelsProgress($("#panel"));
    if (v !== "youtube-audio" && tab !== "reels") return;
    const reelsV = tab === "reels";
    const total = reelsV ? reelsWithAudio().length : chunks().length, done = reelsV ? reelDoneCount() : doneCount();
    const bar = $("#bar"), prog = $("#prog");
    if (!bar) return;
    const mine = rt.run.active && rt.run.kind === (reelsV ? "reels" : "main");
    const pct = total ? Math.round((done / total) * 100) : 0;
    bar.style.width = pct + "%";
    prog.setAttribute("aria-valuenow", String(pct));
    $("#prog-text").textContent = done + " of " + total + (reelsV ? " reel audio" : "") + " ready" + (mine ? (rt.run.stopping ? " (stopping...)" : " (running)") : "");
    const run = $(reelsV ? "#run-reels" : "#run");
    run.disabled = rt.run.active && !mine;
    if (mine) run.innerHTML = icon("square") + "Stop";
    else if (reelsV) run.innerHTML = icon("smartphone") + (done === 0 ? "Generate all reel audio" : done < total ? "Resume reel audio (" + (total - done) + " left)" : "Regenerate all reel audio");
    else run.innerHTML = icon("play") + (done === 0 ? "Start generating all audio files" : done < total ? "Resume (" + (total - done) + " left)" : "Regenerate all audio files");
    run.classList.toggle("primary", !mine);
    syncSetupState();
    $("#save-all").disabled = rt.run.active || !(doneCount() || reelDoneCount()) || !rt.dir;
    $("#zip").disabled = !(doneCount() || reelDoneCount());
    icons();
  }

  function setStatus(key, st) {
    if (st) rt.status[key] = st; else delete rt.status[key];
    if (st !== "error") delete rt.errors[key];
    patchRow(key);
    patchProgress();
  }

  async function loadUrls() {
    const keys = chunks().map((c) => c.n).concat(reelsWithAudio().map((r) => rKey(r.id)));
    for (const key of keys) {
      if (rt.urls[key] || !meta(key)) continue;
      try {
        const blob = await store.getAudio(proj.id, target(key).store);
        if (blob) { rt.urls[key] = URL.createObjectURL(blob); patchRow(key); }
      } catch { /* missing blob: shown as waiting after next run */ }
    }
    patchProgress();
  }

  // Step 2: the Generate card (primary button, progress, Save all / ZIP). Same card for the main chunks and for all reels.
  function generateCardHtml(reelsV) {
    return '<section class="step step-generate" aria-labelledby="step2-title"><div class="step-head"><span class="step-chip" aria-hidden="true">1</span><h3 id="step2-title">Generate</h3></div>' +
      '<div class="runchips" id="runchips"></div>' +
      '<div class="actionbar"><div class="actionbar-row"><div class="row">' +
      '<button class="btn primary" id="' + (reelsV ? "run-reels" : "run") + '" type="button"></button>' +
      '<button class="btn" id="retry-failed" type="button" hidden></button>' +
      '<button class="btn" id="run-all" type="button" title="Main audio, then reel audio, then a ZIP or folder save">' + icon("rocket") + 'Generate everything</button></div><div class="row">' +
      '<button class="btn" id="save-all" type="button">' + icon("hard-drive-download") + "Save all to folder</button>" +
      '<button class="btn" id="zip" type="button">' + icon("archive") + "Download ZIP</button></div></div>" +
      '<p class="est" id="est" role="status" aria-live="polite"></p><details class="fixlist" id="fixlist" hidden><summary id="fix-sum"></summary><ul id="fix-list"></ul></details>' +
      '<p class="gen-reason" id="gen-reason" hidden><span id="gen-reason-text"></span> <button type="button" class="btn sm" data-open-setup>' + icon("settings") + 'Open Setup</button></p>' +
      '<div class="actionbar-progress"><div class="row small progress-text"><span id="prog-text" role="status" aria-live="polite"></span></div>' +
      '<div class="progress" id="prog" role="progressbar" aria-label="' + (reelsV ? "Reel audio" : "Overall") + ' progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div id="bar"></div></div></div></div>' +
      '<p class="hint" style="margin:12px 0 0">Files are generated one at a time with a ' + GAP_MS / 1000 + ' second gap' + (DEMO ? " (shortened in the demo)" : "") + ". Temporary errors are retried up to " + MAX_ATTEMPTS + " times, then reported. Only one queue runs at a time.</p></section>";
  }
  // The whole audio screen below the page header, one component for both modes: a Setup status line, 1 Generate, 2 Review and save.
  function audioWorkflowHtml(reelsV, listLabel, countText, listHtml) {
    return setupLineHtml() + generateCardHtml(reelsV) +
      '<section class="step step-review" aria-labelledby="step3-title"><div class="step-head"><span class="step-chip" aria-hidden="true">2</span><h3 id="step3-title">Review and save</h3>' +
      '<span class="small muted">' + esc(listLabel) + (countText ? " &middot; " + esc(countText) : "") + '</span><span class="step-tools">' + dimToggle() + "</span></div>" + listHtml + "</section>";
  }
  function bindAudioWorkflow(p, reelsV) {
    $(reelsV ? "#run-reels" : "#run", p).addEventListener("click", () => (rt.run.active ? stopQueue() : startQueue(reelsV ? "reels" : "main")));
    $("#save-all", p).addEventListener("click", saveAll);
    $("#zip", p).addEventListener("click", downloadZip);
    $("#retry-failed", p).addEventListener("click", () => startQueue(reelsV ? "reels" : "main", { onlyKeys: failedKeys(reelsV ? "reels" : "main") }));
    $("#run-all", p).addEventListener("click", () => runPipeline(false));
    $("#runchips", p).addEventListener("click", (e) => { if (e.target.closest("#run-edit")) openRunSettings(); else if (e.target.closest("[data-ovr-clear]")) { rt.ovr = null; refreshCredits(); toast("Back to the Setup defaults."); } });
    $("#fix-list", p).addEventListener("click", (e) => { const b = e.target.closest("[data-jump]"); if (b) jumpTo(b.dataset.jump); });
    loadSub(false);
    $$("[data-open-setup]", p).forEach((b) => b.addEventListener("click", focusMissing));
    syncSetupState();
  }

  function renderAudio(p) {
    if (!chunks().length) { p.innerHTML = emptyState("No audio chunks yet. Paste a conversation first."); bindGoto(p); return; }
    p.innerHTML = '<div class="page">' + pageHead("Audio", "Generate one audio file per chunk of the main video with ElevenLabs, then save them to a folder or download a ZIP.", "audio") +
      audioWorkflowHtml(false, "Audio chunks", String(chunks().length), '<div class="list" id="chunk-list">' + chunks().map(rowHtml).join("") + "</div>") + "</div>";
    bindAudioWorkflow(p, false);
    chunks().forEach((c) => bindRow(c.n));
    patchProgress();
    loadUrls();
  }

  function validateReal() {
    if (DEMO) return true;
    const missing = !settings.apiKey ? "s-key" : !eff().voiceId ? "s-voice" : null;
    if (missing) {
      toast(missing === "s-key" ? "Add your ElevenLabs API key first." : "Add a Voice ID first.");
      focusMissing();
      return false;
    }
    return true;
  }

  function abortableSleep(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      const iv = setInterval(() => { if (rt.run.stopping) { clearTimeout(t); clearInterval(iv); resolve(); } }, 150);
      setTimeout(() => clearInterval(iv), ms + 50);
    });
  }

  async function generateOne(key, override) {
    const t = target(key), e = Object.assign({}, eff(), override || {});
    e.stability = A.snapStability(e.model, e.stability);
    setStatus(key, "generating");
    let last;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (rt.run.stopping) { setStatus(key, null); return "stopped"; }
      rt.run.abort = new AbortController();
      try {
        const args = { apiKey: settings.apiKey, voiceId: e.voiceId, model: e.model, stability: e.stability, text: t.text, n: t.simN, signal: rt.run.abort.signal };
        const blob = DEMO ? await A.simulate(args) : await A.elevenLabs(args);
        const ext = DEMO ? "wav" : "mp3";
        const m = { status: "ready", bytes: blob.size, ext, hash: hash(t.text), at: Date.now(), model: e.model, stability: e.stability };
        for (let tries = 1; ; tries++) { // the audio cost credits: retry the upload a few times before calling it a failure
          try { await store.putAudio(proj.id, t.store, blob); break; } catch (ue) { if (tries >= 3 || DEMO) throw ue; await new Promise((r) => setTimeout(r, 1000 * tries)); }
        }
        if (rt.dir) {
          try {
            if (await A.ensureWritable(rt.dir, false)) { await writeAudioFile(t, ext, blob); m.status = "saved"; }
          } catch { /* keep as ready; the user can retry with "Save all to folder" */ }
        }
        t.save(m);
        const lock = proj.ext && proj.ext.queue && proj.ext.queue.lock;
        if (rt.pipe.running && lock) lock.beat = Date.now();
        if (DEMO) await saveProject(); else await persistNow();
        if (rt.urls[key]) URL.revokeObjectURL(rt.urls[key]);
        rt.urls[key] = URL.createObjectURL(blob);
        setStatus(key, null);
        return "ok";
      } catch (e) {
        if (e && e.name === "AbortError") { setStatus(key, null); return "stopped"; }
        last = e;
        if (!e.retryable || attempt === MAX_ATTEMPTS) break;
        await abortableSleep(attempt * 3000);
      }
    }
    rt.errors[key] = (last && last.message) || "Unknown error.";
    setStatus(key, "error");
    return last && last.fatal ? "fatal" : "error";
  }

  // Chunk files go in the chosen folder, reel files in its Reels subfolder (created on demand).
  function writeAudioFile(t, ext, blob) {
    return t.id !== undefined ? A.writeFileIn(rt.dir, A.REELS_DIR, t.file(ext), blob) : A.writeFile(rt.dir, t.file(ext), blob);
  }

  // Every key of one kind of audio, and the ones a run would generate: the missing ones, or all of them when none is missing.
  const allKeys = (kind) => (kind === "reels" ? reelsWithAudio().map((r) => rKey(r.id)) : chunks().map((c) => c.n));
  function pendingKeys(kind) {
    const keys = allKeys(kind), all = keys.every((k) => meta(k));
    return keys.filter((k) => all || !meta(k));
  }
  // Keys of failed items are kept in proj.ext.queue.failed (as strings) so "Retry failed" survives a reload.
  const queueExt = () => (proj.ext = proj.ext || {}).queue || (proj.ext.queue = {});
  const isReelKey = (k) => /^r/.test(String(k));
  const failedKeys = (kind) => ((proj.ext && proj.ext.queue && proj.ext.queue.failed) || []).filter((k) => isReelKey(k) === (kind === "reels")).map(parseKey).filter((k) => allKeys(kind).includes(k));
  async function setFailed(kind, keys) {
    const q = queueExt(), other = (q.failed || []).filter((k) => isReelKey(k) !== (kind === "reels"));
    q.failed = other.concat(keys.map(String));
    if (DEMO) await saveProject().catch(() => {}); else await persistNow();
  }

  async function startQueue(kind, opts) {
    if (rt.run.active || !validateReal()) return { errors: 0, fatal: false, stopped: false, ran: false };
    if (rt.dir) { try { await A.ensureWritable(rt.dir, true); } catch { /* ask failed; falls back to browser only */ } }
    const todo = opts && opts.onlyKeys ? opts.onlyKeys.slice() : pendingKeys(kind);
    rt.run.active = true; rt.run.stopping = false; rt.run.kind = kind;
    todo.forEach((k) => { rt.status[k] = "waiting"; delete rt.errors[k]; patchRow(k); });
    patchProgress();
    let errors = 0, fatal = false;
    const failed = [];
    for (let i = 0; i < todo.length && !rt.run.stopping; i++) {
      const r = await generateOne(todo[i]);
      if (r === "error") { errors++; failed.push(todo[i]); if (rt.pipe.running) await setFailed(kind, failedKeys(kind).concat(todo[i])); }
      if (r === "fatal") { fatal = true; errors++; failed.push(todo[i]); break; }
      if (r === "stopped") break;
      if (i < todo.length - 1 && !rt.run.stopping) await abortableSleep(GAP_MS);
    }
    todo.forEach((k) => { if (rt.status[k] === "waiting") delete rt.status[k]; });
    const stopped = rt.run.stopping;
    rt.run.active = false; rt.run.stopping = false; rt.run.abort = null;
    // Items that were not tried keep their old failed mark; tried ones are failed or cleared.
    const untouched = failedKeys(kind).filter((k) => !todo.includes(k) || (stopped && !rt.errors[k] && !meta(k)));
    await setFailed(kind, untouched.concat(failed));
    todo.forEach(patchRow);
    patchProgress();
    loadSub(true);
    if (opts && opts.quiet) return { errors, fatal, stopped, ran: true };
    toast(fatal ? "Stopped: " + Object.values(rt.errors).pop() : stopped ? "Stopped. Press Resume to continue." : errors ? "Finished with " + errors + " error(s). Use Retry failed or Regenerate on the failed items." : kind === "reels" ? "All reel audio files are ready." : "All audio files are ready.");
    return { errors, fatal, stopped, ran: true };
  }

  // ---------- Generate everything: main audio, then reel audio, then export. Saved in proj.ext.queue after every item. ----------
  const PHASE_TEXT = { main: "Main audio", reels: "Reel audio", export: "Export" };
  const missingKeys = (kind) => allKeys(kind).filter((k) => !meta(k));
  const pipeQueue = () => (proj && proj.ext && proj.ext.queue && proj.ext.queue.id ? proj.ext.queue : null);

  async function runPipeline(resume) {
    if (rt.run.active || rt.pipe.running || !validateReal()) return;
    const fresh = (await store.getProject(proj.id)) || proj;
    if (QU.lockState(fresh.ext && fresh.ext.queue, rt.tabId, Date.now()) === "other") { toast("This pipeline is running in another tab. Close that tab or wait a minute."); return; }
    let q = pipeQueue();
    const keys = { main: missingKeys("main"), reels: missingKeys("reels") };
    if (!resume || !q) {
      const est = E.estimate(keys.main.concat(keys.reels).map((k) => target(k).text), eff().model, settings.rates);
      const issues = issuesFor("main").concat(issuesFor("reels"));
      const lines = [(DEMO ? "Estimate (assumes the Free plan): " : "Estimate: ") + estimateLine(est, !DEMO), keys.main.length + " main chunk(s) and " + keys.reels.length + " reel audio file(s) to generate"]
        .concat(issues.length ? [issues.length + " thing(s) to fix first:"].concat(issues.slice(0, 4).map((x) => x.msg)).concat(issues.length > 4 ? ["and " + (issues.length - 4) + " more (see Fix before generating)"] : []) : ["No problems found in the parse"]);
      if (!(await ask({ title: "Generate everything?", text: "Main audio, then reel audio, then you choose ZIP or Save to folder. You can stop and resume.", lines, confirm: "Start" }))) return;
      q = QU.create(Date.now(), { failed: ((proj.ext && proj.ext.queue && proj.ext.queue.failed) || []) });
      (proj.ext = proj.ext || {}).queue = q;
    }
    QU.takeLock(q, rt.tabId, Date.now());
    rt.pipe.running = true;
    rt.pipe.timer = setInterval(() => { const cur = pipeQueue(); if (cur) { QU.beat(cur, rt.tabId, Date.now()); if (DEMO) store.putProject(proj, { touch: false }).catch(() => {}); else persistNow(); } }, 15000);
    let phase = q.phase, halted = false;
    while (phase) {
      q.phase = phase;
      try { await saveProject(); } catch { /* shown by the save state */ }
      updatePipe();
      if (phase === "export") break;
      const todo = missingKeys(phase);
      if (todo.length) {
        const r = await startQueue(phase, { onlyKeys: todo, quiet: true });
        if (r.stopped || r.fatal) { halted = true; if (r.fatal) toast("Stopped: " + Object.values(rt.errors).pop()); break; }
      }
      phase = QU.nextPhase(q, (p) => p === "reels" && !reelsWithAudio().length);
    }
    clearInterval(rt.pipe.timer);
    rt.pipe.running = false;
    QU.releaseLock(q);
    try { await saveProject(); } catch { /* shown by the save state */ }
    updatePipe();
    patchProgress();
    if (!halted) toast("All audio is generated. Choose ZIP or Save to folder in the panel above.");
    else if (!rt.errors || !Object.keys(rt.errors).length) toast("Stopped. Press Resume pipeline to continue.");
  }

  async function finishPipeline() {
    proj.ext.queue = QU.finish(proj.ext.queue);
    try { await saveProject(); } catch { /* shown by the save state */ }
    updatePipe();
    patchProgress();
  }

  async function retryFailedAll() {
    for (const kind of ["main", "reels"]) {
      const keys = failedKeys(kind);
      if (keys.length) { const r = await startQueue(kind, { onlyKeys: keys }); if (r.stopped || r.fatal) break; }
    }
  }

  function pipeAction(a) {
    if (a === "stop") stopQueue();
    else if (a === "resume") runPipeline(true);
    else if (a === "retry") retryFailedAll();
    else if (a === "zip") downloadZip();
    else if (a === "save") saveAll();
    else if (a === "done") finishPipeline();
    else if (a === "dismiss") ask({ title: "Cancel the pipeline?", text: "Generated audio is kept. Only the saved pipeline position is cleared.", confirm: "Cancel pipeline", danger: true }).then((ok) => { if (ok) finishPipeline(); });
  }

  // The persistent panel above every tab: phase, counts, Stop, Resume, Retry failed, and ZIP or Save to folder at the end.
  function updatePipe() {
    const el = $("#pipe");
    if (!el) return;
    const q = pipeQueue(), rs = q ? QU.resumeFrom(q, rt.tabId, Date.now()) : null;
    if (!q || !rs) { el.hidden = true; el.dataset.sig = ""; return; }
    const mode = rt.pipe.running ? "running" : rs.state;
    const failedN = ((q.failed || []).filter((k) => allKeys(isReelKey(k) ? "reels" : "main").includes(parseKey(k)))).length;
    const md = doneCount(), mt = chunks().length, rd = reelDoneCount(), rtot = reelsWithAudio().length;
    const sig = [mode, q.phase, md, rd, failedN, rt.run.stopping, !!rt.dir].join("|");
    el.hidden = false;
    if (el.dataset.sig === sig) return;
    el.dataset.sig = sig;
    const idx = q.phases.indexOf(q.phase) + 1;
    const total = mt + rtot, done = md + rd, pct = total ? Math.round((done / total) * 100) : 0;
    const state = mode === "running" ? (rt.run.stopping ? "Stopping..." : "Running") : mode === "export" ? "Audio finished" : mode === "locked" ? "Running in another tab" : "Paused";
    const btn = (a, ico, label, cls) => '<button type="button" class="btn sm ' + (cls || "") + '" data-pipe="' + a + '">' + icon(ico) + label + "</button>";
    el.innerHTML = '<div class="pipe-top"><strong>Generate everything</strong><span class="pill ' + (mode === "running" ? "generating" : mode === "export" ? "ready" : "waiting") + '">' + state + "</span>" +
      '<span class="small muted">Phase ' + idx + " of " + q.phases.length + ": " + PHASE_TEXT[q.phase] + "</span></div>" +
      '<div class="small">Main ' + md + " of " + mt + (rtot ? " &middot; Reels " + rd + " of " + rtot : "") + (failedN ? " &middot; " + failedN + " failed" : "") + "</div>" +
      '<div class="progress" role="progressbar" aria-label="Pipeline progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '"><div style="width:' + pct + '%"></div></div>' +
      '<div class="row pipe-actions">' +
      (mode === "running" ? btn("stop", "square", "Stop") : "") +
      (mode === "resume" ? btn("resume", "play", "Resume pipeline", "primary") + btn("dismiss", "x", "Cancel pipeline", "ghost") : "") +
      (mode === "export" ? btn("zip", "archive", "Download ZIP", "primary") + (rt.dir ? btn("save", "hard-drive-download", "Save to folder") : "") + btn("done", "check", "Done", "ghost") : "") +
      (mode === "locked" ? '<span class="small muted">Close the other tab, or wait about a minute, then reload.</span>' : "") +
      (failedN && mode !== "running" && mode !== "locked" ? btn("retry", "rotate-ccw", "Retry failed (" + failedN + ")") : "") + "</div>";
    icons();
  }

  function stopQueue() {
    rt.run.stopping = true;
    if (rt.run.abort) rt.run.abort.abort();
    patchProgress();
  }

  async function regenerate(key, override) {
    if (rt.run.active || !validateReal()) return;
    if (rt.dir) { try { await A.ensureWritable(rt.dir, true); } catch { /* ignore */ } }
    rt.run.active = true; rt.run.stopping = false; rt.run.kind = "single";
    patchProgress();
    const r = await generateOne(key, override);
    rt.run.active = false; rt.run.abort = null; rt.run.stopping = false;
    if (r === "ok" && failedKeys(typeof key === "string" ? "reels" : "main").includes(key)) await setFailed(typeof key === "string" ? "reels" : "main", failedKeys(typeof key === "string" ? "reels" : "main").filter((k) => k !== key));
    patchRow(key); patchProgress();
    loadSub(true);
    if (r === "ok") toast(target(key).label + " generated.");
  }

  // ---------- estimate, quality checks and plan (Generate card) ----------
  const issuesFor = (kind) => (proj.parsed ? Q.check(proj.parsed, { model: eff().model, startPhrase: startPhrase(), lang: lang() }) : [])
    .filter((x) => (kind === "reels" ? x.target.startsWith("reel:") : !x.target.startsWith("reel:")));

  /** One line, e.g. "12,340 chars, about 12,340 credits, about $0.99". withPlan adds what is left on the plan. */
  function estimateLine(est, withPlan) {
    let t = E.fmt(est.chars) + " chars, about " + E.fmt(est.credits) + " credits, " + E.usdApprox(est.usd).replace("~", "about ");
    const sub = rt.sub;
    if (withPlan && sub && sub.limit !== undefined) t += "; " + E.fmt(E.fitsQuota(sub, est.credits).remaining) + " left" + (sub.resetUnix ? ", resets " + E.resetText(sub.resetUnix) : "");
    return t;
  }

  // The chip line next to Generate: what the next run uses (Setup defaults plus "Custom for this run").
  function syncRunChips() {
    const el = $("#runchips");
    if (!el) return;
    const e = eff(), v = e.voiceId;
    const sig = [e.model, e.stability, v, !!rt.ovr].join("|");
    if (el.dataset.sig === sig) return;
    el.dataset.sig = sig;
    el.innerHTML = '<span class="chipline" id="chipline">' + esc(e.model) + " &middot; " + (DEMO ? "Simulated voice" : v ? "Voice " + esc(v.length > 8 ? v.slice(0, 5) + "..." : v) : "No voice ID") + " &middot; Stability " + esc(stabilityText(e.model, A.snapStability(e.model, e.stability))) + "</span>" +
      (rt.ovr ? '<span class="pill custom">Custom for this run</span><button type="button" class="linkbtn" data-ovr-clear>Clear</button>' : "") +
      '<button type="button" class="btn sm" id="run-edit" aria-haspopup="dialog">' + icon("sliders-horizontal") + "Edit</button>";
    icons();
  }

  function syncGenInfo() {
    syncSubPanel();
    syncRunChips();
    const el = $("#est");
    if (!el || !proj.parsed) return;
    const reelsV = tab === "reels", kind = reelsV ? "reels" : "main";
    const keys = pendingKeys(kind), est = E.estimate(keys.map((k) => target(k).text), eff().model, settings.rates);
    let text, warn = false;
    if (!keys.length) text = "Nothing to generate.";
    else if (DEMO) {
      text = "Estimate (assumes the Free plan, " + E.fmt(E.FREE_PLAN_CREDITS) + " credits a month): " + estimateLine(est, false);
      warn = est.credits > E.FREE_PLAN_CREDITS;
      if (warn) text += ". More than a month of the Free plan.";
    } else if (rt.sub && rt.sub.limit !== undefined) {
      const q = E.fitsQuota(rt.sub, est.credits);
      text = estimateLine(est, true);
      if (!q.fits) { warn = true; text += ". This batch needs " + E.fmt(q.over) + " more credits than are left."; }
    } else text = estimateLine(est, false) + " (estimate only" + (rt.sub && rt.sub.error ? ": could not read the plan" : settings.apiKey ? "" : ": add an API key to compare with your plan") + ")";
    el.textContent = text;
    el.classList.toggle("warn-text", warn);
    el.title = "Estimate only. Credit rates are editable in Set up.";
    const issues = issuesFor(kind), box = $("#fixlist");
    box.hidden = !issues.length;
    if (issues.length) {
      const sig = issues.map((x) => x.code + x.target).join("|");
      $("#fix-sum").textContent = "Fix before generating (" + issues.length + ")";
      if (box.dataset.sig !== sig) {
        box.dataset.sig = sig;
        $("#fix-list").innerHTML = issues.map((x) => '<li data-sev="' + x.severity + '"><span>' + esc(x.msg) + '</span><button type="button" class="btn sm ghost" data-jump="' + esc(x.target) + '">Go to it</button></li>').join("");
      }
    }
    const failed = failedKeys(kind), rb = $("#retry-failed");
    rb.hidden = !failed.length;
    rb.disabled = rt.run.active;
    rb.innerHTML = icon("rotate-ccw") + "Retry failed (" + failed.length + ")";
    icons();
  }

  // "Settings for this run only": model, stability and voice for the next batch (rt.ovr), or for one chunk (forKey). Never changes Setup.
  function openRunSettings(forKey) {
    const d = $("#dlg"), opener = document.activeElement, base = eff(), single = forKey !== undefined;
    const cur = { model: base.model, stability: A.snapStability(base.model, base.stability), voiceId: base.voiceId };
    const kind = tab === "reels" ? "reels" : "main";
    const texts = () => (single ? [target(forKey).text] : pendingKeys(kind).map((k) => target(k).text));
    d.setAttribute("aria-labelledby", "dlg-title");
    d.innerHTML = '<form method="dialog" class="runform"><h2 id="dlg-title">' + (single ? "Generate " + esc(target(forKey).label) + " with different settings" : "Settings for this run only") + "</h2>" +
      '<p class="muted" style="margin:0 0 12px">' + (single ? "Used for this one file. The model and stability are recorded on the card." : "Applies to the next run on this page. Your Setup defaults do not change.") + "</p>" +
      '<div class="field"><label for="rs-model">Model</label>' + ddHtml("rs-model", "", "") + "</div>" +
      '<div class="field" style="margin-top:12px"><label for="rs-stab">Stability: <output id="rs-stab-out"></output></label><input id="rs-stab" type="range" min="0" max="1"></div>' +
      '<div class="field" style="margin-top:12px"><label for="rs-voice">Voice ID</label><input id="rs-voice" class="input mono" autocomplete="off" data-1p-ignore data-lpignore="true" data-form-type="other" spellcheck="false"' + (DEMO ? " disabled" : "") + "></div>" +
      '<p class="est" id="rs-est" role="status" aria-live="polite" style="margin-top:12px"></p>' +
      '<div class="row" style="margin-top:14px"><button type="button" class="btn" data-x="cancel">Cancel</button><button type="button" class="btn" data-x="reset">Reset to defaults</button><button class="btn primary" data-x="ok">' + (single ? "Generate" : "Apply") + "</button></div></form>";
    const stab = $("#rs-stab", d), voice = $("#rs-voice", d);
    const est = () => {
      const x = E.estimate(texts(), cur.model, settings.rates), lim = A.MODELS[cur.model].maxChars;
      const over = texts().some((t) => [...t].length > lim);
      $("#rs-est", d).textContent = (single ? "This chunk: " : "Next run: ") + estimateLine(x, !single) + (over ? ". At least one chunk is over this model's " + E.fmt(lim) + " character limit." : "");
      $("#rs-est", d).classList.toggle("warn-text", over);
    };
    const fields = () => {
      const v3 = cur.model === "eleven_v3";
      stab.step = v3 ? "0.5" : "0.05"; stab.value = cur.stability;
      $("#rs-stab-out", d).textContent = stabilityText(cur.model, cur.stability);
      voice.value = cur.voiceId || "";
    };
    const opts = Object.keys(A.MODELS).map((k) => [k, k + " - " + A.MODELS[k].label]);
    const dd = ddInit("rs-model", opts, cur.model, (val) => { cur.model = val; cur.stability = A.snapStability(val, cur.stability); fields(); est(); });
    stab.addEventListener("input", () => { cur.stability = A.snapStability(cur.model, stab.value); stab.value = cur.stability; $("#rs-stab-out", d).textContent = stabilityText(cur.model, cur.stability); });
    voice.addEventListener("input", () => { cur.voiceId = voice.value.trim(); });
    const close = () => { d.close(); if (opener && opener.focus && document.contains(opener)) opener.focus(); };
    $('[data-x="cancel"]', d).onclick = close;
    $('[data-x="reset"]', d).onclick = () => { cur.model = settings.model; cur.stability = A.snapStability(settings.model, settings.stability); cur.voiceId = settings.voiceId; dd.set(opts, cur.model); fields(); est(); };
    $("form", d).onsubmit = (e) => {
      e.preventDefault();
      close();
      if (single) { regenerate(forKey, { model: cur.model, stability: cur.stability, voiceId: cur.voiceId }); return; }
      const o = {};
      if (cur.model !== settings.model) o.model = cur.model;
      if (cur.stability !== settings.stability) o.stability = cur.stability;
      if (cur.voiceId !== settings.voiceId) o.voiceId = cur.voiceId;
      rt.ovr = Object.keys(o).length ? o : null;
      refreshCredits();
      toast(rt.ovr ? "Custom settings apply to the next run." : "Using your Setup defaults.");
    };
    d.oncancel = (e) => { e.preventDefault(); close(); };
    d.onclick = (e) => { if (e.target === d) close(); };
    fields(); est();
    d.showModal();
    $("#rs-model", d).focus();
  }

  // Warnings link to the place that has the problem: open the tab and focus the card.
  function jumpTo(tg) {
    const [kind, id, what, n] = tg.split(":");
    let go1, sel;
    if (kind === "chunk") { go1 = () => go("youtube", "audio"); sel = "#chunk-" + id; }
    else if (kind === "scene") { go1 = () => go("youtube", "board"); sel = "#scene-" + id; rt.boardFilter = "all"; rt.onlyAnim = false; }
    else if (kind === "cover") { go1 = () => go("youtube", "covers"); sel = ".icard"; }
    else {
      const sub = what === "image" || what === "video" ? "visual" : what === "cover" ? "cover" : "audio";
      go1 = () => go("reels", String(id), sub);
      sel = what === "image" ? "#rimg-" + id + "-" + n : what === "video" ? "#rvid-" + id + "-" + n : what === "cover" ? "#rcov-" + id : "#reel-" + id;
    }
    go1();
    const card = $(sel, $("#panel"));
    if (card) { card.scrollIntoView({ block: "center", behavior: "smooth" }); if (card.focus) card.focus({ preventScroll: true }); card.classList.add("flash"); setTimeout(() => card.classList.remove("flash"), 1600); }
  }

  // The account's plan (/app with a saved key only), cached in sessionStorage for a few minutes. Failure means "estimate only".
  const SUB_TTL = 5 * 60 * 1000;
  const subKey = () => "mbs:sub:" + hash(settings.apiKey);
  async function loadSub(force) {
    if (DEMO || !settings.apiKey) { rt.sub = null; syncGenInfo(); return; }
    if (!force) {
      try { const c = JSON.parse(sessionStorage.getItem(subKey()) || "null"); if (c && Date.now() - c.at < SUB_TTL) { rt.sub = c.sub; syncGenInfo(); return; } } catch { /* no cache */ }
    }
    try {
      rt.sub = await A.subscription(settings.apiKey);
      try { sessionStorage.setItem(subKey(), JSON.stringify({ at: Date.now(), sub: rt.sub })); } catch { /* storage blocked */ }
    } catch { rt.sub = { error: true }; }
    syncGenInfo();
  }

  // Cheap voice check: only the warm-up phrase and the first sentence are generated. The audio lives in memory (a blob URL), never stored.
  async function previewChunk(key) {
    if (rt.run.active || rt.previewBusy || !validateReal()) return;
    const t = target(key), text = E.previewText(t.text, E.PREVIEW_CHARS, startPhrase());
    if (!text) return;
    rt.previewBusy = String(key); patchRow(key);
    try {
      const ef = eff(), args = { apiKey: settings.apiKey, voiceId: ef.voiceId, model: ef.model, stability: A.snapStability(ef.model, ef.stability), text, n: t.simN };
      const blob = DEMO ? await A.simulate(args) : await A.elevenLabs(args);
      if (rt.previews[key]) URL.revokeObjectURL(rt.previews[key]);
      rt.previews[key] = URL.createObjectURL(blob);
      toast("Preview ready. It used about " + E.fmt(E.estimate([text], eff().model, settings.rates).credits) + " credits and is not saved.");
      loadSub(true);
    } catch (e) { toast((e && e.message) || "The preview failed."); }
    rt.previewBusy = null;
    patchRow(key);
    const a = $("#" + (typeof key === "string" ? "reel-" + key.slice(1) : "chunk-" + key) + " .preview-row audio");
    if (a && a.play) { try { const r = a.play(); if (r && r.catch) r.catch(() => {}); } catch { /* autoplay blocked */ } }
  }

  // Every generated file as { name, blob, key }: chunks at the top level, reel audio under Reels/.
  async function savedFiles() {
    const out = [];
    for (const c of chunks()) {
      const m = meta(c.n);
      const blob = m && (await store.getAudio(proj.id, c.n));
      if (blob) out.push({ name: A.fileName(c.n, chunks().length, m.ext), blob, key: c.n });
    }
    for (const r of reelsWithAudio()) {
      const m = meta(rKey(r.id));
      const blob = m && (await store.getAudio(proj.id, "reel:" + r.id));
      if (blob) out.push({ name: A.REELS_DIR + "/" + A.reelFileName(r.id, m.ext), blob, key: rKey(r.id) });
    }
    return out;
  }

  async function saveAll() {
    if (!rt.dir) return;
    try {
      if (!(await A.ensureWritable(rt.dir, true))) { toast("Permission to write to the folder was not granted."); return; }
      let count = 0;
      for (const f of await savedFiles()) {
        const slash = f.name.indexOf("/");
        if (slash < 0) await A.writeFile(rt.dir, f.name, f.blob);
        else await A.writeFileIn(rt.dir, f.name.slice(0, slash), f.name.slice(slash + 1), f.blob);
        meta(f.key).status = "saved"; count++;
        patchRow(f.key);
      }
      await saveProject();
      patchProgress();
      toast(count + " file(s) saved to " + rt.dir.name + ".");
    } catch (e) { toast("Could not save to the folder: " + e.message); }
  }

  function textExports() {
    const r = proj.parsed;
    const files = {};
    files["narration.txt"] = r.chunks.map((c) => "[" + pad(c.n) + "]\n" + c.text).join("\n\n");
    if (r.scenes.length) files["image_prompts.txt"] = r.scenes.map((s) => "Scene " + pad(s.number) + "\n" + s.imagePrompt).join("\n\n");
    const vids = r.scenes.filter((s) => s.hasVideo);
    if (vids.length) files["video_prompts.txt"] = vids.map((s) => "Scene " + pad(s.number) + "\n" + s.videoPrompt).join("\n\n");
    const seo = coversExport();
    if (seo) files["covers_and_seo.txt"] = seo;
    reels().forEach((x) => {
      files[A.REELS_DIR + "/Reel_" + pad(x.id) + "_prompts.txt"] = [x.name + " (9:16)"]
        .concat(x.audio ? ["Audio script\n" + x.audio.text] : [])
        .concat(x.images.map((i) => i.label + (i.narration ? ": " + i.narration : "") + "\n" + i.prompt))
        .concat(G.reelVideos(x).map((v, k) => "Vertical animation prompt " + (k + 1) + " (Flow 9:16)\n" + v.prompt))
        .concat(x.cover ? ["Reel cover prompt (9:16)\n" + x.cover.prompt] : [])
        .concat(x.coverHeadline ? ["Cover headline\n" + x.coverHeadline] : [])
        .concat(x.caption ? ["Caption\n" + x.caption] : []).join("\n\n");
    });
    return files;
  }

  async function downloadZip() {
    try {
      const files = await savedFiles();
      if (!files.length) { toast("Nothing to download yet. Generate audio first."); return; }
      const blob = await A.buildZip(files, textExports());
      const slug = proj.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
      A.download(blob, slug + ".zip");
      toast("ZIP downloaded with " + files.length + " audio file(s).");
    } catch (e) { toast(e.message); }
  }

  // ---------- Visual Board ----------
  const KIND_ICON = { image: "image", video: "film", audio: "audio-lines" };
  const KIND_SHORT = { image: "Image", video: "Video", audio: "Audio" };
  // One toggle in a segmented progress strip: icon, short label, check mark when done. The checkbox stays real (hidden visually) for keyboard and screen readers.
  const chipFull = (label) => (/generated/i.test(label) ? label : label + " generated");
  const chipHtml = (attrs, ico, label, checked) => '<label class="chip" title="' + esc(chipFull(label)) + '"><input type="checkbox" aria-label="' + esc(chipFull(label)) + '" ' + attrs + (checked ? " checked" : "") + ">" + icon(ico) + '<span class="chip-l">' + label + '<span class="sr-only"> generated</span></span><i data-lucide="check" class="chip-check" aria-hidden="true"></i></label>';
  const STATUS_TEXT = { todo: "Not started", progress: "In progress", done: "Done" };
  const FILTERS = [["all", "All"], ["todo", "To do"], ["done", "Done"]];

  function barHtml(label, c) {
    return '<div class="progress" role="progressbar" aria-label="' + esc(label) + " progress: " + c.done + " of " + c.total + '" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + c.pct + '"><div style="width:' + c.pct + '%"></div></div>';
  }

  function metersHtml(c) {
    c = c || counts();
    const m = (key, label, x) => '<div class="meter" data-meter="' + key + '"><div class="meter-top"><span>' + label + "</span><b>" + x.done + "/" + x.total + ' <span class="muted">' + x.pct + "%</span></b></div>" + barHtml(label, x) + "</div>";
    const cover = c.cover && c.cover.total ? m("cover", "Covers", c.cover) : "";
    return (c.image ? m("image", "Images", c.image) : "") + (c.video ? m("video", "Videos", c.video) : "") + cover + (c.audio ? m("audio", "Audio", c.audio) : "") + (c.total ? m("total", "Total", c.total) : "");
  }

  /*
   * ONE card per work item, one full-width card per row, the same anatomy everywhere (scenes, reel images,
   * animations, covers, publishing text):
   *   header  title, ratio badge, optional Flow pill, status pill on the right
   *   body    narration or text (auto direction), then the prompt box(es) (monospace, left to right)
   *   footer  one row: the progress chip, extra actions; copy is an icon button next to each prompt label, extra actions after
   * o: { id, cls, attrs, title, ratio, flow, meta, pill, body, narration, text, prompts: [{label, text}], extra, copies: [{text, label}], chips: [html], chipsLabel, actions, after }
   * (audio chunks use body for the clamped script and after for the players)
   */
  function itemCardHtml(o) {
    const copies = (o.copies || []).map((c) => copyBtn(c.text, c.label));
    return '<article class="icard' + (o.cls ? " " + o.cls : "") + '"' + (o.id ? ' id="' + o.id + '"' : "") + ' tabindex="-1"' + (o.attrs || "") + ' aria-label="' + esc(o.title) + '">' +
      '<div class="icard-head"><h3 class="icard-title">' + esc(o.title) + "</h3>" +
      (o.ratio ? '<span class="badge plain ' + (o.ratio === "9:16" ? "vbadge" : "hbadge") + '">' + o.ratio + "</span>" : "") +
      (o.flow ? '<span class="flowpill" title="Has Flow animation">' + icon("film") + "Flow</span>" : "") + (o.meta ? '<span class="muted small icard-meta">' + o.meta + "</span>" : "") + (o.pill || "") + "</div>" +
      (o.body || "") +
      (o.narration ? '<div class="' + contentClass() + ' icard-narr" dir="' + dirAttr() + '">' + o.narration + "</div>" : "") +
      (o.text ? '<div class="' + contentClass() + ' seo-text" dir="' + dirAttr() + '">' + esc(o.text) + "</div>" : "") +
      (o.prompts && o.prompts.length ? '<div class="icard-prompts' + (o.prompts.length > 1 ? " two" : "") + '">' + o.prompts.map((x) => '<div class="pbox"><div class="promptlabel first"><span>' + esc(x.label) + "</span>" + (x.text ? copyIconBtn(x.text, "Copy " + x.label.toLowerCase()) : "") + '</div><div class="prompt">' + esc(x.text || "(none found)") + "</div></div>").join("") + "</div>" : "") +
      (o.extra || "") +
      '<div class="icard-foot">' + copies.join("") + (o.chips && o.chips.length ? '<div class="chips" role="group" aria-label="' + esc(o.chipsLabel || "Progress") + '">' + o.chips.join("") + "</div>" : "") + (o.actions || "") + "</div>" + (o.after || "") + "</article>";
  }
  const donePill = (done) => '<span class="pill st st-' + (done ? "done" : "todo") + '" data-pill>' + (done ? STATUS_TEXT.done : STATUS_TEXT.todo) + "</span>";

  function sceneHtml(s) {
    const st = G.status(prog(), s);
    const chip = (k) => chipHtml('data-n="' + s.number + '" data-kind="' + k + '"', KIND_ICON[k], KIND_SHORT[k], G.isDone(prog(), s, k));
    return itemCardHtml({
      id: "scene-" + s.number, attrs: ' data-status="' + st + '"' + (s.hasVideo ? ' data-flow="true"' : ""), title: "Scene " + pad(s.number), ratio: "16:9", flow: s.hasVideo,
      pill: '<span class="pill st st-' + st + '" data-pill>' + STATUS_TEXT[st] + "</span>",
      narration: s.narration ? warmHtml(s.narration) : "(no narration found)",
      prompts: [{ label: "Image prompt", text: s.imagePrompt }].concat(s.hasVideo ? [{ label: "Video prompt", text: s.videoPrompt }] : []),
      chips: G.kindsFor(s).map(chip), chipsLabel: "Progress for scene " + s.number,
      extra: slotsHtml(["s-" + s.number + "-image"].concat(s.hasVideo ? ["s-" + s.number + "-video"] : [])),
    });
  }

  // Refresh meters, tab badge and each card's status without re-rendering (keeps focus and scroll).
  function updateBoardProgress(p) {
    $(".board-meters", p).innerHTML = metersHtml();
    scenes().forEach((s) => {
      const card = $("#scene-" + s.number, p);
      if (!card) return;
      const st = G.status(prog(), s);
      card.dataset.status = st;
      const pill = $("[data-pill]", card);
      pill.className = "pill st st-" + st;
      pill.textContent = STATUS_TEXT[st];
    });
    refreshCounts();
  }

  function renderBoard(p) {
    const all = scenes();
    if (!all.length) { p.innerHTML = emptyState("No image scenes yet. Paste a conversation first."); bindGoto(p); return; }
    const list = G.filterScenes(all, prog(), rt.boardFilter, rt.onlyAnim);
    p.innerHTML = '<div class="board page">' + pageHead("Visual Board", "Work through the 16:9 scenes one by one: copy a prompt, generate it, then tick it off.") +
      '<div class="board-bar"><div class="board-meters">' + metersHtml() + "</div></div>" + dropZoneHtml() +
      '<section><div class="board-controls row">' +
      '<div class="seg" role="group" aria-label="Filter scenes">' + FILTERS.map((f) => '<button type="button" class="btn sm" data-filter="' + f[0] + '" aria-pressed="' + (rt.boardFilter === f[0]) + '">' + f[1] + "</button>").join("") + "</div>" +
      '<label class="row small" style="gap:8px"><input type="checkbox" id="only-anim"' + (rt.onlyAnim ? " checked" : "") + '> Only Flow scenes</label>' +
      dimToggle() +
      '<button type="button" class="btn sm" id="copy-all-img">' + icon("list-ordered") + "Copy all image prompts</button>" +
      '<button type="button" class="btn sm" id="board-csv">' + icon("file-spreadsheet") + "Download CSV</button>" +
      '</div>' +
      '<h3 class="sec" id="board-count" role="status">' + list.length + " of " + all.length + " scenes</h3>" +
      '<div class="scenes">' + (list.length ? list.map(sceneHtml).join("") : '<div class="empty">No scenes match this filter.</div>') + "</div></section></div>";
    $("#only-anim", p).addEventListener("change", (e) => { rt.onlyAnim = e.target.checked; renderTab(); $("#only-anim").focus(); });
    $$("[data-filter]", p).forEach((b) => b.addEventListener("click", () => { rt.boardFilter = b.dataset.filter; renderTab(); $('[data-filter="' + rt.boardFilter + '"]').focus(); }));
    $("#copy-all-img", p).addEventListener("click", copyAllImages);
    $("#board-csv", p).addEventListener("click", downloadBoardCsv);
    $$('input[data-kind]', p).forEach((box) => box.addEventListener("change", async () => {
      proj.progress = G.setFlag(prog(), Number(box.dataset.n), box.dataset.kind, box.checked);
      updateBoardProgress(p);
      try { await saveProject(); } catch (e) { toast("Could not save progress: " + e.message); }
    }));
  }

  // ---------- Reels (9:16): one card per reel in each of the three sub-tabs, built from three section builders ----------
  // Stored flags are image and video only (per prompt, see progress.js); audio is derived from the generated reel file.
  const reelCounts = () => G.reelCounts(rprog(), reels(), (r) => !!meta(rKey(r.id)));

  function reelAudioNote(r) {
    const key = rKey(r.id), m = meta(key), st = statusOf(key);
    if (st === "generating") return "Generating...";
    if (st === "error") return "Generation failed. Try again.";
    if (!m) return "Not generated yet. Will be saved as " + A.REELS_DIR + "/" + A.reelFileName(r.id, DEMO ? "wav" : "mp3");
    const file = A.REELS_DIR + "/" + A.reelFileName(r.id, m.ext);
    return m.status === "saved" ? "Saved to " + file + (rt.dir ? " in " + rt.dir.name : "") : "Ready in the browser. Not saved to a folder yet (" + file + ").";
  }

  const reelChip = (r, kind, i, ico, label, done) => chipHtml('data-reel="' + r.id + '" data-kind="' + kind + '" data-i="' + i + '"', ico, label, done);
  const secBlock = (label, count, cards, empty) => '<section class="isec" aria-label="' + esc(label) + '">' + secHead(label, count == null ? "" : String(count)) + (cards ? '<div class="icards">' + cards + "</div>" : '<p class="hint">' + empty + "</p>") + "</section>";

  function reelImagesHtml(r) {
    const cards = r.images.map((im, i) => {
      const done = G.reelImageDone(rprog(), r, i);
      return itemCardHtml({
        id: "rimg-" + r.id + "-" + (i + 1), attrs: ' data-done="' + done + '"', title: im.label, ratio: "9:16", pill: donePill(done),
        narration: im.narration ? esc(im.narration) : "", prompts: [{ label: "Image prompt", text: im.prompt }],
        chips: [reelChip(r, "image", i, KIND_ICON.image, "Image generated", done)], chipsLabel: "Progress for " + im.label,
        extra: slotsHtml(["r-" + r.id + "-image-" + (i + 1)]),
      });
    }).join("");
    return secBlock("Vertical images (9:16)", r.images.length, cards, "No image prompts found.");
  }

  function reelVideosHtml(r) {
    const vids = G.reelVideos(r);
    const cards = vids.map((v, i) => {
      const done = G.reelVideoDone(rprog(), r, i);
      return itemCardHtml({
        id: "rvid-" + r.id + "-" + (i + 1), attrs: ' data-done="' + done + '"', title: "Animation " + (i + 1), ratio: "9:16", flow: true, pill: donePill(done),
        prompts: [{ label: "Video prompt (Flow)", text: v.prompt }],
        chips: [reelChip(r, "video", i, KIND_ICON.video, "Video generated", done)], chipsLabel: "Progress for animation " + (i + 1),
        extra: slotsHtml(["r-" + r.id + "-video-" + (i + 1)]),
      });
    }).join("");
    return secBlock("Vertical animations", vids.length, cards, "No animation prompts found.");
  }

  // Publishing text (headline, title, caption): same card, no prompt box, no progress chip.
  const textCard = (label, text) => itemCardHtml({ title: label, text, copies: [{ text }] });

  function reelCoverHtml(r) {
    const done = G.reelCoverDone(rprog(), r);
    const card = r.cover ? itemCardHtml({
      id: "rcov-" + r.id, attrs: ' data-done="' + done + '"', title: "Reel cover", ratio: "9:16", pill: donePill(done),
      prompts: [{ label: "Cover prompt", text: r.cover.prompt }],
      chips: [reelChip(r, "cover", 0, "layout-template", "Cover generated", done)], chipsLabel: "Progress for the reel cover",
      extra: slotsHtml(["r-" + r.id + "-cover"]),
    }) : "";
    const texts = (r.coverHeadline ? textCard("Cover headline", r.coverHeadline) : "") + (r.caption ? textCard("Caption", r.caption) : "");
    return secBlock("Reel cover (9:16)", null, card, 'No cover prompt found. Add a "Reel Cover Prompt:" label to this reel in step 6.') +
      (texts ? '<section class="isec" aria-label="Headline and caption">' + secHead("Headline and caption") + '<div class="icards">' + texts + "</div></section>" : "");
  }

  const currentReel = () => reels().find((r) => String(r.id) === subOf.reels) || reels()[0];

  // What each reel sub-tab tracks: drives the sub-tab badge and the card's left border.
  const REEL_VIEW_KINDS = { audio: ["audio"], visual: ["image", "video"], cover: ["cover"] };
  function reelViewCounts(r, v) {
    const c = G.reelCounts(rprog(), [r], (x) => !!meta(rKey(x.id)));
    return REEL_VIEW_KINDS[v].reduce((t, k) => ({ done: t.done + c[k].done, total: t.total + c[k].total }), { done: 0, total: 0 });
  }
  function reelViewStat(r, v) {
    const c = reelViewCounts(r, v);
    return !c.total || !c.done ? "todo" : c.done === c.total ? "done" : "progress";
  }

  const REEL_HEAD = {
    audio: ["Audio", (r) => "The script for " + r.name + " (9:16), its audio file and the Reels/Reel_" + pad(r.id) + "_audio file" + (rt.dir ? " in " + rt.dir.name : "") + "."],
    visual: ["Visual Board", (r) => "Vertical (9:16) images and Flow animations for " + r.name + ". Copy a prompt, generate it, then tick it off."],
    cover: ["Cover", (r) => "The 9:16 cover prompt, cover headline and caption for " + r.name + "."],
  };

  // One card per sub-tab; the three section builders are reelAudioRowHtml, reelImagesHtml + reelVideosHtml, and reelCoverHtml.
  function reelCardHtml(r) {
    if (reelSub === "audio") return reelAudioRowHtml(r);
    const body = reelSub === "visual" ? reelImagesHtml(r) + reelVideosHtml(r) : reelCoverHtml(r);
    return '<div class="reel-stack" id="reel-' + r.id + '" data-status="' + reelViewStat(r, reelSub) + '" aria-label="' + esc(r.name) + '">' + body + "</div>";
  }

  // Progress across all reels for the open sub-tab: Visual Board = images and videos, Cover = covers.
  function reelMetersHtml(v) {
    const c = reelCounts();
    if (v === "cover") return metersHtml({ cover: c.cover });
    const t = { done: c.image.done + c.video.done, total: c.image.total + c.video.total };
    t.pct = G.pct(t.done, t.total);
    return metersHtml({ image: c.image, video: c.video, total: t });
  }

  function updateReelsProgress(p) {
    const meters = $(".board-meters", p);
    if (meters) meters.innerHTML = reelMetersHtml(reelSub);
    const r = currentReel(), card = r && $("#reel-" + r.id, p);
    if (card) card.dataset.status = reelViewStat(r, reelSub);
  }

  // Saves one audio file (a chunk or a reel) to the chosen folder, or downloads it when there is none.
  async function saveOne(key) {
    const t = target(key), m = meta(key);
    if (!m) return;
    try {
      const blob = await store.getAudio(proj.id, t.store);
      if (!blob) { toast("The audio file is missing. Regenerate it."); return; }
      const name = (t.id !== undefined ? A.REELS_DIR + "/" : "") + t.file(m.ext);
      if (rt.dir && (await A.ensureWritable(rt.dir, true))) {
        await writeAudioFile(t, m.ext, blob);
        m.status = "saved";
        await saveProject();
        patchRow(key);
        patchProgress();
        toast("Saved " + name + " in " + rt.dir.name + ".");
      } else {
        A.download(blob, t.file(m.ext));
        toast(rt.dir ? "Permission to write to the folder was not granted. Downloaded instead." : "No folder chosen, so the file was downloaded.");
      }
    } catch (e) { toast("Could not save: " + e.message); }
  }

  function bindReelCard(card) {
    if (!card) return;
    if (card.classList.contains("icard")) bindRow(card.id.replace("reel-", "r"));
    $$("input[data-reel]", card).forEach((box) => box.addEventListener("change", async () => {
      const reel = reels().find((x) => x.id === Number(box.dataset.reel));
      proj.reelProgress = G.setReelFlag(rprog(), reel, box.dataset.kind, Number(box.dataset.i), box.checked);
      const ic = box.closest(".icard");
      ic.dataset.done = String(box.checked);
      const pill = $("[data-pill]", ic);
      if (pill) { pill.className = "pill st st-" + (box.checked ? "done" : "todo"); pill.textContent = box.checked ? STATUS_TEXT.done : STATUS_TEXT.todo; }
      updateReelsProgress($("#panel"));
      refreshCounts();
      try { await saveProject(); } catch (e) { toast("Could not save progress: " + e.message); }
    }));
  }

  // Visual Board and Cover toolbars (the audio sub-tab uses the shared audio workflow): progress, plus Copy next on the board.
  function reelToolbarHtml() {
    const tools = '<button type="button" class="btn sm" id="reels-csv">' + icon("file-spreadsheet") + "Download CSV</button>";
    const next = reelSub === "visual"
      ? '<div class="board-controls row"><button type="button" class="btn sm" id="copy-all-reel-img">' + icon("list-ordered") + "Copy all image prompts (this reel)</button>" + tools + "</div>"
      : '<div class="board-controls row">' + tools + "</div>";
    return '<div class="board-bar"><div class="board-meters">' + reelMetersHtml(reelSub) + "</div></div>" + dropZoneHtml() + next;
  }

  // Quick links to the other reels' audio under the open reel's row ("Generate all reel audio" covers every reel).
  function reelOthersHtml(cur) {
    const others = reels().filter((x) => x !== cur);
    return others.length ? '<p class="hint reel-others">"Generate all reel audio" covers all ' + reels().length + " reels. Review the others: " + others.map((o) => '<button type="button" class="btn sm ghost" data-reel-go="' + o.id + '">' + esc(o.name) + "</button>").join(" ") + "</p>" : "";
  }

  function renderReels(p) {
    const r = currentReel();
    const head = REEL_HEAD[reelSub];
    $("#rstrip").innerHTML = subtabsHtml(2, RSUBS, r.name + " sections");
    p.innerHTML = '<div id="rpanel" role="tabpanel" tabindex="-1" aria-labelledby="rsubtab-' + reelSub + '"><div class="board page">' +
      pageHead(head[0], head[1](r), "reels") +
      (reelSub === "audio" ? audioWorkflowHtml(true, r.name + " audio", "reel " + (reels().indexOf(r) + 1) + " of " + reels().length, '<div class="list" id="reel-list">' + reelCardHtml(r) + "</div>" + reelOthersHtml(r)) : reelToolbarHtml() + reelCardHtml(r)) + "</div></div>";
    $$("#rsubbar .subtab").forEach((b) => {
      const on = b.dataset.rsub === reelSub;
      b.setAttribute("aria-selected", on ? "true" : "false");
      b.tabIndex = on ? 0 : -1;
    });
    bindSubtabs(document, 2);
    if (reelSub === "audio") {
      bindAudioWorkflow(p, true);
      $$("[data-reel-go]", p).forEach((b) => b.addEventListener("click", () => go("reels", b.dataset.reelGo, "audio")));
    }
    const ca = $("#copy-all-reel-img", p);
    if (ca) ca.addEventListener("click", copyAllReelImages);
    const rc = $("#reels-csv", p);
    if (rc) rc.addEventListener("click", downloadReelsCsv);
    bindReelCard($("#reel-" + r.id, p));
    refreshCounts();
    patchProgress();
    loadUrls();
  }

  // ---------- media: per-card slots, bulk drop zone, originals on R2 (/app), edit-ready export ----------
  // proj.ext.media[itemKey] = { name, type, bytes, at, uploadedAt, sk, r2, stored, thumb, local?, outdated? }.
  //   itemKey   s-4-image, s-4-video, r-1-image-2, r-1-video-1, r-1-cover, yt-cover (the scene number and reel id: see media.js, diff.js carryMedia)
  //   sk        the key of the R2 object (media/<project>/<sk>), fixed at the first upload so a renumbered scene keeps its file
  //   stored    the original is on the server (/app only)
  // proj.ext.orphans[sk] = the same entry plus { from, orphanedAt }: files whose item was removed by a re-parse (kept until "Remove unused media").
  // /demo never calls the server: the thumbnail is kept in the browser's IndexedDB, and the original too while all originals stay under 25 MB.
  const mediaMeta = () => (proj.ext && proj.ext.media) || {};
  const MB = (n) => (n / 1048576 >= 10 ? Math.round(n / 1048576) : Math.round((n / 1048576) * 10) / 10) + " MB";
  const GB = (n) => (n >= 1073741824 ? Math.round((n / 1073741824) * 100) / 100 + " GB" : MB(n));
  const mediaApi = (path) => "/api/projects/" + encodeURIComponent(proj.id) + "/" + path;
  const apiFetch = (url, o) => fetch(url, Object.assign({ credentials: "same-origin" }, o, { headers: Object.assign({ "X-MBS": "1" }, o && o.headers) }));
  const DEMO_ORIG_CAP = 25 * 1024 * 1024;
  const IMG_ACCEPT = "image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp";
  const SLOT = {
    image: { label: "Image", up: "Upload image", types: "PNG, JPG or WebP", accept: IMG_ACCEPT },
    video: { label: "Video", up: "Upload video", types: "MP4 or WebM", accept: "video/mp4,video/webm,.mp4,.webm" },
    cover: { label: "Cover image", up: "Upload cover image", types: "PNG, JPG or WebP", accept: IMG_ACCEPT },
  };
  const slotKind = (key) => { const m = MM.fromKey(key); return m && (m.kind === "cover" || m.kind === "reel-cover") ? "cover" : m ? m.media : "image"; };
  const skOf = (key, P) => MM.serverKey(key, (((P || proj).ext || {}).media || {})[key]);
  const upKey = (P, key) => P.id + "|" + key;
  const isVideoType = (t) => /^video\//.test(t || "");
  const slotWhat = (key) => { const m = MM.fromKey(key); return m ? MM.describe(m) : key; };

  function dropZoneHtml() {
    return '<div class="dropzone" id="dropzone" tabindex="0" role="button" aria-label="Add several images and videos at once. Drop files here or press Enter to choose them." data-drop>' +
      icon("upload") + '<div><strong>Drop images and videos here, or choose files</strong><span class="hint">Bulk upload: names like <code>03.png</code>, <code>scene_04.mp4</code>, <code>R01-02.png</code> or <code>R01-cover.png</code> go into the matching card and tick it. Or use the upload slot on each card. ' +
      (DEMO ? "Demo: files stay in your browser (thumbnails always, originals up to 25 MB in total)." : "Originals (up to 100 MB each) are saved to your account.") + "</span></div>" +
      '<input type="file" id="drop-input" multiple hidden accept="image/png,image/jpeg,image/webp,video/mp4,video/webm,.png,.jpg,.jpeg,.webp,.mp4,.webm"></div>';
  }

  function bindDrop(host) {
    const z = $("#dropzone", host);
    if (!z) return;
    const input = $("#drop-input", z);
    z.addEventListener("click", () => input.click());
    z.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } });
    input.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("change", () => { const f = Array.from(input.files); input.value = ""; if (f.length) handleFiles(f); });
    ["dragenter", "dragover"].forEach((t) => z.addEventListener(t, (e) => { e.preventDefault(); z.classList.add("over"); }));
    ["dragleave", "drop"].forEach((t) => z.addEventListener(t, (e) => { e.preventDefault(); z.classList.remove("over"); }));
    z.addEventListener("drop", (e) => { const f = Array.from((e.dataTransfer && e.dataTransfer.files) || []); if (f.length) handleFiles(f); });
  }

  // A 320 px wide WebP (about 30 KB) of an image, or of a video's first frame. Resolves to a Blob, or null when the browser cannot decode it.
  function makeThumb(file) {
    return new Promise((resolve) => {
      if (typeof URL.createObjectURL !== "function") { resolve(null); return; }
      const url = URL.createObjectURL(file), video = (file.type || "").startsWith("video/");
      const el = document.createElement(video ? "video" : "img");
      let done = false;
      const finish = (blob) => { if (done) return; done = true; clearTimeout(timer); URL.revokeObjectURL(url); resolve(blob); };
      const timer = setTimeout(() => finish(null), 8000);
      const draw = () => {
        try {
          const w0 = video ? el.videoWidth : el.naturalWidth, h0 = video ? el.videoHeight : el.naturalHeight;
          if (!w0 || !h0) return finish(null);
          const c = document.createElement("canvas");
          c.width = Math.min(320, w0); c.height = Math.round((c.width / w0) * h0);
          c.getContext("2d").drawImage(el, 0, 0, c.width, c.height);
          c.toBlob((b) => finish(b), "image/webp", 0.7);
        } catch { finish(null); }
      };
      el.onerror = () => finish(null);
      if (video) {
        el.muted = true; el.preload = "metadata"; el.playsInline = true;
        el.onloadeddata = () => { el.onseeked = draw; el.currentTime = Math.min(0.1, (el.duration || 1) / 2); };
      } else el.onload = draw;
      el.src = url;
    });
  }

  // PUT with upload progress (fetch cannot report it). Resolves to the parsed JSON reply; rejects with Error, or { cancelled: true } after abort.
  function putXhr(url, body, headers, hold, onProgress) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      if (hold) hold.xhr = x;
      x.open("PUT", url);
      x.setRequestHeader("X-MBS", "1");
      Object.keys(headers).forEach((h) => x.setRequestHeader(h, headers[h]));
      if (onProgress && x.upload) x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded, e.total); };
      x.onload = () => {
        let data = {};
        try { data = JSON.parse(x.responseText || "{}"); } catch { /* not JSON */ }
        if (x.status >= 200 && x.status < 300) resolve(data);
        else reject(new Error(data.error || (x.status === 413 ? "The server refused the file as too large (413). Compress it and try again." : "The server refused the file (" + x.status + ").")));
      };
      x.onerror = () => reject(new Error("The network failed. Check your connection and try again."));
      x.onabort = () => reject({ cancelled: true });
      x.send(body);
    });
  }

  function tickItem(P, m, on) {
    if (m.kind === "scene") P.progress = G.setFlag(P.progress || {}, m.scene, m.media, on);
    else if (m.kind === "cover") P.thumbnailDone = on;
    else {
      const reel = ((P.parsed && P.parsed.reels) || []).find((x) => x.id === m.reel);
      if (reel) P.reelProgress = G.setReelFlag(P.reelProgress || {}, reel, m.kind === "reel-cover" ? "cover" : m.media, m.kind === "reel-cover" ? 0 : m.index - 1, on);
    }
  }

  // After a tick changed by a slot: the chip, the card's pill and border, the meters and the tab badges, without re-rendering the view.
  function syncTickUi(m) {
    const p = $("#panel");
    if (!p || !proj.parsed) return;
    const setPill = (card, done) => {
      if (!card) return;
      card.dataset.done = String(done);
      const pill = $("[data-pill]", card);
      if (pill) { pill.className = "pill st st-" + (done ? "done" : "todo"); pill.textContent = done ? STATUS_TEXT.done : STATUS_TEXT.todo; }
    };
    if (m.kind === "scene") {
      const s = scenes().find((x) => x.number === m.scene), box = $('input[data-n="' + m.scene + '"][data-kind="' + m.media + '"]', p);
      if (box && s) box.checked = G.isDone(prog(), s, m.media);
      if ($(".board-meters", p) && $("#scene-" + m.scene, p)) updateBoardProgress(p);
    } else if (m.kind === "cover") {
      const box = $("#thumb-done", p);
      if (box) { box.checked = !!proj.thumbnailDone; setPill(box.closest(".icard"), !!proj.thumbnailDone); }
    } else {
      const reel = reels().find((x) => x.id === m.reel);
      const kind = m.kind === "reel-cover" ? "cover" : m.media, i = m.kind === "reel-cover" ? 0 : m.index - 1;
      const box = $('input[data-reel="' + m.reel + '"][data-kind="' + kind + '"][data-i="' + i + '"]', p);
      if (box && reel) {
        const done = kind === "cover" ? G.reelCoverDone(rprog(), reel) : kind === "image" ? G.reelImageDone(rprog(), reel, i) : G.reelVideoDone(rprog(), reel, i);
        box.checked = done;
        setPill(box.closest(".icard"), done);
        updateReelsProgress(p);
      }
    }
    refreshCounts();
  }

  // ----- the slot on a card -----
  function slotHtml(key) {
    const kind = slotKind(key), S = SLOT[kind], e = mediaMeta()[key], up = rt.uploads[upKey(proj, key)], what = slotWhat(key);
    const flag = e && e.outdated ? '<span class="badge plain mslot-flag" title="The prompt changed after this file was added.">Outdated</span>' : "";
    let body, state;
    if (up) {
      state = "uploading";
      const pct = up.size ? Math.min(100, Math.round((up.loaded / up.size) * 100)) : 0;
      body = '<div class="mslot-busy" role="group" aria-label="Uploading ' + esc(up.name) + '"><div class="mslot-file" title="' + esc(up.name) + '">' + esc(up.name) + "</div>" +
        '<div class="progress" role="progressbar" aria-label="Upload progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '"><div style="width:' + pct + '%"></div></div>' +
        '<div class="mslot-busyrow"><span class="small muted" data-pct role="status">' + esc(upText(up)) + '</span><button type="button" class="btn sm ghost" data-sa="cancel">' + icon("x") + "Cancel</button></div></div>";
    } else if (!e) {
      state = "empty";
      body = '<div class="mslot-drop" role="button" tabindex="0" data-sa="pick" aria-label="' + esc(S.up + " for " + what + ". Choose a file or drop it here.") + '">' + icon("upload") +
        "<div><strong>" + S.up + '</strong><span class="hint">' + S.types + ", up to 100 MB." + (DEMO ? " Demo: files stay in your browser." : "") + "</span></div></div>";
    } else {
      state = "filled";
      const sk = MM.serverKey(key, e), thumb = rt.thumbs[sk], video = isVideoType(e.type);
      const ph = '<span class="mph" data-ph aria-hidden="true">' + icon(video ? "film" : "image") + "</span>";
      let media;
      if (video && (!DEMO || e.local || rt.origs[sk])) {
        media = '<div class="mslot-video"><video controls preload="none" playsinline data-vsrc="' + key + '" aria-label="' + esc("Video for " + what) + '"' + (thumb ? ' poster="' + thumb + '"' : "") + (DEMO ? "" : ' src="' + mediaApi("media/" + sk) + '"') + "></video></div>";
      } else {
        media = '<button type="button" class="mslot-thumb" data-sa="open" aria-label="' + esc("Preview " + e.name) + '">' + (thumb ? '<img src="' + thumb + '" alt="' + esc("Thumbnail of " + e.name) + '">' : (!DEMO && !video && e.stored ? '<img loading="lazy" src="' + mediaApi("media/" + sk) + '" alt="' + esc("Thumbnail of " + e.name) + '">' : ph)) + "</button>";
      }
      const where = DEMO ? (e.local ? "In this browser" : "Thumbnail only (demo size limit)") : "Saved to your account";
      body = '<div class="mslot-filled"><div class="mslot-media">' + media + '</div><div class="mslot-info"><span class="mslot-file" title="' + esc(e.name) + '">' + esc(e.name) + "</span>" +
        '<span class="muted small">' + MB(e.bytes) + " &middot; " + esc((e.type || "").replace(/^[a-z]+\//, "").toUpperCase()) + " &middot; " + esc(where) + "</span>" +
        (e.outdated ? '<span class="small warn-text">Outdated: the prompt was edited after this file was added. Replace it or keep it.</span>' : "") +
        '<div class="mslot-actions"><button type="button" class="btn sm" data-sa="replace">' + icon("refresh-cw") + "Replace</button>" +
        '<button type="button" class="btn sm" data-sa="download">' + icon("download") + "Download</button>" +
        (video ? '<button type="button" class="btn sm" data-sa="open">' + icon("maximize-2") + "Enlarge</button>" : "") +
        '<button type="button" class="btn sm danger" data-sa="remove">' + icon("trash-2") + "Remove</button></div></div></div>";
    }
    return '<div class="mslot" data-slot="' + key + '" data-state="' + state + '"><div class="mslot-label"><span>' + S.label + "</span>" + flag + "</div>" + body +
      '<input type="file" hidden data-slot-input accept="' + S.accept + '"></div>';
  }
  const upText = (up) => (up.loaded >= up.size && up.size ? "Finishing..." : (up.size ? Math.round((up.loaded / up.size) * 100) + "% of " + MB(up.size) : "Preparing..."));

  // The media panel of a card: one slot per file the card can hold (image, video, or cover image).
  const slotsHtml = (keys) => '<div class="mslots' + (keys.length > 1 ? " two" : "") + '">' + keys.map(slotHtml).join("") + "</div>";

  function refreshSlot(key) {
    $$('.mslot[data-slot="' + key + '"]', $("#panel")).forEach((el) => {
      const had = el.contains(document.activeElement);
      el.insertAdjacentHTML("afterend", slotHtml(key));
      const next = el.nextElementSibling;
      el.remove();
      icons();
      if (had) { const f = $("[data-sa]", next); if (f) f.focus(); }
      hydrateSlot(next);
    });
  }

  // Fills in the picture (and the demo's video source) once it is known: from the in-memory URL, else from the server or IndexedDB.
  async function hydrateSlot(el) {
    if (!el || !proj) return;
    const key = el.dataset.slot, e = mediaMeta()[key];
    if (!e) return;
    const sk = MM.serverKey(key, e), P = proj;
    if (e.thumb && !rt.thumbs[sk]) {
      try {
        let blob = null;
        if (DEMO) blob = (await store.getAudio(P.id, "thumb:" + sk)) || null;
        else { const r = await apiFetch(mediaApi("thumb/" + sk)); if (r.ok) blob = await r.blob(); }
        if (blob) rt.thumbs[sk] = URL.createObjectURL(blob);
      } catch { /* shown without a picture */ }
    }
    if (proj !== P || !el.isConnected) return;
    const url = rt.thumbs[sk], ph = $("[data-ph]", el), vid = $("video", el);
    if (url && ph) { const img = document.createElement("img"); img.src = url; img.alt = "Thumbnail of " + e.name; ph.replaceWith(img); }
    if (url && vid && !vid.poster) vid.poster = url;
    if (vid && DEMO && !vid.getAttribute("src")) { const u = await mediaUrl(key); if (u && el.isConnected) vid.src = u; }
  }
  async function loadThumbs() { for (const el of $$(".mslot[data-slot]", $("#panel"))) await hydrateSlot(el); }

  // Where the original can be read from: the server route (/app) or an object URL of the blob kept in the browser (/demo). "" when there is none.
  async function mediaUrl(key) {
    const e = mediaMeta()[key];
    if (!e) return "";
    const sk = MM.serverKey(key, e);
    if (!DEMO) return mediaApi("media/" + sk);
    if (rt.origs[sk]) return rt.origs[sk];
    if (e.local) { const b = await store.getAudio(proj.id, "orig:" + sk); if (b) return (rt.origs[sk] = URL.createObjectURL(b)); }
    return "";
  }

  // ----- the upload pipeline (a slot and the bulk drop zone both end here) -----
  /** Uploads one original (and its 320 px thumbnail) into the slot `key`. Resolves { ok } or { ok: false, error, cancelled }. */
  async function uploadMediaFile(key, file) {
    const P = proj, uk = upKey(P, key), m = MM.fromKey(key), prev = ((P.ext || {}).media || {})[key];
    const sk = prev ? MM.serverKey(key, prev) : MM.newServerKey(key);
    const up = rt.uploads[uk] = { name: file.name, size: file.size, loaded: 0, xhr: null, cancelled: false };
    refreshSlot(key);
    const progress = (loaded) => {
      up.loaded = loaded;
      if (proj !== P) return;
      const el = $('.mslot[data-slot="' + key + '"]', $("#panel"));
      if (!el) return;
      const pct = Math.min(100, Math.round((loaded / up.size) * 100)), bar = $(".progress", el);
      if (bar) { bar.setAttribute("aria-valuenow", String(pct)); $("div", bar).style.width = pct + "%"; }
      const t = $("[data-pct]", el);
      if (t) t.textContent = upText(up);
    };
    try {
      const type = MM.ACCEPT.image.concat(MM.ACCEPT.video).includes(file.type) ? file.type : MM.typeOf(file.name);
      const thumb = await makeThumb(file);
      if (up.cancelled) throw { cancelled: true };
      let stored = false, local = false, thumbOk = !!thumb, info = {}, warn = "";
      if (!DEMO) {
        info = await putXhr(mediaApi("media/" + sk), file, { "Content-Type": type, "X-Name": encodeURIComponent(file.name) }, up, progress);
        stored = true;
        if (thumb) { try { await putXhr(mediaApi("thumb/" + sk), thumb, { "Content-Type": thumb.type || "image/webp" }, null); } catch { thumbOk = false; } }
      } else {
        progress(file.size);
        if (thumb) await store.putAudio(P.id, "thumb:" + sk, thumb);
        const others = Object.keys(mediaMeta()).reduce((n, k) => n + (k !== key && mediaMeta()[k].local ? mediaMeta()[k].bytes || 0 : 0), 0);
        if (others + file.size <= DEMO_ORIG_CAP) { await store.putAudio(P.id, "orig:" + sk, file); local = true; } else await store.deleteAudio(P.id, "orig:" + sk);
      }
      const at = Date.now(), entry = { name: file.name, type, bytes: file.size, at, uploadedAt: at, sk, r2: "media/" + P.id + "/" + sk, stored, thumb: thumbOk };
      if (local) entry.local = true;
      const media = Object.assign({}, (P.ext || {}).media); media[key] = entry;
      P.ext = Object.assign({}, P.ext, { media });
      tickItem(P, m, true);
      if (rt.thumbs[sk]) { URL.revokeObjectURL(rt.thumbs[sk]); delete rt.thumbs[sk]; }
      if (thumbOk && thumb && typeof URL.createObjectURL === "function") rt.thumbs[sk] = URL.createObjectURL(thumb);
      if (rt.origs[sk]) { URL.revokeObjectURL(rt.origs[sk]); delete rt.origs[sk]; }
      if (local && typeof URL.createObjectURL === "function") rt.origs[sk] = URL.createObjectURL(file);
      if (DEMO) await store.putProject(P);
      else await persist(P); // a failure shows in the header (Retry); the project stays marked unsaved
      delete rt.uploads[uk];
      if (proj === P) { refreshSlot(key); syncTickUi(m); }
      if (!DEMO) {
        if (info.usedBytes !== undefined) rt.storage = Object.assign({}, rt.storage, { usedBytes: info.usedBytes, allowanceBytes: info.allowanceBytes });
        if (info.nearAllowance && !rt.warnedAllowance) { rt.warnedAllowance = true; warn = "Storage is above 80% of the 10 GB free allowance (shared with other site media). Remove files you no longer need."; }
        else if (info.overSoftCap && !rt.warnedSoft) { rt.warnedSoft = true; warn = "This project now holds more than 2 GB of media. Consider removing files you no longer need."; }
        loadStorage(true);
      }
      return { ok: true, warn };
    } catch (e) {
      delete rt.uploads[uk];
      if (proj === P) refreshSlot(key);
      if (e && e.cancelled) return { ok: false, cancelled: true, error: "Cancelled" };
      return { ok: false, error: (e && e.message) || "The upload failed." };
    }
  }

  function cancelUpload(key) {
    const up = rt.uploads[upKey(proj, key)];
    if (!up) return;
    up.cancelled = true;
    if (up.xhr) up.xhr.abort();
  }

  // One file into one slot (click, keyboard or drop): checked against the slot's kind first.
  async function slotFiles(key, files) {
    const f = files[0];
    if (!f) return;
    const why = MM.slotCheck(f, slotKind(key) === "video" ? "video" : "image");
    if (why) { toast(f.name + ": " + why + "."); return; }
    if (!mediaMeta()[key] && Object.keys(mediaMeta()).length >= MM.MAX_FILES) { toast("A project can hold " + MM.MAX_FILES + " files. Remove some first."); return; }
    if (files.length > 1) toast("Only the first file was used. Drop one file per slot, or use the bulk drop zone.");
    const r = await uploadMediaFile(key, f);
    if (r.ok) toast(r.warn || "Added " + f.name + " to " + slotWhat(key) + " and ticked it.", null, r.warn ? 9000 : undefined);
    else if (r.cancelled) toast("Upload cancelled.");
    else toast("Could not upload " + f.name + ": " + r.error);
  }

  // The bulk zone: match by file name, run each file through the same pipeline, then list what went where and what was left out.
  async function handleFiles(files) {
    if (!proj.parsed) { toast("Parse a conversation first."); return; }
    const done = [], skipped = [];
    let n = 0, warn = "";
    for (const f of files) {
      n++;
      const m = MM.match(f.name);
      if (!m) { skipped.push([f.name, "the name does not match a scene, reel item or cover (try 03.png, scene_04.mp4, R01-02.png, R01-cover.png)"]); continue; }
      if (!MM.applies(m, proj.parsed)) { skipped.push([f.name, "there is no " + MM.describe(m) + " in this project"]); continue; }
      const why = MM.slotCheck(f, m.media);
      if (why) { skipped.push([f.name, why.charAt(0).toLowerCase() + why.slice(1) + (f.size > MM.MAX_FILE ? " (" + MB(f.size) + ")" : "")]); continue; }
      if (!mediaMeta()[m.key] && Object.keys(mediaMeta()).length >= MM.MAX_FILES) { skipped.push([f.name, "a project can hold " + MM.MAX_FILES + " files"]); continue; }
      toast((DEMO ? "Reading " : "Uploading ") + n + " of " + files.length + ": " + f.name, null, 60000);
      const r = await uploadMediaFile(m.key, f);
      if (r.ok) { done.push([MM.describe(m), f.name + " (" + MB(f.size) + ")"]); if (r.warn) warn = r.warn; } else skipped.push([f.name, r.error.charAt(0).toLowerCase() + r.error.slice(1)]);
    }
    await resultsDialog(done, skipped);
    if (warn) toast(warn, null, 9000);
  }

  function resultsDialog(done, skipped) {
    return new Promise((resolve) => {
      const d = $("#dlg"), opener = document.activeElement;
      d.setAttribute("aria-labelledby", "dlg-title");
      const list = (rows, fmt) => '<ul class="fmt-list res-list">' + rows.map((r) => "<li>" + fmt(r) + "</li>").join("") + "</ul>";
      d.innerHTML = '<form method="dialog" class="resform"><h2 id="dlg-title">Upload results</h2>' +
        '<h3 class="sec res-h" id="res-matched">Added and ticked (' + done.length + ")</h3>" + (done.length ? list(done, (r) => "<strong>" + esc(r[0]) + "</strong>: " + esc(r[1])) : '<p class="hint">Nothing was added.</p>') +
        '<h3 class="sec res-h" id="res-skipped">Not added (' + skipped.length + ")</h3>" + (skipped.length ? list(skipped, (r) => "<strong>" + esc(r[0]) + "</strong>: " + esc(r[1])) : '<p class="hint">Every file found its card.</p>') +
        '<div class="dlg-actions"><button class="btn primary" data-x="ok">OK</button></div></form>';
      const close = () => { d.close(); if (opener && opener.focus && document.contains(opener)) opener.focus(); resolve(); };
      $("form", d).onsubmit = (e) => { e.preventDefault(); close(); };
      d.oncancel = (e) => { e.preventDefault(); close(); };
      d.onclick = (e) => { if (e.target === d) close(); };
      d.showModal();
    });
  }

  // ----- preview, download, remove -----
  async function openLightbox(key) {
    const e = mediaMeta()[key];
    if (!e) return;
    let d = $("#lightbox");
    if (!d) { d = document.createElement("dialog"); d.id = "lightbox"; d.className = "lightbox"; document.body.appendChild(d); }
    const opener = document.activeElement, video = isVideoType(e.type), url = await mediaUrl(key), thumb = rt.thumbs[MM.serverKey(key, e)];
    d.setAttribute("aria-label", "Preview of " + e.name);
    d.innerHTML = '<div class="lb-bar"><span class="lb-name">' + esc(e.name) + '</span><span class="muted small">' + MB(e.bytes) + '</span><button type="button" class="btn sm" data-lb-close>' + icon("x") + "Close</button></div>" +
      '<div class="lb-body">' + (url ? (video ? '<video controls autoplay playsinline src="' + url + '"' + (thumb ? ' poster="' + thumb + '"' : "") + "></video>" : '<img src="' + url + '" alt="' + esc(e.name) + '">')
        : (thumb ? '<img src="' + thumb + '" alt="' + esc(e.name) + '"><p class="hint">Demo: only the thumbnail is kept for this file (the demo keeps 25 MB of originals).</p>' : '<p class="hint">No preview is available.</p>')) + "</div>";
    icons();
    const close = () => { const v = $("video", d); if (v) v.pause(); d.close(); d.innerHTML = ""; if (opener && opener.focus && document.contains(opener)) opener.focus(); };
    $("[data-lb-close]", d).onclick = close;
    d.oncancel = (ev) => { ev.preventDefault(); close(); };
    d.onclick = (ev) => { if (ev.target === d) close(); };
    d.showModal();
    $("[data-lb-close]", d).focus();
  }

  // Download streams from R2 through the browser (Content-Disposition carries the original name); the demo saves its local copy.
  async function downloadMedia(key) {
    const e = mediaMeta()[key];
    if (!e) return;
    if (!DEMO) {
      const a = document.createElement("a");
      a.href = mediaApi("media/" + MM.serverKey(key, e)) + "?download=1";
      a.download = e.name;
      document.body.appendChild(a); a.click(); a.remove();
      return;
    }
    const b = e.local ? await store.getAudio(proj.id, "orig:" + MM.serverKey(key, e)) : null;
    if (b) A.download(b, e.name); else toast("The demo did not keep the original (over its 25 MB limit). Only the thumbnail is stored.");
  }

  async function removeMedia(key) {
    const P = proj, e = mediaMeta()[key], m = MM.fromKey(key);
    if (!e || !m) return;
    if (!(await ask({ title: "Remove " + e.name + "?", text: (DEMO ? "The file is removed from this browser." : "The original and its thumbnail are deleted from your account.") + " The matching Generated chip is unticked.", confirm: "Remove", danger: true }))) return;
    const sk = MM.serverKey(key, e);
    try {
      if (DEMO) { await store.deleteAudio(P.id, "thumb:" + sk); await store.deleteAudio(P.id, "orig:" + sk); }
      else { const r = await apiFetch(mediaApi("media/" + sk), { method: "DELETE" }); if (!r.ok && r.status !== 404) throw new Error("The server refused (" + r.status + ")."); }
    } catch (err) { toast("Could not remove it: " + err.message); return; }
    [rt.thumbs, rt.origs].forEach((o) => { if (o[sk]) { URL.revokeObjectURL(o[sk]); delete o[sk]; } });
    const media = Object.assign({}, (P.ext || {}).media); delete media[key];
    P.ext = Object.assign({}, P.ext, { media });
    tickItem(P, m, false);
    await persist(P);
    if (proj === P) { refreshSlot(key); syncTickUi(m); }
    if (!DEMO) loadStorage(true);
  }

  // One set of listeners on the panel serves every slot on every view (click, keyboard, choose a file, drop a file).
  function bindSlots() {
    const panel = $("#panel");
    const slotOf = (t) => (t && t.closest ? t.closest(".mslot[data-slot]") : null);
    const input = (slot) => $("[data-slot-input]", slot);
    panel.addEventListener("click", (e) => {
      const a = e.target.closest("[data-sa]"), slot = slotOf(e.target);
      if (!a || !slot) return;
      const key = slot.dataset.slot, act = a.dataset.sa;
      if (act === "pick" || act === "replace") input(slot).click();
      else if (act === "open") openLightbox(key);
      else if (act === "download") downloadMedia(key);
      else if (act === "remove") removeMedia(key);
      else if (act === "cancel") cancelUpload(key);
    });
    panel.addEventListener("keydown", (e) => {
      const a = e.target.closest && e.target.closest('[data-sa="pick"]');
      if (a && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); input(slotOf(a)).click(); }
    });
    panel.addEventListener("change", (e) => {
      const slot = e.target.matches && e.target.matches("[data-slot-input]") ? slotOf(e.target) : null;
      if (!slot) return;
      const files = Array.from(e.target.files || []);
      e.target.value = "";
      slotFiles(slot.dataset.slot, files);
    });
    const hasFiles = (e) => !!(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files"));
    ["dragenter", "dragover"].forEach((t) => panel.addEventListener(t, (e) => {
      const slot = slotOf(e.target);
      if (!slot || !hasFiles(e) || slot.dataset.state === "uploading") return;
      e.preventDefault();
      slot.classList.add("over");
    }));
    panel.addEventListener("dragleave", (e) => { const slot = slotOf(e.target); if (slot && !slot.contains(e.relatedTarget)) slot.classList.remove("over"); });
    panel.addEventListener("drop", (e) => {
      const slot = slotOf(e.target);
      if (!slot) return;
      e.preventDefault();
      slot.classList.remove("over");
      if (slot.dataset.state === "uploading") return;
      slotFiles(slot.dataset.slot, Array.from((e.dataTransfer && e.dataTransfer.files) || []));
    });
  }

  // Storage meter (app only): what this app keeps in the R2 bucket, against the 10 GB free allowance the bucket shares with other site media.
  const storageNear = () => !!(rt.storage && rt.storage.usedBytes >= rt.storage.allowanceBytes * 0.8);
  const storageShort = () => "Storage " + GB(rt.storage.usedBytes) + " of " + GB(rt.storage.allowanceBytes) + ".";
  async function loadStorage(force) {
    if (DEMO || (rt.storage && rt.storage.mediaBytes !== undefined && !force)) return;
    try {
      const r = await apiFetch("/api/storage");
      if (!r.ok) return;
      rt.storage = await r.json();
    } catch { return; }
    renderTree();
    const el = $("#ov-storage-line");
    if (el) el.innerHTML = storageLineHtml();
  }
  function storageLineHtml() {
    if (!rt.storage) return "Reading storage...";
    const u = rt.storage, pct = Math.min(100, Math.round((u.usedBytes / u.allowanceBytes) * 100)), mine = MM.usage(proj);
    return "<strong>" + GB(u.usedBytes) + "</strong> of the " + GB(u.allowanceBytes) + " free R2 allowance is used by this app (media " + GB((u.mediaBytes || 0) + (u.thumbBytes || 0)) + ", audio " + GB(u.audioBytes || 0) + "). " +
      "The bucket is shared with other site media, so the room left may be smaller than it looks." +
      (storageNear() ? ' <span class="warn-text">Close to the allowance: remove files you no longer need.</span>' : "") +
      '<div class="progress" role="progressbar" aria-label="Storage used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '"><div style="width:' + pct + '%"></div></div>' +
      '<span class="muted small">This project: ' + mine.files + " original" + (mine.files === 1 ? "" : "s") + ", " + GB(mine.bytes) + (mine.bytes > u.softCapBytes ? ' <span class="warn-text">(over the 2 GB per-project guide)</span>' : "") + "</span>";
  }

  // Files that belong to no card any more: orphans kept by a re-parse, plus (app) files on the server that this project does not reference.
  function unusedList() {
    const o = MM.orphanList(proj), known = new Set(o.list.map((x) => x.sk));
    Object.keys(mediaMeta()).forEach((k) => known.add(MM.serverKey(k, mediaMeta()[k])));
    const strays = (rt.strays && rt.strays.id === proj.id ? rt.strays.list : []).filter((x) => !known.has(x.sk));
    const list = o.list.concat(strays);
    return { list, bytes: list.reduce((n, x) => n + (x.bytes || 0), 0) };
  }
  function unusedHtml() {
    const u = unusedList(), outdated = MM.outdatedCount(proj);
    return (outdated ? '<p class="hint" style="margin:12px 0 0" id="ov-outdated">' + outdated + " file" + (outdated === 1 ? " is" : "s are") + " marked Outdated: its prompt was edited after the file was added. Replace or remove it on its card.</p>" : "") +
      (u.list.length ? '<div class="unused" id="ov-unused"><div class="row" style="justify-content:space-between"><strong>Unused media: ' + u.list.length + " file" + (u.list.length === 1 ? "" : "s") + ", " + GB(u.bytes) + '</strong><button type="button" class="btn sm danger" id="unused-remove">' + icon("trash-2") + "Remove unused media</button></div>" +
        '<p class="hint" style="margin:6px 0 8px">These files belonged to scenes or reels that a re-parse removed or renumbered. They were kept, never deleted automatically.</p>' +
        '<ul class="fmt-list">' + u.list.slice(0, 50).map((x) => "<li><span>" + esc(x.name || x.sk) + "</span> <span class=\"muted small\">" + (x.from ? "was " + esc(slotWhat(x.from)) + ", " : "not linked to a card, ") + MB(x.bytes || 0) + "</span></li>").join("") + (u.list.length > 50 ? "<li>and " + (u.list.length - 50) + " more</li>" : "") + "</ul></div>" : "");
  }
  async function loadStrays() {
    if (DEMO || !proj) return;
    const P = proj;
    try {
      const r = await apiFetch(mediaApi("media"));
      if (!r.ok) return;
      const body = await r.json();
      rt.strays = { id: P.id, list: (body.media || []).map((x) => ({ sk: x.key, name: x.name, bytes: (x.bytes || 0) + (x.thumbBytes || 0), type: x.type })) };
    } catch { return; }
    if (proj === P) { const el = $("#ov-unused-host"); if (el) { el.innerHTML = unusedHtml(); icons(); } }
  }
  async function removeUnused() {
    const P = proj, u = unusedList();
    if (!u.list.length) return;
    if (!(await ask({ title: "Remove " + u.list.length + " unused file" + (u.list.length === 1 ? "" : "s") + "?", text: "This deletes " + GB(u.bytes) + " from " + (DEMO ? "this browser" : "your account") + " for good. Files on cards are not touched.", confirm: "Remove unused media", danger: true }))) return;
    try {
      if (DEMO) { for (const x of u.list) { await store.deleteAudio(P.id, "thumb:" + x.sk); await store.deleteAudio(P.id, "orig:" + x.sk); } }
      else {
        const keys = u.list.map((x) => x.sk);
        for (let i = 0; i < keys.length; i += 200) {
          const r = await apiFetch(mediaApi("media-cleanup"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ keys: keys.slice(i, i + 200) }) });
          if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "The server refused (" + r.status + ").");
        }
      }
    } catch (err) { toast("Could not remove them: " + err.message); return; }
    const ext = Object.assign({}, P.ext); delete ext.orphans; P.ext = ext;
    if (rt.strays && rt.strays.id === P.id) rt.strays = null;
    await persist(P);
    toast("Removed " + u.list.length + " unused file" + (u.list.length === 1 ? "" : "s") + ".");
    if (proj === P) { const el = $("#ov-unused-host"); if (el) el.innerHTML = unusedHtml(); }
    if (!DEMO) loadStorage(true);
  }

  function filesPanelHtml() {
    const n = Object.keys(mediaMeta()).length;
    return '<section class="panel" aria-labelledby="ov-files"><div class="sec-head"><h3 class="sec" id="ov-files">Files</h3></div>' +
      '<p class="hint" style="margin:0 0 12px">' + (DEMO ? "Demo: files stay in your browser. Add them in the upload slot on each card (Visual Board, Cover, Reels). Thumbnails are always kept; originals up to 25 MB in total." : n + " media file" + (n === 1 ? "" : "s") + " on cards in this project. Add them in the upload slot on each card (Visual Board, Cover, Reels).") + "</p>" +
      (DEMO ? "" : '<div class="storage" id="ov-storage-line">' + storageLineHtml() + "</div>") +
      '<div id="ov-unused-host">' + unusedHtml() + "</div>" +
      '<div class="row" style="margin-top:12px"><button type="button" class="btn" id="export-edit">' + icon("folder-down") + "Download all assets</button></div>" +
      '<p class="hint" style="margin:8px 0 0">Audio/, Images/, Video/ and Reels/Reel_01/... plus edit-list.csv (order, scene, chunk, audio, image, video). ' + (A.canPickFolder ? "Each file streams from your account straight into a folder you choose." : "This browser cannot write to a folder, so you get a ZIP built in memory: large videos are left out (use Chrome or Edge on desktop for everything).") + "</p></section>";
  }

  // Streams a response body into Reels/Reel_01/x.png inside the chosen folder without holding the file in memory.
  async function writePathStream(dir, path, source) {
    const parts = path.split("/");
    let d = dir;
    for (let i = 0; i < parts.length - 1; i++) d = await d.getDirectoryHandle(parts[i], { create: true });
    const fh = await d.getFileHandle(parts[parts.length - 1], { create: true });
    const w = await fh.createWritable();
    if (source.body && source.body.pipeTo) await source.body.pipeTo(w);
    else { await w.write(await source.blob()); await w.close(); }
  }

  const ZIP_VIDEO_MAX = 50 * 1024 * 1024, ZIP_BUDGET = 400 * 1024 * 1024;

  // Download all assets: Audio/, Images/, Video/, Reels/Reel_NN/ and edit-list.csv. Chrome and Edge write each file straight from R2 into a chosen
  // folder (nothing is buffered). Other browsers get a ZIP built in memory, so videos over 50 MB each, or past 400 MB in total, are left out and listed.
  async function exportEditReady() {
    const folder = A.canPickFolder;
    const stored = {};
    Object.keys(mediaMeta()).forEach((k) => { if (mediaMeta()[k].stored) stored[k] = mediaMeta()[k]; });
    const base = Object.assign({}, proj, { ext: Object.assign({}, proj.ext, { media: stored }) });
    let plan = MM.exportPlan(base);
    if (!plan.files.length) { toast(DEMO ? "In the demo only audio can be exported: media files stay in your browser. Generate audio first." : "Nothing to export yet. Generate audio or add media files first."); return; }
    let dir = null, left = [];
    if (folder) {
      try { dir = await window.showDirectoryPicker({ mode: "readwrite" }); } catch (e) { if (e && e.name !== "AbortError") toast("Could not open that folder: " + e.message); return; }
    } else {
      let total = 0;
      const skip = new Set();
      plan.files.forEach((f) => {
        const video = f.from.type === "media" && isVideoType(stored[f.from.key].type);
        if (video && (f.bytes > ZIP_VIDEO_MAX || total + f.bytes > ZIP_BUDGET)) { skip.add(f.from.key); left.push(f.path + " (" + MB(f.bytes) + ")"); } else total += f.bytes;
      });
      plan = MM.exportPlan(base, { skip });
      if (!(await ask({ title: "Build a ZIP instead?", text: "This browser cannot write into a folder, so the files are packed into one ZIP in memory (about " + MB(total) + ")." + (left.length ? " " + left.length + " video file" + (left.length === 1 ? " is" : "s are") + " left out because it is too large for a browser ZIP. Use Chrome or Edge on desktop to get everything." : ""), lines: left.slice(0, 8), confirm: "Build ZIP" }))) return;
    }
    const failed = [];
    try {
      const out = [];
      for (let i = 0; i < plan.files.length; i++) {
        const f = plan.files[i];
        toast((dir ? "Writing " : "Collecting ") + (i + 1) + " of " + plan.files.length + ": " + f.path + (f.bytes ? " (" + MB(f.bytes) + ")" : ""), null, 60000);
        if (f.from.type === "audio") {
          const blob = await store.getAudio(proj.id, f.from.key);
          if (!blob) { failed.push(f.path); continue; }
          if (dir) await writePathStream(dir, f.path, { blob: async () => blob }); else out.push({ name: f.path, blob });
          continue;
        }
        const r = await apiFetch(mediaApi("media/" + f.from.sk));
        if (!r.ok) { failed.push(f.path); continue; }
        if (dir) await writePathStream(dir, f.path, r); else out.push({ name: f.path, blob: await r.blob() });
      }
      const csv = PR.toCsv(plan.rows);
      const notes = (left.length ? "Left out of this ZIP because they are too large for a browser ZIP (use Chrome or Edge on desktop):\r\n" + left.join("\r\n") + "\r\n" : "") + (failed.length ? "Could not be read:\r\n" + failed.join("\r\n") + "\r\n" : "");
      if (dir) {
        await A.writeFile(dir, "edit-list.csv", new Blob([csv], { type: "text/csv;charset=utf-8" }));
        toast("Exported " + (plan.files.length - failed.length) + " files and edit-list.csv to " + dir.name + "." + (failed.length ? " " + failed.length + " could not be read." : ""));
      } else {
        const extra = { "edit-list.csv": csv };
        if (notes) extra["NOT-INCLUDED.txt"] = notes;
        A.download(await A.buildZip(out, extra), slugName() + "-edit-ready.zip");
        toast("ZIP downloaded with " + out.length + " files and edit-list.csv." + (left.length ? " " + left.length + " large video" + (left.length === 1 ? "" : "s") + " left out (see NOT-INCLUDED.txt)." : ""));
      }
    } catch (e) { toast("Could not export: " + e.message); }
  }

  // ---------- read-only share link (app only): prompts and progress, never narration, audio, notes or publishing info ----------
  const fmtWhen = (t) => new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  async function openShare() {
    const d = $("#dlg"), opener = document.activeElement;
    let state = { active: false }, days = 7, link = "", busy = false;
    try { const r = await apiFetch(mediaApi("shares")); if (r.ok) state = await r.json(); } catch { /* shown as no link */ }
    const close = () => { d.close(); if (opener && opener.focus && document.contains(opener)) opener.focus(); };
    const draw = (msg) => {
      d.setAttribute("aria-labelledby", "dlg-title");
      d.innerHTML = '<form method="dialog" class="shareform"><h2 id="dlg-title">Share a read-only link</h2>' +
        '<p class="muted" style="margin:0 0 12px">Anyone with the link can see this project\'s image, video and cover prompts and which items are done. No narration, audio, notes, titles, captions or publishing info. It has no login, so share it only with people you trust.</p>' +
        '<div class="field"><span class="label" id="sh-exp">Expires after</span><div class="seg" role="group" aria-labelledby="sh-exp">' + [1, 7, 30].map((n) => '<button type="button" class="btn sm" data-days="' + n + '" aria-pressed="' + (days === n) + '">' + n + (n === 1 ? " day" : " days") + "</button>").join("") + "</div></div>" +
        (link ? '<div class="field" style="margin-top:12px"><label for="sh-link">Link (shown only now)</label><div class="row" style="flex-wrap:nowrap"><input id="sh-link" class="input mono" readonly value="' + esc(link) + '"><button type="button" class="btn" data-x="copy">' + icon("copy") + "<span>Copy</span></button></div></div>" : "") +
        '<p class="small" role="status" style="margin:12px 0 0">' + esc(msg || (state.active ? "A link is active until " + fmtWhen(state.expiresAt) + ". Creating a new link turns the old one off." : "No active link.")) + "</p>" +
        '<div class="row" style="margin-top:14px"><button type="button" class="btn" data-x="cancel">Close</button>' + (state.active ? '<button type="button" class="btn danger" data-x="revoke">Turn link off</button>' : "") + '<button type="button" class="btn primary" data-x="create"' + (busy ? " disabled" : "") + ">" + (state.active ? "Create a new link" : "Create link") + "</button></div></form>";
      icons();
      $$("[data-days]", d).forEach((b) => b.addEventListener("click", () => { days = Number(b.dataset.days); draw(msg); $('[data-days="' + days + '"]', d).focus(); }));
      $('[data-x="cancel"]', d).onclick = close;
      const c = $('[data-x="copy"]', d);
      if (c) c.onclick = async () => { const ok = await copyText(link); $("span", c).textContent = ok ? "Copied" : "Copy failed"; };
      $('[data-x="create"]', d).onclick = async () => {
        busy = true; draw("Creating...");
        try {
          const r = await apiFetch(mediaApi("shares"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ days }) });
          if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "The server refused (" + r.status + ").");
          state = await r.json(); link = state.url;
          busy = false; draw("Link created. Copy it now: it is not shown again. It expires " + fmtWhen(state.expiresAt) + ".");
        } catch (e) { busy = false; draw("Could not create the link: " + e.message); }
        const f = $("#sh-link", d); if (f) f.select();
      };
      const rv = $('[data-x="revoke"]', d);
      if (rv) rv.onclick = async () => {
        try { const r = await apiFetch(mediaApi("shares"), { method: "DELETE" }); if (!r.ok) throw new Error("status " + r.status); state = { active: false }; link = ""; draw("The link is turned off."); }
        catch (e) { draw("Could not turn it off: " + e.message); }
      };
    };
    d.oncancel = (e) => { e.preventDefault(); close(); };
    d.onclick = (e) => { if (e.target === d) close(); };
    draw();
    d.showModal();
  }

  // ---------- numbered copy and CSV ----------
  const slugName = () => proj.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
  const csvDownload = (name, rows) => { A.download(new Blob([PR.toCsv(rows)], { type: "text/csv;charset=utf-8" }), slugName() + "-" + name + ".csv"); toast("Downloaded " + slugName() + "-" + name + ".csv."); };

  async function copyAllImages() {
    const list = scenes().filter((s) => s.imagePrompt);
    if (!list.length) { toast("There are no image prompts to copy."); return; }
    const ok = await copyText(PR.numbered(list.map((s) => s.imagePrompt)));
    toast(ok ? "Copied " + list.length + " numbered image prompts." : "Could not copy. Use Download CSV instead.");
  }
  function downloadBoardCsv() {
    csvDownload("scenes", [["scene", "image_prompt", "video_prompt", "image_done", "video_done"]].concat(scenes().map((s) => [s.number, s.imagePrompt, s.hasVideo ? s.videoPrompt : "", G.isDone(prog(), s, "image") ? "yes" : "no", s.hasVideo ? (G.isDone(prog(), s, "video") ? "yes" : "no") : ""])));
  }
  async function copyAllReelImages() {
    const r = currentReel(), list = r.images.filter((i) => i.prompt);
    if (!list.length) { toast("This reel has no image prompts."); return; }
    const ok = await copyText(PR.numbered(list.map((i) => i.prompt)));
    toast(ok ? "Copied " + list.length + " numbered image prompts for " + r.name + "." : "Could not copy. Use Download CSV instead.");
  }
  function downloadReelsCsv() {
    const rows = [["reel", "item", "label", "prompt", "done"]];
    if (reelSub === "cover") reels().forEach((r) => rows.push([r.name, "cover", "Cover prompt", r.cover ? r.cover.prompt : "", r.cover ? (G.reelCoverDone(rprog(), r) ? "yes" : "no") : ""], [r.name, "headline", "Cover headline", r.coverHeadline || "", ""], [r.name, "caption", "Caption", r.caption || "", ""]));
    else reels().forEach((r) => {
      r.images.forEach((im, i) => rows.push([r.name, "image", im.label, im.prompt, G.reelImageDone(rprog(), r, i) ? "yes" : "no"]));
      G.reelVideos(r).forEach((v, i) => rows.push([r.name, "video", "Animation " + (i + 1), v.prompt, G.reelVideoDone(rprog(), r, i) ? "yes" : "no"]));
    });
    csvDownload(reelSub === "cover" ? "reel-covers" : "reel-prompts", rows);
  }
  function downloadCoversCsv() {
    const t = proj.parsed && proj.parsed.thumbnail;
    const rows = [["item", "label", "text", "done"]];
    if (t) rows.push(["cover", "YouTube cover prompt", t.prompt, proj.thumbnailDone ? "yes" : "no"]);
    seoItems().forEach((x) => rows.push(["text", x.label, x.text, ""]));
    reels().forEach((r) => { if (r.cover) rows.push(["reel-cover", r.name + " cover prompt", r.cover.prompt, G.reelCoverDone(rprog(), r) ? "yes" : "no"]); });
    csvDownload("covers", rows);
  }

  // ---------- Next action banner (top of every project view) ----------
  function nextAction() { return proj ? NX.nextAction(proj, (k) => !!meta(k), { setupReady: settingsReady(), setupTarget: !settings.apiKey ? "#s-key" : "#s-voice" }) : null; }
  function renderNextBar() {
    const el = $("#nextbar");
    if (!el) return;
    const a = nextAction();
    if (!a) { el.hidden = true; return; }
    el.hidden = false;
    const sig = a.label + "|" + a.view;
    if (el.dataset.sig === sig) return;
    el.dataset.sig = sig;
    el.innerHTML = '<span class="nextbar-l">Next:</span><span class="nextbar-t">' + esc(a.label) + '</span><button type="button" class="btn sm primary" id="next-go">' + icon("arrow-right") + "Go</button>";
    icons();
  }
  function goNext() {
    const a = nextAction();
    if (!a) return;
    const v = a.view.split(":");
    if (v[0] === "reels") go("reels", v[1], v[2]);
    else if (v[0] === "youtube-audio") go("youtube", "audio");
    else if (v[0] === "setup") go("setup");
    else if (v[0] === "youtube-board") { rt.boardFilter = "all"; rt.onlyAnim = false; go("youtube", "board"); }
    else if (v[0] === "youtube-covers") go("youtube", "covers");
    else go(v[0]);
    const el = $(a.target, $("#panel"));
    if (el) { el.scrollIntoView({ block: "center", behavior: "smooth" }); if (el.focus) el.focus({ preventScroll: true }); el.classList.add("flash"); setTimeout(() => el.classList.remove("flash"), 1600); }
  }

  // ---------- Covers & SEO ----------
  // Main 16:9 video only (the YouTube cover is proj.thumbnailDone). Reel covers, headlines and captions live in the Reels tabs.
  function coverTotals() {
    const p = proj && proj.parsed;
    if (!p || !p.thumbnail) return { done: 0, total: 0 };
    return { done: proj.thumbnailDone ? 1 : 0, total: 1 };
  }

  /** Publishing text items in display order: { id, label, text }. Empty items are left out. */
  function seoItems() {
    const p = proj.parsed || {};
    const out = [];
    const add = (id, label, text) => { if (text) out.push({ id, label, text }); };
    add("headline", "Cover headline", p.coverHeadline);
    add("title", "YouTube title", p.youtubeTitle);
    add("caption", "Video caption", p.caption);
    return out;
  }

  function coversExport() {
    const p = proj.parsed;
    const parts = [];
    if (p.thumbnail) parts.push("YouTube cover prompt (16:9)\n" + p.thumbnail.prompt);
    seoItems().forEach((x) => parts.push(x.label + "\n" + x.text));
    return parts.join("\n\n");
  }

  function renderCovers(p) {
    const t = proj.parsed && proj.parsed.thumbnail;
    const items = seoItems();
    if (!t && !items.length) { p.innerHTML = emptyState("No cover prompt or publishing text found yet. They come from step 5 of the conversation."); bindGoto(p); return; }
    const yt = t ? itemCardHtml({ title: "YouTube cover", ratio: "16:9", pill: donePill(!!proj.thumbnailDone), prompts: [{ label: "Cover prompt", text: t.prompt }], chips: [chipHtml('id="thumb-done"', "image", "Cover generated", !!proj.thumbnailDone)], chipsLabel: "Progress for the YouTube cover", extra: slotsHtml(["yt-cover"]) }) : "";
    const texts = items.map((x) => textCard(x.label, x.text)).join("");
    p.innerHTML = '<div class="page">' + pageHead("Cover & SEO", "The 16:9 cover prompt, cover headline, YouTube title and caption for the main video. Reel covers and captions are in Reels > Covers & Captions.", "cover") +
      dropZoneHtml() + '<div class="board-controls row"><button type="button" class="btn sm" id="covers-csv">' + icon("file-spreadsheet") + "Download CSV</button>" +
      '</div>' +
      (yt ? '<section class="isec">' + secHead("YouTube cover") + '<div class="icards">' + yt + "</div></section>" : "") +
      (texts ? '<section class="isec">' + secHead("Publishing text") + '<div class="icards">' + texts + "</div></section>" : "") + "</div>";
    $("#covers-csv", p).addEventListener("click", downloadCoversCsv);
    const th = $("#thumb-done", p);
    if (th) th.addEventListener("change", async (e) => {
      proj.thumbnailDone = e.target.checked;
      const tp = $("[data-pill]", e.target.closest(".icard"));
      if (tp) { tp.className = "pill st st-" + (e.target.checked ? "done" : "todo"); tp.textContent = e.target.checked ? STATUS_TEXT.done : STATUS_TEXT.todo; }
      refreshCounts();
      try { await saveProject(); } catch (err) { toast("Could not save progress: " + err.message); }
    });
  }

  // Puts a guide template in the paste box (asking before replacing text). Returns false when the user keeps the current text.
  async function applyTemplate(text) {
    if (proj.text && proj.text.trim() && !(await ask({ title: "Replace the pasted text with the template?", text: "The current text in this project will be replaced.", confirm: "Replace" }))) return false;
    setTab("import");
    useSamplePhrase();
    const ok = await commitText(text);
    if (ok) toast("Template loaded. Replace the [bracketed] parts with your own text.");
    return ok;
  }

  // The standalone /format page leaves a template in localStorage; put it in the paste box.
  async function applyPendingText() {
    const key = store.pendingKey;
    let text = null;
    try { text = localStorage.getItem(key); localStorage.removeItem(key); } catch { /* storage blocked */ }
    if (text) await applyTemplate(text);
  }

  // ---------- Format guide dialog: the /format page content shown in the app, so the paste is never lost ----------
  let fmtReady = false, fmtOpener = null;
  async function loadGuide() {
    if (fmtReady) return;
    const body = $("#fmt-body");
    try {
      const r = await fetch("/format");
      if (!r.ok) throw new Error("guide not found");
      const main = new DOMParser().parseFromString(await r.text(), "text/html").querySelector("main.fmt");
      if (!main || !window.MBSFormat) throw new Error("guide not found");
      body.innerHTML = main.innerHTML;
      window.MBSFormat.init(body, { mode: DEMO ? "demo" : "app", inApp: true, onUse: async (text) => { if (await applyTemplate(text)) closeFormat(); } });
      fmtReady = true;
      icons();
    } catch {
      body.innerHTML = '<div class="warn" role="alert">Could not load the guide here. <a href="/format?from=' + (DEMO ? "demo" : "app") + '" target="_blank" rel="noopener">Open it in a new tab</a>.</div>';
    }
  }
  function openFormat() {
    const d = $("#fmt-dlg");
    if (!d || d.open) return;
    if (location.hash !== "#format") history.pushState(null, "", "#format");
    fmtOpener = document.activeElement;
    d.showModal();
    $("#fmt-close").focus();
    loadGuide();
  }
  function closeFormat(fromHash) {
    const d = $("#fmt-dlg");
    if (!d || !d.open) return;
    d.close();
    if (!fromHash && location.hash === "#format") history.replaceState(null, "", hashFor());
    if (fmtOpener && document.contains(fmtOpener) && fmtOpener.focus) fmtOpener.focus();
  }
  function bindFormat() {
    const d = $("#fmt-dlg");
    $("#fmt-close").addEventListener("click", () => closeFormat());
    d.addEventListener("cancel", (e) => { e.preventDefault(); closeFormat(); });
    d.addEventListener("click", (e) => { if (e.target === d) closeFormat(); });
    root.addEventListener("click", (e) => {
      const a = e.target.closest("[data-fmt]");
      if (!a || e.button || e.metaKey || e.ctrlKey || e.shiftKey) return;
      e.preventDefault();
      openFormat();
    });
  }

  // ---------- Director Prompt vault: the Master Prompt the user pastes into Gemini ----------
  // Stored on the account in /app (always read from the server, never copied here), a fictional template in /demo. Never part of a public file.
  // Two views of one state: the header dialog (ids dp-*) and the card in Setup (ids sv-*).
  const vs = { state: null, editing: false, error: "", loaded: false, opener: null };
  const vaultEmpty = () => !DEMO && !vs.state.text.trim();
  const VIEWS = [["dp", "#dp-body"], ["sv", "#sv-body"]];
  // Never throws: a failed load leaves vs.error set (the views show it with a Retry button) and vs.loaded false.
  async function ensureVault() {
    if (vs.loaded) return;
    try {
      const r = await vault.load();
      vs.state = r.state; vs.error = ""; vs.loaded = true;
    } catch (e) { vs.error = e.message || "Could not load the Master Prompt."; }
  }
  const countText = (t) => t.length.toLocaleString() + " characters, about " + E.approxTokens(t).toLocaleString() + " tokens";

  function vaultHtml(pre) {
    const st = vs.state, editing = vs.editing || vaultEmpty(), id = (s) => pre + "-" + s;
    const noDefault = !st.defaultText || st.defaultText === st.text;
    const note = DEMO ? "Demo template. In the real app this holds your own prompt." : "Saved only to your account, never public.";
    const lines = st.text.split("\n").map((l) => '<div dir="auto">' + (l ? esc(l) : "<br>") + "</div>").join("");
    return '<p class="hint dp-note">' + esc(note) + "</p>" +
      (vaultEmpty() ? '<p class="dp-empty" role="status">Paste your Master Director Prompt here (saved only to your account, never public).</p>' : "") +
      (editing
        ? '<label class="sr-only" for="' + id("text") + '">Master Director Prompt</label><textarea id="' + id("text") + '" class="input dp-edit" dir="auto" spellcheck="false" placeholder="Paste your Master Director Prompt here"></textarea>' +
          '<div class="row dp-actions"><button type="button" class="btn primary" id="' + id("save") + '">' + icon("check") + 'Save</button>' + (vaultEmpty() ? "" : '<button type="button" class="btn" id="' + id("cancel") + '">Cancel</button>') + '<span class="small muted" id="' + id("count") + '" aria-live="polite"></span></div>'
        : '<div class="dp-box" id="' + id("box") + '" tabindex="0" role="region" aria-label="Master Director Prompt">' + lines + "</div>" +
          '<div class="row dp-actions"><button type="button" class="btn primary" id="' + id("copy") + '">' + icon("copy") + '<span>Copy Master Prompt</span></button><span class="sr-only" id="' + id("live") + '" role="status" aria-live="polite"></span>' +
          '<button type="button" class="btn" id="' + id("edit") + '">' + icon("pencil") + 'Edit</button>' +
          '<button type="button" class="btn" id="' + id("reset") + '"' + (noDefault ? ' disabled title="' + (st.defaultText ? "Already the default." : "No default saved yet. Use Set current as my default.") + '"' : "") + ">" + icon("undo-2") + 'Reset to default</button>' +
          '<button type="button" class="btn" id="' + id("default") + '"' + (st.text === st.defaultText || !st.text ? " disabled" : "") + ">" + icon("bookmark") + 'Set current as my default</button>' +
          '<span class="small muted">' + esc(countText(st.text)) + "</span></div>");
  }

  // Renders every vault view that is on the page. focusId (without the prefix) is focused in the view the user is in.
  function renderVault(focusId, pre) {
    VIEWS.forEach(([p, sel]) => {
      const body = $(sel);
      if (!body) return;
      if (!vs.state) {
        body.innerHTML = vs.error ? '<div class="warn" role="alert">Could not load the Master Prompt. ' + esc(vs.error) + ' <button type="button" class="btn sm" id="' + p + '-retry">' + icon("rotate-cw") + "Retry</button></div>" : '<p class="hint">Loading...</p>';
        icons();
        return;
      }
      body.innerHTML = vaultHtml(p);
      const ta = $("#" + p + "-text");
      if (ta) {
        ta.value = vs.draft !== undefined ? vs.draft : vs.state.text;
        const count = () => { $("#" + p + "-count").textContent = countText(ta.value) + (new TextEncoder().encode(ta.value).length > V.MAX_BYTES ? ". Over the 100 KB limit." : ""); };
        ta.addEventListener("input", () => { vs.draft = ta.value; count(); syncSave(); });
        count();
      }
      if (p === (pre || "dp")) { const f = focusId && $("#" + p + "-" + focusId, body) || ta; if (f && (p === "dp" || pre)) f.focus(); }
    });
    icons();
    syncRunGates();
  }

  async function vaultSave(next, msg, pre) {
    try {
      vs.state = await vault.save(next);
      vs.editing = false; vs.draft = undefined;
      renderVault("edit", pre);
      syncSave();
      toast(msg || "Saved.");
    } catch (e) { toast(e.message); }
  }

  async function openVault() {
    const d = $("#dp-dlg");
    if (!d || d.open) return;
    vs.opener = document.activeElement;
    await ensureVault();
    if (vs.editing && vaultDraftPending()) { /* keep the edit that is in progress */ } else { vs.editing = false; vs.draft = undefined; }
    d.showModal();
    renderVault(vs.state && vaultEmpty() ? "text" : "copy", "dp");
  }
  function closeVault() {
    const d = $("#dp-dlg");
    if (!d || !d.open) return;
    d.close();
    if (vs.opener && document.contains(vs.opener) && vs.opener.focus) vs.opener.focus();
  }

  // One click handler for both views; the button id is "<view>-<action>".
  async function vaultClick(e) {
    const b = e.target.closest("button");
    if (!b || !/^(dp|sv)-/.test(b.id)) return;
    const pre = b.id.slice(0, 2), act = b.id.slice(3);
    if (act === "retry") { await ensureVault(); renderVault(); adSync(); return; }
    if (act === "copy") {
      const ok = await copyText(vs.state.text), span = $("span", b);
      span.textContent = ok ? "Copied!" : "Copy failed";
      $("#" + pre + "-live").textContent = ok ? "Copied the Master Prompt to the clipboard." : "Could not copy. Select the text and copy it by hand.";
      clearTimeout(vs.copyTimer);
      vs.copyTimer = setTimeout(() => { const s2 = $("#" + pre + "-copy span"); if (s2) s2.textContent = "Copy Master Prompt"; }, 2000);
    } else if (act === "edit") { vs.editing = true; vs.draft = undefined; renderVault("text", pre); }
    else if (act === "cancel") { vs.editing = false; vs.draft = undefined; renderVault("edit", pre); }
    else if (act === "save") await vaultSave({ text: $("#" + pre + "-text").value, defaultText: vs.state.defaultText }, "Saved.", pre);
    else if (act === "reset") await vaultSave({ text: vs.state.defaultText, defaultText: vs.state.defaultText }, "Restored your default.", pre);
    else if (act === "default") await vaultSave({ text: vs.state.text, defaultText: vs.state.text }, "Saved the current text as your default.", pre);
  }

  function bindVault() {
    const d = $("#dp-dlg");
    $("#dp-open").addEventListener("click", openVault);
    bindGuide();
    $("#dp-close").addEventListener("click", closeVault);
    d.addEventListener("cancel", (e) => { e.preventDefault(); closeVault(); });
    d.addEventListener("click", (e) => { if (e.target === d) closeVault(); });
    $("#dp-body").addEventListener("click", vaultClick);
    $("#panel").addEventListener("click", (e) => { if (e.target.closest("#sv-body")) vaultClick(e); });
  }

  // ---------- guide dialog: opens at the top, or scrolled to one step ("?" links and the How it works card pass the step id) ----------
  function openGuide(id) {
    const d = $("#guide-dlg");
    if (!d) return;
    if (!d.open) { rt.guideOpener = document.activeElement; d.showModal(); }
    const sec = id && $("#guide-" + id);
    if (sec) { sec.scrollIntoView(); sec.focus({ preventScroll: true }); } else { d.scrollTop = 0; $("#guide-close").focus(); }
  }
  function closeGuide() {
    const d = $("#guide-dlg");
    if (!d || !d.open) return;
    d.close();
    if (rt.guideOpener && document.contains(rt.guideOpener) && rt.guideOpener.focus) rt.guideOpener.focus();
  }
  function bindGuide() {
    const d = $("#guide-dlg");
    $("#guide-open").addEventListener("click", () => openGuide());
    $("#guide-close").addEventListener("click", closeGuide);
    d.addEventListener("cancel", (e) => { e.preventDefault(); closeGuide(); });
    d.addEventListener("click", (e) => { if (e.target === d) closeGuide(); });
    d.addEventListener("click", (e) => { const a = e.target.closest("[data-guide-go]"); if (a) { e.preventDefault(); openGuide(a.dataset.guideGo); } });
    document.addEventListener("click", (e) => { const b = e.target.closest("[data-guide]"); if (b) openGuide(b.dataset.guide); });
  }

  // ---------- boot ----------
  // Everything comes from the server: the project list, the folders and the project that opens. A failure shows an error with Retry.
  async function loadAll() {
    projects = await store.listProjects();
    folders = await store.listFolders();
    if (!projects.length) {
      if (DEMO) {
        try { await addProject("Sample: The Lighthouse Keeper's Ledger", await fetchSample()); } catch { await addProject("Sample project"); }
      } else await addProject("My first project");
    }
    const wanted = store.getCurrent();
    await loadProject(projects.some((p) => p.id === wanted) ? wanted : projects[0].id);
    const nav = store.getNav();
    ["youtube", "reels"].forEach((m) => { if (nav.sub && validSub(m, nav.sub[m])) subOf[m] = nav.sub[m]; });
    const h = parseHash(location.hash);
    tab = h ? h.tab : TABS.some((t) => t[0] === nav.tab) && nav.tab !== "import" && nav.tab !== "overview" ? nav.tab : landingTab();
    if (nav.reelSub && validRsub(nav.reelSub)) reelSub = nav.reelSub;
    if (h && h.sub) subOf[h.tab] = h.sub;
    if (h && h.rsub) reelSub = h.rsub;
    refreshAll();
    if (location.hash === "#format") openFormat(); else syncNav(true);
    await applyPendingText();
  }
  async function boot() {
    renderShell();
    if (!DEMO && window.MBSMigrate) {
      try {
        await window.MBSMigrate.maybePrompt(store);
        window.MBSMigrate.footerLink().then((b) => { const host = b && $(".footer .wrap > span:last-child"); if (host) { host.append(" · "); host.append(b); } }).catch(() => {});
      } catch { /* the one-time upload of old local projects is optional */ }
    }
    await start();
  }
  async function start() {
    try {
      await loadAll();
    } catch (e) {
      const out = e && e.status === 401 ? 'You are signed out. <a href="/login">Sign in</a>.' : esc(e.message || "Unknown error") + (DEMO ? " Private windows in some browsers block IndexedDB." : "");
      $("#panel").innerHTML = '<div class="warn" role="alert">Could not load your projects. ' + out + ' <button type="button" class="btn sm" id="boot-retry">' + icon("rotate-cw") + "Retry</button></div>";
      icons();
      $("#boot-retry").addEventListener("click", () => { $("#panel").innerHTML = '<p class="hint" role="status">Loading...</p>'; start(); });
    }
  }

  // Ctrl/Cmd+S saves the project and Setup (the browser's own "save page" is not wanted here). /demo saves as you go, so it is left alone.
  document.addEventListener("keydown", (e) => {
    if (DEMO || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || String(e.key).toLowerCase() !== "s") return;
    e.preventDefault();
    saveEverything();
  });
  // Leaving the page with unsaved changes, a save or an upload in flight, or a run going: the browser asks first.
  window.addEventListener("beforeunload", (e) => { if (rt.run.active || adStatus() === "running" || leaveBlocked()) { e.preventDefault(); e.returnValue = ""; } });
  boot();
})();
