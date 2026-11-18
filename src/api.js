// Storage API for /app: projects, folders and progress in D1, generated audio in R2.
// A PUT replaces the whole record (no merge) but only when it carries the row's current version (baseVersion); otherwise 409 with the
// current version. { overwrite: true } skips that check. Every write to a project row bumps `version`.
//
// Every route is guarded in this order: signed in (401 JSON, never a redirect), per-IP rate limit (429),
// same-origin write (Origin and X-MBS, 403), then content type (415) and size (413) before the body is read.
// Bindings: DB (D1), AUDIO (R2), API_LIMIT (rate limit, optional).

import { isAuthed } from "./auth.js";
import { createShare, activeShare, revokeShares, DEFAULT_DAYS } from "./share.js";

// A full AI Director run is saved as the project text. The three caps below add up to 1.8 MiB, under the 2 MB limit of one D1 row.
const MAX_BODY = 1.9 * 1024 * 1024;
const MAX_TEXT = 900 * 1024;
const MAX_PARSED = 700 * 1024;
const MAX_STATE_INFO = 200 * 1024;
const MAX_AUDIO = 8 * 1024 * 1024;
const MAX_PROMPT = 100 * 1024; // bytes, for each of the Director Prompt texts
const MAX_MEDIA = 100000000; // bytes: one original image or video (100 MB, decimal)
const MAX_THUMB = 512 * 1024;
const MAX_MEDIA_FILES = 200; // per project
const SOFT_CAP = 2 * 1024 * 1024 * 1024; // per project: above this the response carries a warning, nothing is refused
const FREE_ALLOWANCE = 10 * 1024 * 1024 * 1024; // R2 free storage, shared with everything else in the bucket
// s-4-image, r-1-video-2, yt-cover, and the same with a short random suffix (s-4-image-k3j9d) that the app adds so a file keeps its
// own R2 object when its scene is renumbered by a re-parse.
const MEDIA_KEY_RE = /^[a-z]{1,3}(?:-[a-z0-9]{1,12}){0,4}$/;
const MAX_CLEANUP = 200; // keys in one media-cleanup request
const MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp", "video/mp4", "video/webm"];
const THUMB_TYPES = ["image/webp", "image/jpeg", "image/png"];

const ID_RE = /^[\w-]{1,64}$/;
const AUDIO_KEY_RE = /^(\d{1,4}|reel:[\w-]{1,40})$/;
const STATUSES = ["draft", "in_production", "ready", "published"];
const AUDIO_TYPES = { "audio/mpeg": "mp3", "audio/wav": "wav" };

const enc = new TextEncoder();
const size = (s) => enc.encode(s).length;

function headers(extra) {
  return new Headers({
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex, nofollow",
    ...extra,
  });
}

function json(data, status = 200, extra) {
  return new Response(JSON.stringify(data), { status, headers: headers({ "Content-Type": "application/json; charset=utf-8", ...extra }) });
}
const fail = (status, message, extra, more) => json({ error: message, ...more }, status, extra);
const empty = (status = 204) => new Response(null, { status, headers: headers() });

/** Content-Length as a number, or null when missing or malformed. */
function declaredLength(request) {
  const v = request.headers.get("Content-Length");
  if (v === null || !/^\d+$/.test(v)) return null;
  return Number(v);
}

/** Reads and validates a JSON body. Returns { value } or { res } (an error response). */
async function readJson(request) {
  if (!/^application\/json\b/i.test(request.headers.get("Content-Type") || "")) return { res: fail(415, "Send application/json.") };
  const len = declaredLength(request);
  if (len !== null && len > MAX_BODY) return { res: fail(413, "Body too large.") };
  const text = await request.text();
  if (size(text) > MAX_BODY) return { res: fail(413, "Body too large.") };
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) return { res: fail(400, "Expected a JSON object.") };
    return { value };
  } catch {
    return { res: fail(400, "Invalid JSON.") };
  }
}

