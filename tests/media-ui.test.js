// jsdom checks for the per-card media slots (empty, uploading, filled), the upload pipeline, the lightbox, bulk drop results,
// unused media and the demo's no-server rule. XMLHttpRequest, canvas and image decoding are stubbed: no network, no browser.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const P = require("../public/static/parser.js");
const { JSDOM, boot } = require("./ui-harness.js");

const skip = !JSDOM && "jsdom not available (set JSDOM_PATH)";
const sample = fs.readFileSync(path.join(__dirname, "../samples/sample-conversation.txt"), "utf8");
const parsed = () => P.parse(sample, { startPhrase: P.DEFAULT_START_PHRASE });
const FLOW = () => parsed().scenes.find((s) => s.hasVideo).number;
const PLAIN = () => parsed().scenes.find((s) => !s.hasVideo).number;

/** Stubs the browser pieces jsdom lacks. Returns { xhrs, auto, calls } to drive and inspect uploads. */
function stub(h, { reply } = {}) {
  const w = h.w, ctl = { xhrs: [], auto: true, reply: reply || {} };
  class FakeXHR {
    constructor() { this.upload = {}; this.headers = {}; ctl.xhrs.push(this); }
    open(m, u) { this.method = m; this.url = u; }
    setRequestHeader(k, v) { this.headers[k] = v; }
    send(b) { this.body = b; if (ctl.auto) setTimeout(() => this.finish(200), 5); }
    finish(status, json) {
      this.status = status;
      this.responseText = JSON.stringify(json || (/\/media\//.test(this.url) ? Object.assign({ bytes: this.body.size, projectBytes: this.body.size, usedBytes: 5000, allowanceBytes: 10 * 1024 ** 3, nearAllowance: false }, ctl.reply) : { bytes: 1 }));
      this.onload();
    }
    abort() { this.aborted = true; if (this.onabort) this.onabort(); }
  }
  w.XMLHttpRequest = FakeXHR;
  let n = 0;
  w.URL.createObjectURL = () => "blob:t" + ++n;
  w.URL.revokeObjectURL = () => {};
  Object.defineProperty(w.HTMLImageElement.prototype, "src", { configurable: true, set(v) { this._src = v; this.setAttribute("src", v); Object.defineProperty(this, "naturalWidth", { value: 640, configurable: true }); Object.defineProperty(this, "naturalHeight", { value: 360, configurable: true }); setTimeout(() => this.onload && this.onload(), 0); }, get() { return this._src || ""; } });
  // a video decodes to its first frame: loadeddata, then seeked after currentTime is set
  Object.defineProperty(w.HTMLVideoElement.prototype, "src", { configurable: true, set(v) { this.setAttribute("src", v); Object.defineProperty(this, "videoWidth", { value: 1280, configurable: true }); Object.defineProperty(this, "videoHeight", { value: 720, configurable: true }); setTimeout(() => this.onloadeddata && this.onloadeddata(), 0); }, get() { return this.getAttribute("src") || ""; } });
  Object.defineProperty(w.HTMLVideoElement.prototype, "currentTime", { configurable: true, set() { setTimeout(() => this.onseeked && this.onseeked(), 0); }, get() { return 0; } });
  w.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {} });
  w.HTMLCanvasElement.prototype.toBlob = function (cb, type) { cb(new w.Blob(["thumbnail-bytes"], { type })); };
  return ctl;
}

const file = (w, name, type, size = 100) => new w.File([new Uint8Array(size)], name, { type });
const choose = (h, input, f) => { Object.defineProperty(input, "files", { value: [f], configurable: true }); input.dispatchEvent(new h.w.Event("change", { bubbles: true })); };
const drop = (h, el, files) => { const e = new h.w.Event("drop", { bubbles: true, cancelable: true }); Object.defineProperty(e, "dataTransfer", { value: { files, types: ["Files"] } }); el.dispatchEvent(e); };
const appOf = (extra = {}) => ({ mode: "app", projects: [Object.assign({ id: "p0", name: "A", parsed: parsed() }, extra)], fetch: async (u) => ({ ok: true, status: 200, json: async () => ({ text: "M", defaultText: "M", updatedAt: 1, usedBytes: 0, allowanceBytes: 10 * 1024 ** 3, media: [] }), text: async () => "" }) });
const openBoard = async (h) => { h.click(h.$("#tab-youtube")); await h.wait(40); h.click(h.$("#subtab-youtube-board")); await h.wait(60); };
const chipOf = (h, n, kind) => h.$('input[data-n="' + n + '"][data-kind="' + kind + '"]');
const confirm = async (h) => { h.click(h.$('#dlg [data-x="ok"]')); await h.wait(60); };

