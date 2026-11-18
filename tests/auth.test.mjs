import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import { hashPassword, ITERATIONS } from "../src/auth.js";
import { makeEnv, ORIGIN, RECOVERY, sessionCookie } from "./api-helpers.mjs";

const PW = "correct horse battery";
const NEW = "another long passphrase";
let n = 0;
const ip = () => "10.0.0." + ++n; // the failure counter is per IP and module-wide

function withAssets(env) { return Object.assign({}, env, { ASSETS: { fetch: () => new Response("asset") } }); }
async function post(env, fields, { cookie, ipAddr = ip() } = {}) {
  const h = { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN, "CF-Connecting-IP": ipAddr };
  if (cookie) h.Cookie = cookie;
  return worker.fetch(new Request(ORIGIN + "/login", { method: "POST", headers: h, body: new URLSearchParams(fields) }), withAssets(env));
}
const setupFields = (o = {}) => ({ action: "setup", recovery: RECOVERY, new: PW, confirm: PW, ...o });
const sessionOf = (res) => (res.headers.get("Set-Cookie") || "").split(";")[0];
const get = (env, path, cookie) => worker.fetch(new Request(ORIGIN + path, { headers: cookie ? { Cookie: cookie } : {} }), withAssets(env));

test("PBKDF2 at 100000 iterations: one hash is far below the 100 ms CPU limit (measured, Node)", async () => {
  assert.equal(ITERATIONS, 100000);
  const t = performance.now();
  await hashPassword(PW, "c2FsdHNhbHRzYWx0c2FsdA", ITERATIONS);
  const ms = performance.now() - t;
  console.log("# PBKDF2-SHA256 100000 iterations: " + ms.toFixed(1) + " ms in Node (Workers' native crypto is similar)");
  assert.ok(ms < 100, "took " + ms);
});

test("first run: /login shows Create password; /app redirects to /login", async () => {
  const { env } = makeEnv({ noAuth: true });
  const html = await (await get(env, "/login")).text();
  assert.match(html, /Create password/);
  assert.match(html, /name="recovery"/);
  assert.equal((await get(env, "/app")).status, 303);
});

test("setup is blocked without the right recovery key, and nothing is stored", async () => {
  const m = makeEnv({ noAuth: true });
  for (const recovery of ["", "wrong", RECOVERY + "x"]) {
    const res = await post(m.env, setupFields({ recovery }));
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("Set-Cookie"), null);
  }
  assert.equal(m.authRows.size, 0);
  const none = makeEnv({ noAuth: true });
  delete none.env.RECOVERY_KEY;
  assert.equal((await post(none.env, setupFields())).status, 503);
  assert.equal(none.authRows.size, 0);
});

test("setup validates length and confirmation", async () => {
  const m = makeEnv({ noAuth: true });
  assert.match(await (await post(m.env, setupFields({ new: "short", confirm: "short" }))).text(), /at least 10/);
  const mismatch = await post(m.env, setupFields({ confirm: PW + "!" }));
  assert.equal(mismatch.status, 400);
  assert.match(await mismatch.text(), /do not match/);
  assert.equal(m.authRows.size, 0);
});

test("setup works once; the row holds a salted PBKDF2 hash, never the password; a second setup is refused", async () => {
  const m = makeEnv({ noAuth: true });
  const res = await post(m.env, setupFields());
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("Location"), "/app");
  assert.match(res.headers.get("Set-Cookie"), /mbs_session=v2\.\d+\.1\.[\w-]+; Path=\/; HttpOnly; SameSite=Lax/);
  const row = m.authRows.get(1);
  assert.equal(row.iterations, 100000);
  assert.ok(row.salt.length >= 20);
  assert.ok(!JSON.stringify(row).includes(PW));
  assert.equal(row.hash, await hashPassword(PW, row.salt, row.iterations));
  const again = await post(m.env, setupFields({ new: NEW, confirm: NEW }));
  assert.equal(again.status, 409);
  assert.equal(m.authRows.get(1).hash, row.hash);
  assert.match(await (await get(m.env, "/login")).text(), /Sign in/);
});

