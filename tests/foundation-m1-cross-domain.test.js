"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { loadMain } = require("./helpers/main-body-harness");

function open(h) {
  const win = h.createWindow();
  const identity = h.syncDocument();
  h.outcome(identity, { requestedMode: "spine", committedMode: "spine", ok: true });
  h.ready(identity, { committedMode: "spine", usable: true });
  assert.equal(h.state.v2StateCore.lifecycle.ready(), true);
  return { win, identity };
}

function eventFor(h, identity, sender = h.state.win.webContents, senderFrame = sender.mainFrame) {
  return { sender, senderFrame, identity };
}

test("cross-domain chat ownership survives accepted mode off/on and matching exit", async () => {
  const h = loadMain();
  const { identity } = open(h);
  h.setTray({ setContextMenu() {} });
  h.context.__m1.startWalkingEngine({ silent: true });
  const claim = h.context.__m1.chatOwnership.enter("cross-chat");
  assert.equal(claim.ok, true);
  assert.equal(h.state.v2StateCore.pause.isPaused("chat"), true);

  h.context.__m1.call("dispatchRenderModeIntent", "gif");
  h.outcome(identity, { requestedMode: "gif", committedMode: "gif", ok: true });
  h.ready(identity, { committedMode: "gif", usable: true });
  assert.equal(h.state.v2StateCore.pause.isPaused("chat"), true,
    "mode switch must preserve the active chat lease");
  h.context.__m1.call("dispatchRenderModeIntent", "spine");
  h.outcome(identity, { requestedMode: "spine", committedMode: "spine", ok: true });
  h.ready(identity, { committedMode: "spine", usable: true });
  assert.equal(h.state.walk.active, true, "accepted Spine mode must restart the configured walking engine");
  assert.equal(h.context.__m1.chatOwnership.exit(claim.token + 1).ok, false);
  assert.equal(h.state.v2StateCore.pause.isPaused("chat"), true);
  assert.equal(h.context.__m1.chatOwnership.exit(claim.token).ok, true);
  const before = h.state.v2Commit.stats.committed;
  const beforeBounds = h.state.win.getBounds();
  h.context.__m1.stopWalkingEngine();
  h.context.__m1.startWalkingEngine({ silent: true });
  await h.context.__m1.walkOnPhaseEnd();
  h.context.__m1.walkTick();
  assert.ok(h.state.v2Commit.stats.committed > before, "walking remains executable after matching chat exit");
  assert.notDeepEqual(h.state.win.getBounds(), beforeBounds, "post-exit phase must reach a native position change");
});

test("cross-domain same-document stale drag release is inert after mode revocation", () => {
  const h = loadMain();
  const { identity } = open(h);
  const pause = h.handler("pet:walking-pause");
  const move = h.handler("pet:move");
  const before = h.state.win.getBounds();
  pause(eventFor(h, identity), true, "drag", "drag-current", identity);
  move(eventFor(h, identity), 18, 0, "drag-current", identity);
  const moved = h.state.win.getBounds();
  const postureBefore = h.state.v2StateCore.posture.snapshot().posture.state;
  h.context.__m1.call("dispatchRenderModeIntent", "gif");
  h.outcome(identity, { requestedMode: "gif", committedMode: "gif", ok: true });
  h.ready(identity, { committedMode: "gif", usable: true });
  pause(eventFor(h, identity), false, "drag", "drag-old", identity);
  assert.deepEqual(h.state.win.getBounds(), moved, "old release cannot write a new native position");
  assert.equal(h.state.v2StateCore.pause.isPaused("drag"), false);
  assert.equal(h.state.v2StateCore.posture.snapshot().posture.state, postureBefore);
  assert.equal(h.state.walk.dragPaused, false);
  assert.notEqual(h.state.v2Authority.owner(), "external-drag");
  assert.notDeepEqual(moved, before);
});

test("cross-domain non-Spine sleep accepts repeated true without extending main deadline", () => {
  const h = loadMain();
  const { identity } = open(h);
  h.context.__m1.call("dispatchRenderModeIntent", "gif");
  h.outcome(identity, { requestedMode: "gif", committedMode: "gif", ok: true });
  h.ready(identity, { committedMode: "gif", usable: true });
  const sleep = h.handler("pet:set-sleeping");
  sleep(eventFor(h, identity), true, identity);
  h.advance(10 * 60 * 1000);
  sleep(eventFor(h, identity), true, identity);
  h.advance(15 * 60 * 1000 - 1);
  assert.equal(h.state.walk.sleeping, true);
  h.advance(1);
  assert.equal(h.state.walk.sleeping, false, "repeated true must not restart the 25-minute deadline");
});

test("cross-domain default ready geometry admits the real V2 episode and WindowCommit path", () => {
  const h = loadMain();
  const { identity } = open(h);
  h.context.__m1.startWalkingEngine({ silent: true });
  h.context.__m1.setBodyPosture({ seated: true }, { source: "cross-v2-setup" });
  const ground = h.handler("pet:set-ground-gap");
  ground(eventFor(h, identity), 0, {
    sourceMode: "spine", renderGeneration: identity.bodyGeneration,
    docEpoch: identity.docEpoch, geometryRevision: 1
  }, identity);
  const canEnter = h.context.__m1.probe("v2CanEnterSlice");
  assert.equal(typeof canEnter, "function");
  assert.equal(canEnter().ok, true, "accepted geometry and ready owner must admit the default V2 slice");
  const before = h.state.v2Commit.stats.committed;
  const episode = h.state.v2Locomotion.beginEpisode({ dir: 1, moveMs: 500 });
  assert.equal(episode.ok, true);
  h.advance(300);
  h.state.v2Locomotion.tick();
  assert.ok(h.state.v2Commit.stats.committed > before, "V2 episode must use the real WindowCommit path");
});

test("cross-domain ask/stop/regenerate reject wrong document while current ask admits its lease", async () => {
  const h = loadMain();
  const { identity } = open(h);
  const ask = h.handler("pet:ask");
  const stop = h.handler("pet:stop");
  const regen = h.handler("pet:regenerate");
  const wrong = { docEpoch: identity.docEpoch, bodyGeneration: identity.bodyGeneration + 1 };
  const currentEvent = eventFor(h, identity);
  assert.equal(ask(currentEvent, { id: "ask-current", text: "x", bodyIdentity: identity }), true);
  assert.equal(h.state.v2StateCore.pause.isPaused("chat"), true,
    "accepted current ask must acquire the production chat lease before its async body runs");
  assert.equal(ask({ sender: currentEvent.sender, senderFrame: currentEvent.senderFrame },
    { id: "ask-wrong", text: "x", bodyIdentity: wrong }), false);
  assert.equal(stop(currentEvent, "ask-wrong", wrong), undefined);
  assert.equal(h.state.v2StateCore.pause.isPaused("chat"), true,
    "wrong-document stop must not release the current chat lease");
  assert.equal(await regen(currentEvent, "regen-wrong", wrong), null);
  assert.equal(await regen(currentEvent, "regen-current", identity), null,
    "current regenerate remains policy-rejected by the default empty history/API fixture");
});
