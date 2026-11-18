import test from "node:test";
import assert from "node:assert/strict";
import { handleApi } from "../src/api.js";
import { makeEnv, req, project, ORIGIN, sessionCookie } from "./api-helpers.mjs";

const call = (env, r) => handleApi(r, env, new URL(r.url));
// Most tests are not about versions: they overwrite. The version tests send baseVersion themselves (putRaw).
const putRaw = (env, id, body) => req("PUT", "/api/projects/" + id, { body }).then((r) => call(env, r));
const put = (env, id, p) => putRaw(env, id, Object.assign({ overwrite: true }, p || project(id)));

test("signed out: 401 JSON on every method, no redirect", async () => {
  const { env } = makeEnv();
  for (const [m, p] of [["GET", "/api/projects"], ["PUT", "/api/projects/a"], ["DELETE", "/api/folders/f"], ["GET", "/api/projects/a/audio/1"]]) {
    const res = await call(env, await req(m, p, { cookie: false }));
    assert.equal(res.status, 401, m + p);
    assert.match(res.headers.get("Content-Type"), /application\/json/);
    assert.equal(res.headers.get("Location"), null);
  }
  const bad = await call(env, await req("GET", "/api/projects", { cookie: "mbs_session=v2.9999999999.1.forged" }));
  assert.equal(bad.status, 401);
});

test("responses are private and no-store", async () => {
  const { env } = makeEnv();
  const res = await call(env, await req("GET", "/api/projects"));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Cache-Control"), "private, no-store");
  assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
});

test("rate limit: 429 when the limiter says no, keyed by CF-Connecting-IP; works without the binding", async () => {
  const m = makeEnv();
  m.limit.allow = false;
  const res = await call(m.env, await req("GET", "/api/projects", { headers: { "CF-Connecting-IP": "1.2.3.4" } }));
  assert.equal(res.status, 429);
  assert.ok(res.headers.get("Retry-After"));
  assert.deepEqual(m.limit.calls, [{ key: "1.2.3.4" }]);
  const none = makeEnv({ noLimiter: true });
  assert.equal((await call(none.env, await req("GET", "/api/projects"))).status, 200);
});

test("writes need the same Origin and X-MBS: 1, else 403", async () => {
  const { env, projects } = makeEnv();
  for (const o of [{ origin: false }, { origin: "https://evil.test" }, { mbs: false }]) {
    const res = await call(env, await req("PUT", "/api/projects/a", { body: project("a"), ...o }));
    assert.equal(res.status, 403, JSON.stringify(o));
  }
  assert.equal((await call(env, await req("DELETE", "/api/projects/a", { mbs: false }))).status, 403);
  assert.equal(projects.size, 0);
  assert.equal((await put(env, "a")).status, 200);
});

test("JSON size and type guards: 413 over 1.9MB and over field caps, 415 for the wrong type, 400 for junk", async () => {
  const { env } = makeEnv();
  const huge = await call(env, await req("PUT", "/api/projects/a", { body: "x".repeat(2 * 1024 * 1024), headers: { "Content-Type": "application/json" } }));
  assert.equal(huge.status, 413);
  assert.equal((await put(env, "a", project("a", { text: "x".repeat(900 * 1024 + 1) }))).status, 413);
  assert.equal((await put(env, "a", project("a", { text: "x".repeat(900 * 1024) }))).status, 200, "a long AI Director run fits");
  assert.equal((await put(env, "a", project("a", { parsed: { blob: "x".repeat(700 * 1024) } }))).status, 413);
  assert.equal((await put(env, "a", project("a", { info: { notes: "x".repeat(200 * 1024) } }))).status, 413);
  assert.equal((await call(env, await req("PUT", "/api/projects/a", { body: JSON.stringify(project("a")), headers: { "Content-Type": "text/plain" } }))).status, 415);
  assert.equal((await call(env, await req("PUT", "/api/projects/a", { body: "{nope", headers: { "Content-Type": "application/json" } }))).status, 400);
  assert.equal((await put(env, "a", project("b"))).status, 400, "id mismatch");
  assert.equal((await put(env, "a", project("a", { status: "weird" }))).status, 400);
});

