// /app saves on the Save button: dirty tracking, Save success, failure and Retry, the 409 conflict flow, the leave warning,
// the Save / Discard / Cancel prompt, immediate saves (Parse, director replies, rename), Setup Save, Ctrl/Cmd+S, and /demo making no /api calls.
const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../public/static/parser.js");
const { JSDOM, boot } = require("./ui-harness.js");

const skip = !JSDOM && "jsdom not available (set JSDOM_PATH)";
const parsedSample = (sample) => P.parse(sample, { startPhrase: P.DEFAULT_START_PHRASE });
const vaultFetch = (text) => async () => ({ ok: true, status: 200, json: async () => ({ text, defaultText: text, updatedAt: 1 }), text: async () => "" });
const fail = (status, message, extra) => Object.assign(new Error(message), { status }, extra);

/** An app boot whose adapter records saves. ctl.putProject can be replaced per test; versions bump like the server's. */
async function app(extra) {
  const ctl = { puts: [], patches: [], settings: [], next: null };
  const sampleText = require("node:fs").readFileSync(require("node:path").join(__dirname, "../samples/sample-conversation.txt"), "utf8");
  const h = await boot(Object.assign({
    mode: "app",
    fetch: vaultFetch("MASTER"),
    projects: [{ id: "p0", name: "A", text: sampleText, parsed: parsedSample(sampleText), version: 1 }, { id: "p1", name: "B", version: 1 }],
    patchStore(store, projs) {
      store.putProject = async (p, o) => {
        ctl.puts.push({ id: p.id, opts: o || {}, text: p.text, base: p.version });
        if (ctl.next) { const f = ctl.next; ctl.next = null; await f(p); }
        p.version = (p.version || 0) + 1;
        projs.set(p.id, JSON.parse(JSON.stringify(p)));
      };
      store.patchProject = async (id, f) => { ctl.patches.push([id, f]); const p = projs.get(id); Object.assign(p, f); p.version = (p.version || 0) + 1; return { version: p.version }; };
      const save = store.saveSettings;
      store.saveSettings = (s) => { ctl.settings.push(Object.assign({}, s)); save(s); };
      store.getProject = async (id) => (projs.has(id) ? JSON.parse(JSON.stringify(projs.get(id))) : undefined);
      ctl.projs = projs;
    },
  }, extra));
  return Object.assign(h, { ctl, sampleText });
}
const state = (h) => ({ disabled: h.$("#save-btn").disabled, label: h.$("#save-btn").textContent.trim(), note: h.$("#save-note").textContent.trim() });
const tickChip = async (h) => {
  h.click(h.$("#tab-youtube")); await h.wait(40);
  h.click(h.$("#subtab-youtube-board")); await h.wait(60);
  const box = h.$("input[data-kind]");
  box.checked = !box.checked;
  box.dispatchEvent(new h.w.Event("change", { bubbles: true }));
  await h.wait(30);
};
const beforeUnload = (h) => { const e = new h.w.Event("beforeunload", { cancelable: true }); h.w.dispatchEvent(e); return e.defaultPrevented; };

test("clean project: Save is disabled, there is no dot, and leaving the page is not blocked", { skip }, async () => {
  const h = await app();
  assert.deepEqual(state(h), { disabled: true, label: "Save", note: "All changes saved" });
  assert.equal(beforeUnload(h), false);
  assert.equal(h.$("#save-state"), null, "the old sync indicator is gone");
  assert.equal(h.$$("#save-btn").length, 1, "one Save button only");
  assert.equal(h.$("#projhead #save-btn"), null, "it is not in the project header");
  assert.equal(h.$("#savebar").hidden, false);
  assert.equal(h.$("#save-ctx").hidden, true);
  assert.deepEqual(h.errors, []);
});

const EDITS = {
  "a chip": tickChip,
  "an Overview field": async (h) => { h.click(h.$("#tab-overview")); await h.wait(60); h.input(h.$("#ov-notes"), "a note"); await h.wait(30); },
  "director settings": async (h) => { h.click(h.$("#tab-import")); await h.wait(80); h.click(h.$("#mode-ai")); await h.wait(40); h.input(h.$("#ad-title"), "My Book"); await h.wait(30); },
  "the project language": async (h) => { h.click(h.$("#tab-import")); await h.wait(60); h.click(h.$("#mode-paste")); await h.wait(60); await h.pick("lang", "Persian"); },
  "text typed in the paste box": async (h) => { h.click(h.$("#tab-import")); await h.wait(60); h.click(h.$("#mode-paste")); await h.wait(60); h.input(h.$("#paste"), "new pasted text"); await h.wait(30); },
};
for (const [what, edit] of Object.entries(EDITS)) {
  test("dirty tracking: " + what + " lights Unsaved changes and enables Save, and nothing is sent yet", { skip }, async () => {
    const h = await app();
    await edit(h);
    assert.deepEqual(state(h), { disabled: false, label: "Save", note: "Unsaved changes" });
    assert.equal(h.$("#save-note").dataset.state, "dirty");
    assert.equal(h.ctl.puts.length, 0, "an edit does not reach the server");
    assert.equal(beforeUnload(h), true, "the browser is asked before leaving");
  });
}

