const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { shouldPrompt } = require("../public/static/migrate-prompt.js");

const L = [{ id: "a", updatedAt: 1 }, { id: "b", updatedAt: 2 }];

test("prompts for legacy projects that are neither on the server nor uploaded before", () => {
  assert.deepEqual(shouldPrompt(L, [], {}), { prompt: true, pending: ["a", "b"], reason: "pending" });
  assert.deepEqual(shouldPrompt(L, [{ id: "a" }], {}).pending, ["b"]);
});

test("everything already on the server counts as done", () => {
  const r = shouldPrompt(L, [{ id: "a" }, { id: "b" }, { id: "x" }], {});
  assert.deepEqual([r.prompt, r.reason, r.pending], [false, "done", []]);
});

test("a project uploaded once and deleted from the server later is not offered again", () => {
  const r = shouldPrompt(L, [], { uploaded: ["a", "b"] });
  assert.deepEqual([r.prompt, r.reason], [false, "done"]);
  assert.deepEqual(shouldPrompt(L, [], { uploaded: ["a"] }).pending, ["b"]);
});

test("Not now (this session or remembered) and Don't ask again keep it quiet", () => {
  assert.equal(shouldPrompt(L, [], { sessionLater: true }).reason, "later");
  assert.equal(shouldPrompt(L, [], { dismissed: true }).prompt, false);
  assert.equal(shouldPrompt(L, [], { migrated: true }).reason, "migrated");
});

test("when the server list cannot be read nothing is uploaded blindly", () => {
  assert.deepEqual([shouldPrompt(L, null, {}).prompt, shouldPrompt(L, null, {}).reason], [false, "offline"]);
  assert.equal(shouldPrompt([], null, {}).reason, "done");
  assert.equal(shouldPrompt(undefined, undefined, undefined).prompt, false);
});

// jsdom check of the dialog buttons and the Setup row. Needs jsdom: set JSDOM_PATH (or install it); skipped otherwise.
let JSDOM = null;
try { JSDOM = require(process.env.JSDOM_PATH || "jsdom").JSDOM; } catch { /* not installed */ }

test("migrate dialog has Upload, Delete local copies, Not now and Don't ask again; Not now and Don't ask again are remembered", { skip: !JSDOM && "jsdom not available" }, async () => {
  const src = (f) => fs.readFileSync(path.join(__dirname, "../public/static", f), "utf8");
  const build = () => {
    const dom = new JSDOM("<!doctype html><body></body>", { runScripts: "outside-only", url: "http://localhost/app/" });
    const w = dom.window;
    w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    w.HTMLDialogElement.prototype.close = function () { this.open = false; };
    w.TextEncoder = TextEncoder;
    w.indexedDB = { databases: async () => [{ name: "mbs_app_db" }], deleteDatabase: () => { const r = {}; setTimeout(() => r.onsuccess && r.onsuccess(), 0); return r; } };
    const legacy = { listProjects: async () => [{ id: "p1", name: "One", updatedAt: 1, audio: {} }, { id: "p2", name: "Two", updatedAt: 2, audio: {} }], listFolders: async () => [] };
    w.MBSStore = { create: () => legacy };
    w.eval(src("migrate-prompt.js")); w.eval(src("migrate.js"));
    const store = { raw: async () => ({ ok: true, json: async () => ({ projects: [] }) }) };
    return { w, store };
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  let { w, store } = build();
  let p = w.MBSMigrate.maybePrompt(store);
  await wait(30);
  const labels = [...w.document.querySelectorAll("#mig-actions button")].map((b) => b.textContent);
  assert.deepEqual(labels, ["Upload to server", "Not now"]);
  assert.deepEqual([...w.document.querySelectorAll("#mig-foot button")].map((b) => b.textContent), ["Don't ask again", "Delete local copies"]);
  assert.match(w.document.querySelector(".dlg-stats").textContent, /2 projects\s*0\.0 MB audio/);
  w.document.querySelector('[data-x="later"]').click();
  await p;
  assert.equal(w.localStorage.getItem("mbs_app:migrate-dismissed"), "1");
  assert.equal(w.sessionStorage.getItem("mbs_app:migrate-later"), "1");
  await w.MBSMigrate.maybePrompt(store);
  assert.equal(w.document.querySelector("dialog"), null, "no second popup");

  ({ w, store } = build());
  p = w.MBSMigrate.maybePrompt(store);
  await wait(30);
  w.document.querySelector('[data-x="never"]').click();
  await p;
  assert.equal(w.localStorage.getItem("mbs_app:migrated"), "1");

  ({ w, store } = build());
  let asked = "";
  w.confirm = (t) => { asked = t; return false; };
  p = w.MBSMigrate.maybePrompt(store);
  await wait(30);
  w.document.querySelector('[data-x="del"]').click();
  await wait(10);
  assert.equal(asked, "This permanently removes the old browser-only copies. Server projects are not affected.");
  assert.ok(w.document.querySelector("dialog"), "declining the confirm keeps the dialog");
  w.document.querySelector('[data-x="never"]').click();
  await p;

  // every legacy project already on the server: no popup at all
  ({ w, store } = build());
  store.raw = async () => ({ ok: true, json: async () => ({ projects: [{ id: "p1" }, { id: "p2" }] }) });
  await w.MBSMigrate.maybePrompt(store);
  assert.equal(w.document.querySelector("dialog"), null);
  assert.equal(w.localStorage.getItem("mbs_app:migrated"), "1");
});
