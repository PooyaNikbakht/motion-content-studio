/*
 * Browser storage, the LOCAL adapter. Projects, sidebar folders, audio blobs and folder handles live
 * in IndexedDB; settings live in localStorage. Every name is prefixed per mode ("mbs_app" or
 * "mbs_demo") so the demo can never read or overwrite the real app's data.
 *
 * The UI only talks to the adapter interface below. /demo uses this local adapter directly; /app uses
 * MBSRemoteStore (remote-store.js), which talks to the server for everything except device-local state (this adapter
 * serves its folder handles, settings and nav).
 *
 * @typedef {Object} Project  { id, name, folderId, lang, status, text, parsed, progress, audio, reelProgress, reelAudio, info, createdAt, updatedAt }
 * @typedef {Object} Folder   { id, name, collapsed, createdAt }
 *
 * @typedef {Object} StoreAdapter
 * @property {() => Promise<Project[]>} listProjects          locally the whole projects; remotely summaries (no text or parsed), so call getProject
 * @property {(id: string) => Promise<Project|undefined>} getProject
 * @property {(p: Project, opts?: {touch?: boolean, overwrite?: boolean}) => Promise<void>} putProject   touch:false keeps updatedAt; remotely p.version is the base version and is updated, overwrite skips the check (409 otherwise)
 * @property {(id: string, fields: {name?: string, folderId?: string|null, status?: string}) => Promise<{version?: number}>} patchProject   rename or move without touching the rest
 * @property {(id: string) => Promise<void>} deleteProject    also removes its audio
 * @property {() => Promise<Folder[]>} listFolders
 * @property {(f: Folder) => Promise<void>} putFolder
 * @property {(id: string) => Promise<void>} deleteFolder     its projects go to the top level
 * @property {(pid: string, key: number|string, blob: Blob) => Promise<void>} putAudio   key: chunk number or "reel:<id>"
 * @property {(pid: string, key: number|string) => Promise<Blob|undefined>} getAudio
 * @property {(pid: string, key: number|string) => Promise<void>} deleteAudio
 * Handles (File System Access folders), settings, sidebar state, nav and "current project" are always device-local.
 */
