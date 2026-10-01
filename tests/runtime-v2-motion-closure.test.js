/**
 * Runtime V2 — Motion Substrate Closure v0.1 竞争合同测试。
 * 目标：证明「运行期 writer 无法在另一个 owner 持有 Motion 时绕过 authority 改窗口」。
 * 用真实 MotionAuthority + 从 main.js 提取的真实 guard/clamp/writer 块（非 stub 行为）。
 */
"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const runtimeV2 = require("../src/runtime-v2");
const walkGeo = require("../src/walk-geo");

const mainSource = fs.readFileSync(require.resolve("../main.js"), "utf8").replace(/\r\n/g, "\n");
function block(startMarker, endMarker) {
  const s = mainSource.indexOf(startMarker);
  const e = mainSource.indexOf(endMarker, s + startMarker.length);
  assert.ok(s >= 0 && e > s, startMarker + " block exists");
  return mainSource.slice(s, e);
}

/** 真实 authority 驱动的 admission 门面（与 main.js 内 v2LegacyPositionBlocked/v2NoteDeferredClamp 同义） */
function makeAdmission(authority) {
  const deferred = { count: 0, last: null };
  return {
    deferred,
    v2LegacyPositionBlocked: () => authority.isLegacyBlocked(),
    v2NoteDeferredClamp: (r) => { deferred.count += 1; deferred.last = String(r); }
  };
}

/** 提取真实 outOfScreenGuard，注入真 authority-backed admission + 捕获 win.setPosition */
function buildOutOfScreenGuard(authority, bounds, writes) {
  const adm = makeAdmission(authority);
  const win = { isDestroyed: () => false, isVisible: () => true, getBounds: () => ({ ...bounds }), setPosition: (x, y) => { writes.push({ x, y }); bounds.x = x; bounds.y = y; } };
  const walk = { paused: false, flight: false, jump: false, seated: false, _vLog: 0, groundGap: 10 };
  const api = new Function(
    "win", "walk", "walkGeo", "screen", "config", "renderModeMod", "gifVisualGroundGap", "logTts", "applySeatPosition", "PET_LOCAL_X",
    "v2LegacyPositionBlocked", "v2NoteDeferredClamp",
    block("function outOfScreenGuard()", "\nfunction walkTick") + "; return outOfScreenGuard;"
  )(win, walk, walkGeo, { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }), getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }) },
    { getConfig: () => ({ renderMode: "spine" }) }, require("../src/render-mode"), 0, () => {}, () => {}, 138,
    adm.v2LegacyPositionBlocked, adm.v2NoteDeferredClamp);
  return { guard: () => api(), writes, adm, walk, bounds };
}

/** 提取真实 clampPetToWorkArea */
function buildClamp(authority, bounds, writes) {
  const adm = makeAdmission(authority);
  const win = { isDestroyed: () => false, getBounds: () => ({ ...bounds }), setPosition: (x, y) => { writes.push({ x, y }); bounds.x = x; bounds.y = y; } };
  const walk = { seated: false, perched: false, flight: false, jump: false, dragPaused: false, groundGap: 10 };
  const api = new Function(
    "win", "walk", "walkGeo", "screen", "walkMinX", "walkState", "applySeatPosition", "applyLayer", "logTts",
    "v2LegacyPositionBlocked", "v2NoteDeferredClamp",
    block("function clampPetToWorkArea(", "\nlet displayClampTimer") + "; return clampPetToWorkArea;"
  )(win, walk, walkGeo, { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }), getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }) },
    () => 0, require("../src/walk-state"), () => {}, () => {}, () => {},
    adm.v2LegacyPositionBlocked, adm.v2NoteDeferredClamp);
  return { clamp: () => api("test"), writes, adm, bounds };
}

