// Daily backup, run by the Cron Trigger (see "triggers" in wrangler.jsonc) or by POST /api/backup/run.
// Bindings: DB (D1), AUDIO (R2, the source), BACKUP (R2, private bucket motion-books-backups).
//
//   db/YYYY-MM-DD.json     every D1 table (rows as JSON), schema version, row counts. Same-day reruns overwrite it.
//   media/<key>            incremental copy of the AUDIO bucket. Never deleted here, so files removed in the app stay recoverable.
//   status/last-run.json   what the last pass did (counts and keys only, never row contents).
//
// One pass does bounded work: at most MAX_OBJECTS copies and MAX_MS of wall clock, then it stops and the next run continues.
// runBackup never throws: failures are recorded in last-run.json and logged without details.

export const DB_PREFIX = "db/";
export const MEDIA_PREFIX = "media/";
export const STATUS_KEY = "status/last-run.json";
export const MAX_OBJECTS = 40;
export const MAX_MS = 20000;
export const KEEP_DAYS = 30;
export const KEEP_MIN = 7;
export const MIN_GAP_MS = 60 * 1000; // a manual run is refused while the previous pass started less than this ago
const PAGE_ROWS = 50;
const DAY_MS = 24 * 60 * 60 * 1000;
const DB_KEY_RE = /^db\/(\d{4}-\d{2}-\d{2})\.json$/;
const TABLE_RE = /^[A-Za-z0-9_]+$/;

let inFlight = false;

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Lists every object under a prefix, following the cursor. */
async function listAll(bucket, prefix) {
  const out = [];
  let cursor;
  do {
    const r = await bucket.list({ prefix, cursor, limit: 1000 });
    out.push(...r.objects);
    cursor = r.truncated ? r.cursor : undefined;
  } while (cursor);
  return out;
}

/** Dumps every table. Returns { schemaVersion, tables: {name: rows[]}, summary: {name: count} }. */
async function dumpDb(env) {
  const { results: names } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all();
  let schemaVersion = null;
  try {
    const m = await env.DB.prepare("SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1").first();
    schemaVersion = m ? m.name : null;
  } catch { /* no migrations table (not created by wrangler) */ }
  const tables = {}, summary = {};
  for (const { name } of names) {
    if (name === "d1_migrations") continue;
    if (!TABLE_RE.test(name)) throw new Error("unexpected table name");
    const rows = [];
    for (let offset = 0; ; offset += PAGE_ROWS) {
      const { results } = await env.DB.prepare(`SELECT * FROM "${name}" ORDER BY rowid LIMIT ? OFFSET ?`).bind(PAGE_ROWS, offset).all();
      rows.push(...results);
      if (results.length < PAGE_ROWS) break;
    }
    tables[name] = rows;
    summary[name] = rows.length;
  }
  return { schemaVersion, tables, summary };
}

/** Deletes db/ backups older than KEEP_DAYS, always keeping the KEEP_MIN newest. Returns { deleted, kept }. */
export async function applyRetention(bucket, now) {
  const dated = (await listAll(bucket, DB_PREFIX)).map((o) => ({ key: o.key, day: (DB_KEY_RE.exec(o.key) || [])[1] })).filter((o) => o.day);
  dated.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0)); // newest first
  const cutoff = dayOf(now - KEEP_DAYS * DAY_MS);
  const old = dated.slice(KEEP_MIN).filter((o) => o.day < cutoff).map((o) => o.key);
  for (let i = 0; i < old.length; i += 100) await bucket.delete(old.slice(i, i + 100));
  return { deleted: old.length, kept: dated.length - old.length };
}

