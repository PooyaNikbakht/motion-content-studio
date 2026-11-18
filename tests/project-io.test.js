const test = require("node:test");
const assert = require("node:assert");
const JSZip = require("jszip");
require("fake-indexeddb/auto");
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem() {} };
require("../public/static/store.js");
const IO = require("../public/static/project-io.js");

const store = window.MBSStore.create("io_test");
const blob = (s, type) => new Blob([s], { type });
const text = async (b) => Buffer.from(await b.arrayBuffer()).toString();

async function seed() {
  const folder = store.newFolder("Series A");
  await store.putFolder(folder);
  const p = store.newProject("Lighthouse");
  Object.assign(p, { text: "hello", folderId: folder.id, status: "ready", info: { title: "T", reels: [{ id: 1, url: "https://x.test/r", platform: "tiktok" }] }, progress: { 1: { image: true } }, audio: { 1: { status: "ready", ext: "mp3" } }, reelAudio: { 2: { status: "ready", ext: "wav" } } });
  await store.putProject(p);
  await store.putAudio(p.id, 1, blob("MP3DATA", "audio/mpeg"));
  await store.putAudio(p.id, "reel:2", blob("WAVDATA", "audio/wav"));
  return { p, folder };
}

test("export then import round-trips project, info, status, folder name and audio as a copy", async () => {
  const { p, folder } = await seed();
  const out = await IO.buildExport(store, p, folder, JSZip);
  assert.strictEqual(out.name, "lighthouse.mbsproj.zip");
  const zip = await JSZip.loadAsync(await out.blob.arrayBuffer());
  assert.deepStrictEqual(Object.keys(zip.files).filter((n) => !n.endsWith("/")).sort(), ["audio/1.mp3", "audio/reel-2.wav", "project.json"]);
  assert.strictEqual(JSON.parse(await zip.file("project.json").async("string")).format, "mbs-project");

  const parsed = await IO.parseImport(out.blob, JSZip);
  const folders = await store.listFolders();
  const r = await IO.importParsed(store, parsed, { projects: await store.listProjects(), folders });
  assert.notStrictEqual(r.project.id, p.id);
  assert.strictEqual(r.project.name, "Lighthouse (copy)");
  assert.strictEqual(r.project.folderId, folder.id, "matches the folder by name instead of duplicating it");
  assert.strictEqual(r.project.status, "ready");
  assert.deepStrictEqual(r.project.info, p.info);
  assert.deepStrictEqual(r.project.progress, p.progress);
  assert.strictEqual(await text(await store.getAudio(r.project.id, 1)), "MP3DATA");
  assert.strictEqual(await text(await store.getAudio(r.project.id, "reel:2")), "WAVDATA");
  assert.strictEqual((await store.listFolders()).length, folders.length);
});

test("import creates the folder when it does not exist", async () => {
  const zip = new JSZip();
  zip.file("project.json", JSON.stringify({ format: "mbs-project", version: 1, project: { name: "Solo", text: "x" }, folder: { name: "Brand new" } }));
  const r = await IO.importFile(store, await zip.generateAsync({ type: "uint8array" }), { projects: [], folders: [] }, JSZip);
  assert.strictEqual(r.folder.name, "Brand new");
  assert.strictEqual(r.project.folderId, r.folder.id);
});

test("import rejects bad format, bad version, missing project.json, oversized json and zip", async () => {
  const mk = async (files) => { const z = new JSZip(); Object.entries(files).forEach(([k, v]) => z.file(k, v)); return z.generateAsync({ type: "uint8array" }); };
  await assert.rejects(IO.parseImport(await mk({ "a.txt": "x" }), JSZip), /project.json is missing/);
  await assert.rejects(IO.parseImport(await mk({ "project.json": JSON.stringify({ format: "other", version: 1 }) }), JSZip), /not a Motion Content/);
  await assert.rejects(IO.parseImport(await mk({ "project.json": JSON.stringify({ format: "mbs-project", version: 2, project: {} }) }), JSZip), /version 2/);
  await assert.rejects(IO.parseImport(await mk({ "project.json": "{nope" }), JSZip), /not valid JSON/);
  await assert.rejects(IO.parseImport(await mk({ "project.json": " ".repeat(1.6 * 1024 * 1024) }), JSZip), /over 1.5 MB/);
  await assert.rejects(IO.parseImport({ size: 201 * 1024 * 1024 }, JSZip), /over 200 MB/);
  await assert.rejects(IO.parseImport(new Uint8Array([1, 2, 3]), JSZip), /not a valid project zip/);
});

test("audio with unknown names or no file is dropped, not imported", async () => {
  const z = new JSZip();
  z.file("project.json", JSON.stringify({ format: "mbs-project", version: 1, project: { name: "N", audio: { 1: { status: "ready" }, 2: { status: "ready" } } }, folder: null }));
  z.file("audio/1.mp3", "a"); z.file("audio/evil..name.mp3", "b");
  const r = await IO.importFile(store, await z.generateAsync({ type: "uint8array" }), { projects: [], folders: [] }, JSZip);
  assert.deepStrictEqual(Object.keys(r.project.audio), ["1"]);
  assert.strictEqual(r.skipped.length, 1);
});

test("ext (history, startPhrase) survives export and import; the queue lock and media index do not", async () => {
  const p = store.newProject("Ext");
  p.ext = { startPhrase: "Hello", history: [{ at: 1 }], queue: { id: "q", phase: "main" }, media: { "s:1": { name: "01.png" } }, orphans: { x: { bytes: 1 } } };
  await store.putProject(p);
  const out = await IO.buildExport(store, p, null, JSZip);
  const r = await IO.importParsed(store, await IO.parseImport(out.blob, JSZip), { projects: [], folders: [] });
  assert.deepStrictEqual(r.project.ext, { startPhrase: "Hello", history: p.ext.history });
  assert.deepStrictEqual(p.ext.queue, { id: "q", phase: "main" }, "the source project is not modified");
});
