const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const D = require("../public/static/director.js");
const R = require("../public/static/director-run.js");
const P = require("../public/static/parser.js");

const sample = fs.readFileSync(path.join(__dirname, "../samples/sample-conversation.txt"), "utf8");
const CONT = "ادامه";

test("the continue and congratulation words are the exact strings from the master prompt", () => {
  assert.equal(D.CONTINUE_WORD, "ادامه");
  assert.equal(D.CONGRATS, "تبریک");
  assert.equal(D.DEFAULT_MAX_TURNS, 45);
});

test("stage is derived from what the parser found, one to six", () => {
  assert.equal(D.stageOf(null).n, 1);
  assert.equal(D.stageOf({ chunks: [{}] }).n, 2);
  assert.equal(D.stageOf({ chunks: [{}], scenes: [{}] }).n, 3);
  assert.equal(D.stageOf({ chunks: [{}], scenes: [{ hasVideo: true }] }).n, 4);
  assert.equal(D.stageOf({ chunks: [{}], scenes: [{}], thumbnail: "t" }).n, 5);
  assert.equal(D.stageOf({ reels: [{}] }).n, 6);
  assert.equal(D.stageOf(P.parse(sample)).n, 6);
});

test("completion: three reels with covers and captions, or the congratulation word", () => {
  assert.equal(D.isComplete(P.parse(sample), ""), true);
  assert.equal(D.isComplete({ reels: [{ cover: "c", caption: "x" }] }, "ok"), false);
  assert.equal(D.isComplete({ reels: [] }, "... " + D.CONGRATS + " ..."), true);
  assert.equal(D.isComplete({ reels: [{ cover: "c", caption: "x" }, { cover: "c", caption: "x" }, { cover: "", caption: "x" }] }, ""), false);
});

test("question detection: a closing question without a continue prompt pauses; continue prompts do not", () => {
  assert.equal(D.endsWithQuestion("Stage 1 done.\n\nWhich language should I write in?"), true);
  assert.equal(D.endsWithQuestion("Stage 1 done.\n\nShall I continue?"), false);
  assert.equal(D.endsWithQuestion("Done.\n\nSend " + CONT + " for the next stage."), false);
  assert.equal(D.endsWithQuestion("Done. Reply " + CONT + " to proceed, or tell me what to change?"), false);
  assert.equal(D.endsWithQuestion("زبان چیست؟"), true);
  assert.equal(D.endsWithQuestion("Plain statement."), false);
  assert.equal(D.endsWithQuestion("**Which tone do you prefer?**"), true);
});

test("decide: block, empty, done, max turns, truncation, question, continue (in that order)", () => {
  const s = D.create({ language: "en", model: "m", first: "f", maxTurns: 3 });
  assert.equal(D.decide(s, "x", null, { blockReason: "SAFETY" }).reason, "blocked");
  assert.equal(D.decide(s, "  ", null).reason, "empty");
  assert.equal(D.decide(s, "all " + D.CONGRATS, null).action, "done");
  assert.equal(D.decide(Object.assign({}, s, { turns: 3 }), "text", null).reason, "max");
  assert.deepEqual(D.decide(s, "cut off mid sen", null, { finishReason: "MAX_TOKENS" }), { action: "continue", reason: "truncated" });
  assert.equal(D.decide(Object.assign({}, s, { truncStreak: 3 }), "t", null, { finishReason: "MAX_TOKENS" }).reason, "truncated");
  assert.equal(D.decide(s, "Which language?", null).reason, "question");
  assert.deepEqual(D.decide(s, "Stage done. Send continue.", null), { action: "continue", reason: "stage" });
});

test("recordTurn accumulates tokens, cost and a bounded log", () => {
  let s = D.create({ language: "fa", model: "m", first: "f" });
  for (let i = 0; i < 70; i++) s = D.recordTurn(s, { usage: { prompt: 1000, output: 100 }, cost: 0.01, finishReason: i === 69 ? "MAX_TOKENS" : "STOP" }, 5);
  assert.equal(s.turns, 70);
  assert.deepEqual(s.tokens, { prompt: 70000, output: 7000, total: 77000 });
  assert.equal(s.cost, 0.7);
  assert.equal(s.log.length, 60);
  assert.equal(s.log[59].n, 70);
  assert.equal(s.truncStreak, 1);
  assert.equal(s.lastFinishReason, "MAX_TOKENS");
});