test("PUT is a full, idempotent replace and GET returns it", async () => {
  const { env, projects } = makeEnv();
  const p = project("a", { text: "one", info: { title: "T" }, status: "ready", progress: { 1: { image: true } } });
  const r1 = await put(env, "a", p);
  const r2 = await put(env, "a", p);
  assert.equal(r1.status, 200); assert.equal(r2.status, 200);
  assert.ok((await r1.json()).serverAt > 0);
  assert.equal(projects.size, 1);
  await put(env, "a", project("a", { text: "two" }));
  const got = await (await call(env, await req("GET", "/api/projects/a"))).json();
  assert.equal(got.text, "two");
  assert.deepEqual(got.info, {}, "replaced, not merged");
  assert.equal(got.status, "draft");
  const list = await (await call(env, await req("GET", "/api/projects"))).json();
  assert.deepEqual(Object.keys(list.projects[0]).sort(), ["createdAt", "folderId", "id", "name", "serverAt", "status", "updatedAt", "version"]);
  assert.equal((await call(env, await req("GET", "/api/projects/missing"))).status, 404);
});

test("audio: key regex, content type, size and project must exist", async () => {
  const m = makeEnv();
  const { env } = m;
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const a = (key, o) => req("PUT", "/api/projects/a/audio/" + key, { body: bytes, headers: { "Content-Type": "audio/mpeg" }, ...o }).then((r) => call(env, r));
  assert.equal((await a("1")).status, 404, "unknown project");
  await put(env, "a");
  for (const bad of ["abc", "12345", "reel:", "reel:a b", "../x", "1.mp3", "reel:" + "x".repeat(41)]) assert.equal((await a(encodeURIComponent(bad))).status, 400, bad);
  assert.equal((await a("1")).status, 200);
  assert.equal((await a(encodeURIComponent("reel:3-b"))).status, 200);
  assert.deepEqual([...m.objects.keys()].sort(), ["audio/a/1.mp3", "audio/a/reel-3-b.mp3"]);
  for (const type of ["text/plain", "application/json", ""]) {
    const r = await call(env, await req("PUT", "/api/projects/a/audio/2", { body: bytes, headers: type ? { "Content-Type": type } : {} }));
    assert.equal(r.status, 415, type);
  }
  const big = await call(env, await req("PUT", "/api/projects/a/audio/2", { body: new Uint8Array(1), headers: { "Content-Type": "audio/wav", "Content-Length": String(8 * 1024 * 1024 + 1) } }));
  assert.equal(big.status, 413);
  const noLen = new Request(ORIGIN + "/api/projects/a/audio/2", { method: "PUT", headers: { Cookie: (await req("GET", "/")).headers.get("Cookie"), Origin: ORIGIN, "X-MBS": "1", "Content-Type": "audio/mpeg" }, body: bytes });
  assert.equal((await call(env, noLen)).status, 411);
  const wav = await call(env, await req("PUT", "/api/projects/a/audio/2", { body: bytes, headers: { "Content-Type": "audio/wav" } }));
  assert.equal(wav.status, 200);
  const got = await call(env, await req("GET", "/api/projects/a/audio/2"));
  assert.equal(got.headers.get("Content-Type"), "audio/wav");
  assert.deepEqual([...new Uint8Array(await got.arrayBuffer())], [1, 2, 3, 4]);
  assert.equal((await call(env, await req("GET", "/api/projects/a/audio/9"))).status, 404);
});

test("replacing audio with another format removes the old object; DELETE audio is idempotent", async () => {
  const m = makeEnv();
  await put(m.env, "a");
  const up = (type) => req("PUT", "/api/projects/a/audio/1", { body: new Uint8Array([9]), headers: { "Content-Type": type } }).then((r) => call(m.env, r));
  await up("audio/mpeg"); await up("audio/wav");
  assert.deepEqual([...m.objects.keys()], ["audio/a/1.wav"]);
  assert.equal((await call(m.env, await req("DELETE", "/api/projects/a/audio/1"))).status, 204);
  assert.equal((await call(m.env, await req("DELETE", "/api/projects/a/audio/1"))).status, 204);
  assert.equal(m.objects.size, 0);
});

