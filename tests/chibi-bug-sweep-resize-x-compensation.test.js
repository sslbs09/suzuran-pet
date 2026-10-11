"use strict";

/**
 * BUG-02 回归：position micro-jump / stale projection（窗口侧）。
 * 角色条带 CSS 右缘锚定（.pet left: calc(100%-122px)）——窗口宽度变化时 setSize 顶左固定
 * 会让角色屏上瞬跳 ±ΔW（气泡开合 / 行走激活恢复标准窗 / 放大还原 = 三个症状触发源）。
 * 合同：宽度变化必须补偿 win.x，使条带屏上 x 不变；例外=render-mode 重派 / 拖拽持有 /
 * V2-EXTERNAL 占用（admission 拒绝，owner 逐拍接管）。
 * 同时锁 charStripInset 宽度感知几何（非标准宽下钳位/左界不再用 138 硬编码）。
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

test("pet:set-size 宽度变化补偿 x：条带屏上位置不变（气泡开→关 往返零净位移）", () => {
  const h = loadMain();
  const { identity } = open(h);
  h.state.win.__setBounds({ x: 600, y: 700, width: 260, height: 200 });
  const setSize = h.handler("pet:set-size");
  const ev = eventFor(h, identity);

  // 条带屏上左缘 = win.x + (width - 122)：加宽前 600+138=738
  setSize(ev, 460, 200, "bubble", identity);
  let b = h.state.win.getBounds();
  assert.equal(b.width, 460);
  assert.equal(b.x, 400, "加宽 200px → win.x 左移 200（条带屏上位置不变）");
  assert.equal(b.x + (b.width - 122), 738, "条带屏上左缘保持 738");

  // 收窄（行走激活恢复标准窗同路径）：角色不跳
  setSize(ev, 260, 200, "walk-restore", identity);
  b = h.state.win.getBounds();
  assert.equal(b.width, 260);
  assert.equal(b.x, 600, "收窄 200px → win.x 右移 200（条带屏上位置不变）");
});

test("pet:set-size：render-mode 重派不补偿；拖拽持有不补偿", () => {
  const h = loadMain();
  const { identity } = open(h);
  // x=300：即使在 harness 的窄 fake workArea(800) 下，render-mode 的地面重钳也不会水平移动它
  h.state.win.__setBounds({ x: 300, y: 500, width: 260, height: 200 });
  const setSize = h.handler("pet:set-size");
  const ev = eventFor(h, identity);

  setSize(ev, 400, 260, "render-mode", identity);
  assert.equal(h.state.win.getBounds().x, 300, "render-mode 布局重派：无 x 补偿（顶左固定，重钳不涉及水平）");
  setSize(ev, 260, 200, "render-mode", identity);
  assert.equal(h.state.win.getBounds().x, 300, "收窄回标准窗：仍无补偿");

  // 拖拽持有：用户拥有几何，resize 不动 x
  h.state.walk.dragPaused = true;
  setSize(ev, 400, 260, "bubble", identity);
  assert.equal(h.state.win.getBounds().x, 300, "dragPaused：不补偿（用户拥有几何）");
  h.state.walk.dragPaused = false;
});

test("pet:set-size：V2 locomotion 持有时补偿经 admission 拒绝（不双写），setSize 仍生效", () => {
  const h = loadMain();
  const { identity } = open(h);
  h.setTray({ setContextMenu() {} });
  h.context.__m1.startWalkingEngine({ silent: true });
  h.state.win.__setBounds({ x: 600, y: 700, width: 260, height: 200 });
  h.context.__m1.call("setBodyPosture", { seated: true }, { source: "sweep-setup" });
  const ep = h.state.v2Locomotion.beginEpisode({ dir: 1, moveMs: 5000 });
  assert.equal(ep.ok, true);
  const setSize = h.handler("pet:set-size");
  const ev = eventFor(h, identity);

  setSize(ev, 460, 200, "bubble", identity);
  const b = h.state.win.getBounds();
  assert.equal(b.width, 460, "尺寸变更照常生效");
  assert.equal(b.x, 600, "V2 持有：x 补偿被 admission 拒绝（owner 逐拍 live 提交接管，不双写）");
  assert.equal(h.state.v2Commit.stats.byKind["resize-x-compensate"], undefined, "零补偿写入");
});

test("charStripInset 宽度感知几何：标准窗=138，宽窗=宽-122，compact=138（源码提取）", () => {
  const h = loadMain();
  const { identity } = open(h);
  const mainSrc = require("node:fs").readFileSync(require.resolve("../main.js"), "utf8").replace(/\r\n/g, "\n");
  const start = mainSrc.indexOf("function charStripInset");
  const end = mainSrc.indexOf("}", mainSrc.indexOf("Math.max(PET_LOCAL_X", start)) + 1;
  assert.ok(start > 0 && end > start, "charStripInset 存在");
  const charStripInset = new Function("walk", "PET_LOCAL_X", `${mainSrc.slice(start, end)}; return charStripInset;`)(
    h.state.walk, 138);
  assert.equal(charStripInset({ width: 260 }), 138, "标准窗：宽-122=138（PET_LOCAL_X 兼容）");
  assert.equal(charStripInset({ width: 460 }), 338, "宽窗：右缘锚定偏移=宽-122");
  assert.equal(charStripInset({ width: 200 }), 138, "窄窗：下限 PET_LOCAL_X");
  assert.equal(charStripInset(null), 138, "无 bounds：保守标准语义");
});
