"use strict";

/**
 * head-pat provenance 回归（2026-10-02 实机故障）：
 * Walk 中窗口移过静止光标 → Windows 送达 mousemove → v2.1「鼠标逗宠」hover 感应器
 * 把 Interact（摸头）动画 admission 成正式互动。正式语义：head-pat 只能来自
 * pointerdown→pointerup 的 press/click 手势；hover/pointer contact ≠ accepted head-pat。
 *
 * 覆盖：NO-BUTTON-HOVER / LEGAL-HEADPAT / DRAG-SEPARATION / CLEANUP。
 * 与 drag-lifecycle-contract / runtime-v2-state-core 同一先例：源码合同 + 纯模块行为。
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");

const renderer = fs.readFileSync(require.resolve("../renderer/pet.js"), "utf8");
const mainSource = fs.readFileSync(require.resolve("../main.js"), "utf8");
const finish = renderer.slice(renderer.indexOf("function finishDrag"), renderer.indexOf("function onDragStart"));
const dragStart = renderer.slice(renderer.indexOf("function onDragStart"), renderer.indexOf("const rigCanvasEl"));
const { createInteractionState } = require("../src/state-core/interaction-state");
const { createPauseAuthority } = require("../src/state-core/pause-authority");

/* ---------------- 1. NO-BUTTON-HOVER ---------------- */

