/*
 * Remote storage adapter for /app (see the StoreAdapter typedef in store.js). The server is the only source of
 * truth: D1 holds projects, folders, progress and info; R2 holds generated audio. There is no local copy of any
 * project, no queue and no retry loop: every call goes to same-origin /api (X-MBS: 1) and either succeeds or throws
 * an Error that carries `status` (0 for a network failure, 401 signed out, 409 version conflict, other HTTP codes).
 *
 * Projects carry an integer `version`. putProject sends it as baseVersion; the server refuses a stale one with 409
 * (err.version is the current version) unless the caller passes { overwrite: true }. The list holds summaries only
 * (id, name, folderId, status, createdAt, updatedAt, serverAt, version); getProject loads the whole project.
 * IndexedDB is used only for File System Access folder handles (device-local), through the local adapter.
 * Never loaded by /demo.
 */
(function () {
  "use strict";

  const ERR_NET = "Could not reach the server. Check your connection and try again.";

  function apiError(res, body) {
    const msg = res.status === 401 ? "You are signed out. Sign in again to save."
      : res.status === 409 && body && /changed elsewhere/.test(body.error || "") ? "This project changed elsewhere."
      : res.status === 413 ? "That is over the size limit." : (body && body.error) || "The server refused it (" + res.status + ").";
    const e = new Error(msg);
    e.status = res.status;
    if (body && body.version !== undefined) e.version = body.version;
    return e;
  }

  /**
   * @param {string} prefix  "mbs_app": settings, nav, handles and the current project id stay on this device under this prefix.
   * @param {Object} [opts]  test hooks: { fetch, local }
   * @returns {import("./store.js").StoreAdapter & Object}
   */
  function create(prefix, opts) {
    opts = opts || {};
    const local = opts.local || window.MBSStore.create(prefix, { dbPrefix: prefix + "_cache" });
    const doFetch = opts.fetch || ((...a) => window.fetch(...a));

    // The Response, or a thrown Error (status 0) when the network failed. Does not look at the status.
    async function raw(method, path, o) {
      o = o || {};
      const headers = { "X-MBS": "1" };
      if (o.json !== undefined) headers["Content-Type"] = "application/json";
      if (o.type) headers["Content-Type"] = o.type;
      try {
        return await doFetch(path, { method, credentials: "same-origin", headers, body: o.json !== undefined ? JSON.stringify(o.json) : o.body });
      } catch {
        const e = new Error(ERR_NET);
        e.status = 0;
        throw e;
      }
    }
    // Resolves with the Response when it is ok (or its status is in o.allow); throws an Error with .status otherwise.
    async function call(method, path, o) {
      const res = await raw(method, path, o);
      if (res.ok || (o && o.allow && o.allow.includes(res.status))) return res;
      let body = null;
      try { body = await res.json(); } catch { /* not JSON */ }
      throw apiError(res, body);
    }

    const ids = (pid, n) => "/api/projects/" + encodeURIComponent(pid) + "/audio/" + encodeURIComponent(n);

    return {
      prefix,
      raw, // for MBSMigrate: returns the Response, throws on network errors

      newProject: (n) => local.newProject(n),
      newFolder: (n) => local.newFolder(n),

      async listProjects() { return (await (await call("GET", "/api/projects")).json()).projects; },
      async getProject(id) {
        const res = await call("GET", "/api/projects/" + encodeURIComponent(id), { allow: [404] });
        return res.status === 404 ? undefined : res.json();
      },
      // Saves the whole project. p.version is the version it was loaded at; on success it becomes the new one.
      // opts: { touch: false } keeps updatedAt; { overwrite: true } saves over a newer server copy.
      async putProject(p, opts) {
        opts = opts || {};
        if (opts.touch !== false) p.updatedAt = Date.now();
        const body = Object.assign({}, p, { baseVersion: p.version || 0, overwrite: !!opts.overwrite });
        delete body.serverAt; delete body.version;
        const data = await (await call("PUT", "/api/projects/" + encodeURIComponent(p.id), { json: body })).json();
        p.version = data.version; p.serverAt = data.serverAt;
      },
      // Name, folder and status only (rename, move): safe while the same project has unsaved edits. Returns { version, serverAt }.
      async patchProject(id, fields) {
        return (await call("PATCH", "/api/projects/" + encodeURIComponent(id), { json: fields })).json();
      },
      async deleteProject(id) { await call("DELETE", "/api/projects/" + encodeURIComponent(id), { allow: [404] }); },
      async listFolders() { return (await (await call("GET", "/api/folders")).json()).folders; },
      async putFolder(f) { await call("PUT", "/api/folders/" + encodeURIComponent(f.id), { json: { id: f.id, name: f.name, collapsed: !!f.collapsed, createdAt: f.createdAt } }); },
      async deleteFolder(id) { await call("DELETE", "/api/folders/" + encodeURIComponent(id), { allow: [404] }); },

      async putAudio(pid, n, blob) {
        await call("PUT", ids(pid, n), { body: blob, type: /wav/i.test(blob.type) ? "audio/wav" : "audio/mpeg" });
      },
      async getAudio(pid, n) {
        try {
          const res = await call("GET", ids(pid, n));
          return await res.blob();
        } catch { return undefined; }
      },
      async deleteAudio(pid, n) { await call("DELETE", ids(pid, n), { allow: [404] }); },

      putHandle: (...a) => local.putHandle(...a),
      getHandle: (...a) => local.getHandle(...a),
      deleteHandle: (...a) => local.deleteHandle(...a),
      getSettings: () => local.getSettings(),
      saveSettings: (s) => local.saveSettings(s),
      getSidebarCollapsed: () => local.getSidebarCollapsed(),
      setSidebarCollapsed: (v) => local.setSidebarCollapsed(v),
      getNav: () => local.getNav(),
      setNav: (n) => local.setNav(n),
      pendingKey: local.pendingKey,
      getCurrent: () => local.getCurrent(),
      setCurrent: (id) => local.setCurrent(id),
    };
  }

  window.MBSRemoteStore = { create };
})();