const str = (v, max) => typeof v === "string" && v.length <= max;
const num = (v) => typeof v === "number" && Number.isFinite(v);
const obj = (v) => v === undefined || v === null || (typeof v === "object" && !Array.isArray(v));

function projectFromRow(r) {
  const state = JSON.parse(r.state_json || "{}");
  return {
    id: r.id, name: r.name, folderId: r.folder_id, lang: r.lang, status: r.status, text: r.text,
    parsed: r.parsed_json ? JSON.parse(r.parsed_json) : null,
    progress: state.progress || {}, reelProgress: state.reelProgress || {}, audio: state.audio || {}, reelAudio: state.reelAudio || {}, thumbnailDone: !!state.thumbnailDone, ext: state.ext || {},
    info: JSON.parse(r.info_json || "{}"),
    createdAt: r.created_at, updatedAt: r.updated_at, serverAt: r.server_at, version: r.version,
  };
}

async function putProject(env, id, request) {
  const { value: b, res } = await readJson(request);
  if (res) return res;
  if (b.id !== id) return fail(400, "id in the body must match the URL.");
  if (!str(b.name, 200) || !b.name.trim()) return fail(400, "Invalid name.");
  if (!(b.folderId === null || b.folderId === undefined || (str(b.folderId, 64) && b.folderId))) return fail(400, "Invalid folderId.");
  if (!str(b.lang || "auto", 16)) return fail(400, "Invalid lang.");
  const status = b.status === undefined ? "draft" : b.status;
  if (!STATUSES.includes(status)) return fail(400, "Invalid status.");
  if (!str(b.text === undefined ? "" : b.text, MAX_TEXT * 4)) return fail(400, "Invalid text.");
  if (!obj(b.parsed) || !obj(b.progress) || !obj(b.reelProgress) || !obj(b.audio) || !obj(b.reelAudio) || !obj(b.info) || !obj(b.ext)) return fail(400, "Invalid fields.");
  if (!num(b.createdAt) || !(b.updatedAt === undefined || num(b.updatedAt))) return fail(400, "Invalid dates.");

  const text = b.text || "";
  const parsedJson = b.parsed ? JSON.stringify(b.parsed) : null;
  const stateJson = JSON.stringify({ progress: b.progress || {}, reelProgress: b.reelProgress || {}, audio: b.audio || {}, reelAudio: b.reelAudio || {}, thumbnailDone: !!b.thumbnailDone, ext: b.ext || {} });
  const infoJson = JSON.stringify(b.info || {});
  const textBytes = size(text), parsedBytes = parsedJson ? size(parsedJson) : 0, stateInfoBytes = size(stateJson) + size(infoJson);
  if (textBytes > MAX_TEXT || parsedBytes > MAX_PARSED || stateInfoBytes > MAX_STATE_INFO) return fail(413, "Project is too large.");

  if (!(b.baseVersion === undefined || (Number.isInteger(b.baseVersion) && b.baseVersion >= 0)) || !(b.overwrite === undefined || typeof b.overwrite === "boolean")) return fail(400, "Invalid baseVersion.");

  // One atomic statement: a new row is inserted at version 1; an existing row is replaced only when its version is the one the client
  // loaded (or the client chose to overwrite). No row comes back when the check fails.
  const now = Date.now();
  const row = await env.DB.prepare(
    `INSERT INTO projects (id, name, folder_id, lang, status, text, parsed_json, state_json, info_json, created_at, updated_at, server_at, bytes, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, folder_id = excluded.folder_id, lang = excluded.lang, status = excluded.status,
       text = excluded.text, parsed_json = excluded.parsed_json, state_json = excluded.state_json, info_json = excluded.info_json,
       created_at = excluded.created_at, updated_at = excluded.updated_at, server_at = excluded.server_at, bytes = excluded.bytes,
       version = projects.version + 1
     WHERE projects.version = ? OR ? = 1
     RETURNING version`,
  ).bind(id, b.name, b.folderId || null, b.lang || "auto", status, text, parsedJson, stateJson, infoJson, b.createdAt, b.updatedAt || now, now, textBytes + parsedBytes + stateInfoBytes, b.baseVersion || 0, b.overwrite ? 1 : 0).first();
  if (!row) {
    const cur = await env.DB.prepare("SELECT version FROM projects WHERE id = ?").bind(id).first();
    return fail(409, "This project changed elsewhere.", { }, { version: cur ? cur.version : 0 });
  }
  return json({ serverAt: now, version: row.version });
}

