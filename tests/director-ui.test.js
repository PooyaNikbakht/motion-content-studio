const test = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM, boot } = require("./ui-harness.js");

const skip = !JSDOM && "jsdom not available (set JSDOM_PATH)";
const empty = [{ id: "p0", name: "Empty" }];
const vaultFetch = (text) => async () => ({ ok: true, status: 200, json: async () => ({ text, defaultText: text, updatedAt: 1 }), text: async () => "" });

test("AI Director mode (app): numbered cards, language dropdown, PDF zone, run controls; no select; Start disabled without a key, with a link to Setup", { skip }, async () => {
  const h = await boot({ mode: "app", projects: empty, fetch: vaultFetch("MASTER") });
  const { $, $$, click, wait } = h;
  click($("#tab-import")); await wait(80);
  assert.equal($("#mode-ai").getAttribute("aria-pressed"), "true");
  assert.deepEqual($$(".imp-mode .btn").map((b) => b.textContent), ["AI Director (Auto-Generate)", "Paste Conversation"]);
  assert.deepEqual($$("#ad-root h3").map((x) => x.textContent).slice(0, 3), ["Output language", "The book", "Run the director"]);
  assert.equal($("#ad-root select"), null);
  assert.ok($("#ad-lang .dd-val").textContent);
  assert.ok($("#ad-drop") && $("#ad-file").accept.includes("pdf") && $("#ad-title") && $("#ad-sum"));
  assert.deepEqual(["#ad-start", "#ad-next", "#ad-auto", "#ad-stop"].map((s) => $(s).textContent.trim()), ["Start Project", "Next Step", "Auto-Run All 6 Stages", "Stop"]);
  assert.equal($("#ad-start").disabled, true);
  const note = $("#ad-keynote");
  assert.equal(note.hidden, false);
  assert.equal(note.textContent.trim(), "Configure your Gemini API key in Setup to run directly here.");
  assert.equal($("#ad-keynote a").getAttribute("href"), "#setup");
  assert.match($("#ad-reason-text").textContent, /Gemini API key/);
  assert.match($("#ad-cost").textContent, /Estimated about \$\d+\.\d\d \(range \$\d+\.\d\d to \$\d+\.\d\d\) for a full run, actual so far \$0\.00/);
  assert.match($("#ad-cost").textContent, /estimate/i);
  click($("#ad-keynote a")); await wait(50);
  assert.ok($("#g-key"), "the link opens Setup");
  assert.deepEqual(h.errors, []);
});

test("AI Director mode (app): with a key and a vault prompt Start waits for the book input; an empty vault links to Setup", { skip }, async () => {
  let h = await boot({ mode: "app", projects: empty, fetch: vaultFetch(""), settings: { geminiKey: "AIzaX" } });
  h.click(h.$("#tab-import")); await h.wait(80);
  assert.equal(h.$("#ad-vaultnote").hidden, false);
  assert.match(h.$("#ad-reason-text").textContent, /Master Director Prompt is empty/);
  h = await boot({ mode: "app", projects: empty, fetch: vaultFetch("MASTER"), settings: { geminiKey: "AIzaX" } });
  h.click(h.$("#tab-import")); await h.wait(80);
  assert.equal(h.$("#ad-keynote").hidden, true);
  assert.equal(h.$("#ad-start").disabled, true);
  assert.match(h.$("#ad-reason-text").textContent, /PDF, a title or a summary/);
  h.input(h.$("#ad-title"), "My Book");
  assert.equal(h.$("#ad-start").disabled, false);
  assert.equal(h.$("#ad-reason").hidden, true);
  await h.pick("ad-lang", "Persian");
  assert.match(h.$("#ad-phrase-note").textContent, /No start phrase is set/);
});

test("Paste Conversation mode keeps the original screen intact and the choice is remembered per project", { skip }, async () => {
  const h = await boot({ mode: "app", projects: empty, fetch: vaultFetch("M") });
  h.click(h.$("#tab-import")); await h.wait(60);
  h.click(h.$("#mode-paste")); await h.wait(60);
  assert.ok(h.$("#lang") && h.$("#phrase") && h.$("#paste") && h.$("#parse-btn") && h.$("#load-sample") && h.$("#result"));
  assert.deepEqual(h.$$("#imp-mode h3").map((x) => x.textContent).slice(0, 2), ["Language and start phrase", "Paste the conversation"]);
  await h.wait(1000);
  assert.equal(h.projs.get("p0").ext.dirUi.mode, "paste");
});

