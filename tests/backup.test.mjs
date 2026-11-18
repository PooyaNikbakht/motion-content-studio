// Daily backup (src/backup.js): D1 dump, retention, incremental media copy, error handling, the status routes and the cron hook.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import { runBackup, applyRetention, STATUS_KEY } from "../src/backup.js";
import { makeEnv, req } from "./api-helpers.mjs";

const NOW = Date.parse("2026-11-18T03:17:00Z");
const DAY = 86400000;
const dayKey = (ms) => "db/" + new Date(ms).toISOString().slice(0, 10) + ".json";

/** R2 stub with list (prefix, cursor, limit), get, put (stream or string), delete; records every call. */
function bucket(initial = {}, { pageSize = 1000, failPut } = {}) {
  const m = new Map(Object.entries(initial).map(([k, v]) => [k, typeof v === "string" ? { bytes: Buffer.from(v), httpMetadata: {} } : v]));
  const calls = { get: [], put: [], delete: [] };
  return {
    m, calls,
    async list({ prefix = "", cursor, limit = 1000 }) {
      const keys = [...m.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0, n = Math.min(limit, pageSize);
      const page = keys.slice(start, start + n);
      return { objects: page.map((key) => ({ key, size: m.get(key).bytes.length })), truncated: start + n < keys.length, cursor: String(start + n) };
    },
    async get(key) {
      calls.get.push(key);
      const o = m.get(key);
      return o ? { body: new Response(o.bytes).body, httpMetadata: o.httpMetadata, text: async () => Buffer.from(o.bytes).toString() } : null;
    },
    async put(key, body, o) {
      if (failPut && failPut(key)) throw new Error("boom with secret-token");
      calls.put.push(key);
      m.set(key, { bytes: Buffer.from(await new Response(body).arrayBuffer()), httpMetadata: (o && o.httpMetadata) || {} });
    },
    async delete(keys) { for (const k of [].concat(keys)) { calls.delete.push(k); m.delete(k); } },
  };
}

/** D1 stub for the dump: sqlite_master, d1_migrations and paged SELECT * from in-memory tables. */
function dbStub(tables, migration = "0006_project_version.sql") {
  return {
    prepare(sql) {
      const s = sql.replace(/\s+/g, " ");
      return {
        a: [], bind(...a) { this.a = a; return this; },
        async all() {
          if (s.includes("FROM sqlite_master")) return { results: [...Object.keys(tables), "d1_migrations"].sort().map((name) => ({ name })) };
          const t = /FROM "(\w+)"/.exec(s)[1];
          return { results: tables[t].slice(this.a[1], this.a[1] + this.a[0]) };
        },
        async first() { return migration ? { name: migration } : null; },
      };
    },
  };
}
const TABLES = () => ({
  projects: Array.from({ length: 120 }, (_, i) => ({ id: "p" + i, name: "Project " + i, text: "it's text" })),
  folders: [{ id: "f1", name: "F" }],
  media: [], shares: [{ token_hash: "h", project_id: "p1" }],
  settings: [{ key: "director-prompt", value: '{"text":"MASTER-PROMPT-SECRET"}', updated_at: 1 }],
  auth: [{ id: 1, hash: "HASH-SECRET", salt: "SALT-SECRET", iterations: 1, epoch: 1 }],
});

test("db dump: every table, paged, valid JSON, schema version, counts; same-day rerun overwrites", async () => {
  const BACKUP = bucket(), env = { DB: dbStub(TABLES()), BACKUP };
  const st = await runBackup(env, NOW);
  assert.equal(st.ok, true);
  const dump = JSON.parse(BACKUP.m.get("db/2026-11-18.json").bytes.toString());
  assert.deepEqual(Object.keys(dump.tables).sort(), ["auth", "folders", "media", "projects", "settings", "shares"]);
  assert.equal(dump.tables.projects.length, 120);
  assert.equal(dump.schemaVersion, "0006_project_version.sql");
  assert.deepEqual(dump.summary, { auth: 1, folders: 1, media: 0, projects: 120, settings: 1, shares: 1 });
  assert.equal(dump.tables.auth[0].hash, "HASH-SECRET");
  assert.equal(dump.tables.settings[0].value.includes("MASTER-PROMPT-SECRET"), true);
  assert.equal(st.db.totalRows, 124);
  await runBackup(env, NOW + 1000);
  assert.equal(BACKUP.calls.put.filter((k) => k === "db/2026-11-18.json").length, 2);
  assert.equal([...BACKUP.m.keys()].filter((k) => k.startsWith("db/")).length, 1);
  const last = JSON.parse(BACKUP.m.get(STATUS_KEY).bytes.toString());
  assert.equal(last.db.tables.projects, 120);
});

test("logs and the status file never contain row contents", async () => {
  const BACKUP = bucket(), logs = [], orig = console.error;
  console.error = (...a) => logs.push(a.join(" "));
  try {
    const bad = dbStub(TABLES()); const p = bad.prepare; bad.prepare = (sql) => { if (sql.includes('"auth"')) throw new Error("fail near HASH-SECRET"); return p(sql); };
    await runBackup({ DB: bad, BACKUP }, NOW);
  } finally { console.error = orig; }
  assert.ok(logs.length > 0);
  for (const l of logs) assert.doesNotMatch(l, /SECRET/);
});

test("retention: deletes db backups older than 30 days, keeps the 7 newest regardless, ignores other keys", async () => {
  const init = { "media/x": "m", "status/last-run.json": "{}" };
  for (let d = 0; d < 40; d++) init[dayKey(NOW - d * DAY)] = "{}";
  const B = bucket(init);
  const r = await applyRetention(B, NOW);
  const left = [...B.m.keys()].filter((k) => k.startsWith("db/")).sort();
  assert.equal(left.length, 31); // today .. 30 days ago
  assert.equal(r.deleted, 9);
  assert.ok(left.includes(dayKey(NOW - 30 * DAY)) && !left.includes(dayKey(NOW - 31 * DAY)));
  assert.ok(B.m.has("media/x") && B.m.has("status/last-run.json"));

  const old = {}; for (let d = 100; d < 110; d++) old[dayKey(NOW - d * DAY)] = "{}";
  const B2 = bucket(old);
  await applyRetention(B2, NOW);
  assert.equal(B2.m.size, 7, "all are old, the 7 newest stay");
  assert.ok(B2.m.has(dayKey(NOW - 100 * DAY)) && !B2.m.has(dayKey(NOW - 107 * DAY)));
});

const audio = (n, size = 3) => Object.fromEntries(Array.from({ length: n }, (_, i) => ["p1/" + i, "x".repeat(size)]));

test("media: copies missing objects under media/, skips ones already there, never deletes", async () => {
  const AUDIO = bucket(audio(5)), BACKUP = bucket({ "media/p1/0": "xxx", "media/gone/in-app": "keep me" });
  const env = { DB: dbStub(TABLES()), AUDIO, BACKUP };
  const st = await runBackup(env, NOW);
  assert.deepEqual(AUDIO.calls.get.sort(), ["p1/1", "p1/2", "p1/3", "p1/4"]);
  assert.equal(st.media.copied, 4);
  assert.equal(st.media.alreadyBacked, 1);
  assert.equal(st.media.remaining, 0);
  assert.equal(BACKUP.m.get("media/p1/3").bytes.toString(), "xxx");
  assert.ok(BACKUP.m.has("media/gone/in-app"), "an object removed from the app stays in the backup");
  assert.equal(BACKUP.calls.delete.filter((k) => k.startsWith("media/")).length, 0);
  const again = await runBackup(env, NOW);
  assert.equal(again.media.copied, 0);
});

test("media: the per-run cap leaves the rest for the next run", async () => {
  const AUDIO = bucket(audio(10)), BACKUP = bucket();
  const env = { DB: dbStub(TABLES()), AUDIO, BACKUP };
  const a = await runBackup(env, NOW, { maxObjects: 4 });
  assert.equal(a.media.copied, 4);
  assert.equal(a.media.remaining, 6);
  const b = await runBackup(env, NOW, { maxObjects: 4 });
  assert.equal(b.media.copied, 4);
  assert.equal(b.media.remaining, 2);
  const c = await runBackup(env, NOW, { maxObjects: 4 });
  assert.equal(c.media.copied, 2);
  assert.equal(c.media.remaining, 0);
  const t = await runBackup(env, NOW, { maxMs: -1 });
  assert.equal(t.media.copied, 0);
});

test("media: a changed size is copied again; a failed or vanished object is recorded and does not stop the pass", async () => {
  const AUDIO = bucket({ "a": "12345", "b": "bb", "c": "cc" }), BACKUP = bucket({ "media/a": "old" }, { failPut: (k) => k === "media/b" });
  const st = await runBackup({ DB: dbStub(TABLES()), AUDIO, BACKUP }, NOW);
  assert.equal(BACKUP.m.get("media/a").bytes.toString(), "12345");
  assert.deepEqual(st.media.failed, ["b"]);
  assert.equal(st.media.copied, 2);
  assert.equal(st.ok, false);
  assert.ok(BACKUP.m.has("media/c"));
});

test("errors are caught, recorded in last-run.json, and never thrown; media still runs when the db phase fails", async () => {
  const BACKUP = bucket(), AUDIO = bucket(audio(2));
  const DB = { prepare() { throw new Error("D1 down"); } };
  const logs = [], orig = console.error; console.error = (...a) => logs.push(a.join(" "));
  let st;
  try { st = await runBackup({ DB, AUDIO, BACKUP }, NOW); } finally { console.error = orig; }
  assert.equal(st.ok, false);
  assert.equal(st.errors[0].phase, "db");
  assert.equal(st.media.copied, 2);
  const last = JSON.parse(BACKUP.m.get(STATUS_KEY).bytes.toString());
  assert.equal(last.ok, false);
  assert.ok(typeof last.durationMs === "number" && last.startedAt);
  assert.ok(logs.length > 0 && logs.every((l) => !/D1 down/.test(l)), "console gets a generic message");
  assert.equal((await runBackup({ DB, AUDIO }, NOW)).ok, false, "no BACKUP binding: recorded, not thrown");
});

test("status and run routes require sign-in; status returns last-run.json; run is rate limited by the last start", async () => {
  const t = makeEnv(); const BACKUP = bucket(); t.env.BACKUP = BACKUP;
  assert.equal((await worker.fetch(await req("GET", "/api/backup/status", { cookie: false }), t.env)).status, 401);
  assert.equal((await worker.fetch(await req("POST", "/api/backup/run", { cookie: false }), t.env)).status, 401);
  let res = await worker.fetch(await req("GET", "/api/backup/status"), t.env);
  assert.deepEqual(await res.json(), { configured: true, lastRun: null });
  BACKUP.m.set(STATUS_KEY, { bytes: Buffer.from(JSON.stringify({ startedAt: "2020-01-01T00:00:00.000Z", ok: true })), httpMetadata: {} });
  res = await worker.fetch(await req("GET", "/api/backup/status"), t.env);
  assert.equal((await res.json()).lastRun.ok, true);
  assert.equal((await worker.fetch(await req("POST", "/api/backup/status"), t.env)).status, 405);
  assert.equal((await worker.fetch(await req("POST", "/api/backup/run", { origin: false }), t.env)).status, 403);
  BACKUP.m.set(STATUS_KEY, { bytes: Buffer.from(JSON.stringify({ startedAt: new Date().toISOString() })), httpMetadata: {} });
  assert.equal((await worker.fetch(await req("POST", "/api/backup/run"), t.env)).status, 429);
  const none = makeEnv();
  assert.equal((await worker.fetch(await req("GET", "/api/backup/status"), none.env)).status, 200);
  assert.equal((await worker.fetch(await req("POST", "/api/backup/run"), none.env)).status, 503);
});

test("POST /api/backup/run does one pass and returns the status", async () => {
  const t = makeEnv(); t.env.BACKUP = bucket(); const dump = dbStub(TABLES()), real = t.env.DB; t.env.DB = { prepare: (sql) => (sql.startsWith("SELECT hash") ? real : dump).prepare(sql) }; t.env.AUDIO = bucket(audio(2));
  const res = await worker.fetch(await req("POST", "/api/backup/run"), t.env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.lastRun.media.copied, 2);
  assert.equal(body.lastRun.db.tables.projects, 120);
});

test("the Worker exports fetch and scheduled; scheduled runs the backup through waitUntil", async () => {
  assert.equal(typeof worker.fetch, "function");
  assert.equal(typeof worker.scheduled, "function");
  const BACKUP = bucket(), pending = [];
  worker.scheduled({ scheduledTime: NOW }, { DB: dbStub(TABLES()), BACKUP }, { waitUntil: (p) => pending.push(p) });
  assert.equal(pending.length, 1);
  await Promise.all(pending);
  assert.ok(BACKUP.m.has("db/2026-11-18.json"));
  const broken = [];
  worker.scheduled({ scheduledTime: NOW }, {}, { waitUntil: (p) => broken.push(p) });
  await Promise.all(broken); // resolves, never rejects
});