test("transcript: replies kept whole, user turns as one-line markers, and the history can be rebuilt", () => {
  const h = [{ role: "user", text: "Output language: English.\nBook title: T" }, { role: "model", text: "Reply one.\n\nMore." }, { role: "user", text: CONT }, { role: "model", text: "Reply two." }, { role: "user", text: "Make it\nshorter" }, { role: "model", text: "Reply three." }];
  const t = D.buildTranscript(h);
  assert.equal(t, "---\nYou: [book input]\n---\n\nReply one.\n\nMore.\n\n---\nYou: [continue]\n---\n\nReply two.\n\n---\nYou: Make it shorter\n---\n\nReply three.");
  assert.ok(!t.includes(CONT), "the continue word is not saved in the text");
  const back = D.historyFromTranscript(t, h[0].text);
  assert.deepEqual(back.map((m) => m.role), ["user", "model", "user", "model", "user", "model"]);
  assert.equal(back[0].text, h[0].text);
  assert.equal(back[1].text, "Reply one.\n\nMore.");
  assert.equal(back[2].text, CONT);
  assert.equal(back[4].text, "Make it shorter");
  assert.deepEqual(D.historyFromTranscript("", "f"), []);
});

test("the parser sees the same result for a transcript as for the pasted replies", () => {
  const replies = D.splitSample(sample, 8);
  const history = [];
  replies.forEach((r, i) => { history.push({ role: "user", text: i === 0 ? "first" : D.CONTINUE_WORD }, { role: "model", text: r }); });
  const a = P.parse(D.buildTranscript(history)), b = P.parse(sample);
  assert.deepEqual(a.stats, b.stats);
  assert.deepEqual(a.warnings, b.warnings);
  assert.equal(a.reels.length, 3);
});

test("splitSample: about n replies at headings, all text kept, the last one has no continue line", () => {
  const parts = D.splitSample(sample, 8);
  assert.equal(parts.length, 8);
  assert.ok(!/Send Continue/.test(parts[7]));
  assert.ok(parts.slice(0, 7).every((p) => /Send Continue for the next stage\.$/.test(p)));
  assert.equal(parts.join("\n").replace(/\s+/g, "").replace(/SendContinueforthenextstage\./g, ""), sample.replace(/\s+/g, ""));
  assert.equal(D.splitSample(sample, 1).length, 1);
});

// ---------- runner ----------

function fake(replies, opts) {
  opts = opts || {};
  const calls = [];
  let i = 0;
  const log = { changes: [], turns: [] };
  const r = R.createRunner({
    turn: async (req) => {
      calls.push(req.history.map((m) => m.role[0] + ":" + m.text.slice(0, 12)));
      if (opts.gate) await opts.gate(req);
      const x = replies[Math.min(i++, replies.length - 1)];
      if (x instanceof Error) throw x;
      if (req.onText) req.onText(x.text, x.text);
      if (req.signal.aborted) throw Object.assign(new Error("a"), { kind: "aborted" });
      return Object.assign({ usage: { prompt: 1000, output: 100 }, finishReason: "STOP" }, x);
    },
    parse: (t) => P.parse(t),
    cost: (u) => (u.prompt + u.output) / 1e6,
    onChange: (v) => log.changes.push(v.state.status),
    onTurn: (x) => log.turns.push({ turns: x.state.turns, stage: x.state.stage }),
  });
  return { r, calls, log };
}

test("runner: Start Project runs the first turn only, Next Step sends the continue word once", async () => {
  const parts = D.splitSample(sample, 8);
  const { r, calls } = fake(parts.map((text) => ({ text })));
  await r.start({ language: "en", model: "m", first: "Output language: English.", maxTurns: 45 }, false);
  assert.equal(r.state.status, "waiting");
  assert.equal(r.state.turns, 1);
  assert.deepEqual(calls[0], ["u:Output langu"]);
  await r.next();
  assert.equal(r.state.turns, 2);
  assert.deepEqual(calls[1].map((c) => c.slice(0, 2)), ["u:", "m:", "u:"]);
  assert.equal(calls[1][2], "u:" + CONT.slice(0, 12));
  assert.equal(r.state.tokens.total, 2200);
  assert.equal(r.state.cost, 0.0022);
});

