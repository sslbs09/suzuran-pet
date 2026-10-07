"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { loadMain } = require("./helpers/main-body-harness");

function openDocument(h) {
  const win = h.createWindow();
  const identity = h.syncDocument();
  assert.ok(identity && Number.isSafeInteger(identity.docEpoch), "production document sync must return docEpoch");
  assert.ok(Number.isSafeInteger(identity.bodyGeneration), "production document sync must return bodyGeneration");
  h.outcome(identity, { requestedMode: "spine", committedMode: "spine", ok: true });
  h.ready(identity, { owner: "spine", usable: true, committedMode: "spine" });
  assert.equal(h.state.v2StateCore.lifecycle.ready(), true, "body-ready must admit the current visual owner");
  assert.equal(h.state.v2StateCore.lifecycle.usable(identity), true);
  return { win, identity };
}

function eventFor(h, identity, sender = h.state.win.webContents, senderFrame = sender.mainFrame) {
  return { sender, senderFrame, identity };
}

test("T1 default production composition creates canonical authorities and a real body document", () => {
  const h = loadMain();
  assert.equal(h.state.RUNTIME_V2_LOCOMOTION_ENABLED, true);
  assert.ok(h.state.v2StateCore && h.state.v2Authority && h.state.v2Commit && h.state.v2Drag);
  const { identity } = openDocument(h);
  assert.equal(h.state.v2StateCore.lifecycle.current().docEpoch, identity.docEpoch);
  assert.equal(h.state.v2StateCore.lifecycle.current().bodyGeneration, identity.bodyGeneration);
});

test("T2 old document sleep is rejected after a real document replacement", () => {
  const h = loadMain();
  const first = openDocument(h);
  const oldFrame = first.win.webContents.mainFrame;
  h.advance(60000);
  assert.equal(h.handler("pet:reload-renderer")(h.event(), first.identity), true);
  first.win.webContents.__newDocument();
  const current = h.syncDocument();
  h.ready(current, { owner: "spine", usable: true, committed: true });
  const sleep = h.handler("pet:set-sleeping");
  sleep(eventFor(h, first.identity, first.win.webContents, oldFrame), true, first.identity);
  assert.equal(h.state.walk.sleeping, false, "late old-document sleep must not change main truth");
  sleep(eventFor(h, first.identity), true, first.identity);
  assert.equal(h.state.walk.sleeping, false, "old identity on the current sender/frame must still be rejected");
  sleep(eventFor(h, { docEpoch: current.docEpoch, bodyGeneration: current.bodyGeneration + 1 }), true,
    { docEpoch: current.docEpoch, bodyGeneration: current.bodyGeneration + 1 });
  assert.equal(h.state.walk.sleeping, false, "future identity must be rejected");
  sleep(eventFor(h, current), true, current);
  assert.equal(h.state.walk.sleeping, true);
});

test("T3 old document move is rejected after a real reload while current drag can move", () => {
  const h = loadMain();
  const first = openDocument(h);
  const pause = h.handler("pet:walking-pause");
  const move = h.handler("pet:move");
  pause(eventFor(h, first.identity), true, "drag", "lease-1", first.identity);
  const before = h.state.win.getBounds();
  const oldFrame = first.win.webContents.mainFrame;
  h.advance(60000);
  assert.equal(h.handler("pet:reload-renderer")(h.event(), first.identity), true);
  h.state.win.webContents.__newDocument();
  const current = h.syncDocument();
  h.ready(current, { owner: "spine", usable: true, committed: true });
  move(eventFor(h, first.identity, h.state.win.webContents, oldFrame), 40, 0, "lease-1", first.identity);
  assert.deepEqual(h.state.win.getBounds(), before, "old document move must not reach native commit");
  move(eventFor(h, first.identity), 40, 0, "lease-1", first.identity);
  assert.deepEqual(h.state.win.getBounds(), before, "generation mismatch must reject even with current sender/frame");
  const future = { docEpoch: current.docEpoch, bodyGeneration: current.bodyGeneration + 1 };
  move(eventFor(h, future), 40, 0, "lease-current", future);
  assert.deepEqual(h.state.win.getBounds(), before, "future generation must be rejected");
  pause(eventFor(h, current), true, "drag", "lease-current", current);
  move(eventFor(h, current), 40, 0, "lease-current", current);
  assert.equal(h.state.win.getBounds().x, before.x + 40);
});

