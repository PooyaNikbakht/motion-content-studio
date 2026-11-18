/* Input format guide: template, hand-off into the app or demo, and the live checker. Client-side only.
 * init(root, opts) wires the guide markup inside root (the /format page, or the in-app dialog):
 * opts = { mode: "app" | "demo", inApp: bool, onUse(template) }. */
(function () {
  "use strict";
  const P = window.MBSParser, T = window.MBSTemplate;
  const phrase = P.DEFAULT_START_PHRASE;
  const template = T.buildTemplate(phrase);

  function init(root, opts) {
  const $ = (s) => root.querySelector(s);
  const mode = opts.mode;

  $("#dflt-phrase").textContent = phrase;
  $("#tpl-text").textContent = template;
  $("#chk-phrase").value = phrase;

  const flip = $("#tpl-switch");
  const label = () => {
    $("#tpl-use").textContent = mode === "app" ? "Use this template in my project" : "Use this template in the demo";
    flip.textContent = mode === "app" ? "Use the demo instead" : "Use the app instead (sign-in needed)";
    flip.href = "/format?from=" + (mode === "app" ? "demo" : "app");
  };
  label();

  const flash = (btn, text) => { const o = btn.textContent; btn.textContent = text; setTimeout(() => (btn.textContent = o), 1600); };
  $("#tpl-copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(template); flash($("#tpl-copy"), "Copied"); } catch { flash($("#tpl-copy"), "Select the text and copy it by hand"); }
  });
  $("#tpl-use").addEventListener("click", () => opts.onUse(template));
  if (opts.inApp) flip.hidden = true;

  const out = $("#chk-out"), ta = $("#chk-text"), ph = $("#chk-phrase");
  const add = (parent, tag, text, cls) => { const e = document.createElement(tag); e.textContent = text; if (cls) e.className = cls; parent.appendChild(e); return e; };
  function check() {
    out.textContent = "";
    if (!ta.value.trim()) return;
    const r = P.parse(ta.value, { startPhrase: ph.value.trim() === "" ? phrase : ph.value.trim() });
    const s = r.stats;
    const stats = add(out, "div", "", "stats");
    [[s.audioChunks, "Audio chunks"], [s.imageScenes, "Image scenes"], [s.animations, "Animations"], [s.reels, "Reels (9:16)"], [s.reelAudio, "Reel audio"]].forEach((x) => {
      const d = add(stats, "div", "", "stat"); add(d, "b", String(x[0])); add(d, "span", x[1], "small muted");
    });
    const found = [["Thumbnail prompt", !!r.thumbnail], ["Cover headline", !!r.coverHeadline], ["YouTube title", !!r.youtubeTitle], ["Video caption", !!r.caption]];
    r.reels.forEach((x) => {
      found.push([x.name + ": " + x.images.length + " images, " + x.videos.length + " animations", true]);
      found.push([x.name + " cover prompt", !!x.cover]);
    });
    const ul = add(out, "ul", "", "fmt-found");
    found.forEach((f) => add(ul, "li", (f[1] ? "Found: " : "Not found: ") + f[0], f[1] ? "ok" : "miss"));
    if (r.warnings.length) {
      const w = add(out, "div", "", "warn"); add(w, "strong", "Check the text:");
      const l = add(w, "ul"); r.warnings.forEach((x) => add(l, "li", x));
    } else if (s.audioChunks) add(out, "p", "No warnings.", "small muted");
  }
  let timer;
  const later = () => { clearTimeout(timer); timer = setTimeout(check, 300); };
  ta.addEventListener("input", later);
  ph.addEventListener("input", later);
  $("#tpl-sample").addEventListener("click", async () => {
    try {
      const r = await fetch("/demo/sample-conversation.txt");
      if (!r.ok) throw new Error();
      ta.value = await r.text();
      check();
      ta.scrollIntoView({ block: "center", behavior: "smooth" });
    } catch { flash($("#tpl-sample"), "Could not load the sample"); }
  });
  }

  window.MBSFormat = { init };
  // Standalone /format page: the app and demo read this key on load and put the text in the paste box (asking before replacing existing text).
  if (document.getElementById("tpl-text")) {
    const mode = new URLSearchParams(location.search).get("from") === "app" ? "app" : "demo";
    init(document, {
      mode,
      onUse(text) {
        try { localStorage.setItem("mbs_" + mode + ":pending_text", text); } catch { /* storage blocked */ }
        location.href = "/" + mode;
      },
    });
  }
})();