test("runner: Auto-Run goes through all replies and stops at completion with the project parsed", async () => {
  const parts = D.splitSample(sample, 8);
  const { r, log } = fake(parts.map((text) => ({ text })));
  await r.start({ language: "en", model: "m", first: "go", maxTurns: 45 }, true);
  assert.equal(r.state.status, "done");
  assert.equal(r.state.turns, 8);
  assert.equal(r.state.stage, 6);
  assert.equal(r.parsed.reels.length, 3);
  assert.deepEqual(log.turns.map((t) => t.turns), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.ok(log.turns[0].stage < log.turns[7].stage, "stage grows as replies arrive");
  assert.equal(r.history.length, 16);
});

test("runner: the turn limit pauses with a message; raising it and resuming goes on", async () => {
  const { r } = fake([{ text: "Stage text. Send continue." }]);
  await r.start({ language: "en", model: "m", first: "go", maxTurns: 3 }, true);
  assert.equal(r.state.status, "paused");
  assert.equal(r.state.pause.reason, "max");
  assert.equal(r.state.turns, 3);
  r.setMaxTurns(5);
  await r.resume(true);
  assert.equal(r.state.turns, 5);
});

test("runner: a question pauses Auto-Run, the user answers and the run goes on", async () => {
  const { r, calls } = fake([{ text: "Which tone do you want?" }, { text: "Great. Send continue." }, { text: "Stage two. Send continue." }]);
  await r.start({ language: "en", model: "m", first: "go", maxTurns: 4 }, true);
  assert.equal(r.state.status, "paused");
  assert.equal(r.state.pause.reason, "question");
  assert.equal(r.state.pause.reply, "Which tone do you want?");
  assert.equal(r.state.auto, false);
  await r.reply("Warm and calm", true);
  assert.equal(calls[1][2], "u:Warm and cal");
  assert.equal(r.state.turns, 4, "auto resumed until the limit");
  assert.match(r.text, /You: Warm and calm/);
});

test("runner: MAX_TOKENS sends a continue turn automatically", async () => {
  const { r } = fake([{ text: "part one", finishReason: "MAX_TOKENS" }, { text: "part two. Send continue.", finishReason: "STOP" }, { text: "x. Send continue." }]);
  await r.start({ language: "en", model: "m", first: "go", maxTurns: 2 }, true);
  assert.equal(r.state.turns, 2);
  assert.equal(r.state.lastFinishReason, "STOP");
});

test("runner: a safety block pauses with the reason and does not enter the history", async () => {
  const { r } = fake([{ text: "", blockReason: "PROHIBITED_CONTENT" }]);
  await r.start({ language: "en", model: "m", first: "go" }, true);
  assert.equal(r.state.status, "paused");
  assert.equal(r.state.pause.reason, "blocked");
  assert.match(r.state.pause.message, /PROHIBITED_CONTENT/);
  assert.equal(r.history.length, 0);
});

test("runner: an error stops Auto-Run; Resume sends the same message again", async () => {
  const { r, calls } = fake([{ text: "ok. Send continue." }, new Error("Gemini is busy"), { text: "again. Send continue." }]);
  await r.start({ language: "en", model: "m", first: "go", maxTurns: 10 }, true);
  assert.equal(r.state.status, "error");
  assert.equal(r.state.error, "Gemini is busy");
  assert.equal(r.state.turns, 1);
  await r.resume(false);
  assert.equal(r.state.turns, 2);
  assert.equal(calls[1].length, calls[2].length, "the same request was repeated");
});

test("runner: Pause drops the reply in flight and Resume sends it again; Stop ends the run", async () => {
  let release;
  let gated = false;
  const gate = (req) => (req.history.length === 3 && !gated ? (gated = true, new Promise((res) => { release = res; })) : null);
  const { r, calls } = fake([{ text: "one. Send continue." }, { text: "two. Send continue." }, { text: "three. Send continue." }], { gate });
  await r.start({ language: "en", model: "m", first: "go", maxTurns: 10 }, false);
  const p = r.next();
  await new Promise((s) => setTimeout(s, 5));
  assert.equal(r.state.status, "running");
  r.pause();
  release();
  await p;
  assert.equal(r.state.status, "paused");
  assert.equal(r.state.pause.reason, "user");
  assert.equal(r.state.turns, 1);
  assert.equal(r.history.length, 2);
  await r.resume(false);
  assert.equal(r.state.turns, 2);
  assert.equal(r.state.status, "waiting");
  r.stop();
  assert.equal(r.state.status, "stopped");
  assert.ok(calls.length >= 3);
});

test("runner: load rebuilds the run from the saved text; a run that was mid-reply comes back paused", async () => {
  const parts = D.splitSample(sample, 8);
  const a = fake(parts.map((text) => ({ text })));
  await a.r.start({ language: "en", model: "m", first: "FIRST", maxTurns: 45 }, false);
  await a.r.next();
  const saved = JSON.parse(JSON.stringify({ state: Object.assign({}, a.r.state, { status: "running" }), text: a.r.text }));
  const b = fake(parts.slice(2).map((text) => ({ text })));
  b.r.load(saved);
  assert.equal(b.r.state.status, "paused");
  assert.equal(b.r.state.pause.reason, "interrupted");
  assert.equal(b.r.history.length, 4);
  assert.equal(b.r.history[0].text, "FIRST");
  await b.r.resume(true);
  assert.equal(b.r.state.status, "done");
  assert.equal(b.r.state.turns, 8);
  assert.equal(b.r.parsed.reels.length, 3);
});

test("conversation(): turns pair each message with its reply, meta is matched from the end, and the text export separates turns", () => {
  const history = [
    { role: "user", text: "FIRST BOOK INPUT" }, { role: "model", text: "Reply one" },
    { role: "user", text: D.CONTINUE_WORD }, { role: "model", text: "Reply two" },
    { role: "user", text: "x".repeat(400) }, { role: "model", text: "Reply three" },
  ];
  const t = D.conversation(history, [{ model: "m2", stage: 1 }, { model: "m3", stage: 2 }]);
  assert.equal(t.length, 3);
  assert.deepEqual(t.map((x) => x.n), [1, 2, 3]);
  assert.equal(t[0].model, "", "old runs without meta still list the turn");
  assert.equal(t[1].model, "m2"); assert.equal(t[1].stage, 1); assert.equal(t[1].user, "Continue");
  assert.equal(t[2].stageLabel, "Script chapters"); assert.equal(t[2].userCut, true);
  assert.equal(t[0].userCut, false);
  const txt = D.conversationText(t);
  assert.ok(txt.indexOf("Turn 1") < txt.indexOf("Turn 2") && txt.indexOf("Turn 2") < txt.indexOf("Turn 3"));
  assert.ok(txt.includes("You:\nFIRST BOOK INPUT\n\nModel:\nReply one"));
  assert.ok(txt.includes("=".repeat(60)));
  assert.deepEqual(D.conversation([{ role: "user", text: "a" }], []), [], "an unanswered message is not a turn");
});

test("runner keeps meta per reply, drops it on regenerate, and a reloaded run rebuilds the full conversation from the saved text", async () => {
  let n = 0;
  const deps = { turn: async () => ({ text: "Reply " + ++n + "\n\nSend Continue.", usage: { prompt: 1, output: 1 }, finishReason: "STOP" }), parse: (t) => P.parse(t), cost: () => 0 };
  const r = R.createRunner(deps);
  await r.start({ first: "BOOK", language: "en", model: "m" }, false);
  await r.next();
  assert.equal(r.state.meta.length, 2);
  assert.equal(D.conversation(r.history, r.state.meta).length, 2);
  const r2 = R.createRunner(deps);
  r2.load({ state: JSON.parse(JSON.stringify(r.state)), text: r.text });
  const c = D.conversation(r2.history, r2.state.meta);
  assert.equal(c.length, 2);
  assert.equal(c[0].user, "BOOK");
  assert.equal(c[1].user, "Continue");
  assert.match(c[1].reply, /^Reply 2/);
  assert.ok(c[1].model, "model kept from meta");
  await r.regenerate();
  assert.equal(D.conversation(r.history, r.state.meta).length, 2);
  assert.equal(r.state.meta.length, 2);
});
