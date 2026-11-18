/*
 * Director Prompt vault: the user's own Master Director Prompt, kept out of every public file.
 *   /app   stored on the server only (GET and PUT /api/settings/director-prompt); nothing is kept on this device
 *   /demo  no server calls; a short fictional template, edits stay in localStorage under the demo prefix
 * State: { text, defaultText, updatedAt }. UMD: window.MBSVault in the browser, require() in Node.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MBSVault = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const MAX_BYTES = 100 * 1024;
  const ENDPOINT = "/api/settings/director-prompt";

  /** Generic and fictional. The real prompt is loaded by its owner through the vault and is never part of the repository. */
  const DEMO_TEMPLATE = [
    "DEMO TEMPLATE (fictional). Replace this with your own director prompt.",
    "",
    "You are a director who turns one book into a complete video package.",
    "Work in six stages. After each stage, stop and wait for the word Continue.",
    "",
    "Stage 1. Script chunks",
    "Write the narration in numbered chunks. Start every chunk with the same warm-up phrase.",
    "Keep each chunk under 4,500 characters.",
    "",
    "Stage 2. 16:9 image scenes",
    "For each scene write: Scene N, the narration for that scene, then Image Prompt: followed by one paragraph.",
    "",
    "Stage 3. Flow animation prompts",
    "For scenes that should move, add Video Prompt: followed by a short camera and motion description.",
    "",
    "Stage 4. Thumbnail",
    "Write Cover Prompt: for the 16:9 cover, then the cover headline, the YouTube title and a caption.",
    "",
    "Stage 5. Reels (9:16)",
    "Write Reel 01, Reel 02 and Reel 03. Each has an audio script, labelled images (R01-01, R01-02),",
    "a vertical animation prompt and a Reel Cover Prompt:, then a cover headline and a caption.",
    "",
    "Stage 6. Wrap up",
    "List every item you produced and ask whether anything should change.",
  ].join("\n");

  const bytes = (s) => (typeof TextEncoder !== "undefined" ? new TextEncoder().encode(s).length : String(s).length);
  const empty = () => ({ text: "", defaultText: "", updatedAt: 0 });
  const clean = (v) => ({ text: typeof v.text === "string" ? v.text : "", defaultText: typeof v.defaultText === "string" ? v.defaultText : "", updatedAt: Number(v.updatedAt) || 0 });

  /** opts: { demo, prefix, fetch, storage }. */
  function create(opts) {
    const demo = !!opts.demo, key = opts.prefix + ":director";
    const storage = opts.storage || (typeof localStorage !== "undefined" ? localStorage : null);
    const f = opts.fetch || (typeof fetch !== "undefined" ? fetch.bind(globalThis) : null);
    const readCache = () => { try { const c = JSON.parse(storage.getItem(key) || "null"); return c && typeof c === "object" ? c : null; } catch { return null; } }; // demo only
    const writeCache = (v) => { try { storage.setItem(key, JSON.stringify(v)); } catch { /* storage full or blocked */ } };

    async function request(method, body) {
      const init = { method, credentials: "same-origin", headers: {} };
      if (body) { init.headers["Content-Type"] = "application/json"; init.headers["X-MBS"] = "1"; init.body = JSON.stringify(body); }
      return f(ENDPOINT, init);
    }

    return {
      MAX_BYTES,
      /** Returns { state }. In /app it throws when the server cannot be read, so the UI can offer Retry instead of showing an empty prompt. */
      async load() {
        if (demo) {
          const c = readCache();
          return { state: c ? clean(c) : { text: DEMO_TEMPLATE, defaultText: DEMO_TEMPLATE, updatedAt: 0 } };
        }
        let res;
        try { res = await request("GET"); } catch { throw new Error("The server could not be reached."); }
        if (!res.ok) throw new Error(res.status === 401 ? "You are signed out. Sign in again." : "The server answered " + res.status + ".");
        return { state: clean(await res.json()) };
      },
      /** Saves { text, defaultText }. Throws when the server did not take it (nothing is kept locally). */
      async save(next) {
        const state = clean(next);
        if (bytes(state.text) > MAX_BYTES || bytes(state.defaultText) > MAX_BYTES) throw new Error("The prompt is over 100 KB.");
        state.updatedAt = Date.now();
        if (demo) { writeCache(state); return state; }
        let res;
        try { res = await request("PUT", { text: state.text, defaultText: state.defaultText }); } catch { throw new Error("Not saved. The server could not be reached."); }
        if (!res.ok) throw new Error(res.status === 401 ? "Signed out. Sign in again to save." : "The server did not accept the prompt (" + res.status + ").");
        const data = await res.json().catch(() => ({}));
        state.updatedAt = data.updatedAt || state.updatedAt;
        return state;
      },
    };
  }

  return { DEMO_TEMPLATE, MAX_BYTES, create };
});
