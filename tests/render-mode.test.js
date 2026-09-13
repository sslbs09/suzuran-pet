/** 渲染模式归一化 + 切换贴地坐标单测（node，纯函数） */
"use strict";
const assert = require("node:assert/strict");
const RM = require("../src/render-mode");
const G = require("../src/walk-geo");
const fs = require("node:fs");
const vm = require("node:vm");
const mainSource = fs.readFileSync(require.resolve("../main.js"), "utf8").replace(/\r\n/g, "\n");
const renderModeSource = fs.readFileSync(require.resolve("../src/render-mode"), "utf8").replace(/\r\n/g, "\n");
const rendererSource = fs.readFileSync(require.resolve("../renderer/pet.js"), "utf8").replace(/\r\n/g, "\n");
const preloadSource = fs.readFileSync(require.resolve("../preload.js"), "utf8").replace(/\r\n/g, "\n");
const settingsSource = fs.readFileSync(require.resolve("../renderer/settings.js"), "utf8").replace(/\r\n/g, "\n");
let failed = 0;
function assertEq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failed++; console.log("FAIL", name, "got", JSON.stringify(got), "want", JSON.stringify(want)); }
  else console.log("PASS", name);
}

function sourceBlock(source, startMarker, endMarker, name) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `${name} block exists`);
  return source.slice(start, end);
}

function setSizeHandlerBlock(source = mainSource) {
  return sourceBlock(source, 'ipcMain.on("pet:set-size"', 'ipcMain.handle("pet:tts-clone"', "pet:set-size");
}

function setScaleFunctionBlock(source = mainSource) {
  return sourceBlock(source, "function setScale(scale)", "function setWalkSpeed", "setScale");
}

function setScaleExecutableBlock(source = mainSource) {
  const block = setScaleFunctionBlock(source);
  const handler = block.indexOf('ipcMain.handle("pet:set-scale"');
  return handler >= 0 ? block.slice(0, handler) : block;
}

function assertSetSizeWiring(source = mainSource) {
  const block = setSizeHandlerBlock(source);
  assert.equal((block.match(/captureResizeAnchor\(\)/g) || []).length, 1, "pet:set-size 只在 resize 前 capture 一次");
  const capture = block.indexOf("const wasGrounded = captureResizeAnchor();");
  const setSize = block.indexOf("win.setSize(ws, hs)");
  assert.ok(capture >= 0 && capture < setSize, "pet:set-size 在 win.setSize 前保存 grounded 结果");
  const callbackStart = block.indexOf("setTimeout(() =>");
  const callback = block.slice(callbackStart);
  assert.match(callback, /windowSizeRevision\.isCurrent\(resizeRevision\)/, "pet:set-size callback 保留 revision guard");
  assert.match(callback, /}, 150\);/, "pet:set-size 保留 150ms callback");
  assert.match(callback, /repositionAfterWindowSizeChange\(renderModeCommit, wasGrounded\)/, "pet:set-size callback 使用 pre-resize grounded 结果");
  assert.doesNotMatch(callback, /captureResizeAnchor\(\)|wasGroundAnchored\(/, "pet:set-size callback 不重新推断 grounded");
}

