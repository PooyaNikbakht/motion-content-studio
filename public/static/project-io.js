/*
 * Export and import one project as "<name>.mbsproj.zip". Works in both modes and only talks to the
 * storage adapter, so /demo stays local and /app saves through the server.
 *
 *   project.json   { format: "mbs-project", version: 1, project, folder: { name } | null }
 *   audio/<key>.mp3|wav   <key> is a chunk number, or "reel-<id>" for a reel's audio
 *
 * Import always creates a copy with a new id. UMD: window.MBSProjectIO in the browser, require() in Node
 * (the JSZip constructor is injected there).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MBSProjectIO = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const FORMAT = "mbs-project";
  const VERSION = 1;
  const LIMITS = { zip: 200 * 1024 * 1024, json: 1.5 * 1024 * 1024, audio: 8 * 1024 * 1024, entries: 600 };
  const FIELDS = ["lang", "status", "text", "parsed", "progress", "reelProgress", "audio", "reelAudio", "info", "thumbnailDone"];
  // proj.ext is the catch-all for newer features (history, queue, media, orphans). The queue lock and the media index are
  // per-device or per-server state, so they stay out of an export.
  const EXT_LOCAL = ["queue", "media", "orphans"];
  const portableExt = (ext) => { const o = Object.assign({}, ext); EXT_LOCAL.forEach((k) => delete o[k]); return o; };
  const FILE_KEY = /^(\d{1,4}|reel-[\w-]{1,40})$/;

  const zipCtor = (Z) => Z || (typeof window !== "undefined" && window.JSZip);
  const toStoreKey = (k) => (k.startsWith("reel-") ? "reel:" + k.slice(5) : Number(k));
  const toFileKey = (k) => String(k).replace(":", "-");
  const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";

  /** The audio keys a project has metadata for, as adapter keys ("n" chunks and "reel:<id>"). */
  function audioKeys(p) {
    return Object.keys(p.audio || {}).map((n) => ({ key: Number(n), meta: p.audio[n] }))
      .concat(Object.keys(p.reelAudio || {}).map((id) => ({ key: "reel:" + id, meta: p.reelAudio[id] })));
  }

  /**
   * Builds the zip. Returns { blob, name, missing }, where missing lists audio the adapter could not read.
   * @param {object} store   a StoreAdapter
   * @param {object} proj
   * @param {{name?: string}|null} folder
   */
  async function buildExport(store, proj, folder, JSZip) {
    const Z = zipCtor(JSZip);
    const zip = new Z();
    const project = {};
    ["name"].concat(FIELDS).forEach((k) => { if (proj[k] !== undefined) project[k] = proj[k]; });
    if (proj.ext && typeof proj.ext === "object") project.ext = portableExt(proj.ext);
    project.createdAt = proj.createdAt;
    project.updatedAt = proj.updatedAt;
    zip.file("project.json", JSON.stringify({ format: FORMAT, version: VERSION, project, folder: folder && folder.name ? { name: folder.name } : null }, null, 2));
    const missing = [];
    for (const a of audioKeys(proj)) {
      const blob = await store.getAudio(proj.id, a.key);
      if (!blob) { missing.push(String(a.key)); continue; }
      const ext = /wav/i.test(blob.type) || (a.meta && a.meta.ext === "wav") ? "wav" : "mp3";
      zip.file("audio/" + toFileKey(a.key) + "." + ext, blob);
    }
    const blob = await zip.generateAsync({ type: "blob", compression: "STORE" }); // audio is already compressed
    return { blob, name: slug(proj.name) + ".mbsproj.zip", missing };
  }

  /** Builds the zip and saves it through the browser's download. */
  async function exportProject(store, proj, folders, JSZip) {
    const folder = (folders || []).find((f) => f.id === proj.folderId) || null;
    const r = await buildExport(store, proj, folder, JSZip);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(r.blob);
    a.download = r.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    return r;
  }

  const declared = (entry) => (entry && entry._data && typeof entry._data.uncompressedSize === "number" ? entry._data.uncompressedSize : null);

  /**
   * Validates a zip (Blob, File, ArrayBuffer or Uint8Array). Throws Error with a readable message.
   * Returns { project, folderName, audio: [{ key, blob }], skipped: [string] }.
   */
  async function parseImport(file, JSZip) {
    const Z = zipCtor(JSZip);
    const size = file.size !== undefined ? file.size : file.byteLength;
    if (size > LIMITS.zip) throw new Error("That file is over 200 MB.");
    let zip;
    try { zip = await Z.loadAsync(file); } catch { throw new Error("That is not a valid project zip."); }
    const names = Object.keys(zip.files);
    if (names.length > LIMITS.entries) throw new Error("That zip has too many files.");
    const entry = zip.file("project.json");
    if (!entry) throw new Error("project.json is missing. Is this a Motion Content Studio project?");
    if ((declared(entry) || 0) > LIMITS.json) throw new Error("project.json is over 1.5 MB.");
    const bytes = await entry.async("uint8array");
    if (bytes.length > LIMITS.json) throw new Error("project.json is over 1.5 MB.");
    let doc;
    try { doc = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error("project.json is not valid JSON."); }
    if (!doc || doc.format !== FORMAT) throw new Error("This is not a Motion Content Studio project file.");
    if (doc.version !== VERSION) throw new Error("This project file is version " + doc.version + ", which this app cannot read.");
    const p = doc.project;
    if (!p || typeof p !== "object" || typeof p.name !== "string" || !p.name.trim()) throw new Error("The project in this file has no name.");
    if (p.text !== undefined && typeof p.text !== "string") throw new Error("The project text is invalid.");

    const audio = [], skipped = [];
    for (const n of names) {
      const m = /^audio\/([^/]+)\.(mp3|wav)$/.exec(n);
      if (!m) continue;
      if (!FILE_KEY.test(m[1])) { skipped.push(n + " (unknown name)"); continue; }
      const e = zip.file(n);
      if ((declared(e) || 0) > LIMITS.audio) { skipped.push(n + " (over 8 MB)"); continue; }
      const buf = await e.async("uint8array");
      if (buf.length > LIMITS.audio) { skipped.push(n + " (over 8 MB)"); continue; }
      audio.push({ key: toStoreKey(m[1]), blob: new Blob([buf], { type: m[2] === "wav" ? "audio/wav" : "audio/mpeg" }) });
    }
    const folderName = doc.folder && typeof doc.folder.name === "string" ? doc.folder.name.slice(0, 80) : "";
    return { project: p, folderName, audio, skipped };
  }

  /**
   * Saves a parsed import through the adapter as a new project (new id, name gets " (copy)" if taken).
   * Returns { project, folder, skipped }. The caller refreshes its lists.
   */
  async function importParsed(store, parsed, existing) {
    const projects = (existing && existing.projects) || [];
    const folders = (existing && existing.folders) || [];
    const src = parsed.project;
    const base = String(src.name).trim().slice(0, 80);
    const name = projects.some((x) => x.name === base) ? base.slice(0, 73) + " (copy)" : base;
    const p = store.newProject(name);
    FIELDS.forEach((k) => { if (src[k] !== undefined && src[k] !== null) p[k] = src[k]; });
    p.ext = src.ext && typeof src.ext === "object" && !Array.isArray(src.ext) ? portableExt(src.ext) : {};
    if (!["draft", "in_production", "ready", "published"].includes(p.status)) p.status = "draft";
    // Only keep audio metadata for files that came with the zip.
    const have = new Set(parsed.audio.map((a) => String(a.key)));
    p.audio = Object.fromEntries(Object.entries(p.audio || {}).filter(([n]) => have.has(n)));
    p.reelAudio = Object.fromEntries(Object.entries(p.reelAudio || {}).filter(([id]) => have.has("reel:" + id)));

    let folder = null;
    if (existing && existing.folderId !== undefined && existing.folderId !== null) folder = folders.find((f) => f.id === existing.folderId) || null;
    else if (parsed.folderName) {
      folder = folders.find((f) => f.name.toLowerCase() === parsed.folderName.toLowerCase()) || null;
      if (!folder) { folder = store.newFolder(parsed.folderName); await store.putFolder(folder); }
    }
    p.folderId = folder ? folder.id : null;
    await store.putProject(p);
    for (const a of parsed.audio) await store.putAudio(p.id, a.key, a.blob);
    return { project: p, folder, skipped: parsed.skipped };
  }

  async function importFile(store, file, existing, JSZip) {
    return importParsed(store, await parseImport(file, JSZip), existing);
  }

  return { FORMAT, VERSION, LIMITS, buildExport, exportProject, parseImport, importParsed, importFile, audioKeys };
});
