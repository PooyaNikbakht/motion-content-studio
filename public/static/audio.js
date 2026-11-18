/*
 * Audio generation (real ElevenLabs call or a simulated tone), folder saving and ZIP export.
 * ElevenLabs details checked against https://elevenlabs.io/docs (Text to Speech, "Create speech").
 */
(function () {
  "use strict";

  const MODELS = {
    eleven_v4: { label: "Eleven v4 (recommended for Persian and expressive storytelling)", maxChars: 10000, stabilitySteps: null },
    eleven_v3: { label: "Eleven v3 (most expressive)", maxChars: 5000, stabilitySteps: [0, 0.5, 1] },
    eleven_multilingual_v2: { label: "Multilingual v2", maxChars: 10000, stabilitySteps: null },
    eleven_flash_v2_5: { label: "Flash v2.5 (fast, half the credits)", maxChars: 40000, stabilitySteps: null },
  };
  /** Quick previews always use this model (half the credits, 40,000 characters, any stability from 0 to 1). */
  const PREVIEW_MODEL = "eleven_flash_v2_5";
  const V3_PRESETS = { 0: "Creative", 0.5: "Natural", 1: "Robust" };

  /** eleven_v3 only takes 0.0, 0.5 or 1.0. Other models take any value from 0 to 1. */
  function snapStability(model, value) {
    const v = Math.min(1, Math.max(0, Number(value)));
    const steps = (MODELS[model] || MODELS.eleven_v4).stabilitySteps;
    if (!steps) return Math.round(v * 20) / 20;
    return steps.reduce((best, s) => (Math.abs(s - v) < Math.abs(best - v) ? s : best), steps[0]);
  }

  function fileName(n, total, ext) {
    return String(n).padStart(Math.max(2, String(total).length), "0") + "_audio." + ext;
  }

  const REELS_DIR = "Reels";

  /** Reel_01_audio.mp3, Reel_02_audio.mp3, ... (always two digits at least). */
  function reelFileName(id, ext) {
    return "Reel_" + String(id).padStart(2, "0") + "_audio." + ext;
  }

  class TtsError extends Error {
    constructor(message, opts) {
      super(message);
      this.name = "TtsError";
      this.status = (opts && opts.status) || 0;
      this.retryable = !!(opts && opts.retryable);
      this.fatal = !!(opts && opts.fatal); // stop the whole queue (bad key, no credits)
    }
  }

  function detailMessage(body) {
    if (!body) return "";
    const d = body.detail;
    if (typeof d === "string") return d;
    if (d && typeof d === "object" && !Array.isArray(d)) return d.message || d.status || "";
    if (Array.isArray(d)) return d.map((x) => x.msg || x.message).filter(Boolean).join("; ");
    return body.message || "";
  }

  async function elevenLabs({ apiKey, voiceId, model, stability, text, signal }) {
    const spec = MODELS[model];
    if (!spec) throw new TtsError("Unknown model: " + model);
    if ([...text].length > spec.maxChars) {
      throw new TtsError("This chunk has " + [...text].length + " characters. " + spec.label + " accepts at most " + spec.maxChars + " per request.");
    }
    let res;
    try {
      res = await fetch("https://api.elevenlabs.io/v1/text-to-speech/" + encodeURIComponent(voiceId) + "?output_format=mp3_44100_128", {
        method: "POST",
        headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
        body: JSON.stringify({ text, model_id: model, voice_settings: { stability: snapStability(model, stability) } }),
        signal,
      });
    } catch (e) {
      if (e && e.name === "AbortError") throw e;
      throw new TtsError("Network error. Check your connection and try again.", { retryable: true });
    }
    if (res.ok) return new Blob([await res.arrayBuffer()], { type: "audio/mpeg" });

    let detail = "";
    try { detail = detailMessage(await res.json()); } catch { /* not JSON */ }
    const s = res.status;
    if (s === 401) throw new TtsError("ElevenLabs rejected the API key (401). Check the key in the settings.", { status: s, fatal: true });
    if (s === 402) throw new TtsError("Payment required (402). Your plan or credits do not cover this request." + (detail ? " " + detail : ""), { status: s, fatal: true });
    if (s === 404) throw new TtsError("Voice not found (404). Check the Voice ID in the settings.", { status: s, fatal: true });
    if (s === 429) throw new TtsError("Too many requests (429). ElevenLabs is rate limiting this key." + (detail ? " " + detail : ""), { status: s, retryable: true });
    if (s === 400 || s === 422) throw new TtsError("ElevenLabs rejected the request (" + s + "): " + (detail || "invalid settings or text."), { status: s });
    if (s >= 500) throw new TtsError("ElevenLabs had a server problem (" + s + ").", { status: s, retryable: true });
    throw new TtsError("Unexpected response (" + s + ")." + (detail ? " " + detail : ""), { status: s });
  }

  /**
   * The account's credit usage for the current period (GET /v1/user/subscription).
   * Returns { used, limit, resetUnix, tier }. Throws TtsError when the key cannot read it (restricted keys, offline).
   */
  async function subscription(apiKey, signal) {
    let res;
    try {
      res = await fetch("https://api.elevenlabs.io/v1/user/subscription", { headers: { "xi-api-key": apiKey, Accept: "application/json" }, signal });
    } catch (e) {
      if (e && e.name === "AbortError") throw e;
      throw new TtsError("Network error while reading the plan.", { retryable: true });
    }
    if (!res.ok) throw new TtsError("Could not read the plan (" + res.status + ").", { status: res.status });
    const b = await res.json();
    if (!Number.isFinite(b.character_count) || !Number.isFinite(b.character_limit)) throw new TtsError("The plan response had no credit counts.");
    return { used: b.character_count, limit: b.character_limit, resetUnix: b.next_character_count_reset_unix || 0, tier: b.tier || "" };
  }

  /** Short placeholder WAV: a three-note tone whose pitch depends on the chunk number. No network. */
  function simulatedWav(n, text) {
    const rate = 16000;
    const seconds = Math.min(3.2, 1.2 + [...text].length / 300);
    const total = Math.floor(rate * seconds);
    const data = new Int16Array(total);
    const base = 196 * Math.pow(1.122, n % 8);
    const notes = [base, base * 1.25, base * 1.5];
    for (let i = 0; i < total; i++) {
      const t = i / rate;
      const f = notes[Math.min(2, Math.floor((t / seconds) * 3))];
      const env = Math.min(1, t * 20, (seconds - t) * 10);
      data[i] = Math.round(Math.sin(2 * Math.PI * f * t) * 0.25 * env * 32767);
    }
    const buf = new ArrayBuffer(44 + data.length * 2);
    const v = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, "RIFF"); v.setUint32(4, 36 + data.length * 2, true); str(8, "WAVE"); str(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, "data"); v.setUint32(40, data.length * 2, true);
    new Int16Array(buf, 44).set(data);
    return new Blob([buf], { type: "audio/wav" });
  }

  async function simulate({ n, text, signal }) {
    await new Promise((resolve, reject) => {
      const t = setTimeout(resolve, 500 + Math.random() * 400);
      if (signal) signal.addEventListener("abort", () => { clearTimeout(t); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
    });
    return simulatedWav(n, text);
  }

  // Folder saving (File System Access API)
  const canPickFolder = typeof window.showDirectoryPicker === "function";

  async function ensureWritable(handle, ask) {
    const opts = { mode: "readwrite" };
    if ((await handle.queryPermission(opts)) === "granted") return true;
    return ask ? (await handle.requestPermission(opts)) === "granted" : false;
  }

  async function writeFile(dirHandle, name, blob) {
    const fh = await dirHandle.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(blob);
    await w.close();
  }

  /** Writes into a subfolder of the chosen folder, creating it when missing. */
  async function writeFileIn(dirHandle, subdir, name, blob) {
    const sub = await dirHandle.getDirectoryHandle(subdir, { create: true });
    await writeFile(sub, name, blob);
  }

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  async function buildZip(files, textFiles) {
    if (typeof JSZip === "undefined") throw new Error("The ZIP library did not load. Check your connection and reload.");
    const zip = new JSZip();
    files.forEach((f) => zip.file(f.name, f.blob));
    Object.keys(textFiles).forEach((k) => zip.file(k, textFiles[k]));
    return zip.generateAsync({ type: "blob" });
  }

  window.MBSAudio = { MODELS, PREVIEW_MODEL, V3_PRESETS, snapStability, fileName, reelFileName, REELS_DIR, TtsError, elevenLabs, subscription, simulate, simulatedWav, canPickFolder, ensureWritable, writeFile, writeFileIn, download, buildZip };
})();