test("deleting a folder moves its projects to the top level and never deletes them", async () => {
  const { env, projects, folders } = makeEnv();
  const f = await call(env, await req("PUT", "/api/folders/f1", { body: { id: "f1", name: "F", collapsed: false, createdAt: 1 } }));
  assert.equal(f.status, 200);
  await put(env, "a", project("a", { folderId: "f1" }));
  await put(env, "b", project("b", { folderId: "f1" }));
  await put(env, "c", project("c"));
  assert.equal((await (await call(env, await req("GET", "/api/folders"))).json()).folders.length, 1);
  assert.equal((await call(env, await req("DELETE", "/api/folders/f1"))).status, 204);
  assert.equal(folders.size, 0);
  assert.deepEqual([...projects.values()].map((p) => p.folder_id), [null, null, null]);
  assert.equal(projects.size, 3);
  assert.equal((await call(env, await req("DELETE", "/api/folders/f1"))).status, 204, "missing is fine");
});

test("deleting a project removes its D1 rows and every R2 object under its prefix, and nothing else", async () => {
  const m = makeEnv();
  await put(m.env, "a"); await put(m.env, "b");
  for (const [id, key] of [["a", "1"], ["a", "reel:2"], ["b", "1"]]) {
    await call(m.env, await req("PUT", `/api/projects/${id}/audio/${encodeURIComponent(key)}`, { body: new Uint8Array([1]), headers: { "Content-Type": "audio/mpeg" } }));
  }
  assert.equal(m.objects.size, 3);
  assert.equal((await call(m.env, await req("DELETE", "/api/projects/a"))).status, 204);
  assert.deepEqual([...m.objects.keys()], ["audio/b/1.mp3"]);
  assert.deepEqual([...m.audio.keys()], ["b|1"]);
  assert.deepEqual([...m.projects.keys()], ["b"]);
  assert.equal((await call(m.env, await req("DELETE", "/api/projects/a"))).status, 204, "missing is fine");
});

test("unknown paths and methods", async () => {
  const { env } = makeEnv();
  assert.equal((await call(env, await req("GET", "/api/nope"))).status, 404);
  assert.equal((await call(env, await req("POST", "/api/projects"))).status, 405);
  assert.equal((await call(env, await req("GET", "/api/projects/bad%20id"))).status, 400);
});

test("ext (queue, history, media index, settings-free catch-all) round-trips through state_json", async () => {
  const { env } = makeEnv();
  const ext = { queue: { id: "q1", phases: ["main", "reels", "export"], phase: "main", failed: [3], startedAt: 5, lock: { tab: "t", beat: 9 } }, startPhrase: "Hi", history: [{ at: 1 }], media: { "s:1": { name: "01.png", bytes: 10 } } };
  await put(env, "a", project("a", { ext }));
  const got = await (await call(env, await req("GET", "/api/projects/a"))).json();
  assert.deepEqual(got.ext, ext);
  assert.equal((await put(env, "a", project("a", { ext: [] }))).status, 400, "ext must be an object");
});

test("settings/director-prompt: 401 signed out, 403 without origin or X-MBS, 413 over 100 KB, 405 on DELETE", async () => {
  const { env } = makeEnv();
  const P = "/api/settings/director-prompt";
  assert.equal((await call(env, await req("GET", P, { cookie: false }))).status, 401);
  assert.equal((await call(env, await req("PUT", P, { body: { text: "x" }, mbs: false }))).status, 403);
  assert.equal((await call(env, await req("PUT", P, { body: { text: "x" }, origin: "https://evil.test" }))).status, 403);
  assert.equal((await call(env, await req("PUT", P, { body: { text: "x".repeat(100 * 1024 + 1) } }))).status, 413);
  assert.equal((await call(env, await req("PUT", P, { body: { text: "x", defaultText: "y".repeat(100 * 1024 + 1) } }))).status, 413);
  assert.equal((await call(env, await req("PUT", P, { body: { text: 5 } }))).status, 400);
  assert.equal((await call(env, await req("DELETE", P))).status, 405);
  assert.equal((await call(env, await req("GET", "/api/settings/other"))).status, 404);
});