test("T4 same-document stale drag release cannot clear a newer lease", () => {
  const h = loadMain();
  const { identity } = openDocument(h);
  const pause = h.handler("pet:walking-pause");
  const throwPet = h.handler("pet:throw");
  pause(eventFor(h, identity), true, "drag", "lease-new", identity);
  pause(eventFor(h, identity), false, "drag", "lease-old", identity);
  assert.equal(h.state.v2StateCore.pause.isPaused("drag"), true);
  pause(eventFor(h, identity), false, "interact", "lease-new", identity);
  pause(eventFor(h, identity), false, "unknown", "lease-new", identity);
  assert.equal(h.state.v2StateCore.pause.isPaused("drag"), true,
    "body-local/unknown releases must not clear the drag lease");
  throwPet(eventFor(h, identity), 300, -400, "lease-old", identity);
  assert.equal(h.state.v2StateCore.pause.isPaused("drag"), true,
    "stale throw must be rejected without clearing the current drag lease");
  pause(eventFor(h, identity), false, "drag", "lease-new", identity);
  assert.equal(h.state.v2StateCore.pause.isPaused("drag"), false);
});

test("T5 real walking engine to drag and release preserves authority handoff", async () => {
  const h = loadMain();
  const { identity } = openDocument(h);
  h.context.__m1.startWalkingEngine({ silent: true });
  assert.equal(h.state.walk.active, true, "real walking engine must be active");
  await h.context.__m1.walkOnPhaseEnd();
  assert.ok(["legacy", "v2"].includes(h.state.v2Authority.owner()), "phase execution must retain a legitimate motion owner");
  const pause = h.handler("pet:walking-pause");
  pause(eventFor(h, identity), true, "drag", "lease-walk", identity);
  assert.equal(h.state.v2Authority.owner(), "external-drag");
  pause(eventFor(h, identity), false, "drag", "lease-walk", identity);
  assert.equal(h.state.v2StateCore.pause.isPaused("drag"), false);
  assert.equal(h.state.v2Authority.owner(), "legacy", "drag release must return ownership to the walking executor");
  const beforeWalkingCommit = h.state.v2Commit.stats.committed;
  h.state.walk.resting = false;
  h.state.walk.seated = false;
  h.state.walk.paused = false;
  h.state.walk.dir = 1;
  h.context.__m1.walkTick();
  assert.ok(h.state.v2Commit.stats.committed > beforeWalkingCommit,
    "post-release walking tick must reach WindowCommit");
  assert.equal(h.state.walk.active, true, "walking must remain executable after drag release");
});

test("T6 production chatPauseWalk owns and releases chat busy lease", () => {
  const h = loadMain();
  const { identity } = openDocument(h);
  h.context.__m1.startWalkingEngine({ silent: true });
  const claim = h.context.__m1.chatOwnership.enter("test-chat");
  assert.equal(claim.ok, true);
  assert.equal(h.state.v2StateCore.pause.isPaused("chat"), true);
  const stale = h.context.__m1.chatOwnership.exit(claim.token + 1);
  assert.equal(stale.ok, false, "stale chat handle must not clear the current chat lease");
  assert.equal(h.state.v2StateCore.pause.isPaused("chat"), true);
  const released = h.context.__m1.chatOwnership.exit(claim.token);
  assert.equal(released.ok, true);
  assert.equal(h.state.v2StateCore.pause.isPaused("chat"), false);
  assert.equal(h.state.walk.chatPaused, false);
  assert.equal(h.state.walk.active, true, "walking must resume after the matching chat release");
  assert.ok(identity);
});