test("slots: an image slot on every scene, a Video slot only on Flow scenes, empty state names the types and the 100 MB cap", { skip }, async () => {
  const h = await boot(appOf());
  stub(h);
  await openBoard(h);
  const plain = h.$("#scene-" + PLAIN()), flow = h.$("#scene-" + FLOW());
  assert.deepEqual([...plain.querySelectorAll(".mslot")].map((s) => s.dataset.slot), ["s-" + PLAIN() + "-image"]);
  assert.deepEqual([...flow.querySelectorAll(".mslot")].map((s) => s.dataset.slot), ["s-" + FLOW() + "-image", "s-" + FLOW() + "-video"]);
  const empty = flow.querySelector('.mslot[data-slot$="-video"]');
  assert.equal(empty.dataset.state, "empty");
  assert.match(empty.textContent, /Upload video/);
  assert.match(empty.textContent, /MP4 or WebM, up to 100 MB/);
  assert.match(plain.querySelector(".mslot").textContent, /Upload image/);
  assert.match(plain.querySelector(".mslot").textContent, /PNG, JPG or WebP, up to 100 MB/);
  assert.equal(plain.querySelector("[data-slot-input]").accept.includes("image/png"), true);
  assert.ok(!/Demo: files stay/.test(plain.textContent), "the demo label is not shown in the app");
  assert.equal(h.$$("#panel select").length, 0);
  // the slot sits between the prompts and the footer of the card
  const kids = [...plain.children].map((c) => c.className.split(" ")[0]);
  assert.ok(kids.indexOf("mslots") > kids.indexOf("icard-prompts") && kids.indexOf("mslots") < kids.indexOf("icard-foot"), kids.join());
  assert.deepEqual(h.errors, []);
});

test("slots: covers and reel items have the right slot kinds", { skip }, async () => {
  const h = await boot(appOf());
  stub(h);
  const pr = parsed();
  h.click(h.$("#tab-youtube")); await h.wait(40);
  h.click(h.$("#subtab-youtube-covers")); await h.wait(60);
  const yt = h.$$("#panel .mslot");
  assert.deepEqual(yt.map((s) => [s.dataset.slot, s.querySelector(".mslot-label span").textContent]), [["yt-cover", "Cover image"]]);
  h.click(h.$("#tab-reels")); await h.wait(60);
  h.click(h.$("#rsubtab-visual")); await h.wait(60);
  const r1 = pr.reels[0];
  assert.deepEqual(h.$$("#panel .mslot").map((s) => s.dataset.slot), r1.images.map((_, i) => "r-1-image-" + (i + 1)).concat(r1.videos.map((_, i) => "r-1-video-" + (i + 1))));
  h.click(h.$("#rsubtab-cover")); await h.wait(60);
  assert.deepEqual(h.$$("#panel .mslot").map((s) => s.dataset.slot), ["r-1-cover"]);
  assert.equal(h.$(".mslot .mslot-label span").textContent, "Cover image");
});

test("upload: progress with Cancel, original goes to its own R2 key, a 320 px thumbnail follows, the Generated chip ticks, metadata is saved", { skip }, async () => {
  const h = await boot(appOf());
  const ctl = stub(h); ctl.auto = false;
  await openBoard(h);
  const n = PLAIN(), slot = () => h.$('.mslot[data-slot="s-' + n + '-image"]');
  assert.equal(chipOf(h, n, "image").checked, false);
  choose(h, slot().querySelector("[data-slot-input]"), file(h.w, "03 shot.png", "image/png", 2000));
  await h.wait(40);
  assert.equal(slot().dataset.state, "uploading");
  const x = ctl.xhrs[0];
  assert.equal(x.method, "PUT");
  assert.match(x.url, new RegExp("^/api/projects/p0/media/s-" + n + "-image-[a-z0-9]{5}$"));
  assert.equal(x.headers["Content-Type"], "image/png");
  assert.equal(x.headers["X-Name"], encodeURIComponent("03 shot.png"));
  assert.equal(x.headers["X-MBS"], "1");
  assert.equal(x.body.size, 2000, "the ORIGINAL file is sent, not a copy");
  x.upload.onprogress({ lengthComputable: true, loaded: 500, total: 2000 });
  assert.equal(slot().querySelector('[role="progressbar"]').getAttribute("aria-valuenow"), "25");
  assert.match(slot().querySelector("[data-pct]").textContent, /25% of/);
  assert.ok(slot().querySelector('[data-sa="cancel"]'));
  assert.equal(chipOf(h, n, "image").checked, false, "not ticked before the upload finishes");
  x.finish(200);
  await h.wait(60);
  const t = ctl.xhrs[1];
  assert.match(t.url, new RegExp("^/api/projects/p0/thumb/s-" + n + "-image-[a-z0-9]{5}$"));
  assert.equal(t.headers["Content-Type"], "image/webp");
  t.finish(200);
  await h.wait(80);
  assert.equal(slot().dataset.state, "filled");
  assert.match(slot().textContent, /03 shot\.png/);
  assert.match(slot().textContent, /Saved to your account/);
  assert.deepEqual([...slot().querySelectorAll("[data-sa]")].map((b) => b.dataset.sa), ["open", "replace", "download", "remove"]);
  assert.ok(slot().querySelector("img"), "a thumbnail is shown");
  assert.equal(chipOf(h, n, "image").checked, true, "the chip ticked itself");
  assert.equal(h.$("#scene-" + n).dataset.status !== "todo", true);
  const saved = h.projs.get("p0");
  const e = saved.ext.media["s-" + n + "-image"];
  assert.equal(e.name, "03 shot.png"); assert.equal(e.bytes, 2000); assert.equal(e.type, "image/png"); assert.equal(e.stored, true); assert.equal(e.thumb, true);
  assert.ok(e.uploadedAt > 0);
  assert.equal(e.r2, "media/p0/" + e.sk);
  assert.match(e.sk, /^s-\d+-image-[a-z0-9]{5}$/);
  assert.equal(saved.progress[n].image, true);
  assert.deepEqual(h.errors, []);
});

