const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const D = require("../public/static/director.js");
const R = require("../public/static/director-run.js");
const E = require("../public/static/estimate.js");
const P = require("../public/static/parser.js");
const { JSDOM, boot } = require("./ui-harness.js");

const skip = !JSDOM && "jsdom not available (set JSDOM_PATH)";
const F = "gemini-3.8-flash", C = "gemini-4-carbon";

test("routing presets: Smart Hybrid is Carbon for stages 1-2 and Flash for 3-6; All Carbon; All Flash", () => {
  const models = (route) => [1, 2, 3, 4, 5, 6].map((n) => D.stageModel(route, n));
  assert.deepEqual(D.ROUTE_PRESETS.map((p) => p.label), ["Recommended Smart Hybrid", "All Carbon", "All Flash"]);
  assert.deepEqual(models(undefined), [C, C, F, F, F, F], "the default is the hybrid");
  assert.deepEqual(models({ preset: "carbon" }), Array(6).fill(C));
  assert.deepEqual(models({ preset: "flash" }), Array(6).fill(F));
  assert.deepEqual(models({ preset: "nope", stages: { 3: "x" } }), [C, C, "x", F, F, F]);
  assert.equal(D.routeLabelId({ preset: "hybrid", stages: { 1: F } }), "custom");
  assert.equal(D.routeLabelId({ preset: "hybrid", stages: { 1: C } }), "hybrid");
});

test("pickModel: a mid-run pick wins over the routing", () => {
  assert.equal(D.pickModel({ stage: 3 }, { preset: "hybrid" }), F);
  assert.equal(D.pickModel({ stage: 3, modelOverride: C }, { preset: "hybrid" }), C);
});

function fake(replies, route, extra) {
  const seen = [];
  let i = 0;
  const r = R.createRunner(Object.assign({
    turn: async (req) => { seen.push(req.model); return Object.assign({ usage: { prompt: 1e6, output: 1e5 }, finishReason: "STOP" }, replies[Math.min(i++, replies.length - 1)]); },
    parse: (t) => P.parse(t),
    cost: (u, model) => E.geminiCost(u, E.geminiRateFor(model)),
    route: () => route,
  }, extra));
  return { r, seen };
}

test("runner: each turn runs on the routed model and is priced at that model's rates, per turn and in total", async () => {
  const sample = fs.readFileSync(path.join(__dirname, "../public/demo/sample-conversation.txt"), "utf8");
  const parts = D.splitSample(sample, 8);
  const { r, seen } = fake(parts.map((text) => ({ text })), { preset: "hybrid" });
  await r.start({ language: "en", model: "m", first: "go", maxTurns: 45 }, true);
  assert.equal(seen[0], C, "turn 1 is stage 1");
  assert.ok(seen.includes(F), "later stages use Flash");
  const log = r.state.log;
  log.forEach((t, k) => { assert.equal(t.model, seen[k]); assert.equal(t.usd, E.geminiCost({ prompt: 1e6, output: 1e5 }, E.geminiRateFor(t.model))); });
  assert.ok(log.some((t) => t.usd === 3) && log.some((t) => t.usd === 1.125), "Carbon 2+1.0=3.0, Flash 0.75+0.375=1.125");
  assert.equal(r.state.cost, Math.round(log.reduce((s, t) => s + t.usd, 0) * 1e6) / 1e6);
});

test("runner: switching the model mid-run applies to the next turn; empty goes back to routing", async () => {
  const { r, seen } = fake([{ text: "Stage text. Send continue." }], { preset: "flash" });
  await r.start({ language: "en", model: "m", first: "go", maxTurns: 45 }, false);
  r.setModel(C);
  await r.next();
  r.setModel("");
  await r.next();
  assert.deepEqual(seen, [F, C, F]);
  assert.deepEqual(r.state.log.map((t) => t.model), [F, C, F]);
});

test("estimate: a rate function prices each turn of a projection at its own model", () => {
  const flash = E.geminiRateFor(F), carbon = E.geminiRateFor(C);
  const all = (r) => E.projectGeminiRun(10000, r).expected.usd;
  const mixed = all((i, n) => (i < n / 2 ? carbon : flash));
  assert.ok(all(flash) < mixed && mixed < all(carbon));
});

test("Setup (app): routing presets and per-stage dropdowns are custom dropdowns and are saved", { skip }, async () => {
  const h = await boot({ mode: "app", fetch: async () => ({ ok: true, status: 200, json: async () => ({ text: "M", defaultText: "M", updatedAt: 1 }), text: async () => "" }) });
  const { $, click, pick, wait } = h;
  click($("#tab-setup")); await wait(100);
  assert.equal($("#g-route select"), null);
  assert.equal($("#g-preset .dd-val").textContent, "Recommended Smart Hybrid");
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((n) => $("#g-stage-" + n + " .dd-val").textContent.split(" - ")[0]), [C, C, F, F, F, F]);
  await pick("g-preset", "All Carbon");
  assert.deepEqual(JSON.parse(JSON.stringify(h.settings.geminiRoute)), { preset: "carbon", stages: {} });
  assert.equal($("#g-stage-6 .dd-val").textContent.split(" - ")[0], C);
  await pick("g-preset", "All Flash");
  await pick("g-stage-2", "gemini-4-hydrogen");
  assert.deepEqual(JSON.parse(JSON.stringify(h.settings.geminiRoute)), { preset: "flash", stages: { 2: "gemini-4-hydrogen" } });
  assert.equal($("#g-preset .dd-val").textContent, "Custom (per stage)");
  assert.match($("#g-summary").textContent, /Custom routing/);
  await pick("g-preset", "Recommended Smart Hybrid");
  assert.deepEqual(JSON.parse(JSON.stringify(h.settings.geminiRoute)), { preset: "hybrid", stages: {} });
  assert.deepEqual(h.errors, []);
});

test("demo: the AI Director panel shows the model per turn, a total, and a mid-run model switch for the next turn", { skip }, async () => {
  const h = await boot({ mode: "demo", projects: [{ id: "p0", name: "Empty" }] });
  const { $, $$, click, pick, wait } = h;
  h.w.MBS_SIM_MS = 40;
  click($("#tab-import")); await wait(80);
  assert.match($("#ad-model-note").textContent, new RegExp("Next turn: " + C + " \\(routing for stage 1\\)"));
  click($("#ad-start"));
  for (let i = 0; i < 40 && $("#ad-next").disabled; i++) await wait(50);
  assert.match($("#ad-log li").textContent, new RegExp("Turn 1 \\(" + C + "\\)"));
  await pick("ad-model", "gemini-4-hydrogen");
  assert.match($("#ad-model-note").textContent, /Next turn: gemini-4-hydrogen \(your pick\)/);
  click($("#ad-next"));
  for (let i = 0; i < 40 && $$("#ad-log li").length < 2; i++) await wait(50);
  await wait(60);
  assert.match($$("#ad-log li")[1].textContent, /Turn 2 \(gemini-4-hydrogen\)/);
  assert.match($("#ad-total").textContent, /^Total: \$[\d.]+ over 2 turns \(gemini-4-carbon [<$\d.]+, gemini-4-hydrogen [<$\d.]+\)/);
  assert.deepEqual(h.errors, []);
});
