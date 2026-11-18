const test = require("node:test");
const assert = require("node:assert/strict");

globalThis.window = globalThis;
require("../public/static/audio.js");
const A = window.MBSAudio;

const reply = (status, body) => async () => ({ ok: status < 400, status, json: async () => body });

test("Flash v2.5 is a model with the 40,000 character limit and free stability", () => {
  assert.equal(A.MODELS.eleven_flash_v2_5.maxChars, 40000);
  assert.equal(A.snapStability("eleven_flash_v2_5", 0.37), 0.35);
  assert.equal(A.MODELS.eleven_v3.maxChars, 5000);
  assert.equal(A.MODELS.eleven_v4.maxChars, 10000);
  assert.equal(Object.keys(A.MODELS)[0], "eleven_v4");
  assert.equal(A.snapStability("eleven_v4", 0.37), 0.35);
  assert.equal(A.MODELS.eleven_multilingual_v2.maxChars, 10000);
});

test("subscription reads character_count, character_limit and the reset time", async () => {
  let seen;
  globalThis.fetch = async (url, o) => { seen = [url, o.headers["xi-api-key"]]; return reply(200, { tier: "creator", character_count: 1200, character_limit: 100000, next_character_count_reset_unix: 1796000000 })(); };
  const s = await A.subscription("sk_test");
  assert.deepEqual(s, { used: 1200, limit: 100000, resetUnix: 1796000000, tier: "creator" });
  assert.deepEqual(seen, ["https://api.elevenlabs.io/v1/user/subscription", "sk_test"]);
});

test("subscription fails with a TtsError when the key cannot read it or the answer is odd", async () => {
  globalThis.fetch = reply(401, {});
  await assert.rejects(A.subscription("k"), (e) => e.name === "TtsError" && e.status === 401);
  globalThis.fetch = reply(200, { tier: "free" });
  await assert.rejects(A.subscription("k"), /no credit counts/);
  globalThis.fetch = async () => { throw new TypeError("offline"); };
  await assert.rejects(A.subscription("k"), (e) => e.retryable === true);
});

test("preview model defaults to Flash, stays valid for every model, and Flash is priced at half", () => {
  const E = require("../public/static/estimate.js");
  assert.equal(A.PREVIEW_MODEL, "eleven_flash_v2_5");
  assert.equal(E.PREVIEW_MODEL, "eleven_flash_v2_5");
  assert.equal(E.estimate(["x".repeat(100)], A.PREVIEW_MODEL, {}).credits, 50);
  assert.equal(E.estimate(["x".repeat(100)], "eleven_v4", {}).credits, 100);
  for (const m of Object.keys(A.MODELS)) assert.ok(A.MODELS[m].maxChars >= 170);
  assert.equal(A.snapStability(A.PREVIEW_MODEL, 0.5), 0.5);
  assert.equal(A.snapStability("eleven_v3", 0.37), 0.5);
});
