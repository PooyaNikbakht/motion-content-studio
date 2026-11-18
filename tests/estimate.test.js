const test = require("node:test");
const assert = require("node:assert/strict");
const E = require("../public/static/estimate.js");

test("chars counts code points like audio.js", () => {
  assert.equal(E.chars("abc"), 3);
  assert.equal(E.chars("سلام"), 4);
  assert.equal(E.chars("a😀b"), 3);
  assert.equal(E.chars(null), 0);
});

test("estimate: 1 credit per char for v3 and multilingual v2, 0.5 for Flash, with the pay-as-you-go price", () => {
  const t = ["a".repeat(1000), "b".repeat(340)];
  assert.deepEqual(E.estimate(t, "eleven_v4"), { chars: 1340, credits: 1340, usd: 0.1072 });
  assert.deepEqual(E.estimate(t, "eleven_v3"), { chars: 1340, credits: 1340, usd: 0.1072 });
  assert.deepEqual(E.estimate(t, "eleven_multilingual_v2"), { chars: 1340, credits: 1340, usd: 0.1072 });
  assert.deepEqual(E.estimate(t, "eleven_flash_v2_5"), { chars: 1340, credits: 670, usd: 0.0536 });
  assert.deepEqual(E.estimate([], "eleven_v3"), { chars: 0, credits: 0, usd: 0 });
});

test("estimate: editable rates override the defaults, bad values fall back", () => {
  const rates = { eleven_v3: { credits: 2, usd: 0.1 }, eleven_flash_v2_5: { credits: "x", usd: -1 } };
  assert.deepEqual(E.estimate(["a".repeat(1000)], "eleven_v3", rates), { chars: 1000, credits: 2000, usd: 0.1 });
  assert.deepEqual(E.estimate(["a".repeat(1000)], "eleven_flash_v2_5", rates), { chars: 1000, credits: 500, usd: 0.04 });
  assert.deepEqual(E.estimate(["a".repeat(1000)], "unknown_model"), { chars: 1000, credits: 1000, usd: 0.08 });
});

test("fitsQuota compares the batch with what is left", () => {
  assert.deepEqual(E.fitsQuota({ used: 3000, limit: 10000 }, 7000), { fits: true, remaining: 7000, over: 0 });
  assert.deepEqual(E.fitsQuota({ used: 9000, limit: 10000 }, 1500), { fits: false, remaining: 1000, over: 500 });
  assert.equal(E.fitsQuota({ used: 12000, limit: 10000 }, 1).remaining, 0);
  assert.equal(E.fitsQuota(null, 5).fits, false);
});

test("previewText keeps the warm-up phrase plus the first sentence; with no phrase it takes the first two sentences", () => {
  const phrase = "امروز هوا خیلی آرومه";
  const text = phrase + "... قایقی کوچک کنار ساحل بود. جمله دوم نباید بیاید.";
  assert.equal(E.previewText(text, 170, phrase), phrase + " قایقی کوچک کنار ساحل بود.");
  assert.equal(E.previewText("First one. Second one. Third one."), "First one. Second one.");
  assert.equal(E.previewText("First one. Second one. Third one.", 170, ""), "First one. Second one.");
  assert.equal(E.previewText("Only one sentence here."), "Only one sentence here.");
  assert.equal(E.previewText("Hello there. First one. Second one.", 170, "Hello there"), "Hello there First one.");
  assert.equal(E.previewText("No end punctuation here"), "No end punctuation here");
});

test("previewText never exceeds n and cuts at a word boundary", () => {
  const long = "word ".repeat(100).trim() + ".";
  const p = E.previewText(long, 170);
  assert.ok([...p].length <= 170 && [...p].length > 100);
  assert.ok(!p.endsWith("wor"), p.slice(-10));
  assert.equal(E.previewText("x".repeat(400), 50).length, 50);
  assert.equal(E.PREVIEW_CHARS, 170);
});

test("resetText formats a unix time as day and month", () => {
  assert.match(E.resetText(Date.UTC(2026, 11, 3, 12) / 1000), /Dec 3/);
  assert.equal(E.resetText(0), "");
});

test("USD maths: per 1,000 characters, rounded to 4 places, editable per model", () => {
  const e = (n, m, r) => E.estimate(["a".repeat(n)], m, r);
  assert.equal(e(170, "eleven_v3").usd, 0.0136);
  assert.equal(e(286, "eleven_multilingual_v2").usd, 0.0229);
  assert.equal(e(286, "eleven_flash_v2_5").usd, 0.0114);
  assert.equal(e(1000, "eleven_v3", { eleven_v3: { usd: 0.3 } }).usd, 0.3);
  assert.equal(e(12340, "eleven_v3").usd, 0.9872);
  assert.equal(e(0, "eleven_v3").usd, 0);
});

test("usdApprox and usdText: two decimals, and a small amount is never shown as $0.00", () => {
  assert.equal(E.usdApprox(0.0136), "~$0.01");
  assert.equal(E.usdApprox(0.9872), "~$0.99");
  assert.equal(E.usdApprox(0.004), "<$0.01");
  assert.equal(E.usdApprox(0), "~$0.00");
  assert.equal(E.usdText(0.004), "<$0.01");
  assert.equal(E.usdText(2), "$2.00");
});