test("upload: Cancel aborts the request and leaves the slot empty and unticked", { skip }, async () => {
  const h = await boot(appOf());
  const ctl = stub(h); ctl.auto = false;
  await openBoard(h);
  const n = PLAIN(), slot = () => h.$('.mslot[data-slot="s-' + n + '-image"]');
  choose(h, slot().querySelector("[data-slot-input]"), file(h.w, "a.png", "image/png", 400));
  await h.wait(40);
  h.click(slot().querySelector('[data-sa="cancel"]'));
  await h.wait(40);
  assert.equal(ctl.xhrs[0].aborted, true);
  assert.equal(slot().dataset.state, "empty");
  assert.equal(chipOf(h, n, "image").checked, false);
  assert.equal(h.projs.get("p0").ext.media, undefined);
});

test("upload: a server error is shown and nothing is ticked or stored", { skip }, async () => {
  const h = await boot(appOf());
  const ctl = stub(h); ctl.auto = false;
  await openBoard(h);
  const n = PLAIN(), slot = () => h.$('.mslot[data-slot="s-' + n + '-image"]');
  choose(h, slot().querySelector("[data-slot-input]"), file(h.w, "a.png", "image/png", 400));
  await h.wait(40);
  ctl.xhrs[0].finish(413, { error: "That file is over 100 MB." });
  await h.wait(60);
  assert.equal(slot().dataset.state, "empty");
  assert.match(h.w.document.body.textContent, /Could not upload a\.png: That file is over 100 MB\./);
  assert.equal(chipOf(h, n, "image").checked, false);
});

test("upload: a wrong type or an empty or oversize file never reaches the server", { skip }, async () => {
  const h = await boot(appOf());
  const ctl = stub(h);
  await openBoard(h);
  const n = PLAIN(), input = () => h.$('.mslot[data-slot="s-' + n + '-image"] [data-slot-input]');
  choose(h, input(), file(h.w, "clip.mp4", "video/mp4", 50));
  await h.wait(30);
  assert.match(h.w.document.body.textContent, /clip\.mp4: Use a PNG, JPG or WebP image/);
  choose(h, input(), file(h.w, "e.png", "image/png", 0));
  await h.wait(30);
  const big = file(h.w, "big.png", "image/png", 10);
  Object.defineProperty(big, "size", { value: 100000001 });
  choose(h, input(), big);
  await h.wait(30);
  assert.match(h.w.document.body.textContent, /big\.png: The file is over 100 MB/);
  assert.equal(ctl.xhrs.length, 0);
});

test("drop: a file dropped on a slot uploads into that slot (first file only), and the slot highlights while dragging over", { skip }, async () => {
  const h = await boot(appOf());
  const ctl = stub(h);
  await openBoard(h);
  const n = FLOW(), vslot = () => h.$('.mslot[data-slot="s-' + n + '-video"]');
  const over = new h.w.Event("dragover", { bubbles: true, cancelable: true });
  Object.defineProperty(over, "dataTransfer", { value: { files: [], types: ["Files"] } });
  vslot().querySelector(".mslot-drop").dispatchEvent(over);
  assert.ok(vslot().classList.contains("over"));
  drop(h, vslot().querySelector(".mslot-drop"), [file(h.w, "anim.mp4", "video/mp4", 900), file(h.w, "second.mp4", "video/mp4", 10)]);
  await h.wait(120);
  assert.ok(!vslot().classList.contains("over"));
  assert.match(ctl.xhrs[0].url, new RegExp("/media/s-" + n + "-video-"));
  assert.equal(ctl.xhrs[0].headers["Content-Type"], "video/mp4");
  assert.equal(chipOf(h, n, "video").checked, true);
  assert.equal(vslot().dataset.state, "filled");
  const video = vslot().querySelector("video");
  assert.ok(video && video.controls, "an inline player");
  assert.match(video.getAttribute("src"), /^\/api\/projects\/p0\/media\/s-\d+-video-[a-z0-9]{5}$/);
  assert.equal(video.getAttribute("preload"), "none");
  assert.ok(video.getAttribute("poster"), "the poster is the thumbnail");
  assert.ok(vslot().querySelector('[data-sa="open"]'), "Enlarge");
});

