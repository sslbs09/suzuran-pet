/**
 * Runtime V2 — State Core Cutover v0.1 状态所有权合同测试。
 * PAUSE：lease 语义（acquire/release/revoke/revokeByDomain/effectivePaused derived）。
 * INTERACTION：candidate → threshold → admitted drag / tap；reload 失效；admit 顺序=先 pause 后 motion。
 * POSTURE/SUPPORT：语义 posture 与 support 证据分离；scale/resize 使证据过期而非伪造。
 * LIFECYCLE：reload 保留 canonical 语义态、失效 renderer-owned transient、旧纪元事件被拒。
 * COMPAT：gate OFF legacy 路径逐字保留；Motion Closure 测试不退步（由全量套件保证）。
 */
"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");

const stateCore = require("../src/state-core");
const runtimeV2 = require("../src/runtime-v2");
const walkGeo = require("../src/walk-geo");

const mainSource = fs.readFileSync(require.resolve("../main.js"), "utf8").replace(/\r\n/g, "\n");
const petSource = fs.readFileSync(require.resolve("../renderer/pet.js"), "utf8").replace(/\r\n/g, "\n");
const preloadSource = fs.readFileSync(require.resolve("../preload.js"), "utf8").replace(/\r\n/g, "\n");

/* ---------------- PAUSE 1-6 ---------------- */

test("PAUSE-1: drag acquire/release 配对（effectivePaused derived 正确）", () => {
  const a = stateCore.createPauseAuthority();
  assert.equal(a.effectivePaused(), false, "初始无 pause");
  const l = a.acquire("drag", { leaseId: "drag-1", domain: "renderer" });
  assert.equal(l.ok, true);
  assert.equal(a.effectivePaused(), true, "lease 持有 → paused");
  assert.equal(a.isPaused("drag"), true);
  const r = a.release("drag", { leaseId: "drag-1" });
  assert.equal(r.ok, true);
  assert.equal(a.effectivePaused(), false, "释放 → 未 paused");
});

test("PAUSE-2: chat + drag overlap——两个 lease 并存，任一持有即 paused", () => {
  const a = stateCore.createPauseAuthority();
  a.acquire("chat", { leaseId: "chat-1", domain: "main" });
  assert.equal(a.effectivePaused(), true);
  const d = a.acquire("drag", { leaseId: "drag-1", domain: "renderer" });
  assert.equal(a.activeSources().length, 2);
  a.release("chat", { leaseId: "chat-1" });
  assert.equal(a.effectivePaused(), true, "drag 仍持有 → 仍 paused");
  a.release("drag", { leaseId: d.leaseId });
  assert.equal(a.effectivePaused(), false);
});

test("PAUSE-3: release drag 不清 chat（source 隔离）", () => {
  const a = stateCore.createPauseAuthority();
  a.acquire("chat", { leaseId: "chat-1", domain: "main" });
  a.acquire("drag", { leaseId: "drag-1", domain: "renderer" });
  a.release("drag", { leaseId: "drag-1" });
  assert.equal(a.isPaused("chat"), true, "chat lease 不受 drag release 影响");
  assert.equal(a.isPaused("drag"), false);
});

test("PAUSE-4: stale leaseId 不能 release 新 lease；同 source 重复 acquire 换发新 token", () => {
  const a = stateCore.createPauseAuthority();
  const first = a.acquire("drag", { leaseId: "old-interaction", domain: "renderer" });
  a.release("drag", { leaseId: "old-interaction" });
  const second = a.acquire("drag", { leaseId: "new-interaction", domain: "renderer" });
  assert.ok(second.token > first.token, "token 单调");
  // 旧身份尝试 release 新 lease
  const stale = a.release("drag", { leaseId: "old-interaction" });
  assert.equal(stale.ok, false, "旧 leaseId 拒绝");
  assert.equal(stale.reason, "lease-id-mismatch");
  assert.equal(a.isPaused("drag"), true, "新 lease 不被旧回调清掉");
  // 同 source 再 acquire：换发新 token，旧 leaseId 失效（防同来源旧 callback 清新 pause）
  const third = a.acquire("drag", { leaseId: "newer-interaction", domain: "renderer" });
  assert.equal(third.refreshed, true);
  assert.equal(a.release("drag", { leaseId: "new-interaction" }).ok, false, "refresh 后旧 leaseId 失效");
  assert.equal(a.release("drag", { leaseId: "newer-interaction" }).ok, true);
});