test("T7 accepted sleep and interaction wake use one main-owned truth", () => {
  const h = loadMain();
  const { identity } = openDocument(h);
  const sleep = h.handler("pet:set-sleeping");
  sleep(eventFor(h, identity), true, identity);
  assert.equal(h.state.walk.sleeping, true);
  const sleepingBroadcast = h.messages().filter((m) => m.name === "pet:walking").at(-1);
  assert.equal(sleepingBroadcast.args[0].sleeping, true, "main truth must be projected to renderer");
  h.advance(25 * 60 * 1000 - 1);
  assert.equal(h.state.walk.sleeping, true, "main sleep truth must remain until the 25-minute boundary");
  h.advance(1);
  assert.equal(h.state.walk.sleeping, false, "main-owned auto-wake must clear sleeping at 25 minutes");
  sleep(eventFor(h, identity), false, identity);
  assert.equal(h.state.walk.sleeping, false);
  const awakeBroadcast = h.messages().filter((m) => m.name === "pet:walking").at(-1);
  assert.equal(awakeBroadcast.args[0].sleeping, false);
  const rendererSource = fs.readFileSync(path.join(__dirname, "..", "renderer", "pet.js"), "utf8");
  assert.doesNotMatch(rendererSource, /SLEEP_AUTO_WAKE_MS|armSleepAutoWake/,
    "renderer must not retain an independent auto-wake owner");
});

test("T8 production posture command updates canonical posture and compatibility projection", () => {
  const h = loadMain();
  openDocument(h);
  h.context.__m1.startWalkingEngine({ silent: true });
  const sit = h.context.__m1.setBodyPosture({ seated: true }, { source: "test" });
  assert.equal(sit.posture, "seated");
  assert.equal(h.state.v2StateCore.posture.snapshot().posture.state, "seated");
  assert.equal(h.state.walk.seated, true);
  h.context.__m1.setBodyPosture({ seated: false }, { source: "test" });
  assert.equal(h.state.v2StateCore.posture.snapshot().posture.state, "standing");
  assert.equal(h.state.walk.seated, false);
  h.context.__m1.startFlight(300, -400);
  assert.equal(h.state.v2StateCore.posture.snapshot().posture.state, "airborne");
  h.context.__m1.setBodyAirborne(false, { source: "flight-land" });
  assert.equal(h.state.v2StateCore.posture.snapshot().posture.state, "standing");
  h.context.__m1.setBodyPosture({ perched: true, seated: false }, { source: "perch-admit" });
  assert.equal(h.state.v2StateCore.posture.snapshot().posture.state, "seated");
  h.context.__m1.setBodyPosture({ perched: false, gotoPerch: true }, { source: "perch-transition" });
  assert.equal(h.state.v2StateCore.posture.snapshot().posture.state, "transition");
  h.context.__m1.setBodyPosture({ gotoPerch: false }, { source: "perch-land" });
  h.state.walk.seated = true;
  h.context.__m1.walkBroadcast();
  assert.equal(h.state.v2StateCore.posture.snapshot().posture.state, "standing",
    "tampering with compatibility walk flags must not rewrite canonical posture");
});

