const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const P = require("../public/static/parser.js");
const { JSDOM, boot } = require("./ui-harness.js");

const skip = !JSDOM && "jsdom not available (set JSDOM_PATH)";
const sample = fs.readFileSync(path.join(__dirname, "../samples/sample-conversation.txt"), "utf8");
const parsed = () => P.parse(sample, { startPhrase: P.DEFAULT_START_PHRASE });

test("Visual Boards have no Copy next button", { skip }, async () => {
  const h = await boot({ mode: "demo", projects: [{ id: "p0", name: "A", parsed: parsed() }] });
  const { $, click, wait } = h;
  click($("#tab-youtube")); await wait(60);
  click($("#subtab-youtube-board")); await wait(60);
  assert.ok($("#scene-1"), "the board is open");
  assert.equal($("#next-img"), null);
  assert.ok(!/Copy next/i.test($("#panel").textContent));
  assert.ok($("#copy-all-img"), "Copy all image prompts stays");
  assert.ok($("#board-csv"), "Download CSV stays");
  assert.ok($("#nextbar") && !$("#nextbar").hidden, "the Next banner stays");
  click($("#tab-reels")); await wait(60);
  click($("#rsubtab-visual")); await wait(60);
  assert.equal($("#next-reel-img"), null);
  assert.ok(!/Copy next/i.test($("#panel").textContent));
  assert.ok($("#copy-all-reel-img"));
  assert.deepEqual(h.errors, []);
});

test("no Prompt pack button or dialog anywhere; an old ext.pack is ignored and prompts copy raw", { skip }, async () => {
  const pr = parsed();
  const pack = { images: { prefix: "PREFIX", suffix: "SUFFIX" } };
  const h = await boot({ mode: "demo", projects: [{ id: "p0", name: "A", parsed: pr, ext: { pack } }], settings: { pack } });
  const { $, $$, click, wait, w } = h;
  const copied = [];
  Object.defineProperty(w.navigator, "clipboard", { value: { writeText: async (t) => { copied.push(t); } }, configurable: true });
  const views = [["#tab-youtube", "#subtab-youtube-board"], ["#tab-youtube", "#subtab-youtube-covers"], ["#tab-reels", "#rsubtab-visual"], ["#tab-reels", "#rsubtab-cover"]];
  for (const [t, s] of views) {
    click($(t)); await wait(40); click($(s)); await wait(60);
    assert.ok(!/Prompt pack/i.test($("#panel").textContent), s);
    assert.equal($("[data-pack]"), null, s);
    assert.equal($(".packbadge"), null, s);
  }
  assert.equal($("#pk-images-p"), null);
  click($("#tab-youtube")); await wait(40); click($("#subtab-youtube-board")); await wait(60);
  click($("#scene-1 [data-copy]")); await wait(30);
  assert.equal(copied[0], pr.scenes[0].imagePrompt, "copied raw, no prefix or suffix");
  click($("#copy-all-img")); await wait(30);
  assert.ok(!/PREFIX|SUFFIX/.test(copied[1]) && copied[1].startsWith("1. "));
  assert.deepEqual(h.errors, []);
});

test("prompt cards: no wide Copy footer buttons; an icon-only copy button sits in each prompt label and flips to a check", { skip }, async () => {
  const pr = parsed();
  const h = await boot({ mode: "demo", projects: [{ id: "p0", name: "A", parsed: pr }] });
  const { $, $$, click, wait, w } = h;
  const copied = [];
  Object.defineProperty(w.navigator, "clipboard", { value: { writeText: async (t) => { copied.push(t); } }, configurable: true });
  const views = [["#tab-youtube", "#subtab-youtube-board"], ["#tab-youtube", "#subtab-youtube-covers"], ["#tab-reels", "#rsubtab-visual"], ["#tab-reels", "#rsubtab-cover"]];
  for (const [t, s] of views) {
    click($(t)); await wait(40); click($(s)); await wait(60);
    assert.equal($$(".icard .icard-foot .copybtn").filter((b) => /prompt/i.test(b.textContent)).length, 0, s);
    const btns = $$(".icard .promptlabel .copyico");
    assert.ok(btns.length, s);
    btns.forEach((b) => assert.match(b.getAttribute("aria-label"), /^Copy .*prompt/i));
    assert.ok(btns.every((b) => b.getAttribute("title") === b.getAttribute("aria-label") && !b.textContent.trim()));
  }
  click($("#tab-youtube")); await wait(40); click($("#subtab-youtube-board")); await wait(60);
  const flow = $$(".icard").find((c) => c.querySelector('[aria-label="Copy video prompt"]'));
  assert.ok(flow, "a Flow scene has Copy image prompt and Copy video prompt");
  assert.ok(flow.querySelector('[aria-label="Copy image prompt"]'));
  const b = flow.querySelector('[aria-label="Copy video prompt"]');
  click(b); await wait(30);
  assert.equal(copied.length, 1);
  assert.equal(b.dataset.state, "copied");
  await wait(1700);
  assert.equal(b.dataset.state, undefined);
  assert.deepEqual(h.errors, []);
});