test("PAUSE-5: renderer reload → revokeByDomain('renderer') 只吊销 renderer-owned lease（chat/main 保留）", () => {
  const a = stateCore.createPauseAuthority();
  a.acquire("drag", { leaseId: "d1", domain: "renderer" });
  a.acquire("interaction", { leaseId: "i1", domain: "renderer" });
  a.acquire("chat", { leaseId: "c1", domain: "main" });
  const r = a.revokeByDomain("renderer", "renderer-reload");
  assert.deepEqual(r.revoked.sort(), ["drag", "interaction"]);
  assert.equal(a.isPaused("chat"), true, "main-owned chat 保留");
  assert.equal(a.isPaused("drag"), false);
  assert.equal(a.isPaused("interaction"), false);
});

test("PAUSE-6: effectivePaused 是 derived state——revoke/main 权威路径同样驱动它", () => {
  const a = stateCore.createPauseAuthority();
  a.acquire("zoom", { leaseId: "z1", domain: "renderer" });
  assert.equal(a.effectivePaused(), true);
  a.revoke("zoom", "watchdog");
  assert.equal(a.effectivePaused(), false, "revoke（main 权威）同样驱动 derived state");
  // 匿名配对（leaseId 双 null）允许 release——fallback shim 路径
  a.acquire("drag", { leaseId: null, domain: "renderer" });
  assert.equal(a.release("drag", { leaseId: null }).ok, true);
});

/* ---------------- INTERACTION 7-12 ---------------- */

function makeInteractionChain() {
  // 组合层：InteractionState 的 admit/end 钩子按「先 Pause lease 后 Motion token」顺序执行
  const authority = runtimeV2.createMotionAuthority();
  const pause = stateCore.createPauseAuthority();
  const order = [];
  const interaction = stateCore.createInteractionState({
    threshold: 3,
    now: () => 1000,
    onAdmit(ev) {
      pause.acquire("drag", { leaseId: ev.interactionId, domain: "renderer", now: 1000 });
      order.push("pause:acquire");
      const m = authority.externalAcquire("drag");
      order.push("motion:" + (m.ok ? "acquire" : "denied"));
    },
    onEnd(ev) {
      if (ev.kind === "drag") {
        pause.release("drag", { leaseId: ev.interactionId });
        order.push("pause:release");
      }
    }
  });
  return { authority, pause, interaction, order };
}

test("INT-7: pointerdown 只创建 candidate——零 admission、零 Motion/Pause 获取", () => {
  const c = makeInteractionChain();
  const b = c.interaction.begin({ pointerId: 1, x: 600, y: 500 });
  assert.equal(b.ok, true);
  assert.equal(c.interaction.snapshot().admitted, false);
  assert.equal(c.pause.effectivePaused(), false, "candidate 不产生 pause lease");
  assert.equal(c.authority.owner(), "legacy", "candidate 不产生 Motion ownership");
});

test("INT-8: <3px tap never becomes drag——end 返回 tap，不 acquire Motion/Pause", () => {
  const c = makeInteractionChain();
  c.interaction.begin({ pointerId: 1, x: 600, y: 500 });
  c.interaction.move(602, 501); // 位移 ≤ 阈值
  const e = c.interaction.end();
  assert.equal(e.wasDrag, false);
  assert.equal(e.kind, "tap");
  assert.equal(e.interactionId, null, "tap 无 interaction 身份（不进 Motion/Pause）");
  assert.equal(c.authority.owner(), "legacy");
  assert.equal(c.pause.effectivePaused(), false);
});

