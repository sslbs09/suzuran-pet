"use strict";

/**
 * BUG-05 回归：pat/interact > locomotion（产品优先级冻结）。
 * body-local 互动（tap/pat）必须让 locomotion 让位：
 *   ① V2 episode 立即释放（不得继续推进窗口）；
 *   ② PauseAuthority 走预留的 "interaction" source（lease-id 匹配释放）；
 *   ③ 不产生 EXTERNAL_DRAG 会话、不写 dragPaused（互动不是拖拽）；
 *   ④ 释放后 locomotion 仅在 policy 允许时恢复；
 *   ⑤ 匿名互动请求被拒绝（与 drag/zoom 同一 admission 纪律）；
 *   ⑥ 迟到的旧 lease 释放被权威拒绝（新互动不被旧 timer 打断）。
 */
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

function eventFor(h, identity) {
  return { sender: h.state.win.webContents, senderFrame: h.state.win.webContents.mainFrame, identity };
}

test("interaction pause：V2 locomotion 让位 + interaction lease 生命周期", () => {
  const h = loadMain();
  const { identity } = open(h);
  h.setTray({ setContextMenu() {} });
  h.context.__m1.startWalkingEngine({ silent: true });

  // 稳定坐姿 admits V2 episode（cross-domain 同式）
  h.context.__m1.call("setBodyPosture", { seated: true }, { source: "sweep-setup" });
  const ep = h.state.v2Locomotion.beginEpisode({ dir: 1, moveMs: 5000 });
  assert.equal(ep.ok, true);
  assert.equal(h.state.v2Authority.owner(), "v2-locomotion");

  const pause = h.handler("pet:walking-pause");
  const ev = eventFor(h, identity);
  const before = h.state.win.getBounds();
  pause(ev, true, "interaction", "interact-1", identity);

  // ① locomotion 让位：episode 释放；② lease 持有；③ 非拖拽语义
  assert.equal(h.state.v2Authority.owner(), "legacy", "V2 episode 必须立即释放（locomotion 让位）");
  assert.equal(h.state.v2StateCore.pause.isPaused("interaction"), true);
  assert.equal(h.state.v2StateCore.pause.isPaused("drag"), false, "interaction 不是 drag（无 dragPaused 语义）");
  assert.equal(h.state.walk.paused, true);
  assert.notEqual(h.state.v2Authority.owner(), "external-drag", "不得误建 EXTERNAL_DRAG 会话");

  // 暂停期间窗口不推进（V1 旁路 + pause 早退）——直接驱动 tick，不经 advance（相位 timer 自续循环）
  h.context.__m1.walkTick();
  h.context.__m1.walkTick();
  assert.deepEqual(h.state.win.getBounds(), before, "互动持有期间 locomotion 不得提交位移");

  // ⑥ 匿名/错误 lease 释放被拒
  assert.equal(pause(ev, false, "interaction", "wrong-lease", identity) === undefined, true);
  assert.equal(h.state.v2StateCore.pause.isPaused("interaction"), true, "lease-id 不匹配 → 释放被拒");

  // ④ 正确释放 → 恢复；相位机（policy）接管下一步
  pause(ev, false, "interaction", "interact-1", identity);
  assert.equal(h.state.v2StateCore.pause.isPaused("interaction"), false);
  assert.equal(h.state.walk.paused, false);
});

test("interaction pause：匿名 acquire 被拒；重复 acquire 换发 lease（旧 timer 失效）", async () => {
  const h = loadMain();
  const { identity } = open(h);
  h.setTray({ setContextMenu() {} });
  h.context.__m1.startWalkingEngine({ silent: true });
  const pause = h.handler("pet:walking-pause");
  const ev = eventFor(h, identity);

  pause(ev, true, "interaction", null, identity); // 匿名：admission 纪律拒绝
  assert.equal(h.state.v2StateCore.pause.isPaused("interaction"), false, "匿名互动请求不得暂停 locomotion");

  pause(ev, true, "interaction", "interact-a", identity);
  pause(ev, true, "interaction", "interact-b", identity); // 连击：同 source 换发新 lease
  assert.equal(h.state.v2StateCore.pause.isPaused("interaction"), true);
  pause(ev, false, "interaction", "interact-a", identity); // 旧 timer：lease-id 不匹配 → 拒
  assert.equal(h.state.v2StateCore.pause.isPaused("interaction"), true, "旧互动 timer 不得释放新互动的 lease");
  pause(ev, false, "interaction", "interact-b", identity);
  assert.equal(h.state.v2StateCore.pause.isPaused("interaction"), false);

  // ⑤ V2 episode 持有时的互动让位：resume 后 policy 接管（不直接重走）
  h.context.__m1.call("setBodyPosture", { seated: true }, { source: "sweep-setup-2" });
  const ep = h.state.v2Locomotion.beginEpisode({ dir: 1, moveMs: 3000 });
  assert.equal(ep.ok, true);
  pause(ev, true, "interaction", "interact-c", identity);
  assert.equal(h.state.v2Authority.owner(), "legacy", "互动让位：episode 释放");
  pause(ev, false, "interaction", "interact-c", identity);
  assert.equal(h.state.v2StateCore.pause.isPaused("interaction"), false);
  assert.equal(h.state.v2CanEnterSlice ? h.state.v2CanEnterSlice().ok : h.context.__m1.probe("v2CanEnterSlice")().ok, false,
    "释放后不立即夺权：等稳定坐姿由相位机重新决策（policy permits）");
});
