const test = require("node:test");
const assert = require("node:assert/strict");
const G = require("../public/static/gemini.js");

const ev = (o) => "data: " + JSON.stringify(o) + "\r\n\r\n";
const cand = (text, extra) => ({ candidates: [Object.assign({ content: { role: "model", parts: [{ text }] }, index: 0 }, extra || {})] });
const usage = { promptTokenCount: 1000, candidatesTokenCount: 50, thoughtsTokenCount: 20, totalTokenCount: 1070 };

function streamRes(chunks, status, headers) {
  const enc = new TextEncoder();
  let i = 0;
  const body = new ReadableStream({ pull(c) { if (i < chunks.length) c.enqueue(enc.encode(chunks[i++])); else c.close(); } });
  return new Response(body, { status: status || 200, headers: headers || { "content-type": "text/event-stream" } });
}
const errRes = (status, message, headers, extra) => new Response(JSON.stringify({ error: Object.assign({ code: status, message, status: "X" }, extra || {}) }), { status, headers: Object.assign({ "content-type": "application/json" }, headers || {}) });
const noSleep = () => Promise.resolve();

test("SSE parser: events split at every possible boundary give the same result", () => {
  const stream = ev(cand("Hello ")) + ev(cand("wor")) + ": comment\r\n\r\n" + ev(cand("ld", { finishReason: "STOP" })).replace("\r\n\r\n", "\n\n") + "data: [DONE]\n\n";
  const whole = G.createSseParser().push(stream);
  assert.equal(whole.length, 3);
  for (let cut = 1; cut < stream.length; cut++) {
    const p = G.createSseParser();
    const got = p.push(stream.slice(0, cut)).concat(p.push(stream.slice(cut)), p.flush());
    assert.deepEqual(got, whole, "cut at " + cut);
  }
});

test("SSE parser: multi-line data, a final event without its blank line, and non-JSON payloads", () => {
  const p = G.createSseParser();
  assert.deepEqual(p.push('data: {"a":\ndata: 1}\n\ndata: oops\n\n'), [{ a: 1 }, { _raw: "oops" }]);
  assert.deepEqual(p.push('data: {"last":true}'), []);
  assert.deepEqual(p.flush(), [{ last: true }]);
});

test("turn folding: text, skipped thought parts, usage (thinking counts as output), finishReason", () => {
  const t = G.createTurn();
  assert.equal(t.add(cand("A")), "A");
  assert.equal(t.add({ candidates: [{ content: { parts: [{ text: "secret thinking", thought: true }, { text: "B" }] } }] }), "B");
  t.add(Object.assign(cand("C", { finishReason: "MAX_TOKENS" }), { usageMetadata: usage }));
  assert.equal(t.t.text, "ABC");
  assert.equal(t.t.finishReason, "MAX_TOKENS");
  assert.deepEqual(t.t.usage, { prompt: 1000, candidates: 50, thoughts: 20, output: 70, total: 1070, cached: 0 });
});

test("usage accumulates over turns", () => {
  let acc = null;
  acc = G.addUsage(acc, G.normalizeUsage(usage));
  acc = G.addUsage(acc, G.normalizeUsage({ promptTokenCount: 2000, candidatesTokenCount: 100 }));
  assert.deepEqual(acc, { prompt: 3000, output: 170, total: 3170, turns: 2 });
  assert.equal(G.normalizeUsage(null), null);
  assert.deepEqual(G.addUsage(acc, null), acc);
});

test("blocks: promptFeedback and a SAFETY finish both give a block reason", () => {
  const a = G.createTurn(); a.add({ promptFeedback: { blockReason: "PROHIBITED_CONTENT" } });
  assert.equal(a.t.blockReason, "PROHIBITED_CONTENT");
  const b = G.createTurn(); b.add(cand("x", { finishReason: "SAFETY" }));
  assert.equal(b.t.blockReason, "SAFETY");
  assert.match(G.blockText("SAFETY"), /SAFETY/);
});

test("streamTurn: streams text deltas, returns usage and finish reason, sends the key only in x-goog-api-key", async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return streamRes([ev(cand("Hel")), ev(cand("lo")).slice(0, 20), ev(cand("lo")).slice(20), ev(Object.assign(cand("!", { finishReason: "STOP" }), { usageMetadata: usage }))]);
  };
  const seen = [];
  const r = await G.streamTurn({ fetch, key: "K123", model: "gemini-2.5-pro", body: { x: 1 }, onText: (d, full) => seen.push([d, full]) });
  assert.equal(r.text, "Hello!");
  assert.deepEqual(seen.map((s) => s[0]), ["Hel", "lo", "!"]);
  assert.equal(seen[2][1], "Hello!");
  assert.equal(r.finishReason, "STOP");
  assert.equal(r.usage.output, 70);
  assert.equal(calls[0].url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse");
  assert.equal(calls[0].init.headers["x-goog-api-key"], "K123");
  assert.ok(!calls[0].url.includes("K123") && !calls[0].init.body.includes("K123"));
});

