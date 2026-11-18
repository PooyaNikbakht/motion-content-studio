const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../public/static/parser.js");
const { JSDOM, boot } = require("./ui-harness.js");

const skip = !JSDOM && "jsdom not available (set JSDOM_PATH)";
const vaultFetch = async () => ({ ok: true, status: 200, json: async () => ({ text: "M", defaultText: "M", updatedAt: 1 }), text: async () => "" });

test("the start phrase is an optional fallback parse option: each project can use its own, and none gives the actionable warning", () => {
  const text = "Alpha one. First chunk.\n\n---\n\nBeta two. Second chunk.";
  assert.equal(P.parse(text, { startPhrase: "Alpha one" }).stats.audioChunks, 1);
  assert.equal(P.parse(text, { startPhrase: "Beta two" }).stats.audioChunks, 1);
  const none = P.parse(text, { startPhrase: "" });
  assert.equal(none.stats.audioChunks, 0);
  assert.deepEqual(none.warnings, ["No audio chunks found. Expected **Audio chunk 1** labels with the text in a code block (or, for older conversations, the chunk start phrase from step 1)."]);
});

test("app: Load sample finds 6 chunks by their labels with no start phrase and no warning; the phrase stays empty", { skip }, async () => {
  let h;
  const fetch = async (u) => (String(u).includes("sample") ? { ok: true, text: async () => h.sample } : vaultFetch());
  h = await boot({ mode: "app", projects: [{ id: "p0", name: "E" }], fetch });
  const { $, $$, click, wait } = h;
  click($("#tab-import")); await wait(60);
  click($("#mode-paste")); await wait(60);
  assert.equal(h.settings.startPhrase, "");
  click($("#load-sample")); await wait(300);
  assert.equal(h.projs.get("p0").parsed.stats.audioChunks, 6);
  assert.equal($$("#result .warn").length, 0);
  assert.equal($("#phrase").value, "");
  assert.equal(h.settings.startPhrase, "", "the global setting is not touched");
  await wait(1000);
  assert.ok(!h.projs.get("p0").ext || !h.projs.get("p0").ext.startPhrase);
});

test("app: Parse without any start phrase still parses scenes, shows the field error, focuses the field and offers Set start phrase", { skip }, async () => {
  const h = await boot({ mode: "app", projects: [{ id: "p0", name: "E" }], fetch: vaultFetch });
  const { $, click, wait } = h;
  click($("#tab-import")); await wait(60);
  click($("#mode-paste")); await wait(60);
  $("#paste").value = "## Step 2\n\n**Scene Number: [01]**\n**Image Prompt:**\n```\na lighthouse\n```\n\nHello there. Some narration.";
  click($("#parse-btn")); await wait(200);
  assert.equal(h.projs.get("p0").parsed.stats.imageScenes, 1, "scenes are still parsed");
  assert.equal($("#phrase-err").hidden, false);
  assert.equal($("#phrase-err").textContent, "No audio chunks found. Use Audio chunk labels with the text in a code block, or set the start phrase for an older conversation");
  assert.equal(h.w.document.activeElement.id, "phrase");
  const btn = $("[data-focus-phrase]");
  assert.ok(btn && /Set start phrase/.test(btn.textContent));
  h.input($("#phrase"), "Hello there");
  assert.equal($("#phrase-err").hidden, true);
  click($("#parse-btn")); await wait(200);
  assert.equal(h.projs.get("p0").parsed.stats.audioChunks, 1);
});

test("a project keeps its own phrase over the global default", { skip }, async () => {
  const h = await boot({ mode: "app", projects: [{ id: "p0", name: "A", ext: { startPhrase: "Own phrase" } }], fetch: vaultFetch, settings: { startPhrase: "Global phrase" } });
  h.click(h.$("#tab-import")); await h.wait(60);
  h.click(h.$("#mode-paste")); await h.wait(60);
  assert.equal(h.$("#phrase").value, "Own phrase");
});

test("How it works: expanded in the demo even for a parsed project (until hidden), collapsed in the app; step texts follow the mode", { skip }, async () => {
  const parsedP = P.parse(require("node:fs").readFileSync(require("node:path").join(__dirname, "../samples/sample-conversation.txt"), "utf8"), { startPhrase: P.DEFAULT_START_PHRASE });
  const demo = await boot({ mode: "demo", projects: [{ id: "p0", name: "A", parsed: parsedP }] });
  demo.click(demo.$("#tab-import")); await demo.wait(80);
  assert.equal(demo.$("#how-body").hidden, false);
  assert.match(demo.$("#how-body").textContent, /short generic English sample; in the real app it holds your own prompt/);
  assert.ok(demo.$("#how-dp"), "Open Director Prompt stays");
  assert.match(demo.$("#how-body").textContent, /simulated, so no key is needed/);
  assert.match(demo.$("#how-body").textContent, /files stay in your browser/);
  demo.click(demo.$("#how-toggle")); await demo.wait(30);
  assert.equal(demo.$("#how-body").hidden, true, "the visitor can hide it");
  const app = await boot({ mode: "app", projects: [{ id: "p0", name: "A", parsed: parsedP }], fetch: vaultFetch });
  app.click(app.$("#tab-import")); await app.wait(80);
  assert.equal(app.$("#how-body").hidden, true);
  assert.ok(!/generic English sample|simulated|stay in your browser/.test(app.$("#how-body").textContent));
});
