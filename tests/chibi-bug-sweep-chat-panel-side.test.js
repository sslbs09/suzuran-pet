"use strict";

/**
 * BUG-06 回归：靠左屏幕边缘时 chat panel 出现在错误一侧。
 * 合同：侧别决策使用当前 display workArea（getDisplayMatching 跟随窗口）+ 真实 panel width
 * （渲染层经 pet:chat-panel-metrics 上报）；常规侧（panel 左侧）放得下保持默认布局，
 * 左缘换边（ui-edge-compact ON），退回屏内换回（滞回）；面板宽真实变化时重评。
 */
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { loadMain } = require("./helpers/main-body-harness");

function open(h) {
  const win = h.createWindow();
  const identity = h.syncDocument();
  h.outcome(identity, { requestedMode: "spine", committedMode: "spine", ok: true });
  h.ready(identity, { committedMode: "spine", usable: true });
  return { win, identity };
}

function eventFor(h, identity) {
  return { sender: h.state.win.webContents, senderFrame: h.state.win.webContents.mainFrame, identity };
}

function uiEdgeMessages(h) {
  return h.messages().filter((m) => m.name === "pet:ui-edge-compact").map((m) => m.args && m.args[0]);
}

test("chat panel 侧别：左缘换边（面板宽上报后）→ 回屏内换回（滞回）", () => {
  const h = loadMain();
  const { identity } = open(h);
  const metrics = h.handler("pet:chat-panel-metrics");
  const ev = eventFor(h, identity);

  // 面板真实宽度上报（100px：harness fake workArea=800，两侧均可行的滞回带存在）
  metrics(ev, { width: 100 }, identity);

  // 角色条带左缘贴工作区左缘（win.x = wa.x - 138）：常规侧放不下 100 → 换边
  h.state.win.__setBounds({ x: -138, y: 500, width: 260, height: 200 });
  h.context.__m1.walkBroadcast();
  let msgs = uiEdgeMessages(h);
  assert.equal(msgs.length, 1, "换边恰好一次 IPC（变化才发）");
  assert.equal(msgs[0].value, true, "左缘 → compact ON（panel 换到角色右侧）");

  // 同位置重复广播：零新增 IPC（变化门控）
  h.context.__m1.walkBroadcast();
  assert.equal(uiEdgeMessages(h).length, 1, "无变化零 IPC");

  // 滞回带（两侧都可行时才生效）：x=-26 → charLeft=112 → leftRoom=106 ∈ [100,116)，
  // 退出需 ≥ 100+16 → 维持 ON；右侧 562px 仍放得下（若右侧已放不下则必须换回防裁切）
  h.state.win.__setBounds({ x: -26, y: 500, width: 260, height: 200 });
  h.context.__m1.walkBroadcast();
  msgs = uiEdgeMessages(h);
  assert.equal(msgs.length, 1, "滞回带内维持换边态（贴阈值不往复）");

  // 越过滞回带 → 换回默认布局
  h.state.win.__setBounds({ x: 600, y: 500, width: 260, height: 200 });
  h.context.__m1.walkBroadcast();
  msgs = uiEdgeMessages(h);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[1].value, false, "屏内余量恢复 → compact OFF");
});

test("chat panel 侧别：面板宽真实变化驱动重评（宽面板在屏内也换边 / 窄面板换回）", () => {
  const h = loadMain();
  const { identity } = open(h);
  const metrics = h.handler("pet:chat-panel-metrics");
  const ev = eventFor(h, identity);
  h.state.win.__setBounds({ x: 4, y: 500, width: 260, height: 200 }); // 条带左缘=142，左室=142-6=136

  metrics(ev, { width: 300 }, identity); // 136 < 300 → 常规侧放不下 → 换边
  h.context.__m1.walkBroadcast();
  let msgs = uiEdgeMessages(h);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].value, true, "面板真实变宽 → 即使未贴死边也换边（冻结规则）");

  metrics(ev, { width: 100 }, identity); // 136+16 滞回 ≥ 100+16? leftRoom=136 ≥ 100+16=116 → 退出
  h.context.__m1.walkBroadcast();
  msgs = uiEdgeMessages(h);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[1].value, false, "面板变窄且余量越过滞回带 → 换回默认侧");

  metrics(ev, { width: 9999 }, identity); // 超宽：两侧都放不下 → larger side + clamp 终态
  h.state.win.__setBounds({ x: 0, y: 500, width: 260, height: 200 });
  h.context.__m1.walkBroadcast();
  msgs = uiEdgeMessages(h);
  assert.equal(msgs.length, 3);
  assert.equal(msgs[2].value, true, "终态：更大侧（右）+ clamp（compact CSS 收窄布局）");
});