/** Copies AUDIO objects that BACKUP does not hold yet (same key and size). Stops at maxObjects or maxMs. */
async function copyMedia(env, t0, maxObjects, maxMs) {
  const [source, have] = await Promise.all([listAll(env.AUDIO, ""), listAll(env.BACKUP, MEDIA_PREFIX)]);
  const sizes = new Map(have.map((o) => [o.key.slice(MEDIA_PREFIX.length), o.size]));
  const todo = source.filter((o) => sizes.get(o.key) !== o.size);
  const out = { totalSource: source.length, alreadyBacked: source.length - todo.length, copied: 0, remaining: 0, failed: [] };
  let attempted = 0, i = 0;
  for (; i < todo.length; i++) {
    if (attempted >= maxObjects || Date.now() - t0 >= maxMs) break;
    attempted++;
    const key = todo[i].key;
    try {
      const src = await env.AUDIO.get(key);
      if (!src) { out.failed.push(key); continue; } // deleted since the listing
      await env.BACKUP.put(MEDIA_PREFIX + key, src.body, { httpMetadata: src.httpMetadata, customMetadata: src.customMetadata });
      out.copied++;
    } catch {
      out.failed.push(key); // retried by the next run
    }
  }
  out.remaining = todo.length - i; // not attempted this pass; failed keys are listed separately and retried too
  return out;
}

/** Reads status/last-run.json, or null. */
export async function readStatus(env) {
  if (!env.BACKUP) return null;
  const o = await env.BACKUP.get(STATUS_KEY);
  if (!o) return null;
  try { return JSON.parse(await o.text()); } catch { return null; }
}

/**
 * One bounded backup pass. Never throws. `now` is a Date or ms. opts: { maxObjects, maxMs } (tests).
 * Returns the status object it also wrote to status/last-run.json.
 */
export async function runBackup(env, now = Date.now(), opts = {}) {
  const t0 = Date.now();
  const nowMs = now instanceof Date ? now.getTime() : now;
  const status = { startedAt: new Date(t0).toISOString(), ok: true, schemaVersion: null, db: null, retention: null, media: null, errors: [] };
  const phase = async (name, fn) => {
    try { return await fn(); } catch (e) {
      status.ok = false;
      status.errors.push({ phase: name, message: String((e && e.message) || e).slice(0, 200) });
      console.error("backup phase failed:", name); // generic: no row data, no keys
      return null;
    }
  };
  if (inFlight) return { ...status, ok: false, errors: [{ phase: "start", message: "another pass is running" }] };
  inFlight = true;
  try {
    if (!env.BACKUP) { status.ok = false; status.errors.push({ phase: "start", message: "BACKUP binding missing" }); console.error("backup phase failed: start"); return status; }
    await phase("db", async () => {
      const d = await dumpDb(env);
      const key = DB_PREFIX + dayOf(nowMs) + ".json";
      const body = JSON.stringify({ format: 1, createdAt: new Date(nowMs).toISOString(), schemaVersion: d.schemaVersion, summary: d.summary, tables: d.tables });
      await env.BACKUP.put(key, body, { httpMetadata: { contentType: "application/json" } });
      status.schemaVersion = d.schemaVersion;
      status.db = { key, bytes: body.length, tables: d.summary, totalRows: Object.values(d.summary).reduce((a, b) => a + b, 0) };
    });
    if (status.db) status.retention = await phase("retention", () => applyRetention(env.BACKUP, nowMs));
    if (env.AUDIO) status.media = await phase("media", () => copyMedia(env, t0, opts.maxObjects ?? MAX_OBJECTS, opts.maxMs ?? MAX_MS));
    if (status.media && status.media.failed.length) status.ok = false;
  } finally {
    inFlight = false;
    status.finishedAt = new Date().toISOString();
    status.durationMs = Date.now() - t0;
    try { await env.BACKUP.put(STATUS_KEY, JSON.stringify(status), { httpMetadata: { contentType: "application/json" } }); }
    catch { console.error("backup phase failed: status"); }
  }
  return status;
}

/** Cron Trigger entry point. */
export function scheduled(event, env, ctx) {
  const run = runBackup(env, new Date(event && event.scheduledTime ? event.scheduledTime : Date.now()));
  ctx.waitUntil(run); // runBackup never rejects
}