test("remove: asks first, deletes the R2 file, empties the slot and unticks the chip", { skip }, async () => {
  const h = await boot(appOf());
  const ctl = stub(h);
  await openBoard(h);
  const n = PLAIN(), slot = () => h.$('.mslot[data-slot="s-' + n + '-image"]');
  choose(h, slot().querySelector("[data-slot-input]"), file(h.w, "a.png", "image/png", 300));
  await h.wait(150);
  assert.equal(chipOf(h, n, "image").checked, true);
  const sk = h.projs.get("p0").ext.media["s-" + n + "-image"].sk;
  const before = h.calls.length;
  h.click(slot().querySelector('[data-sa="remove"]'));
  await h.wait(30);
  assert.match(h.$("#dlg").textContent, /Remove a\.png\?/);
  assert.equal(h.calls.length, before, "nothing is deleted before the confirmation");
  await confirm(h);
  const del = h.calls.slice(before).find((c) => c[1] && c[1].method === "DELETE");
  assert.equal(del[0], "/api/projects/p0/media/" + sk);
  assert.equal(slot().dataset.state, "empty");
  assert.equal(chipOf(h, n, "image").checked, false, "the chip unticked itself");
  assert.deepEqual(h.projs.get("p0").ext.media, {});
  assert.equal(h.projs.get("p0").progress[n], undefined);
  void ctl;
});

test("remove: Cancel in the confirmation keeps the file", { skip }, async () => {
  const h = await boot(appOf());
  stub(h);
  await openBoard(h);
  const n = PLAIN(), slot = () => h.$('.mslot[data-slot="s-' + n + '-image"]');
  choose(h, slot().querySelector("[data-slot-input]"), file(h.w, "a.png", "image/png", 300));
  await h.wait(150);
  h.click(slot().querySelector('[data-sa="remove"]')); await h.wait(30);
  h.click(h.$('#dlg [data-x="cancel"]')); await h.wait(30);
  assert.equal(slot().dataset.state, "filled");
  assert.equal(chipOf(h, n, "image").checked, true);
});

test("lightbox: a thumbnail opens the full image from the server route, Esc and Close dismiss it; a video opens a player", { skip }, async () => {
  const h = await boot(appOf());
  stub(h);
  await openBoard(h);
  const n = FLOW();
  choose(h, h.$('.mslot[data-slot="s-' + n + '-image"] [data-slot-input]'), file(h.w, "big.png", "image/png", 900));
  await h.wait(150);
  const sk = h.projs.get("p0").ext.media["s-" + n + "-image"].sk;
  h.click(h.$('.mslot[data-slot="s-' + n + '-image"] .mslot-thumb')); await h.wait(30);
  const lb = h.$("#lightbox");
  assert.equal(lb.open, true);
  assert.equal(lb.querySelector("img").getAttribute("src"), "/api/projects/p0/media/" + sk, "full size from R2, not the thumbnail");
  assert.match(lb.textContent, /big\.png/);
  lb.dispatchEvent(new h.w.Event("cancel", { cancelable: true })); await h.wait(10);
  assert.equal(lb.open, false, "Esc closes");
  assert.equal(lb.querySelector("img"), null);
  h.click(h.$('.mslot[data-slot="s-' + n + '-image"] .mslot-thumb')); await h.wait(30);
  h.click(lb.querySelector("[data-lb-close]")); await h.wait(10);
  assert.equal(lb.open, false, "the Close button closes");
  choose(h, h.$('.mslot[data-slot="s-' + n + '-video"] [data-slot-input]'), file(h.w, "v.mp4", "video/mp4", 800));
  await h.wait(150);
  h.click(h.$('.mslot[data-slot="s-' + n + '-video"] [data-sa="open"]')); await h.wait(30);
  assert.ok(lb.open && lb.querySelector("video[controls]"), "a player in the lightbox");
  assert.match(lb.querySelector("video").getAttribute("src"), /\/media\/s-\d+-video-/);
});

test("download: points at the stream route with ?download=1 and the original file name", { skip }, async () => {
  const h = await boot(appOf());
  stub(h);
  await openBoard(h);
  const n = PLAIN();
  choose(h, h.$('.mslot[data-slot="s-' + n + '-image"] [data-slot-input]'), file(h.w, "Original Name.png", "image/png", 300));
  await h.wait(150);
  const sk = h.projs.get("p0").ext.media["s-" + n + "-image"].sk;
  const clicks = [];
  h.w.HTMLAnchorElement.prototype.click = function () { clicks.push([this.getAttribute("href"), this.download]); };
  h.click(h.$('.mslot[data-slot="s-' + n + '-image"] [data-sa="download"]')); await h.wait(20);
  assert.deepEqual(clicks, [["/api/projects/p0/media/" + sk + "?download=1", "Original Name.png"]]);
});