test("settings/director-prompt: empty before the first save, then a round trip with the default kept", async () => {
  const { env } = makeEnv();
  const P = "/api/settings/director-prompt";
  assert.deepEqual(await (await call(env, await req("GET", P))).json(), { text: "", defaultText: "", updatedAt: 0 });
  const r = await call(env, await req("PUT", P, { body: { text: "پرامپت من\nline 2", defaultText: "پرامپت من" } }));
  assert.equal(r.status, 200);
  const at = (await r.json()).updatedAt;
  const got = await (await call(env, await req("GET", P))).json();
  assert.deepEqual(got, { text: "پرامپت من\nline 2", defaultText: "پرامپت من", updatedAt: at });
  assert.equal((await call(env, await req("GET", P))).headers.get("Cache-Control"), "private, no-store");
});

// ---------- media routes ----------
const bin = (n) => new Uint8Array(n).fill(7);
const putFile = (env, id, key, type, bytes, extra = {}) => req("PUT", "/api/projects/" + id + "/media/" + key, { body: bytes, headers: Object.assign({ "Content-Type": type }, extra) }).then((r) => call(env, r));

test("media: signed out is 401, a cross-origin write is 403", async () => {
  const { env } = makeEnv();
  assert.equal((await call(env, await req("GET", "/api/projects/a/media", { cookie: false }))).status, 401);
  assert.equal((await call(env, await req("PUT", "/api/projects/a/media/s-1-image", { body: bin(4), headers: { "Content-Type": "image/png" }, origin: "https://evil.test" }))).status, 403);
  assert.equal((await call(env, await req("PUT", "/api/projects/a/thumb/s-1-image", { body: bin(4), headers: { "Content-Type": "image/webp" }, mbs: false }))).status, 403);
});

test("media: content type allowlist, size cap, key pattern, project must exist", async () => {
  const { env } = makeEnv();
  await put(env, "a", project("a"));
  assert.equal((await putFile(env, "a", "s-1-image", "image/gif", bin(10))).status, 415);
  assert.equal((await putFile(env, "a", "s-1-image", "application/pdf", bin(10))).status, 415);
  assert.equal((await putFile(env, "a", "s-1-image", "image/svg+xml", bin(10))).status, 415);
  const big = await call(env, new Request("https://studio.test/api/projects/a/media/s-1-video", { method: "PUT", headers: { Cookie: await (await import("./api-helpers.mjs")).sessionCookie(), Origin: ORIGIN, "X-MBS": "1", "Content-Type": "video/mp4", "Content-Length": String(100000001) }, body: "x" }));
  assert.equal(big.status, 413);
  assert.match((await big.json()).error, /over 100 MB \(the limit is 100,000,000 bytes\)/);
  assert.equal((await putFile(env, "a", "BAD_KEY", "image/png", bin(10))).status, 400);
  assert.equal((await putFile(env, "missing", "s-1-image", "image/png", bin(10))).status, 404);
  assert.equal((await call(env, await req("PUT", "/api/projects/a/media/s-1-image", { body: bin(0), headers: { "Content-Type": "image/png" } }))).status, 400);
  assert.equal((await call(env, await req("POST", "/api/projects/a/media/s-1-image"))).status, 405);
  assert.equal((await call(env, await req("DELETE", "/api/projects/a/thumb/s-1-image"))).status, 405);
});

