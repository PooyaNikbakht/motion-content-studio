const test = require("node:test");
const assert = require("node:assert/strict");
const Pr = require("../public/static/prompts.js");

test("numbered", () => {
  assert.equal(Pr.numbered(["a", " b "]), "1. a\n\n2. b");
  assert.equal(Pr.numbered([]), "");
  assert.equal(Pr.numbered(["a", null]), "1. a\n\n2. ");
});

test("toCsv follows RFC 4180 and starts with a BOM", () => {
  const csv = Pr.toCsv([["scene", "prompt"], [1, 'He said "hi", then left'], [2, "line one\nline two"], [3, "پرامپت"], [4, null]]);
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.equal(csv.slice(1), 'scene,prompt\r\n1,"He said ""hi"", then left"\r\n2,"line one\nline two"\r\n3,پرامپت\r\n4,\r\n');
  assert.equal(Pr.toCsv([]), "﻿\r\n");
});

test("the pack helpers are gone", () => {
  assert.deepEqual(Object.keys(Pr).sort(), ["numbered", "toCsv"]);
});
