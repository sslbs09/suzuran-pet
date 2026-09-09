"use strict";
const assert = require("assert");
const { trackDecision, trackHasProgress, movementDecision, hwndIdentity } = require("../src/animation-watch");

assert.strictEqual(trackDecision({ currentName: "Sit", targetName: "Sit", currentLoop: true, previousName: "Sit", previousTime: 1, currentTime: 1.2 }), "ok");
assert.strictEqual(trackDecision({ currentName: "Sit", targetName: "Sit", currentLoop: true, previousName: "Sit", previousTime: 1, currentTime: 1, stallCount: 2 }), "restart");
assert.strictEqual(hwndIdentity(Buffer.from([0x56, 0x34, 0x12, 0, 0, 0, 0, 0])), 0x123456n);
assert.strictEqual(hwndIdentity(Buffer.from([0x57, 0x34, 0x12, 0, 0, 0, 0, 0])), 0x123457n);
assert.strictEqual(hwndIdentity(Buffer.alloc(8)), null);
assert.strictEqual(hwndIdentity(0n), null);
assert.strictEqual(hwndIdentity(Buffer.from([0x56, 0x34, 0x12, 0]), 4), 0x123456n);
assert.strictEqual(trackDecision({ currentName: "Happy", targetName: "Move", currentLoop: false, currentAnimationEnd: 2, currentTrackTime: 1.5, active: true, busy: true }), "defer");
assert.strictEqual(trackDecision({ currentName: "Happy", targetName: "Move", currentLoop: false, currentAnimationEnd: 2, currentTrackTime: 2, active: true, busy: true }), "restart");
assert.strictEqual(trackDecision({ currentName: "Happy", targetName: "Move", currentLoop: false, currentAnimationEnd: 2, currentTrackTime: 2, active: true, queuedSuccessor: true }), "defer");
for (const state of ["resting", "paused", "sleeping", "seated", "perched"]) {
  const opts = { currentName: "Happy", targetName: "Move", currentLoop: false, currentAnimationEnd: 1, currentTrackTime: 2, active: true };
  opts[state] = true;
  assert.strictEqual(trackDecision(opts), "defer");
}
assert.strictEqual(trackDecision({ currentName: "Wrong", targetName: "Sit", currentLoop: true }), "restart");
assert.strictEqual(trackDecision({ currentName: "Sit", targetName: "Sit", currentLoop: false, previousName: "Sit", previousTime: 1, currentTime: 1 }), "defer");
assert.strictEqual(trackDecision({ currentName: "Sit", targetName: "Sit", currentLoop: true, previousName: "Sit", previousTime: 1, currentTime: 1, busy: true }), "defer");
assert.strictEqual(trackDecision({ currentName: "Sit", targetName: "Sit", currentLoop: true, previousName: "Sit", previousTime: 1, currentTime: 1, sleeping: true }), "defer");
assert.strictEqual(trackDecision({ currentName: "Sit", targetName: "Sit", currentLoop: true, previousName: "Relax", previousTime: 1, currentTime: 1.01 }), "ok");
assert.strictEqual(trackDecision({ currentName: "Sit", targetName: "Sit", currentLoop: true, previousName: "Sit", previousTime: 1, currentTime: 1, stallCount: 1 }), "ok");
assert.strictEqual(trackDecision({ currentName: "Sit", targetName: "Sit", currentLoop: true, previousName: "Sit", previousTime: 1, currentTime: 1, stallCount: 2 }), "restart");
assert.strictEqual(trackHasProgress("Move", 1, "Move", 1.1), true);
assert.strictEqual(trackHasProgress("Move", 1, "Move", 1), false);
assert.strictEqual(movementDecision({ active: true, resting: true, seated: true, positionChanged: false }), "expected-stop");
assert.strictEqual(movementDecision({ active: true, resting: false, seated: false, positionChanged: true }), "moving");
assert.strictEqual(movementDecision({ active: true, resting: false, seated: false, positionChanged: false, stallCount: 2 }), "observe");
assert.strictEqual(movementDecision({ active: true, resting: false, seated: false, positionChanged: false, stallCount: 3 }), "restart");
console.log("animation-watch 全部通过 ✅");
