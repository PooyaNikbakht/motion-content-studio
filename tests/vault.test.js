const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const V = require("../public/static/vault.js");

const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m }; };
const res = (status, body) => ({ ok: status < 400, status, json: async () => body });

test("the demo template exists, is short, fictional and free of Persian text", () => {
  const t = V.DEMO_TEMPLATE;
  assert.match(t, /^DEMO TEMPLATE \(fictional\)/);
  assert.ok(t.split("\n").length >= 20 && t.split("\n").length <= 40);
  assert.ok(t.length < 2000);
  assert.ok(!/[؀-ۿ]/.test(t), "no Persian master prompt in the public template");
  ["Script chunks", "16:9", "Flow", "Thumbnail", "Reel 01", "Reel Cover Prompt"].forEach((w) => assert.ok(t.includes(w), w));
});

test("no file under public/ or src/ ships a long Persian block besides the sample and the format guide", () => {
  const skip = /sample-conversation|format-template|\/format\//;
  const bad = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|html|txt|md|css)$/.test(e.name) && !skip.test(p)) {
        const long = (fs.readFileSync(p, "utf8").match(/[؀-ۿ\s]{400,}/g) || []).length;
        if (long) bad.push(p);
      }
    }
  })(path.join(__dirname, ".."));
  const roots = bad.filter((p) => /\/(public|src)\//.test(p) && !/node_modules/.test(p));
  assert.deepEqual(roots, []);
});

test("demo: no server calls, edits stay in storage", async () => {
  const storage = mem();
  const v = V.create({ demo: true, prefix: "mbs_demo", storage, fetch: () => { throw new Error("no calls in the demo"); } });
  const a = await v.load();
  assert.equal(a.state.text, V.DEMO_TEMPLATE);
  await v.save({ text: "mine", defaultText: V.DEMO_TEMPLATE });
  assert.equal((await v.load()).state.text, "mine");
  assert.ok(storage.m.has("mbs_demo:director"));
});

test("app: first run is empty, save goes to the server, nothing is kept on this device", async () => {
  const storage = mem(), calls = [];
  let online = true;
  const f = async (url, o) => {
    calls.push([o.method, url, o.headers["X-MBS"] || ""]);
    if (!online) throw new TypeError("offline");
    return o.method === "GET" ? res(200, { text: "", defaultText: "", updatedAt: 0 }) : res(200, { updatedAt: 42 });
  };
  const v = V.create({ demo: false, prefix: "mbs_app", storage, fetch: f });
  assert.deepEqual((await v.load()).state, { text: "", defaultText: "", updatedAt: 0 });
  const saved = await v.save({ text: "hello", defaultText: "hello" });
  assert.equal(saved.updatedAt, 42);
  assert.deepEqual(calls.at(-1), ["PUT", "/api/settings/director-prompt", "1"]);
  assert.equal(storage.m.size, 0, "no device copy of the prompt");
  online = false;
  await assert.rejects(v.load(), /could not be reached/, "a failed load throws instead of showing an empty prompt");
  await assert.rejects(v.save({ text: "edited", defaultText: "hello" }), /Not saved/);
  assert.equal(storage.m.size, 0);
  online = true;
  assert.equal((await v.load()).state.text, "", "the server copy is what loads");
});

test("app: a refused load (401, 500) throws with a reason", async () => {
  const v = V.create({ demo: false, prefix: "x", storage: mem(), fetch: async () => res(401, {}) });
  await assert.rejects(v.load(), /signed out/i);
  const w = V.create({ demo: false, prefix: "x", storage: mem(), fetch: async () => res(500, {}) });
  await assert.rejects(w.load(), /500/);
});

test("save rejects a prompt over 100 KB before any request", async () => {
  const v = V.create({ demo: false, prefix: "x", storage: mem(), fetch: () => { throw new Error("no request"); } });
  await assert.rejects(v.save({ text: "x".repeat(100 * 1024 + 1), defaultText: "" }), /100 KB/);
});