test("Save success: one PUT, the button reads Saved and disables, the dot goes, leaving is allowed", { skip }, async () => {
  const h = await app();
  await tickChip(h);
  h.click(h.$("#save-btn")); await h.wait(60);
  assert.equal(h.ctl.puts.length, 1);
  assert.deepEqual(state(h), { disabled: true, label: "Saved", note: "All changes saved" });
  assert.equal(beforeUnload(h), false);
  await tickChip(h);
  assert.equal(state(h).note, "Unsaved changes", "a new edit after Saved is dirty again");
});

test("Save failure shows a clear error with Retry; Retry saves and the edit was never lost", { skip }, async () => {
  const h = await app();
  await tickChip(h);
  h.ctl.next = async () => { throw fail(500, "Storage error."); };
  h.click(h.$("#save-btn")); await h.wait(60);
  assert.equal(h.$("#save-note").dataset.state, "error");
  assert.match(h.$("#save-note").textContent, /Not saved\. Storage error\./);
  assert.equal(h.$("#save-note").getAttribute("role"), "alert");
  assert.deepEqual([state(h).disabled, state(h).label], [false, "Retry"]);
  assert.equal(beforeUnload(h), true, "still unsaved");
  h.click(h.$("#save-btn")); await h.wait(60);
  assert.equal(h.ctl.puts.length, 2);
  assert.deepEqual(state(h), { disabled: true, label: "Saved", note: "All changes saved" });
});

test("signed out while saving points to sign in", { skip }, async () => {
  const h = await app();
  await tickChip(h);
  h.ctl.next = async () => { throw fail(401, "You are signed out. Sign in again to save."); };
  h.click(h.$("#save-btn")); await h.wait(60);
  assert.match(h.$("#save-note").textContent, /signed out/);
  assert.equal(h.$("#save-note a").getAttribute("href"), "/login");
});

test("while a save is in flight the button says Saving... and leaving is blocked", { skip }, async () => {
  const h = await app();
  await tickChip(h);
  let release;
  h.ctl.next = () => new Promise((r) => { release = r; });
  h.click(h.$("#save-btn")); await h.wait(30);
  assert.deepEqual([state(h).disabled, state(h).label], [true, "Saving..."]);
  assert.equal(beforeUnload(h), true);
  release(); await h.wait(40);
  assert.equal(state(h).label, "Saved");
  assert.equal(beforeUnload(h), false);
});

test("409: the conflict message offers Reload and Overwrite; Overwrite saves with overwrite, Reload takes the server copy", { skip }, async () => {
  const h = await app();
  await tickChip(h);
  h.ctl.next = async () => { throw fail(409, "This project changed elsewhere.", { version: 7 }); };
  h.click(h.$("#save-btn")); await h.wait(60);
  const c = h.$("#conflict");
  assert.equal(c.hidden, false);
  assert.match(h.$("#save-note").textContent, /This project changed elsewhere\. Reload to get the latest, or overwrite/);
  assert.deepEqual(h.$$("#conflict button").map((b) => b.textContent.trim()), ["Reload latest", "Overwrite"]);
  assert.equal(h.$("#save-btn").disabled, true, "Save waits for the choice");
  assert.equal(beforeUnload(h), true);
  h.click(h.$("#conflict-overwrite")); await h.wait(60);
  assert.equal(h.ctl.puts.at(-1).opts.overwrite, true);
  assert.equal(h.$("#conflict").hidden, true);
  assert.equal(state(h).label, "Saved");

  // Reload: another conflict, then the server copy replaces the local edit.
  await tickChip(h);
  h.ctl.next = async () => { throw fail(409, "This project changed elsewhere.", { version: 9 }); };
  h.click(h.$("#save-btn")); await h.wait(60);
  assert.equal(h.$("#conflict").hidden, false);
  h.ctl.projs.get("p0").name = "Renamed elsewhere";
  h.click(h.$("#conflict-reload")); await h.wait(80);
  assert.equal(h.$("#conflict").hidden, true);
  assert.equal(h.$("#ph-name span").textContent, "Renamed elsewhere");
  assert.deepEqual(state(h), { disabled: true, label: "Save", note: "All changes saved" });
  assert.equal(beforeUnload(h), false);
  assert.deepEqual(h.errors, []);
});

