// Read-only share links. A link shows a project's image, video and cover PROMPTS and their progress, nothing else:
// no narration, audio, notes, publishing info, titles or captions.
//
//   token       32 random bytes, base64url (43 characters). Only its SHA-256 is stored, so a database leak does not leak links.
//   one link    per project: creating a new one revokes the old one.
//   expiry      1, 7 (default) or 30 days. Expired, revoked and unknown tokens all answer the same 404.
//   GET /s/:token is public (no login), rate limited, rendered on the server, no JavaScript, never cached, never indexed.
// Bindings: DB (D1), API_LIMIT (optional).

const DAY = 24 * 60 * 60 * 1000;
export const EXPIRY_DAYS = [1, 7, 30];
export const DEFAULT_DAYS = 7;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

const b64url = (bytes) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export const newToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));

export async function hashToken(token) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return Array.from(d, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Creates the project's link (revoking any earlier one). Returns { token, createdAt, expiresAt }; the token is not stored. */
export async function createShare(env, projectId, days) {
  const d = EXPIRY_DAYS.includes(days) ? days : DEFAULT_DAYS;
  const now = Date.now(), token = newToken();
  await env.DB.prepare("UPDATE shares SET revoked_at = ? WHERE project_id = ? AND revoked_at IS NULL").bind(now, projectId).run();
  await env.DB.prepare("INSERT INTO shares (token_hash, project_id, created_at, expires_at) VALUES (?, ?, ?, ?)").bind(await hashToken(token), projectId, now, now + d * DAY).run();
  return { token, createdAt: now, expiresAt: now + d * DAY };
}

/** { createdAt, expiresAt } of the project's live link, or null. */
export async function activeShare(env, projectId) {
  const r = await env.DB.prepare("SELECT created_at, expires_at FROM shares WHERE project_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1").bind(projectId, Date.now()).first();
  return r ? { createdAt: r.created_at, expiresAt: r.expires_at } : null;
}

export async function revokeShares(env, projectId) {
  await env.DB.prepare("UPDATE shares SET revoked_at = ? WHERE project_id = ? AND revoked_at IS NULL").bind(Date.now(), projectId).run();
}

/** The project id for a live token, or null (malformed, unknown, revoked or expired all look the same). */
export async function lookupShare(env, token) {
  if (!TOKEN_RE.test(token || "")) return null;
  const r = await env.DB.prepare("SELECT project_id, expires_at, revoked_at FROM shares WHERE token_hash = ?").bind(await hashToken(token)).first();
  if (!r || r.revoked_at || r.expires_at <= Date.now()) return null;
  return r.project_id;
}

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = (n) => String(n).padStart(2, "0");

/**
 * The only fields a share view may use: prompts and done flags. Built from an allowlist, so a new field on the
 * project can never leak into a link by accident.
 */
export function shareView(parsed, state) {
  const p = parsed || {}, prog = (state && state.progress) || {}, rprog = (state && state.reelProgress) || {};
  const flag = (obj, id, k) => !!(obj[id] && obj[id][k]);
  const scenes = (p.scenes || []).map((s) => ({
    number: s.number, imagePrompt: s.imagePrompt || "", hasVideo: !!s.hasVideo, videoPrompt: s.hasVideo ? s.videoPrompt || "" : "",
    imageDone: flag(prog, s.number, "image"), videoDone: s.hasVideo ? flag(prog, s.number, "video") : null,
  }));
  const reels = (p.reels || []).map((r) => {
    const rp = rprog[r.id] || {};
    const vids = r.videos || (r.video ? [r.video] : []);
    return {
      id: r.id, name: r.name || "Reel " + pad(r.id),
      images: (r.images || []).map((im, i) => ({ label: im.label || "R" + pad(r.id) + "-" + pad(i + 1), prompt: im.prompt || "", done: !!(rp["img" + (i + 1)] || rp.image) })),
      videos: vids.map((v, i) => ({ prompt: v.prompt || "", done: !!(rp["vid" + (i + 1)] || (i === 0 && rp.video)) })),
      cover: r.cover ? { prompt: r.cover.prompt || "", done: !!rp.cover } : null,
    };
  });
  return { scenes, cover: p.thumbnail ? { prompt: p.thumbnail.prompt || "", done: !!(state && state.thumbnailDone) } : null, reels };
}

const pill = (done) => '<span class="pill ' + (done ? "done" : "todo") + '">' + (done ? "Done" : "To do") + "</span>";
const card = (title, ratio, parts) => '<article class="card"><header><h3>' + esc(title) + '</h3><span class="ratio">' + ratio + "</span></header>" + parts.join("") + "</article>";
const prompt = (label, text, done) => '<div class="pbox"><div class="plabel"><span>' + esc(label) + "</span>" + (done === null ? "" : pill(done)) + '</div><pre class="prompt">' + esc(text || "(none)") + "</pre></div>";

export function renderShare(view, expiresAt) {
  const count = (list) => list.length;
  const all = [];
  view.scenes.forEach((s) => { all.push(s.imageDone); if (s.hasVideo) all.push(s.videoDone); });
  view.reels.forEach((r) => { r.images.forEach((i) => all.push(i.done)); r.videos.forEach((v) => all.push(v.done)); if (r.cover) all.push(r.cover.done); });
  if (view.cover) all.push(view.cover.done);
  const done = all.filter(Boolean).length;
  const sections = [];
  if (view.scenes.length) sections.push("<section><h2>16:9 scenes (" + count(view.scenes) + ")</h2>" + view.scenes.map((s) => card("Scene " + pad(s.number), "16:9", [prompt("Image prompt", s.imagePrompt, s.imageDone)].concat(s.hasVideo ? [prompt("Video prompt", s.videoPrompt, s.videoDone)] : []))).join("") + "</section>");
  if (view.cover) sections.push("<section><h2>YouTube cover</h2>" + card("YouTube cover", "16:9", [prompt("Cover prompt", view.cover.prompt, view.cover.done)]) + "</section>");
  view.reels.forEach((r) => {
    sections.push("<section><h2>" + esc(r.name) + " (9:16)</h2>" +
      r.images.map((i) => card(i.label, "9:16", [prompt("Image prompt", i.prompt, i.done)])).join("") +
      r.videos.map((v, k) => card("Animation " + (k + 1), "9:16", [prompt("Video prompt", v.prompt, v.done)])).join("") +
      (r.cover ? card("Reel cover", "9:16", [prompt("Cover prompt", r.cover.prompt, r.cover.done)]) : "") + "</section>");
  });
  const days = Math.max(0, Math.ceil((expiresAt - Date.now()) / DAY));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>Shared prompts</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0B0F19; color: #E6E8EB; font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 860px; margin: 0 auto; padding: 24px 16px 48px; }
  h1 { font-size: 1.4rem; margin: 0 0 4px; }
  h2 { font-size: 1.05rem; margin: 28px 0 10px; }
  h3 { font-size: 1rem; margin: 0; }
  .meta { color: #9AA3AF; font-size: .9rem; margin: 0 0 16px; }
  .card { background: #151C2C; border-left: 2px solid #3a4560; border-radius: 12px; padding: 14px 18px; margin: 0 0 12px; }
  .card header { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
  .ratio { font-size: .75rem; color: #9AA3AF; background: #1B2438; border-radius: 999px; padding: 0 8px; }
  .plabel { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: .8rem; color: #9AA3AF; margin-bottom: 4px; }
  .prompt { margin: 0; padding: 10px 12px; background: #0B0F19; border-radius: 8px; white-space: pre-wrap; overflow-wrap: anywhere; font: .8125rem/1.6 ui-monospace, Menlo, Consolas, monospace; direction: ltr; text-align: left; }
  .pbox + .pbox { margin-top: 10px; }
  .pill { font-size: .75rem; font-weight: 600; }
  .pill.done { color: #34d399; }
  .pill.todo { color: #9AA3AF; }
</style>
</head>
<body>
<main>
<h1>Shared prompts</h1>
<p class="meta">Read-only. ${done} of ${all.length} items done. Image, video and cover prompts only. This link expires in ${days} day${days === 1 ? "" : "s"}.</p>
${sections.join("\n") || "<p>No prompts in this project yet.</p>"}
</main>
</body>
</html>`;
}

const shareHeaders = (extra) => new Headers({
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  ...extra,
});

const notFound = () => new Response('<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>Link not available</title><body style="font:16px system-ui;background:#0B0F19;color:#E6E8EB;padding:32px"><h1>This link is not available</h1><p>It may have expired or been turned off.</p>', { status: 404, headers: shareHeaders({ "Content-Type": "text/html; charset=utf-8" }) });

/** GET /s/:token, public. */
export async function handleShare(request, env, url) {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: shareHeaders({ Allow: "GET, HEAD" }) });
  if (env.API_LIMIT) {
    const { success } = await env.API_LIMIT.limit({ key: "share:" + (request.headers.get("CF-Connecting-IP") || "local") });
    if (!success) return new Response("Too many requests", { status: 429, headers: shareHeaders({ "Retry-After": "30", "Content-Type": "text/plain; charset=utf-8" }) });
  }
  const token = decodeURIComponent(url.pathname.slice(3)).replace(/\/$/, "");
  const projectId = await lookupShare(env, token);
  if (!projectId) return notFound();
  const row = await env.DB.prepare("SELECT parsed_json, state_json FROM projects WHERE id = ?").bind(projectId).first();
  if (!row) return notFound();
  const share = await env.DB.prepare("SELECT project_id, expires_at, revoked_at FROM shares WHERE token_hash = ?").bind(await hashToken(token)).first();
  const html = renderShare(shareView(row.parsed_json ? JSON.parse(row.parsed_json) : null, JSON.parse(row.state_json || "{}")), share.expires_at);
  return new Response(request.method === "HEAD" ? null : html, { headers: shareHeaders({ "Content-Type": "text/html; charset=utf-8" }) });
}
