// Motion Content Studio: static assets, a password gate for /app, and the /api storage routes (src/api.js).
// The app itself runs in the browser. This Worker decides who may load /app and who may read or write /api.
//
// Secrets and the password: see src/auth.js (RECOVERY_KEY, SESSION_SECRET; the password itself is in D1).

import { handleApi } from "./api.js";
import { handleShare } from "./share.js";
import { scheduled } from "./backup.js";
import { COOKIE, SESSION_SECONDS, MIN_PASSWORD, MAX_PASSWORD, safeEqual, newCredential, verifyPassword, getAuth, createAuth, replaceAuth, makeToken, isAuthed } from "./auth.js";

export { isAuthed };

const MAX_FAILURES = 5; // per IP, per isolate, inside the window
const WINDOW_MS = 15 * 60 * 1000;

// Best-effort limiter: memory is per isolate, so add a Cloudflare rate-limit rule on POST /login too.
const failures = new Map();

function cookie(value, maxAge, url) {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function privateHeaders(headers) {
  headers.set("X-Robots-Tag", "noindex, nofollow");
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "same-origin");
  return headers;
}

const MODES = {
  setup: { title: "Create password", lead: "First run: choose the password for this app. You need the recovery key.", button: "Create password", fields: ["recovery", "new", "confirm"] },
  signin: { title: "Sign in", lead: "Enter the password to open the app.", button: "Sign in", fields: ["password"] },
  forgot: { title: "Reset password", lead: "Enter the recovery key and a new password. Every signed-in device is signed out.", button: "Reset password", fields: ["recovery", "new", "confirm"] },
  change: { title: "Change password", lead: "Enter your current password and a new one. Other devices are signed out.", button: "Change password", fields: ["password", "new", "confirm"] },
};
const FIELDS = {
  password: '<label for="password">Current password</label><input id="password" name="password" type="password" autocomplete="current-password" required>',
  recovery: '<label for="recovery">Recovery key</label><input id="recovery" name="recovery" type="password" autocomplete="off" spellcheck="false" required>',
  new: `<label for="new">New password</label><input id="new" name="new" type="password" autocomplete="new-password" minlength="${MIN_PASSWORD}" maxlength="${MAX_PASSWORD}" required><div class="hint">At least ${MIN_PASSWORD} characters.</div>`,
  confirm: '<label for="confirm">Confirm password</label><input id="confirm" name="confirm" type="password" autocomplete="new-password" required>',
};

// Local-only shortcut: DEV_LOGIN=1 (in .dev.vars, never a deployed var or secret) AND the request host is 127.0.0.1 or localhost.
// The fixed password below is only ever written to a local D1 by that shortcut.
const DEV_PASSWORD = "local-dev-password";
const devEnabled = (env, url) => env.DEV_LOGIN === "1" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");

