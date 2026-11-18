const test = require("node:test");
const assert = require("node:assert/strict");
const Q = require("../public/static/queue.js");

test("create starts at main, keeps old failed keys and has no lock", () => {
  const q = Q.create(1000, { failed: ["3", "r2"] });
  assert.deepEqual(q.phases, ["main", "reels", "export"]);
  assert.equal(q.phase, "main");
  assert.deepEqual(q.failed, ["3", "r2"]);
  assert.equal(q.startedAt, 1000);
  assert.ok(q.id);
  assert.equal(q.lock, undefined);
});

test("nextPhase walks main, reels, export, then null; skip drops a phase", () => {
  const q = Q.create(1);
  assert.equal(Q.nextPhase(q), "reels");
  q.phase = "reels"; assert.equal(Q.nextPhase(q), "export");
  q.phase = "export"; assert.equal(Q.nextPhase(q), null);
  q.phase = "main";
  assert.equal(Q.nextPhase(q, (p) => p === "reels"), "export");
  assert.equal(Q.nextPhase({ phases: ["main"], phase: "gone" }), null);
  assert.equal(Q.nextPhase(null), null);
});

test("lock: free, mine, other, and stale after the TTL", () => {
  const q = Q.create(1);
  assert.equal(Q.lockState(q, "A", 100), "free");
  Q.takeLock(q, "A", 100);
  assert.equal(Q.lockState(q, "A", 200), "mine");
  assert.equal(Q.lockState(q, "B", 200), "other");
  assert.equal(Q.lockState(q, "B", 100 + Q.LOCK_TTL_MS + 1), "free", "no heartbeat for 45 s means abandoned");
  Q.beat(q, "B", 5000); assert.equal(q.lock.beat, 100, "only the owner beats");
  Q.beat(q, "A", 40000); assert.equal(Q.lockState(q, "B", 40000 + 1000), "other");
  Q.releaseLock(q); assert.equal(Q.lockState(q, "B", 1), "free");
});

test("resumeFrom: nothing, resume, export, locked; never starts by itself", () => {
  assert.equal(Q.resumeFrom(undefined, "A", 1), null);
  assert.equal(Q.resumeFrom({ failed: ["1"] }, "A", 1), null, "a queue that only holds failed keys has nothing to resume");
  const q = Q.create(1);
  assert.deepEqual(Q.resumeFrom(q, "A", 2), { phase: "main", state: "resume" });
  q.phase = "reels"; assert.deepEqual(Q.resumeFrom(q, "A", 2), { phase: "reels", state: "resume" });
  q.phase = "export"; assert.deepEqual(Q.resumeFrom(q, "A", 2), { phase: "export", state: "export" });
  Q.takeLock(q, "B", 10);
  assert.deepEqual(Q.resumeFrom(q, "A", 11), { phase: "export", state: "locked" });
  assert.equal(Q.resumeFrom(q, "B", 11).state, "export", "the lock owner (same tab after a reload) may continue");
  assert.equal(Q.resumeFrom(q, "A", 11 + Q.LOCK_TTL_MS + 5).state, "export");
});

test("finish keeps only the failed keys", () => {
  const q = Q.create(1, { failed: ["2"] }); Q.takeLock(q, "A", 3);
  assert.deepEqual(Q.finish(q), { failed: ["2"] });
  assert.deepEqual(Q.finish(undefined), { failed: [] });
});