test("login: right password sets the cookie and opens /app; wrong password is 401", async () => {
  const m = makeEnv({ noAuth: true });
  await post(m.env, setupFields());
  const bad = await post(m.env, { action: "signin", password: "nope nope nope" });
  assert.equal(bad.status, 401);
  assert.equal(bad.headers.get("Set-Cookie"), null);
  const ok = await post(m.env, { password: PW });
  assert.equal(ok.status, 303);
  const c = sessionOf(ok);
  assert.equal((await get(m.env, "/app", c)).status, 200);
  assert.equal((await get(m.env, "/app", "mbs_session=v2.9999999999.1.forged")).status, 303);
  assert.equal((await get(m.env, "/app", await sessionCookie("other-secret"))).status, 303);
});

test("change password: needs the current one, signs out other sessions, keeps this one", async () => {
  const m = makeEnv({ noAuth: true });
  await post(m.env, setupFields());
  const old = sessionOf(await post(m.env, { password: PW }));
  const wrong = await post(m.env, { action: "change", password: "not the password", new: NEW, confirm: NEW }, { cookie: old });
  assert.equal(wrong.status, 401);
  const signedOut = await post(m.env, { action: "change", password: PW, new: NEW, confirm: NEW });
  assert.equal(signedOut.status, 401); // no session cookie
  const ok = await post(m.env, { action: "change", password: PW, new: NEW, confirm: NEW }, { cookie: old });
  assert.equal(ok.status, 303);
  const fresh = sessionOf(ok);
  assert.equal((await get(m.env, "/app", fresh)).status, 200);
  assert.equal((await get(m.env, "/app", old)).status, 303);
  assert.equal((await post(m.env, { password: PW })).status, 401);
  assert.equal((await post(m.env, { password: NEW })).status, 303);
  assert.equal((await get(m.env, "/login?mode=change", fresh)).status, 200);
  assert.equal((await get(m.env, "/login?mode=change")).status, 303);
});

test("reset: needs the recovery key, sets a new password, invalidates every session", async () => {
  const m = makeEnv({ noAuth: true });
  await post(m.env, setupFields());
  const old = sessionOf(await post(m.env, { password: PW }));
  assert.equal((await get(m.env, "/app", old)).status, 200);
  assert.match(await (await get(m.env, "/login?mode=forgot")).text(), /Reset password/);
  const denied = await post(m.env, { action: "forgot", recovery: "wrong", new: NEW, confirm: NEW });
  assert.equal(denied.status, 401);
  assert.equal((await post(m.env, { password: PW })).status, 303);
  const res = await post(m.env, { action: "forgot", recovery: RECOVERY, new: NEW, confirm: NEW });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Set-Cookie"), null);
  assert.equal(m.authRows.get(1).epoch, 2);
  assert.equal((await get(m.env, "/app", old)).status, 303);
  const api = await worker.fetch(new Request(ORIGIN + "/api/projects", { headers: { Cookie: old } }), withAssets(m.env));
  assert.equal(api.status, 401);
  assert.equal((await post(m.env, { password: PW })).status, 401);
  const again = sessionOf(await post(m.env, { password: NEW }));
  assert.equal((await get(m.env, "/app", again)).status, 200);
});

test("rate limit: 5 misses lock the IP for login, setup and reset; success elsewhere is unaffected", async () => {
  const m = makeEnv({ noAuth: true });
  const a = "9.9.9.9";
  for (let i = 0; i < 5; i++) assert.equal((await post(m.env, setupFields({ recovery: "bad" + i }), { ipAddr: a })).status, 401);
  const locked = await post(m.env, setupFields(), { ipAddr: a });
  assert.equal(locked.status, 429);
  assert.ok(locked.headers.get("Retry-After"));
  assert.equal(m.authRows.size, 0);
  assert.equal((await post(m.env, setupFields(), { ipAddr: "9.9.9.8" })).status, 303);
  const b = "9.9.9.7";
  for (let i = 0; i < 5; i++) await post(m.env, { password: "bad password " + i }, { ipAddr: b });
  assert.equal((await post(m.env, { password: PW }, { ipAddr: b })).status, 429);
  assert.equal((await post(m.env, { action: "forgot", recovery: RECOVERY, new: NEW, confirm: NEW }, { ipAddr: b })).status, 429);
});

