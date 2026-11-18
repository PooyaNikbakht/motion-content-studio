import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { handleApi } from "../src/api.js";
import worker from "../src/worker.js";
import { handleShare, hashToken, shareView } from "../src/share.js";
import { makeEnv, req, project, ORIGIN } from "./api-helpers.mjs";

const P = createRequire(import.meta.url)("../public/static/parser.js");
const parsed = P.parse(fs.readFileSync(new URL("../samples/sample-conversation.txt", import.meta.url), "utf8"), { startPhrase: P.DEFAULT_START_PHRASE });
const call = (env, r) => handleApi(r, env, new URL(r.url));
const getShare = (env, token, init) => handleShare(new Request(ORIGIN + "/s/" + token, init), env, new URL(ORIGIN + "/s/" + token));
const SECRET_NOTE = "PRIVATE-NOTE-9f3";

async function setup() {
  const m = makeEnv();
  const p = project("a", {
    name: "Secret Project Name", parsed, text: "FULL TEXT " + SECRET_NOTE,
    progress: { 1: { image: true, audio: true }, 2: { image: true, video: true } }, reelProgress: { 1: { img1: true, cover: true } }, thumbnailDone: true,
    audio: { 1: { status: "ready" } }, info: { title: "Info Title", notes: SECRET_NOTE, youtubeUrl: "https://youtu.be/x" }, ext: { history: [] },
  });
  await call(m.env, await req("PUT", "/api/projects/a", { body: p }));
  return m;
}
const create = async (env, body) => (await call(env, await req("POST", "/api/projects/a/shares", { body: body || {} }))).json();

test("shares API: signed in only, same-origin writes, expiry 1/7/30, default 7", async () => {
  const { env } = await setup();
  assert.equal((await call(env, await req("GET", "/api/projects/a/shares", { cookie: false }))).status, 401);
  assert.equal((await call(env, await req("POST", "/api/projects/a/shares", { body: {}, mbs: false }))).status, 403);
  assert.equal((await call(env, await req("POST", "/api/projects/a/shares", { body: { days: 3 } }))).status, 400);
  assert.equal((await call(env, await req("POST", "/api/projects/zzz/shares", { body: {} }))).status, 404);
  const a = await create(env);
  assert.match(a.url, /^https:\/\/studio\.test\/s\/[A-Za-z0-9_-]{43}$/);
  assert.ok(Math.abs(a.expiresAt - a.createdAt - 7 * 86400000) < 5);
  assert.ok(Math.abs((await create(env, { days: 1 })).expiresAt - Date.now() - 86400000) < 5000);
  assert.ok(Math.abs((await create(env, { days: 30 })).expiresAt - Date.now() - 30 * 86400000) < 5000);
});

test("only the SHA-256 of the token is stored", async () => {
  const { env, shares } = await setup();
  const { url } = await create(env);
  const token = url.split("/s/")[1];
  assert.equal(shares.size, 1);
  const row = [...shares.values()][0];
  assert.equal(row.token_hash, await hashToken(token));
  assert.equal(row.token_hash.length, 64);
  assert.ok(!JSON.stringify([...shares.values()]).includes(token));
  const st = await (await call(env, await req("GET", "/api/projects/a/shares"))).json();
  assert.deepEqual(Object.keys(st).sort(), ["active", "createdAt", "expiresAt"], "the link itself is never returned again");
});

test("one active link per project: a new one revokes the old one", async () => {
  const { env } = await setup();
  const t1 = (await create(env)).url.split("/s/")[1];
  assert.equal((await getShare(env, t1)).status, 200);
  const t2 = (await create(env)).url.split("/s/")[1];
  assert.equal((await getShare(env, t1)).status, 404);
  assert.equal((await getShare(env, t2)).status, 200);
});

test("revoke, expiry, wrong and malformed tokens all answer the same 404", async () => {
  const { env, shares } = await setup();
  const t = (await create(env)).url.split("/s/")[1];
  const bodies = new Set();
  for (const bad of ["x", "A".repeat(43), t.slice(0, -1) + (t.endsWith("A") ? "B" : "A"), "../etc"]) {
    const r = await getShare(env, bad);
    assert.equal(r.status, 404, bad);
    bodies.add(await r.text());
  }
  [...shares.values()][0].expires_at = Date.now() - 1;
  const expired = await getShare(env, t);
  assert.equal(expired.status, 404);
  bodies.add(await expired.text());
  assert.equal(bodies.size, 1, "no hint which case it was");
  [...shares.values()][0].expires_at = Date.now() + 1e6;
  assert.equal((await getShare(env, t)).status, 200);
  assert.equal((await call(env, await req("DELETE", "/api/projects/a/shares"))).status, 204);
  assert.equal((await getShare(env, t)).status, 404);
  assert.equal((await (await call(env, await req("GET", "/api/projects/a/shares"))).json()).active, false);
});

