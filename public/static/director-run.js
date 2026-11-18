/*
 * AI Director runner: drives the turns of one run on top of director.js. No DOM and no direct network: everything outside is injected,
 * so the same runner drives Gemini in /app and the simulated director in /demo, and tests use fakes.
 *   deps.turn({ history, model, signal, onText, onRetry }) -> Promise<{ text, usage: { prompt, output }, finishReason, blockReason }>
 *   deps.parse(text)                                 -> parsed object (the app's parser)
 *   deps.cost(usage, model)                          -> USD for one turn at that model's rates
 *   deps.route()                                     -> the routing { preset, stages } read at the start of every turn (optional)
 *   deps.pauseEach()                                 -> true: Auto-Run stops after every finished stage reply (optional)
 *   deps.onChange(view)                              view = { state, stream, retry } after every status change and every streamed piece
 *   deps.onTurn({ state, text, parsed, history })    after every finished model reply (save the project here)
 * Start Project sends the first message; Next Step sends the continue word once; Auto-Run keeps going until a stop condition
 * (see D.decide) or Pause or Stop. Pause and Stop abort the reply in flight and drop it: the same message is sent again on Resume.
 * UMD: window.MBSDirectorRun in the browser, require() in Node.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(typeof require === "function" ? require("./director.js") : root.MBSDirector);
  else root.MBSDirectorRun = factory(root.MBSDirector);
})(typeof self !== "undefined" ? self : this, function (D) {
  "use strict";

  function createRunner(deps) {
    const now = deps.now || Date.now;
    let st = null, history = [], text = "", parsed = null;
    let pending = null, ctl = null, busy = false, stream = "", retry = null;

    const emit = () => { if (deps.onChange) deps.onChange({ state: st, stream, retry }); };
    const setState = (patch) => { st = Object.assign({}, st, patch, { updatedAt: now() }); };
    const aborted = (e) => e && (e.kind === "aborted" || e.name === "AbortError");

    /** Runs one turn for `pending`. Resolves the decision ({ action, ... }), or null when the turn did not finish. */
    async function turn() {
      ctl = new AbortController();
      stream = ""; retry = null;
      const model = D.pickModel(st, deps.route ? deps.route() : null, st.model);
      setState({ status: "running", pause: null, error: "", model });
      emit();
      let r;
      try {
        r = await deps.turn({
          history: history.concat([{ role: "user", text: pending }]), model, signal: ctl.signal,
          onText: (d, full) => { stream = full; emit(); },
          onRetry: (x) => { retry = x; emit(); },
        });
      } catch (e) {
        if (!aborted(e) && st.status === "running") setState({ status: "error", auto: false, error: (e && e.message) || "The request failed." });
        emit();
        return null;
      }
      if (st.status !== "running") return null; // paused or stopped while the reply was arriving: dropped
      retry = null;
      if (r.blockReason) {
        setState({ status: "paused", auto: false, pause: { reason: "blocked", message: D.decide(st, "x", null, { blockReason: r.blockReason }).message } });
        emit();
        return null;
      }
      const usage = r.usage || { prompt: 0, output: 0 };
      history = history.concat([{ role: "user", text: pending }, { role: "model", text: r.text }]);
      pending = null;
      st = D.recordTurn(st, { usage, cost: deps.cost(usage, model), model, finishReason: r.finishReason }, now());
      text = D.buildTranscript(history);
      parsed = deps.parse(text);
      st.stage = D.stageOf(parsed).n;
      st.meta = (st.meta || []).concat([{ model, stage: st.stage }]).slice(-200);
      const dec = D.decide(st, r.text, parsed, { finishReason: r.finishReason });
      if (dec.action === "done") setState({ status: "done", auto: false, pause: null });
      else if (dec.action === "pause") setState({ status: "paused", auto: false, pause: { reason: dec.reason, message: dec.message, reply: dec.reason === "question" ? r.text : undefined } });
      else {
        pending = D.CONTINUE_WORD;
        // "Pause after each stage": Auto-Run hands control back after a finished stage reply
        setState({ status: "waiting", auto: st.auto && !(dec.reason === "stage" && deps.pauseEach && deps.pauseEach()) });
      }
      stream = "";
      if (deps.onTurn) await deps.onTurn({ state: st, text, parsed, history });
      emit();
      return dec;
    }

    async function loop() {
      if (busy) return;
      busy = true;
      try {
        for (;;) {
          const dec = await turn();
          if (!dec || dec.action !== "continue" || !st.auto || st.status !== "waiting") break;
        }
      } finally { busy = false; }
    }

    return {
      get state() { return st; },
      get busy() { return busy; },
      get text() { return text; },
      get history() { return history; },
      get parsed() { return parsed; },
      get pending() { return pending; },

      /** Starts a new run with the first user message. o: D.create options. Runs the first turn, then waits (or goes on when auto). */
      async start(o, auto) {
        if (busy) return;
        st = D.create(Object.assign({ now: now() }, o));
        history = []; text = ""; parsed = null; pending = o.first;
        st.auto = !!auto;
        st.first = o.first.slice(0, 30000);
        await loop();
      },

      /** Rebuilds a saved run: { state, text, history }. A run that was mid-reply when the page closed comes back paused. */
      load(saved) {
        st = Object.assign({}, saved.state);
        history = saved.history || D.historyFromTranscript(saved.text || "", st.first);
        text = saved.text || D.buildTranscript(history);
        parsed = deps.parse(text);
        if (history.length && history[history.length - 1].role === "user") history = history.slice(0, -1);
        pending = history.length ? D.CONTINUE_WORD : st.first;
        if (st.status === "running") st = Object.assign({}, st, { status: "paused", auto: false, pause: { reason: "interrupted", message: "The page was closed during a reply. Press Resume to continue." } });
        emit();
      },

      /** One more step: sends the continue word (or the free text of a manual reply) once. */
      async next(userText) {
        if (busy || !st || ["running", "done", "idle"].includes(st.status)) return;
        if (userText) pending = userText;
        else if (!pending) pending = D.CONTINUE_WORD;
        setState({ auto: false });
        await loop();
      },

      /** Auto-Run: keeps sending the continue word until a stop condition. */
      async auto(userText) {
        if (busy || !st || ["running", "done", "idle"].includes(st.status)) return;
        if (userText) pending = userText;
        else if (!pending) pending = D.CONTINUE_WORD;
        setState({ auto: true });
        await loop();
      },

      /**
       * Drops the last model reply and sends the same message again (the tokens already spent stay counted). Works from a finished stage,
       * a pause, an error, a stop or the end of the run.
       */
      async regenerate() {
        if (busy || !st || st.status === "running" || st.status === "idle") return;
        const n = history.length;
        if (n < 2 || history[n - 1].role !== "model") return;
        pending = history[n - 2].text;
        history = history.slice(0, n - 2);
        text = D.buildTranscript(history);
        parsed = deps.parse(text);
        st.meta = (st.meta || []).slice(0, -1);
        setState({ status: "waiting", auto: false, pause: null, error: "", stage: D.stageOf(parsed).n, truncStreak: 0 });
        if (history.length && deps.onTurn) await deps.onTurn({ state: st, text, parsed, history });
        emit();
        await loop();
      },

      /** Replaces the last model reply with the user's edited text (for the next turns it is what the director said). Returns true when applied. */
      async editLast(newText) {
        if (busy || !st || st.status === "running") return false;
        const n = history.length, t = String(newText || "").trim();
        if (!t || n < 1 || history[n - 1].role !== "model") return false;
        history = history.slice(0, n - 1).concat([{ role: "model", text: t }]);
        text = D.buildTranscript(history);
        parsed = deps.parse(text);
        setState({ stage: D.stageOf(parsed).n });
        if (deps.onTurn) await deps.onTurn({ state: st, text, parsed, history });
        emit();
        return true;
      },

      /** Answers the director's question with free text and goes on (auto stays as it was before the question). */
      async reply(userText, auto) {
        if (busy || !st) return;
        pending = String(userText);
        setState({ auto: !!auto });
        await loop();
      },

      pause() {
        if (!st || st.status !== "running") return;
        setState({ status: "paused", auto: false, pause: { reason: "user", message: "Paused. The reply in progress was dropped and is sent again on Resume." } });
        stream = "";
        if (ctl) ctl.abort();
        emit();
      },

      /** Resume after Pause, an error, a blocked or empty reply, or the turn limit; keeps Auto-Run if it was on before the pause. */
      async resume(auto) {
        if (busy || !st || !["paused", "error", "stopped"].includes(st.status)) return;
        if (!pending) pending = D.CONTINUE_WORD;
        setState({ auto: !!auto });
        await loop();
      },

      stop() {
        if (!st || ["idle", "done", "stopped"].includes(st.status)) return;
        setState({ status: "stopped", auto: false, pause: null });
        stream = "";
        if (ctl) ctl.abort();
        emit();
      },

      /** Picks the model for the next turns from now on ("" goes back to the routing). */
      setModel(id) {
        if (!st) return;
        const m = String(id || "");
        const next = Object.assign({}, st, { updatedAt: now() });
        if (m) next.modelOverride = m; else delete next.modelOverride;
        st = next;
        emit();
      },

      setMaxTurns(n) {
        if (!st) return;
        setState({ maxTurns: Math.max(1, Math.floor(Number(n)) || D.DEFAULT_MAX_TURNS) });
        emit();
      },

      /** Leaves the run (project switched): aborts a reply in flight without changing the saved state. */
      detach() { if (ctl) ctl.abort(); st = null; history = []; text = ""; parsed = null; pending = null; busy = false; },
    };
  }

  return { createRunner };
});
