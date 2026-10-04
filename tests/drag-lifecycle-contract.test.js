"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");

const renderer = fs.readFileSync(require.resolve("../renderer/pet.js"), "utf8");
const main = fs.readFileSync(require.resolve("../main.js"), "utf8");
const dragStart = renderer.slice(renderer.indexOf("function onDragStart"), renderer.indexOf("// 右键宠物"));
const finish = renderer.slice(renderer.indexOf("function finishDrag"), renderer.indexOf("function onDragStart"));
const pause = main.slice(main.indexOf("function clearDragPause"), main.indexOf("function walkSpeed"));
const throwHandler = main.slice(main.indexOf('ipcMain.on("pet:throw"'), main.indexOf('ipcMain.on("pet:set-sleeping"'));

test("three drag surfaces start only through Pointer Events", () => {
  assert.match(renderer, /const dragSurfaces = \[petEl, rigCanvasEl, live2dCanvasEl\]/);
  assert.match(renderer, /surface\.addEventListener\("pointerdown", onDragStart\)/);
  assert.doesNotMatch(renderer, /petEl\.addEventListener\("mousedown", onDragStart\)/);
  assert.doesNotMatch(renderer, /rigCanvasEl\.addEventListener\("mousedown", onDragStart\)/);
  assert.doesNotMatch(renderer, /live2dCanvasEl\.addEventListener\("mousedown", onDragStart\)/);
});

test("drag session records the required pointer session fields", () => {
  assert.match(dragStart, /pointerId: e\.pointerId/);
  assert.match(dragStart, /sx: e\.screenX/);
  assert.match(dragStart, /sy: e\.screenY/);
  assert.match(dragStart, /moved: false/);
  assert.match(dragStart, /active: true/);
  assert.match(dragStart, /samples: \[\]/);
});

test("only primary left mouse pointers can start", () => {
  assert.match(dragStart, /e\.pointerType !== "mouse"/);
  assert.match(dragStart, /e\.isPrimary !== true/);
  assert.match(dragStart, /e\.button !== 0/);
});