test("the shared page has prompts and progress only, no narration, notes, titles, captions or project name", async () => {
  const { env } = await setup();
  const t = (await create(env)).url.split("/s/")[1];
  const html = await (await getShare(env, t)).text();
  assert.ok(html.includes(parsed.scenes[0].imagePrompt.slice(0, 40)), "has an image prompt");
  assert.ok(html.includes(parsed.thumbnail.prompt.slice(0, 40)), "has the cover prompt");
  assert.ok(html.includes(parsed.reels[0].images[0].prompt.slice(0, 40)), "has a reel prompt");
  assert.match(html, /Done/); assert.match(html, /To do/);
  const forbidden = [
    ...parsed.scenes.map((s) => s.narration), ...parsed.chunks.map((c) => c.text.slice(0, 40)),
    ...parsed.reels.flatMap((r) => [r.coverHeadline, r.caption, ...r.images.map((i) => i.narration), r.audio && r.audio.text]),
    parsed.youtubeTitle, parsed.caption, parsed.coverHeadline, SECRET_NOTE, "Info Title", "youtu.be", "Secret Project Name", "FULL TEXT",
  ].filter((x) => x && x.length > 8);
  assert.ok(forbidden.length > 10);
  forbidden.forEach((f) => assert.ok(!html.includes(f), "leaked: " + f.slice(0, 40)));
  assert.ok(!/<script/i.test(html));
});

test("shareView is an allowlist of prompts and done flags", () => {
  const v = shareView(parsed, { progress: { 1: { image: true } } });
  assert.deepEqual(Object.keys(v).sort(), ["cover", "reels", "scenes"]);
  assert.deepEqual(Object.keys(v.scenes[0]).sort(), ["hasVideo", "imageDone", "imagePrompt", "number", "videoDone", "videoPrompt"]);
  assert.equal(v.scenes[0].imageDone, true);
  assert.deepEqual(Object.keys(v.reels[0]).sort(), ["cover", "id", "images", "name", "videos"]);
  assert.deepEqual(Object.keys(v.reels[0].images[0]).sort(), ["done", "label", "prompt"]);
});

test("headers: noindex, no referrer, no store, no framing", async () => {
  const { env } = await setup();
  const t = (await create(env)).url.split("/s/")[1];
  for (const r of [await getShare(env, t), await getShare(env, "bad")]) {
    assert.equal(r.headers.get("X-Robots-Tag"), "noindex, nofollow");
    assert.equal(r.headers.get("Referrer-Policy"), "no-referrer");
    assert.equal(r.headers.get("Cache-Control"), "no-store");
    assert.equal(r.headers.get("X-Frame-Options"), "DENY");
    assert.match(r.headers.get("Content-Security-Policy"), /default-src 'none'/);
  }
});

test("public route: no login needed, rate limited, GET only, reached through the Worker before the auth gate", async () => {
  const m = await setup();
  const t = (await create(m.env)).url.split("/s/")[1];
  const viaWorker = await worker.fetch(new Request(ORIGIN + "/s/" + t), Object.assign({}, m.env, { ASSETS: { fetch: () => { throw new Error("must not reach assets"); } } }));
  assert.equal(viaWorker.status, 200);
  assert.equal((await getShare(m.env, t, { method: "POST" })).status, 405);
  m.limit.allow = false;
  const r = await getShare(m.env, t, { headers: { "CF-Connecting-IP": "9.9.9.9" } });
  assert.equal(r.status, 429);
  assert.equal(m.limit.calls.at(-1).key, "share:9.9.9.9");
});

test("deleting a project turns its link off", async () => {
  const { env, shares } = await setup();
  const t = (await create(env)).url.split("/s/")[1];
  await call(env, await req("DELETE", "/api/projects/a"));
  assert.equal(shares.size, 0);
  assert.equal((await getShare(env, t)).status, 404);
});
