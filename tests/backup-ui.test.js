const test = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM, boot } = require("./ui-harness.js");

const skip = !JSDOM && "jsdom not available (set JSDOM_PATH)";
const run = { startedAt: "2026-11-18T03:17:00.000Z", ok: true, db: { totalRows: 42 }, media: { copied: 3, remaining: 5, failed: [] } };
const fetcher = (status, calls) => async (url, o) => {
  if (String(url).startsWith("/api/backup/status")) return { ok: true, status: 200, json: async () => status, text: async () => "" };
  if (String(url).startsWith("/api/backup/run")) { calls.push(o); return { ok: true, status: 200, json: async () => ({ configured: true, lastRun: run }), text: async () => "" }; }
  return { ok: true, status: 200, json: async () => ({ text: "M", defaultText: "M", updatedAt: 1 }), text: async () => "" };
};

test("Setup shows a Backups card in /app with the last run, and Run backup now posts and updates it", { skip }, async () => {
  const calls = [];
  const h = await boot({ mode: "app", fetch: fetcher({ configured: true, lastRun: null }, calls) });
  h.click(h.$("#tab-setup")); await h.wait(150);
  assert.ok(h.$("#set-backup"));
  assert.match(h.$("#bk-sum").textContent, /No backup has run yet/);
  h.click(h.$("#bk-run")); await h.wait(100);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.match(h.$("#bk-sum").textContent, /42 database rows, 3 media files copied this run, 5 still to copy/);
  assert.deepEqual(h.errors, []);
});

test("Setup has no Backups card in /demo or when the server has no backup status", { skip }, async () => {
  const d = await boot({ mode: "demo" });
  d.click(d.$("#tab-setup")); await d.wait(100);
  assert.equal(d.$("#set-backup"), null);
  const a = await boot({ mode: "app", fetch: fetcher({}, []) });
  a.click(a.$("#tab-setup")); await a.wait(100);
  assert.equal(a.$("#set-backup"), null);
});
