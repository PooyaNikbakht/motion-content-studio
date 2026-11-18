const test = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM, boot } = require("./ui-harness.js");

const skip = !JSDOM && "jsdom not available (set JSDOM_PATH)";
const vaultFetch = async () => ({ ok: true, status: 200, json: async () => ({ text: "M", defaultText: "M", updatedAt: 1 }), text: async () => "" });
const open = (h) => [1, 2, 3, 4].map((n) => !h.$("#set" + n + "-body").hidden);

test("Setup cards: every card has a toggle; on a first run all are open, and the choice is remembered", { skip }, async () => {
  const h = await boot({ mode: "app", fetch: vaultFetch });
  const { $, $$, click, wait } = h;
  click($("#tab-setup")); await wait(100);
  assert.equal($$(".card-toggle").length, 4);
  assert.deepEqual(open(h), [true, true, true, true]);
  assert.equal($(".card-toggle[data-card=set2]").getAttribute("aria-label"), "Collapse Gemini AI Director");
  click($(".card-toggle[data-card=set2]"));
  assert.equal($("#set2-body").hidden, true);
  assert.equal($(".card-toggle[data-card=set2]").getAttribute("aria-expanded"), "false");
  assert.equal($(".card-toggle[data-card=set2]").getAttribute("aria-label"), "Expand Gemini AI Director");
  assert.ok($("#g-key"), "the fields stay in the page");
  assert.deepEqual(JSON.parse(h.w.localStorage.getItem("mbs_app:setupcards")), { set2: false });
  click($("#tab-overview") || $("#tab-import")); await wait(60);
  click($("#tab-setup")); await wait(100);
  assert.deepEqual(open(h), [true, false, true, true], "remembered after leaving and coming back");
  click($(".card-toggle[data-card=set2]"));
  assert.equal($("#set2-body").hidden, false);
  assert.deepEqual(h.errors, []);
});

test("Setup cards: once configured only the cards that still need something are open", { skip }, async () => {
  let h = await boot({ mode: "app", fetch: vaultFetch, settings: { apiKey: "sk_x", voiceId: "v", geminiKey: "AIza" } });
  h.click(h.$("#tab-setup")); await h.wait(100);
  assert.deepEqual(open(h), [false, false, false, false]);
  h = await boot({ mode: "app", fetch: vaultFetch, settings: { geminiKey: "AIza" } });
  h.click(h.$("#tab-setup")); await h.wait(100);
  assert.deepEqual(open(h), [true, false, false, false], "ElevenLabs still needs its key and voice");
});

test("Setup cards (demo): open on first visit", { skip }, async () => {
  const h = await boot({ mode: "demo" });
  h.click(h.$("#tab-setup")); await h.wait(100);
  assert.deepEqual(open(h), [true, true, true, true]);
});