function loginPage(message, status = 200, extra = {}, mode = "signin", notice = "", dev = false) {
  const m = MODES[mode];
  const fields = m.fields.map((f) => (f === m.fields[0] ? FIELDS[f].replace("<input ", "<input autofocus ") : FIELDS[f])).join("\n    ");
  const links = mode === "signin" ? '<a class="back" href="/login?mode=forgot">Forgot password?</a> ' : mode === "setup" ? "" : '<a class="back" href="' + (mode === "change" ? "/app" : "/login") + '">Cancel</a> ';
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${m.title} | Motion Content Studio</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: #0B0F19; color: #E6E8EB; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { width: 100%; max-width: 380px; background: #151C2C; border: 1px solid #263149; border-radius: 12px; padding: 28px 24px; }
  .brand { display: flex; align-items: center; gap: 10px; font-weight: 700; margin-bottom: 20px; }
  .mark { width: 28px; height: 28px; border-radius: 8px; background: #F59E0B; display: grid; place-items: center; }
  h1 { font-size: 1.25rem; margin: 0 0 4px; }
  p { margin: 0 0 20px; color: #9AA3AF; font-size: .95rem; }
  label { display: block; font-size: .875rem; margin-bottom: 6px; }
  input { width: 100%; min-height: 44px; padding: 10px 12px; border-radius: 8px; border: 1px solid #34425f; background: #0B0F19; color: inherit; font: inherit; }
  input:focus-visible, button:focus-visible, a:focus-visible { outline: 3px solid #FBBF24; outline-offset: 2px; }
  button { width: 100%; min-height: 44px; margin-top: 16px; border: 0; border-radius: 8px; background: #F59E0B; color: #0B0F19; font: inherit; font-weight: 700; cursor: pointer; }
  button:hover { background: #FBBF24; }
  button.dev { background: transparent; color: #FBBF24; border: 1px dashed #FBBF24; margin-top: 10px; }
  .err { margin-top: 12px; color: #F97066; font-size: .9rem; min-height: 1.3em; }
  .hint { margin-top: 4px; color: #9AA3AF; font-size: .8rem; }
  label:not(:first-child) { margin-top: 14px; }
  .ok { margin: 0 0 14px; color: #6EE7B7; font-size: .9rem; }
  .back { margin-right: 16px; display: inline-block; margin-top: 18px; color: #9AA3AF; font-size: .875rem; }
</style>
</head>
<body>
<main>
  <div class="brand"><span class="mark" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#0B0F19" stroke-width="2.5" stroke-linecap="round"><path d="M4 8v8M9 5v14M14 9v6M19 7v10"/></svg></span>Motion Content Studio</div>
  <h1>${m.title}</h1>
  <p>${m.lead}</p>
  ${notice ? `<div class="ok" role="status">${notice}</div>` : ""}
  <form method="post" action="/login">
    <input type="hidden" name="action" value="${mode}">
    ${fields}
    <div class="err" role="alert">${message ? message : ""}</div>
    <button type="submit">${m.button}</button>
  </form>
  ${dev ? '<form method="post" action="/login"><input type="hidden" name="action" value="dev"><button type="submit" class="dev">Dev sign in (local only)</button></form>' : ""}
  ${links}<a class="back" href="/">Back to the home page</a>
</main>
</body>
</html>`;
  const headers = privateHeaders(new Headers({ "Content-Type": "text/html; charset=utf-8", ...extra }));
  return new Response(html, { status, headers });
}

function redirect(location, extra = {}) {
  return new Response(null, { status: 303, headers: privateHeaders(new Headers({ Location: location, ...extra })) });
}

async function handleLogin(request, env, url) {
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  const now = Date.now();
  let rec = failures.get(ip);
  if (rec && now - rec.first > WINDOW_MS) { failures.delete(ip); rec = undefined; }
  let form;
  try { form = await request.formData(); } catch { form = new FormData(); }
  const action = String(form.get("action") || "signin");
  const dev = devEnabled(env, url);
  if (action === "dev") {
    if (!dev) return new Response("Not found", { status: 404, headers: privateHeaders(new Headers({ "Content-Type": "text/plain; charset=utf-8" })) });
    const o = request.headers.get("Origin");
    if (o && o !== url.origin) return loginPage("Request blocked.", 403, {}, "signin", "", dev);
    let r = await getAuth(env);
    if (!r) { await createAuth(env, await newCredential(DEV_PASSWORD)); r = await getAuth(env); }
    return redirect("/app", { "Set-Cookie": cookie(await makeToken(env, r.epoch), SESSION_SECONDS, url) });
  }
  const mode = MODES[action] ? action : "signin";
  const get = (k) => String(form.get(k) || "");
  const page = (msg, status, extra) => loginPage(msg, status, extra, mode, "", dev);

  if (rec && rec.count >= MAX_FAILURES) {
    const wait = Math.ceil((rec.first + WINDOW_MS - now) / 1000);
    return page("Too many attempts. Try again in a few minutes.", 429, { "Retry-After": String(wait) });
  }

  // Same-origin check: a cross-site form post cannot log anyone in.
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin) return page("Request blocked.", 403);

  const row = await getAuth(env);
  if (mode === "setup" && row) return loginPage("A password is already set. Sign in.", 409, {}, "signin", "", dev);
  if (mode !== "setup" && !row) return loginPage("No password is set yet. Create one first.", 409, {}, "setup", "", dev);
  if ((mode === "setup" || mode === "forgot") && !env.RECOVERY_KEY) return page("The recovery key is not configured on the server.", 503);
  if (mode === "change" && !(await isAuthed(request, env))) return loginPage("Sign in first.", 401, {}, "signin", "", dev);

  const fail = async (msg) => {
    const count = (rec ? rec.count : 0) + 1;
    failures.set(ip, { count, first: rec ? rec.first : now });
    if (failures.size > 500) failures.delete(failures.keys().next().value);
    await new Promise((r) => setTimeout(r, env.LOGIN_DELAY_MS !== undefined ? Number(env.LOGIN_DELAY_MS) : Math.min(count * 600, 3000))); // slows guessing; wall time, not CPU time
    return page(msg, 401);
  };

  // Proof first: recovery key (setup, forgot), current password (change, signin).
  if (mode === "setup" || mode === "forgot") {
    if (!(await safeEqual(get("recovery").trim(), env.RECOVERY_KEY))) return fail("That recovery key is not right.");
  } else if (!(await verifyPassword(get("password"), row))) {
    return fail("That password is not right.");
  }

  if (mode === "signin") {
    failures.delete(ip);
    return redirect("/app", { "Set-Cookie": cookie(await makeToken(env, row.epoch), SESSION_SECONDS, url) });
  }

  const pw = get("new");
  if (pw.length < MIN_PASSWORD) return page(`Use at least ${MIN_PASSWORD} characters.`, 400);
  if (pw.length > MAX_PASSWORD) return page(`Use at most ${MAX_PASSWORD} characters.`, 400);
  if (pw !== get("confirm")) return page("The two passwords do not match.", 400);
  const cred = await newCredential(pw);
  failures.delete(ip);

  if (mode === "setup") {
    if (!(await createAuth(env, cred))) return loginPage("A password is already set. Sign in.", 409, {}, "signin", "", dev);
  } else {
    await replaceAuth(env, cred);
  }
  if (mode === "forgot") return loginPage("", 200, {}, "signin", "Password reset. Sign in with the new one.", dev);
  const fresh = await getAuth(env);
  return redirect("/app", { "Set-Cookie": cookie(await makeToken(env, fresh.epoch), SESSION_SECONDS, url) });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/api" || path.startsWith("/api/")) return handleApi(request, env, url);
    // Public read-only share links: no login, handled before the auth gate.
    if (path.startsWith("/s/")) return handleShare(request, env, url);
    const gated = path === "/app" || path.startsWith("/app/") || path === "/login" || path === "/logout";

    if (!gated) return env.ASSETS.fetch(request);

    if (!env.SESSION_SECRET || !env.DB) {
      return new Response("Login is not configured. Set SESSION_SECRET and bind the database.", {
        status: 503,
        headers: privateHeaders(new Headers({ "Content-Type": "text/plain; charset=utf-8" })),
      });
    }

    if (path === "/logout") {
      return redirect("/", { "Set-Cookie": cookie("", 0, url) });
    }

    const authed = await isAuthed(request, env);

    if (path === "/login") {
      if (request.method === "POST") return handleLogin(request, env, url);
      if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
      const mode = url.searchParams.get("mode");
      let row;
      try { row = await getAuth(env); } catch { return new Response("Run the database migrations (npm run db:migrate:local).", { status: 503, headers: privateHeaders(new Headers({ "Content-Type": "text/plain; charset=utf-8" })) }); }
      const dev = devEnabled(env, url);
      if (!row) return loginPage("", 200, {}, "setup", "", dev);
      if (mode === "change") return authed ? loginPage("", 200, {}, "change", "", dev) : redirect("/login");
      if (authed) return redirect("/app");
      return loginPage("", 200, {}, mode === "forgot" ? "forgot" : "signin", "", dev);
    }

    // /app and /app/*
    if (!authed) return redirect("/login");
    const res = await env.ASSETS.fetch(request);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: privateHeaders(new Headers(res.headers)) });
  },
  // Daily backup (Cron Trigger in wrangler.jsonc): src/backup.js.
  scheduled,
};