// Name, folder and status only (rename, move). Does not touch the rest of the project, so it is safe while the open project has unsaved edits.
async function patchProject(env, id, request) {
  const { value: b, res } = await readJson(request);
  if (res) return res;
  const row = await env.DB.prepare("SELECT * FROM projects WHERE id = ?").bind(id).first();
  if (!row) return fail(404, "Not found.");
  const name = b.name === undefined ? row.name : b.name;
  const folderId = b.folderId === undefined ? row.folder_id : b.folderId;
  const status = b.status === undefined ? row.status : b.status;
  if (!str(name, 200) || !name.trim()) return fail(400, "Invalid name.");
  if (!(folderId === null || (str(folderId, 64) && folderId))) return fail(400, "Invalid folderId.");
  if (!STATUSES.includes(status)) return fail(400, "Invalid status.");
  const now = Date.now();
  const out = await env.DB.prepare("UPDATE projects SET name = ?, folder_id = ?, status = ?, server_at = ?, version = version + 1 WHERE id = ? RETURNING version").bind(name, folderId, status, now, id).first();
  return json({ serverAt: now, version: out.version });
}

async function deleteProject(env, id) {
  // R2 first: a retry after a partial failure still finds the D1 row and finishes the job.
  let cursor;
  do {
    const page = await env.AUDIO.list({ prefix: `audio/${id}/`, cursor });
    if (page.objects.length) await env.AUDIO.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  cursor = undefined;
  do {
    const page = await env.AUDIO.list({ prefix: `media/${id}/`, cursor });
    if (page.objects.length) await env.AUDIO.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM shares WHERE project_id = ?").bind(id),
    env.DB.prepare("DELETE FROM media WHERE project_id = ?").bind(id),
    env.DB.prepare("DELETE FROM audio WHERE project_id = ?").bind(id),
    env.DB.prepare("DELETE FROM projects WHERE id = ?").bind(id),
  ]);
  return empty();
}

async function putFolder(env, id, request) {
  const { value: b, res } = await readJson(request);
  if (res) return res;
  if (b.id !== id) return fail(400, "id in the body must match the URL.");
  if (!str(b.name, 200) || !b.name.trim()) return fail(400, "Invalid name.");
  if (!num(b.createdAt)) return fail(400, "Invalid dates.");
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO folders (id, name, collapsed, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, collapsed = excluded.collapsed, created_at = excluded.created_at, updated_at = excluded.updated_at`,
  ).bind(id, b.name, b.collapsed ? 1 : 0, b.createdAt, now).run();
  return json({ serverAt: now });
}

async function deleteFolder(env, id) {
  await env.DB.batch([
    env.DB.prepare("UPDATE projects SET folder_id = NULL, server_at = ? WHERE folder_id = ?").bind(Date.now(), id),
    env.DB.prepare("DELETE FROM folders WHERE id = ?").bind(id),
  ]);
  return empty();
}

async function putAudio(env, request, id, key) {
  const type = (request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
  const ext = AUDIO_TYPES[type];
  if (!ext) return fail(415, "Send audio/mpeg or audio/wav.");
  const len = declaredLength(request);
  if (len === null) return fail(411, "Content-Length is required.");
  if (len > MAX_AUDIO) return fail(413, "Audio is too large.");
  if (len === 0 || !request.body) return fail(400, "Empty audio.");
  if (!(await env.DB.prepare("SELECT 1 AS ok FROM projects WHERE id = ?").bind(id).first())) return fail(404, "Save the project first.");

  const r2Key = `audio/${id}/${key.replace(":", "-")}.${ext}`;
  const prev = await env.DB.prepare("SELECT r2_key FROM audio WHERE project_id = ? AND key = ?").bind(id, key).first();
  await env.AUDIO.put(r2Key, request.body, { httpMetadata: { contentType: type } });
  if (prev && prev.r2_key !== r2Key) await env.AUDIO.delete(prev.r2_key);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO audio (project_id, key, r2_key, bytes, content_type, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, key) DO UPDATE SET r2_key = excluded.r2_key, bytes = excluded.bytes, content_type = excluded.content_type, updated_at = excluded.updated_at`,
  ).bind(id, key, r2Key, len, type, now).run();
  return json({ bytes: len });
}

