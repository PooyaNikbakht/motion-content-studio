// Quick previews use the Preview model (Flash by default) and its rates; full generation keeps the main model (v4 by default).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const P = require("../public/static/parser.js");
const { JSDOM, boot } = require("./ui-harness.js");

const skip = !JSDOM && "jsdom not available (set JSDOM_PATH)";
const sampleText = fs.readFileSync(path.join(__dirname, "../samples/sample-conversation.txt"), "utf8");
const parsed = P.parse(sampleText, { startPhrase: P.DEFAULT_START_PHRASE });

// An app boot with a key and voice; every ElevenLabs request is recorded and answered with a tiny mp3.
async function app(settings) {
  const tts = [];
  const h = await boot({
    mode: "app",
    settings: Object.assign({ apiKey: "sk_x", voiceId: "voice1" }, settings),
    projects: [{ id: "p0", name: "A", text: sampleText, parsed, version: 1 }],
    fetch: async (u, init) => {
      if (String(u).includes("api.elevenlabs.io/v1/text-to-speech")) { tts.push(JSON.parse(init.body)); return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer, json: async () => ({}) }; }
      return { ok: true, status: 200, json: async () => ({ text: "M", defaultText: "M", updatedAt: 1 }), text: async () => sample() };
    },
  });
  const sample = () => h.sample;
  h.w.URL.createObjectURL = () => "blob:x"; h.w.URL.revokeObjectURL = () => {};
  h.tts = tts;
  h.click(h.$("#tab-youtube")); await h.wait(60);
  h.click(h.$("#subtab-youtube-audio")); await h.wait(80);
  return h;
}

test("fresh settings: eleven_v4 is the default model and the preview model is Flash", { skip }, async () => {
  const h = await boot({ mode: "app" });
  assert.equal(h.settings.model, "eleven_v4");
  assert.equal(h.settings.previewModel, "eleven_flash_v2_5");
  h.click(h.$("#tab-setup")); await h.wait(100);
  assert.match(h.$("#s-model .dd-val").textContent, /^eleven_v4/);
  assert.match(h.$("#s-preview-model .dd-val").textContent, /^eleven_flash_v2_5/);
});

test("preview sends the preview model and Flash rates whatever the default model or run override is; the default stays untouched", { skip }, async () => {
  const h = await app({ model: "eleven_v3", stability: 1 });
  assert.match(h.$("[data-preview]").textContent, /Preview first 10 s \(Flash, half the credits\)/);
  assert.match(h.$("[data-est-a]").textContent, /^First 10 s \(Flash\): ~\d+ chars, ~[\d.,]+ credits/);
  const chars = Number(h.$("[data-est-a]").textContent.match(/~([\d,]+) chars/)[1].replace(/,/g, ""));
  const credits = Number(h.$("[data-est-a]").textContent.match(/~([\d.,]+) credits/)[1].replace(/,/g, ""));
  assert.equal(credits, chars * 0.5);
  h.click(h.$("[data-preview]")); await h.wait(80);
  assert.equal(h.tts.length, 1);
  assert.equal(h.tts[0].model_id, "eleven_flash_v2_5");
  assert.equal(h.tts[0].voice_settings.stability, 1);
  assert.equal(h.settings.model, "eleven_v3", "the default model is untouched");
  assert.equal(h.settings.previewModel, "eleven_flash_v2_5");
});

test("the preview caret changes the preview model for previews only; the estimate and stability follow it", { skip }, async () => {
  const h = await app({ stability: 0.37 });
  h.click(h.$("[data-preview-more]")); await h.wait(40);
  await h.pick("pm-model", "eleven_v3");
  h.click(h.$('#dlg [data-x="ok"]')); await h.wait(80);
  assert.match(h.$("[data-preview]").textContent, /Preview first 10 s \(eleven_v3\)/);
  assert.match(h.$("[data-est-a]").textContent, /^First 10 s \(eleven_v3\)/);
  const chars = Number(h.$("[data-est-a]").textContent.match(/~([\d,]+) chars/)[1].replace(/,/g, ""));
  assert.equal(Number(h.$("[data-est-a]").textContent.match(/~([\d.,]+) credits/)[1].replace(/,/g, "")), chars);
  h.click(h.$("[data-preview]")); await h.wait(80);
  assert.equal(h.tts[0].model_id, "eleven_v3");
  assert.ok([0, 0.5, 1].includes(h.tts[0].voice_settings.stability), "stability valid for v3");
  assert.equal(h.settings.model, "eleven_v4");
  assert.equal(h.settings.previewModel, "eleven_flash_v2_5");
  assert.match(h.$("[data-est-b]").textContent, /^Full chunk:/);
});

test("Setup preview model is saved; full generation uses the main model (v4 by default)", { skip }, async () => {
  const h = await app();
  h.click(h.$("#tab-setup")); await h.wait(100);
  await h.pick("s-preview-model", "eleven_multilingual_v2");
  assert.equal(h.settings.previewModel, "eleven_multilingual_v2");
  assert.equal(h.settings.model, "eleven_v4");
  h.click(h.$("#tab-youtube")); await h.wait(60);
  h.click(h.$("#subtab-youtube-audio")); await h.wait(80);
  assert.match(h.$("[data-preview]").textContent, /\(eleven_multilingual_v2\)/);
  h.click(h.$("[data-regen]")); await h.wait(150);
  assert.ok(h.tts.length >= 1);
  assert.equal(h.tts[0].model_id, "eleven_v4");
});