test("replace: the same R2 key is overwritten and the metadata updates", { skip }, async () => {
  const h = await boot(appOf());
  const ctl = stub(h);
  await openBoard(h);
  const n = PLAIN(), slot = () => h.$('.mslot[data-slot="s-' + n + '-image"]');
  choose(h, slot().querySelector("[data-slot-input]"), file(h.w, "one.png", "image/png", 300));
  await h.wait(150);
  const sk = h.projs.get("p0").ext.media["s-" + n + "-image"].sk;
  choose(h, slot().querySelector("[data-slot-input]"), file(h.w, "two.jpg", "image/jpeg", 700));
  await h.wait(150);
  const e = h.projs.get("p0").ext.media["s-" + n + "-image"];
  assert.equal(e.sk, sk);
  assert.equal(e.name, "two.jpg"); assert.equal(e.bytes, 700); assert.equal(e.type, "image/jpeg");
  assert.ok(ctl.xhrs.filter((x) => x.method === "PUT" && /\/media\//.test(x.url)).every((x) => x.url.endsWith("/media/" + sk)));
});

test("bulk drop zone: same pipeline, then a results list with matched files and unmatched ones with a reason", { skip }, async () => {
  const h = await boot(appOf());
  const ctl = stub(h);
  await openBoard(h);
  const n = PLAIN();
  const input = h.$("#drop-input");
  const files = [file(h.w, String(n).padStart(2, "0") + ".png", "image/png", 200), file(h.w, "holiday.png", "image/png", 50), file(h.w, "99.png", "image/png", 50), file(h.w, "notes.txt", "text/plain", 5)];
  Object.defineProperty(input, "files", { value: files, configurable: true });
  input.dispatchEvent(new h.w.Event("change", { bubbles: true }));
  await h.wait(250);
  const d = h.$("#dlg");
  assert.match(d.textContent, /Upload results/);
  assert.match(d.querySelector("#res-matched").textContent, /Added and ticked \(1\)/);
  assert.match(d.textContent, new RegExp("Scene " + String(n).padStart(2, "0") + " image"));
  assert.match(d.querySelector("#res-skipped").textContent, /Not added \(3\)/);
  assert.match(d.textContent, /holiday\.png: the name does not match/);
  assert.match(d.textContent, /99\.png: there is no Scene 99 image in this project/);
  assert.match(d.textContent, /notes\.txt: the name does not match/);
  assert.ok(ctl.xhrs.some((x) => new RegExp("/media/s-" + n + "-image-").test(x.url)), "went through the same upload");
  assert.equal(chipOf(h, n, "image").checked, true);
  assert.equal(h.$('.mslot[data-slot="s-' + n + '-image"]').dataset.state, "filled", "the card's slot shows it");
});

test("storage: near the 10 GB allowance warns in the sidebar footer and Overview; an upload reply that is near it warns once", { skip }, async () => {
  const fetch = async (u) => ({ ok: true, status: 200, json: async () => (String(u).includes("/api/storage") ? { mediaBytes: 8.6 * 1024 ** 3, thumbBytes: 1000, audioBytes: 5000, files: 3, usedBytes: 8.6 * 1024 ** 3, allowanceBytes: 10 * 1024 ** 3, softCapBytes: 2 * 1024 ** 3 } : { text: "M", media: [] }), text: async () => "" });
  const h = await boot(Object.assign(appOf(), { fetch }));
  stub(h, { reply: { nearAllowance: true, usedBytes: 8.6 * 1024 ** 3, allowanceBytes: 10 * 1024 ** 3 } });
  h.click(h.$("#tab-overview")); await h.wait(150);
  assert.match(h.$("#ov-storage-line").textContent, /8\.6 GB of the 10 GB free R2 allowance/);
  assert.match(h.$("#ov-storage-line").textContent, /Close to the allowance/);
  assert.ok(h.$("#sb-foot").classList.contains("warn-text"));
  assert.match(h.$("#sb-foot").textContent, /Storage 8\.6 GB of 10 GB/);
  await openBoard(h);
  choose(h, h.$('.mslot[data-slot="s-' + PLAIN() + '-image"] [data-slot-input]'), file(h.w, "a.png", "image/png", 100));
  await h.wait(200);
  assert.match(h.w.document.body.textContent, /above 80% of the 10 GB free allowance/);
});

test("Overview: unused media lists orphaned files with sizes; Remove unused media deletes them on the server after a confirmation", { skip }, async () => {
  const ext = { orphans: { "s-5-image-aaaaa": { name: "old5.png", bytes: 3 * 1048576, type: "image/png", from: "s-5-image", sk: "s-5-image-aaaaa" }, "r-2-video-1-bbbbb": { name: "r2.mp4", bytes: 20 * 1048576, type: "video/mp4", from: "r-2-video-1", sk: "r-2-video-1-bbbbb" } } };
  const h = await boot(appOf({ ext }));
  stub(h);
  h.click(h.$("#tab-overview")); await h.wait(150);
  const box = h.$("#ov-unused");
  assert.ok(box);
  assert.match(box.textContent, /Unused media: 2 files, 23 MB/);
  assert.match(box.textContent, /r2\.mp4/);
  assert.match(box.textContent, /was Reel 02 animation 1, 20 MB/);
  assert.match(box.textContent, /was Scene 05 image, 3 MB/);
  const before = h.calls.length;
  h.click(h.$("#unused-remove")); await h.wait(30);
  assert.equal(h.calls.length, before);
  await confirm(h);
  const post = h.calls.slice(before).find((c) => c[1] && c[1].method === "POST");
  assert.equal(post[0], "/api/projects/p0/media-cleanup");
  assert.deepEqual(JSON.parse(post[1].body).keys.sort(), ["r-2-video-1-bbbbb", "s-5-image-aaaaa"]);
  assert.equal(h.$("#ov-unused"), null);
  assert.equal(h.projs.get("p0").ext.orphans, undefined);
});

test("Overview: files on the server that no card references are listed as unused too", { skip }, async () => {
  const n = PLAIN();
  const media = { ["s-" + n + "-image"]: { name: "kept.png", bytes: 10, type: "image/png", sk: "s-" + n + "-image-kkkkk", stored: true } };
  const fetch = async (u) => ({ ok: true, status: 200, json: async () => (String(u).endsWith("/media") ? { media: [{ key: "s-" + n + "-image-kkkkk", name: "kept.png", bytes: 10, thumbBytes: 0 }, { key: "s-9-image-zzzzz", name: "stray.png", bytes: 500, thumbBytes: 20 }] } : { usedBytes: 0, allowanceBytes: 10 * 1024 ** 3 }), text: async () => "" });
  const h = await boot(Object.assign(appOf({ ext: { media } }), { fetch }));
  stub(h);
  h.click(h.$("#tab-overview")); await h.wait(200);
  assert.match(h.$("#ov-unused").textContent, /Unused media: 1 file/);
  assert.match(h.$("#ov-unused").textContent, /stray\.png/);
  assert.ok(!/kept\.png/.test(h.$("#ov-unused").textContent));
});

test("outdated: a file whose prompt was edited shows the Outdated label on its card", { skip }, async () => {
  const n = PLAIN();
  const media = { ["s-" + n + "-image"]: { name: "x.png", bytes: 10, type: "image/png", sk: "s-" + n + "-image-ooooo", stored: true, outdated: true } };
  const h = await boot(appOf({ ext: { media } }));
  stub(h);
  await openBoard(h);
  const slot = h.$('.mslot[data-slot="s-' + n + '-image"]');
  assert.match(slot.querySelector(".mslot-flag").textContent, /Outdated/);
  assert.match(slot.textContent, /the prompt was edited after this file was added/);
});

test("demo: slots work with no /api call, show the browser-only label, keep the thumbnail and the original", { skip }, async () => {
  const h = await boot({ mode: "demo", projects: [{ id: "p0", name: "A", parsed: parsed() }] });
  const ctl = stub(h);
  const kept = {};
  h.store.putAudio = async (pid, key, blob) => { kept[key] = blob; };
  h.store.getAudio = async (pid, key) => kept[key] || null;
  h.store.deleteAudio = async (pid, key) => { delete kept[key]; };
  await openBoard(h);
  const n = PLAIN(), slot = () => h.$('.mslot[data-slot="s-' + n + '-image"]');
  assert.match(slot().textContent, /Demo: files stay in your browser/);
  choose(h, slot().querySelector("[data-slot-input]"), file(h.w, "demo.png", "image/png", 4000));
  await h.wait(120);
  assert.equal(slot().dataset.state, "filled");
  assert.match(slot().textContent, /In this browser/);
  assert.equal(chipOf(h, n, "image").checked, true);
  const e = h.projs.get("p0").ext.media["s-" + n + "-image"];
  assert.equal(e.stored, false); assert.equal(e.local, true);
  assert.ok(kept["thumb:" + e.sk] && kept["orig:" + e.sk], "thumbnail and original are in IndexedDB");
  assert.equal(ctl.xhrs.length, 0, "no upload");
  assert.ok(!h.calls.some((c) => /\/api\//.test(String(c[0]))), "no /api call in the demo");
  h.click(slot().querySelector('[data-sa="remove"]')); await h.wait(30);
  await confirm(h);
  assert.deepEqual(Object.keys(kept), []);
  assert.equal(chipOf(h, n, "image").checked, false);
  assert.ok(!h.calls.some((c) => /\/api\//.test(String(c[0]))), "still no /api call");
});

test("demo: originals past the 25 MB total are not kept, only the thumbnail", { skip }, async () => {
  const h = await boot({ mode: "demo", projects: [{ id: "p0", name: "A", parsed: parsed() }] });
  stub(h);
  const kept = {};
  h.store.putAudio = async (pid, key, blob) => { kept[key] = blob; };
  h.store.getAudio = async (pid, key) => kept[key] || null;
  h.store.deleteAudio = async (pid, key) => { delete kept[key]; };
  await openBoard(h);
  const n = PLAIN();
  const big = file(h.w, "big.png", "image/png", 10);
  Object.defineProperty(big, "size", { value: 26 * 1024 * 1024 });
  choose(h, h.$('.mslot[data-slot="s-' + n + '-image"] [data-slot-input]'), big);
  await h.wait(120);
  const e = h.projs.get("p0").ext.media["s-" + n + "-image"];
  assert.equal(e.local, undefined);
  assert.ok(kept["thumb:" + e.sk] && !kept["orig:" + e.sk]);
  assert.match(h.$('.mslot[data-slot="s-' + n + '-image"]').textContent, /Thumbnail only \(demo size limit\)/);
});

// ---------- Download all assets ----------
const exportProject = () => {
  const pr = parsed(), n = PLAIN(), f = FLOW();
  const e = (name, type, bytes, sk) => ({ name, type, bytes, sk, stored: true });
  return { id: "p0", name: "My Book", parsed: pr, audio: {}, ext: { media: {
    ["s-" + n + "-image"]: e("a.png", "image/png", 1000, "s-" + n + "-image-aaaaa"),
    ["s-" + f + "-video"]: e("b.mp4", "video/mp4", 60 * 1048576, "s-" + f + "-video-bbbbb"),
    "r-1-image-1": e("r.webp", "image/webp", 500, "r-1-image-1-ccccc"),
    "yt-cover": e("c.png", "image/png", 800, "yt-cover-ddddd"),
  } } };
};
const exportFetch = (log) => async (u, o) => {
  log.push(String(u));
  if (!/\/media\//.test(String(u))) return { ok: true, status: 200, json: async () => ({ usedBytes: 0, allowanceBytes: 10 * 1024 ** 3, media: [] }), text: async () => "" };
  return { ok: true, status: 200, body: { pipeTo: async (w) => { await w.write(new Uint8Array([1, 2, 3])); await w.close(); } }, blob: async () => { log.push("BLOB " + u); return new Blob([new Uint8Array(3)]); } };
};

test("download all assets (folder): every file streams from R2 into Images/, Video/, Reels/Reel_01/ with edit-list.csv, nothing is buffered", { skip }, async () => {
  const log = [], written = {};
  const dirHandle = (path) => ({ name: "Out", async getDirectoryHandle(n) { return dirHandle(path + n + "/"); }, async getFileHandle(n) { return { async createWritable() { const chunks = []; return { async write(c) { chunks.push(c); }, async close() { written[path + n] = chunks; } }; } }; } });
  const h = await boot({ mode: "app", projects: [exportProject()], fetch: exportFetch(log), pre: (w) => { w.showDirectoryPicker = async () => dirHandle(""); } });
  stub(h);
  h.click(h.$("#tab-overview")); await h.wait(150);
  assert.match(h.$("#export-edit").textContent, /Download all assets/);
  h.click(h.$("#export-edit")); await h.wait(250);
  const n = String(PLAIN()).padStart(2, "0"), f = String(FLOW()).padStart(2, "0");
  assert.deepEqual(Object.keys(written).sort(), ["Images/Cover.png", "Images/Scene_" + n + ".png", "Reels/Reel_01/R01-01.webp", "Video/Scene_" + f + ".mp4", "edit-list.csv"].sort());
  assert.ok(log.some((u) => u.endsWith("/media/s-" + FLOW() + "-video-bbbbb")), "read by its R2 key");
  assert.ok(!log.some((u) => u.startsWith("BLOB")), "no file was read into memory as a Blob");
  assert.match(h.w.document.body.textContent, /Exported 4 files and edit-list\.csv to Out\./);
});

test("download all assets (ZIP fallback): videos over 50 MB are left out, listed in NOT-INCLUDED.txt, and the edit list has no path for them", { skip }, async () => {
  const log = [];
  const h = await boot({ mode: "app", projects: [exportProject()], fetch: exportFetch(log) });
  stub(h);
  let zipped = null;
  h.w.MBSAudio.buildZip = async (files, text) => { zipped = { files, text }; return new h.w.Blob(["zip"]); };
  h.w.MBSAudio.download = () => {};
  h.click(h.$("#tab-overview")); await h.wait(150);
  h.click(h.$("#export-edit")); await h.wait(60);
  assert.match(h.$("#dlg").textContent, /Build a ZIP instead\?/);
  assert.match(h.$("#dlg").textContent, /1 video file is left out/);
  assert.match(h.$("#dlg").textContent, /Video\/Scene_\d\d\.mp4 \(60 MB\)/);
  await confirm(h); await h.wait(250);
  assert.ok(zipped, "the ZIP was built");
  assert.ok(!zipped.files.some((x) => /^Video\//.test(x.name)));
  assert.equal(zipped.files.length, 3);
  assert.match(zipped.text["NOT-INCLUDED.txt"], /Video\/Scene_\d\d\.mp4 \(60 MB\)/);
  assert.ok(!/\.mp4/.test(zipped.text["edit-list.csv"]), "no path to a file that is not in the ZIP");
  assert.ok(!log.some((u) => /video-bbbbb/.test(u)), "the skipped video is never downloaded");
});

// ---------- a re-parse keeps media with its item ----------
test("re-parse in the UI: media follows an unchanged scene, an edited one is flagged Outdated, a removed one lands in Unused media, nothing is deleted", { skip }, async () => {
  const pr = parsed();
  const keep = pr.scenes[0].number, edit = pr.scenes[2].number, gone = pr.scenes[3].number;
  const mk = (name, sk) => ({ name, type: "image/png", bytes: 1048576, sk, stored: true });
  const ext = { media: { ["s-" + keep + "-image"]: mk("keep.png", "s-" + keep + "-image-kkkkk"), ["s-" + edit + "-image"]: mk("edit.png", "s-" + edit + "-image-eeeee"), ["s-" + gone + "-image"]: mk("gone.png", "s-" + gone + "-image-ggggg") } };
  const h = await boot(Object.assign(appOf({ ext, text: sample }), {}));
  const calls0 = h.calls.length;
  const text = sample.replace(pr.scenes[2].imagePrompt, "A completely different image prompt for this scene, rewritten.").replace(new RegExp("\\*\\*Scene Number:\\s*\\[?0?" + gone + "\\]?\\*\\*[\\s\\S]*?(?=\\*\\*Scene Number:|$)"), "");
  h.click(h.$("#tab-import")); await h.wait(60);
  h.click(h.$("#mode-paste")); await h.wait(60);
  h.$("#paste").value = text;
  h.click(h.$("#parse-btn")); await h.wait(150);
  if (h.$("#dlg").open) { assert.match(h.$("#dlg").textContent, /media file/); await confirm(h); await h.wait(150); }
  const after = h.projs.get("p0");
  assert.ok(after.ext.media["s-" + keep + "-image"], "the unchanged scene kept its file");
  assert.equal(after.ext.media["s-" + keep + "-image"].sk, "s-" + keep + "-image-kkkkk");
  assert.equal(after.ext.media["s-" + keep + "-image"].outdated, undefined);
  assert.equal(after.ext.media["s-" + edit + "-image"].outdated, true, "the edited scene's file is flagged outdated");
  assert.ok(after.ext.orphans["s-" + gone + "-image-ggggg"], "the removed scene's file is an orphan, kept");
  assert.ok(!h.calls.slice(calls0).some((c) => c[1] && c[1].method === "DELETE"), "no R2 file is deleted by a re-parse");
  h.click(h.$("#tab-overview")); await h.wait(150);
  assert.match(h.$("#ov-unused").textContent, /gone\.png/);
  assert.match(h.$("#ov-outdated").textContent, /1 file is marked Outdated/);
});

// ---------- progress chips never truncate ----------
test("chips: labels have no ellipsis or overflow rule, chips do not shrink, the strip wraps, full label in title and aria-label", { skip }, async () => {
  const css = fs.readFileSync(path.join(__dirname, "../public/static/styles.css"), "utf8");
  const rule = (sel) => (css.match(new RegExp("(?:^|\\n)" + sel.replace(/[.]/g, "\\.") + " \\{([^}]*)\\}")) || [])[1] || "";
  assert.ok(!/text-overflow|overflow:\s*hidden/.test(rule(".chip-l")), ".chip-l: " + rule(".chip-l"));
  assert.ok(!/text-overflow/.test(rule(".chip")) && /white-space:\s*nowrap/.test(rule(".chip")) && /flex:\s*0 0 auto/.test(rule(".chip")));
  assert.ok(/flex-wrap:\s*wrap/.test(rule(".chips")) && !/overflow:\s*hidden/.test(rule(".chips")));
  assert.ok(/flex-wrap:\s*wrap/.test(rule(".icard-foot")));
  const h = await boot(appOf());
  await openBoard(h);
  const chip = h.$("#scene-" + FLOW() + " .chip");
  assert.equal(chip.getAttribute("title"), "Image generated");
  assert.equal(chip.querySelector("input").getAttribute("aria-label"), "Image generated");
  assert.ok(!/generated generated/.test(h.$("#panel").innerHTML));
});
