const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const G = require("../public/static/guide.js");
const { JSDOM, boot } = require("./ui-harness.js");

const skip = !JSDOM && "jsdom not available (set JSDOM_PATH)";
const empty = [{ id: "p0", name: "Empty" }];
const IDS = ["setup", "import", "audio", "board", "cover", "reels", "assemble"];

test("guide data: seven steps, each with the three parts, labelled suggestions, no em dash or Arabic script", () => {
  assert.deepEqual(G.GUIDE.steps.map((s) => s.id), IDS);
  G.GUIDE.steps.forEach((s) => { assert.ok(s.app && s.you && s.rec.length, s.id); });
  const all = JSON.stringify(G.GUIDE);
  assert.ok(!/—/.test(all) && !/[؀-ۿ]/.test(all));
  const html = G.html({ demo: false });
  assert.equal((html.match(/What the app does here/g) || []).length, 7);
  assert.equal((html.match(/What you do in other tools/g) || []).length, 7);
  assert.equal((html.match(/Recommended for this step/g) || []).length, 7);
  assert.ok(/Where to start/.test(html) && /Suggestions, not rules/.test(html));
  assert.ok(!/In the demo:/.test(html) && /In the demo:/.test(G.html({ demo: true })));
  const src = fs.readFileSync(path.join(__dirname, "../public/static/guide.js"), "utf8");
  assert.ok(!/[؀-ۿ]/.test(src));
});

test("guide suggestions: model advice, chunk size, warm-up (truthful: no trim setting), banners, Ken Burns", () => {
  const rec = (id) => G.find(id).rec.join("\n");
  assert.match(rec("setup"), /Eleven v4: recommended for Persian narration and expressive storytelling/);
  assert.match(rec("setup"), /Eleven v3 is the previous-generation alternative/);
  assert.match(rec("setup"), /Eleven Flash v2\.5: best for English production/);
  assert.match(rec("setup"), /Multilingual v2: alternative for longer, ultra-stable narration blocks/);
  assert.match(rec("setup"), /800 to 900 character chunks \(under 1,000 characters\)/);
  assert.match(rec("audio"), /3-sentence warm-up/);
  assert.ok(!/auto-?trim|built-in trim/i.test(JSON.stringify(G.GUIDE)), "the app has no trim setting, so the guide must not promise one");
  assert.match(rec("board"), /2 to 4 word English title banners/);
  assert.match(rec("assemble"), /Ken Burns/);
  assert.match(rec("assemble"), /0\.5x speed \(Optical Flow\)/);
});

for (const mode of ["demo", "app"]) {
  test("Guide dialog opens and closes (" + mode + "), lists all sections, and the ? link and How it works card open it at a step", { skip }, async () => {
    const h = await boot({ mode, projects: empty, fetch: async () => ({ ok: true, status: 200, json: async () => ({ text: "M", defaultText: "M", updatedAt: 1 }), text: async () => "" }) });
    const { $, $$, click, wait } = h;
    assert.equal($("#topbar #fmt-link"), null, "format guide is not in the header");
    assert.ok($("#guide-open") && /Guide/.test($("#guide-open").textContent));
    assert.equal($("#guide-dlg").open, false);
    click($("#guide-open")); await wait(30);
    assert.equal($("#guide-dlg").open, true);
    assert.equal($("#guide-title").textContent, "How to use Motion Content Studio");
    assert.ok($("#guide-import #guide-format[data-fmt]"), "Import step links to the format guide");
    assert.deepEqual($$("#guide-body .guide-sec").map((s) => s.id), IDS.map((i) => "guide-" + i));
    assert.ok(/Where to start/.test($("#guide-body").textContent));
    assert.equal(/In the demo:/.test($("#guide-body").textContent), mode === "demo");
    $("#guide-dlg").dispatchEvent(new h.w.Event("cancel", { cancelable: true })); await wait(20);
    assert.equal($("#guide-dlg").open, false, "Esc (cancel) closes it");
    click($("#tab-import")); await wait(80);
    assert.ok($("#how-body") && $("#tab-import"));
    const q = $(".pagehead .guide-help");
    assert.equal(q.getAttribute("data-guide"), "import");
    click(q); await wait(30);
    assert.equal(h.w.document.activeElement.id, "guide-import", "focus moves to the matching section");
    click($("#guide-close")); await wait(20);
    assert.equal($("#guide-dlg").open, false);
    click($('.how-head [data-guide]')); await wait(20);
    assert.equal($("#guide-dlg").open, true);
    if (mode === "demo") assert.ok(!h.calls.some((c) => /\/api\//.test(String(c[0]))), "no /api call in the demo");
    assert.deepEqual(h.errors, []);
  });
}