test("INT-9: >3px admits drag exactly once（第二次 crossing 不重复 admit）", () => {
  const c = makeInteractionChain();
  c.interaction.begin({ pointerId: 1, x: 600, y: 500 });
  const s1 = c.interaction.move(700, 500);
  assert.equal(s1.crossed, true);
  assert.equal(s1.justAdmitted, true);
  const id = s1.interactionId;
  const s2 = c.interaction.move(702, 500); // 同会话内小位移
  assert.equal(s2.crossed, false);
  const s3 = c.interaction.move(900, 500); // 再次大位移
  assert.equal(s3.crossed, true);
  assert.equal(s3.justAdmitted, false, "admit 恰好一次");
  assert.equal(s3.interactionId, id, "会话身份不变");
});

test("INT-10: invalidate（renderer reload）后旧 candidate 事件全部失效", () => {
  const c = makeInteractionChain();
  c.interaction.begin({ pointerId: 1, x: 600, y: 500 });
  const inv = c.interaction.invalidate("renderer-reload");
  assert.equal(inv.ok, true);
  assert.equal(c.interaction.move(900, 500).crossed, false, "旧 candidate 的 move 失效");
  assert.equal(c.interaction.end().noop, true);
});

test("INT-11: drag admission 顺序合同——先 Pause lease 后 Motion token（同链真实模块）", () => {
  const c = makeInteractionChain();
  c.interaction.begin({ pointerId: 1, x: 600, y: 500 });
  const s = c.interaction.move(700, 500); // crossing → onAdmit
  assert.equal(s.justAdmitted !== undefined, true);
  assert.deepEqual(c.order, ["pause:acquire", "motion:acquire"], "admit 顺序=先 pause 后 motion");
  assert.equal(c.authority.owner(), "external-drag");
  assert.equal(c.pause.leaseOf("drag").leaseId, s.interactionId, "pause lease 以 interactionId 为身份");
});

test("INT-12: tap 路径 never acquires Motion（owner 恒 LEGACY）", () => {
  const c = makeInteractionChain();
  c.interaction.begin({ pointerId: 1, x: 600, y: 500 });
  c.interaction.move(601, 501);
  c.interaction.end();
  assert.equal(c.authority.owner(), "legacy");
  assert.equal(c.order.some((o) => String(o).startsWith("motion:")), false);
});

/* ---------------- POSTURE/SUPPORT 13-16 ---------------- */

test("POST-13: seated 语义独立于 support validity（posture=seated 可与 support stale 并存）", () => {
  const ps = stateCore.createPostureSupport();
  ps.setPosture("seated");
  ps.markSupport("taskbar", { valid: true, anchorStatus: "anchored" });
  assert.equal(ps.isSupportValid(), true);
  const inv = ps.invalidateSupport("scale");
  assert.equal(inv.posture, "seated", "语义 posture 保持 seated");
  assert.equal(ps.support().anchorStatus, "stale", "support 诚实过期");
  assert.equal(ps.isSupportValid(), false);
});

test("POST-14: resize/scale invalidate 的是 support 证据，不是 semantic posture", () => {
  const ps = stateCore.createPostureSupport();
  ps.setPosture("seated");
  const before = ps.posture();
  ps.invalidateSupport("resize");
  assert.equal(ps.posture(), before, "semantic posture 不因 geometry 失效而改变");
  const gen0 = ps.snapshot().support.generation;
  ps.refreshSupportEvidence({ generation: 7 });
  assert.equal(ps.snapshot().support.generation, 7, "evidence 世代由新几何证据推进");
  assert.equal(ps.isSupportValid(), false, "世代推进 ≠ 自动 valid（不谎称已正确落位）");
  ps.markSupport("taskbar", { valid: true, anchorStatus: "anchored", generation: 7 });
  assert.equal(ps.isSupportValid(), true, "重新声明支撑后才恢复 valid");
});

test("POST-15: stale geometry 不能 validate 新 support（必须显式 markSupport）", () => {
  const ps = stateCore.createPostureSupport();
  ps.setPosture("seated");
  ps.invalidateSupport("scale");
  // refreshSupportEvidence 只推进世代，不翻转 valid
  ps.refreshSupportEvidence({});
  assert.equal(ps.support().valid, false);
  assert.equal(ps.isSupportValid(), false, "除非显式 markSupport，否则 stale 不能 self-heal");
});