async function getAudio(env, id, key) {
  const row = await env.DB.prepare("SELECT r2_key, content_type, bytes FROM audio WHERE project_id = ? AND key = ?").bind(id, key).first();
  const obj = row && (await env.AUDIO.get(row.r2_key));
  if (!obj) return fail(404, "Not found.");
  return new Response(obj.body, { headers: headers({ "Content-Type": row.content_type, "Content-Length": String(row.bytes) }) });
}

async function deleteAudio(env, id, key) {
  const row = await env.DB.prepare("SELECT r2_key FROM audio WHERE project_id = ? AND key = ?").bind(id, key).first();
  if (row) await env.AUDIO.delete(row.r2_key);
  await env.DB.prepare("DELETE FROM audio WHERE project_id = ? AND key = ?").bind(id, key).run();
  return empty();
}

// Originals (images, videos) and their thumbnails, streamed into R2 under media/<project>/. Metadata is in the D1 table media.
// Workers request bodies are capped by the plan (100 MB on Free and Pro), so the 100,000,000 byte file cap sits at that edge limit.
const reqType = (request) => (request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();

class UploadError extends Error { constructor(status, message) { super(message); this.status = status; } }

/**
 * The request body through a byte counter: more bytes than Content-Length (a client that lies) fails with 413, fewer with 400.
 * Nothing is buffered. In the Workers runtime the counted stream goes through FixedLengthStream, which R2 needs for a stream of known length.
 * Returns { body, failure() } where failure() is the UploadError the counter raised, if any.
 */
function countedBody(body, len) {
  let seen = 0, err = null;
  const counter = new TransformStream({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > len) { err = new UploadError(413, "The upload is larger than its Content-Length."); throw err; }
      controller.enqueue(chunk);
    },
    flush() { if (seen !== len) { err = new UploadError(400, "The upload ended early. Try again."); throw err; } },
  });
  const counted = body.pipeThrough(counter);
  return { body: typeof FixedLengthStream === "function" ? counted.pipeThrough(new FixedLengthStream(len)) : counted, failure: () => err };
}

/** Puts a request body into R2 through the counter. Returns null on success or an error response. */
async function putStreamed(env, r2Key, request, len, type) {
  const g = countedBody(request.body, len);
  try {
    await env.AUDIO.put(r2Key, g.body, { httpMetadata: { contentType: type } });
  } catch (e) {
    const f = g.failure() || (e instanceof UploadError ? e : null);
    if (f) return fail(f.status, f.message);
    throw e;
  }
  return g.failure() ? fail(g.failure().status, g.failure().message) : null;
}

async function accountUsage(env) {
  const m = await env.DB.prepare("SELECT COALESCE(SUM(bytes), 0) AS b, COALESCE(SUM(thumb_bytes), 0) AS t, COUNT(*) AS n FROM media").first();
  const a = await env.DB.prepare("SELECT COALESCE(SUM(bytes), 0) AS b FROM audio").first();
  return { mediaBytes: m.b, thumbBytes: m.t, audioBytes: a.b, files: m.n, usedBytes: m.b + m.t + a.b, allowanceBytes: FREE_ALLOWANCE, softCapBytes: SOFT_CAP };
}