test("streamTurn: 429 then 503 are retried with backoff and Retry-After, then it succeeds", async () => {
  const queue = [errRes(429, "slow down", { "retry-after": "3" }), errRes(503, "overloaded"), streamRes([ev(cand("ok", { finishReason: "STOP" }))])];
  const waits = [], retries = [];
  const r = await G.streamTurn({ fetch: async () => queue.shift(), key: "k", model: "m", body: {}, sleep: async (ms) => { waits.push(ms); }, rand: () => 0, onRetry: (x) => retries.push(x) });
  assert.equal(r.text, "ok");
  assert.deepEqual(waits, [3000, 2000]);
  assert.deepEqual(retries.map((x) => [x.attempt, x.status]), [[1, 429], [2, 503]]);
});

test("streamTurn: gives up after the retry limit with a clear message", async () => {
  let n = 0;
  await assert.rejects(G.streamTurn({ fetch: async () => { n++; return errRes(503, "x"); }, key: "k", model: "m", body: {}, sleep: noSleep, maxRetries: 2 }), (e) => e.kind === "unavailable" && /busy or down/.test(e.message));
  assert.equal(n, 3);
});

test("streamTurn: 400, 401, 403 and 404 are not retried and map to readable kinds", async () => {
  const cases = [
    [400, "API key not valid. Please pass a valid API key.", "auth", /not valid/],
    [400, "Unable to process the request", "bad_request", /rejected the request/],
    [400, "The input token count exceeds the maximum number of tokens allowed", "too_long", /context window/],
    [401, "bad", "auth", /refused the API key \(401\)/],
    [403, "no", "auth", /refused the API key \(403\)/],
    [404, "models/x is not found", "not_found", /Pick another model/],
  ];
  for (const [status, msg, kind, re] of cases) {
    let n = 0;
    await assert.rejects(G.streamTurn({ fetch: async () => { n++; return errRes(status, msg); }, key: "k", model: "m", body: {}, sleep: noSleep }), (e) => e.kind === kind && re.test(e.message) && e.status === status);
    assert.equal(n, 1, status + " is not retried");
  }
});

test("streamTurn: abort stops the request, also while waiting to retry and mid-stream", async () => {
  const ac = new AbortController();
  const p = G.streamTurn({ fetch: async () => errRes(429, "x"), key: "k", model: "m", body: {}, signal: ac.signal, rand: () => 0 });
  setTimeout(() => ac.abort(), 20);
  await assert.rejects(p, (e) => e.kind === "aborted");
  const ac2 = new AbortController();
  const f2 = async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(ev(cand("part")))); }, pull() { return new Promise(() => {}); } }));
  const p2 = G.streamTurn({ fetch: f2, key: "k", model: "m", body: {}, signal: ac2.signal, onText: () => ac2.abort() });
  await assert.rejects(p2, (e) => e.kind === "aborted");
});

test("streamTurn: a dropped stream throws network with the partial text; a connection failure is retried", async () => {
  const dropped = async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(ev(cand("half")))); }, pull(c) { c.error(new Error("reset")); } }));
  await assert.rejects(G.streamTurn({ fetch: dropped, key: "k", model: "m", body: {} }), (e) => e.kind === "network" && e.partial === "half");
  let n = 0;
  const flaky = async () => { if (n++ === 0) throw new TypeError("Failed to fetch"); return streamRes([ev(cand("fine"))]); };
  assert.equal((await G.streamTurn({ fetch: flaky, key: "k", model: "m", body: {}, sleep: noSleep })).text, "fine");
});

test("an error event inside the stream is thrown", async () => {
  await assert.rejects(G.streamTurn({ fetch: async () => streamRes([ev({ error: { code: 503, message: "overloaded" } })]), key: "k", model: "m", body: {}, sleep: noSleep, maxRetries: 0 }), (e) => e.kind === "unavailable");
});

test("backoff doubles, is capped, and prefers Retry-After", () => {
  assert.deepEqual([0, 1, 2, 3].map((a) => G.backoffDelay(a, 0, () => 0)), [1000, 2000, 4000, 8000]);
  assert.equal(G.backoffDelay(10, 0, () => 0), 30000);
  assert.equal(G.backoffDelay(0, 7000, () => 0), 7000);
  assert.equal(G.backoffDelay(0, 1000, () => 1), 1200);
  assert.equal(G.mapError(429, { error: { message: "q", details: [{ retryDelay: "34s" }] } }).retryAfterMs, 34000);
});

test("contents: the PDF rides on the first user message only; inline or File API part shapes", () => {
  const h = [{ role: "user", text: "first" }, { role: "model", text: "reply" }, { role: "user", text: "go on" }];
  const inline = G.toContents(h, { inline: "QUJD" });
  assert.deepEqual(inline[0].parts, [{ inline_data: { mime_type: "application/pdf", data: "QUJD" } }, { text: "first" }]);
  assert.deepEqual(inline[1], { role: "model", parts: [{ text: "reply" }] });
  assert.deepEqual(inline[2].parts, [{ text: "go on" }]);
  assert.deepEqual(G.toContents(h, { uri: "https://x/files/1" })[0].parts[0], { file_data: { mime_type: "application/pdf", file_uri: "https://x/files/1" } });
  assert.deepEqual(G.toContents(h, null)[0].parts, [{ text: "first" }]);
});