test("LOGIN_LIMIT: the 11th POST /login in a window gets 429 before any hashing or D1 work, other IPs are unaffected", async () => {
  const m = makeEnv({ noAuth: true });
  const a = ip();
  let prepares = 0;
  const env = { ...m.env, DB: { prepare(...x) { prepares++; return m.env.DB.prepare(...x); }, batch: (l) => m.env.DB.batch(l) } };
  for (let i = 0; i < 10; i++) assert.notEqual((await post(env, { action: "signin", password: "x" }, { ipAddr: a })).status, 429);
  const before = prepares;
  for (const action of ["signin", "setup", "change", "forgot", "dev"]) {
    const r = await post(env, setupFields({ action }), { ipAddr: a });
    assert.equal(r.status, 429, action);
    assert.equal(r.headers.get("Retry-After"), "60");
    assert.match(await r.text(), /Too many attempts\. Wait a minute and try again\./);
  }
  assert.equal(prepares, before, "no D1 work once limited");
  assert.equal(m.authRows.size, 0);
  assert.equal(m.loginLimit.calls.at(-1).key, a);
  assert.equal((await post(env, setupFields(), { ipAddr: ip() })).status, 303);
});

test("LOGIN_LIMIT: keyed by CF-Connecting-IP with a local fallback; GET /login is not limited", async () => {
  const m = makeEnv({ noAuth: true });
  await worker.fetch(new Request(ORIGIN + "/login", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN }, body: new URLSearchParams({ password: "x" }) }), withAssets(m.env));
  assert.equal(m.loginLimit.calls[0].key, "local");
  m.loginLimit.max = 0;
  for (let i = 0; i < 3; i++) assert.equal((await get(m.env, "/login")).status, 200);
  assert.equal(m.loginLimit.calls.length, 1, "GET never touches the limiter");
});

test("LOGIN_LIMIT: an absent binding is skipped without breaking sign in", async () => {
  const m = makeEnv({ noAuth: true, noLoginLimiter: true });
  assert.equal(m.env.LOGIN_LIMIT, undefined);
  assert.equal((await post(m.env, setupFields())).status, 303);
});