async function putMedia(env, request, id, key) {
  const type = reqType(request);
  if (!MEDIA_TYPES.includes(type)) return fail(415, "Send image/png, image/jpeg, image/webp, video/mp4 or video/webm.");
  const len = declaredLength(request);
  if (len === null) return fail(411, "Content-Length is required.");
  if (len > MAX_MEDIA) return fail(413, "That file is over 100 MB (the limit is 100,000,000 bytes). Compress it (a lower bitrate or resolution) and add it again.");
  if (len === 0 || !request.body) return fail(400, "Empty file.");
  if (!(await env.DB.prepare("SELECT 1 AS ok FROM projects WHERE id = ?").bind(id).first())) return fail(404, "Save the project first.");
  let name = key;
  try { name = decodeURIComponent(request.headers.get("X-Name") || "").replace(/[\u0000-\u001f]/g, "").slice(0, 200) || key; } catch { /* keep the key */ }
  const prev = await env.DB.prepare("SELECT r2_key, thumb_key, bytes FROM media WHERE project_id = ? AND key = ?").bind(id, key).first();
  const tot = await env.DB.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM media WHERE project_id = ?").bind(id).first();
  if (!prev && tot.n >= MAX_MEDIA_FILES) return fail(409, "A project can hold 200 files. Remove some first.");
  const r2Key = `media/${id}/${key}`;
  const bad = await putStreamed(env, r2Key, request, len, type);
  if (bad) return bad;
  await env.DB.prepare(
    `INSERT INTO media (project_id, key, r2_key, thumb_key, name, content_type, bytes, thumb_bytes, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, key) DO UPDATE SET r2_key = excluded.r2_key, name = excluded.name, content_type = excluded.content_type, bytes = excluded.bytes, updated_at = excluded.updated_at`,
  ).bind(id, key, r2Key, null, name, type, len, 0, Date.now()).run();
  const projectBytes = tot.b - (prev ? prev.bytes : 0) + len;
  const u = await accountUsage(env);
  return json({ bytes: len, projectBytes, softCap: SOFT_CAP, overSoftCap: projectBytes > SOFT_CAP, usedBytes: u.usedBytes, allowanceBytes: u.allowanceBytes, nearAllowance: u.usedBytes >= u.allowanceBytes * 0.8 });
}

async function putThumb(env, request, id, key) {
  const type = reqType(request);
  if (!THUMB_TYPES.includes(type)) return fail(415, "Send image/webp, image/jpeg or image/png.");
  const len = declaredLength(request);
  if (len === null) return fail(411, "Content-Length is required.");
  if (len > MAX_THUMB) return fail(413, "Thumbnail is too large.");
  if (len === 0 || !request.body) return fail(400, "Empty thumbnail.");
  if (!(await env.DB.prepare("SELECT r2_key, thumb_key, bytes FROM media WHERE project_id = ? AND key = ?").bind(id, key).first())) return fail(404, "Upload the file first.");
  const thumbKey = `media/${id}/thumb/${key}`;
  const bad = await putStreamed(env, thumbKey, request, len, type);
  if (bad) return bad;
  await env.DB.prepare("UPDATE media SET thumb_key = ?, thumb_bytes = ?, thumb_type = ? WHERE project_id = ? AND key = ?").bind(thumbKey, len, type, id, key).run();
  return json({ bytes: len });
}

/** One byte range of a representation of `size` bytes. null: no usable Range header (send everything). "bad": not satisfiable (416). */
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec((header || "").trim());
  if (!m || (m[1] === "" && m[2] === "")) return null; // absent, malformed or several ranges: serve the whole file
  let start, end;
  if (m[1] === "") {
    const n = Number(m[2]);
    if (n === 0) return "bad";
    start = Math.max(0, size - n); end = size - 1;
  } else {
    start = Number(m[1]); end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  return start >= size || start > end ? "bad" : { start, end };
}