test("media: round trip, thumbnail, list, replace, delete; originals and thumbs live under media/", async () => {
  const { env, objects } = makeEnv();
  await put(env, "a", project("a"));
  const r = await putFile(env, "a", "s-1-image", "image/png", bin(100), { "X-Name": encodeURIComponent("03 My Shot.png") });
  assert.equal(r.status, 200);
  const info = await r.json();
  assert.equal(info.bytes, 100); assert.equal(info.overSoftCap, false);
  assert.ok(objects.has("media/a/s-1-image"));
  assert.equal((await call(env, await req("PUT", "/api/projects/a/thumb/s-9-image", { body: bin(5), headers: { "Content-Type": "image/webp" } }))).status, 404, "thumbnail needs its original");
  assert.equal((await call(env, await req("PUT", "/api/projects/a/thumb/s-1-image", { body: bin(30), headers: { "Content-Type": "image/webp" } }))).status, 200);
  assert.equal((await call(env, await req("PUT", "/api/projects/a/thumb/s-1-image", { body: bin(30), headers: { "Content-Type": "video/mp4" } }))).status, 415);
  assert.ok(objects.has("media/a/thumb/s-1-image"));
  const got = await call(env, await req("GET", "/api/projects/a/media/s-1-image"));
  assert.equal(got.status, 200);
  assert.equal(got.headers.get("Content-Type"), "image/png");
  assert.equal(got.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(got.headers.get("Cache-Control"), "private, no-cache");
  assert.match(got.headers.get("Content-Disposition"), /^inline; filename="03 My Shot.png"/);
  assert.equal((await got.arrayBuffer()).byteLength, 100);
  const th = await call(env, await req("GET", "/api/projects/a/thumb/s-1-image"));
  assert.equal(th.headers.get("Content-Type"), "image/webp");
  await putFile(env, "a", "r-1-video-1", "video/mp4", bin(50));
  const list = await (await call(env, await req("GET", "/api/projects/a/media"))).json();
  assert.deepEqual(list.media.map((m) => [m.key, m.name, m.type, m.bytes, m.thumbBytes]), [["r-1-video-1", "r-1-video-1", "video/mp4", 50, 0], ["s-1-image", "03 My Shot.png", "image/png", 100, 30]]);
  const again = await (await putFile(env, "a", "s-1-image", "image/jpeg", bin(60))).json();
  assert.equal(again.projectBytes, 110, "replacing counts the new size, not both");
  assert.equal((await (await call(env, await req("GET", "/api/projects/a/media"))).json()).media.length, 2);
  assert.equal((await call(env, await req("DELETE", "/api/projects/a/media/s-1-image"))).status, 204);
  assert.ok(!objects.has("media/a/s-1-image") && !objects.has("media/a/thumb/s-1-image"));
  assert.equal((await call(env, await req("GET", "/api/projects/a/media/s-1-image"))).status, 404);
});

test("media: 200 files per project, a replace is not a new file", async () => {
  const { env, media } = makeEnv();
  await put(env, "a", project("a"));
  for (let i = 0; i < 200; i++) media.set("a|s-" + (i + 1) + "-image", { project_id: "a", key: "s-" + (i + 1) + "-image", bytes: 1, r2_key: "x" });
  assert.equal((await putFile(env, "a", "s-500-image", "image/png", bin(5))).status, 409);
  assert.equal((await putFile(env, "a", "s-1-image", "image/png", bin(5))).status, 200);
});

test("media: the response warns above the per-project soft cap", async () => {
  const { env, media } = makeEnv();
  await put(env, "a", project("a"));
  media.set("a|s-1-video", { project_id: "a", key: "s-1-video", bytes: 2 * 1024 * 1024 * 1024, r2_key: "x" });
  const r = await (await putFile(env, "a", "s-2-image", "image/png", bin(10))).json();
  assert.equal(r.overSoftCap, true);
});

test("media: deleting a project removes its media objects and rows", async () => {
  const { env, objects, media } = makeEnv();
  await put(env, "a", project("a")); await put(env, "b", project("b"));
  await putFile(env, "a", "s-1-image", "image/png", bin(10));
  await putFile(env, "b", "s-1-image", "image/png", bin(10));
  await call(env, await req("PUT", "/api/projects/a/thumb/s-1-image", { body: bin(3), headers: { "Content-Type": "image/webp" } }));
  assert.equal((await call(env, await req("DELETE", "/api/projects/a"))).status, 204);
  assert.deepEqual([...objects.keys()].filter((k) => k.startsWith("media/a/")), []);
  assert.ok(objects.has("media/b/s-1-image"));
  assert.deepEqual([...media.keys()], ["b|s-1-image"]);
});

test("storage: totals for the meter, with the shared 10 GB allowance", async () => {
  const { env } = makeEnv();
  await put(env, "a", project("a"));
  await putFile(env, "a", "s-1-image", "image/png", bin(100));
  await call(env, await req("PUT", "/api/projects/a/thumb/s-1-image", { body: bin(20), headers: { "Content-Type": "image/webp" } }));
  const u = await (await call(env, await req("GET", "/api/storage"))).json();
  assert.equal(u.mediaBytes, 100); assert.equal(u.thumbBytes, 20); assert.equal(u.usedBytes, 120); assert.equal(u.files, 1);
  assert.equal(u.allowanceBytes, 10 * 1024 * 1024 * 1024);
  assert.equal((await call(env, await req("GET", "/api/storage", { cookie: false }))).status, 401);
  assert.equal((await call(env, await req("PUT", "/api/storage", { body: {} }))).status, 405);
});

// ---------- per-card media slots: streaming, Range, ETag, download name, size enforcement, cleanup ----------
const ramp = (n) => Uint8Array.from({ length: n }, (_, i) => i % 251);
const get = async (env, path, headers = {}) => call(env, await req("GET", path, { headers }));

test("media GET: Range returns 206 with Content-Range, suffix and open ranges work, 416 when unsatisfiable", async () => {
  const { env } = makeEnv();
  await put(env, "a", project("a"));
  await putFile(env, "a", "s-1-video", "video/mp4", ramp(1000), { "X-Name": encodeURIComponent("clip.mp4") });
  const full = await get(env, "/api/projects/a/media/s-1-video");
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("Accept-Ranges"), "bytes");
  assert.equal(full.headers.get("Content-Length"), "1000");
  assert.equal(full.headers.get("Content-Type"), "video/mp4");
  assert.match(full.headers.get("ETag"), /^"m/);
  const r1 = await get(env, "/api/projects/a/media/s-1-video", { Range: "bytes=10-19" });
  assert.equal(r1.status, 206);
  assert.equal(r1.headers.get("Content-Range"), "bytes 10-19/1000");
  assert.equal(r1.headers.get("Content-Length"), "10");
  assert.deepEqual([...new Uint8Array(await r1.arrayBuffer())], [...ramp(1000).slice(10, 20)]);
  const open = await get(env, "/api/projects/a/media/s-1-video", { Range: "bytes=990-" });
  assert.equal(open.headers.get("Content-Range"), "bytes 990-999/1000");
  const suffix = await get(env, "/api/projects/a/media/s-1-video", { Range: "bytes=-5" });
  assert.equal(suffix.headers.get("Content-Range"), "bytes 995-999/1000");
  const clamped = await get(env, "/api/projects/a/media/s-1-video", { Range: "bytes=900-5000" });
  assert.equal(clamped.headers.get("Content-Range"), "bytes 900-999/1000");
  const bad = await get(env, "/api/projects/a/media/s-1-video", { Range: "bytes=1000-1100" });
  assert.equal(bad.status, 416);
  assert.equal(bad.headers.get("Content-Range"), "bytes */1000");
  assert.equal((await get(env, "/api/projects/a/media/s-1-video", { Range: "bytes=0-1,5-6" })).status, 200, "several ranges: the whole file");
  assert.equal((await get(env, "/api/projects/a/media/s-1-video", { Range: "garbage" })).status, 200);
});

test("media GET: ETag gives 304, If-Range with an old tag sends the whole file, replacing changes the tag", async () => {
  const { env } = makeEnv();
  await put(env, "a", project("a"));
  await putFile(env, "a", "s-1-video", "video/mp4", ramp(500));
  const etag = (await get(env, "/api/projects/a/media/s-1-video")).headers.get("ETag");
  const nm = await get(env, "/api/projects/a/media/s-1-video", { "If-None-Match": etag });
  assert.equal(nm.status, 304);
  assert.equal(nm.headers.get("Cache-Control"), "private, no-cache");
  const same = await get(env, "/api/projects/a/media/s-1-video", { Range: "bytes=0-9", "If-Range": etag });
  assert.equal(same.status, 206);
  const stale = await get(env, "/api/projects/a/media/s-1-video", { Range: "bytes=0-9", "If-Range": '"old"' });
  assert.equal(stale.status, 200);
  assert.equal((await stale.arrayBuffer()).byteLength, 500);
  await putFile(env, "a", "s-1-video", "video/mp4", ramp(700));
  assert.notEqual((await get(env, "/api/projects/a/media/s-1-video")).headers.get("ETag"), etag);
});

test("media GET: the download name keeps the original file name (ASCII fallback plus UTF-8)", async () => {
  const { env } = makeEnv();
  await put(env, "a", project("a"));
  await putFile(env, "a", "s-1-image", "image/png", bin(20), { "X-Name": encodeURIComponent('Scène "1" é.png') });
  const inline = await get(env, "/api/projects/a/media/s-1-image");
  assert.match(inline.headers.get("Content-Disposition"), /^inline; filename="Sc_ne _1_ _\.png"; filename\*=UTF-8''Sc%C3%A8ne%20%221%22%20%C3%A9\.png$/);
  const dl = await get(env, "/api/projects/a/media/s-1-image?download=1");
  assert.match(dl.headers.get("Content-Disposition"), /^attachment; /);
  assert.equal(dl.headers.get("Content-Type"), "image/png", "type comes from the stored metadata");
});

test("media PUT: 413 above 100,000,000 bytes by Content-Length, 413 when the body is longer than declared, 400 when shorter, nothing stored", async () => {
  const { env, objects, media } = makeEnv();
  await put(env, "a", project("a"));
  const raw = async (len, body, type = "image/png") => call(env, new Request("https://studio.test/api/projects/a/media/s-1-image", { method: "PUT", headers: { Cookie: await sessionCookie(), Origin: ORIGIN, "X-MBS": "1", "Content-Type": type, "Content-Length": String(len) }, body }));
  assert.equal((await raw(100000001, "x")).status, 413);
  assert.equal((await raw(10, bin(50))).status, 413);
  assert.equal((await raw(50, bin(10))).status, 400);
  assert.equal((await raw(10, bin(10), "video/quicktime")).status, 415);
  assert.deepEqual([...objects.keys()], []);
  assert.equal(media.size, 0);
  assert.equal((await raw(10, bin(10))).status, 200, "an honest upload still works");
});

test("media PUT: a file of exactly 100,000,000 bytes is accepted by the header check (streamed, never buffered by the handler)", async () => {
  const { env } = makeEnv();
  await put(env, "a", project("a"));
  const len = 100000000;
  const r = await call(env, new Request("https://studio.test/api/projects/a/media/s-1-video", { method: "PUT", headers: { Cookie: await sessionCookie(), Origin: ORIGIN, "X-MBS": "1", "Content-Type": "video/mp4", "Content-Length": String(len) }, body: new Uint8Array(len) }));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).bytes, len);
});