test("the card lines: 170 characters is about 10 seconds, 286 characters full", () => {
  const line = (x, approx) => (approx ? "~" : "") + E.fmt(x.chars) + " chars, " + (approx ? "~" : "") + E.fmt(x.credits) + " credits, " + E.usdApprox(x.usd);
  assert.equal(line(E.estimate(["a".repeat(170)], "eleven_v3"), true), "~170 chars, ~170 credits, ~$0.01");
  assert.equal(line(E.estimate(["a".repeat(286)], "eleven_multilingual_v2"), false), "286 chars, 286 credits, ~$0.02");
  assert.equal(line(E.estimate(["a".repeat(286)], "eleven_flash_v2_5"), false), "286 chars, 143 credits, ~$0.01");
});

test("geminiCost prices input and output per 1M tokens, and the 200k tier on the prompt size", () => {
  const pro = E.geminiRateFor("gemini-2.5-pro");
  assert.equal(E.geminiCost({ prompt: 1e6, output: 1e5 }, E.geminiRateFor("gemini-2.5-flash")), 0.3 + 0.25);
  assert.equal(E.geminiCost({ prompt: 100000, output: 10000 }, pro), 0.125 + 0.1);
  assert.equal(E.geminiCost({ prompt: 300000, output: 10000 }, pro), 0.75 + 0.15);
  assert.equal(E.geminiCost({}, pro), 0);
  assert.equal(E.geminiCost({ prompt: "x", output: -5 }, pro), 0);
});

test("geminiTotals adds turns up, each turn priced on its own prompt size", () => {
  const pro = E.geminiRateFor("gemini-2.5-pro");
  const t = E.geminiTotals([{ prompt: 100000, output: 1000 }, { prompt: 250000, output: 2000 }], pro);
  assert.deepEqual(t, { turns: 2, prompt: 350000, output: 3000, total: 353000, usd: 0.125 + 0.01 + 0.625 + 0.03 });
  assert.equal(E.geminiTotals([], pro).usd, 0);
});

test("gemini rates: overrides win, bad values fall back, unknown models get a fallback", () => {
  const r = E.normalizeGeminiRates({ "gemini-2.5-flash": { in: 0.5, out: "x" }, custom: { in: 1, out: 2 } });
  assert.equal(r["gemini-2.5-flash"].in, 0.5);
  assert.equal(r["gemini-2.5-flash"].out, 2.5);
  assert.equal(r["gemini-2.5-flash"].inHi, 0.5, "the high tier never drops below the base rate");
  assert.equal(r["gemini-2.5-pro"].inHi, 2.5);
  assert.deepEqual(E.geminiRateFor("nope"), { in: 1.25, out: 10, inHi: 2.5, outHi: 15 });
  assert.equal(r.custom.out, 2);
});

test("projectGeminiRun: history is re-sent so input grows with every turn; range low < expected < high", () => {
  const rate = E.geminiRateFor("gemini-2.5-pro");
  const p = E.projectGeminiRun(10000, rate);
  assert.equal(p.expected.turns, 25);
  // input = 25 * 10,000 + (3,000 + 10) * (0 + 1 + ... + 24)
  assert.equal(p.expected.prompt, 25 * 10000 + 3010 * 300);
  assert.equal(p.expected.output, 25 * 4000);
  assert.ok(p.low.usd < p.expected.usd && p.expected.usd < p.high.usd);
  assert.equal(p.expected.usd, E.geminiCost({ prompt: 0, output: 0 }, rate) + E.geminiTotals(Array.from({ length: 25 }, (_, t) => ({ prompt: 10000 + t * 3010, output: 4000 })), rate).usd);
  assert.equal(E.projectGeminiRun(0, rate, { low: { turns: 1, reply: 0, think: 0 }, expected: { turns: 2, reply: 100, think: 0 }, high: { turns: 3, reply: 0, think: 0 }, user: 0 }).expected.prompt, 100);
});

test("approxTokens: about 4 characters a token for Latin text, 2 for Arabic script; kTokens abbreviates", () => {
  assert.equal(E.approxTokens("a".repeat(400)), 100);
  assert.equal(E.approxTokens("س".repeat(100)), 50);
  assert.equal(E.approxTokens(""), 0);
  assert.equal(E.kTokens(1234567), "1.23M");
  assert.equal(E.kTokens(45000), "45k");
  assert.equal(E.kTokens(12), "12");
});

test("gemini default rates: Flash 3.8 0.75/3.75, Hydrogen 1.5/7.5, Carbon 2/10", () => {
  const r = E.normalizeGeminiRates({});
  assert.deepEqual([r["gemini-3.8-flash"].in, r["gemini-3.8-flash"].out], [0.75, 3.75]);
  assert.deepEqual([r["gemini-4-hydrogen"].in, r["gemini-4-hydrogen"].out], [1.5, 7.5]);
  assert.deepEqual([r["gemini-4-carbon"].in, r["gemini-4-carbon"].out], [2, 10]);
  assert.equal(E.geminiCost({ prompt: 1e6, output: 1e6 }, E.geminiRateFor("gemini-4-carbon")), 12);
});
