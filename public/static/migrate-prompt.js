/*
 * When to offer the one-time upload of the projects kept in this browser before /app moved to server storage. Pure, no DOM.
 *   legacy: [{ id, updatedAt }] projects found in the old IndexedDB
 *   server: [{ id }] projects on the server, or null when the list could not be read
 *   flags:  { migrated, dismissed, sessionLater, uploaded: [ids] }
 *     migrated     "Don't ask again" or an upload finished (localStorage mbs_app:migrated)
 *     dismissed    "Not now" was chosen once (localStorage mbs_app:migrate-dismissed)
 *     sessionLater "Not now" in this tab session (sessionStorage)
 *     uploaded     ids that were uploaded before (localStorage mbs_app:uploaded); a project deleted from the server later is not offered again
 * Returns { prompt, pending: [ids never uploaded and not on the server], reason }.
 * UMD: window.MBSMigratePrompt in the browser, require() in Node.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MBSMigratePrompt = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function shouldPrompt(legacy, server, flags) {
    flags = flags || {};
    const up = new Set(flags.uploaded || []);
    const on = new Set((server || []).map((p) => p.id));
    const pending = (legacy || []).filter((p) => !on.has(p.id) && !up.has(p.id)).map((p) => p.id);
    let reason = "pending";
    if (flags.migrated) reason = "migrated";
    else if (flags.dismissed) reason = "dismissed";
    else if (flags.sessionLater) reason = "later";
    else if (!pending.length) reason = "done";
    else if (server === null || server === undefined) reason = "offline";
    return { prompt: reason === "pending", pending, reason };
  }

  return { shouldPrompt };
});