test("media PUT: the response carries account usage and warns near the shared 10 GB allowance", async () => {
  const { env, media } = makeEnv();
  await put(env, "a", project("a"));
  const first = await (await putFile(env, "a", "s-1-image", "image/png", bin(10))).json();
  assert.equal(first.nearAllowance, false);
  assert.equal(first.allowanceBytes, 10 * 1024 * 1024 * 1024);
  media.set("b|s-1-video", { project_id: "b", key: "s-1-video", bytes: 8.5 * 1024 * 1024 * 1024, r2_key: "x", thumb_bytes: 0 });
  const second = await (await putFile(env, "a", "s-2-image", "image/png", bin(10))).json();
  assert.equal(second.nearAllowance, true);
  assert.ok(second.usedBytes > 8 * 1024 * 1024 * 1024);
});

test("media: keys with the app's random suffix are valid, six groups are not", async () => {
  const { env } = makeEnv();
  await put(env, "a", project("a"));
  assert.equal((await putFile(env, "a", "r-1-image-2-k3j9d", "image/png", bin(4))).status, 200);
  assert.equal((await putFile(env, "a", "r-1-image-2-k3j9d-zz", "image/png", bin(4))).status, 400);
});

test("media-cleanup: removes the listed files of this project only, with their thumbnails, and reports the bytes", async () => {
  const { env, objects, media } = makeEnv();
  await put(env, "a", project("a")); await put(env, "b", project("b"));
  await putFile(env, "a", "s-1-image", "image/png", bin(100));
  await putFile(env, "a", "s-2-image", "image/png", bin(40));
  await putFile(env, "b", "s-1-image", "image/png", bin(10));
  await call(env, await req("PUT", "/api/projects/a/thumb/s-1-image", { body: bin(5), headers: { "Content-Type": "image/webp" } }));
  const post = (body, p = "/api/projects/a/media-cleanup") => req("POST", p, { body }).then((r) => call(env, r));
  assert.equal((await post({ keys: "s-1-image" })).status, 400);
  assert.equal((await post({ keys: ["BAD KEY"] })).status, 400);
  assert.equal((await post({ keys: Array.from({ length: 201 }, (_, i) => "s-" + i) })).status, 400);
  const r = await (await post({ keys: ["s-1-image", "s-1-image", "s-9-image"] })).json();
  assert.deepEqual(r, { removed: 1, bytes: 100 });
  assert.ok(!objects.has("media/a/s-1-image") && !objects.has("media/a/thumb/s-1-image"));
  assert.ok(objects.has("media/a/s-2-image") && objects.has("media/b/s-1-image"), "other files are untouched");
  assert.deepEqual([...media.keys()].sort(), ["a|s-2-image", "b|s-1-image"]);
  assert.equal((await call(env, await req("GET", "/api/projects/a/media-cleanup"))).status, 405);
  assert.equal((await call(env, await req("POST", "/api/projects/a/media-cleanup", { body: { keys: [] }, mbs: false }))).status, 403);
  assert.equal((await call(env, await req("POST", "/api/projects/a/media-cleanup", { body: { keys: [] }, cookie: false }))).status, 401);
});

