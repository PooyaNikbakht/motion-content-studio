/*
 * Gemini client for the AI Director. Pure functions plus fetch calls that are passed in, so everything is testable in Node.
 * Endpoints (checked against ai.google.dev/gemini-api/docs on 2026-11-17):
 *   POST /v1beta/models/{model}:streamGenerateContent?alt=sse   header x-goog-api-key
 *   POST /v1beta/models/{model}:countTokens
 *   GET  /v1beta/models?pageSize=1                              (Test key)
 *   POST /upload/v1beta/files                                   (resumable File API upload, for PDFs over the inline limit)
 * The key is sent only to generativelanguage.googleapis.com, in the x-goog-api-key header. It and the prompt are never logged.
 * UMD: window.MBSGemini in the browser, require() in Node.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MBSGemini = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const API = "https://generativelanguage.googleapis.com";
  /**
   * Models offered in Setup, default first. maxOutput is the documented output limit, thinking included. note is shown under the picker.
   * gemini-2.5-pro and gemini-2.5-flash stay selectable but are deprecated.
   */
  const MODELS = [
    { id: "gemini-3.8-flash", label: "Fast and low cost (default)", maxOutput: 65536, note: "" },
    { id: "gemini-4-hydrogen", label: "Fast and efficient", maxOutput: 65536, note: "" },
    { id: "gemini-4-carbon", label: "Best quality", maxOutput: 65536, note: "Priced at $2 in / $10 out per 1M tokens until 30 Nov 2026, then $4 / $20." },
    { id: "gemini-2.5-pro", label: "Deprecated", maxOutput: 65536, note: "Deprecated: it may return 404 for new API keys." },
    { id: "gemini-2.5-flash", label: "Deprecated", maxOutput: 65536, note: "Deprecated: it may return 404 for new API keys." },
  ];
  const DEFAULT_MODEL = "gemini-3.8-flash";
  const DEFAULT_TEMPERATURE = 0.7;
  /** Largest PDF sent inline. Inline data is re-sent on every turn, so bigger files go through the File API. */
  const INLINE_MAX_BYTES = 14 * 1024 * 1024;
  /** The API accepts PDFs up to 50 MB or 1000 pages (inline and File API alike). Each page is about 258 tokens. */
  const PDF_MAX_BYTES = 50 * 1024 * 1024;
  const PDF_MAX_PAGES = 1000;
  const PDF_TOKENS_PER_PAGE = 258;
  const MAX_RETRIES = 4;

  const maxOutputFor = (model) => (MODELS.find((m) => m.id === model) || { maxOutput: 8192 }).maxOutput;
  const modelPath = (model) => "/v1beta/models/" + encodeURIComponent(model);
  const streamUrl = (model) => API + modelPath(model) + ":streamGenerateContent?alt=sse";
  const countUrl = (model) => API + modelPath(model) + ":countTokens";
  const listUrl = () => API + "/v1beta/models?pageSize=1";
  const uploadUrl = () => API + "/upload/v1beta/files";

  class GeminiError extends Error {
    constructor(kind, message, extra) {
      super(message);
      this.name = "GeminiError";
      this.kind = kind;
      Object.assign(this, extra || {});
    }
  }

  // ---------- request building ----------

  /** First user message text: output language, then the title and summary the user typed (either or both). */
  function firstMessage(o) {
    const lines = ["Output language: " + (o.language === "fa" ? "Persian" : "English") + "."];
    if (o.title && o.title.trim()) lines.push("Book title: " + o.title.trim());
    if (o.summary && o.summary.trim()) lines.push("Book summary or notes:\n" + o.summary.trim());
    if (o.hasPdf) lines.push("The book is attached as a PDF.");
    return lines.join("\n");
  }

  /** The part that carries a PDF: { inline: base64, mime } or { uri, mime }. */
  function pdfPart(pdf) {
    if (!pdf) return null;
    if (pdf.uri) return { file_data: { mime_type: pdf.mime || "application/pdf", file_uri: pdf.uri } };
    if (pdf.inline) return { inline_data: { mime_type: pdf.mime || "application/pdf", data: pdf.inline } };
    return null;
  }

  /**
   * History [{ role: "user"|"model", text }] to API contents. The PDF rides on the first user message, so every request carries it:
   * Gemini has no memory between calls, and a PDF is billed again as input tokens on each turn either way (inline or File API).
   */
  function toContents(history, pdf) {
    const part = pdfPart(pdf);
    let attached = false;
    return history.map((m) => {
      const parts = [];
      if (m.role === "user" && part && !attached) { parts.push(part); attached = true; }
      parts.push({ text: m.text });
      return { role: m.role === "model" ? "model" : "user", parts };
    });
  }

  /** Body for generateContent and streamGenerateContent. */
  function buildBody(o) {
    return {
      systemInstruction: { parts: [{ text: o.system || "" }] },
      contents: o.contents,
      generationConfig: { temperature: o.temperature === undefined ? DEFAULT_TEMPERATURE : o.temperature, maxOutputTokens: o.maxOutputTokens || maxOutputFor(o.model) },
    };
  }

  // ---------- SSE ----------

  /**
   * Incremental Server-Sent Events parser. push(text) takes any slice of the stream (chunks can end mid-line or mid-event)
   * and returns the JSON payloads of the events completed so far. Handles LF and CRLF, comments and multi-line data.
   * A payload that is not JSON comes back as { _raw }.
   */
  function createSseParser() {
    let buf = "", data = [];
    const out = [];
    const emit = () => {
      if (!data.length) return;
      const s = data.join("\n"); data = [];
      if (s === "[DONE]") return;
      try { out.push(JSON.parse(s)); } catch { out.push({ _raw: s }); }
    };
    const line = (l) => {
      if (l === "") { emit(); return; }
      if (l.charAt(0) === ":") return;
      const i = l.indexOf(":");
      const field = i < 0 ? l : l.slice(0, i);
      if (field !== "data") return;
      let v = i < 0 ? "" : l.slice(i + 1);
      if (v.charAt(0) === " ") v = v.slice(1);
      data.push(v);
    };
    return {
      push(chunk) {
        buf += chunk;
        let m;
        while ((m = /\r\n|\n|\r/.exec(buf))) {
          if (m[0] === "\r" && m.index === buf.length - 1) break; // a CR at the very end may be the start of CRLF
          line(buf.slice(0, m.index));
          buf = buf.slice(m.index + m[0].length);
        }
        const r = out.splice(0, out.length);
        return r;
      },
      /** At the end of the stream: a last event without its blank line. */
      flush() {
        if (buf) { line(buf.replace(/\r$/, "")); buf = ""; }
        emit();
        return out.splice(0, out.length);
      },
    };
  }

  // ---------- one streamed reply ----------

  const BLOCK_FINISH = ["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION", "IMAGE_SAFETY", "LANGUAGE"];

  const blockText = (reason) => "Gemini stopped this reply (" + reason + "). Change the book input or the prompt and try again.";

  /** Reads Gemini's usageMetadata into { prompt, candidates, thoughts, output, total, cached }; output = candidates + thinking (what is billed as output). */
  function normalizeUsage(u) {
    if (!u) return null;
    const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    const prompt = n(u.promptTokenCount), candidates = n(u.candidatesTokenCount), thoughts = n(u.thoughtsTokenCount);
    const output = candidates + thoughts;
    return { prompt, candidates, thoughts, output, total: n(u.totalTokenCount) || prompt + output, cached: n(u.cachedContentTokenCount) };
  }

  /** Adds one turn's usage into a running total. */
  function addUsage(acc, usage) {
    const a = acc || { prompt: 0, output: 0, total: 0, turns: 0 };
    if (!usage) return a;
    return { prompt: a.prompt + usage.prompt, output: a.output + usage.output, total: a.total + usage.total, turns: a.turns + 1 };
  }

  /** Folds the events of one stream into { text, usage, finishReason, blockReason }. add() returns the new text of that event. */
  function createTurn() {
    const t = { text: "", usage: null, finishReason: "", blockReason: "" };
    return {
      t,
      add(ev) {
        if (!ev || ev._raw !== undefined) return "";
        if (ev.error) throw mapError(Number(ev.error.code) || 0, ev);
        let delta = "";
        if (ev.promptFeedback && ev.promptFeedback.blockReason) t.blockReason = ev.promptFeedback.blockReason;
        const c = ev.candidates && ev.candidates[0];
        if (c) {
          ((c.content && c.content.parts) || []).forEach((p) => { if (typeof p.text === "string" && !p.thought) delta += p.text; });
          if (c.finishReason) {
            t.finishReason = c.finishReason;
            if (BLOCK_FINISH.includes(c.finishReason) && !t.blockReason) t.blockReason = c.finishReason;
          }
        }
        if (ev.usageMetadata) t.usage = normalizeUsage(ev.usageMetadata);
        t.text += delta;
        return delta;
      },
    };
  }

  // ---------- errors and retries ----------

  const retryAfterOf = (headers, body) => {
    const h = headers && typeof headers.get === "function" ? headers.get("retry-after") : null;
    if (h) {
      const s = Number(h);
      if (Number.isFinite(s)) return Math.round(s * 1000);
      const d = Date.parse(h);
      if (Number.isFinite(d)) return Math.max(0, d - Date.now());
    }
    const details = body && body.error && body.error.details;
    const info = Array.isArray(details) && details.find((d) => d && d.retryDelay);
    const m = info && /^([\d.]+)s$/.exec(String(info.retryDelay));
    return m ? Math.round(Number(m[1]) * 1000) : 0;
  };

  /**
   * Maps an HTTP status (or the code of an error event) and its body to a GeminiError with a message the user can act on.
   * body: the parsed JSON, or text. headers: a Headers object (optional). Never includes the key or the prompt.
   */
  function mapError(status, body, headers) {
    const e = body && typeof body === "object" ? body.error || {} : {};
    const raw = String(e.message || (typeof body === "string" ? body : "") || "").slice(0, 300);
    const st = Number(status) || Number(e.code) || 0;
    const retryAfterMs = retryAfterOf(headers, body);
    if (st === 400 && /api key not valid|api_key_invalid|API key expired/i.test(raw + JSON.stringify(e.details || ""))) return new GeminiError("auth", "Gemini says the API key is not valid. Check the key in Setup.", { status: st });
    if (st === 400 && /token count|exceeds the maximum|input is too long/i.test(raw)) return new GeminiError("too_long", "The conversation no longer fits in the model's context window. Start over, or use a shorter book input.", { status: st });
    if (st === 400 && /FAILED_PRECONDITION|location is not supported/i.test(raw + (e.status || ""))) return new GeminiError("region", "Gemini is not available for this key or region (" + raw + ").", { status: st });
    if (st === 400) return new GeminiError("bad_request", "Gemini rejected the request (400)" + (raw ? ": " + raw : "") + ".", { status: st });
    if (st === 401 || st === 403) return new GeminiError("auth", "Gemini refused the API key (" + st + "). Check the key in Setup, and that the Generative Language API is enabled for it.", { status: st });
    if (st === 404) return new GeminiError("not_found", "This model is not available for your key (404). Pick another model in Setup." + (raw ? " " + raw : ""), { status: st });
    if (st === 413) return new GeminiError("too_large", "The request is too large. Compress the PDF or paste a summary instead.", { status: st });
    if (st === 429) return new GeminiError("rate", "Gemini rate limit or quota reached (429)." + (raw ? " " + raw : ""), { status: st, retryable: true, retryAfterMs });
    if (st === 500 || st === 502 || st === 503 || st === 504) return new GeminiError("unavailable", "Gemini is busy or down right now (" + st + ").", { status: st, retryable: true, retryAfterMs });
    return new GeminiError("unknown", "Gemini returned an unexpected error (" + (st || "no status") + ")" + (raw ? ": " + raw : "") + ".", { status: st });
  }

  /** Delay before retry number `attempt` (0 based): Retry-After when given, else 1s, 2s, 4s... capped at 30s, with up to 20% jitter. */
  function backoffDelay(attempt, retryAfterMs, rand) {
    const r = typeof rand === "function" ? rand : Math.random;
    const base = retryAfterMs > 0 ? Math.min(retryAfterMs, 120000) : Math.min(30000, 1000 * Math.pow(2, attempt));
    return Math.round(base * (1 + 0.2 * r()));
  }

  async function errorFrom(res) {
    let body;
    try { const t = await res.text(); try { body = JSON.parse(t); } catch { body = t; } } catch { body = ""; }
    return mapError(res.status, body, res.headers);
  }

  const abortError = () => new GeminiError("aborted", "Stopped.");
  const isAbort = (e, signal) => (signal && signal.aborted) || (e && e.name === "AbortError");

  // Waits ms, or rejects early when the signal aborts.
  function waitFor(ms, signal, sleep) {
    if (sleep) return sleep(ms, signal);
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(abortError());
      const id = setTimeout(() => { if (signal) signal.removeEventListener("abort", onAbort); resolve(); }, ms);
      const onAbort = () => { clearTimeout(id); reject(abortError()); };
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * One streamed model reply. o: { fetch, key, model, body, signal, onText(delta, fullText), onRetry({attempt, delayMs, status, kind}), sleep, rand, maxRetries }.
   * Retries 429 and 5xx (and a failed connection) before any text arrived, honouring Retry-After. Returns { text, usage, finishReason, blockReason }.
   * Throws GeminiError (kind auth, bad_request, rate, unavailable, network, aborted ...); a stream cut mid-reply throws kind "network" with .partial.
   */
  async function streamTurn(o) {
    const f = o.fetch || (typeof fetch !== "undefined" ? fetch.bind(globalThis) : null);
    if (!f) throw new GeminiError("network", "fetch is not available.");
    const max = o.maxRetries === undefined ? MAX_RETRIES : o.maxRetries;
    for (let attempt = 0; ; attempt++) {
      if (o.signal && o.signal.aborted) throw abortError();
      let res, err = null;
      try {
        res = await f(streamUrl(o.model), { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": o.key }, body: JSON.stringify(o.body), signal: o.signal });
        if (!res.ok) err = await errorFrom(res);
      } catch (e) {
        if (isAbort(e, o.signal)) throw abortError();
        err = new GeminiError("network", "Could not reach Gemini. Check your connection.", { retryable: true });
      }
      if (err) {
        if (err.retryable && attempt < max) {
          const delayMs = backoffDelay(attempt, err.retryAfterMs, o.rand);
          if (o.onRetry) o.onRetry({ attempt: attempt + 1, delayMs, status: err.status || 0, kind: err.kind });
          await waitFor(delayMs, o.signal, o.sleep);
          continue;
        }
        throw err;
      }
      const sse = createSseParser(), turn = createTurn();
      const feed = (events) => { for (const ev of events) { const d = turn.add(ev); if (d && o.onText) o.onText(d, turn.t.text); } };
      try {
        if (res.body && typeof res.body.getReader === "function") {
          const reader = res.body.getReader(), dec = new TextDecoder("utf-8");
          if (o.signal) o.signal.addEventListener("abort", () => { reader.cancel().catch(() => {}); }, { once: true });
          for (;;) {
            const { done, value } = await reader.read();
            if (o.signal && o.signal.aborted) throw abortError();
            if (done) break;
            feed(sse.push(dec.decode(value, { stream: true })));
          }
          feed(sse.push(dec.decode()));
        } else feed(sse.push(await res.text()));
        feed(sse.flush());
      } catch (e) {
        if (isAbort(e, o.signal)) throw abortError();
        if (e instanceof GeminiError) { e.partial = turn.t.text; throw e; }
        throw new GeminiError("network", "The connection dropped while Gemini was replying.", { partial: turn.t.text });
      }
      return turn.t;
    }
  }

  // ---------- other calls ----------

  async function jsonCall(o, url, init) {
    const f = o.fetch || fetch.bind(globalThis);
    let res;
    try { res = await f(url, Object.assign({ signal: o.signal }, init)); } catch (e) {
      if (isAbort(e, o.signal)) throw abortError();
      throw new GeminiError("network", "Could not reach Gemini. Check your connection.");
    }
    if (!res.ok) throw await errorFrom(res);
    return res.json();
  }

  /** Cheap key check: lists one model. Resolves { ok: true } or throws a GeminiError. */
  async function testKey(o) {
    await jsonCall(o, listUrl(), { method: "GET", headers: { "x-goog-api-key": o.key } });
    return { ok: true };
  }

  /** Free token count of a whole request (system prompt, history, PDF). o: { fetch, key, model, system, contents }. Returns the total. */
  async function countTokens(o) {
    const req = { model: "models/" + o.model, contents: o.contents };
    if (o.system) req.systemInstruction = { parts: [{ text: o.system }] };
    const d = await jsonCall(o, countUrl(o.model), { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": o.key }, body: JSON.stringify({ generateContentRequest: req }) });
    return Number(d.totalTokens) || 0;
  }

  // ---------- PDF helpers ----------

  /** Base64 of a Blob or File (browser: FileReader; Node: Buffer). */
  async function blobToBase64(blob) {
    if (typeof FileReader !== "undefined") {
      return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(",")[1] || "");
        r.onerror = () => reject(r.error);
        r.readAsDataURL(blob);
      });
    }
    return Buffer.from(await blob.arrayBuffer()).toString("base64");
  }

  /** Page count read from the PDF's page objects; null when it cannot be told cheaply (compressed object streams). */
  function countPdfPages(bytes) {
    const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let s = "";
    for (let i = 0; i < u.length; i += 1 << 16) s += String.fromCharCode.apply(null, u.subarray(i, Math.min(u.length, i + (1 << 16))));
    const n = (s.match(/\/Type\s*\/Page(?![A-Za-z])/g) || []).length;
    return n || null;
  }

  /** Why a PDF cannot be used, or "" when it can. size in bytes, pages may be null. */
  function pdfProblem(size, pages) {
    if (size > PDF_MAX_BYTES) return "This PDF is over 50 MB. Compress it, or paste a summary instead.";
    if (pages && pages > PDF_MAX_PAGES) return "This PDF has more than 1,000 pages. Split it, or paste a summary instead.";
    return "";
  }

  /**
   * File API upload (resumable): start, send the bytes, wait until the file is ACTIVE. o: { fetch, key, blob, name, mime, signal, sleep }.
   * Returns { uri, name, mime, expiresAt }. Files are kept for 48 hours.
   * The preflight for these calls is allowed from browsers (checked 2026-11-17), but the start response must expose x-goog-upload-url
   * for the page to read it; if it does not, this throws kind "cors" so the UI can ask for a smaller PDF or a summary.
   */
  async function uploadFile(o) {
    const f = o.fetch || fetch.bind(globalThis), mime = o.mime || "application/pdf", size = o.blob.size;
    const fail = new GeminiError("upload", "The PDF could not be uploaded from the browser. Compress it to under about 14 MB, or paste a summary instead.");
    let start;
    try {
      start = await f(uploadUrl(), {
        method: "POST", signal: o.signal,
        headers: { "x-goog-api-key": o.key, "X-Goog-Upload-Protocol": "resumable", "X-Goog-Upload-Command": "start", "X-Goog-Upload-Header-Content-Length": String(size), "X-Goog-Upload-Header-Content-Type": mime, "Content-Type": "application/json" },
        body: JSON.stringify({ file: { display_name: o.name || "book.pdf" } }),
      });
    } catch (e) { if (isAbort(e, o.signal)) throw abortError(); throw fail; }
    if (!start.ok) throw await errorFrom(start);
    const url = start.headers && start.headers.get("x-goog-upload-url");
    if (!url) throw fail;
    let up;
    try { up = await f(url, { method: "POST", signal: o.signal, headers: { "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize" }, body: o.blob }); } catch (e) { if (isAbort(e, o.signal)) throw abortError(); throw fail; }
    if (!up.ok) throw await errorFrom(up);
    let file = (await up.json()).file || {};
    for (let i = 0; i < 20 && file.state && file.state !== "ACTIVE"; i++) {
      if (file.state === "FAILED") throw new GeminiError("upload", "Gemini could not read this PDF. Try another copy, or paste a summary instead.");
      await waitFor(1500, o.signal, o.sleep);
      file = await jsonCall(o, API + "/v1beta/" + file.name, { method: "GET", headers: { "x-goog-api-key": o.key } });
    }
    return { uri: file.uri, name: file.name, mime, expiresAt: file.expirationTime ? Date.parse(file.expirationTime) : Date.now() + 47 * 3600 * 1000 };
  }

  return {
    API, MODELS, DEFAULT_MODEL, DEFAULT_TEMPERATURE, INLINE_MAX_BYTES, PDF_MAX_BYTES, PDF_MAX_PAGES, PDF_TOKENS_PER_PAGE, MAX_RETRIES,
    GeminiError, maxOutputFor, streamUrl, countUrl, listUrl, uploadUrl,
    firstMessage, pdfPart, toContents, buildBody, createSseParser, createTurn, normalizeUsage, addUsage, blockText,
    mapError, backoffDelay, streamTurn, testKey, countTokens, blobToBase64, countPdfPages, pdfProblem, uploadFile,
  };
});
