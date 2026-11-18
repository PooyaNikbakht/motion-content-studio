// Shared by the jsdom UI tests: loads the real public/static scripts into a jsdom window with an in-memory store.
// Needs jsdom: set JSDOM_PATH (or install it). Tests skip when it is missing. Not a test file itself.
const fs = require("node:fs");
const path = require("node:path");

let JSDOM = null;
try { JSDOM = require(process.env.JSDOM_PATH || "jsdom").JSDOM; } catch { /* not installed */ }

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, "public/static", f), "utf8");
const MODS = ["parser", "diff", "progress", "store", "tree", "audio", "estimate", "quality", "vault", "gemini", "director", "director-run", "guide", "queue", "next", "prompts", "media", "format-template", "format", "project-io", "overview"];

/**
 * opts: { mode: "demo"|"app", settings, projects: [partial project], fetch, vaultText, sample, pre(window), patchStore(store, projs, window) }
 * Returns { w, $, $$, click, wait, store, projs, settings, errors }.
 */
async function boot(opts) {
  opts = opts || {};
  const mode = opts.mode || "demo";
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { runScripts: "outside-only", url: "http://localhost:8799/" + mode + "/", pretendToBeVisual: true });
  const w = dom.window;
  w.MBS_MODE = mode;
  w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder; w.Blob = Blob;
  const sample = fs.readFileSync(path.join(ROOT, "public/demo/sample-conversation.txt"), "utf8");
  const calls = [];
  w.fetch = opts.fetch ? async (...a) => { calls.push(a); return opts.fetch(...a); } : async (u, ...a) => { calls.push([u, ...a]); return { ok: true, status: 200, text: async () => sample, json: async () => ({}) }; };
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; };
  if (opts.pre) opts.pre(w); // before the scripts load (e.g. to define showDirectoryPicker)
  MODS.forEach((m) => w.eval(read(m + ".js")));
  if (mode === "app") { w.eval(read("migrate-prompt.js")); w.eval(read("migrate.js")); }
  const projs = new Map();
  const settings = Object.assign({}, w.MBSStore.DEFAULT_SETTINGS, opts.settings || {});
  const mk = (name) => ({ id: "p" + projs.size, name, lang: "auto", text: "", parsed: null, progress: {}, audio: {}, reelProgress: {}, reelAudio: {}, folderId: null, status: "draft", info: {}, ext: {}, createdAt: Date.now(), updatedAt: Date.now() });
  (opts.projects || []).forEach((p) => projs.set(p.id, Object.assign(mk("P"), p)));
  const store = {
    prefix: "mbs_" + mode,
    newProject: (name) => mk(name),
    listProjects: async () => [...projs.values()], getProject: async (id) => projs.get(id), putProject: async (p) => { projs.set(p.id, JSON.parse(JSON.stringify(p))); }, patchProject: async (id, f) => { Object.assign(projs.get(id), f); return {}; },
    listFolders: async () => [], putFolder: async () => {}, deleteFolder: async () => {}, deleteProject: async () => {},
    putAudio: async () => {}, getAudio: async () => null, deleteAudio: async () => {}, putHandle: async () => {}, getHandle: async () => null, deleteHandle: async () => {},
    getSettings: () => settings, saveSettings(s) { Object.assign(settings, s); }, 
    pendingKey: "k", getSidebarCollapsed: () => false, setSidebarCollapsed() {}, getCurrent: () => null, setCurrent() {}, getNav: () => ({}), setNav() {},
  };
  w.MBSStore = { create: () => store, DEFAULT_SETTINGS: w.MBSStore.DEFAULT_SETTINGS }; w.MBSRemoteStore = { create: () => store };
  if (opts.patchStore) opts.patchStore(store, projs, w); // tests: spy on or replace adapter methods
  const errors = [];
  w.addEventListener("error", (e) => errors.push(e.message));
  w.eval(read("ui.js"));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(opts.bootWait || 300);
  const $ = (s) => w.document.querySelector(s), $$ = (s) => [...w.document.querySelectorAll(s)];
  const click = (el) => el.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  const input = (el, v) => { el.value = v; el.dispatchEvent(new w.Event("input", { bubbles: true })); el.dispatchEvent(new w.Event("change", { bubbles: true })); };
  /** Opens a custom dropdown by button id and picks the option whose text contains `text`. */
  const pick = async (id, text) => { click($("#" + id)); await wait(10); const li = $$("#" + id + "-list li").find((x) => x.textContent.includes(text)); click(li); await wait(30); };
  return { w, $, $$, click, input, pick, wait, store, projs, settings, errors, calls, sample };
}

module.exports = { JSDOM, boot };
