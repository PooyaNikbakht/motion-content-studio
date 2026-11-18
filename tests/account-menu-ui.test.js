const test = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM, boot } = require("./ui-harness.js");

const skip = !JSDOM && "jsdom not available (set JSDOM_PATH)";
const key = (h, el, k) => el.dispatchEvent(new h.w.KeyboardEvent("keydown", { key: k, bubbles: true }));

test("app header: Guide, Director Prompt and an account menu holding Change password and Sign out", { skip }, async () => {
  const h = await boot({ mode: "app", projects: [{ id: "p0", name: "A" }] });
  const { $, $$, click } = h;
  assert.ok($("#guide-open") && $("#dp-open") && $("#acct-btn"));
  assert.equal($("#help-open"), null, "no keyboard shortcuts button");
  assert.equal($(".bar > a[href='/logout']"), null, "Sign out is not in the bar");
  assert.equal($("#acct-btn").getAttribute("aria-haspopup"), "menu");
  assert.equal($("#acct-btn").getAttribute("aria-expanded"), "false");
  assert.equal($("#acct-menu").hidden, true);
  click($("#acct-btn"));
  assert.equal($("#acct-menu").hidden, false);
  assert.equal($("#acct-btn").getAttribute("aria-expanded"), "true");
  const items = $$("#acct-menu [role=menuitem]");
  assert.deepEqual(items.map((a) => a.textContent), ["Change password", "Sign out"]);
  assert.deepEqual(items.map((a) => a.getAttribute("href")), ["/login?mode=change", "/logout"]);
  assert.equal(h.w.document.activeElement, items[0]);
  key(h, items[0], "ArrowDown");
  assert.equal(h.w.document.activeElement, items[1]);
  key(h, items[1], "Escape");
  assert.equal($("#acct-menu").hidden, true);
  assert.equal($("#acct-btn").getAttribute("aria-expanded"), "false");
  assert.equal(h.w.document.activeElement, $("#acct-btn"));
  click($("#acct-btn"));
  h.w.document.body.dispatchEvent(new h.w.Event("pointerdown", { bubbles: true }));
  assert.equal($("#acct-menu").hidden, true, "an outside press closes it");
  assert.deepEqual(h.errors, []);
});

test("demo header has no account menu", { skip }, async () => {
  const h = await boot({ mode: "demo", projects: [{ id: "p0", name: "A" }] });
  assert.equal(h.$("#acct-btn"), null);
  assert.ok(h.$(".demo-tag"));
});