test("cross-origin form posts are blocked", async () => {
  const m = makeEnv({ noAuth: true });
  const res = await worker.fetch(new Request(ORIGIN + "/login", { method: "POST", headers: { Origin: "https://evil.test", "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(setupFields()) }), withAssets(m.env));
  assert.equal(res.status, 403);
  assert.equal(m.authRows.size, 0);
});

// ---- Dev sign in (DEV_LOGIN=1 and a local host only) ----
const LOCAL = "http://localhost:8799";
const devEnv = (m, flag) => withAssets(Object.assign({}, m.env, flag === undefined ? {} : { DEV_LOGIN: flag }));
const devPost = (env, origin, fields = { action: "dev" }) => worker.fetch(new Request(origin + "/login", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: origin, "CF-Connecting-IP": ip() }, body: new URLSearchParams(fields) }), env);

test("dev sign in: the button is not rendered and the route is 404 when DEV_LOGIN is unset or not 1", async () => {
  for (const flag of [undefined, "0", "true", ""]) {
    const m = makeEnv({ noAuth: true });
    const env = devEnv(m, flag);
    assert.ok(!/Dev sign in/.test(await (await worker.fetch(new Request(LOCAL + "/login"), env)).text()));
    assert.equal((await devPost(env, LOCAL)).status, 404);
    assert.equal(m.authRows.size, 0);
  }
});

test("dev sign in: 404 and no button on a non-local host even with the flag", async () => {
  const m = makeEnv({ noAuth: true });
  const env = devEnv(m, "1");
  assert.ok(!/Dev sign in/.test(await (await worker.fetch(new Request(ORIGIN + "/login"), env)).text()));
  for (const host of [ORIGIN, "https://localhost.evil.example", "http://127.0.0.1.nip.io"]) {
    const res = await devPost(env, host);
    assert.equal(res.status, 404, host);
    assert.equal(res.headers.get("Set-Cookie"), null);
  }
  assert.equal(m.authRows.size, 0);
});

test("dev sign in: with the flag on localhost or 127.0.0.1 it creates the password without the recovery key and signs in", async () => {
  for (const origin of [LOCAL, "http://127.0.0.1:8799"]) {
    const m = makeEnv({ noAuth: true });
    delete m.env.RECOVERY_KEY;
    const env = devEnv(m, "1");
    const html = await (await worker.fetch(new Request(origin + "/login"), env)).text();
    assert.match(html, /Dev sign in \(local only\)/);
    assert.ok(!/local-dev-password/.test(html), "the password is never shown");
    const res = await devPost(env, origin);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("Location"), "/app");
    const cookie = sessionOf(res);
    assert.match(cookie, /^mbs_session=v2\./);
    assert.equal(m.authRows.size, 1);
    assert.equal((await get(env, "/app", cookie)).status, 200);
    // signing in again reuses the existing password row
    const row = { ...m.authRows.get(1) };
    assert.equal((await devPost(env, origin)).status, 303);
    assert.equal(m.authRows.get(1).hash, row.hash);
  }
});

test("dev sign in: with the flag off the normal RECOVERY_KEY flow is unchanged", async () => {
  const m = makeEnv({ noAuth: true });
  const env = devEnv(m);
  assert.equal((await post(env, setupFields({ recovery: "wrong" }))).status, 401);
  assert.equal(m.authRows.size, 0);
  assert.equal((await post(env, setupFields())).status, 303);
  assert.equal((await post(env, { action: "signin", password: "nope-nope-nope" })).status, 401);
  assert.equal((await devPost(env, ORIGIN)).status, 404);
});

// wrangler dev rewrites request.url's host to the route host (motioncontent.pooya.website) unless told not to, which silently hides Dev sign in locally.
test("dev sign in: local dev commands keep the real local origin (--infer-origin-from-routes=false)", async () => {
  const { readFileSync } = await import("node:fs");
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(pkg.scripts.dev, /--infer-origin-from-routes=false/);
  assert.match(readFileSync(new URL("../playwright.config.ts", import.meta.url), "utf8"), /wrangler dev .*--infer-origin-from-routes=false/);
});

test("dev sign in: stays off when the host is the production route host even with DEV_LOGIN=1", async () => {
  const m = await makeEnv();
  const r = await worker.fetch(new Request("http://motioncontent.pooya.website/login", { headers: { "CF-Connecting-IP": ip() } }), devEnv(m, "1"));
  assert.equal((await r.text()).includes("Dev sign in"), false);
});

// ---- Optional Google sign-in ----
const CID = "client-id.apps.googleusercontent.com";
const gEnv = (o = {}) => { const m = makeEnv(o); Object.assign(m.env, { GOOGLE_CLIENT_ID: CID, GOOGLE_CLIENT_SECRET: "gsecret", ALLOWED_EMAIL: "Me@Example.com, other@example.com" }); return m; };
const jwt = (c) => "h." + Buffer.from(JSON.stringify(c)).toString("base64url") + ".s";
const goodClaims = (nonce, o = {}) => ({ iss: "https://accounts.google.com", aud: CID, exp: Math.floor(Date.now() / 1000) + 600, nonce, email: "me@example.com", email_verified: true, ...o });
const cookieOf = (res, name) => ((res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get("Set-Cookie")]).find((c) => c && c.startsWith(name + "=")) || "").split(";")[0];