test("request body: system instruction, contents, temperature and the model's output limit", () => {
  const b = G.buildBody({ system: "SYS", contents: [1], model: "gemini-2.5-flash" });
  assert.deepEqual(b.systemInstruction, { parts: [{ text: "SYS" }] });
  assert.equal(b.generationConfig.temperature, 0.7);
  assert.equal(b.generationConfig.maxOutputTokens, 65536);
  assert.equal(G.buildBody({ system: "", contents: [], model: "x", temperature: 0.2, maxOutputTokens: 100 }).generationConfig.temperature, 0.2);
});

test("first message: language plus title and summary, either or both", () => {
  assert.equal(G.firstMessage({ language: "en", title: "T" }), "Output language: English.\nBook title: T");
  assert.equal(G.firstMessage({ language: "fa", summary: " S ", hasPdf: true }), "Output language: Persian.\nBook summary or notes:\nS\nThe book is attached as a PDF.");
});

test("models: Flash 3.8 is the default, Carbon is best quality; test key and countTokens use the key header", async () => {
  assert.deepEqual(G.MODELS.slice(0, 4).map((m) => m.id), ["gemini-3.8-flash", "gemini-4-hydrogen", "gemini-4-carbon", "gemini-2.5-pro"]);
  assert.equal(G.DEFAULT_MODEL, "gemini-3.8-flash");
  assert.match(G.MODELS.find((m) => m.id === "gemini-4-carbon").label, /best quality/i);
  assert.match(G.MODELS.find((m) => m.id === "gemini-4-carbon").note, /30 Nov 2026.*\$4 \/ \$20/);
  assert.match(G.MODELS.find((m) => m.id === "gemini-2.5-pro").note, /deprecated.*404/i);
  const seen = [];
  const fetch = async (url, init) => { seen.push([url, init.method, init.headers["x-goog-api-key"]]); return Response.json(url.includes("countTokens") ? { totalTokens: 4242 } : { models: [] }); };
  assert.deepEqual(await G.testKey({ fetch, key: "k" }), { ok: true });
  assert.equal(await G.countTokens({ fetch, key: "k", model: "gemini-2.5-pro", system: "s", contents: [{ role: "user", parts: [{ text: "x" }] }] }), 4242);
  assert.deepEqual(seen.map((s) => s[1]), ["GET", "POST"]);
  assert.equal(seen[0][0], "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1");
  await assert.rejects(G.testKey({ fetch: async () => errRes(400, "API key not valid. Please pass a valid API key."), key: "bad" }), (e) => e.kind === "auth");
});

test("File API upload: start, send bytes, wait until ACTIVE; a missing upload URL header gives the clear browser message", async () => {
  const blob = new Blob(["%PDF-1.4 fake"]);
  const steps = [];
  let polls = 0;
  const fetch = async (url, init) => {
    steps.push(init.method + " " + url.replace("https://generativelanguage.googleapis.com", ""));
    if (url.endsWith("/upload/v1beta/files")) return new Response("{}", { headers: { "x-goog-upload-url": "https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=1" } });
    if (url.includes("upload_id")) return Response.json({ file: { name: "files/abc", uri: "https://g/files/abc", state: "PROCESSING" } });
    return Response.json(++polls < 2 ? { name: "files/abc", state: "PROCESSING" } : { name: "files/abc", uri: "https://g/files/abc", state: "ACTIVE", expirationTime: "2030-01-01T00:00:00Z" });
  };
  const f = await G.uploadFile({ fetch, key: "k", blob, name: "b.pdf", sleep: noSleep });
  assert.equal(f.uri, "https://g/files/abc");
  assert.equal(f.expiresAt, Date.parse("2030-01-01T00:00:00Z"));
  assert.equal(steps.length, 4);
  await assert.rejects(G.uploadFile({ fetch: async () => new Response("{}"), key: "k", blob }), (e) => e.kind === "upload" && /Compress it/.test(e.message) && /paste a summary/.test(e.message));
  await assert.rejects(G.uploadFile({ fetch: async () => { throw new TypeError("CORS"); }, key: "k", blob }), (e) => e.kind === "upload");
});

test("PDF helpers: page count, limits, base64", async () => {
  const fake = Buffer.from("%PDF-1.4\n1 0 obj<< /Type /Pages /Count 2 >>endobj\n2 0 obj<< /Type /Page >>endobj\n3 0 obj<</Type/Page/Parent 1 0 R>>endobj");
  assert.equal(G.countPdfPages(fake), 2);
  assert.equal(G.countPdfPages(Buffer.from("nothing")), null);
  assert.match(G.pdfProblem(51 * 1024 * 1024, 10), /50 MB/);
  assert.match(G.pdfProblem(1000, 1001), /1,000 pages/);
  assert.equal(G.pdfProblem(1000, null), "");
  assert.equal(await G.blobToBase64(new Blob(["ABC"])), "QUJD");
});
