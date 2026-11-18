/*
 * Cost and quota estimates for ElevenLabs text to speech. Pure functions, no DOM.
 * Characters are counted like audio.js (code points, not UTF-16 units). Credit rates are editable in the
 * settings; the defaults below are published figures and everything shown from them is labelled an estimate.
 *   credits per character: v3 and Multilingual v2 = 1, Flash v2.5 = 0.5
 *   pay-as-you-go API price per 1,000 characters: about $0.08 (v3, Multilingual v2), about $0.04 (Flash)
 *   about 1,000 characters is one minute of audio, so 10 seconds is about 170 characters
 * Gemini (AI Director) costs are token based: USD per 1M input and output tokens, taken from the usage numbers the API returns
 * after each turn. Output includes thinking tokens. Some models price a whole request higher when its prompt is over 200k tokens.
 * UMD: window.MBSEstimate in the browser, require() in Node.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MBSEstimate = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DEFAULT_RATES = {
    eleven_v4: { credits: 1, usd: 0.08 },
    eleven_v3: { credits: 1, usd: 0.08 },
    eleven_multilingual_v2: { credits: 1, usd: 0.08 },
    eleven_flash_v2_5: { credits: 0.5, usd: 0.04 },
  };
  const FALLBACK_RATE = { credits: 1, usd: 0.08 };

  // Gemini API list prices (USD per 1M tokens, paid tier, ai.google.dev/gemini-api/docs/pricing, checked 2026-11-17).
  // in/out apply to prompts up to 200k tokens, inHi/outHi above that. gemini-4-carbon is 2/10 until 30 Nov 2026 and 4/20 after: edit it in Setup then.
  const GEMINI_TIER_TOKENS = 200000;
  const DEFAULT_GEMINI_RATES = {
    "gemini-3.8-flash": { in: 0.75, out: 3.75, inHi: 0.75, outHi: 3.75 },
    "gemini-4-hydrogen": { in: 1.5, out: 7.5, inHi: 1.5, outHi: 7.5 },
    "gemini-4-carbon": { in: 2, out: 10, inHi: 2, outHi: 10 },
    "gemini-2.5-pro": { in: 1.25, out: 10, inHi: 2.5, outHi: 15 },
    "gemini-2.5-flash": { in: 0.3, out: 2.5, inHi: 0.3, outHi: 2.5 },
  };
  const FALLBACK_GEMINI_RATE = { in: 1.25, out: 10, inHi: 2.5, outHi: 15 };
  /**
   * What a "full run" is assumed to be. These are assumptions, shown to the user next to every estimate.
   * reply = visible reply tokens per turn (they stay in the history and are re-sent on every later turn),
   * think = extra billed output tokens per turn that are not re-sent (thinking). user = tokens of each short user turn.
   */
  const DIRECTOR_ASSUMPTIONS = {
    low: { turns: 20, reply: 2000, think: 500 },
    expected: { turns: 25, reply: 3000, think: 1000 },
    high: { turns: 30, reply: 4500, think: 2000 },
    user: 10,
  };
  /** Assumed monthly allowance of the Free plan, used in /demo where there is no key to ask. */
  const FREE_PLAN_CREDITS = 10000;
  const PREVIEW_CHARS = 170;
  // Every quick voice preview runs on Flash (half the credits), whatever the default model or the run override is.
  const PREVIEW_MODEL = "eleven_flash_v2_5";

  const chars = (text) => [...String(text == null ? "" : text)].length;
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };

  /** Defaults with the user's overrides on top. Bad values fall back to the default. */
  function normalizeRates(rates) {
    const out = {};
    const keys = new Set(Object.keys(DEFAULT_RATES).concat(Object.keys(rates || {})));
    keys.forEach((m) => {
      const d = DEFAULT_RATES[m] || FALLBACK_RATE, r = (rates && rates[m]) || {};
      out[m] = { credits: num(r.credits, d.credits), usd: num(r.usd, d.usd) };
    });
    return out;
  }

  const rateFor = (model, rates) => normalizeRates(rates)[model] || FALLBACK_RATE;

  /** { chars, credits, usd } for the given texts (strings) with one model. */
  function estimate(texts, model, rates) {
    const r = rateFor(model, rates);
    const total = (texts || []).reduce((n, t) => n + chars(t), 0);
    return { chars: total, credits: Math.round(total * r.credits * 100) / 100, usd: Math.round((total / 1000) * r.usd * 10000) / 10000 };
  }

  /**
   * sub: { used, limit } (characters or credits used this period, and the allowance).
   * Returns { fits, remaining, over } where over is how many credits the batch is short by (0 when it fits).
   */
  function fitsQuota(sub, credits) {
    const remaining = Math.max(0, num(sub && sub.limit, 0) - num(sub && sub.used, 0));
    const over = Math.max(0, Math.round((credits - remaining) * 100) / 100);
    return { fits: over === 0, remaining, over };
  }

  /** "3 Dec" style date from a unix time in seconds (the day in the reader's time zone). */
  function resetText(unix) {
    if (!unix) return "";
    return new Date(unix * 1000).toLocaleDateString("en-US", { day: "numeric", month: "short" });
  }

  const fmt = (n) => Number(n).toLocaleString("en-US", { maximumFractionDigits: 1 });
  const usdText = (u) => (u < 0.01 && u > 0 ? "<$0.01" : "$" + u.toFixed(2));
  /** "~$0.12" for display next to other estimates; "<$0.01" when it rounds to nothing. */
  const usdApprox = (u) => (u < 0.01 && u > 0 ? "<$0.01" : "~$" + u.toFixed(2));

  const SENTENCE_END = /[.!?\u061F\u06D4…\n]/;

  /**
   * A short slice of a chunk for a cheap voice check: the warm-up phrase (when the text starts with it) plus the
   * first sentence after it (no phrase: the first two sentences), cut at a word boundary to at most n characters (about 10 seconds of speech at 170).
   */
  function previewText(text, n, startPhrase) {
    n = n || PREVIEW_CHARS;
    const t = String(text == null ? "" : text).trim();
    const phrase = String(startPhrase || "").trim();
    let warm = "", rest = t;
    if (phrase && t.startsWith(phrase)) { warm = phrase; rest = t.slice(phrase.length).replace(/^[\s.,\u060C\u061B:;…-]+/, ""); }
    const cps = [...rest];
    // With a warm-up phrase: it plus one sentence. Without one: the first two sentences (the cut below still caps the length).
    let end = cps.findIndex((c) => SENTENCE_END.test(c));
    if (end >= 0 && !phrase) { const next = cps.findIndex((c, i) => i > end && SENTENCE_END.test(c)); end = next < 0 ? cps.length - 1 : next; }
    end = end < 0 ? cps.length : end + 1;
    const out = (warm ? warm + " " : "") + cps.slice(0, end).join("").trim();
    const all = [...out];
    if (all.length <= n) return out.trim();
    const cut = all.slice(0, n).join("");
    const sp = cut.lastIndexOf(" ");
    return (sp > n * 0.5 ? cut.slice(0, sp) : cut).trim();
  }

  const r6 = (n) => Math.round(n * 1e6) / 1e6;
  const gnum = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };

  /** Gemini rates with the user's overrides on top. A missing inHi/outHi follows the user's in/out when they set only those. */
  function normalizeGeminiRates(rates) {
    const out = {};
    new Set(Object.keys(DEFAULT_GEMINI_RATES).concat(Object.keys(rates || {}))).forEach((m) => {
      const d = DEFAULT_GEMINI_RATES[m] || FALLBACK_GEMINI_RATE, r = (rates && rates[m]) || {};
      const i = gnum(r.in, d.in), o = gnum(r.out, d.out);
      out[m] = { in: i, out: o, inHi: gnum(r.inHi, r.in !== undefined && r.inHi === undefined ? Math.max(i, d.inHi) : d.inHi), outHi: gnum(r.outHi, r.out !== undefined && r.outHi === undefined ? Math.max(o, d.outHi) : d.outHi) };
    });
    return out;
  }
  const geminiRateFor = (model, rates) => normalizeGeminiRates(rates)[model] || FALLBACK_GEMINI_RATE;

  /** USD for one request. usage: { prompt, output } tokens (output includes thinking). rate: one entry of normalizeGeminiRates. */
  function geminiCost(usage, rate) {
    const r = rate || FALLBACK_GEMINI_RATE, p = gnum(usage && usage.prompt, 0), o = gnum(usage && usage.output, 0);
    const hi = p > GEMINI_TIER_TOKENS;
    return r6((p * (hi ? r.inHi : r.in) + o * (hi ? r.outHi : r.out)) / 1e6);
  }

  /** Cumulative { turns, prompt, output, total, usd } over a list of per-turn usages; each turn is priced on its own prompt size. rate may be a function (turn index, turn count) -> rate. */
  function geminiTotals(turns, rate) {
    const t = { turns: 0, prompt: 0, output: 0, total: 0, usd: 0 };
    (turns || []).forEach((u, i) => { t.turns++; t.prompt += gnum(u.prompt, 0); t.output += gnum(u.output, 0); t.usd += geminiCost(u, typeof rate === "function" ? rate(i, turns.length) : rate); });
    t.total = t.prompt + t.output; t.usd = r6(t.usd);
    return t;
  }

  /**
   * Cost of a whole run before it starts. base = tokens of the saved prompt plus the first message (and the PDF), resent on every turn.
   * Returns { low, expected, high }, each { turns, prompt, output, usd }; the prompt grows by the visible reply and a short user turn each turn.
   */
  function projectGeminiRun(base, rate, assume) {
    const a = assume || DIRECTOR_ASSUMPTIONS, b = gnum(base, 0), res = {};
    ["low", "expected", "high"].forEach((k) => {
      const s = a[k], turns = [];
      for (let t = 0; t < s.turns; t++) turns.push({ prompt: b + t * (s.reply + a.user), output: s.reply + s.think });
      const tot = geminiTotals(turns, rate);
      res[k] = { turns: s.turns, prompt: tot.prompt, output: tot.output, usd: tot.usd };
    });
    return res;
  }

  /** Rough token count without a network call: about 4 characters per token for Latin text, about 2 for Arabic script. */
  function approxTokens(text) {
    let rtl = 0, other = 0;
    for (const ch of String(text == null ? "" : text)) { if (/[\u0590-\u08FF]/.test(ch)) rtl++; else other++; }
    return Math.ceil(other / 4 + rtl / 2);
  }

  const kTokens = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1000 ? Math.round(n / 1000) + "k" : String(Math.round(n)));

  return { DEFAULT_GEMINI_RATES, GEMINI_TIER_TOKENS, DIRECTOR_ASSUMPTIONS, normalizeGeminiRates, geminiRateFor, geminiCost, geminiTotals, projectGeminiRun, approxTokens, kTokens, DEFAULT_RATES, FREE_PLAN_CREDITS, PREVIEW_CHARS, PREVIEW_MODEL, chars, normalizeRates, rateFor, estimate, fitsQuota, resetText, fmt, usdText, usdApprox, previewText };
});