test("a second pointer cannot take over an active session", () => {
  assert.match(dragStart, /if \(dragState \|\|/);
  assert.match(renderer, /if \(e\.pointerId !== dragState\.pointerId\) return;/);
});

test("capture is established before dragState is activated", () => {
  assert.ok(dragStart.indexOf("target.setPointerCapture(e.pointerId)") < dragStart.indexOf("dragState = state"));
  assert.match(dragStart, /typeof target\.setPointerCapture !== "function"/);
});

test("capture failure rolls back state, visuals, and capture", () => {
  assert.match(dragStart, /if \(dragState === state\) dragState = null/);
  assert.match(dragStart, /clearDragVisuals\(\)/);
  assert.match(dragStart, /releaseDragPointer\(\{ target, pointerId: e\.pointerId \}\)/);
});

test("finishDrag is idempotent and takes state before releasing capture", () => {
  assert.match(finish, /if \(!state \|\| !state\.active\) return false/);
  assert.ok(finish.indexOf("dragState = null") < finish.indexOf("releaseDragPointer(state)"));
  assert.match(finish, /state\.active = false/);
});

test("finishDrag clears drag visuals and recomputes click-through", () => {
  assert.match(finish, /clearDragVisuals\(\)/);
  assert.match(finish, /renderDragClickable\(\)/);
  assert.match(renderer, /petEl\.classList\.remove\("dragging", "pet-squash", "pet-squash-release"\)/);
});

test("normal pointerup is the only normal finish reason", () => {
  assert.match(renderer, /finishDrag\("pointerup"\)/);
  assert.match(finish, /if \(reason !== "pointerup"\)/);
  assert.match(finish, /window\.petAPI\.throwPet/);
  assert.match(finish, /toggleInputBar\(\)/);
});

test("pointerup coordinates are not added to throw samples", () => {
  assert.match(finish, /正常 pointerup 不把释放坐标额外加入 samples/);
  assert.ok(!/addDragSample\(state, e\)/.test(finish));
});

test("all abnormal lifecycle signals route to cancel", () => {
  assert.match(renderer, /finishDrag\("pointercancel"\)/);
  assert.match(renderer, /finishDrag\("blur"\)/);
  assert.match(renderer, /finishDrag\("visibilitychange"\)/);
  assert.match(renderer, /finishDrag\("pagehide"\)/);
  assert.match(renderer, /finishDrag\("lostpointercapture"\)/);
});

test("cancel resumes only drag pause and cannot invoke click or throw", () => {
  const cancelBranch = finish.slice(finish.indexOf('if (reason !== "pointerup")'), finish.indexOf("const wasDrag"));
  // State Core：只有真 admit 过的 drag（ended.wasDrag）才释放，且携带 interaction 身份（leaseId 匹配释放）
  assert.match(cancelBranch, /if \(ended\.wasDrag\) window\.petAPI\.walkingPause\(false, "drag", ended\.interactionId\);/);
  assert.doesNotMatch(cancelBranch, /throwPet|\.pat\(|toggleInputBar|playSpineInteract/);
});

test("buttons=0 cancels before sampling or moving the window", () => {
  const move = renderer.slice(renderer.indexOf('window.addEventListener("pointermove"'), renderer.indexOf('window.addEventListener("pointerup"'));
  assert.ok(move.indexOf("finishDrag(\"buttons\")") < move.indexOf("addDragSample(dragState, e)"));
  assert.ok(move.indexOf("finishDrag(\"buttons\")") < move.indexOf("moveWindow(step.dx, step.dy)"));
  assert.match(move, /if \(!\(e\.buttons & 1\)\)/);
});

test("pointermove and pointerup are restricted to the active pointerId", () => {
  assert.match(renderer, /if \(e\.pointerId !== dragState\.pointerId\) return;/);
  assert.match(renderer, /if \(dragState && e\.pointerId === dragState\.pointerId\) \{[\s\S]*?finishDrag\("pointerup"\)/);
});

test("lostpointercapture is a no-op after normal completion", () => {
  assert.match(renderer, /surface\.addEventListener\("lostpointercapture"/);
  assert.match(renderer, /if \(!dragState \|\| e\.currentTarget !== dragState\.target \|\| e\.pointerId !== dragState\.pointerId\) return;/);
  assert.ok(finish.indexOf("dragState = null") < finish.indexOf("releaseDragPointer(state)"));
});

test("main drag cleanup preserves chat and zoom pauses", () => {
  assert.match(pause, /const ownsPausedAt = !walk\.chatPaused && !walk\.zoomPaused/);
  assert.match(pause, /walk\.dragPaused = false/);
  assert.match(pause, /walk\.paused = walk\.chatPaused \|\| walk\.zoomPaused/);
  assert.doesNotMatch(pause, /walk\.paused = false/);
});

test("normal drag release uses the idempotent main cleanup helper", () => {
  const pauseHandler = main.slice(main.indexOf('ipcMain.on("pet:walking-pause"'), main.indexOf('ipcMain.on("pet:throw"'));
  assert.match(pauseHandler, /clearDragPause\("walking-pause", false\)/);
  assert.match(pauseHandler, /walk\.dragPaused = true/);
});

test("accepted and rejected throws both clear drag pause", () => {
  const flight = main.slice(main.indexOf("function startFlight"), main.indexOf("function walkFlightTick"));
  assert.match(flight, /clearDragPause\("throw-accepted", false\)/);
  assert.match(throwHandler, /clearDragPause\("throw-rejected"\)/);
});

test("renderer reload, crash, hide, close, and quit have fallback cleanup", () => {
  assert.match(main, /clearDragPause\("renderer-reload"\)/);
  assert.match(main, /clearDragPause\("renderer-crash"\)/);
  assert.match(main, /clearDragPause\("window-hide"\)/);
  assert.match(main, /clearDragPause\("window-close"\)/);
  assert.match(main, /clearDragPause\("app-quit"\)/);
});

test("the 60 second watchdog remains as the final insurance", () => {
  assert.match(main, /Date\.now\(\) - walk\.pausedAt > 60000/);
  assert.match(main, /clearDragPause\("watchdog"\)/);
});

test("drag lifecycle does not add a new preload API or drag IPC", () => {
  const preload = fs.readFileSync(require.resolve("../preload.js"), "utf8");
  assert.doesNotMatch(preload, /drag-cancel|drag-end/);
  assert.doesNotMatch(main, /ipcMain\.(on|handle)\(["']pet:drag-(cancel|end)/);
});

console.log("drag lifecycle contract 全部通过");
