/*
 * "Generate everything" pipeline state. Pure functions over proj.ext.queue, no DOM, no timers.
 *   queue = { id, phases: ["main", "reels", "export"], phase, failed: [keys], startedAt, lock: { tab, beat } }
 * The pipeline never starts by itself: after a reload the saved queue only offers "Resume pipeline".
 * The lock (tab id plus a heartbeat time) keeps two tabs from running one project's queue at once.
 * UMD: window.MBSQueue in the browser, require() in Node.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MBSQueue = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const PHASES = ["main", "reels", "export"];
  /** A lock whose heartbeat is older than this is treated as abandoned (the tab was closed or crashed). */
  const LOCK_TTL_MS = 45 * 1000;

  /** A fresh queue at the first phase. Keeps the failed keys of an earlier run so "Retry failed" still works. */
  function create(now, opts) {
    opts = opts || {};
    const phases = opts.phases || PHASES.slice();
    return { id: opts.id || "q" + now.toString(36), phases, phase: phases[0], failed: (opts.failed || []).slice(), startedAt: now };
  }

  /**
   * The phase after the current one, or null at the end. skip(phase) says a phase has nothing to do
   * (for example "reels" when the project has no reel audio).
   */
  function nextPhase(queue, skip) {
    if (!queue || !queue.phases) return null;
    let i = queue.phases.indexOf(queue.phase);
    if (i < 0) return null;
    for (i += 1; i < queue.phases.length; i++) {
      if (!skip || !skip(queue.phases[i])) return queue.phases[i];
    }
    return null;
  }

  /** "free" (no lock, or a stale one), "mine" or "other" (another tab holds a live lock). */
  function lockState(queue, tab, now) {
    const l = queue && queue.lock;
    if (!l || !l.tab) return "free";
    if (l.tab === tab) return "mine";
    return now - (Number(l.beat) || 0) > LOCK_TTL_MS ? "free" : "other";
  }

  function takeLock(queue, tab, now) { queue.lock = { tab, beat: now }; return queue; }
  function beat(queue, tab, now) { if (queue.lock && queue.lock.tab === tab) queue.lock.beat = now; return queue; }
  function releaseLock(queue) { delete queue.lock; return queue; }

  /**
   * What to offer for a saved queue: null (nothing), or { phase, state } where state is
   * "export" (audio done, pick ZIP or folder), "resume" (paused, stopped or interrupted, this tab may continue)
   * or "locked" (another tab is running it).
   */
  function resumeFrom(queue, tab, now) {
    if (!queue || !queue.id || !queue.phase || !queue.phases || !queue.phases.includes(queue.phase)) return null;
    if (lockState(queue, tab, now) === "other") return { phase: queue.phase, state: "locked" };
    return { phase: queue.phase, state: queue.phase === "export" ? "export" : "resume" };
  }

  /** The queue after the user is done: only the failed keys stay, so "Retry failed" keeps working. */
  function finish(queue) { return { failed: ((queue && queue.failed) || []).slice() }; }

  return { PHASES, LOCK_TTL_MS, create, nextPhase, lockState, takeLock, beat, releaseLock, resumeFrom, finish };
});
