const test = require("node:test");
const assert = require("node:assert");
require("fake-indexeddb/auto");

// The browser modules attach to window; point it at the Node global.
globalThis.window = globalThis;
globalThis.localStorage = (() => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; })();
require("../public/static/store.js");
require("../public/static/remote-store.js");

let n = 0;
const fresh = (fetch) => window.MBSRemoteStore.create("t" + ++n, { fetch });
const res = (data, status = 200) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => data, blob: async () => new Blob(["x"]) });

test("there is no sync layer: no ready, no status events, no outbox, no flush", () => {
  const s = fresh(async () => res({}));
  for (const k of ["ready", "onStatus", "status", "flush", "outboxAll"]) assert.strictEqual(s[k], undefined, k);
});

test("putProject sends the base version and overwrite flag, and takes the new version from the reply", async () => {
  const calls = [];
  const s = fresh(async (url, o) => { calls.push([o.method, url, JSON.parse(o.body)]); return res({ serverAt: 5, version: 4 }); });
  const p = s.newProject("A");
  p.version = 3; p.serverAt = 1;
  await s.putProject(p);
  assert.strictEqual(calls[0][0], "PUT");
  assert.strictEqual(calls[0][2].baseVersion, 3);
  assert.strictEqual(calls[0][2].overwrite, false);
  assert.ok(!("version" in calls[0][2]) && !("serverAt" in calls[0][2]), "server-owned fields are not sent");
  assert.strictEqual(p.version, 4);
  await s.putProject(p, { overwrite: true });
  assert.strictEqual(calls[1][2].overwrite, true);
  assert.strictEqual(calls[1][2].baseVersion, 4);
});

test("a new project is sent with baseVersion 0", async () => {
  let body;
  const s = fresh(async (url, o) => { body = JSON.parse(o.body); return res({ serverAt: 5, version: 1 }); });
  const p = s.newProject("A");
  await s.putProject(p);
  assert.strictEqual(body.baseVersion, 0);
  assert.strictEqual(p.version, 1);
});

test("409 throws with status 409 and the current version; the project keeps its own version", async () => {
  const s = fresh(async () => res({ error: "This project changed elsewhere.", version: 9 }, 409));
  const p = s.newProject("A");
  p.version = 2;
  await assert.rejects(s.putProject(p), (e) => e.status === 409 && e.version === 9 && /changed elsewhere/.test(e.message));
  assert.strictEqual(p.version, 2);
});

test("failures throw with a status: network 0, signed out 401, too large 413, other from the body", async () => {
  const net = fresh(async () => { throw new TypeError("offline"); });
  await assert.rejects(net.putProject(net.newProject("A")), (e) => e.status === 0 && /server/.test(e.message));
  const out = fresh(async () => res({ error: "Not signed in." }, 401));
  await assert.rejects(out.putProject(out.newProject("A")), (e) => e.status === 401 && /signed out/.test(e.message));
  const big = fresh(async () => res({ error: "Project is too large." }, 413));
  await assert.rejects(big.putProject(big.newProject("A")), (e) => e.status === 413);
  const odd = fresh(async () => res({ error: "Storage error." }, 500));
  await assert.rejects(odd.listProjects(), (e) => e.status === 500 && e.message === "Storage error.");
});

test("every request goes to the server (no cache): the list is summaries, getProject loads the whole project each time", async () => {
  const calls = [];
  const s = fresh(async (url, o) => { calls.push([o.method, url, o.headers["X-MBS"], o.credentials]); return url === "/api/projects" ? res({ projects: [{ id: "a", name: "A", version: 2 }] }) : res({ id: "a", text: "full", version: 2 }); });
  assert.deepStrictEqual(await s.listProjects(), [{ id: "a", name: "A", version: 2 }]);
  assert.strictEqual((await s.getProject("a")).text, "full");
  await s.getProject("a");
  assert.strictEqual(calls.filter((c) => c[1] === "/api/projects/a").length, 2, "no local copy answers the second read");
  assert.ok(calls.every((c) => c[2] === "1" && c[3] === "same-origin"));
});

test("getProject returns undefined for a project that is gone", async () => {
  const s = fresh(async () => res({ error: "Not found." }, 404));
  assert.strictEqual(await s.getProject("zz"), undefined);
});

test("patchProject sends only the given fields", async () => {
  let call;
  const s = fresh(async (url, o) => { call = [o.method, url, JSON.parse(o.body)]; return res({ version: 6, serverAt: 1 }); });
  assert.deepStrictEqual(await s.patchProject("a", { name: "New" }), { version: 6, serverAt: 1 });
  assert.deepStrictEqual(call, ["PATCH", "/api/projects/a", { name: "New" }]);
});

test("audio: upload throws when refused (nothing is queued), delete treats 404 as done, read returns undefined when missing", async () => {
  let status = 500;
  const s = fresh(async () => res({ error: "no" }, status));
  await assert.rejects(s.putAudio("a", 1, new Blob(["x"], { type: "audio/mpeg" })), (e) => e.status === 500);
  assert.strictEqual(await s.getAudio("a", 1), undefined);
  status = 404;
  await s.deleteAudio("a", 1);
  await s.deleteProject("a");
  await s.deleteFolder("f");
});
