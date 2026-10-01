/**
 * Runtime V2 — Interaction/Pause admission 修正：tap-vs-drag admission 合同。
 * 根因（实机 trace 确认）：pointerdown 提前 walkingPause(true,"drag")/EXTERNAL_DRAG，
 * 把轻点/摸头错误套进 drag 生命周期 → renderer-local Q-bounce 被 seatEpisode 拒绝。
 * 修复：drag admission 后移到 pointermove 位移阈值；pointerup 未过阈值按 tap/headpat 处理。
 * 本文件证明：tap 不进入 EXTERNAL_DRAG；true drag 才进入；Q-bounce 在 tap 路径恢复；
 * drag handoff / motion closure 语义不退步。
 */
"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");

const runtimeV2 = require("../src/runtime-v2");
const petSource = fs.readFileSync(require.resolve("../renderer/pet.js"), "utf8").replace(/\r\n/g, "\n");

function block(startMarker, endMarker) {
  const s = petSource.indexOf(startMarker);
  const e = petSource.indexOf(endMarker, s + startMarker.length);
  assert.ok(s >= 0 && e > s, startMarker + " block exists");
  return petSource.slice(s, e);
}

/* ---------- renderer 源合同：admission 后移 ---------- */

test("T1: pointerdown（onDragStart）只进入 pending/candidate——不再提前 walkingPause(true,'drag')", () => {
  const b = block("function onDragStart(e) {", "const rigCanvasEl");
  assert.doesNotMatch(b, /window\.petAPI\.walkingPause\(true/, "pointerdown 不得调用 drag admission（注释提及不算调用）");
  assert.match(b, /dragAdmitted: false/, "候选态：dragAdmitted=false");
  assert.match(b, /Interaction\/Pause admission/, "修正点有明确标记");
  // press 视觉/wake 等 body-local 反馈保持不变
  assert.match(b, /petEl\.classList\.add\("pet-squash"\)/);
  assert.match(b, /wake\(\);/);
});

test("T2: 真 drag 的 admission 在 pointermove 位移阈值处，且先于首个 moveWindow（EXTERNAL 先就位再 commit）", () => {
  const b = block('window.addEventListener("pointermove"', 'window.addEventListener("pointerup"');
  assert.match(b, /if \(!dragState\.dragAdmitted\) \{[^\n]*\n\s*dragState\.dragAdmitted = true;\s*window\.petAPI\.walkingPause\(true, "drag"\);/);
  const admitAt = b.indexOf('window.petAPI.walkingPause(true, "drag")');
  const moveAt = b.indexOf("window.petAPI.moveWindow(");
  assert.ok(admitAt >= 0 && moveAt > admitAt, "admission 先于首个 pet:move（同源 IPC 有序 → EXTERNAL 先就位）");
  assert.match(b, /Math\.abs\(dx\) > 3 \|\| Math\.abs\(dy\) > 3/, "位移阈值=现行为（3px，不改手感）");
});

test("T3: finishDrag 异常取消只在真 admit 过时才释放（tap 取消不触碰 ownership）", () => {
  const b = block("function finishDrag(", "function onDragStart");
  const cancelRegion = b.slice(b.indexOf('if (reason !== "pointerup")'), b.indexOf("const wasDrag"));
  assert.match(cancelRegion, /if \(state\.dragAdmitted\) window\.petAPI\.walkingPause\(false, "drag"\);/);
});

test("T4: tap/headpat 路径（!wasDrag）恢复 Q-bounce 触发，且不直接释放 drag（从不 admit）", () => {
  const b = block("function finishDrag(", "function onDragStart");
  const tapRegion = b.slice(b.indexOf("if (!wasDrag) {"), b.indexOf("} else if (velocity"));
  assert.match(tapRegion, /headPatSquash\(\);/, "Q-bounce 触发仍在 tap 路径");
  assert.doesNotMatch(tapRegion, /walkingPause\(false, "drag"\)/, "tap 从未 admit → 无需/不得释放 drag");
  // pokeResumeTimer("interact") 保留（无 admit 时为无害 no-op）
  assert.match(b, /walkingPause\(false, "interact"\)/);
});

test("T5: 真 drag 的松手/抛掷释放路径保持原样（admitted ⇒ wasDrag，释放配对完整）", () => {
  const b = block("function finishDrag(", "function onDragStart");
  assert.match(b, /const wasDrag = state\.moved;/, "wasDrag=位移阈值判定（与 admission 同一 crossing）");
  assert.match(b, /window\.petAPI\.throwPet\(/, "throw 路径不变");
  const releaseBranches = (b.match(/window\.petAPI\.walkingPause\(false, "drag"\);/g) || []).length;
  assert.equal(releaseBranches, 3, "throw-fail + 正常松手两处无条件释放保留；第三处为 cancel 路径（已由 T3 证明受 dragAdmitted 门控）");
});

/* ---------- 行为链：真实 authority/drag-session/commit 上的 tap-vs-drag ---------- */

function makeRuntime() {
  const authority = runtimeV2.createMotionAuthority();
  const writes = [];
  const commit = runtimeV2.createWindowCommit({
    authority,
    writePosition: () => {}, writePositionExternal: (x, y) => writes.push({ x, y }),
    readRect: () => ({ x: 0, y: 0, width: 260, height: 200 }),
    notifyWrite: () => {}
  });
  const drag = runtimeV2.createDragSession({
    authority, commit, deps: { now: () => 0, currentRect: () => ({ x: 0, y: 0, width: 260, height: 200 }) }
  });
  return { authority, commit, drag, writes };
}

test("B1: tap——从不 begin → EXTERNAL_DRAG 不进入；commitExternal 全拒；release 为 no-op；owner 恒 LEGACY", () => {
  const r = makeRuntime();
  // renderer tap 序列：pointerdown（pending，无 IPC）→ pointerup（!wasDrag，无 release IPC）
  assert.equal(r.drag.active(), false);
  assert.equal(r.drag.end("interact").noop, true, "未 admit 时 interact 释放是 no-op");
  assert.equal(r.commit.commitExternal({ externalToken: 1, kind: "drag-move", x: 5, y: 5 }).ok, false, "无会话：迟到/无主 commit 拒绝");
  assert.equal(r.authority.owner(), "legacy", "tap 全程不进入 EXTERNAL_DRAG");
  assert.equal(r.authority.isLegacyBlocked(), false, "ownership 未被占用 → body-local 反馈（Q-bounce）不被 motion 门挡");
  assert.equal(r.writes.length, 0);
});

test("B2: true drag——阈值后 begin → EXTERNAL_DRAG current → commitExternal 可写 → release 回 LEGACY（handoff 不退步）", () => {
  const r = makeRuntime();
  const b = r.drag.begin("drag", { docEpoch: 5, senderId: 7 });
  assert.equal(b.ok, true);
  assert.equal(r.authority.owner(), "external-drag");
  assert.equal(r.commit.commitExternal({ externalToken: b.token, kind: "drag-move", x: 10, y: 20 }).ok, true);
  assert.equal(r.drag.end("drag-cleanup").ok, true);
  assert.equal(r.authority.owner(), "legacy", "release 回 LEGACY（下一次行为选择可再进 V2）");
  assert.equal(r.commit.commitExternal({ externalToken: b.token, kind: "drag-move", x: 30, y: 40 }).ok, false, "release 后旧 token 失效");
});

test("B3: 多次 tap 不泄漏会话/不卡死 ownership（可反复正常 pat）", () => {
  const r = makeRuntime();
  for (let i = 0; i < 10; i++) {
    assert.equal(r.drag.active(), false);
    assert.equal(r.drag.end("interact").noop, true);
    assert.equal(r.authority.owner(), "legacy");
  }
  // 之后 true drag 仍正常建立
  assert.equal(r.drag.begin("drag", { docEpoch: 5 }).ok, true);
  assert.equal(r.authority.owner(), "external-drag");
});

test("B4: Motion Closure 语义不退步——V2 持有时 external 不得直接抢占；EXTERNAL 持有时 legacy 全拒", () => {
  const a = runtimeV2.createMotionAuthority();
  a.acquire("ep-1");
  assert.equal(a.externalAcquire("drag").ok, false, "V2 未释放 → external 不得抢占（交接顺序保持）");
  a.release("interrupt");
  assert.equal(a.externalAcquire("drag").ok, true);
  assert.equal(a.denyLegacyWriter("walkSetPosition:walkTick"), true, "EXTERNAL 持有时 legacy writer 仍被拒（对称闭合保持）");
  assert.equal(a.positionAdmit("legacy").ok, false);
  a.externalRelease("t");
  assert.equal(a.positionAdmit("legacy").ok, true);
});
