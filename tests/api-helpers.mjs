// Test helpers for src/api.js: an in-memory D1 stub (it understands only the statements api.js issues),
// an R2 stub backed by a Map, a signed session cookie and a request builder.
import { webcrypto } from "node:crypto";

export const SECRET = "test-secret";
export const RECOVERY = "recovery-key-for-tests";
export const ORIGIN = "https://studio.test";
const enc = new TextEncoder();
const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export async function sessionCookie(secret = SECRET, epoch = 1) {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const key = await webcrypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await webcrypto.subtle.sign("HMAC", key, enc.encode(`v2.${exp}.${epoch}`)));
  return `mbs_session=v2.${exp}.${epoch}.${b64url(sig)}`;
}

export function makeEnv(opts = {}) {
  const settings = new Map(), media = new Map(), shares = new Map();
  const authRows = new Map(opts.noAuth ? [] : [[1, { hash: "x", salt: "x", iterations: 1, epoch: 1 }]]);
  const projects = new Map(), folders = new Map(), audio = new Map(), objects = new Map();
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  const P = (id) => projects.get(id);

  function run(sql, a) {
    sql = norm(sql);
    if (sql.startsWith("SELECT hash, salt, iterations, epoch FROM auth")) return { row: authRows.get(1) || null };
    if (sql.startsWith("INSERT INTO auth")) { if (authRows.has(1)) throw new Error("UNIQUE constraint failed: auth.id"); authRows.set(1, { hash: a[0], salt: a[1], iterations: a[2], epoch: 1 }); return {}; }
    if (sql.startsWith("UPDATE auth SET")) { const r = authRows.get(1); Object.assign(r, { hash: a[0], salt: a[1], iterations: a[2], epoch: r.epoch + 1 }); return {}; }
    if (sql.startsWith("SELECT id, name, folder_id, status, created_at, updated_at, server_at, version FROM projects")) return { results: [...projects.values()].sort((x, y) => x.created_at - y.created_at) };
    if (sql.startsWith("SELECT r2_key, thumb_key, content_type")) return { row: media.get(a[0] + "|" + a[1]) || null };
    if (sql.startsWith("SELECT r2_key, thumb_key, bytes FROM media")) return { row: media.get(a[0] + "|" + a[1]) || null };
    if (sql.startsWith("SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM media WHERE project_id")) { const l = [...media.values()].filter((m) => m.project_id === a[0]); return { row: { n: l.length, b: l.reduce((x, m) => x + m.bytes, 0) } }; }
    if (sql.startsWith("INSERT INTO media")) { const [project_id, key, r2_key, thumb_key, name, content_type, bytes, thumb_bytes, updated_at] = a; const prev = media.get(project_id + "|" + key); media.set(project_id + "|" + key, Object.assign({ thumb_key, thumb_bytes, thumb_type: null }, prev ? { thumb_key: prev.thumb_key, thumb_bytes: prev.thumb_bytes, thumb_type: prev.thumb_type } : {}, { project_id, key, r2_key, name, content_type, bytes, updated_at })); return {}; }
    if (sql.startsWith("UPDATE media SET thumb_key")) { const m = media.get(a[3] + "|" + a[4]); if (m) { m.thumb_key = a[0]; m.thumb_bytes = a[1]; m.thumb_type = a[2]; } return {}; }
    if (sql === "DELETE FROM media WHERE project_id = ? AND key = ?") { media.delete(a[0] + "|" + a[1]); return {}; }
    if (sql === "DELETE FROM media WHERE project_id = ?") { for (const k of [...media.keys()]) if (k.startsWith(a[0] + "|")) media.delete(k); return {}; }
    if (sql.startsWith("SELECT key, name, content_type, bytes, thumb_bytes, updated_at FROM media")) return { results: [...media.values()].filter((m) => m.project_id === a[0]).sort((x, y) => (x.key < y.key ? -1 : 1)) };
    if (sql.startsWith("SELECT COALESCE(SUM(bytes), 0) AS b, COALESCE(SUM(thumb_bytes), 0) AS t")) { const l = [...media.values()]; return { row: { b: l.reduce((x, m) => x + m.bytes, 0), t: l.reduce((x, m) => x + (m.thumb_bytes || 0), 0), n: l.length } }; }
    if (sql.startsWith("SELECT COALESCE(SUM(bytes), 0) AS b FROM audio")) return { row: { b: [...audio.values()].reduce((x, m) => x + m.bytes, 0) } };
    if (sql.startsWith("SELECT parsed_json, state_json FROM projects")) return { row: P(a[0]) || null };
    if (sql.startsWith("INSERT INTO shares")) { const [token_hash, project_id, created_at, expires_at] = a; shares.set(token_hash, { token_hash, project_id, created_at, expires_at, revoked_at: null }); return {}; }
    if (sql.startsWith("UPDATE shares SET revoked_at")) { for (const r of shares.values()) if (r.project_id === a[1] && r.revoked_at === null) r.revoked_at = a[0]; return {}; }
    if (sql.startsWith("SELECT created_at, expires_at FROM shares")) { const l = [...shares.values()].filter((r) => r.project_id === a[0] && r.revoked_at === null && r.expires_at > a[1]).sort((x, y) => y.created_at - x.created_at); return { row: l[0] || null }; }
    if (sql.startsWith("SELECT project_id, expires_at, revoked_at FROM shares")) return { row: shares.get(a[0]) || null };
    if (sql === "DELETE FROM shares WHERE project_id = ?") { for (const [k, r] of [...shares]) if (r.project_id === a[0]) shares.delete(k); return {}; }
    if (sql.startsWith("SELECT value, updated_at FROM settings")) return { row: settings.get(a[0]) || null };
    if (sql.startsWith("INSERT INTO settings")) { settings.set(a[0], { value: a[1], updated_at: a[2] }); return {}; }
    if (sql.startsWith("SELECT * FROM projects WHERE id")) return { row: P(a[0]) };
    if (sql.startsWith("SELECT 1 AS ok FROM projects")) return { row: P(a[0]) ? { ok: 1 } : null };
    if (sql.startsWith("SELECT version FROM projects")) return { row: P(a[0]) ? { version: P(a[0]).version } : null };
    if (sql.startsWith("INSERT INTO projects")) {
      // Mirrors the conditional upsert: insert at version 1, or replace when version = base (or overwrite) and bump it. RETURNING version.
      const [id, name, folder_id, lang, status, text, parsed_json, state_json, info_json, created_at, updated_at, server_at, bytes, base, overwrite] = a;
      const prev = P(id);
      if (prev && !(prev.version === base || overwrite === 1)) return { row: null };
      const version = prev ? prev.version + 1 : 1;
      projects.set(id, { id, name, folder_id, lang, status, text, parsed_json, state_json, info_json, created_at, updated_at, server_at, bytes, version });
      return { row: { version } };
    }
    if (sql.startsWith("UPDATE projects SET name = ?")) { const p = P(a[4]); Object.assign(p, { name: a[0], folder_id: a[1], status: a[2], server_at: a[3], version: p.version + 1 }); return { row: { version: p.version } }; }
    if (sql === "DELETE FROM projects WHERE id = ?") { projects.delete(a[0]); return {}; }
    if (sql === "DELETE FROM audio WHERE project_id = ?") { for (const k of [...audio.keys()]) if (k.startsWith(a[0] + "|")) audio.delete(k); return {}; }
    if (sql === "DELETE FROM audio WHERE project_id = ? AND key = ?") { audio.delete(a[0] + "|" + a[1]); return {}; }
    if (sql.startsWith("SELECT r2_key")) return { row: audio.get(a[0] + "|" + a[1]) || null };
    if (sql.startsWith("INSERT INTO audio")) { const [project_id, key, r2_key, bytes, content_type, updated_at] = a; audio.set(project_id + "|" + key, { project_id, key, r2_key, bytes, content_type, updated_at }); return {}; }
    if (sql.startsWith("SELECT id, name, collapsed, created_at, updated_at FROM folders WHERE id")) return { row: folders.get(a[0]) || null };
    if (sql.startsWith("SELECT id, name, collapsed, created_at, updated_at FROM folders")) return { results: [...folders.values()] };
    if (sql.startsWith("INSERT INTO folders")) { const [id, name, collapsed, created_at, updated_at] = a; folders.set(id, { id, name, collapsed, created_at, updated_at }); return {}; }
    if (sql.startsWith("UPDATE projects SET folder_id = NULL")) { for (const p of projects.values()) if (p.folder_id === a[1]) { p.folder_id = null; p.server_at = a[0]; } return {}; }
    if (sql === "DELETE FROM folders WHERE id = ?") { folders.delete(a[0]); return {}; }
    throw new Error("DB stub does not know: " + sql);
  }
  const stmt = (sql) => ({
    a: [], bind(...a) { this.a = a; return this; },
    async first() { const r = run(sql, this.a); return r.row === undefined ? null : r.row; },
    async all() { return { results: run(sql, this.a).results || [] }; },
    async run() { run(sql, this.a); return { success: true }; },
  });
  const DB = { prepare: stmt, async batch(list) { for (const s of list) await s.run(); return []; } };

  const AUDIO = {
    async put(key, body, o) { objects.set(key, { bytes: new Uint8Array(await new Response(body).arrayBuffer()), type: o && o.httpMetadata && o.httpMetadata.contentType }); },
    async get(key, o2) {
      const o = objects.get(key);
      if (!o) return null;
      const r = o2 && o2.range;
      this.lastRange = r || null;
      return { body: new Response(r ? o.bytes.slice(r.offset, r.offset + r.length) : o.bytes).body };
    },
    async delete(keys) { for (const k of [].concat(keys)) objects.delete(k); },
    async list({ prefix }) { return { objects: [...objects.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false }; },
  };
  const limit = { allow: true, calls: [] };
  const loginLimit = { calls: [], counts: new Map(), max: 10 }; // counts per key like the real binding (10 per window)
  const LOGIN_LIMIT = opts.noLoginLimiter ? undefined : { async limit(o) { loginLimit.calls.push(o); const c = (loginLimit.counts.get(o.key) || 0) + 1; loginLimit.counts.set(o.key, c); return { success: c <= loginLimit.max }; } };
  const env = { RECOVERY_KEY: RECOVERY, LOGIN_DELAY_MS: "0", SESSION_SECRET: SECRET, DB, AUDIO, LOGIN_LIMIT, API_LIMIT: opts.noLimiter ? undefined : { async limit(o) { limit.calls.push(o); return { success: limit.allow }; } } };
  return { env, authRows, settings, media, shares, projects, folders, audio, objects, limit, loginLimit };
}

/** A Request. Body strings and byte arrays get a Content-Length unless headers say otherwise. */
export async function req(method, path, { body, headers = {}, cookie = true, origin = true, mbs = true, json = true } = {}) {
  const h = new Headers(headers);
  if (cookie) h.set("Cookie", typeof cookie === "string" ? cookie : await sessionCookie());
  if (method !== "GET" && origin) h.set("Origin", origin === true ? ORIGIN : origin);
  if (method !== "GET" && mbs) h.set("X-MBS", "1");
  let payload;
  if (body !== undefined) {
    if (json && typeof body === "object" && !(body instanceof Uint8Array)) { payload = JSON.stringify(body); if (!h.has("Content-Type")) h.set("Content-Type", "application/json"); }
    else payload = body;
    if (!h.has("Content-Length")) h.set("Content-Length", String(typeof payload === "string" ? Buffer.byteLength(payload) : payload.byteLength));
  }
  return new Request(ORIGIN + path, { method, headers: h, body: payload });
}

export const project = (id, extra = {}) => ({ id, name: "P " + id, folderId: null, lang: "auto", status: "draft", text: "hello", parsed: null, progress: {}, reelProgress: {}, audio: {}, reelAudio: {}, info: {}, createdAt: 1, updatedAt: 2, ...extra });
