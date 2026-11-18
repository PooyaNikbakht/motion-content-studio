const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

// Every choice list uses the custom dropdown (ddHtml/ddInit in ui.js): a native <select> would show the grey system popup.
test("no native <select> in any script or page", () => {
  const root = path.join(__dirname, "../public");
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (/\.(js|html)$/.test(e.name)) files.push(f);
    }
  })(root);
  const bad = files.filter((f) => /<select[\s>]/i.test(fs.readFileSync(f, "utf8")) || /createElement\(["']select["']\)/.test(fs.readFileSync(f, "utf8")));
  assert.deepEqual(bad.map((f) => path.relative(root, f)), []);
});