// ASCII fallback plus the real name (RFC 6266 / 5987) so Download keeps the original file name.
function disposition(kind, name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())}`;
}

// GET of an original or a thumbnail: content type from the stored metadata, an ETag, Range support (so <video> can seek), a download
// name. Cache-Control is private + no-cache: the browser keeps a copy but asks (cheaply, with the ETag) before using it.
async function getMedia(env, request, url, id, key, thumb) {
  const row = await env.DB.prepare("SELECT r2_key, thumb_key, content_type, bytes, thumb_bytes, thumb_type, name, updated_at FROM media WHERE project_id = ? AND key = ?").bind(id, key).first();
  const r2Key = row && (thumb ? row.thumb_key : row.r2_key);
  if (!r2Key) return fail(404, "Not found.");
  const size = thumb ? row.thumb_bytes : row.bytes, type = thumb ? row.thumb_type : row.content_type;
  const etag = '"' + (thumb ? "t" : "m") + size.toString(36) + "-" + Number(row.updated_at || 0).toString(36) + '"';
  const base = { "Content-Type": type, ETag: etag, "Accept-Ranges": "bytes", "Cache-Control": "private, no-cache", "Content-Disposition": disposition(url.searchParams.get("download") === "1" ? "attachment" : "inline", thumb ? key + ".webp" : row.name) };
  if ((request.headers.get("If-None-Match") || "").split(",").some((t) => t.trim() === etag)) return new Response(null, { status: 304, headers: headers({ ETag: etag, "Cache-Control": base["Cache-Control"] }) });
  let range = parseRange(request.headers.get("Range"), size);
  const ifRange = request.headers.get("If-Range");
  if (range && ifRange && ifRange !== etag) range = null; // the file changed since the client's copy: send all of it
  if (range === "bad") return new Response(null, { status: 416, headers: headers({ "Content-Range": "bytes */" + size }) });
  const obj = await env.AUDIO.get(r2Key, range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : undefined);
  if (!obj) return fail(404, "Not found.");
  if (range) return new Response(obj.body, { status: 206, headers: headers({ ...base, "Content-Range": `bytes ${range.start}-${range.end}/${size}`, "Content-Length": String(range.end - range.start + 1) }) });
  return new Response(obj.body, { headers: headers({ ...base, "Content-Length": String(size) }) });
}

async function deleteMedia(env, id, key) {
  const row = await env.DB.prepare("SELECT r2_key, thumb_key, bytes FROM media WHERE project_id = ? AND key = ?").bind(id, key).first();
  if (row) await env.AUDIO.delete([row.r2_key].concat(row.thumb_key ? [row.thumb_key] : []));
  await env.DB.prepare("DELETE FROM media WHERE project_id = ? AND key = ?").bind(id, key).run();
  return empty();
}

async function listMedia(env, id) {
  const { results } = await env.DB.prepare("SELECT key, name, content_type, bytes, thumb_bytes, updated_at FROM media WHERE project_id = ? ORDER BY key").bind(id).all();
  return json({ media: results.map((r) => ({ key: r.key, name: r.name, type: r.content_type, bytes: r.bytes, thumbBytes: r.thumb_bytes, updatedAt: r.updated_at })) });
}

// What this app stores in the bucket. The bucket is shared with other site media, so the real free allowance left is lower.
async function storageUsage(env) { return json(await accountUsage(env)); }

// Removes several files of one project in one call (the "Remove unused media" action). Only keys that belong to the project are touched.
async function cleanupMedia(env, request, id) {
  const { value: b, res } = await readJson(request);
  if (res) return res;
  if (!Array.isArray(b.keys) || b.keys.length > MAX_CLEANUP || !b.keys.every((k) => typeof k === "string" && MEDIA_KEY_RE.test(k))) return fail(400, "Send up to " + MAX_CLEANUP + " valid media keys.");
  let removed = 0, bytes = 0;
  for (const key of new Set(b.keys)) {
    const row = await env.DB.prepare("SELECT r2_key, thumb_key, bytes FROM media WHERE project_id = ? AND key = ?").bind(id, key).first();
    if (!row) continue;
    await env.AUDIO.delete([row.r2_key].concat(row.thumb_key ? [row.thumb_key] : []));
    await env.DB.prepare("DELETE FROM media WHERE project_id = ? AND key = ?").bind(id, key).run();
    removed++; bytes += row.bytes;
  }
  return json({ removed, bytes });
}

// Read-only share link of one project (see share.js). The token is returned once, at creation; only its hash is stored.
async function shareRoute(env, request, url, id) {
  const method = request.method;
  if (method === "GET") { const a = await activeShare(env, id); return json({ active: !!a, createdAt: a ? a.createdAt : null, expiresAt: a ? a.expiresAt : null }); }
  if (method === "DELETE") { await revokeShares(env, id); return empty(); }
  if (!(await env.DB.prepare("SELECT 1 AS ok FROM projects WHERE id = ?").bind(id).first())) return fail(404, "Save the project first.");
  let days = DEFAULT_DAYS;
  if ((request.headers.get("Content-Type") || "").startsWith("application/json")) {
    const { value, res } = await readJson(request);
    if (res) return res;
    if (value.days !== undefined) days = value.days;
  }
  if (![1, 7, 30].includes(days)) return fail(400, "Expiry must be 1, 7 or 30 days.");
  const s = await createShare(env, id, days);
  return json({ active: true, url: url.origin + "/s/" + s.token, createdAt: s.createdAt, expiresAt: s.expiresAt });
}

// The Director Prompt vault: the user's own prompt, kept on the account (never in a public file).
async function getDirectorPrompt(env) {
  const row = await env.DB.prepare("SELECT value, updated_at FROM settings WHERE key = ?").bind("director-prompt").first();
  const v = row ? JSON.parse(row.value) : {};
  return json({ text: v.text || "", defaultText: v.defaultText || "", updatedAt: row ? row.updated_at : 0 });
}

async function putDirectorPrompt(env, request) {
  const { value: b, res } = await readJson(request);
  if (res) return res;
  if (typeof b.text !== "string" || (b.defaultText !== undefined && typeof b.defaultText !== "string")) return fail(400, "Send text and defaultText as strings.");
  const defaultText = b.defaultText || "";
  if (size(b.text) > MAX_PROMPT || size(defaultText) > MAX_PROMPT) return fail(413, "The prompt is over 100 KB.");
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).bind("director-prompt", JSON.stringify({ text: b.text, defaultText }), now).run();
  return json({ updatedAt: now });
}

/** Handles /api/*. Returns a Response for every path, including unknown ones. */
export async function handleApi(request, env, url) {
  if (!env.SESSION_SECRET) return fail(503, "Login is not configured.");
  if (!(await isAuthed(request, env))) return fail(401, "Not signed in.");

  // Best-effort per-IP budget. A missing binding (older local setups) skips the check.
  if (env.API_LIMIT) {
    const { success } = await env.API_LIMIT.limit({ key: request.headers.get("CF-Connecting-IP") || "local" });
    if (!success) return fail(429, "Too many requests.", { "Retry-After": "15" });
  }

  const method = request.method;
  const write = method !== "GET" && method !== "HEAD";
  if (write && (request.headers.get("Origin") !== url.origin || request.headers.get("X-MBS") !== "1")) return fail(403, "Request blocked.");

  const parts = url.pathname.split("/").filter(Boolean).slice(1).map((s) => { try { return decodeURIComponent(s); } catch { return "\u0000"; } });
  const [kind, id, sub, key] = parts;
  const allowed = (...m) => (m.includes(method) ? null : fail(405, "Method not allowed.", { Allow: m.join(", ") }));

  try {
    if (kind === "projects") {
      if (parts.length === 1) {
        const bad = allowed("GET"); if (bad) return bad;
        const { results } = await env.DB.prepare("SELECT id, name, folder_id, status, created_at, updated_at, server_at, version FROM projects ORDER BY created_at").all();
        return json({ projects: results.map((r) => ({ id: r.id, name: r.name, folderId: r.folder_id, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at, serverAt: r.server_at, version: r.version })) });
      }
      if (!ID_RE.test(id)) return fail(400, "Invalid id.");
      if (parts.length === 2) {
        const bad = allowed("GET", "PUT", "PATCH", "DELETE"); if (bad) return bad;
        if (method === "PUT") return await putProject(env, id, request);
        if (method === "PATCH") return await patchProject(env, id, request);
        if (method === "DELETE") return await deleteProject(env, id);
        const row = await env.DB.prepare("SELECT * FROM projects WHERE id = ?").bind(id).first();
        return row ? json(projectFromRow(row)) : fail(404, "Not found.");
      }
      if (parts.length === 3 && sub === "shares") {
        const bad = allowed("GET", "POST", "DELETE"); if (bad) return bad;
        return await shareRoute(env, request, url, id);
      }
      if ((parts.length === 4 && (sub === "media" || sub === "thumb")) || (parts.length === 3 && sub === "media")) {
        if (parts.length === 3) { const bad = allowed("GET"); if (bad) return bad; return await listMedia(env, id); }
        if (!MEDIA_KEY_RE.test(key)) return fail(400, "Invalid media key.");
        const bad = sub === "thumb" ? allowed("GET", "PUT") : allowed("GET", "PUT", "DELETE"); if (bad) return bad;
        if (method === "PUT") return sub === "media" ? await putMedia(env, request, id, key) : await putThumb(env, request, id, key);
        if (method === "DELETE") return await deleteMedia(env, id, key);
        return await getMedia(env, request, url, id, key, sub === "thumb");
      }
      if (parts.length === 3 && sub === "media-cleanup") {
        const bad = allowed("POST"); if (bad) return bad;
        return await cleanupMedia(env, request, id);
      }
      if (parts.length === 4 && sub === "audio") {
        if (!AUDIO_KEY_RE.test(key)) return fail(400, "Invalid audio key.");
        const bad = allowed("GET", "PUT", "DELETE"); if (bad) return bad;
        if (method === "PUT") return await putAudio(env, request, id, key);
        if (method === "DELETE") return await deleteAudio(env, id, key);
        return await getAudio(env, id, key);
      }
    } else if (kind === "storage") {
      if (parts.length === 1) { const bad = allowed("GET"); if (bad) return bad; return await storageUsage(env); }
    } else if (kind === "settings") {
      if (parts.length === 2 && id === "director-prompt") {
        const bad = allowed("GET", "PUT"); if (bad) return bad;
        return method === "PUT" ? await putDirectorPrompt(env, request) : await getDirectorPrompt(env);
      }
    } else if (kind === "folders") {
      if (parts.length === 1) {
        const bad = allowed("GET"); if (bad) return bad;
        const { results } = await env.DB.prepare("SELECT id, name, collapsed, created_at, updated_at FROM folders ORDER BY created_at").all();
        return json({ folders: results.map((r) => ({ id: r.id, name: r.name, collapsed: !!r.collapsed, createdAt: r.created_at, updatedAt: r.updated_at })) });
      }
      if (parts.length === 2) {
        if (!ID_RE.test(id)) return fail(400, "Invalid id.");
        const bad = allowed("GET", "PUT", "DELETE"); if (bad) return bad;
        if (method === "PUT") return await putFolder(env, id, request);
        if (method === "DELETE") return await deleteFolder(env, id);
        const r = await env.DB.prepare("SELECT id, name, collapsed, created_at, updated_at FROM folders WHERE id = ?").bind(id).first();
        return r ? json({ id: r.id, name: r.name, collapsed: !!r.collapsed, createdAt: r.created_at, updatedAt: r.updated_at }) : fail(404, "Not found.");
      }
    }
  } catch (e) {
    console.error("api error", method, url.pathname, e && e.message);
    return fail(500, "Storage error.");
  }
  return fail(404, "Not found.");
}
