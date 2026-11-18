const test = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM, boot } = require("./ui-harness.js");

const skip = !JSDOM && "jsdom not available (set JSDOM_PATH)";

test("Setup (app): Gemini card, Master Director Prompt card in the Setup tab, no native select, key kept per mode and not sent anywhere", { skip }, async () => {
  const fetchLog = [];
  const h = await boot({ mode: "app", fetch: async (u, init) => { fetchLog.push([u, init && init.method]); return { ok: true, status: 200, json: async () => ({ text: "Secret master text", defaultText: "Secret master text", updatedAt: 5 }), text: async () => "" }; }, settings: { startPhrase: "x" } });
  const { $, $$, click, input, wait } = h;
  click($("#tab-setup")); await wait(120);
  assert.deepEqual($$("#panel h3").map((x) => x.textContent).slice(0, 4), ["ElevenLabs", "Gemini AI Director", "Output folder and audio preferences", "Master Director Prompt"]);
  assert.equal($("#g-key").type, "password");
  assert.equal($("#g-state").textContent, "Needs API key");
  assert.equal($("#g-model .dd-val").textContent, "gemini-3.8-flash - Fast and low cost (default)");
  assert.equal($("#panel select"), null);
  assert.match($("#s-model .dd-val").textContent, /^eleven_v4 - Eleven v4/);
  click($("#s-model")); await wait(10);
  assert.equal($$("#s-model-list li")[0].textContent.split(" - ")[0], "eleven_v4");
  click($("#s-model")); await wait(10);
  assert.ok($('[data-rate="eleven_v4"]'), "v4 rate is editable");
  assert.ok($$("[data-grate]").length >= 8, "editable token rates");
  assert.ok($("#g-key").closest("section").querySelector(".subsec [data-grate]"), "token rates sit inside the Gemini card");
  const eleven = $("#s-key").closest("section");
  assert.ok(eleven.querySelector(".subsec [data-rate]") && eleven.querySelector("#plan") && eleven.querySelector("#sub-refresh"), "credit rates and plan sit inside the ElevenLabs card");
  input($("#g-key"), "AIzaTEST");
  assert.equal($("#g-state").textContent, "Ready");
  assert.equal(h.settings.geminiKey, "AIzaTEST");
  click($("#g-model")); await wait(10);
  assert.deepEqual($$("#g-model-list li").slice(0, 2).map((x) => x.textContent.split(" - ")[0]), ["gemini-3.8-flash", "gemini-4-hydrogen"]);
  // vault card shows the saved text and its counts, with Copy / Edit / Reset / Set default
  assert.match($("#sv-box").textContent, /Secret master text/);
  assert.deepEqual($$("#sv-body .dp-actions button").map((b) => b.textContent.trim()), ["Copy Master Prompt", "Edit", "Reset to default", "Set current as my default"]);
  assert.match($("#sv-body .dp-actions .muted:last-child").textContent, /18 characters, about \d+ tokens/);
  // the key is never part of a request to this site's own API
  assert.ok(!JSON.stringify(h.calls).includes("AIzaTEST"));
  assert.deepEqual(h.errors, []);
});

test("Setup (demo): the Gemini card says simulated and its fields are off", { skip }, async () => {
  const h = await boot({ mode: "demo" });
  h.click(h.$("#tab-setup")); await h.wait(120);
  assert.equal(h.$("#g-state").textContent, "Simulated");
  assert.equal(h.$("#g-key").disabled, true);
  assert.equal(h.$("#g-test").disabled, true);
  assert.match(h.$("#sv-box").textContent, /DEMO TEMPLATE/);
  assert.ok(!h.calls.some((c) => /googleapis/.test(String(c[0]))));
});

test("Setup (app): the local-copies row shows only while the old browser database has projects", { skip }, async () => {
  const mk = async (legacyProjects) => {
    const dom = require("./ui-harness.js");
    return dom.boot({
      mode: "app", bootWait: 50,
      fetch: async (u) => ({ ok: true, status: 200, json: async () => (String(u).includes("director") ? { text: "", defaultText: "", updatedAt: 0 } : { projects: [] }), text: async () => "" }),
    }).then(async (h) => {
      h.w.indexedDB = { databases: async () => [{ name: "mbs_app_db" }], deleteDatabase: () => { const r = {}; setTimeout(() => r.onsuccess && r.onsuccess(), 0); return r; } };
      h.w.MBSStore.create = () => ({ listProjects: async () => legacyProjects, listFolders: async () => [] });
      h.store.raw = async () => ({ ok: true, json: async () => ({ projects: [] }) });
      return h;
    });
  };
  let h = await mk([{ id: "o1", name: "Old", audio: {} }, { id: "o2", name: "Old 2", audio: {} }]);
  h.click(h.$("#tab-setup")); await h.wait(200);
  assert.ok(h.$("#set-local"), "row is shown");
  assert.match(h.$("#set-local").textContent, /2 projects/);
  assert.deepEqual(h.$$("#set-local .row button").map((b) => b.textContent.trim()), ["Upload", "Delete local copies"]);
  h.click(h.$("#loc-del")); await h.wait(30);
  assert.match(h.$("#dlg").textContent, /permanently removes the old browser-only copies\. Server projects are not affected\./);
  h.click(h.$$("#dlg button").find((b) => /Delete local copies/.test(b.textContent))); await h.wait(60);
  assert.equal(h.$("#set-local"), null, "row is gone after deleting");
  h = await mk([]);
  h.click(h.$("#tab-setup")); await h.wait(200);
  assert.equal(h.$("#set-local"), null, "no row when the old database is empty");
});