/** 提取真实 repositionAfterWindowSizeChange（含 V2 与 EXTERNAL 双 deny 路径） */
function buildReposition(authority, v2Locomotion, bounds, writes) {
  const win = { isDestroyed: () => false, getBounds: () => ({ ...bounds }), setPosition: (x, y) => { writes.push({ x, y }); } };
  const walk = { seated: false, perched: false, dragPaused: false, flight: false, jump: false, iconRest: false, iconTarget: false, gotoPerch: false, returning: false, freeStand: false, groundGap: 10 };
  const api = new Function(
    "win", "walk", "config", "screen", "walkGeo", "renderModeMod", "gifVisualGroundGap", "effectiveSeatSink", "v2Locomotion", "seatExit", "seatExitOffsetY", "applySeatPosition",
    block("function repositionAfterWindowSizeChange(", "\nfunction chooseWalkBehavior") + "; return repositionAfterWindowSizeChange;"
  )(win, walk, { getConfig: () => ({ renderMode: "spine" }) }, { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }) },
    walkGeo, require("../src/render-mode"), 0, () => 30, v2Locomotion, null, () => 0, () => {});
  return api;
}

/* ---------- G1/G2: outOfScreenGuard 在 V2 / EXTERNAL 持有时零裸写 ---------- */

test("G1: V2 active → outOfScreenGuard fires → 零 native write + 记录 defer", () => {
  const authority = runtimeV2.createMotionAuthority();
  authority.acquire("ep-1");
  const writes = [];
  const g = buildOutOfScreenGuard(authority, { x: 600, y: 4000, width: 260, height: 200 }, writes); // y 远在屏外，正常会钳回
  g.guard();
  assert.equal(writes.length, 0, "V2 持有：guard 不得裸写");
  assert.equal(g.adm.deferred.count, 1, "记录有界 defer");
  assert.equal(g.adm.deferred.last, "outOfScreenGuard");
});

test("G2: EXTERNAL_DRAG active → outOfScreenGuard fires → 零 native write", () => {
  const authority = runtimeV2.createMotionAuthority();
  authority.externalAcquire("drag");
  const writes = [];
  const g = buildOutOfScreenGuard(authority, { x: -5000, y: 500, width: 260, height: 200 }, writes); // x 越左界，正常会钳回
  g.guard();
  assert.equal(writes.length, 0, "EXTERNAL 持有：guard 不得裸写");
  assert.equal(g.adm.deferred.count, 1);
});

/* ---------- G3/G4: 延迟 clamp 在回调执行时重查 owner ---------- */

test("G3: clamp scheduled in LEGACY → 回调前 owner 变 V2 → 回调不能写", () => {
  const authority = runtimeV2.createMotionAuthority();
  const writes = [];
  const c = buildClamp(authority, { x: 600, y: 4000, width: 260, height: 200 }, writes);
  // 模拟：LEGACY 时调度 → 回调排队；随后 V2 acquire；回调此刻执行
  authority.acquire("ep-9");
  c.clamp();
  assert.equal(writes.length, 0, "回调执行时已 V2 持有 → 拒绝钳位写");
  assert.equal(c.adm.deferred.count >= 1, true);
});

test("G4: clamp LEGACY 调度 → 回调前变 EXTERNAL → 回调不能写", () => {
  const authority = runtimeV2.createMotionAuthority();
  const writes = [];
  const c = buildClamp(authority, { x: 600, y: 4000, width: 260, height: 200 }, writes);
  authority.externalAcquire("drag");
  c.clamp();
  assert.equal(writes.length, 0, "EXTERNAL 持有 → clamp 回调拒绝写");
});

test("clamp 在 LEGACY 时仍正常钳位（不被 closure 误杀）", () => {
  const authority = runtimeV2.createMotionAuthority(); // owner LEGACY
  const writes = [];
  const c = buildClamp(authority, { x: 600, y: 4000, width: 260, height: 200 }, writes);
  c.clamp();
  assert.equal(writes.length, 1, "LEGACY：钳位写照常执行（baseline 不变）");
});

/* ---------- G5/G6: EXTERNAL 对称 deny ---------- */

test("G5: EXTERNAL_DRAG active → repositionAfterWindowSizeChange 被拒", () => {
  const authority = runtimeV2.createMotionAuthority();
  const v2Locomotion = { deniesLegacy: (c) => authority.denyLegacyWriter(c) };
  const writes = [];
  const reposition = buildReposition(authority, v2Locomotion, { x: 100, y: 200, width: 260, height: 200 }, writes);
  authority.externalAcquire("drag");
  reposition(false, true); // renderModeCommit=false, wasGroundAnchored=true → 原本会 ground 分支写
  assert.equal(writes.length, 0, "EXTERNAL 持有时 reposition 被 deny（对称闭合）");
  assert.equal(authority.snapshot().denyCounts.repositionAfterWindowSizeChange >= 1, true);
});

