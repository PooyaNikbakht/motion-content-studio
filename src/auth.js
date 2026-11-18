// Login password and session cookie for the Worker (used by worker.js and api.js).
//
// The password lives in D1 (table auth, one row) as PBKDF2-SHA256 with a per-install random salt. It is created once on
// first run and needs the RECOVERY_KEY Worker secret, so a stranger who finds the URL first cannot claim the app.
// Secrets (npx wrangler secret put ...):
//   RECOVERY_KEY    needed to create the password and to reset it
//   SESSION_SECRET  long random string used to sign the session cookie
//
// Iterations: Cloudflare Workers cap PBKDF2 at 100,000 iterations, which is also what we use. Hashing is done by the
// platform's native crypto (not JS), so one hash costs a few ms of CPU, far below the 100 ms cpu_ms limit
// (tests/auth.test.mjs prints the measured time in Node). The count is stored per row, so it can change later.

export const COOKIE = "mbs_session";
export const SESSION_SECONDS = 30 * 24 * 60 * 60;
export const ITERATIONS = 100000;
export const MIN_PASSWORD = 10;
export const MAX_PASSWORD = 256;

const enc = new TextEncoder();

export function b64url(bytes) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s) {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(t + "=".repeat((4 - (t.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

/** Constant-time string compare: both sides are hashed to 32 bytes first, so length does not leak. */
export async function safeEqual(a, b) {
  const key = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const [x, y] = await Promise.all([hmac(key, String(a)), hmac(key, String(b))]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export async function hashPassword(password, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return b64url(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: fromB64url(salt), iterations }, key, 256));
}

/** A new { hash, salt, iterations } for a password. */
export async function newCredential(password) {
  const salt = b64url(crypto.getRandomValues(new Uint8Array(16)));
  return { hash: await hashPassword(password, salt, ITERATIONS), salt, iterations: ITERATIONS };
}

export async function verifyPassword(password, row) {
  return safeEqual(await hashPassword(password, row.salt, row.iterations), row.hash);
}

/** The auth row, or null before first-run setup. */
export async function getAuth(env) {
  return env.DB.prepare("SELECT hash, salt, iterations, epoch FROM auth WHERE id = 1").first();
}

/** Creates the row. Resolves false if one already exists (the primary key makes this atomic). */
export async function createAuth(env, cred) {
  const now = Date.now();
  try {
    await env.DB.prepare("INSERT INTO auth (id, hash, salt, iterations, epoch, created_at, updated_at) VALUES (1, ?, ?, ?, 1, ?, ?)")
      .bind(cred.hash, cred.salt, cred.iterations, now, now).run();
    return true;
  } catch (e) {
    if (await getAuth(env)) return false;
    throw e;
  }
}

/** Replaces the password and bumps the epoch, which signs out every existing session. */
export async function replaceAuth(env, cred) {
  await env.DB.prepare("UPDATE auth SET hash = ?, salt = ?, iterations = ?, epoch = epoch + 1, updated_at = ? WHERE id = 1")
    .bind(cred.hash, cred.salt, cred.iterations, Date.now()).run();
}

export async function makeToken(env, epoch) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const body = `v2.${exp}.${epoch}`;
  return `${body}.${b64url(await hmac(env.SESSION_SECRET, body))}`;
}

export async function isAuthed(request, env) {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(request.headers.get("Cookie") || "");
  if (!m) return false;
  const parts = m[1].split(".");
  if (parts.length !== 4 || parts[0] !== "v2") return false;
  const exp = Number(parts[1]);
  if (!Number.isFinite(exp) || exp < Date.now() / 1000) return false;
  const expected = b64url(await hmac(env.SESSION_SECRET, `v2.${parts[1]}.${parts[2]}`));
  if (!(await safeEqual(parts[3], expected))) return false;
  let row;
  try { row = await getAuth(env); } catch { return false; }
  return !!row && String(row.epoch) === parts[2];
}
