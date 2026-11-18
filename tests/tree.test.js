const test = require("node:test");
const assert = require("node:assert");
const T = require("../public/static/tree.js");

const folders = [{ id: "fb", name: "beta" }, { id: "fa", name: "Alpha", collapsed: true }, { id: "fe", name: "Empty" }];
const projects = [
  { id: "p1", name: "Lighthouse", updatedAt: 10, folderId: "fa" },
  { id: "p2", name: "Harbour", updatedAt: 30, folderId: "fa" },
  { id: "p3", name: "Loose old", updatedAt: 5 },
  { id: "p4", name: "Loose new", updatedAt: 50, folderId: null },
  { id: "p5", name: "Orphan", updatedAt: 40, folderId: "gone" },
  { id: "p6", name: "Tide", updatedAt: 20, folderId: "fb" },
];

test("buildTree sorts folders by name and projects by updated desc", () => {
  const t = T.buildTree(folders, projects, "");
  assert.deepStrictEqual(t.folders.map((f) => f.id), ["fa", "fb", "fe"]);
  assert.deepStrictEqual(t.folders[0].projects.map((p) => p.id), ["p2", "p1"]);
  assert.deepStrictEqual(t.root.map((p) => p.id), ["p4", "p5", "p3"]);
});

test("buildTree: missing or unknown folderId is top level, collapsed respected", () => {
  const t = T.buildTree(folders, projects, "");
  assert.ok(t.root.some((p) => p.id === "p5"));
  assert.strictEqual(t.folders[0].expanded, false);
  assert.strictEqual(t.folders[1].expanded, true);
  assert.strictEqual(t.folders[2].total, 0);
});

test("search filters by project name and auto-expands matching folders", () => {
  const t = T.buildTree(folders, projects, " har ");
  assert.deepStrictEqual(t.folders.map((f) => f.id), ["fa"]);
  assert.strictEqual(t.folders[0].expanded, true);
  assert.deepStrictEqual(t.folders[0].projects.map((p) => p.id), ["p2"]);
  assert.strictEqual(t.folders[0].total, 2);
  assert.deepStrictEqual(t.root, []);
});

test("search on a folder name keeps all its projects; no match is empty", () => {
  const t = T.buildTree(folders, projects, "alpha");
  assert.strictEqual(t.folders[0].projects.length, 2);
  assert.strictEqual(T.buildTree(folders, projects, "zzz").empty, true);
});

test("moveProject sets or clears folderId without mutating", () => {
  const moved = T.moveProject(projects, "p3", "fb", folders);
  assert.strictEqual(moved.find((p) => p.id === "p3").folderId, "fb");
  assert.strictEqual(projects.find((p) => p.id === "p3").folderId, undefined);
  assert.strictEqual(T.moveProject(moved, "p3", null, folders).find((p) => p.id === "p3").folderId, null);
  assert.strictEqual(T.moveProject(projects, "p3", "nope", folders).find((p) => p.id === "p3").folderId, null);
});

test("deleteFolder moves its projects to the top level and never deletes projects", () => {
  const r = T.deleteFolder(folders, projects, "fa");
  assert.strictEqual(r.projects.length, projects.length);
  assert.deepStrictEqual(r.folders.map((f) => f.id), ["fb", "fe"]);
  assert.ok(r.projects.filter((p) => ["p1", "p2"].includes(p.id)).every((p) => p.folderId === null));
  assert.strictEqual(r.projects.find((p) => p.id === "p6").folderId, "fb");
  assert.strictEqual(T.countIn(projects, "fa"), 2);
});