test("demo: the simulated director runs 8 turns without any network call and fills the YouTube and Reels tabs", { skip }, async () => {
  const h = await boot({ mode: "demo", projects: empty });
  const { $, $$, click, wait } = h;
  h.w.MBS_SIM_MS = 40;
  click($("#tab-import")); await wait(80);
  assert.equal($("#ad-keynote").hidden, true);
  assert.equal($("#ad-start").disabled, false, "no key needed in the demo");
  assert.match($("#ad-cost").textContent, /^Simulated: Estimated about/);
  click($("#ad-auto"));
  for (let i = 0; i < 80 && !/All 6 stages are complete/.test($("#ad-status").textContent); i++) await wait(100);
  assert.match($("#ad-status").textContent, /All 6 stages are complete/);
  assert.equal($("#ad-turns").textContent, "Turn 8 of up to 45");
  assert.equal($("#ad-stage").textContent, "Stage 6 of 6: Reels and covers");
  assert.equal($$("#ad-log li").length, 8);
  assert.match($("#ad-log li").textContent, /simulated/);
  assert.match($("#ad-cost").textContent, /actual so far \$0\.\d\d/);
  assert.equal($("#ad-found").hidden, false);
  assert.ok($("#ad-stream").textContent.length > 100, "the last reply stays visible");
  click($("#ad-yt")); await wait(60);
  assert.ok($$("#subpanel .icard").length >= 6, "YouTube audio cards");
  click($("#tab-reels")); await wait(60);
  assert.ok($$("#subbar .subtab").length >= 3, "three reels");
  assert.ok(!h.calls.some((c) => /googleapis|generativelanguage/.test(String(c[0]))), "no API call in the demo");
  await wait(1000);
  const saved = h.projs.get("p0");
  assert.deepEqual(saved.parsed.stats, { audioChunks: 6, imageScenes: 8, animations: 3, reels: 3, reelAudio: 3 });
  assert.equal(saved.ext.director.status, "done");
  assert.equal(saved.ext.director.turns, 8);
  assert.match(saved.text, /You: \[continue\]/);
  assert.deepEqual(h.errors, []);
});

test("demo: Pause stops the stream, Resume goes on, Stop ends the run; Start over asks first", { skip }, async () => {
  const h = await boot({ mode: "demo", projects: empty });
  const { $, click, wait } = h;
  h.w.MBS_SIM_MS = 150;
  click($("#tab-import")); await wait(60);
  click($("#ad-auto")); await wait(80);
  assert.equal($("#ad-pause").hidden, false);
  click($("#ad-pause")); await wait(60);
  assert.equal($("#ad-resume").hidden, false);
  assert.match($("#ad-status").textContent, /Paused/);
  click($("#ad-resume")); await wait(400);
  click($("#ad-stop")); await wait(200);
  assert.match($("#ad-status").textContent, /Stopped after/);
  click($("#ad-over")); await wait(40);
  assert.match($("#dlg").textContent, /Start over\?/);
});

test("the header Director Prompt dialog shows the vault in the demo", { skip }, async () => {
  const h = await boot({ mode: "demo", projects: empty });
  h.click(h.$("#dp-open")); await h.wait(60);
  assert.match(h.$("#dp-box").textContent, /DEMO TEMPLATE/);
  assert.ok(h.$("#dp-copy"));
});

const allDone = ($$) => { const li = $$("#ad-steps li"); return li.length === 6 && li.every((x) => x.classList.contains("past") && !x.classList.contains("on")); };