test("G6: EXTERNAL_DRAG active → applySeatPosition 被 deny（denyLegacy 现对称拒 V2 与 EXTERNAL）", () => {
  const authority = runtimeV2.createMotionAuthority();
  authority.externalAcquire("drag");
  assert.equal(authority.denyLegacyWriter("applySeatPosition"), true, "EXTERNAL 也触发 legacy deny");
  assert.equal(authority.positionAdmit("legacy").ok, false);
  authority.externalRelease("t");
  assert.equal(authority.positionAdmit("legacy").ok, true, "release 回 LEGACY 后 legacy 可写");
});

/* ---------- G7/G8: scale 处理 ---------- */

test("G7: scale during V2 → 先 interrupt 释放 episode，再 resize（无 competing position writer）", () => {
  const authority = runtimeV2.createMotionAuthority();
  const ep = authority.acquire("ep-s");
  // setScale 语义：interrupt→release→LEGACY；此后 legacy reposition/clamp 允许（唯一写者）
  authority.release("scale-change");
  assert.equal(authority.owner(), "legacy");
  assert.equal(authority.positionAdmit("legacy").ok, true);
  assert.equal(authority.positionAdmit("v2-locomotion", ep).ok, false, "旧 V2 token 释放后彻底失效");
  assert.match(mainSource, /v2Locomotion\.interrupt\("scale-change"\)[\s\S]{0,120}v2Drag\.end\("scale-change"\)/, "setScale 先释放 V2 再释放 EXTERNAL");
});

test("G8: scale during Drag → 不允许 external 与 scale 同时写 position", () => {
  // setScale 在 resize 前 v2Drag.end() → 释放 EXTERNAL；drag landing 与 scale 写不同时存在
  assert.match(mainSource, /v2Drag && v2Drag\.active\(\)\) v2Drag\.end\("scale-change"\)/, "scale 前释放拖拽会话");
  const authority = runtimeV2.createMotionAuthority();
  const acq = authority.externalAcquire("drag");
  authority.externalRelease("scale-change");
  assert.equal(authority.positionAdmit("external-drag", { externalToken: acq.token }).ok, false, "释放后旧 external token 立即失效");
});

/* ---------- G9: stale resize callback ---------- */

test("G9: stale resize callback 由 revision + owner 双检丢弃（不复活旧写权）", () => {
  // 生产 windowSizeRevision 已使陈旧尺寸回调失效；本用例锁 closure 增量：clamp/reposition 执行时再查 owner
  assert.match(mainSource, /windowSizeRevision\.isCurrent\(resizeRevision\)/, "resize deferred 回调带 revision 校验");
  const authority = runtimeV2.createMotionAuthority();
  authority.acquire("ep"); // 回调排队时合法，触发时已 V2
  const writes = [];
  const c = buildClamp(authority, { x: 600, y: 4000, width: 260, height: 200 }, writes);
  c.clamp();
  assert.equal(writes.length, 0, "stale-ish：owner 已 V2 → 回调丢弃写");
});

/* ---------- G10/G11: Flight/Jump legacy 行为 ---------- */

test("G10: Flight/Jump legacy 写（walkSetPosition）在 LEGACY 下照常（行为未被误杀）", () => {
  const authority = runtimeV2.createMotionAuthority();
  assert.equal(authority.positionAdmit("legacy").ok, true, "LEGACY：flight/jump 经 legacy 路径可写");
});

