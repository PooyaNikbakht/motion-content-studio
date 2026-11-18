const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const D = require("../public/static/director.js");
const R = require("../public/static/director-run.js");
const P = require("../public/static/parser.js");
const { JSDOM, boot } = require("./ui-harness.js");

const skip = !JSDOM && "jsdom not available (set JSDOM_PATH)";
const sample = fs.readFileSync(path.join(__dirname, "../public/demo/sample-conversation.txt"), "utf8");

function fake(replies, extra) {
  const sent = [];
  let i = 0;
  const saved = [];
  const r = R.createRunner(Object.assign({
    turn: async (req) => { sent.push(req.history.map((m) => m.role[0] + ":" + m.text)); const x = replies[Math.min(i++, replies.length - 1)]; return { text: x, usage: { prompt: 10, output: 5 }, finishReason: "STOP" }; },
    parse: (t) => P.parse(t),
    cost: () => 0.01,
    onTurn: (x) => saved.push(x.text),
  }, extra));
  return { r, sent, saved };
}

test("runner: Pause after each stage turns Auto-Run into one stage at a time; off runs on", async () => {
  const parts = D.splitSample(sample, 8);
  let on = true;
  const { r } = fake(parts, { pauseEach: () => on });
  await r.start({ language: "en", model: "m", first: "go", maxTurns: 45 }, true);
  assert.equal(r.state.status, "waiting");
  assert.equal(r.state.auto, false);
  assert.equal(r.state.turns, 1);
  on = false;
  await r.auto();
  assert.equal(r.state.status, "done");
  assert.equal(r.state.turns, 8);
});

test("runner: feedback is sent as the next user message, then the run goes on with the continue word", async () => {
  const { r, sent } = fake(["Stage one. Send continue.", "Revised. Send continue.", "Stage two. Send continue."]);
  await r.start({ language: "en", model: "m", first: "go", maxTurns: 45 }, false);
  await r.reply("Make the hook shorter", false);
  assert.deepEqual(sent[1], ["u:go", "m:Stage one. Send continue.", "u:Make the hook shorter"]);
  await r.next();
  assert.equal(sent[2][4], "u:" + D.CONTINUE_WORD);
});

test("runner: Regenerate drops the last reply and sends the same message again; tokens spent stay counted", async () => {
  const { r, sent, saved } = fake(["Stage one. Send continue.", "Second try. Send continue.", "Third. Send continue."]);
  await r.start({ language: "en", model: "m", first: "go", maxTurns: 45 }, false);
  await r.next();
  assert.equal(r.history.length, 4);
  await r.regenerate();
  assert.deepEqual(sent[2], sent[1], "the same conversation is sent again");
  assert.equal(r.history.length, 4, "one reply replaced, not added");
  assert.equal(r.history[3].text, "Third. Send continue.");
  assert.equal(r.state.turns, 3);
  assert.equal(r.state.tokens.total, 45);
  assert.ok(!r.text.includes("Second try"));
  assert.ok(saved.length >= 3);
});

test("runner: editLast replaces the last reply, re-parses, saves, and the next turn sends the edited text", async () => {
  const { r, sent, saved } = fake(["Stage one. Send continue.", "Next. Send continue."]);
  await r.start({ language: "en", model: "m", first: "go", maxTurns: 45 }, false);
  assert.equal(await r.editLast("   "), false);
  assert.equal(await r.editLast("My edited reply. Send continue."), true);
  assert.equal(r.history[1].text, "My edited reply. Send continue.");
  assert.match(saved[saved.length - 1], /My edited reply/);
  assert.equal(r.state.turns, 1, "an edit is not a turn");
  await r.next();
  assert.equal(sent[1][1], "m:My edited reply. Send continue.");
});

test("UI (demo): feedback box, Regenerate, edit and accept, and the Pause after each stage toggle", { skip }, async () => {
  const h = await boot({ mode: "demo", projects: [{ id: "p0", name: "Empty" }] });
  const { $, $$, click, input, wait } = h;
  h.w.MBS_SIM_MS = 30;
  click($("#tab-import")); await wait(80);
  assert.equal($("#ad-fb-box").hidden, true);
  assert.equal($("#ad-pause-each").checked, false);
  click($("#ad-pause-each"));
  click($("#ad-auto"));
  for (let i = 0; i < 40 && !($("#ad-turns").textContent.startsWith("Turn 1 ") && !$("#ad-next").disabled); i++) await wait(50);
  await wait(300);
  assert.equal($("#ad-turns").textContent, "Turn 1 of up to 45", "Auto-Run stopped after the first stage");
  assert.equal($("#ad-next").disabled, false);
  assert.equal($("#ad-fb-box").hidden, false);
  assert.deepEqual($$("#ad-fb-box .row button").map((b) => b.textContent.trim()).slice(0, 3), ["Send feedback", "Regenerate", "Edit reply"]);
  // feedback
  input($("#ad-fb"), "Please make the opening shorter");
  click($("#ad-fb-send"));
  for (let i = 0; i < 40 && $$("#ad-log li").length < 2; i++) await wait(50);
  await wait(100);
  assert.equal($("#ad-fb").value, "");
  await wait(1000);
  assert.match(h.projs.get("p0").text, /You: Please make the opening shorter/);
  // regenerate: same stage again, one more turn counted, the conversation keeps one reply per stage
  const before = h.projs.get("p0").text;
  click($("#ad-regen"));
  for (let i = 0; i < 40 && $$("#ad-log li").length < 3; i++) await wait(50);
  await wait(1000);
  assert.equal($$("#ad-log li").length, 3);
  assert.equal(h.projs.get("p0").text, before, "the regenerated reply replaces the old one");
  // edit and accept
  click($("#ad-edit"));
  assert.equal($("#ad-edit-box").hidden, false);
  $("#ad-edit-text").value = "EDITED stage text. Send Continue for the next stage.";
  click($("#ad-edit-ok")); await wait(1100);
  assert.equal($("#ad-edit-box").hidden, true);
  assert.match($("#ad-stream").textContent, /^EDITED stage text/);
  assert.match(h.projs.get("p0").text, /EDITED stage text/);
  assert.deepEqual(h.errors, []);
});

test("parser: a chunk or scene written twice keeps the LATEST version (a regenerated reply stays in the conversation)", () => {
  const text = [
    "**Audio chunk 1**", "", "Today the sea is very calm. Draft one.", "",
    "**Audio chunk 2**", "", "Today the sea is very calm. Chunk two.", "",
    "Scene Number: 1", "Narration Part 1: old", "Image Prompt: old image", "",
    "Scene Number: 1", "Narration Part 1: new", "Image Prompt: new image", "",
    "(you asked for a rewrite)", "",
    "**Audio chunk 1**", "", "Today the sea is very calm. Rewritten one.",
  ].join("\n");
  const r = P.parse(text, { startPhrase: "Today the sea is very calm" });
  assert.deepEqual(r.chunks.map((c) => c.text.replace(/^.*calm\. /, "")), ["Rewritten one.", "Chunk two."]);
  assert.deepEqual(r.scenes.map((s) => s.narration), ["new"]);
  assert.equal(r.stats.audioChunks, 2);
  // chunks without a number label are never merged
  const plain = P.parse("Today the sea is very calm. A\n\nToday the sea is very calm. A", { startPhrase: "Today the sea is very calm" });
  assert.equal(plain.chunks.length, 2);
});