test("project navigation with unsaved changes asks Save / Discard / Cancel", { skip }, async () => {
  const h = await app();
  await tickChip(h);
  const row = () => h.$('[data-key="p:p1"]');
  h.click(row()); await h.wait(40);
  assert.match(h.$("#dlg-title").textContent, /Unsaved changes/);
  assert.deepEqual(h.$$("#dlg .dlg-actions button, #dlg .dlg-foot button").map((b) => b.textContent.trim()), ["Save", "Cancel", "Discard changes"]);
  h.click(h.$('#dlg [data-x="cancel"]')); await h.wait(40);
  assert.equal(h.$("#ph-name span").textContent, "A", "Cancel stays");
  assert.equal(state(h).note, "Unsaved changes");

  h.click(row()); await h.wait(40);
  h.click(h.$('#dlg [data-foot="0"]')); await h.wait(80);
  assert.equal(h.$("#ph-name span").textContent, "B", "Discard moves on");
  assert.equal(h.ctl.puts.length, 0, "and saves nothing");

  h.click(h.$('[data-key="p:p0"]')); await h.wait(80);
  assert.equal(state(h).note, "All changes saved", "the discarded edit is gone: p0 is loaded from the server again");
  await tickChip(h);
  h.click(row()); await h.wait(40);
  h.click(h.$('#dlg [data-x="ok"]')); await h.wait(100);
  assert.equal(h.ctl.puts.length, 1, "Save sends it first");
  assert.equal(h.ctl.puts[0].id, "p0");
  assert.equal(h.$("#ph-name span").textContent, "B");
});

test("opening a project always loads it from the server", { skip }, async () => {
  const h = await app();
  let gets = 0;
  const get = h.store.getProject;
  h.store.getProject = async (id) => { gets++; return get(id); };
  h.click(h.$('[data-key="p:p1"]')); await h.wait(60);
  h.click(h.$('[data-key="p:p0"]')); await h.wait(60);
  h.click(h.$('[data-key="p:p1"]')); await h.wait(60);
  assert.equal(gets, 3, "every open is a server read, none is answered from memory");
});

test("Parse persists at once (after the replace confirm) and leaves nothing unsaved", { skip }, async () => {
  const h = await app({ projects: [{ id: "p0", name: "A", version: 1 }] });
  h.click(h.$("#tab-import")); await h.wait(60);
  h.click(h.$("#mode-paste")); await h.wait(60);
  h.input(h.$("#phrase"), P.DEFAULT_START_PHRASE);
  h.input(h.$("#paste"), h.sample);
  assert.equal(state(h).note, "Unsaved changes");
  h.click(h.$("#parse-btn")); await h.wait(100);
  assert.equal(h.ctl.puts.length, 1);
  assert.ok(h.ctl.puts[0].text.length > 100);
  assert.equal(state(h).label, "Saved");
});

test("Save with unparsed pasted text runs Parse first", { skip }, async () => {
  const h = await app({ projects: [{ id: "p0", name: "A", version: 1 }] });
  h.click(h.$("#tab-import")); await h.wait(60);
  h.click(h.$("#mode-paste")); await h.wait(60);
  h.input(h.$("#phrase"), P.DEFAULT_START_PHRASE);
  h.input(h.$("#paste"), h.sample);
  h.click(h.$("#save-btn")); await h.wait(120);
  assert.equal(h.ctl.puts.length >= 1, true);
  assert.equal(h.ctl.puts[0].text, h.sample);
  assert.equal(state(h).label, "Saved");
});