async function startG(env, ipAddr = ip()) {
  const res = await worker.fetch(new Request(ORIGIN + "/auth/google", { headers: { "CF-Connecting-IP": ipAddr } }), withAssets(env));
  const loc = res.headers.get("Location") ? new URL(res.headers.get("Location")) : null;
  return { res, loc, tmp: cookieOf(res, "mbs_oauth") };
}
/** Runs the callback with a stubbed token endpoint. claims: object or function(nonce); tweak: { state, tmp, status }. */
async function callbackG(env, claims, tweak = {}) {
  const { loc, tmp } = await startG(env);
  const realFetch = globalThis.fetch;
  let sent;
  globalThis.fetch = async (u, init) => {
    sent = { u: String(u), body: new URLSearchParams(init.body) };
    if (tweak.status) return new Response("{}", { status: tweak.status });
    return new Response(JSON.stringify({ id_token: jwt(typeof claims === "function" ? claims(loc.searchParams.get("nonce")) : claims) }));
  };
  try {
    const q = new URLSearchParams({ code: "abc", state: "state" in tweak ? tweak.state : loc.searchParams.get("state") });
    const h = { "CF-Connecting-IP": ip() };
    const c = "tmp" in tweak ? tweak.tmp : tmp;
    if (c) h.Cookie = c;
    const res = await worker.fetch(new Request(ORIGIN + "/auth/google/callback?" + q, { headers: h }), withAssets(env));
    return { res, sent, loc };
  } finally { globalThis.fetch = realFetch; }
}
const GENERIC = /Google sign-in was not allowed\./;

test("google: off by default, button hidden, routes 404", async () => {
  const m = makeEnv();
  assert.doesNotMatch(await (await get(m.env, "/login")).text(), /Continue with Google/);
  assert.equal((await get(m.env, "/auth/google")).status, 404);
  assert.equal((await get(m.env, "/auth/google/callback?code=a&state=b")).status, 404);
  const partial = makeEnv();
  partial.env.GOOGLE_CLIENT_ID = CID;
  assert.equal((await get(partial.env, "/auth/google")).status, 404);
});

test("google: button on the sign-in page only, not in setup or forgot", async () => {
  const m = gEnv();
  assert.match(await (await get(m.env, "/login")).text(), /href="\/auth\/google"[^>]*>[^]*Continue with Google/);
  assert.doesNotMatch(await (await get(m.env, "/login?mode=forgot")).text(), /Continue with Google/);
  assert.doesNotMatch(await (await get(gEnv({ noAuth: true }).env, "/login")).text(), /Continue with Google/);
});

