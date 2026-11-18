/*
 * AI Director state machine. Pure functions over the plain object saved in project.ext.director, no DOM, no timers, no network.
 *   state = { v, status, auto, language, model, turns, maxTurns, tokens: { prompt, output, total }, cost, stage, lastFinishReason,
 *             pause: { reason, message }, first, pdf, meta: [{ model, stage }] (one per kept reply), log: [{ n, prompt, output, usd, finish }], error, startedAt, updatedAt }
 *   status: idle | running | waiting (a reply arrived, ready for the next step) | paused | stopped | done | error
 * The conversation itself is saved as project.text in the shape of a pasted Gemini conversation: only the model replies, with a
 * one-line marker for every user turn (see buildTranscript). The history can be rebuilt from that text plus state.first.
 * The Persian words are written as \uXXXX escapes so no Arabic script sits in a served file.
 * UMD: window.MBSDirector in the browser, require() in Node.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MBSDirector = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /** "Continue", the word the master prompt waits for at the end of each stage. */
  const CONTINUE_WORD = "\u0627\u062F\u0627\u0645\u0647";
  /** "Congratulations": the closing marker of the last stage. */
  const CONGRATS = "\u062A\u0628\u0631\u06CC\u06A9";
  const DEFAULT_MAX_TURNS = 45;
  const LOG_MAX = 60;
  const FIRST_MAX = 30000;
  const STAGES = [
    { n: 1, id: "architecture", label: "Architecture" },
    { n: 2, id: "script", label: "Script chapters" },
    { n: 3, id: "scenes", label: "16:9 scenes" },
    { n: 4, id: "animation", label: "Animations and audio chunks" },
    { n: 5, id: "publish", label: "Thumbnail, cover, title and caption" },
    { n: 6, id: "reels", label: "Reels and covers" },
  ];
  // ---------- model routing: which Gemini model runs which stage ----------
  const FLASH = "gemini-3.8-flash", CARBON = "gemini-4-carbon";
  /** Presets of the six stage models. "custom" is what a per-stage override makes of any preset. */
  const ROUTE_PRESETS = [
    { id: "hybrid", label: "Recommended Smart Hybrid", hint: "Carbon for stages 1 and 2 (architecture and script), Flash for stages 3 to 6", models: [CARBON, CARBON, FLASH, FLASH, FLASH, FLASH] },
    { id: "carbon", label: "All Carbon", hint: "Best quality at every stage, highest cost", models: [CARBON, CARBON, CARBON, CARBON, CARBON, CARBON] },
    { id: "flash", label: "All Flash", hint: "Lowest cost at every stage", models: [FLASH, FLASH, FLASH, FLASH, FLASH, FLASH] },
  ];
  const DEFAULT_ROUTE = { preset: "hybrid", stages: {} };
  const presetOf = (id) => ROUTE_PRESETS.find((p) => p.id === id) || ROUTE_PRESETS[0];

  /** A route is { preset, stages: { "1": modelId, ... } }; stages holds the per-stage overrides over the preset. Bad input gives the default. */
  function normalizeRoute(r) {
    const preset = presetOf(r && r.preset).id, stages = {};
    const src = (r && r.stages) || {};
    for (let n = 1; n <= 6; n++) if (typeof src[n] === "string" && src[n].trim()) stages[n] = src[n].trim();
    return { preset, stages };
  }
  /** Model of stage n (1 to 6): the override, else the preset's. */
  function stageModel(route, n, fallback) {
    const r = normalizeRoute(route), i = Math.min(6, Math.max(1, Math.floor(num(n)) || 1));
    return r.stages[i] || presetOf(r.preset).models[i - 1] || fallback || FLASH;
  }
  /** "custom" when an override differs from the preset's model, else the preset id. */
  function routeLabelId(route) {
    const r = normalizeRoute(route), p = presetOf(r.preset);
    return Object.keys(r.stages).some((n) => r.stages[n] !== p.models[n - 1]) ? "custom" : p.id;
  }
  /**
   * The model for the next turn: a model picked mid-run (state.modelOverride) wins, else the route's model for the stage the
   * director is in (the stage reached by the last reply; the first turn is stage 1).
   */
  function pickModel(state, route, fallback) {
    if (state && state.modelOverride) return state.modelOverride;
    return stageModel(route, state ? state.stage || 1 : 1, (state && state.model) || fallback);
  }

  const MARK_CONTINUE = "[continue]";
  const MARK_FIRST = "[book input]";

  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

  /** A fresh run. o: { language, model, maxTurns, first, pdf, now }. */
  function create(o) {
    return {
      v: 1, status: "idle", auto: false, language: o.language || "en", model: o.model || "", turns: 0,
      maxTurns: Math.max(1, Math.floor(num(o.maxTurns)) || DEFAULT_MAX_TURNS),
      tokens: { prompt: 0, output: 0, total: 0 }, cost: 0, stage: 1, lastFinishReason: "", pause: null,
      first: String(o.first || "").slice(0, FIRST_MAX), pdf: o.pdf || null, log: [], error: "", startedAt: o.now || 0, updatedAt: o.now || 0,
    };
  }

  /** Stage 1 to 6 from what the parser found so far. */
  function stageOf(parsed) {
    const p = parsed || {};
    const reels = p.reels || [];
    let n = 1;
    if ((p.chunks || []).length) n = 2;
    if ((p.scenes || []).length) n = 3;
    if (p.stats ? p.stats.animations > 0 : (p.scenes || []).some((s) => s.hasVideo)) n = 4;
    if (p.thumbnail || p.youtubeTitle || p.coverHeadline) n = 5;
    if (reels.length) n = 6;
    return STAGES[n - 1];
  }

  /** The run is finished: three reels with covers and captions, or the closing congratulation word in the reply. */
  function isComplete(parsed, reply) {
    const reels = (parsed && parsed.reels) || [];
    if (reels.length >= 3 && reels.every((r) => r.cover && r.caption)) return true;
    return String(reply || "").includes(CONGRATS);
  }

  const CONTINUE_HINT = new RegExp(CONTINUE_WORD + "|continue|\\bnext\\b|proceed|go on", "i");

  /**
   * The reply ends by asking something that "continue" does not answer: its last paragraph ends with a question mark and does not
   * mention continuing. A stage ending "Say continue when ready" or "Shall I continue?" is not such a question.
   */
  function endsWithQuestion(reply) {
    const paras = String(reply || "").trim().split(/\n\s*\n/);
    const last = (paras[paras.length - 1] || "").trim();
    const lines = last.split("\n");
    const tail = lines[lines.length - 1].replace(/[\s*_`>"')\]]+$/, "");
    if (!/[?\u061F]$/.test(tail)) return false;
    return !CONTINUE_HINT.test(last);
  }

  /**
   * What to do after a reply. info: { finishReason, blockReason }. Returns { action, reason, message? } with action
   * "continue" (send the continue word), "done" or "pause" (reason: blocked, empty, question, max, truncated).
   */
  function decide(state, reply, parsed, info) {
    info = info || {};
    if (info.blockReason) return { action: "pause", reason: "blocked", message: "Gemini stopped this reply (" + info.blockReason + "). Change the book input or the prompt, then try again." };
    if (!String(reply || "").trim()) return { action: "pause", reason: "empty", message: "Gemini sent an empty reply. Press Resume to try again." };
    if (isComplete(parsed, reply)) return { action: "done", reason: "complete" };
    if (state.turns >= state.maxTurns) return { action: "pause", reason: "max", message: "Reached the limit of " + state.maxTurns + " turns. Raise the limit and press Resume, or stop here." };
    if (info.finishReason === "MAX_TOKENS") {
      if ((state.truncStreak || 0) >= 3) return { action: "pause", reason: "truncated", message: "Gemini keeps hitting its output limit. Reply with a shorter instruction, or press Resume to try again." };
      return { action: "continue", reason: "truncated" };
    }
    if (endsWithQuestion(reply)) return { action: "pause", reason: "question", message: "The director asked a question. Answer it below, then the run goes on." };
    return { action: "continue", reason: "stage" };
  }

  /** Adds one finished turn. t: { usage: { prompt, output }, cost (USD at the rate of t.model), model, finishReason }. Returns a new state. */
  function recordTurn(state, t, now) {
    const s = Object.assign({}, state);
    const u = t.usage || { prompt: 0, output: 0 };
    s.turns = state.turns + 1;
    s.tokens = { prompt: state.tokens.prompt + num(u.prompt), output: state.tokens.output + num(u.output), total: state.tokens.total + num(u.prompt) + num(u.output) };
    s.cost = Math.round((state.cost + num(t.cost)) * 1e6) / 1e6;
    s.lastFinishReason = t.finishReason || "";
    s.truncStreak = t.finishReason === "MAX_TOKENS" ? (state.truncStreak || 0) + 1 : 0;
    if (t.model) s.model = t.model;
    s.log = state.log.concat([{ n: s.turns, model: t.model || state.model || "", prompt: num(u.prompt), output: num(u.output), usd: num(t.cost), finish: t.finishReason || "" }]).slice(-LOG_MAX);
    s.updatedAt = now || state.updatedAt;
    return s;
  }

  // ---------- the conversation text ----------

  const markerText = (userText) => {
    if (userText === CONTINUE_WORD) return MARK_CONTINUE;
    return String(userText).replace(/\s+/g, " ").trim().slice(0, 400);
  };
  const MARKER_SRC = "(?:^|\\n)---\\nYou: ([^\\n]*)\\n---\\n+";

  /**
   * history [{ role, text }] to the text saved as project.text: each user turn is a short "---, You: ..., ---" block (a Latin-only
   * line between rules, which the parser treats as a boundary), each model reply is kept whole. The first user message, which can
   * be long, is shown as "[book input]" (it is kept in state.first).
   */
  function buildTranscript(history) {
    const out = [];
    history.forEach((m, i) => {
      if (m.role === "user") out.push("---\nYou: " + (i === 0 ? MARK_FIRST : markerText(m.text)) + "\n---");
      else out.push(m.text.trim());
    });
    return out.join("\n\n");
  }

  /** The inverse of buildTranscript, given the first user message. Free-text user replies come back as saved (one line, cut at 400). */
  function historyFromTranscript(text, first) {
    const history = [];
    const re = new RegExp(MARKER_SRC, "g");
    let last = 0, m, user = null;
    const flush = (end) => {
      if (user === null) return;
      history.push({ role: "user", text: user });
      const reply = text.slice(last, end).trim();
      if (reply) history.push({ role: "model", text: reply });
    };
    while ((m = re.exec(text))) {
      flush(m.index);
      user = history.length === 0 ? first : m[1] === MARK_CONTINUE ? CONTINUE_WORD : m[1];
      last = re.lastIndex;
    }
    flush(text.length);
    return history;
  }

  // ---------- the full conversation view ----------

  const MARK_LEN = 400;
  /**
   * history [{ role, text }] plus state.meta [{ model, stage }] (one per finished turn, newest last) to the turns shown in the
   * "Full conversation" card: [{ n, stage, stageLabel, model, user, reply, userCut }]. Meta is matched from the end, so a run saved
   * before meta existed still lists every turn (without model or stage). A reloaded run keeps replies whole; your own messages come
   * back as saved, one line cut at 400 characters (userCut), except the first message (the book input), which is kept whole.
   */
  function conversation(history, meta) {
    const turns = [], m = meta || [], pairs = Math.floor(history.length / 2);
    for (let i = 0; i + 1 < history.length; i += 2) {
      const u = history[i], r = history[i + 1];
      if (!u || u.role !== "user" || !r || r.role !== "model") continue;
      const k = turns.length, mi = m.length - pairs + k, x = mi >= 0 ? m[mi] : null;
      const stage = x && STAGES[x.stage - 1] ? STAGES[x.stage - 1] : null;
      const user = u.text === CONTINUE_WORD ? "Continue" : String(u.text);
      turns.push({ n: k + 1, stage: stage ? stage.n : 0, stageLabel: stage ? stage.label : "", model: (x && x.model) || "", user, reply: r.text, userCut: k > 0 && u.text !== CONTINUE_WORD && user.length >= MARK_LEN });
    }
    return turns;
  }

  /** One turn as plain text. */
  function turnText(t) {
    return "Turn " + t.n + (t.stage ? " | Stage " + t.stage + ": " + t.stageLabel : "") + (t.model ? " | " + t.model : "") + "\n\nYou:\n" + t.user + "\n\nModel:\n" + t.reply;
  }

  /** The whole conversation as plain text, turns separated by a rule. */
  function conversationText(turns) {
    const rule = "\n\n" + "=".repeat(60) + "\n\n";
    return turns.map(turnText).join(rule) + "\n";
  }

  // ---------- simulated director for /demo ----------

  /**
   * Splits a sample conversation into about n replies at its headings ("## " and "### " lines), merging the smallest neighbours
   * until n are left. Used by the /demo simulation; no network.
   */
  function splitSample(text, n) {
    const lines = String(text).split("\n");
    const cuts = [0];
    lines.forEach((l, i) => { if (i > 0 && /^#{2,3} /.test(l)) cuts.push(i); });
    const segs = cuts.map((c, i) => lines.slice(c, cuts[i + 1] === undefined ? lines.length : cuts[i + 1]).join("\n").trim()).filter(Boolean);
    while (segs.length > Math.max(1, n)) {
      let k = 0, min = Infinity;
      for (let i = 0; i < segs.length - 1; i++) { const s = segs[i].length + segs[i + 1].length; if (s < min) { min = s; k = i; } }
      segs.splice(k, 2, segs[k] + "\n\n" + segs[k + 1]);
    }
    // each reply ends the way a stage does, so the run behaves like a real one
    return segs.map((s, i) => (i < segs.length - 1 ? s + "\n\nSend Continue for the next stage." : s));
  }

  return { CONTINUE_WORD, CONGRATS, DEFAULT_MAX_TURNS, STAGES, ROUTE_PRESETS, DEFAULT_ROUTE, FLASH, CARBON, normalizeRoute, stageModel, routeLabelId, pickModel, MARK_CONTINUE, MARK_FIRST, create, stageOf, isComplete, endsWithQuestion, decide, recordTurn, buildTranscript, historyFromTranscript, conversation, turnText, conversationText, splitSample };
});