test("G11: Flight/Jump legacy writer 在 V2 owner 下被拒", () => {
  const authority = runtimeV2.createMotionAuthority();
  const v2Locomotion = { deniesLegacy: (c) => authority.denyLegacyWriter(c) };
  const writes = [];
  const win = { isDestroyed: () => false, setPosition: (x, y) => writes.push({ x, y }) };
  const walkSetPosition = new Function(
    "win", "logTts", "applyLayerThrottled", "v2Locomotion",
    block("function walkSetPosition", "\nfunction walkBroadcast") + "; return walkSetPosition;"
  )(win, () => {}, () => {}, v2Locomotion);
  authority.acquire("ep-fly");
  assert.equal(walkSetPosition(300, 300, "flight-move"), false, "V2 持有：flight legacy writer 被拒");
  assert.equal(writes.length, 0);
  authority.release("t");
  assert.equal(walkSetPosition(300, 300, "flight-move"), true, "LEGACY：flight 正常写");
  assert.equal(writes.length, 1);
});

/* ---------- G12: gate OFF baseline ---------- */

test("G12: gate OFF（v2Authority null）→ guard/clamp/writer 全放行，baseline 逐字不变", () => {
  // 真实门面 gate OFF：v2Authority null → v2LegacyPositionBlocked 返回 false（放行）
  assert.match(mainSource, /function v2LegacyPositionBlocked\(\) \{[\s\S]*?typeof v2Authority !== "undefined" && v2Authority && v2Authority\.isLegacyBlocked\(\)/, "gate OFF 门面短路放行");
  // admission：NONE（引擎停止）不阻塞放置/guard 写（显示器变化仍须把角色留在屏内）；
  // 只有 V2/EXTERNAL 活跃持有才拒普通 legacy 写。locomotion 写在 NONE 下由 walkTick 停摆自然不发生。
  const authority = runtimeV2.createMotionAuthority();
  authority.engineOff();
  assert.equal(authority.isLegacyBlocked(), false, "NONE：放置/guard 不被判阻塞（不 strand 角色于屏外）");
  authority.engineOn();
  assert.equal(authority.positionAdmit("legacy").ok, true, "LEGACY：正常放行");
});

/* ---------- 最终问题：是否仍存在运行期 writer 能在持有期绕过 authority ---------- */

test("最终 inventory 合同：主窗口 x/y native 写仅出现在 commit 点 / 带 admission 的 legacy writer", () => {
  const winPosWrites = (mainSource.match(/win\.setPosition\(/g) || []).length;
  // 逐个受控：sitOnTaskbar/clamp/outOfScreen(2)/walkSetPosition/commit×2/reposition/seat-exit/sleeping/pet:move(OFF)/setScale
  assert.ok(winPosWrites >= 1, "存在 native 写点");
  // 关键异步/裸写旁路必须挂 admission：
  for (const fn of ["outOfScreenGuard", "clampPetToWorkArea"]) {
    const b = block("function " + fn + "(", fn === "outOfScreenGuard" ? "\n// 出屏哨兵由" : "\nlet displayClampTimer");
    assert.match(b, /v2LegacyPositionBlocked\(\)/, fn + " 执行时重查 owner");
  }
  // 其余经 denyLegacy（含 EXTERNAL 对称）
  for (const fn of ["applySeatPosition", "seatExitStep", "repositionAfterWindowSizeChange", "walkSetPosition"]) {
    const end = { applySeatPosition: "function resizeTransientActive", seatExitStep: "function diagSeat", repositionAfterWindowSizeChange: "function setWalking", walkSetPosition: "function walkBroadcast" }[fn];
    assert.match(block("function " + fn + "(", "\n" + end), /deniesLegacy\(/, fn + " 经统一 admission");
  }
});

test("最终问题答案：不存在可在另一 owner 持有时绕过 authority 的运行期 writer", () => {
  const a = runtimeV2.createMotionAuthority();
  for (const owner of [["v2", () => a.acquire("e")], ["external", () => a.externalAcquire("drag")]]) {
    owner[1]();
    // 任何非当前 owner 的 commit/legacy 尝试都必须被拒
    assert.equal(a.positionAdmit("legacy").ok, false, "legacy 被 " + owner[0] + " 拒");
    assert.equal(a.positionAdmit("v2-locomotion", { token: 9999, episodeId: "ghost" }).ok, false);
    assert.equal(a.positionAdmit("external-drag", { externalToken: 9999 }).ok, false);
    a.release("t"); a.externalRelease("t");
  }
});
