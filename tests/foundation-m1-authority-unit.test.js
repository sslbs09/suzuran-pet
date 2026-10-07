"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");

const { createPostureSupport } = require("../src/state-core/posture-support");
const { createWindowCommit } = require("../src/runtime-v2/window-commit");
const { createMotionAuthority } = require("../src/runtime-v2/motion-authority");
const runtimeV2 = require("../src/runtime-v2");
const stateCore = require("../src/state-core");

test("M1 canonical runtime gate is on by default and explicit zero preserves compatibility", () => {
  assert.equal(runtimeV2.locomotionGateEnabled({}), true);
  assert.equal(stateCore.stateCoreGateEnabled({}), true);
  assert.equal(runtimeV2.locomotionGateEnabled({ SUSSURRO_RUNTIME_V2_LOCOMOTION: "0" }), false);
  assert.equal(stateCore.stateCoreGateEnabled({ SUSSURRO_RUNTIME_V2_LOCOMOTION: "0" }), false);
});

test("M1 posture patch owns body pose flags and exposes a legacy projection", () => {
  const posture = createPostureSupport();
  const result = posture.applyBodyPatch({ seated: true, perched: false, iconRest: false, freeStand: false }, { now: 10 });
  assert.equal(result.ok, true);
  assert.equal(posture.posture(), "seated");
  assert.deepEqual(posture.walkProjection(), {
    airborne: false,
    seated: true, perched: false, iconRest: false, gotoPerch: false,
    returning: false, iconTarget: false, freeStand: false
  });
});

test("M1 airborne projection returns to the current body posture on landing", () => {
  const posture = createPostureSupport();
  posture.applyBodyPatch({ seated: true });
  posture.applyBodyPatch({ airborne: true });
  assert.equal(posture.posture(), "airborne");
  posture.applyBodyPatch({ airborne: false });
  assert.equal(posture.posture(), "seated");
  assert.equal(posture.walkProjection().airborne, false);
});

test("M1 body pose kind changes invalidate old support evidence", () => {
  const posture = createPostureSupport();
  posture.applyBodyPatch({ seated: true, supportValid: true, anchorStatus: "anchored" });
  assert.equal(posture.support().valid, true);
  posture.applyBodyPatch({ seated: false, iconRest: true });
  assert.equal(posture.support().valid, false);
  assert.equal(posture.support().anchorStatus, "stale");
});

test("M1 icon rest wins support classification when legacy perched flag is also set", () => {
  const posture = createPostureSupport();
  posture.applyBodyPatch({ perched: true, iconRest: true });
  assert.equal(posture.support().kind, "icon");
});

test("M1 legacy position commit uses the shared admission and write kernel", () => {
  const authority = createMotionAuthority();
  const writes = [];
  const commit = createWindowCommit({
    authority,
    writePosition: (x, y) => writes.push([x, y]),
    writePositionExternal: (x, y) => writes.push([x, y]),
  });
  assert.equal(commit.commitLegacy({ kind: "legacy-clamp", x: 12.2, y: 33.8 }).ok, true);
  assert.deepEqual(writes, [[12, 34]]);
  const ep = authority.acquire("episode");
  assert.equal(commit.commitLegacy({ kind: "legacy-clamp", x: 20, y: 30 }).ok, false);
  assert.equal(writes.length, 1);
  authority.release("test");
  assert.equal(commit.commitLegacy({ kind: "legacy-clamp", x: 20, y: 30 }).ok, true);
  assert.deepEqual(writes.at(-1), [20, 30]);
  assert.ok(ep.token > 0);
});

test("M1 external drag remains admissible when locomotion is disabled", () => {
  const authority = createMotionAuthority();
  authority.engineOff();
  const drag = authority.externalAcquire("drag");
  assert.equal(drag.ok, true);
  assert.equal(authority.owner(), "external-drag");
  assert.equal(authority.externalRelease("pointerup").noop, undefined);
  assert.equal(authority.owner(), "none");
});

test("M1 lifecycle readiness requires the exact current document/body identity", () => {
  const lifecycle = stateCore.createLifecycleProjection();
  const identity = { docEpoch: 4, bodyGeneration: 2 };
  lifecycle.begin(identity);
  assert.equal(lifecycle.markReady(null).ok, false);
  assert.equal(lifecycle.markReady(identity).ok, true);
  assert.equal(lifecycle.usable(identity), true);
  assert.equal(lifecycle.usable({ docEpoch: 3, bodyGeneration: 2 }), false);
  assert.equal(lifecycle.usable({ docEpoch: 4, bodyGeneration: 1 }), false);
  lifecycle.begin({ docEpoch: 5, bodyGeneration: 3 });
  assert.equal(lifecycle.ready(), false);
});