test("media DELETE: removes the original, the thumbnail and the row; a second delete is still 204", async () => {
  const { env, objects, media } = makeEnv();
  await put(env, "a", project("a"));
  await putFile(env, "a", "s-1-video", "video/mp4", bin(30));
  await call(env, await req("PUT", "/api/projects/a/thumb/s-1-video", { body: bin(5), headers: { "Content-Type": "image/webp" } }));
  assert.equal((await call(env, await req("DELETE", "/api/projects/a/media/s-1-video"))).status, 204);
  assert.deepEqual([...objects.keys()], []);
  assert.equal(media.size, 0);
  assert.equal((await call(env, await req("DELETE", "/api/projects/a/media/s-1-video"))).status, 204);
});

test("versions: a new project is version 1, a PUT with the current baseVersion bumps it, a stale one gets 409 and changes nothing", async () => {
  const { env, projects } = makeEnv();
  const r1 = await putRaw(env, "a", project("a", { text: "one", baseVersion: 0 }));
  assert.equal(r1.status, 200);
  assert.equal((await r1.json()).version, 1);
  const r2 = await putRaw(env, "a", project("a", { text: "two", baseVersion: 1 }));
  assert.equal((await r2.json()).version, 2);
  const stale = await putRaw(env, "a", project("a", { text: "stale", baseVersion: 1 }));
  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), { error: "This project changed elsewhere.", version: 2 });
  assert.equal(projects.get("a").text, "two", "the stale save changed nothing");
  const none = await putRaw(env, "a", project("a", { text: "no base" }));
  assert.equal(none.status, 409, "an existing project needs a baseVersion");
  assert.equal((await putRaw(env, "a", project("a", { baseVersion: 1.5 }))).status, 400);
  assert.equal((await putRaw(env, "a", project("a", { baseVersion: 2, overwrite: "yes" }))).status, 400);
  const ow = await putRaw(env, "a", project("a", { text: "mine", baseVersion: 1, overwrite: true }));
  assert.equal(ow.status, 200);
  assert.equal((await ow.json()).version, 3, "overwrite ignores the base version and still bumps");
  assert.equal(projects.get("a").text, "mine");
  const got = await (await call(env, await req("GET", "/api/projects/a"))).json();
  assert.equal(got.version, 3);
  const list = await (await call(env, await req("GET", "/api/projects"))).json();
  assert.equal(list.projects[0].version, 3);
});

test("PATCH changes name, folder and status only, bumps the version and leaves the content", async () => {
  const { env, projects } = makeEnv();
  await putRaw(env, "a", project("a", { text: "keep me", baseVersion: 0 }));
  const r = await call(env, await req("PATCH", "/api/projects/a", { body: { name: "Renamed", folderId: "f1" } }));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).version, 2);
  const p = projects.get("a");
  assert.deepEqual([p.name, p.folder_id, p.status, p.text], ["Renamed", "f1", "draft", "keep me"]);
  assert.equal((await call(env, await req("PATCH", "/api/projects/a", { body: { name: " " } }))).status, 400);
  assert.equal((await call(env, await req("PATCH", "/api/projects/a", { body: { status: "x" } }))).status, 400);
  assert.equal((await call(env, await req("PATCH", "/api/projects/zzz", { body: { name: "x" } }))).status, 404);
  const moved = await call(env, await req("PATCH", "/api/projects/a", { body: { folderId: null } }));
  assert.equal((await moved.json()).version, 3);
  assert.equal(projects.get("a").folder_id, null);
  assert.equal((await putRaw(env, "a", project("a", { baseVersion: 1 }))).status, 409, "a save from before the rename is stale");
});
