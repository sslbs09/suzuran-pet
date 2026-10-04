"use strict";
/**
 * B-2 点击穿透自锁修复——正式回归测试（纯静态：require 逻辑模块 + 源码接线契约，不启动 Electron、无动态代码执行）。
 *
 * 根因（实机确认）：Windows + Electron 43 + transparent 桌宠窗口下，setIgnoreMouseEvents(true,{forward:true})
 * 不能可靠把 mousemove 转发进 renderer；进入穿透后 renderer 只剩过期 lastMouse，500ms 兜底无限重放 false，永久自锁。
 * 修复：① 无效坐标无 native 变更权限；② 穿透期由 main 轮询系统光标推 viewport 坐标，renderer 真实位置重判
 * （独立于鼠标事件流）；③ native 写只在状态跃迁时发生，缓存随新窗口重置。
 */
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const {
  clientPointInContent, createNativeIgnoreController, petUiHit, createClickabilityCore
} = require("../src/clickability");

function readLf(p) { return fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n"); }
const main = readLf(require.resolve("../main.js"));
const pet = readLf(require.resolve("../renderer/pet.js"));
const preload = readLf(require.resolve("../preload.js"));
const indexHtml = readLf(require.resolve("../renderer/index.html"));

/* ---------- 工具：假 DOM 元素（closest 按祖先选择器名单命中） ---------- */
function makeEl(tagName, ancestors) {
  const el = { tagName, id: "", className: "cls", closest: (sel) => (ancestors && ancestors.includes(sel) ? el : null) };
  return el;
}
function makeCore(env = {}) {
  const h = { sent: [], efp: [], hitEl: env.hitEl === undefined ? null : env.hitEl };
  h.core = createClickabilityCore({
    elementFromPoint: (x, y) => { h.efp.push([x, y]); return h.hitEl; },
    setClickable: (v) => h.sent.push(v),
    getDragState: () => env.dragState || null,
    isPetUI: (el, e) => petUiHit(el, e, {
      petEl: () => ({ getBoundingClientRect: () => ({ left: 138, top: 54, right: 258, bottom: 174, width: 120, height: 120 }) }),
      activeRenderMode: () => env.activeRenderMode || "gif",
      busy: () => env.busy || false,
      walkState: () => env.walkState || { active: false, resting: false, paused: false, sleeping: false, seated: false, perched: false },
      playback: () => {},
    }),
  });
  return h;
}

/* ---------- T11 / T12：screen→client 换算（DIP 纯减法，无 dpr/zoom；多屏负原点） ---------- */
test("T11 screen-to-client conversion is pure DIP subtraction, zoom/dpr-free and scale-invariant", () => {
  assert.doesNotMatch(clientPointInContent.toString(), /devicePixelRatio|dpr|zoom/i);
  assert.deepEqual(clientPointInContent({ x: 105, y: 106 }, { x: 100, y: 100, width: 260, height: 200 }), { x: 5, y: 6 });
  assert.deepEqual(clientPointInContent({ x: 102, y: 103 }, { x: 100, y: 100, width: 195, height: 150 }), { x: 2, y: 3 });   // 0.75x 窗口
  assert.deepEqual(clientPointInContent({ x: 424, y: 348 }, { x: 100, y: 100, width: 325, height: 250 }), { x: 324, y: 248 }); // 1.25x 窗口
});
test("T12 negative origin / non-zero origin converts correctly, right-bottom edge exclusive", () => {
  assert.deepEqual(clientPointInContent({ x: -1915, y: -195 }, { x: -1920, y: -200, width: 260, height: 200 }), { x: 5, y: 5 });
  assert.deepEqual(clientPointInContent({ x: 359, y: 299 }, { x: 100, y: 100, width: 260, height: 200 }), { x: 259, y: 199 });
  assert.equal(clientPointInContent({ x: -1921, y: -150 }, { x: -1920, y: -200, width: 260, height: 200 }), null);
  assert.equal(clientPointInContent({ x: 360, y: 150 }, { x: 100, y: 100, width: 260, height: 200 }), null);
  assert.equal(clientPointInContent({ x: NaN, y: 10 }, { x: 0, y: 0, width: 10, height: 10 }), null);
  assert.equal(clientPointInContent(null, { x: 0, y: 0, width: 10, height: 10 }), null);
});

/* ---------- T4：native 写去抖 + 恢复哨兵生命周期（纯逻辑） ---------- */
test("T4 native ignore controller debounces writes and arms the recovery poll only while ignored", () => {
  const writes = [];
  const timers = { created: [], cleared: [] };
  let polls = 0;
  const c = createNativeIgnoreController({
    setIntervalFn: (fn, ms) => { timers.created.push([fn, ms]); return 11; },
    clearIntervalFn: (t) => timers.cleared.push(t),
    pollIntervalMs: 200,
    onPoll: () => { polls += 1; },
  });
  assert.equal(c.applied, null, "新窗口缓存初始为未写入");
  assert.equal(c.apply((ig, o) => writes.push([ig, o]), true), true);
  assert.deepEqual(writes.at(-1), [true, { forward: true }]);
  assert.equal(timers.created.length, 1);
  assert.equal(timers.created[0][1], 200, "进入穿透：200ms 哨兵启动");
  assert.equal(typeof timers.created[0][0], "function");
  assert.equal(c.apply((ig, o) => writes.push([ig, o]), true), false);
  assert.equal(writes.length, 1, "同状态（如 stale 兜底重放）不得重复写 native");
  assert.equal(c.apply((ig, o) => writes.push([ig, o]), false), true);
  assert.deepEqual(writes.at(-1), [false, { forward: true }]);
  assert.deepEqual(timers.cleared, [11], "恢复可交互：哨兵停止（此后由真实鼠标事件流自持）");
  timers.created[0][0](); // 哨兵 tick → onPoll
  assert.equal(polls, 1);
  c.reset();
  assert.equal(c.applied, null, "reset 后旧窗状态不得污染新窗（首写必达）");
});

test("T4 main watchdog wiring: single native write site, 200ms poll, visible-only, in-bounds-only push", () => {
  assert.match(main, /require\("\.\/src\/clickability"\)/);
  assert.match(main, /pollIntervalMs: 200/);
  assert.equal((main.match(/\.setIgnoreMouseEvents\(/g) || []).length, 1, "setIgnoreMouseEvents 仅 applyNativeIgnore 一个调用点");
  assert.match(main, /if \(!win \|\| win\.isDestroyed\(\) \|\| !win\.isVisible\(\)\) return;/);
  assert.match(main, /if \(!p\) return;[\s\S]*?win\.webContents\.send\("pet:cursor-recovery", p\);/, "窗口外不推送");
  assert.match(main, /nativeIgnore\.reset\(\);[\s\S]{0,120}applyNativeIgnore\(win, true\);/, "createWindow：重置+初始穿透");
  assert.match(main, /function showWindow[\s\S]{0,200}applyNativeIgnore\(win, false\)/, "托盘恢复强制解除穿透");
  assert.match(main, /ipcMain\.on\("pet:set-clickable", \(_e, clickable\) => \{[\s\S]*?applyNativeIgnore\(win, !clickable\);/);
  assert.match(preload, /onCursorRecovery: \(cb\) => ipcRenderer\.on\("pet:cursor-recovery", \(_e, p\) => cb\(p\)\)/);
  assert.ok(indexHtml.indexOf("clickability.js") < indexHtml.indexOf("\"pet.js\""), "clickability.js 先于 pet.js 加载");
});

/* ---------- T2 / T3 / T4d / T5 / T6：renderer 穿透核心行为 ---------- */
test("T1 startup recovery releases clickability on committed render mode", () => {
  assert.match(pet, /clickability\.petSetClickable\(initialResult\.status === "ready" \|\| initialResult\.status === "noop"\);/);
  assert.equal((pet.match(/window\.petAPI\.setClickable\(/g) || []).length, 1, "renderer 仅核心注入一个 setClickable 出口（镜像不被旁路）");
});
test("T2 invalid coordinates cannot change native clickability or touch elementFromPoint", () => {
  for (const [x, y] of [[-1, -1], [-1, 92], [92, -1], [NaN, 92], [92, Infinity], [undefined, 10]]) {
    const h = makeCore({ hitEl: makeEl("DIV", ["#pet"]) });
    h.core.refreshClickable(x, y);
    assert.deepEqual(h.sent, [], `(${x},${y}) 不得发出 clickable 变更`);
    assert.deepEqual(h.efp, [], `(${x},${y}) 不得触达 elementFromPoint`);
  }
});
test("T2b hideBubble with uninitialized coords keeps current state (no forced click-through)", () => {
  assert.match(pet, /function hideBubble\(\) \{[\s\S]*?clickability\.refreshFromLastMouse\(\);[\s\S]*?\}/);
  const h = makeCore();
  h.core.refreshFromLastMouse(); // lastMouse 初始 (-1,-1)
  assert.deepEqual(h.sent, []);
});
test("T3 500ms fallback replays the LIVE position, never an invalid or superseded stale one", () => {
  assert.match(pet, /setInterval\(\(\) => \{[^}]*clickability\.refreshFromLastMouse\(\);/);
  const h = makeCore({ hitEl: makeEl("DIV", [".pet-root"]), lastSent: null });
  h.core.refreshFromLastMouse();
  assert.deepEqual(h.sent, [], "未初始化：兜底静默");
  const stale = makeCore({ hitEl: makeEl("DIV", [".pet-root"]) });
  stale.core.refreshClickable(5, 92); // 一次真实空白判定（穿透开始）
  assert.deepEqual(stale.sent, [false]);
  stale.hitEl = makeEl("IMG", ["#pet"]);
  stale.core.onNativeCursorPush({ x: 198, y: 114 }); // 恢复推送：真实光标已在角色身上
  assert.deepEqual(stale.sent, [false, true]);
  assert.deepEqual(stale.core.lastMouse, { x: 198, y: 114 }, "残值被真实位置覆盖");
  stale.core.refreshFromLastMouse(); // 兜底此后重放新位置
  assert.deepEqual(stale.efp.at(-1), [198, 114]);
});
test("T4d recovery push works with zero renderer mouse events and is ignored once interactive", () => {
  const locked = makeCore({ hitEl: makeEl("DIV", [".pet-root"]) });
  locked.core.refreshClickable(5, 92); // 空白处真实判定 false → 进入穿透
  assert.deepEqual(locked.sent, [false]);
  locked.hitEl = makeEl("DIV", ["#pet"]); // 光标（物理上）此刻在角色身上
  locked.core.onNativeCursorPush({ x: 198, y: 114 });
  assert.deepEqual(locked.sent, [false, true], "穿透态下恢复推送翻转 true（不依赖任何 mousemove）");
  const interactive = makeCore({ hitEl: makeEl("DIV", ["#pet"]) });
  interactive.core.petSetClickable(true);
  interactive.core.onNativeCursorPush({ x: 198, y: 114 }); // 在途残推送防御：不得触达 elementFromPoint、不得再发状态
  assert.equal(interactive.efp.length, 0);
  assert.deepEqual(interactive.sent, [true], "仍只有 petSetClickable(true) 那一次发送");
  const junk = makeCore();
  junk.core.onNativeCursorPush({ x: 10 }); junk.core.onNativeCursorPush(null); junk.core.onNativeCursorPush(undefined);
  assert.deepEqual(junk.sent, [], "非法 payload 不得变更状态");
});
test("T5 blank transparent areas still click-through (no over-capture)", () => {
  const root = makeCore({ hitEl: makeEl("DIV", [".pet-root"]) });
  root.core.refreshClickable(20, 20);
  assert.deepEqual(root.sent, [false]);
  const bg = makeCore({ hitEl: makeEl("HTML", []) });
  bg.core.refreshClickable(30, 30);
  assert.deepEqual(bg.sent, [false], "根/背景元素不算实体");
});
test("T6 bubble / input-bar / info-panel hits recover interactivity", () => {
  for (const sel of ["#bubble", "#input-bar", "#info-panel"]) {
    const h = makeCore();
    h.hitEl = makeEl("BUTTON", [sel]);
    h.core.refreshClickable(60, 80);
    assert.deepEqual(h.sent, [true], `${sel} 必须可交互`);
  }
});
test("T7-T10 all four render-mode owners remain hittable", () => {
  const cases = [
    ["gif", "DIV", ["#pet"], "gif"],
    ["gif img", "IMG", ["#pet"], "gif"],
    ["spine canvas in #pet", "CANVAS", ["#pet"], "spine"],
    ["spine escaped canvas", "CANVAS", [], "spine"],
    ["rig canvas", "CANVAS", ["#rig-canvas"], "rig"],
    ["live2d canvas", "CANVAS", ["#live2d-canvas"], "live2d"],
  ];
  for (const [label, tag, anc, mode] of cases) {
    const h = makeCore({ hitEl: makeEl(tag, anc), activeRenderMode: mode });
    h.core.refreshClickable(198, 114);
    assert.deepEqual(h.sent, [true], `${label} 实体必须可交互`);
  }
  // 行走容差圈规则保持：仅 Spine 真正走动时启用
  const walkOn = makeCore({ hitEl: makeEl("DIV", []), activeRenderMode: "spine", walkState: { active: true, resting: false, paused: false, sleeping: false, seated: false, perched: false } });
  walkOn.core.refreshClickable(198, 114);
  assert.deepEqual(walkOn.sent, [true], "Spine 走动中容差圈命中");
  const walkOff = makeCore({ hitEl: makeEl("DIV", []), activeRenderMode: "spine", walkState: { active: false, resting: false, paused: false, sleeping: false, seated: false, perched: false } });
  walkOff.core.refreshClickable(198, 114);
  assert.deepEqual(walkOff.sent, [false], "Spine 静止：容差圈不再挡下层应用");
});
test("T13 active drag keeps capture; drag cleanup on missing coords does not force click-through", () => {
  const drag = makeCore({ hitEl: makeEl("DIV", [".pet-root"]), dragState: { active: true } });
  drag.core.refreshClickable(20, 20);
  assert.deepEqual(drag.sent, [true], "拖拽中强制放行（mouseup 不得被穿透吞掉）");
  assert.equal(petUiHit(makeEl("DIV", []), { clientX: 0, clientY: 0 }, {}), false, "拖拽兜底不改变 isPetUI 本体语义");
  assert.match(pet, /function renderDragClickable\(\) \{[\s\S]*?clickability\.refreshFromLastMouse\(\);[\s\S]*?\}/);
  assert.match(pet, /function finishDrag[\s\S]*?renderDragClickable\(\);/);
  assert.equal((pet.match(/clickability\.setLastMouse\(e\.clientX, e\.clientY\);/g) || []).length, 2, "拖拽 pointermove/pointerup 同步 lastMouse 语义不变");
});
test("T14 render owner pointer ownership unchanged in commit paths", () => {
  assert.match(pet, /function commitRenderMode[\s\S]*?petEl\.style\.pointerEvents = "auto";/, "gif commit 收回 #pet auto");
  assert.match(pet, /spineApp\.view\.style\.pointerEvents = "none";/, "spine 画布 pe:none（由 #pet 父级承接命中）");
  assert.match(pet, /petEl\.insertBefore\(owner\.view, spriteEl\)/, "spine 画布挂在 #pet 内部");
  assert.match(pet, /rigCanvas\.style\.pointerEvents = "auto";/, "rig 画布本体 auto");
  assert.match(pet, /document\.getElementById\("live2d-canvas"\)[\s\S]{0,220}?canvas\.style\.pointerEvents = "auto";/, "live2d 画布本体 auto");
  const hitSrc = petUiHit.toString();
  for (const sel of ["#pet", "#bubble", "#input-bar", "#rig-canvas", "#live2d-canvas", "#info-panel"]) {
    assert.ok(hitSrc.includes(`closest("${sel}")`), `判定规则保留 ${sel}`);
  }
});
test("mousemove still drives the single shared evaluation path", () => {
  assert.match(pet, /document\.addEventListener\("mousemove", \(e\) => clickability\.onRealMouseMove\(e\.clientX, e\.clientY\)\);/);
  const h = makeCore({ hitEl: makeEl("DIV", ["#pet"]) });
  h.core.onRealMouseMove(198, 114);
  assert.deepEqual(h.efp, [[198, 114]]);
  assert.deepEqual(h.sent, [true]);
  assert.deepEqual(h.core.lastMouse, { x: 198, y: 114 });
});

/* ---------- housekeeping：临时诊断清零 ---------- */
test("housekeeping temporary B-2 forensics fully removed", () => {
  for (const [label, src] of [["main", main], ["pet", pet], ["preload", preload], ["index", indexHtml]]) {
    assert.doesNotMatch(src, /CLICK-DIAG|RENDERER-DIAG|\[RECOVERY|pet:click-diag|clickDiagForward|clickDiag\b|diagMsg/, `${label} 取证临时诊断必须清零`);
  }
  assert.doesNotMatch(pet, /let lastMouse|source=/, "lastMouse/source 诊断参数已迁入核心模块");
});