test("POST-16: airborne 与 valid seated support 语义互斥（模块内强制）", () => {
  const ps = stateCore.createPostureSupport();
  ps.setPosture("seated");
  ps.markSupport("taskbar", { valid: true });
  ps.setPosture("airborne");
  assert.equal(ps.support().kind, "none", "airborne 时 seated 支撑自动失效");
  assert.equal(ps.isSupportValid(), false);
  // airborne 期间声明支撑也被拒
  ps.markSupport("taskbar", { valid: true });
  assert.equal(ps.support().valid, false);
});

test("POST-adapter: observeWalk 单向派生 posture/kind（LEGACY → CANONICAL），不回写 walk", () => {
  const ps = stateCore.createPostureSupport();
  const walk = { seated: true, perched: false, flight: false, jump: false, gotoPerch: false, returning: false, iconTarget: false, freeStand: false, iconRest: false };
  const r = ps.observeWalk(walk, { now: 1 });
  assert.equal(r.posture, "seated");
  assert.equal(r.kind, "taskbar");
  assert.equal(ps.posture(), "seated");
  // walk 字段变化 → posture 跟随（adapter 方向）
  walk.seated = false;
  walk.flight = true;
  ps.observeWalk(walk);
  assert.equal(ps.posture(), "airborne");
  assert.equal(ps.support().kind, "none");
});

/* ---------------- LIFECYCLE 17-19 ---------------- */

test("LIFE-17: reload 保留 canonical semantic posture（只失效 support/transient）", () => {
  const ps = stateCore.createPostureSupport();
  const lc = stateCore.createLifecycleProjection();
  ps.setPosture("seated");
  ps.markSupport("taskbar", { valid: true });
  // reload 级联（与 main 接线同序）：invalidate lifecycle → revoke renderer pause → invalidate support
  lc.invalidate("renderer-reload", "pet:reload-renderer");
  ps.invalidateSupport("reload");
  assert.equal(ps.posture(), "seated", "canonical semantic posture 保留");
  assert.equal(ps.support().valid, false, "support 证据失效");
});

test("LIFE-18: renderer-local interaction/session 随 reload 失效（不 durable resume）", () => {
  const c = makeInteractionChain();
  c.interaction.begin({ pointerId: 1, x: 600, y: 500 });
  c.interaction.move(700, 500); // admitted drag（pause lease + motion token 均已获取）
  assert.equal(c.authority.owner(), "external-drag");
  // reload 级联（与 main 接线同序）：① Motion EXTERNAL 释放（clearDragPause → v2Drag.end → externalRelease）
  c.authority.externalRelease("renderer-reload");
  // ② PauseAuthority revokeByDomain("renderer") ③ interaction candidate invalidate
  c.pause.revokeByDomain("renderer", "renderer-reload");
  const inv = c.interaction.invalidate("renderer-reload");
  assert.equal(inv.ok, true);
  assert.equal(inv.invalidated.admitted, true);
  assert.equal(c.authority.owner(), "legacy", "全部 renderer-owned 权利已释放");
  assert.equal(c.interaction.end().noop, true, "旧会话 end 无效");
  assert.equal(c.interaction.move(900, 500).crossed, false, "旧 candidate 的 move 失效");
  assert.equal(c.pause.effectivePaused(), false);
});

test("LIFE-19: 旧文档纪元事件被 isCurrent 拒绝；代际只前进不回卷", () => {
  const lc = stateCore.createLifecycleProjection();
  assert.equal(lc.begin({ docEpoch: 5, bodyGeneration: 3 }).changed, true);
  assert.equal(lc.isCurrent(5), true);
  assert.equal(lc.isCurrent(4), false, "旧纪元事件拒绝");
  assert.equal(lc.isCurrent(6), true, "新纪元事件接受");
  assert.equal(lc.begin({ docEpoch: 4 }).stale, true, "代际不回卷");
  assert.equal(lc.current().docEpoch, 5);
  assert.equal(lc.begin({ docEpoch: 6 }).changed, true);
});

/* ---------------- COMPAT 20-22 ---------------- */