test("NO-BUTTON-HOVER-1: v2.1 鼠标逗宠 hover 感应器已删除——mousemove 不得进入互动 admission", () => {
  assert.doesNotMatch(renderer, /mouseNearAt|mouseInteractCooldown/, "hover 停留感应器状态机不得复活");
  assert.doesNotMatch(renderer, /now - mouseNearAt > 1200/, "hover 停留 1.2s → interact 的映射不得存在");
  // 不允许任何 hover/contact 型监听器存在（info-panel 用 mousedown/mousemove 组合，属窗口 UI chrome，非宠物互动入口）
  assert.doesNotMatch(renderer, /addEventListener\("(pointerenter|pointerover|pointerout|pointerleave|mouseenter|mouseover)"/, "禁止 hover 类 listener 成为互动入口");
});

test("NO-BUTTON-HOVER-2: 互动动画调用点只允许在 finishDrag(tap)、onDropped(落地反馈)与测试 seam", () => {
  // playSpineInteract 的出现点必须逐一定位；hover 感应器删除后不得再有游离入口
  const calls = [...renderer.matchAll(/playSpineInteract\(\)/g)].length; // 5 = 定义 + onDropped + finishDrag×2 + poke seam
  assert.equal(calls, 5, "playSpineInteract() 出现点数量锁定（hover 入口已删除）");
  // headPatSquash 调用只存在于 finishDrag tap 分支与测试 seam
  assert.match(finish, /if \(!wasDrag\) \{[\s\S]*?headPatSquash\(\);/, "headPatSquash 在 !wasDrag 分支内");
  const outsideFinish = renderer.replace(finish, "");
  assert.doesNotMatch(outsideFinish.slice(0, outsideFinish.indexOf("poke:")), /(?<!function )(?<!\.)headPatSquash\(\);/, "finishDrag 之外无游离 headPatSquash() 调用");
});

test("NO-BUTTON-HOVER-3: InteractionState 无 begin 时任何 move 都不产生 candidate/admission（零 IPC、零 lease）", () => {
  let admits = 0;
  const i = createInteractionState({ onAdmit: () => { admits += 1; } });
  const pause = createPauseAuthority();
  for (let k = 0; k < 10; k += 1) { // 模拟 walking 移过静止光标的连续 mousemove/pointermove
    const r = i.move(300 + k * 5, 400); // 绝对位移远超阈值——但没有 pointerdown candidate
    assert.equal(r.crossed, false, "无 candidate 时 move 永不 crossed");
  }
  assert.equal(i.active(), false);
  assert.equal(i.snapshot(), null);
  assert.equal(admits, 0);
  assert.equal(pause.effectivePaused(), false, "hover 不得建立任何 pause lease");
});

/* ---------------- 2. LEGAL-HEADPAT ---------------- */

test("LEGAL-HEADPAT-1: tap admission 前提——dragState 只能由 pointerdown（左键、主指针、mouse）创建", () => {
  assert.match(dragStart, /if \(dragState \|\| e\.pointerType !== "mouse" \|\| e\.isPrimary !== true \|\| e\.button !== 0\) return;/, "onDragStart provenance 守卫完整");
  assert.match(finish, /const state = dragState;\s*if \(!state \|\| !state\.active\) return false;/, "finishDrag 无会话直接拒绝：pointerup 前提=pointerdown");
});

test("LEGAL-HEADPAT-2: 正常 pointerdown→pointerup（未过阈值）仍产出 tap head-pat 路径", () => {
  const i = createInteractionState();
  const ended = (() => {
    i.begin({ pointerId: 1, x: 600, y: 500 });
    i.move(601, 501); // 未过阈值
    return i.end();
  })();
  assert.equal(ended.wasDrag, false);
  assert.equal(ended.kind, "tap");
  assert.equal(ended.interactionId, null, "tap 不携带 interaction 身份（body-local）");
  // 渲染层 tap 分支：headPatSquash + Interact + pat IPC 完整保留（不被 hover 修复误伤）
  const tapBlock = finish.slice(finish.indexOf("if (!wasDrag)"), finish.indexOf("} else if (velocity"));
  assert.match(tapBlock, /headPatSquash\(\);/);
  assert.match(tapBlock, /playSpineInteract\(\);/);
  assert.match(tapBlock, /window\.petAPI\.pat && window\.petAPI\.pat\(\);/);
});

test("LEGAL-HEADPAT-3: pointerup/cancel 全部以 pointerId 匹配为条件——外部事件无法凭空触发释放路径", () => {
  assert.match(renderer, /window\.addEventListener\("pointerup", \(e\) => \{\s*if \(dragState && e\.pointerId === dragState\.pointerId\)/);
  assert.match(renderer, /if \(dragState && e\.pointerId === dragState\.pointerId\) finishDrag\("pointercancel"\);/);
  assert.match(renderer, /if \(!dragState \|\| e\.currentTarget !== dragState\.target \|\| e\.pointerId !== dragState\.pointerId\) return;\s*finishDrag\("lostpointercapture"\);/);
});

/* ---------------- 3. DRAG-SEPARATION ---------------- */

test("DRAG-SEPARATION-1: 真 drag（过阈值 admit）结束走 drag 分支，绝不触碰 head-pat 动画", () => {
  let admits = 0;
  const i = createInteractionState({ onAdmit: () => { admits += 1; } });
  i.begin({ pointerId: 1, x: 600, y: 500 });
  const step = i.move(610, 500);
  assert.equal(step.crossed, true);
  assert.equal(step.justAdmitted, true);
  assert.equal(admits, 1);
  const ended = i.end();
  assert.equal(ended.wasDrag, true);
  assert.equal(ended.kind, "drag");
  assert.ok(ended.interactionId, "drag 结束必须携带 interactionId");
  // finishDrag 的 drag/throw 分支无任何 pat 入口
  const dragBranch = finish.slice(finish.indexOf("} else if (velocity"));
  assert.doesNotMatch(dragBranch, /headPatSquash\(\)|playSpineInteract\(\)|petAPI\.pat\(/, "drag 分支与 head-pat 完全隔离");
});

test("DRAG-SEPARATION-2: admission IPC 顺序合同不变——justAdmitted 先 walkingPause(true,\"drag\",id) 再 moveWindow", () => {
  const pm = renderer.slice(renderer.indexOf('window.addEventListener("pointermove"'), renderer.indexOf('window.addEventListener("pointerup"'));
  assert.ok(pm.indexOf('walkingPause(true, "drag", step.interactionId)') < pm.indexOf("moveWindow(step.dx, step.dy, step.interactionId)"), "pause+motion 前置 IPC 先于位移");
});

/* ---------------- 4. CLEANUP ---------------- */

test("CLEANUP-1: 合法 interaction 生命周期后 leases 零残留，locomotion 恢复正常（effectivePaused=false）", () => {
  const pause = createPauseAuthority();
  const ids = [];
  const i = createInteractionState({ onAdmit: (e) => { ids.push(e.interactionId); pause.acquire("drag", { leaseId: e.interactionId, domain: "renderer" }); } });
  i.begin({ pointerId: 1, x: 100, y: 100 });
  const step = i.move(120, 100);
  assert.equal(step.justAdmitted, true);
  assert.equal(pause.effectivePaused(), true, "admitted drag 期间 paused");
  const wrong = pause.release("drag", { leaseId: "stale-id" });
  assert.equal(wrong.ok, false, "错 leaseId 释放被拒");
  assert.equal(pause.effectivePaused(), true);
  const ended = i.end();
  const rel = pause.release("drag", { leaseId: ended.interactionId });
  assert.equal(rel.ok, true);
  assert.equal(pause.effectivePaused(), false, "interaction 结束无残留 lease");
  assert.deepEqual(pause.activeSources(), []);
  // renderer 合同：释放携带 ended.interactionId，且先摘全局状态再发副作用
  assert.match(finish, /dragState = null;/);
  assert.ok(finish.indexOf("dragState = null;") < finish.indexOf('walkingPause(false, "drag"'), "先摘 dragState 再释放");
  assert.match(finish, /window\.petAPI\.walkingPause\(false, "drag", interactionId\);/);
});

test("CLEANUP-2: hover 全程无 accepted session——revokeByDomain 无 renderer lease 可吊销（幂等）", () => {
  const pause = createPauseAuthority();
  pause.acquire("chat", { leaseId: null, domain: "main" });
  const res = pause.revokeByDomain("renderer", "renderer-reload");
  assert.deepEqual(res.revoked, [], "hover 场景未建立 renderer lease——无残骸可清");
  assert.equal(pause.isPaused("chat"), true, "main-owned lease 不受影响");
});

test("CLEANUP-3: body-local head-pat 只做本地视觉收尾，不伪造 drag lease release", () => {
  const tapBlock = finish.slice(finish.indexOf("if (!wasDrag)"), finish.indexOf("} else if (velocity"));
  assert.doesNotMatch(tapBlock, /walkingPause\(false,\s*[\"']interact[\"']/,
    "tap/head-pat 不得发送匿名 interact release");
  assert.match(tapBlock, /reconcileSpineAnimation\("interact-end"\)/,
    "body-local 互动仍通过本地 reconcile 收尾");
  assert.match(finish, /walkingPause\(false, "drag", interactionId\)/,
    "只有真实 drag 结束才携带匹配 interactionId 释放");
});