test("google: start redirects with state, nonce, PKCE and the callback URL, and sets a signed short-lived cookie", async () => {
  const { res, loc } = await startG(gEnv().env);
  assert.equal(res.status, 302);
  assert.equal(loc.origin + loc.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(loc.searchParams.get("client_id"), CID);
  assert.equal(loc.searchParams.get("redirect_uri"), ORIGIN + "/auth/google/callback");
  assert.equal(loc.searchParams.get("scope"), "openid email");
  assert.equal(loc.searchParams.get("response_type"), "code");
  assert.equal(loc.searchParams.get("code_challenge_method"), "S256");
  for (const k of ["state", "nonce", "code_challenge"]) assert.ok(loc.searchParams.get(k).length >= 40, k);
  assert.match(res.headers.get("Set-Cookie"), /^mbs_oauth=[\w.-]+; Path=\/auth\/google; HttpOnly; SameSite=Lax; Max-Age=600; Secure$/);
  assert.match(res.headers.get("Cache-Control"), /no-store/);
});

test("google: callback rejects every bad case with one generic error and no session cookie", async () => {
  const cases = {
    "wrong aud": [(n) => goodClaims(n, { aud: "other" })],
    "wrong iss": [(n) => goodClaims(n, { iss: "https://evil.test" })],
    expired: [(n) => goodClaims(n, { exp: Math.floor(Date.now() / 1000) - 5 })],
    "nonce mismatch": [(n) => goodClaims(n + "x")],
    "unverified email": [(n) => goodClaims(n, { email_verified: false })],
    "string email_verified": [(n) => goodClaims(n, { email_verified: "true" })],
    "not allowed": [(n) => goodClaims(n, { email: "stranger@example.com" })],
    "token endpoint error": [(n) => goodClaims(n), { status: 400 }],
    "bad state": [(n) => goodClaims(n), { state: "wrong" }],
    "missing state": [(n) => goodClaims(n), { state: "" }],
    "missing cookie": [(n) => goodClaims(n), { tmp: "" }],
    "forged cookie": [(n) => goodClaims(n), { tmp: "mbs_oauth=e30.AAAA" }],
  };
  for (const [name, [claims, tweak]] of Object.entries(cases)) {
    const m = gEnv();
    const { res } = await callbackG(m.env, claims, tweak);
    const body = await res.text();
    assert.equal(res.status, 403, name);
    assert.match(body, GENERIC, name);
    assert.doesNotMatch(body, /example\.com|stranger/, name);
    assert.equal(cookieOf(res, "mbs_session"), "", name);
  }
});

test("google: allowed email (case-insensitive list) gets a working session, redirect to /app, temp cookie cleared, code sent with verifier and secret", async () => {
  const m = gEnv();
  const { res, sent, loc } = await callbackG(m.env, (n) => goodClaims(n, { iss: "accounts.google.com", email: "ME@example.COM" }));
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("Location"), "/app");
  const c = cookieOf(res, "mbs_session");
  assert.match(c, /^mbs_session=v2\.\d+\.1\./);
  assert.match(res.headers.getSetCookie().find((x) => x.startsWith("mbs_oauth=")), /Max-Age=0/);
  assert.equal(sent.u, "https://oauth2.googleapis.com/token");
  assert.equal(sent.body.get("client_secret"), "gsecret");
  assert.equal(sent.body.get("code"), "abc");
  assert.equal(sent.body.get("redirect_uri"), ORIGIN + "/auth/google/callback");
  const verifier = sent.body.get("code_verifier");
  const digest = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
  assert.equal(digest, loc.searchParams.get("code_challenge"));
  assert.notEqual((await get(m.env, "/api/projects", c)).status, 401);
  assert.equal((await get(m.env, "/api/projects")).status, 401);
  assert.equal((await get(m.env, "/app", c)).status, 200);
});

test("google: no auth row means no session and a clear message", async () => {
  const m = gEnv({ noAuth: true });
  const { res } = await callbackG(m.env, (n) => goodClaims(n));
  assert.equal(res.status, 409);
  assert.match(await res.text(), /Create the password first\./);
  assert.equal(cookieOf(res, "mbs_session"), "");
  assert.equal(m.authRows.size, 0);
});

test("google: start and callback are rate limited by LOGIN_LIMIT", async () => {
  const m = gEnv();
  const same = "10.9.9.9";
  for (let i = 0; i < 10; i++) assert.equal((await startG(m.env, same)).res.status, 302);
  const blocked = await startG(m.env, same);
  assert.equal(blocked.res.status, 429);
  assert.equal(blocked.res.headers.get("Retry-After"), "60");
  const cb = await worker.fetch(new Request(ORIGIN + "/auth/google/callback?code=a&state=b", { headers: { "CF-Connecting-IP": same } }), withAssets(m.env));
  assert.equal(cb.status, 429);
});

test("google: password login still works with Google enabled", async () => {
  const m = gEnv({ noAuth: true });
  await post(m.env, setupFields());
  const ok = await post(m.env, { password: PW });
  assert.equal(ok.status, 303);
  assert.equal((await get(m.env, "/app", sessionOf(ok))).status, 200);
  assert.equal((await post(m.env, { password: "wrong wrong wrong" })).status, 401);
});