function assertSetScaleWiring(source = mainSource) {
  const block = setScaleFunctionBlock(source);
  assert.match(block, /const resizeRevision = windowSizeRevision\.next\(\);/, "setScale 保存 resize revision");
  assert.match(block, /const wasGrounded = captureResizeAnchor\(\);/, "setScale 保存 grounded 结果");
  const capture = block.indexOf("const wasGrounded = captureResizeAnchor();");
  const setSize = block.indexOf("win.setSize(ws, hs)");
  assert.ok(capture >= 0 && capture < setSize, "setScale 在 win.setSize 前 capture");
  const enableResizable = block.indexOf("if (!win.isResizable()) win.setResizable(true);");
  assert.equal((block.match(/win\.setResizable\(true\)/g) || []).length, 1, "setScale 只开启一次 resizable");
  assert.ok(enableResizable >= 0 && enableResizable < setSize, "setScale 在 win.setSize 前临时开启 resizable");
  const callbackStart = block.indexOf("setTimeout(() =>");
  const callback = block.slice(callbackStart);
  assert.match(callback, /const revisionCurrent = windowSizeRevision\.isCurrent\(resizeRevision\);/, "setScale callback 保存 revision 判断");
  assert.match(callback, /if \(revisionCurrent\) \{/, "setScale callback 仅 current 时定位");
  assert.match(callback, /finally \{/, "setScale callback 用 finally 保证 resizable 恢复");
  assert.match(callback, /repositionAfterWindowSizeChange\(false, wasGrounded\)/, "setScale callback 使用保存的 grounded 结果");
  assert.equal((callback.match(/win\.setResizable\(false\)/g) || []).length, 1, "setScale callback 最终恢复 resizable=false");
  assert.ok(callback.indexOf("win.setResizable(false)") > callback.indexOf("repositionAfterWindowSizeChange(false, wasGrounded)"), "setScale 先完成稳定定位再恢复 resizable");
  assert.doesNotMatch(callback, /if \(!windowSizeRevision\.isCurrent\(resizeRevision\)\) return;/, "setScale stale callback 不能跳过 resizable 恢复");
  assert.match(block, /const ws = Math\.round\(\(cfg\.window\.width \|\| 260\) \* s\);/, "setScale 使用 base width 计算目标宽度");
  assert.match(block, /const hs = Math\.round\(\(cfg\.window\.height \|\| 200\) \* s\);/, "setScale 使用 base height 计算目标高度");
  assert.match(block, /win\.setSize\(ws, hs\);/, "setScale 使用当前 scale 目标尺寸执行 native resize");
  const notify = block.indexOf('sendToRenderer("pet:scale-changed", s);');
  assert.ok(notify > setSize, "native resize 请求后才通知 renderer scale-changed");
}

// setScale 的最小动态夹具：直接执行 production function block，验证 native resize 顺序与 stale callback 行为。
function createScaleHarness({ width = 260, height = 200, x = 400, y = 300, resizable = false, grounded = false } = {}) {
  const calls = [];
  const callbacks = [];
  const wa = { x: 0, y: 0, width: 1536, height: 800 };
  let bounds = { x, y, width, height };
  let resizableState = !!resizable;
  const fakeWin = {
    isDestroyed: () => false,
    isResizable: () => resizableState,
    setResizable: (value) => { resizableState = !!value; calls.push({ type: "setResizable", value: resizableState }); },
    setSize: (nextWidth, nextHeight) => {
      calls.push({ type: "setSize", width: nextWidth, height: nextHeight, resizable: resizableState });
      if (resizableState) { bounds.width = nextWidth; bounds.height = nextHeight; }
    },
    getBounds: () => ({ ...bounds }),
    getPosition: () => [bounds.x, bounds.y],
    setPosition: (nextX, nextY) => { bounds.x = nextX; bounds.y = nextY; calls.push({ type: "setPosition", x: nextX, y: nextY }); }
  };
  const config = {
    saveConfig: () => {},
    getConfig: () => ({ window: { width: 260, height: 200 } })
  };
  const revision = RM.createResizeRevision();
  const fn = new Function(
    "clampScale", "config", "win", "windowSizeRevision", "captureResizeAnchor", "walkGeo", "screen",
    "walkMinX", "repositionAfterWindowSizeChange", "clampPetToWorkArea", "applySeatPosition", "refreshTrayMenu",
    "sendToRenderer", "setTimeout", `${setScaleExecutableBlock()}; return setScale;`
  )(
    (value) => Math.max(0.6, Math.min(2.0, Number(value) || 1.0)),
    config,
    fakeWin,
    revision,
    () => grounded,
    { workAreaOf: () => wa },
    {},
    () => 0,
    (_renderModeCommit, wasGrounded) => calls.push({ type: "reposition", wasGrounded, bounds: { ...bounds } }),
    (reason) => calls.push({ type: "clamp", reason }),
    () => calls.push({ type: "seat" }),
    () => calls.push({ type: "tray" }),
    (_channel, value) => calls.push({ type: "notify", value }),
    (callback, delay) => { callbacks.push({ callback, delay }); return callbacks.length; }
  );
  return {
    calls,
    callbacks,
    get bounds() { return { ...bounds }; },
    get resizable() { return resizableState; },
    setScale: fn,
    runCallback(index = 0) { callbacks[index].callback(); }
  };
}

function createSitOnTaskbarHarness({ gap, bounds, workArea } = {}) {
  const calls = [];
  const wa = workArea || { x: 0, y: 0, width: 1536, height: 912 };
  let currentBounds = { x: 638, y: 782, width: 195, height: 150, ...(bounds || {}) };
  const fakeWin = {
    isDestroyed: () => false,
    getBounds: () => ({ ...currentBounds }),
    setPosition: (x, y) => {
      calls.push({ type: "setPosition", x, y });
      currentBounds.x = x;
      currentBounds.y = y;
    }
  };
  const walk = { groundGap: 80, seated: false, resting: false, perched: false, gotoPerch: false, returning: false };
  const config = { getConfig: () => ({ renderMode: "gif" }) };
  const fn = new Function(
    "win", "walkGeo", "screen", "config", "walk", "gifVisualGroundGap", "renderModeMod", "walkMinX",
    "showWindow", "skinHasSit", "applySeatPosition", "walkBroadcast", "logTts",
    `${sourceBlock(mainSource, "function sitOnTaskbar", 'ipcMain.handle("pet:sit-taskbar"', "sitOnTaskbar")}; return sitOnTaskbar;`
  )(
    fakeWin,
    { workAreaOf: () => wa },
    {},
    config,
    walk,
    gap,
    RM,
    () => wa.x,
    () => {},
    true,
    () => {},
    () => {},
    () => {}
  );
  return { calls, get bounds() { return { ...currentBounds }; }, run: fn };
}

function assertSitOnTaskbarWiring(source = mainSource) {
  const block = sourceBlock(source, "function sitOnTaskbar", 'ipcMain.handle("pet:sit-taskbar"', "sitOnTaskbar");
  assert.match(block, /const groundGap = renderModeMod\.effectiveGroundGap\(mode, walk\.groundGap, gifVisualGroundGap\);/, "sitOnTaskbar 保存 mode-aware gap");
  assert.match(block, /const targetY = renderModeMod\.groundAlign\(b, wa, groundGap\)\.y \|\| 0;/, "sitOnTaskbar 复用统一 native y 取整");
  assert.doesNotMatch(block, /const targetY = wa\.y \+ wa\.height \+ groundGap - b\.height;/, "sitOnTaskbar 不把 fractional y 直接交给 native API");
  const setPositionStart = block.indexOf("win.setPosition(");
  const setPositionEnd = block.indexOf(");", setPositionStart);
  const setPosition = block.slice(setPositionStart, setPositionEnd);
  assert.match(setPosition, /Math\.round\(/, "sitOnTaskbar native x 坐标归一化");
  assert.match(setPosition, /targetY/, "sitOnTaskbar native y 使用归一化结果");
  assert.doesNotMatch(setPosition, /calculatedY|groundGap/, "sitOnTaskbar native 调用不直接消费 fractional 公式");
}

function assertOutOfScreenGuardWiring(source = mainSource) {
  const block = sourceBlock(source, "function outOfScreenGuard", "function walkTick", "outOfScreenGuard");
  assert.match(block, /const groundGap = renderModeMod\.effectiveGroundGap\(config\.getConfig\(\)\.renderMode, walk\.groundGap, gifVisualGroundGap\);/, "outOfScreenGuard 保存 mode-aware gap");
  assert.match(block, /const groundY = Math\.max\(wa\.y, wa\.y \+ wa\.height - b\.height\) \+ groundGap;/, "outOfScreenGuard groundY 公式消费局部 groundGap");
  assert.match(block, /win\.setPosition\(b\.x, Math\.round\(groundY\)\);/, "outOfScreenGuard native y 坐标归一化");
  assert.doesNotMatch(block, /const groundY = Math\.max\(wa\.y, wa\.y \+ wa\.height - b\.height\) \+ \(walk\.groundGap \|\| 0\);/, "outOfScreenGuard groundY 公式不消费 raw gap");
}

function assertDragSeatNativeWiring(source = mainSource) {
  const block = sourceBlock(source, "function dragSeatUpdate", "/* ---------- 桌面行走 v2", "dragSeatUpdate");
  assert.doesNotMatch(block, /[+\-]\s*walk\.groundGap/, "dragSeatUpdate 不直接消费 raw groundGap");
  assert.match(block, /win\.setPosition\(Math\.round\(nx\), Math\.round\(ny\)\);/, "dragSeatUpdate native 坐标归一化");
}

function expectMutationToFail(name, mutate, check) {
  let failedAsExpected = false;
  try { check(mutate()); } catch { failedAsExpected = true; }
  assert.equal(failedAsExpected, true, `${name} mutation 应使测试失败`);
  console.log("PASS", name, "mutation 被测试抓住");
}

function loadRenderMode(source) {
  const module = { exports: {} };
  new Function("module", "exports", `${source}\nreturn module.exports;`)(module, module.exports);
  return module.exports;
}

// 1) 渲染模式归一化
assertEq("renderModeOf spine", RM.renderModeOf("spine"), "spine");
assertEq("renderModeOf rig", RM.renderModeOf("rig"), "rig");
assertEq("renderModeOf gif", RM.renderModeOf("gif"), "gif");
assertEq("renderModeOf 未配置(undefined) 回落 gif", RM.renderModeOf(undefined), "gif");
assertEq("renderModeOf 空串回落 gif", RM.renderModeOf(""), "gif");
assertEq("renderModeOf 未知值回落 gif", RM.renderModeOf("psd"), "gif");
assertEq("renderModeOf 大写不匹配回落 gif", RM.renderModeOf("SPINE"), "gif");
assertEq("RENDER_MODES 四态", JSON.stringify(RM.RENDER_MODES), JSON.stringify(["gif", "spine", "rig", "live2d"]));

// B-2 outcome acceptance：main 只接受当前 main-side seq，且必须能表达 requested/committed。
assert.deepEqual(
  RM.renderModeOutcomeDecision({
    currentSeq: 7,
    expectedRequestedMode: "rig",
    outcome: { seq: 7, ok: false, requestedMode: "rig", committedMode: "gif", error: "missing skin" }
  }),
  { accepted: true, seq: 7, ok: false, requestedMode: "rig", committedMode: "gif", error: "missing skin" }
);
assert.deepEqual(
  RM.renderModeOutcomeDecision({
    currentSeq: 7,
    expectedRequestedMode: "rig",
    outcome: { seq: 6, ok: true, requestedMode: "rig", committedMode: "rig" }
  }),
  { accepted: false, reason: "stale" },
  "old outcome cannot be accepted"
);
assert.deepEqual(
  RM.renderModeOutcomeDecision({
    currentSeq: 7,
    expectedRequestedMode: "rig",
    outcome: { seq: 7, ok: true, requestedMode: "live2d", committedMode: "live2d" }
  }),
  { accepted: false, reason: "unexpected-requested-mode" },
  "same seq but wrong intent cannot be accepted"
);
assert.deepEqual(
  RM.renderModeCorrectionDecision({
    currentSeq: 9,
    currentSourceMode: "rig",
    correction: { baseSeq: 9, sourceMode: "rig", committedMode: "gif", error: "missing skin" }
  }),
  { accepted: true, baseSeq: 9, sourceMode: "rig", committedMode: "gif", error: "missing skin" }
);
assert.deepEqual(
  RM.renderModeCorrectionDecision({
    currentSeq: 9,
    currentSourceMode: "rig",
    correction: { baseSeq: 8, sourceMode: "rig", committedMode: "gif" }
  }),
  { accepted: false, reason: "stale" },
  "old internal correction cannot be accepted"
);
assert.deepEqual(
  RM.renderModeCorrectionDecision({
    currentSeq: 9,
    currentSourceMode: "live2d",
    correction: { baseSeq: 9, sourceMode: "rig", committedMode: "gif" }
  }),
  { accepted: false, reason: "unexpected-source-mode" },
  "correction from another source mode cannot be accepted"
);
const sender = {};
assert.equal(RM.isCurrentRenderSender(sender, sender), true, "current renderer sender is accepted");
assert.equal(RM.isCurrentRenderSender({}, sender), false, "wrong renderer sender is rejected");

// 2) 切换贴地坐标
const wa = { x: 0, y: 0, width: 1536, height: 800 };
assertEq("贴地 居中窗口", RM.groundAlign({ x: 500, y: 300, width: 260, height: 200 }, wa, 0), { x: 500, y: 600 });
assertEq("贴地 带 groundGap", RM.groundAlign({ x: 500, y: 300, width: 260, height: 200 }, wa, 26), { x: 500, y: 626 });
assertEq("贴地 越左界钳回", RM.groundAlign({ x: -120, y: 300, width: 260, height: 200 }, wa, 0), { x: 0, y: 600 });
assertEq("贴地 越右界钳回", RM.groundAlign({ x: 2000, y: 300, width: 260, height: 200 }, wa, 0), { x: 1276, y: 600 });
assertEq("贴地 负坐标工作区(副屏)", RM.groundAlign({ x: -300, y: 100, width: 260, height: 200 }, { x: -1920, y: 0, width: 1920, height: 1080 }, 10), { x: -300, y: 890 });
assertEq("贴地 工作区比窗口窄(坍缩)仍钳回左界", RM.groundAlign({ x: 50, y: 0, width: 300, height: 200 }, { x: 10, y: 0, width: 200, height: 600 }, 0), { x: 10, y: 400 });
// 与 walkGeo.groundLine 一致性（正常窗口：贴地 y == groundLine）
assertEq("贴地 y 与 walkGeo.groundLine 一致", RM.groundAlign({ x: 0, y: 0, width: 260, height: 200 }, wa, 26).y, G.groundLine(wa, 200, 26));

// 3) 模式切换必须复用当前窗口所在显示器的 workArea，不得固定 primary display。
function assertDisplayAlignment(name, bounds, displayWorkArea, expected) {
  let receivedBounds = null;
  const matchedWorkArea = G.workAreaOf({
    getDisplayMatching: (input) => {
      receivedBounds = input;
      return { workArea: displayWorkArea };
    }
  }, bounds);
  assertEq(name + " workAreaOf 返回匹配显示器", matchedWorkArea, displayWorkArea);
  assertEq(name + " groundAlign 使用匹配显示器", RM.groundAlign(bounds, matchedWorkArea, 10), expected);
  assertEq(name + " workAreaOf 转发当前 bounds", receivedBounds, bounds);
}

assertDisplayAlignment(
  "主屏",
  { x: 400, y: 200, width: 260, height: 200 },
  { x: 0, y: 0, width: 1920, height: 1040 },
  { x: 400, y: 850 }
);
assertDisplayAlignment(
  "右侧副屏正坐标",
  { x: 2200, y: 200, width: 260, height: 200 },
  { x: 1920, y: 0, width: 2560, height: 1400 },
  { x: 2200, y: 1210 }
);
assertDisplayAlignment(
  "左侧副屏负 X",
  { x: -1500, y: 200, width: 260, height: 200 },
  { x: -1920, y: 0, width: 1920, height: 1080 },
  { x: -1500, y: 890 }
);
assertDisplayAlignment(
  "上方副屏负 Y",
  { x: 100, y: -600, width: 260, height: 200 },
  { x: 0, y: -1200, width: 1920, height: 1160 },
  { x: 100, y: -230 }
);
assertDisplayAlignment(
  "下方副屏正 Y",
  { x: 100, y: 1200, width: 260, height: 200 },
  { x: 0, y: 1080, width: 1920, height: 1440 },
  { x: 100, y: 2330 }
);

// 4) pet:set-size 使用尺寸提交后的最新 bounds，且按当前姿态选择唯一定位规则。
const resizeDefaults = {
  mode: "rig",
  bounds: { x: 2200, y: 200, width: 300, height: 460 },
  wa: { x: 1920, y: 0, width: 2560, height: 1400 },
  groundGap: 0,
  seated: false,
  perched: false,
  dragPaused: false,
  flight: false,
  jump: false,
  transient: false,
  renderModeCommit: true
};
assertEq(
  "pet:set-size 新高度使用最终 bounds 贴地",
  RM.resizeRepositionDecision(resizeDefaults),
  { type: "ground", position: { x: 2200, y: 940 } }
);
assertEq(
  "render-mode Spine 普通 grounded 使用 groundGap",
  RM.resizeRepositionDecision({ ...resizeDefaults, mode: "spine", groundGap: 26, seated: false }),
  { type: "ground", position: { x: 2200, y: 966 } }
);
assertEq(
  "Rig/Live2D 右侧副屏使用当前 workArea",
  RM.resizeRepositionDecision({ ...resizeDefaults, mode: "live2d" }),
  { type: "ground", position: { x: 2200, y: 940 } }
);
assertEq(
  "Rig/Live2D 左侧副屏负坐标使用当前 workArea",
  RM.resizeRepositionDecision({
    ...resizeDefaults,
    mode: "rig",
    bounds: { x: -1500, y: 200, width: 300, height: 460 },
    wa: { x: -1920, y: 0, width: 1920, height: 1080 }
  }),
  { type: "ground", position: { x: -1500, y: 620 } }
);
assertEq(
  "Spine 坐姿走现有 applySeatPosition（保留 seatSink）",
  RM.resizeRepositionDecision({ ...resizeDefaults, mode: "spine", seated: true }),
  { type: "seat" }
);
assertEq(
  "perched 尺寸变化不走普通坐姿重锚",
  RM.resizeRepositionDecision({ ...resizeDefaults, mode: "spine", seated: true, perched: true }),
  { type: "skip" }
);
assertEq(
  "flight/throw 尺寸变化不强制改位置",
  RM.resizeRepositionDecision({ ...resizeDefaults, flight: { vx: 1, vy: 2 } }),
  { type: "skip" }
);
assertEq(
  "ordinary 普通站立尺寸变化不强制贴地",
  RM.resizeRepositionDecision({ ...resizeDefaults, renderModeCommit: false, bounds: { x: 2200, y: 999, width: 300, height: 200 } }),
  { type: "skip" }
);

// 5) ordinary resize 不得把用户手动位置拉到底部；render-mode commit 才使用新尺寸贴地且非 Spine gap=0。
for (const mode of ["gif", "rig", "live2d"]) {
  const visualGap = mode === "gif" ? 26 : 0;
  assertEq(
    `ordinary ${mode} resize 保留用户位置`,
    RM.resizeRepositionDecision({ ...resizeDefaults, mode, renderModeCommit: false, bounds: { x: 400, y: 300, width: 300, height: 460 }, groundGap: 80, gifGroundGap: visualGap }),
    { type: "skip" }
  );
  assertEq(
    `render-mode ${mode} 使用新高度与当前 visual gap`,
    RM.resizeRepositionDecision({ ...resizeDefaults, mode, wa: { x: 0, y: 0, width: 2560, height: 1400 }, bounds: { x: 400, y: 300, width: 300, height: 460 }, groundGap: 80, gifGroundGap: visualGap }),
    { type: "ground", position: { x: 400, y: 940 + visualGap } }
  );
}
assertEq(
  "ordinary Spine seated resize 保留 seat-aware 语义",
  RM.resizeRepositionDecision({ ...resizeDefaults, mode: "spine", renderModeCommit: false, seated: true }),
  { type: "seat" }
);

// 5a) 普通 resize 只对 resize 前已经 grounded 的窗口保持底边锚点。
assertEq("GIF effectiveGroundGap 使用 visual gap=26", RM.effectiveGroundGap("gif", 80, 26), 26);
assertEq("GIF effectiveGroundGap 使用 visual gap=32.5", RM.effectiveGroundGap("gif", 24, 32.5), 32.5);
assertEq("GIF effectiveGroundGap 使用 visual gap=19.5", RM.effectiveGroundGap("gif", 24, 19.5), 19.5);
assertEq("Rig effectiveGroundGap 仍为 0", RM.effectiveGroundGap("rig", 80, 32.5), 0);
assertEq("Live2D effectiveGroundGap 仍为 0", RM.effectiveGroundGap("live2d", 80, 32.5), 0);
assertEq("Spine effectiveGroundGap 保留合法 gap", RM.effectiveGroundGap("spine", 26, 32.5), 26);
assertEq(
  "GIF resize 前按 visual gap grounded",
  RM.wasGroundAnchored({
    mode: "gif",
    bounds: { x: 400, y: 966, width: 300, height: 460 },
    wa: { x: 0, y: 0, width: 2560, height: 1400 },
    groundGap: 80,
    gifGroundGap: 26
  }),
  true
);
assertEq(
  "GIF 自由放置不是 grounded",
  RM.wasGroundAnchored({
    mode: "gif",
    bounds: { x: 400, y: 300, width: 300, height: 460 },
    wa: { x: 0, y: 0, width: 2560, height: 1400 },
    groundGap: 80
  }),
  false
);
assertEq(
  "Spine 坐姿 grounded 包含 seatSink",
  RM.wasGroundAnchored({
    mode: "spine",
    bounds: { x: 400, y: 986, width: 300, height: 460 },
    wa: { x: 0, y: 0, width: 2560, height: 1400 },
    groundGap: 26,
    seated: true,
    seatSink: 20
  }),
  true
);
for (const mode of ["gif", "rig", "live2d"]) {
  assertEq(
    `${mode} grounded resize 保持新底边 anchor`,
    RM.resizeRepositionDecision({
      ...resizeDefaults,
      mode,
      wa: { x: 0, y: 0, width: 2560, height: 1400 },
      bounds: { x: 400, y: 940, width: 300, height: 640 },
      groundGap: 80,
      renderModeCommit: false,
      wasGroundAnchored: true
    }),
    { type: "ground", position: { x: 400, y: 760 } }
  );
}
assertEq(
  "free placement ordinary resize 不被拉到底部",
  RM.resizeRepositionDecision({
    ...resizeDefaults,
    mode: "gif",
    bounds: { x: 400, y: 300, width: 300, height: 640 },
    renderModeCommit: false,
    wasGroundAnchored: false
  }),
  { type: "skip" }
);
assertEq(
  "transient grounded resize 仍跳过",
  RM.resizeRepositionDecision({
    ...resizeDefaults,
    mode: "gif",
    bounds: { x: 400, y: 940, width: 300, height: 640 },
    renderModeCommit: false,
    wasGroundAnchored: true,
    transient: true
  }),
  { type: "skip" }
);

// 5b) wasGroundAnchored 的 8px tolerance 明确固定：边界内接受，9px 起拒绝。
const anchorWa = { x: 0, y: 0, width: 2560, height: 1400 };
for (const delta of [0, 1, 4, 8]) {
  assertEq(
    `wasGroundAnchored Δ=${delta} → true`,
    RM.wasGroundAnchored({ mode: "gif", bounds: { x: 400, y: 966 + delta, width: 300, height: 460 }, wa: anchorWa, groundGap: 80, gifGroundGap: 26 }),
    true
  );
}
for (const delta of [9, 20]) {
  assertEq(
    `wasGroundAnchored Δ=${delta} → false`,
    RM.wasGroundAnchored({ mode: "gif", bounds: { x: 400, y: 966 + delta, width: 300, height: 460 }, wa: anchorWa, groundGap: 80, gifGroundGap: 26 }),
    false
  );
}
assertEq(
  "Spine seated 正确包含 seatSink",
  RM.wasGroundAnchored({ mode: "spine", bounds: { x: 400, y: 986, width: 300, height: 460 }, wa: anchorWa, groundGap: 26, seated: true, seatSink: 20 }),
  true
);
assertEq(
  "Spine seated 少算 seatSink → false",
  RM.wasGroundAnchored({ mode: "spine", bounds: { x: 400, y: 986, width: 300, height: 460 }, wa: anchorWa, groundGap: 26, seated: true, seatSink: 0 }),
  false
);

// 6) GIF/Spine geometry report 分开保存，并拒绝 stale / 错模式身份。
const gifReport26 = RM.groundGapReportDecision({
  mode: "gif", sourceMode: "gif", current: 24, gifCurrent: 0, px: 26,
  geometryRevision: 1, renderGeneration: 10
});
assert.equal(gifReport26.accepted, true, "GIF 26 report accepted");
assert.equal(gifReport26.target, "gif");
assert.equal(gifReport26.value, 26);
const gifReport325 = RM.groundGapReportDecision({
  mode: "gif", sourceMode: "gif", current: 24, gifCurrent: gifReport26.value, px: 32.5,
  geometryRevision: 2, renderGeneration: 10, lastReport: gifReport26.identity
});
assert.equal(gifReport325.value, 32.5, "GIF 32.5 report preserved as visual gap");
const gifReport195 = RM.groundGapReportDecision({
  mode: "gif", sourceMode: "gif", current: 24, gifCurrent: gifReport325.value, px: 19.5,
  geometryRevision: 3, renderGeneration: 10, lastReport: gifReport325.identity
});
assert.equal(gifReport195.value, 19.5, "GIF 19.5 report preserved as visual gap");
const spineReport24 = RM.groundGapReportDecision({
  mode: "spine", sourceMode: "spine", current: 0, gifCurrent: gifReport195.value, px: 24,
  renderGeneration: 20
});
assert.equal(spineReport24.value, 24, "Spine report keeps Spine gap");
assert.equal(gifReport195.value, 19.5, "Spine report does not change GIF gap");
assert.equal(RM.groundGapReportDecision({
  mode: "rig", sourceMode: "rig", current: 0, gifCurrent: 32.5, px: 80,
  renderGeneration: 30
}).accepted, false, "Rig report rejected");
assert.equal(RM.groundGapReportDecision({
  mode: "live2d", sourceMode: "live2d", current: 12, gifCurrent: 32.5, px: 80,
  renderGeneration: 31
}).accepted, false, "Live2D report rejected");
assert.equal(RM.groundGapReportDecision({
  mode: "gif", sourceMode: "spine", current: 0, gifCurrent: 32.5, px: 80,
  geometryRevision: 4, renderGeneration: 32
}).accepted, false, "错 mode report rejected");
assert.equal(RM.groundGapReportDecision({
  mode: "gif", sourceMode: "gif", current: 0, gifCurrent: 32.5, px: 80,
  geometryRevision: 1, renderGeneration: 10, lastReport: gifReport325.identity
}).accepted, false, "stale GIF report rejected");

// 6a) GIF visual gap 变化时，只有 resize 前 grounded 才重新保持可见脚底地面线。
const gifWa = { x: 0, y: 0, width: 1920, height: 912 };
const gifGroundedBounds = { x: 500, y: 688, width: 260, height: 250 }; // bottom=938=912+26
assert.equal(
  RM.wasGroundAnchored({ mode: "gif", bounds: gifGroundedBounds, wa: gifWa, groundGap: 24, gifGroundGap: 26 }),
  true,
  "GIF old gap=26 grounded"
);
assertEq(
  "GIF gap 26→32.5 reanchor 到新 visual ground line",
  RM.groundAlign(gifGroundedBounds, gifWa, RM.effectiveGroundGap("gif", 24, 32.5)),
  { x: 500, y: 695 }
);
assert.equal(
  RM.wasGroundAnchored({ mode: "gif", bounds: { ...gifGroundedBounds, y: 300 }, wa: gifWa, groundGap: 24, gifGroundGap: 26 }),
  false,
  "GIF free placement gap update 不视为 grounded"
);
assertEq(
  "GIF restore 32.5→19.5 reanchor",
  RM.groundAlign({ ...gifGroundedBounds, y: 695 }, gifWa, RM.effectiveGroundGap("gif", 24, 19.5)),
  { x: 500, y: 682 }
);

// 7) 模式切换不再有立即/2500ms 位置回写；尺寸回调只接受当前 revision。
const modeChangeBlockStart = mainSource.indexOf("function dispatchRenderModeIntent");
const modeChangeBlockEnd = mainSource.indexOf("/** §14 追加 102", modeChangeBlockStart);
const modeChangeBlock = mainSource.slice(modeChangeBlockStart, modeChangeBlockEnd);
assert.ok(modeChangeBlockStart >= 0 && modeChangeBlockEnd > modeChangeBlockStart, "模式切换处理块存在");
assert.doesNotMatch(modeChangeBlock, /setPosition\(|setTimeout\(|groundAlign\(/, "模式切换处理块不再直接贴地或延迟贴地");
assert.doesNotMatch(mainSource, /2500/, "不存在旧 2500ms delayed groundAlign");
assert.match(modeChangeBlock, /windowSizeRevision\.next\(\); \/\/ 旧模式的 150ms 尺寸回调不得回写新模式/, "模式切换使旧尺寸回调失效");
assert.match(mainSource, /let renderModeSeq = 0/, "main 持有单调 renderModeSeq");
assert.match(mainSource, /sendToRenderer\("pet:render-mode-changed", request\)/, "main→renderer 发送 versioned request");
assert.match(mainSource, /delete ordinaryPatch\.renderMode/, "renderMode intent 不提前持久化");
assert.match(mainSource, /renderModeOutcomeDecision\(/, "main 校验 renderer outcome");
assert.match(renderModeSource, /msg\.seq !== currentSeq/, "旧 seq outcome 被拒绝");
assert.match(preloadSource, /reportRenderModeOutcome: \(outcome\) => ipcRenderer\.send\("pet:render-mode-outcome", outcome\)/, "renderer→main outcome bridge");
assert.match(preloadSource, /reportRenderModeCorrection: \(correction\) => ipcRenderer\.send\("pet:render-mode-correction", correction\)/, "internal correction bridge");
assert.match(settingsSource, /onRenderModeOutcome/, "settings listens for accepted outcome");
assert.match(settingsSource, /outcome\.requestedMode !== committed/, "settings distinguishes fallback from success");
assert.match(settingsSource, /已切换并保存 ✓/, "settings shows success only after outcome");
assert.match(settingsSource, /已回退到 GIF/, "settings shows fallback correction");
assert.match(settingsSource, /correctionSourceMode/, "settings preserves correction-derived UI context");
assert.match(settingsSource, /function ensureRigSkinForMode\(\)/, "settings has a narrow Rig resource precheck");
assert.match(settingsSource, /renderer 仍保留真实 init failure \+ GIF fallback/, "precheck is UX-only");
assert.match(rendererSource, /reportRenderModeCorrection\(baseSeq, sourceMode, result/, "internal fallback reports correction");
assert.match(rendererSource, /result\.status !== "ready" && result\.status !== "noop"/, "formal outcome accepts ready and noop");
assert.match(rendererSource, /mainSeq < currentMainRenderModeSeq/, "stale formal request cannot report a noop");
assert.match(rendererSource, /if \(result\.status === "superseded"\)/, "formal superseded result has reconciliation path");
assert.match(rendererSource, /renderSwitchStatus === "ready" && renderRuntimeReady/, "superseded reconciliation requires stable ready owner");
assert.match(rendererSource, /activeRenderMode === mode && requestedRenderMode === mode/, "superseded reconciliation requires target mode ownership");
assert.match(mainSource, /renderModeMod\.isCurrentRenderSender\(event\.sender, win\.webContents\)/, "main validates current pet renderer sender");
assert.match(mainSource, /bumpRenderModeIntentForRecovery\(\)/, "renderer recovery creates a new formal intent identity");
assert.match(mainSource, /renderModeMod\.renderModeOf\(config\.getConfig\(\)\.renderMode\)/, "recovery uses committed config mode");
const correctionBlockStart = mainSource.indexOf('ipcMain.on("pet:render-mode-correction"');
const correctionBlockEnd = mainSource.indexOf('ipcMain.handle("pet:save-persona"', correctionBlockStart);
const correctionBlock = mainSource.slice(correctionBlockStart, correctionBlockEnd);
assert.ok(correctionBlockStart >= 0 && correctionBlockEnd > correctionBlockStart, "internal correction handler exists");
assert.match(correctionBlock, /renderModeCorrectionDecision\(/, "main validates internal correction");
assert.match(correctionBlock, /dispatchRenderModeIntent\("gif"\)/, "correction starts a formal GIF intent");
assert.doesNotMatch(correctionBlock, /config\.saveConfig\(/, "correction does not write config directly");
const reloadBlock = mainSource.slice(mainSource.indexOf('ipcMain.handle("pet:reload-renderer"'), mainSource.indexOf('app.whenReady()'));
assert.match(reloadBlock, /bumpRenderModeIntentForRecovery\(\)/, "manual reload bumps seq before reload");
assert.match(mainSource, /bumpRenderModeIntentForRecovery\(\);\n      win\.reload\(\)/, "render-process-gone recovery bumps seq");
const recoveryHelperStart = mainSource.indexOf("function bumpRenderModeIntentForRecovery");
const recoveryHelperEnd = mainSource.indexOf("/** §14 追加 102", recoveryHelperStart);
const recoveryHelper = mainSource.slice(recoveryHelperStart, recoveryHelperEnd);
assert.doesNotMatch(recoveryHelper, /sendToRenderer|syncWalkingEngine|saveConfig|refreshTrayMenu|walk\./,
  "recovery identity helper has no renderer/UI/walking side effects");
assert.match(mainSource, /const correctionMeta = renderModeCorrectionMeta && renderModeCorrectionMeta\.seq === decision\.seq/, "accepted correction metadata is matched by formal seq");
assert.match(mainSource, /correctionSourceMode: correctionMeta\.sourceMode/, "accepted correction context reaches settings");
assert.match(mainSource, /sendToRenderer\("pet:toast", renderModeFallbackToast\(correctionMeta\.sourceMode\)\)/, "accepted correction uses source-mode fallback toast");
assert.match(mainSource, /source === "render-mode"/, "主进程区分 render-mode resize 来源");
assert.match(mainSource, /groundGapReportDecision\(/, "ground-gap handler 使用 mode guard 决策");
assert.match(mainSource, /let gifVisualGroundGap = 0/, "GIF visual gap 有独立安全初值");
assert.match(mainSource, /sourceMode: meta && meta\.sourceMode/, "ground-gap handler 校验 source mode");
assert.match(mainSource, /geometryRevision: meta && meta\.geometryRevision/, "ground-gap handler 接收 geometry revision");
assert.match(mainSource, /lastReport: lastGroundGapReports\[mode\]/, "ground-gap handler 拒绝旧 report identity");
assert.match(mainSource, /gifVisualGroundGap = report\.value/, "GIF report 不写入 Spine walk.groundGap");
assert.match(mainSource, /if \(report\.changed && wasGrounded\) repositionAfterWindowSizeChange\(false, true\)/, "GIF grounded gap 更新后立即 reanchor");
assert.match(mainSource, /if \(decision\.type === "seat"\) \{\s*applySeatPosition\(\);/, "Spine 坐姿尺寸提交调用 applySeatPosition");
assert.match(mainSource, /const targetY = walk\.seated \? baseY \+ effectiveSeatSink\(\) : baseY/, "坐姿仍保留 seatSink");
assert.match(preloadSource, /setSize: \(w, h, source\) => ipcRenderer\.send\("pet:set-size", w, h, source\)/, "现有 preload bridge 透传可选 resize source");
const commitStart = rendererSource.indexOf("function commitRenderMode");
const commitEnd = rendererSource.indexOf("async function switchRenderMode", commitStart);
const commitBlock = rendererSource.slice(commitStart, commitEnd);
assert.equal((commitBlock.match(/setSize\([^\n]+"render-mode"\)/g) || []).length, 4, "四态 commitRenderMode 均标记 render-mode source");
const groundGapBlockStart = mainSource.indexOf('ipcMain.on("pet:set-ground-gap"');
const groundGapBlockEnd = mainSource.indexOf('ipcMain.on("pet:set-char-inset"', groundGapBlockStart);
const groundGapBlock = mainSource.slice(groundGapBlockStart, groundGapBlockEnd);
assert.match(groundGapBlock, /walk\.seated\) applySeatPosition\(\)/, "Spine late groundGap 仍按最新 gap 重锚当前坐姿");
assert.match(groundGapBlock, /report\.target === "gif"/, "GIF late groundGap 走独立分支");
assertSetSizeWiring();
assertSetScaleWiring();
assertSitOnTaskbarWiring();
assertOutOfScreenGuardWiring();

// B-2 主进程协议行为夹具：直接执行 production handler block，覆盖 sender、seq、
// correction metadata 与正式 outcome 的收敛边界，而不是只依赖 source regex。
function createMainRenderModeProtocolHarness({ seq = 40, intent = "rig", configMode = intent } = {}) {
  const currentSender = { id: "current-pet-renderer" };
  const otherSender = { id: "old-pet-renderer" };
  const handlers = {};
  const saves = [];
  const settingsMessages = [];
  const rendererMessages = [];
  const dispatches = [];
  const logs = [];
  let trayRefreshes = 0;
  let walkingSyncs = 0;
  let persistedMode = configMode;
  const ipcMain = { on: (channel, handler) => { handlers[channel] = handler; } };
  const config = {
    getConfig: () => ({ renderMode: persistedMode }),
    saveConfig: (patch) => {
      saves.push({ ...patch });
      if (patch && Object.prototype.hasOwnProperty.call(patch, "renderMode")) persistedMode = patch.renderMode;
    }
  };
  const settingsWin = {
    isDestroyed: () => false,
    webContents: { send: (channel, payload) => settingsMessages.push({ channel, payload }) }
  };
  const renderModeFallbackToast = (mode) => mode === "rig"
    ? "2.5D 资源不可用，已回退到 GIF"
    : mode === "live2d"
      ? "Live2D 初始化失败，已回退到 GIF"
      : mode === "spine"
        ? "Spine 初始化失败，已回退到 GIF"
        : "渲染模式初始化失败，已回退到 GIF";
  const registered = new Function(
    "ipcMain", "renderModeMod", "isCurrentPetRendererSender", "config", "refreshTrayMenu",
    "syncWalkingEngine", "settingsWin", "sendToRenderer", "logTts", "renderModeFallbackToast",
    `
      let renderModeSeq = ${seq};
      let renderModeIntentMode = ${JSON.stringify(intent)};
      let renderModeCorrectionMeta = null;
      const dispatches = [];
      function dispatchRenderModeIntent(mode) {
        renderModeCorrectionMeta = null;
        const request = { mode: renderModeMod.renderModeOf(mode), seq: ++renderModeSeq };
        renderModeIntentMode = request.mode;
        dispatches.push(request);
        return request;
      }
      ${sourceBlock(mainSource, 'ipcMain.on("pet:render-mode-outcome"', 'ipcMain.on("pet:render-mode-correction"', "protocol outcome")}
      ${sourceBlock(mainSource, 'ipcMain.on("pet:render-mode-correction"', 'ipcMain.handle("pet:save-persona"', "protocol correction")}
      return {
        getSeq: () => renderModeSeq,
        getIntent: () => renderModeIntentMode,
        getCorrectionMeta: () => renderModeCorrectionMeta,
        dispatches
      };
    `
  )(
    ipcMain,
    RM,
    (event) => !!event && event.sender === currentSender,
    config,
    () => { trayRefreshes += 1; },
    () => { walkingSyncs += 1; },
    settingsWin,
    (channel, payload) => rendererMessages.push({ channel, payload }),
    (...args) => logs.push(args),
    renderModeFallbackToast
  );
  return {
    handlers,
    currentSender,
    otherSender,
    saves,
    settingsMessages,
    rendererMessages,
    dispatches: registered.dispatches,
    logs,
    get trayRefreshes() { return trayRefreshes; },
    get walkingSyncs() { return walkingSyncs; },
    get persistedMode() { return persistedMode; },
    get seq() { return registered.getSeq(); },
    get intent() { return registered.getIntent(); },
    get correctionMeta() { return registered.getCorrectionMeta(); }
  };
}

const m1 = createMainRenderModeProtocolHarness({ seq: 40, intent: "rig", configMode: "rig" });
m1.handlers["pet:render-mode-correction"]({ sender: m1.currentSender }, {
  baseSeq: 40, sourceMode: "rig", committedMode: "gif", error: "missing rig asset"
});
assertEq("M1 current correction 只创建一个正式 GIF intent", m1.dispatches, [{ mode: "gif", seq: 41 }]);
assertEq("M1 correction 不直接写 config", m1.saves, []);

const m2 = createMainRenderModeProtocolHarness({ seq: 40, intent: "rig", configMode: "rig" });
m2.handlers["pet:render-mode-correction"]({ sender: m2.otherSender }, {
  baseSeq: 40, sourceMode: "rig", committedMode: "gif"
});
assertEq("M2 非当前 sender 不 dispatch", m2.dispatches, []);
assertEq("M2 非当前 sender 不写 config", m2.saves, []);

const m3 = createMainRenderModeProtocolHarness({ seq: 40, intent: "rig", configMode: "rig" });
m3.handlers["pet:render-mode-correction"]({ sender: m3.currentSender }, {
  baseSeq: 39, sourceMode: "rig", committedMode: "gif"
});
assertEq("M3 stale baseSeq 不 dispatch", m3.dispatches, []);

const m4 = createMainRenderModeProtocolHarness({ seq: 40, intent: "rig", configMode: "rig" });
m4.handlers["pet:render-mode-correction"]({ sender: m4.currentSender }, {
  baseSeq: 40, sourceMode: "rig", committedMode: "gif", error: "missing rig asset"
});
m4.handlers["pet:render-mode-outcome"]({ sender: m4.currentSender }, {
  seq: 41, requestedMode: "gif", committedMode: "gif", ok: true
});
assertEq("M4 correction-derived GIF outcome 持久化 committed mode", m4.persistedMode, "gif");
assertEq("M4 correction-derived GIF outcome 只保存一次", m4.saves, [{ renderMode: "gif" }]);
assertEq("M4 correction-derived outcome 刷新 tray 与 walking", [m4.trayRefreshes, m4.walkingSyncs], [1, 1]);
assertEq("M4 settings 收到 source marker", m4.settingsMessages[0] && m4.settingsMessages[0].payload.correctionSourceMode, "rig");
assertEq("M4 correction metadata 被消费", m4.correctionMeta, null);
assertEq("M4 correction 使用 source-specific toast", m4.rendererMessages, [
  { channel: "pet:toast", payload: "2.5D 资源不可用，已回退到 GIF" }
]);

const m5 = createMainRenderModeProtocolHarness({ seq: 40, intent: "rig", configMode: "rig" });
const repeatedCorrection = { baseSeq: 40, sourceMode: "rig", committedMode: "gif" };
m5.handlers["pet:render-mode-correction"]({ sender: m5.currentSender }, repeatedCorrection);
m5.handlers["pet:render-mode-correction"]({ sender: m5.currentSender }, repeatedCorrection);
assertEq("M5 repeated correction 只创建一个正式 GIF intent", m5.dispatches, [{ mode: "gif", seq: 41 }]);

const staleOutcome = createMainRenderModeProtocolHarness({ seq: 8, intent: "gif", configMode: "rig" });
staleOutcome.handlers["pet:render-mode-outcome"]({ sender: staleOutcome.currentSender }, {
  seq: 7, requestedMode: "gif", committedMode: "gif", ok: true
});
assertEq("R3 stale outcome 不收敛 config", staleOutcome.saves, []);

const wrongOutcome = createMainRenderModeProtocolHarness({ seq: 8, intent: "gif", configMode: "rig" });
wrongOutcome.handlers["pet:render-mode-outcome"]({ sender: wrongOutcome.otherSender }, {
  seq: 8, requestedMode: "gif", committedMode: "gif", ok: true
});
assertEq("R4 old renderer outcome 不收敛 config", wrongOutcome.saves, []);

const ordinaryGifNoop = createMainRenderModeProtocolHarness({ seq: 8, intent: "gif", configMode: "gif" });
ordinaryGifNoop.handlers["pet:render-mode-outcome"]({ sender: ordinaryGifNoop.currentSender }, {
  seq: 8, requestedMode: "gif", committedMode: "gif", ok: true
});
assert.equal(Object.prototype.hasOwnProperty.call(ordinaryGifNoop.settingsMessages[0].payload, "correctionSourceMode"), false,
  "ordinary GIF→GIF noop 不携带 fallback source marker");
assertEq("ordinary GIF→GIF noop 不产生 fallback toast", ordinaryGifNoop.rendererMessages, []);

let recoverySeq = 20;
let recoveryIntent = "live2d";
let recoveryBeginCalls = [];
const recoveryFn = new Function(
  "beginRenderModeIntent", "renderModeMod", "config",
  `${recoveryHelper}; return bumpRenderModeIntentForRecovery;`
)(
  (mode) => {
    recoverySeq += 1;
    recoveryIntent = mode;
    recoveryBeginCalls.push(mode);
    return { mode, seq: recoverySeq };
  },
  RM,
  { getConfig: () => ({ renderMode: "rig" }) }
);
assertEq("R1 recovery helper 只 bump 到 committed mode", recoveryFn(), { mode: "rig", seq: 21 });
assertEq("R1 recovery helper 只调用一次 begin", recoveryBeginCalls, ["rig"]);
assertEq("R1 recovery helper 更新 intent identity", [recoverySeq, recoveryIntent], [21, "rig"]);

const recoveryStartup = new Function(
  "renderModeMod", "config",
  `
    let renderModeSeq = 20;
    let renderModeIntentMode = "live2d";
    function beginRenderModeIntent(mode) {
      const normalized = renderModeMod.renderModeOf(mode);
      renderModeSeq += 1;
      renderModeIntentMode = normalized;
      return { mode: normalized, seq: renderModeSeq };
    }
    ${recoveryHelper}
    ${sourceBlock(mainSource, "function ensureRenderModeRequest", "function renderModeFallbackToast", "ensureRenderModeRequest")}
    const recovery = bumpRenderModeIntentForRecovery();
    const startup = ensureRenderModeRequest("gif");
    return { recovery, startup };
  `
)(RM, { getConfig: () => ({ renderMode: "rig" }) });
assertEq("R2 reload 后 startup get-state 复用 N+1", recoveryStartup, {
  recovery: { mode: "rig", seq: 21 }, startup: { mode: "rig", seq: 21 }
});
assert.equal(/walk\.|syncWalkingEngine|dragPaused|chatPaused|zoomPaused/.test(recoveryHelper), false,
  "R5 recovery helper 不修改 walking pause");

const spineSkinDispatches = [];
const spineSkinMessages = [];
const setSpineSkinForTest = new Function(
  "config", "renderModeIntentMode", "dispatchRenderModeIntent", "refreshTrayMenu", "sendToRenderer", "logTts",
  `${sourceBlock(mainSource, "function setSpineSkin(id)", "/** 皮肤三层菜单", "setSpineSkin")}; return setSpineSkin;`
)(
  {
    getConfig: () => ({ renderMode: "spine", spineSkinId: "" }),
    saveConfig: () => {}
  },
  "live2d",
  (mode) => spineSkinDispatches.push({ mode, seq: 22 }),
  () => {},
  (channel, payload) => spineSkinMessages.push({ channel, payload }),
  () => {}
);
setSpineSkinForTest("builtin");
assertEq("T8 Spine skin 在 pending Live2D intent 下创建正式 Spine intent", spineSkinDispatches, [{ mode: "spine", seq: 22 }]);
assertEq("T8 不向 pending Live2D 发送无 seq Spine reskin", spineSkinMessages, []);

function renderModeListenerBlock(source = rendererSource) {
  return sourceBlock(source, "if (window.petAPI.onRenderModeChanged)", "if (window.petAPI.onLive2dChanged)", "render-mode listener");
}
function assertReconciliationHelperWiring(source = rendererSource) {
  const block = sourceBlock(source, "async function reconcileFormalRenderMode", "if (window.petAPI.onUiEdgeCompact)", "formal reconciliation helper");
  assert.match(block, /while \(currentMainRenderModeSeq === mainSeq\)/);
  assert.match(block, /const ownerPromise = currentRenderSwitchPromise/);
  assert.match(block, /await ownerPromise/);
  assert.match(block, /if \(currentMainRenderModeSeq !== mainSeq\) return false/);
  assert.match(block, /isStableFormalRenderMode\(mode, mainSeq\)/);
  assert.match(block, /currentRenderSwitchPromise !== ownerPromise/);
  assert.match(block, /reportRenderModeOutcome\(mainSeq, mode/);
}
function assertPostGetStateReconciliation(source = rendererSource) {
  const block = renderModeListenerBlock(source);
  assert.match(block, /let state = null;[\s\S]*if \(!isCurrentModeRequest\(\)\) \{\s*await reconcileFormalRenderMode\(mode, mainSeq\);/);
}
function assertSpineEnteringUsesIntent(source = mainSource) {
  const block = sourceBlock(source, "function setSpineSkin(id)", "/** 皮肤三层菜单", "setSpineSkin");
  assert.match(block, /const enteringSpine = renderModeIntentMode !== "spine";/);
}
function assertSpineModeGuard(source = rendererSource) {
  const block = sourceBlock(source, "async function rebuildSpine()", "if (window.petAPI.onSpineSkinChanged)", "Spine rebuild guard");
  assert.match(block, /if \(activeRenderMode !== "spine" && requestedRenderMode !== "spine"\)/);
}
function assertStableFormalOwnerGuard(source = rendererSource) {
  const block = sourceBlock(source, "function isStableFormalRenderMode", "if (window.petAPI.onUiEdgeCompact)", "stable formal owner guard");
  assert.match(block, /renderSwitchStatus === "ready"/);
  assert.match(block, /renderRuntimeReady/);
  assert.match(block, /renderRuntimeResource/);
  assert.match(block, /activeRenderMode === mode/);
  assert.match(block, /requestedRenderMode === mode/);
}
function assertRecoveryHelperPure(source = mainSource) {
  const block = sourceBlock(source, "function bumpRenderModeIntentForRecovery", "/** §14 追加 102", "recovery helper");
  assert.match(block, /beginRenderModeIntent\(/);
  assert.doesNotMatch(block, /sendToRenderer|syncWalkingEngine|saveConfig|refreshTrayMenu|walk\./);
}
function assertCorrectionMetadataWiring(source = mainSource) {
  const block = sourceBlock(source, 'ipcMain.on("pet:render-mode-correction"', 'ipcMain.handle("pet:save-persona"', "correction metadata");
  assert.match(block, /renderModeCorrectionMeta = \{ seq: request\.seq, sourceMode: decision\.sourceMode \}/);
  assert.doesNotMatch(block, /config\.saveConfig\(/);
  const outcome = sourceBlock(source, 'ipcMain.on("pet:render-mode-outcome"', 'ipcMain.on("pet:render-mode-correction"', "outcome metadata");
  assert.match(outcome, /correctionMeta\.sourceMode/);
  assert.match(outcome, /renderModeCorrectionMeta = null/);
}

// B-2 mutation matrix：每个新 guard 都必须能被对应的行为/结构断言抓住。
const removePostGetStateReconciliation = (source) => source.replace(
  '    if (!isCurrentModeRequest()) {\n      await reconcileFormalRenderMode(mode, mainSeq);\n      return;\n    }\n    if (!result.fallback) {',
  '    if (!isCurrentModeRequest()) return;\n    if (!result.fallback) {'
);
const removeOwnerLoop = (source) => source.replace(
  "  while (currentMainRenderModeSeq === mainSeq) {",
  "  if (currentMainRenderModeSeq === mainSeq) {"
);
const removePostAwaitMainSeqGuard = (source) => source.replace(
  "    if (currentMainRenderModeSeq !== mainSeq) return false;\n",
  ""
);
const removeActiveFormalModeGuard = (source) => source.replace(
  "    !!renderRuntimeResource && activeRenderMode === mode && requestedRenderMode === mode;",
  "    !!renderRuntimeResource && requestedRenderMode === mode;"
);
const revertSpineEnteringToConfig = (source) => source.replace(
  'const enteringSpine = renderModeIntentMode !== "spine";',
  'const enteringSpine = config.getConfig().renderMode !== "spine";'
);
const removeSpineModeGuard = (source) => source.replace(
  'async function rebuildSpine() {\n  if (activeRenderMode !== "spine" && requestedRenderMode !== "spine") {\n    return { status: "ignored" };\n  }',
  "async function rebuildSpine() {"
);
const addRecoveryBroadcast = (source) => source.replace(
  "  return beginRenderModeIntent(renderModeMod.renderModeOf(config.getConfig().renderMode));",
  "  const request = beginRenderModeIntent(renderModeMod.renderModeOf(config.getConfig().renderMode));\n  sendToRenderer(\"pet:render-mode-changed\", request);\n  return request;"
);
const removeRecoveryBump = (source) => source.replace(
  "  return beginRenderModeIntent(renderModeMod.renderModeOf(config.getConfig().renderMode));",
  "  return { mode: renderModeIntentMode, seq: renderModeSeq };"
);
const loseCorrectionMetadata = (source) => source.replace(
  "  renderModeCorrectionMeta = { seq: request.seq, sourceMode: decision.sourceMode };",
  "  renderModeCorrectionMeta = null;"
);
const addCorrectionConfigWrite = (source) => source.replace(
  "  // correction 只重新发起正式 GIF intent；config/settings/tray 仍由正式 outcome 单一收敛。",
  "  config.saveConfig({ renderMode: \"gif\" });\n  // correction 只重新发起正式 GIF intent；config/settings/tray 仍由正式 outcome 单一收敛。"
);
expectMutationToFail("MUT-1", removePostGetStateReconciliation, assertPostGetStateReconciliation);
expectMutationToFail("MUT-2", removeOwnerLoop, assertReconciliationHelperWiring);
expectMutationToFail("MUT-3", removePostAwaitMainSeqGuard, assertReconciliationHelperWiring);
expectMutationToFail("MUT-4", removeActiveFormalModeGuard, assertStableFormalOwnerGuard);
expectMutationToFail("MUT-5", revertSpineEnteringToConfig, assertSpineEnteringUsesIntent);
expectMutationToFail("MUT-6", removeSpineModeGuard, assertSpineModeGuard);

const sitFractional = createSitOnTaskbarHarness({ gap: 19.5 });
sitFractional.run();
assertEq("sitOnTaskbar GIF gap=19.5 native y=782", sitFractional.calls[0], { type: "setPosition", x: 638, y: 782 });
assert.equal(Number.isInteger(sitFractional.calls[0].y), true, "sitOnTaskbar fractional y 不抛异常且传入整数");

const sitFractionalLarge = createSitOnTaskbarHarness({ gap: 32.5, bounds: { x: 638, y: 600, width: 325, height: 250 } });
sitFractionalLarge.run();
assertEq("sitOnTaskbar GIF gap=32.5 native y=695", sitFractionalLarge.calls[0].y, 695);
assert.equal(Math.abs((sitFractionalLarge.bounds.y + sitFractionalLarge.bounds.height - 32.5) - 912), 0.5, "sitOnTaskbar gap=32.5 视觉地面误差不超过 0.5px");

const sitInteger = createSitOnTaskbarHarness({ gap: 26, bounds: { x: 638, y: 600, width: 260, height: 200 } });
sitInteger.run();
assertEq("sitOnTaskbar GIF gap=26 保持原整数 y", sitInteger.calls[0].y, 738);

const sitNegativeDisplay = createSitOnTaskbarHarness({
  gap: 32.5,
  bounds: { x: -300, y: 0, width: 195, height: 150 },
  workArea: { x: -1920, y: -100, width: 1920, height: 1080 }
});
sitNegativeDisplay.run();
assertEq("sitOnTaskbar 负坐标显示器 native 坐标仍为整数", sitNegativeDisplay.calls[0], { type: "setPosition", x: -300, y: 863 });

const scaleSequence = createScaleHarness({ width: 260, height: 200, resizable: false });
scaleSequence.setScale(1.25);
assertEq("setScale 260×200 → 325×250", { width: scaleSequence.bounds.width, height: scaleSequence.bounds.height }, { width: 325, height: 250 });
const firstSetSizeIndex = scaleSequence.calls.findIndex((call) => call.type === "setSize");
const firstEnableIndex = scaleSequence.calls.findIndex((call) => call.type === "setResizable" && call.value === true);
const firstNotifyIndex = scaleSequence.calls.findIndex((call) => call.type === "notify");
assert.ok(firstEnableIndex >= 0 && firstEnableIndex < firstSetSizeIndex, "setScale shrink/resize 前开启 resizable");
assert.ok(firstNotifyIndex > firstSetSizeIndex, "setScale native resize 后才通知 renderer");
scaleSequence.runCallback();
assertEq("setScale callback 最终恢复 false", scaleSequence.resizable, false);
scaleSequence.setScale(0.75);
assertEq("setScale 325×250 → 195×150", { width: scaleSequence.bounds.width, height: scaleSequence.bounds.height }, { width: 195, height: 150 });
scaleSequence.runCallback();
assertEq("setScale shrink 后最终恢复 false", scaleSequence.resizable, false);

const staleScale = createScaleHarness({ width: 260, height: 200, resizable: false });
staleScale.setScale(1.25);
staleScale.setScale(0.75);
const staleBoundsBeforeCallback = staleScale.bounds;
const staleCallStart = staleScale.calls.length;
staleScale.runCallback(0);
assertEq("stale setScale callback 不改后续 bounds", staleScale.bounds, staleBoundsBeforeCallback);
assertEq("stale setScale callback 不留下 resizable=true", staleScale.resizable, false);
assert.equal(staleScale.calls.slice(staleCallStart).some((call) => call.type === "clamp" || call.type === "reposition"), false, "stale setScale callback 不执行定位");
staleScale.runCallback(1);
assertEq("current setScale callback 最终恢复 false", staleScale.resizable, false);

const dragStart = mainSource.indexOf("function dragSeatUpdate");
const dragEnd = mainSource.indexOf("/* ---------- 桌面行走 v2", dragStart);
const dragBlock = mainSource.slice(dragStart, dragEnd);
assert.doesNotMatch(dragBlock, /[+\-]\s*walk\.groundGap/, "dragSeatUpdate 不直接消费 raw groundGap");
assert.match(dragBlock, /win\.setPosition\(Math\.round\(nx\), Math\.round\(ny\)\);/, "dragSeatUpdate native 坐标归一化");

const groundReportStart = rendererSource.indexOf("function reportGroundGap");
const groundReportEnd = rendererSource.indexOf("function scheduleGeometryReport", groundReportStart);
const groundReportBlock = rendererSource.slice(groundReportStart, groundReportEnd);
assert.match(groundReportBlock, /activeRenderMode === "gif"/);
assert.match(groundReportBlock, /window\.innerHeight - petEl\.getBoundingClientRect\(\)\.bottom/, "GIF visual gap 使用 boundingClientRect");
assert.match(groundReportBlock, /reportMeta\.geometryRevision = gifGeometryRevision/, "GIF report 携带 geometry revision");
assert.match(groundReportBlock, /window\.petAPI\.setGroundGap\(gap, reportMeta\)/, "GIF report 复用现有 channel 并携带身份");
const geometryScheduleStart = rendererSource.indexOf("function scheduleGeometryReport");
const geometryScheduleEnd = rendererSource.indexOf("/** 行走朝向", geometryScheduleStart);
const geometryScheduleBlock = rendererSource.slice(geometryScheduleStart, geometryScheduleEnd);
assert.match(geometryScheduleBlock, /context\.mode !== "gif"/, "GIF geometry 不再额外等待 120ms");
assert.match(rendererSource, /nextGifGeometryRevision\(\);\s*requestedRenderMode = mode/, "mode switch 使旧 GIF geometry callback 失效");
const scaleBlock = sourceBlock(rendererSource, "function applyScale(s)", "window.petAPI.onScaleChanged", "renderer applyScale");
assert.match(scaleBlock, /nextGifGeometryRevision\(\)/, "CSS scale 使旧 GIF geometry callback 失效");
assert.doesNotMatch(scaleBlock, /window\.petAPI\.setSize|win\.setSize/, "renderer applyScale 不负责 BrowserWindow resize");
assert.match(preloadSource, /setGroundGap: \(px, meta\) => ipcRenderer\.send\("pet:set-ground-gap", px, meta \|\| null\)/, "ground-gap metadata 透传");

// 9) mutation matrix：所有 mutation 只在内存 source 上执行，必须被精确 block 断言抓红。
function mutateBlock(source, startMarker, endMarker, mutate) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, "mutation target block exists");
  const block = source.slice(start, end);
  return source.slice(0, start) + mutate(block) + source.slice(end);
}

const removeSetSizeCapture = (block) => block.replace("  const wasGrounded = captureResizeAnchor();\n", "");
const moveSetSizeCaptureAfterSetSize = (block) => block.replace(
  /  const wasGrounded = captureResizeAnchor\(\);\n([\s\S]*?  win\.setSize\(ws, hs\);\n)/,
  "$1  const wasGrounded = captureResizeAnchor();\n"
);
const removeScaleRevision = (block) => block.replace("    const resizeRevision = windowSizeRevision.next();\n", "");
const removeScaleCapture = (block) => block.replace("    const wasGrounded = captureResizeAnchor();\n", "");
const removeScaleResizableEnable = (block) => block.replace("    try { if (!win.isResizable()) win.setResizable(true); } catch { /* 忽略 */ }\n", "");
const moveScaleResizableEnableAfterSetSize = (block) => block
  .replace("    try { if (!win.isResizable()) win.setResizable(true); } catch { /* 忽略 */ }\n", "")
  .replace("    win.setSize(ws, hs);\n", "    win.setSize(ws, hs);\n    try { if (!win.isResizable()) win.setResizable(true); } catch { /* 忽略 */ }\n");
const removeScaleResizableRestore = (block) => block.replace("        try { if (win && !win.isDestroyed()) win.setResizable(false); } catch { /* 忽略 */ }\n", "");
const moveScaleCaptureAfterSetSize = (block) => block.replace(
  /    const wasGrounded = captureResizeAnchor\(\);\n([\s\S]*?    win\.setSize\(ws, hs\);\n)/,
  "$1    const wasGrounded = captureResizeAnchor();\n"
);
const removeScaleRevisionGuard = (block) => block.replace("        if (revisionCurrent) {\n", "        if (true) {\n");
const moveScaleNotificationBeforeSetSize = (block) => block
  .replace('  sendToRenderer("pet:scale-changed", s);\n', "")
  .replace("    win.setSize(ws, hs);\n", '    sendToRenderer("pet:scale-changed", s);\n    win.setSize(ws, hs);\n');
const replaceScaleTargetWithOldSize = (block) => block.replace("    win.setSize(ws, hs);\n", "    win.setSize(325, 250);\n");
const removeSitPositionNormalization = (block) => block.replace(
  "  const targetY = renderModeMod.groundAlign(b, wa, groundGap).y || 0;\n",
  "  const targetY = calculatedY;\n"
);
const removeOutOfScreenNormalization = (block) => block.replace("win.setPosition(b.x, Math.round(groundY));", "win.setPosition(b.x, groundY);");
const removeDragPositionNormalization = (block) => block.replace("win.setPosition(Math.round(nx), Math.round(ny));", "win.setPosition(nx, ny);");

expectMutationToFail("MUT-A", (source) => mutateBlock(source, 'ipcMain.on("pet:set-size"', 'ipcMain.handle("pet:tts-clone"', moveSetSizeCaptureAfterSetSize), assertSetSizeWiring);
expectMutationToFail("MUT-B", (source) => mutateBlock(source, 'ipcMain.on("pet:set-size"', 'ipcMain.handle("pet:tts-clone"', removeSetSizeCapture), assertSetSizeWiring);
expectMutationToFail("MUT-C", (source) => mutateBlock(source, "function setScale(scale)", "function setWalkSpeed", removeScaleRevision), assertSetScaleWiring);
expectMutationToFail("MUT-D", (source) => mutateBlock(source, "function setScale(scale)", "function setWalkSpeed", removeScaleCapture), assertSetScaleWiring);
expectMutationToFail("MUT-E", (source) => mutateBlock(source, "function setScale(scale)", "function setWalkSpeed", moveScaleCaptureAfterSetSize), assertSetScaleWiring);
expectMutationToFail("MUT-F", (source) => mutateBlock(source, "function setScale(scale)", "function setWalkSpeed", removeScaleRevisionGuard), assertSetScaleWiring);
expectMutationToFail("MUT-J", (source) => mutateBlock(source, "function setScale(scale)", "function setWalkSpeed", removeScaleResizableEnable), assertSetScaleWiring);
expectMutationToFail("MUT-K", (source) => mutateBlock(source, "function setScale(scale)", "function setWalkSpeed", moveScaleResizableEnableAfterSetSize), assertSetScaleWiring);
expectMutationToFail("MUT-L", (source) => mutateBlock(source, "function setScale(scale)", "function setWalkSpeed", removeScaleResizableRestore), assertSetScaleWiring);
expectMutationToFail("MUT-M", (source) => mutateBlock(source, "function setScale(scale)", "function setWalkSpeed", moveScaleNotificationBeforeSetSize), assertSetScaleWiring);
expectMutationToFail("MUT-N", (source) => mutateBlock(source, "function setScale(scale)", "function setWalkSpeed", replaceScaleTargetWithOldSize), assertSetScaleWiring);
expectMutationToFail("MUT-G", (source) => mutateBlock(source, "function sitOnTaskbar", 'ipcMain.handle("pet:sit-taskbar"', (block) => block.replace("wa.y + wa.height + groundGap - b.height", "wa.y + wa.height + walk.groundGap - b.height")), assertSitOnTaskbarWiring);
expectMutationToFail("MUT-H", (source) => mutateBlock(source, "function outOfScreenGuard", "function walkTick", (block) => block.replace(") + groundGap;", ") + (walk.groundGap || 0);")), assertOutOfScreenGuardWiring);
expectMutationToFail("MUT-O", (source) => mutateBlock(source, "function sitOnTaskbar", 'ipcMain.handle("pet:sit-taskbar"', removeSitPositionNormalization), assertSitOnTaskbarWiring);
expectMutationToFail("MUT-P", (source) => mutateBlock(source, "function outOfScreenGuard", "function walkTick", removeOutOfScreenNormalization), assertOutOfScreenGuardWiring);
expectMutationToFail("MUT-Q", (source) => mutateBlock(source, "function dragSeatUpdate", "/* ---------- 桌面行走 v2", removeDragPositionNormalization), assertDragSeatNativeWiring);

const looseToleranceRM = loadRenderMode(renderModeSource.replace("tolerance = 8", "tolerance = 50"));
let toleranceMutationFailed = false;
try {
  assert.equal(
    looseToleranceRM.wasGroundAnchored({ mode: "gif", bounds: { x: 400, y: 949, width: 300, height: 460 }, wa: anchorWa, groundGap: 80 }),
    false,
    "tolerance=50 应错误接受 Δ=9"
  );
} catch { toleranceMutationFailed = true; }
assert.equal(toleranceMutationFailed, true, "MUT-I tolerance=50 必须被边界测试抓住");
console.log("PASS", "MUT-I");

// 10) 真实 revision 行为：A 已排队，mode B 发生但尚未收到 B set-size，A 到期必须 no-op。
const revision = RM.createResizeRevision();
const aRevision = revision.next();
let delayedPositionWrites = 0;
const delayedA = () => {
  if (!revision.isCurrent(aRevision)) return;
  delayedPositionWrites += 1;
};
revision.next(); // render-mode B event；模拟没有 B set-size 到达
delayedA();
assertEq("A delayed callback 在 B mode event 后 no-op", delayedPositionWrites, 0);

console.log(failed ? `\n${failed} 项失败` : "\nrender-mode 全部通过 ✅");
process.exit(failed ? 1 : 0);