(function () {
  "use strict";

  const DEFAULT_SETTINGS = {
    apiKey: "",
    voiceId: "",
    model: "eleven_v4",
    // Model for quick previews and voice tests (Flash: half the credits). Never used for full chunks. A saved settings object without it gets this default.
    previewModel: "eleven_flash_v2_5",
    stability: 0.5,
    startPhrase: "",
    // Editable credit rates { model: { credits, usd } } over the defaults in estimate.js. Empty means defaults.
    rates: {},
    // AI Director (Gemini). The key stays in this browser and goes only to generativelanguage.googleapis.com.
    geminiKey: "",
    geminiModel: "gemini-3.8-flash",
    geminiTemp: 0.7,
    // Which model runs which stage: { preset: "hybrid"|"carbon"|"flash", stages: { "1": modelId, ... } } (per-stage overrides). See director.js.
    geminiRoute: { preset: "hybrid", stages: {} },
    // Editable token rates { model: { in, out, inHi, outHi } } over the defaults in estimate.js. Empty means defaults.
    geminiRates: {},
  };

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function req(r) {
    return new Promise((resolve, reject) => {
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }

  // opts.dbPrefix: name the IndexedDB database differently from the localStorage prefix (the remote adapter keeps its folder handles in its own database).
  function create(prefix, opts) {
    opts = opts || {};
    let dbPromise = null;

    function db() {
      if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
          const open = indexedDB.open((opts.dbPrefix || prefix) + "_db", 2);
          // Version 2 adds the sidebar "folders" store. Existing projects are untouched (no folderId means top level).
          open.onupgradeneeded = () => {
            const d = open.result;
            if (!d.objectStoreNames.contains("projects")) d.createObjectStore("projects", { keyPath: "id" });
            if (!d.objectStoreNames.contains("audio")) d.createObjectStore("audio");
            if (!d.objectStoreNames.contains("handles")) d.createObjectStore("handles");
            if (!d.objectStoreNames.contains("folders")) d.createObjectStore("folders", { keyPath: "id" });
          };
          open.onsuccess = () => resolve(open.result);
          open.onerror = () => reject(open.error);
        });
      }
      return dbPromise;
    }

    async function store(name, mode) {
      return (await db()).transaction(name, mode || "readonly").objectStore(name);
    }

    // n is a chunk number, or "reel:<id>" for a reel's audio, so the two never collide.
    const audioKey = (pid, n) => pid + ":" + n;

    const api = {
      prefix,

      newProject(name) {
        const now = Date.now();
        return { id: uid(), name: name || "Untitled project", lang: "auto", text: "", parsed: null, progress: {}, audio: {}, reelProgress: {}, reelAudio: {}, folderId: null, status: "draft", info: {}, createdAt: now, updatedAt: now };
      },
      async listProjects() {
        const all = await req((await store("projects")).getAll());
        return all.sort((a, b) => a.createdAt - b.createdAt);
      },
      async getProject(id) {
        return req((await store("projects")).get(id));
      },
      // opts.touch === false keeps updatedAt (moving a project must not reorder it).
      async putProject(p, opts) {
        if (!opts || opts.touch !== false) p.updatedAt = Date.now();
        await req((await store("projects", "readwrite")).put(p));
      },
      // Rename or move without a full save (the remote adapter has a server route for it).
      async patchProject(id, fields) {
        const p = await this.getProject(id);
        if (p) await this.putProject(Object.assign(p, fields), { touch: false });
        return {};
      },
      newFolder(name) {
        return { id: uid(), name: name || "New folder", collapsed: false, createdAt: Date.now() };
      },
      async listFolders() {
        const all = await req((await store("folders")).getAll());
        return all.sort((a, b) => a.createdAt - b.createdAt);
      },
      async putFolder(f) {
        await req((await store("folders", "readwrite")).put(f));
      },
      // Removes the folder only. Its projects go back to the top level and are never deleted.
      async deleteFolder(id) {
        const d = await db();
        await new Promise((resolve, reject) => {
          const tx = d.transaction(["folders", "projects"], "readwrite");
          tx.objectStore("folders").delete(id);
          const cur = tx.objectStore("projects").openCursor();
          cur.onsuccess = () => {
            const c = cur.result;
            if (!c) return;
            if (c.value.folderId === id) c.update(Object.assign({}, c.value, { folderId: null }));
            c.continue();
          };
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
        });
      },
      async deleteProject(id) {
        const d = await db();
        await new Promise((resolve, reject) => {
          const tx = d.transaction(["projects", "audio", "handles"], "readwrite");
          tx.objectStore("projects").delete(id);
          tx.objectStore("audio").delete(IDBKeyRange.bound(id + ":", id + ":￿"));
          tx.objectStore("handles").delete(id);
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
        });
      },

      async putAudio(pid, n, blob) {
        await req((await store("audio", "readwrite")).put(blob, audioKey(pid, n)));
      },
      async getAudio(pid, n) {
        return req((await store("audio")).get(audioKey(pid, n)));
      },
      async deleteAudio(pid, n) {
        await req((await store("audio", "readwrite")).delete(audioKey(pid, n)));
      },

      async putHandle(pid, handle) {
        await req((await store("handles", "readwrite")).put(handle, pid));
      },
      async getHandle(pid) {
        return req((await store("handles")).get(pid));
      },
      async deleteHandle(pid) {
        await req((await store("handles", "readwrite")).delete(pid));
      },

      getSettings() {
        try {
          return Object.assign({}, DEFAULT_SETTINGS, JSON.parse(localStorage.getItem(prefix + ":settings") || "{}"));
        } catch {
          return Object.assign({}, DEFAULT_SETTINGS);
        }
      },
      saveSettings(s) {
        localStorage.setItem(prefix + ":settings", JSON.stringify(s));
      },
      // Sidebar collapsed state (desktop), remembered per mode.
      getSidebarCollapsed() {
        return localStorage.getItem(prefix + ":sidebar") === "closed";
      },
      setSidebarCollapsed(v) {
        localStorage.setItem(prefix + ":sidebar", v ? "closed" : "open");
      },
      // Last main tab and last sub-tab per mode: { tab, sub: { youtube, reels } }.
      getNav() {
        try { return JSON.parse(localStorage.getItem(prefix + ":nav") || "{}") || {}; } catch { return {}; }
      },
      setNav(nav) {
        try { localStorage.setItem(prefix + ":nav", JSON.stringify(nav)); } catch { /* storage full or blocked */ }
      },
      pendingKey: prefix + ":pending_text",
      getCurrent() {
        return localStorage.getItem(prefix + ":current");
      },
      setCurrent(id) {
        localStorage.setItem(prefix + ":current", id);
      },
    };
    return api;
  }

  window.MBSStore = { create, DEFAULT_SETTINGS };
})();