test("demo: Next Step to the end turns all 6 stage chips green (none current)", { skip }, async () => {
  const h = await boot({ mode: "demo", projects: empty });
  const { $, $$, click, wait } = h;
  h.w.MBS_SIM_MS = 20;
  click($("#tab-import")); await wait(80);
  click($("#ad-start"));
  const finished = () => /All 6 stages are complete/.test($("#ad-status").textContent);
  for (let i = 0; i < 100 && !finished(); i++) {
    await wait(60);
    if (!$("#ad-next").disabled && !finished()) {
      assert.equal(allDone($$), false, "not all done before the end");
      click($("#ad-next"));
    }
  }
  assert.ok(finished());
  assert.equal(allDone($$), true);
  assert.deepEqual(h.errors, []);
});

test("demo: Auto-Run to the end turns all 6 stage chips green", { skip }, async () => {
  const h = await boot({ mode: "demo", projects: empty });
  const { $, $$, click, wait } = h;
  h.w.MBS_SIM_MS = 20;
  click($("#tab-import")); await wait(80);
  click($("#ad-auto"));
  for (let i = 0; i < 80 && !/All 6 stages are complete/.test($("#ad-status").textContent); i++) await wait(60);
  assert.equal(allDone($$), true);
});

test("demo: the Full conversation card lists every turn in order, with per-turn Copy, Copy whole conversation and Download .txt; it survives a reload", { skip }, async () => {
  const h = await boot({ mode: "demo", projects: empty });
  const { $, $$, click, wait } = h;
  h.w.MBS_SIM_MS = 20;
  const copied = [], blobs = [];
  Object.defineProperty(h.w.navigator, "clipboard", { configurable: true, value: { writeText: async (t) => { copied.push(t); } } });
  h.w.URL.createObjectURL = (b) => { blobs.push(b); return "blob:x"; }; h.w.URL.revokeObjectURL = () => {};
  click($("#tab-import")); await wait(80);
  assert.equal($("#ad-convo").hidden, true, "hidden before a run");
  click($("#ad-auto"));
  for (let i = 0; i < 80 && !/All 6 stages are complete/.test($("#ad-status").textContent); i++) await wait(60);
  assert.equal($("#ad-convo").hidden, false);
  assert.ok($("#ad-stream").textContent.length > 100, "Live reply stays");
  let turns = $$("#ad-convo-body details.ad-turn");
  assert.equal(turns.length, 8);
  assert.match($("#ad-convo-count").textContent, /8 turns/);
  assert.deepEqual(turns.map((d) => d.dataset.n), ["1", "2", "3", "4", "5", "6", "7", "8"]);
  assert.match(turns[0].querySelector("summary").textContent, /^Turn 1 . Stage \d: .+ . gemini/);
  assert.match(turns[1].textContent, /You\s*Continue/);
  assert.ok(turns[7].querySelector("summary").textContent.includes("Stage 6: Reels and covers"));
  click(turns[2].querySelector("[data-ad-copy]")); await wait(30);
  assert.match(copied[0], /^Turn 3 \| Stage \d/);
  assert.ok(copied[0].includes("You:\nContinue\n\nModel:\n"));
  click($("#ad-convo-copy")); await wait(30);
  const all = copied[1];
  assert.equal((all.match(/^Turn \d+ \|/gm) || []).length, 8);
  assert.ok(all.indexOf("Turn 2 |") < all.indexOf("Turn 3 |") && /\n={60}\n/.test(all));
  click($("#ad-convo-dl")); await wait(30);
  assert.equal(blobs.length, 1);
  assert.equal(await blobs[0].text(), all);
  await wait(1000);
  const saved = h.projs.get("p0");
  assert.equal(saved.ext.director.meta.length, 8);
  // reload: a fresh boot on the saved project rebuilds the same turns from proj.text
  const h2 = await boot({ mode: "demo", projects: [saved] });
  h2.click(h2.$("#tab-import")); await h2.wait(80); if (h2.$("#mode-ai").getAttribute("aria-pressed") !== "true") h2.click(h2.$("#mode-ai")); await h2.wait(120);
  turns = h2.$$("#ad-convo-body details.ad-turn");
  assert.equal(turns.length, 8);
  assert.ok(turns[7].querySelector("summary").textContent.includes("Stage 6"));
  assert.equal(allDone(h2.$$), true, "a reloaded finished run shows all chips green");
  assert.deepEqual(h.errors.concat(h2.errors), []);
});