test("COMPAT-20/22: gate OFF——State Core 不存在，legacy pause 字段即 canonical（源码合同）", () => {
  assert.match(mainSource, /const v2StateCore = RUNTIME_V2_LOCOMOTION_ENABLED \? \(\(\) => \{/);
  assert.match(mainSource, /\}\)\(\) : null;\n\nfunction cancelFlight/, "gate OFF：v2StateCore=null（门位内联三元走 legacy compute）");
  // CANON 三元 = v2StateCore ? effectivePaused() : 三布尔——gate OFF 分支与 V1 逐字等价
  const canonTernary = /\(typeof v2StateCore !== "undefined" && v2StateCore \? v2StateCore\.pause\.effectivePaused\(\) : \(walk\.dragPaused \|\| walk\.chatPaused \|\| walk\.zoomPaused\)\)/g;
  assert.ok((mainSource.match(canonTernary) || []).length >= 4, "主门位全部经 CANON 三元（>=4 处）");
  // 主门位全部经 v2EffectivePaused（沙箱安全三元），OFF 分支=legacy 三布尔
  assert.match(mainSource, /if \(\(typeof v2StateCore !== "undefined" && v2StateCore \? v2StateCore\.pause\.effectivePaused\(\) : \(walk\.dragPaused \|\| walk\.chatPaused \|\| walk\.zoomPaused\)\) \|\| walk\.seated \|\| !win\.isVisible\(\)\) return;/, "walkTick 主门");
});

test("COMPAT-21: Motion Closure 接线保持——external commit/revoke/deny 全在（源码合同）", () => {
  assert.match(mainSource, /v2StateCore\.pause\.acquire\("drag", \{ leaseId: interactionId !== undefined \? interactionId : null, domain: "renderer"/, "drag admission=① pause lease");
  assert.match(mainSource, /v2StateCore\.pause\.revoke\("drag", reason\); v2StateCore\.syncPauseProjection\(\);/, "clearDragPause=权威 revoke");
  assert.match(mainSource, /v2StateCore\.pause\.revokeByDomain\("renderer", "renderer-reload"\);/, "reload 吊销 renderer-owned lease");
  // Motion Closure 测试不退步：run 全套由 CI 保证；此处锁关键接线存在
  assert.match(mainSource, /function v2DragCommitLanding/, "drag landing admission 门面仍在");
});

test("COMPAT-22: 单向写合同——pause projection 只由 syncPauseProjection 写，禁止反向散写", () => {
  // walking-pause handler 内不再出现旧三布尔直接赋值（lease acquire + sync 取代）
  const handler = mainSource.slice(mainSource.indexOf('ipcMain.on("pet:walking-pause"'), mainSource.indexOf('ipcMain.on("pet:throw"'));
  assert.doesNotMatch(handler, /\n\s*walk\.paused = walk\.dragPaused/, "handler 不再用散落布尔合成 paused");
  assert.match(handler, /v2StateCore\.syncPauseProjection\(\)/, "projection 经 sync 单向写");
  // chatPauseWalk 同样经 lease + sync
  const chat = mainSource.slice(mainSource.indexOf("function chatPauseWalk"), mainSource.indexOf("async function handleAsk"));
  assert.match(chat, /v2StateCore\.chatLease\.(acquire|release)\(\)/);
  assert.match(chat, /v2StateCore\.syncPauseProjection\(\)/);
});

test("STATE-CORE 源码合同：renderer 分类器接入 drag 流；preload 透传 interactionId", () => {
  assert.match(petSource, /const dragInteraction = window\.StateCoreInteraction/);
  assert.match(petSource, /dragInteraction\.begin\(\{ pointerId: e\.pointerId, x: e\.screenX, y: e\.screenY \}\)/, "pointerdown=candidate 零 IPC");
  assert.match(petSource, /if \(step\.justAdmitted\) window\.petAPI\.walkingPause\(true, "drag", step\.interactionId\);/, "admission 先发 pause+motion 前置 IPC");
  assert.match(petSource, /const ended = dragInteraction\.end\(\);/);
  assert.match(preloadSource, /walkingPause: \(b, source, interactionId\) => ipcRenderer\.send\("pet:walking-pause", !!b, source \|\| "drag", interactionId === undefined \? null : interactionId\)/);
});
