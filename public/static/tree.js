/*
 * Sidebar tree helpers. Plain JS, no dependencies, works in the browser
 * (window.MBSTree) and in Node (require). Folders are one level deep:
 * a folder is { id, name, collapsed }, a project has an optional folderId
 * (missing, null or unknown means top level). Nothing here mutates its input.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MBSTree = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const byName = (a, b) => String(a.name).localeCompare(String(b.name), undefined, { sensitivity: "base", numeric: true });
  const byUpdated = (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || byName(a, b);
  const has = (name, q) => String(name || "").toLowerCase().includes(q);

  /**
   * { folders: [{ id, name, collapsed, expanded, total, projects }], root: [project], empty }.
   * Folders are alphabetical, projects newest-updated first. A search matches project names
   * and folder names (a folder match keeps all its projects) and force-expands matching folders.
   */
  function buildTree(folders, projects, query) {
    const q = String(query || "").trim().toLowerCase();
    const known = new Set((folders || []).map((f) => f.id));
    const list = projects || [];
    const rootAll = list.filter((p) => !p.folderId || !known.has(p.folderId));
    const out = [];
    (folders || []).slice().sort(byName).forEach((f) => {
      const all = list.filter((p) => p.folderId === f.id);
      let shown = all;
      if (q && !has(f.name, q)) {
        shown = all.filter((p) => has(p.name, q));
        if (!shown.length) return;
      }
      out.push({ id: f.id, name: f.name, collapsed: !!f.collapsed, expanded: q ? true : !f.collapsed, total: all.length, projects: shown.slice().sort(byUpdated) });
    });
    const root = (q ? rootAll.filter((p) => has(p.name, q)) : rootAll).sort(byUpdated);
    return { folders: out, root, empty: !out.length && !root.length };
  }

  /** Returns a new projects array with one project's folderId set (null for the top level; unknown folders become null). */
  function moveProject(projects, id, folderId, folders) {
    const target = folderId && (folders || []).some((f) => f.id === folderId) ? folderId : null;
    return (projects || []).map((p) => (p.id === id ? Object.assign({}, p, { folderId: target }) : p));
  }

  /** Removes a folder and moves its projects to the top level. Never removes a project. */
  function deleteFolder(folders, projects, id) {
    return {
      folders: (folders || []).filter((f) => f.id !== id),
      projects: (projects || []).map((p) => (p.folderId === id ? Object.assign({}, p, { folderId: null }) : p)),
    };
  }

  /** Number of projects directly inside a folder. */
  function countIn(projects, folderId) {
    return (projects || []).filter((p) => p.folderId === folderId).length;
  }

  return { buildTree, moveProject, deleteFolder, countIn, byName, byUpdated };
});