test("T9 real renderer crash/reload/recreate advances lifecycle and rejects old callback", () => {
  const h = loadMain();
  const first = openDocument(h);
  const reload = h.handler("pet:reload-renderer");
  h.advance(60000);
  assert.equal(reload(h.event(), first.identity), true, "production reload handler must accept a ready reload request");
  const reloadFrame = first.win.webContents.mainFrame;
  first.win.webContents.__newDocument();
  const reloadedFrame = first.win.webContents.mainFrame;
  const reloaded = h.syncDocument();
  h.outcome(reloaded, { requestedMode: "spine", committedMode: "spine", ok: true });
  h.ready(reloaded, { owner: "spine", usable: true, committed: true });
  assert.ok(reloaded.bodyGeneration > first.identity.bodyGeneration);
  const oldWin = first.win;
  const oldFrame = oldWin.webContents.mainFrame;
  oldWin.__emitRenderer("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
  h.advance(3000);
  const recreated = h.createWindow();
  const current = h.syncDocument();
  h.outcome(current, { requestedMode: "spine", committedMode: "spine", ok: true });
  h.ready(current, { owner: "spine", usable: true, committed: true });
  assert.ok(current.bodyGeneration > reloaded.bodyGeneration || current.docEpoch > reloaded.docEpoch);
  const sleep = h.handler("pet:set-sleeping");
  sleep(eventFor(h, first.identity, oldWin.webContents, oldFrame), true, first.identity);
  assert.equal(h.state.walk.sleeping, false);
  assert.notEqual(recreated, oldWin, "crash recovery must exercise a recreated BrowserWindow");
  assert.notEqual(reloadFrame, reloadedFrame, "reload must advance the renderer mainFrame");
  oldWin.__emitWindow("closed");
  h.advance(60000);
  h.handler("pet:set-sleeping")(eventFor(h, current), true, current);
  assert.equal(h.state.walk.sleeping, true, "new window must still accept a positive current sleep request");
  assert.equal(h.state.win, recreated, "old close/crash callbacks must not null or replace the new window");
  const lifecycle = h.state.v2StateCore.lifecycle.current();
  assert.equal(lifecycle.docEpoch, current.docEpoch);
  assert.equal(lifecycle.bodyGeneration, current.bodyGeneration,
    "new window lifecycle identity must remain current after old-window close");
  assert.equal(h.state.v2StateCore.lifecycle.ready(), true,
    "new window body-ready state must remain ready after old-window close");
});

test("T10 native drag write is counted by WindowCommit and stale write is denied", () => {
  const h = loadMain();
  const { identity } = openDocument(h);
  const pause = h.handler("pet:walking-pause");
  const move = h.handler("pet:move");
  pause(eventFor(h, identity), true, "drag", "lease-commit", identity);
  const before = h.state.win.getBounds();
  move(eventFor(h, identity), 12, 0, "lease-commit", identity);
  assert.equal(h.state.win.getBounds().x, before.x + 12);
  const committed = h.state.v2Commit.stats.committed;
  assert.ok(committed >= 1);
  move(eventFor(h, identity, h.state.win.webContents, { routingId: 999 }), 12, 0, "lease-commit", identity);
  assert.equal(h.state.v2Commit.stats.committed, committed, "wrong frame must not commit native position");
});

test("T11 lifecycle protocol requires current sender and main frame", () => {
  const h = loadMain();
  const first = openDocument(h);
  const sync = h.handler("pet:body-document-sync");
  assert.equal(typeof sync, "function");
  const wrongSender = { id: 999, mainFrame: { routingId: 999 } };
  const rejected = (call) => {
    try {
      const result = call();
      assert.ok(result === undefined || result === null || result === false || (result && result.ok === false),
        "wrong sender/frame must be rejected by the production listener");
    } catch (error) {
      assert.match(String(error && error.message || error), /sender|frame|current|document|renderer/i);
    }
  };
  rejected(() => sync({ sender: wrongSender, senderFrame: wrongSender.mainFrame }));
  rejected(() => sync({ sender: first.win.webContents, senderFrame: { routingId: 999 } }));
  h.advance(60000);
  assert.equal(h.handler("pet:reload-renderer")(h.event(), first.identity), true);
  first.win.webContents.__newDocument();
  const next = h.syncDocument();
  h.outcome(next, { requestedMode: "spine", committedMode: "spine", ok: true });
  h.ready(next, { usable: false });
  assert.equal(h.state.v2StateCore.lifecycle.ready(), false, "failed visual owner must not mark lifecycle ready");
  h.ready(next, { committedMode: "gif", usable: true });
  assert.equal(h.state.v2StateCore.lifecycle.ready(), false, "wrong committed mode must remain rejected");
  h.ready(next, { committedMode: "spine", usable: true });
  assert.equal(h.state.v2StateCore.lifecycle.ready(), true, "current usable owner must become ready");
});

test("T12 fresh default composition has no Runtime V2 environment override", () => {
  const h = loadMain();
  for (const key of Object.keys(h.context.process.env)) assert.equal(key.startsWith("SUSSURRO_RUNTIME_V2_"), false);
  assert.equal(h.state.RUNTIME_V2_LOCOMOTION_ENABLED, true);
  const gated = loadMain({ env: { SUSSURRO_RUNTIME_V2_LOCOMOTION: "0" } });
  assert.equal(gated.state.RUNTIME_V2_LOCOMOTION_ENABLED, false,
    "explicit test env must reach the real production gate");
  const clean = loadMain();
  assert.equal(clean.state.RUNTIME_V2_LOCOMOTION_ENABLED, true,
    "temporary gate override must not leak into the next production composition");
});
