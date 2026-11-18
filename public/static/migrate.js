/*
 * One-time upload of the projects that were kept in this browser before /app moved to server storage.
 * App only (never loaded by /demo). It reads the old IndexedDB "mbs_app_db" through the local adapter,
 * uploads folders, then projects, then audio, one request at a time and paced under the API rate limit.
 * The old database stays untouched until the person clicks "Remove local copies".
 */
(function () {
  "use strict";

  const FLAG = "mbs_app:migrated"; // "Don't ask again", or an upload finished
  const DISMISSED = "mbs_app:migrate-dismissed"; // "Not now": do not pop up on every load
  const LATER = "mbs_app:migrate-later"; // sessionStorage: "Not now" for this tab session
  const UPLOADED = "mbs_app:uploaded"; // ids already uploaded, so a project deleted from the server is not offered again
  const LEGACY_DB = "mbs_app_db";
  const PACE_MS = 550; // about 110 requests a minute, under the 120 per minute limit
  const CAPS = { text: 400 * 1024, parsed: 700 * 1024, stateInfo: 200 * 1024, audio: 8 * 1024 * 1024 };
  const enc = new TextEncoder();
  const bytesOf = (s) => enc.encode(s).length;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const mb = (n) => (n / 1048576).toFixed(1);

  const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } };
  function uploadedIds() { try { const a = JSON.parse(lsGet(UPLOADED) || "[]"); return Array.isArray(a) ? a : []; } catch { return []; } }
  function markUploaded(ids) { lsSet(UPLOADED, JSON.stringify(Array.from(new Set(uploadedIds().concat(ids))))); }
  function readFlags() {
    let later = false;
    try { later = !!sessionStorage.getItem(LATER); } catch { /* blocked */ }
    return { migrated: !!lsGet(FLAG), dismissed: !!lsGet(DISMISSED), sessionLater: later, uploaded: uploadedIds() };
  }
  async function serverList(store) {
    try { const r = await store.raw("GET", "/api/projects"); if (!r.ok) return null; return ((await r.json()).projects || []).map((p) => ({ id: p.id })); } catch { return null; }
  }

  async function legacyExists() {
    if (indexedDB.databases) {
      try { return (await indexedDB.databases()).some((d) => d.name === LEGACY_DB); } catch { /* fall through */ }
    }
    return true; // cannot tell; opening an empty database is harmless
  }

  /** Audio keys a project may have in the old database: "<n>" for chunks, "reel:<id>" for reels. */
  function audioKeys(p) {
    return Object.keys(p.audio || {}).map((n) => ({ key: n, meta: p.audio[n] }))
      .concat(Object.keys(p.reelAudio || {}).map((id) => ({ key: "reel:" + id, meta: p.reelAudio[id] })));
  }

  /** The over-cap reason for a project body, or "". */
  function projectProblem(p) {
    const parsed = p.parsed ? JSON.stringify(p.parsed) : "";
    const state = JSON.stringify({ progress: p.progress || {}, reelProgress: p.reelProgress || {}, audio: p.audio || {}, reelAudio: p.reelAudio || {} }) + JSON.stringify(p.info || {});
    if (bytesOf(p.text || "") > CAPS.text) return "text is over 400 KB";
    if (bytesOf(parsed) > CAPS.parsed) return "parsed content is over 700 KB";
    if (bytesOf(state) > CAPS.stateInfo) return "progress data is over 200 KB";
    return "";
  }

  async function scan() {
    if (!(await legacyExists())) return null;
    const legacy = window.MBSStore.create("mbs_app");
    const projects = await legacy.listProjects();
    if (!projects.length) return null;
    let bytes = 0;
    projects.forEach((p) => audioKeys(p).forEach((a) => { bytes += (a.meta && a.meta.bytes) || 0; }));
    return { legacy, projects, folders: await legacy.listFolders(), bytes };
  }

  // One request with pacing, Retry-After on 429 and a few retries on network errors. Returns the Response.
  async function paced(store, ctl, method, path, o) {
    for (let tries = 0; ; tries++) {
      if (ctl.stop) throw new Error("stopped");
      let res = null;
      try { res = await store.raw(method, path, o); } catch { res = null; }
      await sleep(PACE_MS);
      if (res && res.status === 429 && tries < 6) {
        const ra = Number(res.headers.get("Retry-After")) || 15;
        ctl.note("Rate limit reached. Waiting " + ra + " s...");
        await sleep(ra * 1000);
        continue;
      }
      if (!res && tries < 3) { ctl.note("Connection problem. Retrying..."); await sleep(2000 * (tries + 1)); continue; }
      if (!res) throw new Error("The server cannot be reached. Try again later.");
      if (res.status === 401) throw new Error("You are signed out. Sign in and try again.");
      return res;
    }
  }

  async function upload(store, found, ctl) {
    const skipped = []; // { project, what, why }
    const lp = (await (await paced(store, ctl, "GET", "/api/projects")).json()).projects || [];
    const server = new Map(lp.map((p) => [p.id, p]));
    const folderIds = new Set(((await (await paced(store, ctl, "GET", "/api/folders")).json()).folders || []).map((f) => f.id));

    const audio = [];
    found.projects.forEach((p) => audioKeys(p).forEach((a) => audio.push({ p, key: a.key })));
    const total = found.folders.length + found.projects.length + audio.length;
    let done = 0;
    const step = (label) => { done++; ctl.progress(done, total, label); };

    for (const f of found.folders) {
      if (!folderIds.has(f.id)) {
        const res = await paced(store, ctl, "PUT", "/api/folders/" + f.id, { json: f });
        if (!res.ok) skipped.push({ what: "Folder \"" + f.name + "\"", why: "the server refused it (" + res.status + ")" });
      }
      step("Folders");
    }

    const sent = new Set();
    for (const p of found.projects) {
      const remote = server.get(p.id);
      const problem = projectProblem(p);
      if (remote && remote.updatedAt >= (p.updatedAt || 0)) { markUploaded([p.id]); step("Projects"); continue; } // the server copy is newer or the same: keep it
      if (problem) { skipped.push({ project: p, what: "Project \"" + p.name + "\"", why: problem }); step("Projects"); continue; }
      const body = Object.assign({ status: "draft", info: {}, overwrite: true }, p); // the local copy is newer than any server copy here, so skip the version check
      delete body.serverAt; delete body.version;
      const res = await paced(store, ctl, "PUT", "/api/projects/" + p.id, { json: body });
      if (res.ok) { sent.add(p.id); markUploaded([p.id]); }
      else skipped.push({ project: p, what: "Project \"" + p.name + "\"", why: res.status === 413 ? "it is over the size limit" : "the server refused it (" + res.status + ")" });
      step("Projects");
    }

    for (const a of audio) {
      if (sent.has(a.p.id)) {
        const blob = await found.legacy.getAudio(a.p.id, a.key);
        if (blob) {
          if (blob.size > CAPS.audio) skipped.push({ project: a.p, what: "Audio " + a.key + " in \"" + a.p.name + "\"", why: "the file is over 8 MB" });
          else {
            const res = await paced(store, ctl, "PUT", "/api/projects/" + a.p.id + "/audio/" + encodeURIComponent(a.key), { body: blob, type: /wav/i.test(blob.type) ? "audio/wav" : "audio/mpeg" });
            if (!res.ok) skipped.push({ project: a.p, what: "Audio " + a.key + " in \"" + a.p.name + "\"", why: "the server refused it (" + res.status + ")" });
          }
        }
      }
      step("Audio");
    }
    return { skipped, sent: sent.size };
  }

  function removeLocal() {
    return new Promise((resolve) => {
      const r = indexedDB.deleteDatabase(LEGACY_DB);
      r.onsuccess = r.onerror = r.onblocked = () => resolve();
    });
  }

  function open(html) {
    const d = document.createElement("dialog");
    d.setAttribute("aria-labelledby", "mig-title");
    d.innerHTML = html;
    document.body.appendChild(d);
    d.addEventListener("cancel", (e) => e.preventDefault());
    d.showModal();
    return d;
  }

  /** What is still kept in this browser: { count, bytes, pending } (pending = never uploaded and not on the server), or null. */
  async function summary(store) {
    let found = null;
    try { found = await scan(); } catch { return null; }
    if (!found) return null;
    const server = await serverList(store);
    const d = window.MBSMigratePrompt.shouldPrompt(found.projects.map((p) => ({ id: p.id, updatedAt: p.updatedAt })), server, {});
    return { count: found.projects.length, bytes: found.bytes, pending: d.pending.length, found };
  }

  const CONFIRM_DELETE = "This permanently removes the old browser-only copies. Server projects are not affected.";

  /** The upload dialog for the projects in `found`. Resolves when it is closed. */
  function showDialog(store, found) {
    return new Promise((resolve) => {
      const n = found.projects.length;
      const d = open(
        '<form method="dialog"><h2 id="mig-title">Upload your local projects</h2>' +
        '<p class="muted mig-line">Projects now live on the server so they follow you across devices.</p>' +
        '<p class="muted mig-line">Your local copies stay until you delete them.</p>' +
        '<div class="dlg-stats" role="group" aria-label="Found in this browser"><span><b>' + n + "</b> project" + (n === 1 ? "" : "s") + "</span><span><b>" + mb(found.bytes) + "</b> MB audio</span></div>" +
        '<div id="mig-body"></div>' +
        '<div class="dlg-actions" id="mig-actions"><button type="button" class="btn primary" data-x="go">Upload to server</button><button type="button" class="btn" data-x="later">Not now</button></div>' +
        '<div class="dlg-foot" id="mig-foot"><button type="button" class="linkact" data-x="never">Don\'t ask again</button><button type="button" class="linkact danger" data-x="del">Delete local copies</button></div></form>');
      d.classList.add("mig-dlg");
      const body = d.querySelector("#mig-body"), actions = d.querySelector("#mig-actions"), foot = d.querySelector("#mig-foot");
      const close = () => { d.close(); d.remove(); resolve(); };
      d.querySelector('[data-x="later"]').onclick = () => { try { sessionStorage.setItem(LATER, "1"); } catch { /* blocked */ } lsSet(DISMISSED, "1"); close(); };
      d.querySelector('[data-x="never"]').onclick = () => { lsSet(FLAG, "1"); close(); };
      d.querySelector('[data-x="del"]').onclick = async () => { if (!window.confirm(CONFIRM_DELETE)) return; await removeLocal(); lsSet(FLAG, "1"); close(); };
      d.querySelector('[data-x="go"]').onclick = async () => {
        const ctl = {
          stop: false,
          note: (t) => { const s = body.querySelector("#mig-note"); if (s) s.textContent = t; },
          progress: (i, t, label) => {
            body.querySelector("progress").value = i;
            body.querySelector("progress").max = t;
            body.querySelector("#mig-note").textContent = label + ": " + i + " of " + t;
          },
        };
        body.innerHTML = '<progress value="0" max="1" style="width:100%" aria-label="Upload progress"></progress><p class="hint" id="mig-note" role="status" aria-live="polite" style="margin:8px 0 0">Starting...</p>';
        foot.hidden = true;
        actions.innerHTML = '<button type="button" class="btn" data-x="stop">Stop</button>';
        actions.querySelector('[data-x="stop"]').onclick = () => { ctl.stop = true; };
        try {
          const r = await upload(store, found, ctl);
          lsSet(FLAG, "1");
          body.innerHTML = '<p style="margin:0 0 8px">Uploaded ' + r.sent + " project" + (r.sent === 1 ? "" : "s") + ". Projects that already had a newer copy on the server were kept as they are.</p>" +
            (r.skipped.length
              ? '<div class="warn" role="alert"><strong>' + r.skipped.length + " item" + (r.skipped.length === 1 ? "" : "s") + " not uploaded</strong><ul style=\"margin:6px 0 0;padding-left:18px\">" +
                r.skipped.map((s, i) => "<li>" + esc(s.what) + ": " + esc(s.why) + (s.project && window.MBSProjectIO ? ' <button type="button" class="btn sm" data-export="' + i + '">Export</button>' : "") + "</li>").join("") + "</ul></div>"
              : "");
          body.querySelectorAll("[data-export]").forEach((b) => { b.onclick = () => window.MBSProjectIO.exportProject(found.legacy, r.skipped[Number(b.dataset.export)].project).catch(() => {}); });
          actions.innerHTML = '<button type="button" class="btn primary" data-x="done">Done</button>';
          foot.hidden = false;
          foot.innerHTML = '<span></span><button type="button" class="linkact danger" data-x="rm">Delete local copies</button>';
          actions.querySelector('[data-x="done"]').onclick = close;
          foot.querySelector('[data-x="rm"]').onclick = async () => {
            if (r.skipped.length && !window.confirm("Some items were not uploaded. Removing local copies deletes them for good. Continue?")) return;
            if (!window.confirm(CONFIRM_DELETE)) return;
            await removeLocal();
            close();
          };
        } catch (e) {
          body.innerHTML = '<div class="warn" role="alert">' + esc(e.message === "stopped" ? "Stopped. Run it again from Setup; items already uploaded are skipped." : e.message) + "</div>";
          actions.innerHTML = '<button type="button" class="btn primary" data-x="done">Close</button>';
          foot.hidden = true;
          actions.querySelector('[data-x="done"]').onclick = close;
        }
      };
      d.querySelector('[data-x="go"]').focus();
    });
  }

  /**
   * Shows the upload dialog at load only when something is worth offering: legacy projects that were never uploaded and are not on
   * the server, and the person did not choose "Not now" or "Don't ask again". Otherwise it stays quiet (Setup has a row for it).
   */
  async function maybePrompt(store) {
    const flags = readFlags();
    if (flags.migrated || flags.dismissed || flags.sessionLater) return;
    let found = null;
    try { found = await scan(); } catch { return; }
    if (!found) { lsSet(FLAG, "1"); return; }
    const server = await serverList(store);
    const d = window.MBSMigratePrompt.shouldPrompt(found.projects.map((p) => ({ id: p.id, updatedAt: p.updatedAt })), server, flags);
    if (d.reason === "done") { lsSet(FLAG, "1"); return; }
    if (!d.prompt) return;
    await showDialog(store, found);
  }

  /** Opens the dialog on request (Setup row). */
  async function openDialog(store) {
    const found = await scan();
    if (found) await showDialog(store, found);
  }

  /** A small footer button while old local copies still exist after migrating; null when there is nothing to remove. */
  async function footerLink() {
    if (!(await legacyExists())) return null;
    let n = 0;
    try { n = (await window.MBSStore.create("mbs_app").listProjects()).length; } catch { return null; }
    if (!n) return null;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "linkbtn";
    b.textContent = "Remove old local copies (" + n + ")";
    b.onclick = async () => {
      if (!window.confirm("Remove the " + n + " project(s) kept in this browser from before server storage? Make sure they are on the server first.")) return;
      await removeLocal();
      b.remove();
    };
    return b;
  }

  window.MBSMigrate = { maybePrompt, openDialog, summary, footerLink, removeLocal, projectProblem, audioKeys, CONFIRM_DELETE };
})();
