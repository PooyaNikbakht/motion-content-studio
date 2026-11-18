/*
 * Prompt helpers: numbered lists and CSV. Pure functions.
 * UMD: window.MBSPrompts in the browser, require() in Node.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MBSPrompts = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /** "1. first\n\n2. second": a numbered list, one block per item. Empty items keep their number but are left blank. */
  function numbered(list) {
    return (list || []).map((t, i) => (i + 1) + ". " + String(t == null ? "" : t).trim()).join("\n\n");
  }

  /** RFC 4180: CRLF line ends, fields with comma, quote or line break are quoted, quotes doubled. Starts with a UTF-8 BOM. */
  function toCsv(rows) {
    const cell = (v) => {
      const s = v == null ? "" : String(v);
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return "\uFEFF" + (rows || []).map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
  }

  return { numbered, toCsv };
});