test("renaming goes through the metadata route and does not save or clear the open project's other edits", { skip }, async () => {
  const h = await app();
  await tickChip(h);
  h.click(h.$("#ph-name")); await h.wait(20);
  const input = h.$(".ph-input");
  input.value = "Brand new name";
  input.dispatchEvent(new h.w.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await h.wait(60);
  assert.equal(JSON.stringify(h.ctl.patches), JSON.stringify([["p0", { name: "Brand new name" }]]));
  assert.equal(h.ctl.puts.length, 0);
  assert.equal(state(h).note, "Unsaved changes", "the chip edit is still unsaved");
  h.click(h.$("#save-btn")); await h.wait(60);
  assert.equal(h.ctl.puts.length, 1);
  assert.equal(h.ctl.puts[0].base, 2, "the save used the version the rename returned");
});

test("a director reply is saved to the server as it arrives", { skip }, async () => {
  const h = await app({ projects: [{ id: "p0", name: "A", version: 1 }], settings: { geminiKey: "AIzaX", startPhrase: P.DEFAULT_START_PHRASE } });
  const reply = h.sample.slice(0, 6000);
  h.w.MBSGemini.streamTurn = async (o) => { o.onText && o.onText(reply, reply); return { text: reply, usage: { prompt: 100, output: 100 }, finishReason: "STOP" }; };
  h.w.MBSGemini.countTokens = async () => 100;
  h.click(h.$("#tab-import")); await h.wait(80);
  h.input(h.$("#ad-title"), "My Book");
  assert.equal(state(h).note, "Unsaved changes", "the setting alone is unsaved");
  h.click(h.$("#ad-start")); await h.wait(400);
  const saved = h.ctl.puts.filter((p) => p.text && p.text.length > 100);
  assert.ok(saved.length >= 1, "the project with the reply was sent without pressing Save");
  assert.ok(saved[0].text.includes("Audio chunk 1"), "the reply is in the saved project");
  assert.equal(state(h).note, "All changes saved", "and nothing is left unsaved");
  assert.deepEqual(h.errors, []);
});

test("Setup has its own Save: edits stay unsaved until it is pressed; Master Prompt edits count too", { skip }, async () => {
  const h = await app();
  h.click(h.$("#tab-setup")); await h.wait(100);
  const note = () => h.$("#save-note").textContent.trim();
  assert.equal(h.$("#save-btn").disabled, true);
  assert.equal(h.$("#save-ctx").hidden, false, "the bar is labelled Setup");
  h.input(h.$("#s-voice"), "voice123");
  assert.equal(note(), "Unsaved changes");
  assert.equal(h.$("#save-btn").disabled, false);
  assert.equal(h.ctl.settings.length, 0, "not written yet");
  assert.equal(beforeUnload(h), true);
  h.click(h.$("#save-btn")); await h.wait(50);
  assert.equal(h.ctl.settings.at(-1).voiceId, "voice123");
  assert.equal(h.$("#save-btn").textContent.trim(), "Saved");
  assert.equal(beforeUnload(h), false);
  h.click(h.$("#sv-edit")); await h.wait(30);
  h.input(h.$("#sv-text"), "MASTER changed");
  assert.equal(note(), "Unsaved changes");
  assert.equal(beforeUnload(h), true);
});

test("Ctrl/Cmd+S saves the project and Setup, and the browser's own save is blocked", { skip }, async () => {
  const h = await app();
  await tickChip(h);
  const key = (extra) => { const e = new h.w.KeyboardEvent("keydown", Object.assign({ key: "s", bubbles: true, cancelable: true }, extra)); h.w.document.dispatchEvent(e); return e; };
  assert.equal(key({}).defaultPrevented, false, "a bare s does nothing");
  const e = key({ ctrlKey: true });
  assert.equal(e.defaultPrevented, true);
  await h.wait(60);
  assert.equal(h.ctl.puts.length, 1);
  await tickChip(h);
  key({ metaKey: true }); await h.wait(60);
  assert.equal(h.ctl.puts.length, 2);
});

test("old shortcuts are gone: no keyboard button, plain keys do nothing", { skip }, async () => {
  const h = await app();
  assert.equal(h.$("#help-open"), null);
  const before = h.$("#tab-youtube").getAttribute("aria-selected");
  h.w.document.body.dispatchEvent(new h.w.KeyboardEvent("keydown", { key: "]", bubbles: true }));
  assert.equal(h.$("#tab-youtube").getAttribute("aria-selected"), before);
});

test("demo: no /api call at all, no Save button, edits are written locally as before", { skip }, async () => {
  const h = await boot({
    mode: "demo",
    projects: [{ id: "p0", name: "A", version: undefined }],
    patchStore(store, projs) { projs.get("p0").text = require("node:fs").readFileSync(require("node:path").join(__dirname, "../samples/sample-conversation.txt"), "utf8"); projs.get("p0").parsed = parsedSample(projs.get("p0").text); },
  });
  assert.equal(h.$("#save-btn"), null);
  assert.equal(h.$("#savebar"), null);
  assert.equal(h.$("#acct-btn"), null);
  await tickChip(h);
  h.click(h.$("#tab-overview")); await h.wait(60);
  h.input(h.$("#ov-notes"), "demo note"); await h.wait(60);
  h.click(h.$("#tab-setup")); await h.wait(80);
  assert.equal(h.$("#save-btn"), null);
  assert.equal(beforeUnload(h), false, "nothing to warn about: the demo saves as you go");
  assert.equal(h.projs.get("p0").info.notes, "demo note", "the edit was written at once");
  const api = h.calls.filter((c) => /^\/api\//.test(String(c[0])) || /\/api\//.test(String(c[0])));
  assert.deepEqual(api, []);
  assert.deepEqual(h.errors, []);
});
