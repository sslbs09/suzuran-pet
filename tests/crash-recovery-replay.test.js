"use strict";
/**
 * H1 修复回归测试：崩溃恢复 3s 回调的窗口身份守卫 + uncaughtException 诊断处理器不再 rethrow。
 * 纯静态 require + 假窗口/假依赖注入；定时器由测试手动触发（不等真实 3s，无 sleep）。
 */
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const { replayCrashRecovery } = require("../src/crash-recovery");

const main = fs.readFileSync(require.resolve("../main.js"), "utf8").replace(/\r\n/g, "\n");

/* ---------- 假窗口/假依赖夹具 ---------- */
function makeWindow({ destroyed = false, wcDestroyed = false, throwOnGetBounds = false } = {}) {
  const calls = { getBounds: 0 };
  return {
    calls,
    isDestroyed: () => destroyed,
    webContents: { isDestroyed: () => wcDestroyed },
    getBounds: () => {
      calls.getBounds += 1;
      if (throwOnGetBounds) throw new TypeError("Object has been destroyed");
      return { x: 100, y: 200, width: 260, height: 200 };
    },
  };
}
function makeDeps(win, env = {}) {
  const h = { broadcast: 0, edge: [], win };
  return {
    h,
    deps: {
      getWindow: () => (env.current !== undefined ? env.current : win),
      isWalkActive: () => !!env.walkActive,
      walkBroadcast: () => { h.broadcast += 1; },
      updateUiEdgeCompact: (b, wa) => { h.edge.push([b, wa]); },
      getWorkArea: () => "WORK_AREA",
    },
  };
}

/* ---------- T1：诊断 uncaughtException 处理器只记不抛 ---------- */
test("T1 diagnostics uncaughtException handler records and never rethrows", () => {
  const first = main.indexOf('process.on("uncaughtException"');
  assert.ok(first >= 0);
  const block = main.slice(first, main.indexOf("});", first));
  assert.ok(first < main.indexOf("const { app"), "诊断 handler 仍是先注册的那个（保留 death-log 职责）");
  assert.doesNotMatch(block, /throw/, "handler 体内不得 throw：监听器 rethrow 会阻断后续兜底 handler 并让进程硬崩、退出清理半途而废");
  assert.match(block, /__dl\("UNCAUGHT/, "留痕职责保留");
  assert.equal((main.match(/process\.on\("uncaughtException"/g) || []).length, 2, "两个 handler（诊断 + 兜底）并存，兜底得以轮到");
  assert.doesNotMatch(main, /process\.exit\(/, "本轮不新增 process.exit");
});

/* ---------- T2：正常窗口——原功能完整执行 ---------- */
test("T2 healthy window replays walk broadcast and edge state exactly once", () => {
  const win = makeWindow();
  const { h, deps } = makeDeps(win, { walkActive: true });
  assert.equal(replayCrashRecovery(win, deps), "replayed");
  assert.equal(h.broadcast, 1, "walk.active 时补播行走状态（新文档恢复动画）");
  assert.equal(h.edge.length, 1);
  assert.deepEqual(h.edge[0], [{ x: 100, y: 200, width: 260, height: 200 }, "WORK_AREA"], "bounds→workArea→贴边紧凑态重放的接线不变");
  const idle = makeDeps(makeWindow(), { walkActive: false });
  assert.equal(replayCrashRecovery(idle.h.win, idle.deps), "replayed");
  assert.equal(idle.h.broadcast, 0, "未行走不广播（原语义 if (walk.active) 保留）");
  assert.equal(idle.h.edge.length, 1, "贴边紧凑态始终重放（边沿触发状态，新文档需要补）");
});

/* ---------- T3：destroy/置 null 后触发——安全 no-op，不 throw ---------- */
test("T3 destroyed or nulled window makes the delayed callback a safe no-op", () => {
  assert.equal(replayCrashRecovery(null, makeDeps(makeWindow()).deps), "window-gone");
  const dead = makeWindow({ destroyed: true });
  const f = makeDeps(dead);
  assert.equal(replayCrashRecovery(dead, f.deps), "window-gone");
  assert.equal(f.h.broadcast, 0);
  assert.equal(f.h.edge.length, 0);
  assert.equal(dead.calls.getBounds, 0, "身份失败时不得触达 native");
});

/* ---------- T4：旧窗关闭、新窗已建——旧回调不得作用于新窗 ---------- */
test("T4 callback bound to an old window is refused after a new window is created", () => {
  const oldWin = makeWindow(); // 旧窗本身甚至仍然"活着"（竞态：destroy 与重建交错）
  const newWin = makeWindow();
  const f = makeDeps(oldWin, { current: newWin, walkActive: true });
  assert.equal(replayCrashRecovery(oldWin, f.deps), "superseded-window");
  assert.equal(f.h.broadcast, 0, "新窗收不到旧 recovery 的重放");
  assert.equal(f.h.edge.length, 0);
  assert.equal(newWin.calls.getBounds, 0);
});

/* ---------- T5：webContents 失效——不得 send/getBounds ---------- */
test("T5 destroyed webContents is refused before any bounds access", () => {
  const win = makeWindow({ wcDestroyed: true });
  const f = makeDeps(win, { walkActive: true });
  assert.equal(replayCrashRecovery(win, f.deps), "webcontents-gone");
  assert.equal(win.calls.getBounds, 0);
  assert.equal(f.h.broadcast, 0);
});

/* ---------- T6：任何分支都不外抛——退出清理链不可能被该回调打断 ---------- */
test("T6 replay never rethrows on any branch, protecting the quit cleanup chain", () => {
  const hostile = [
    [null, {}],
    [makeWindow({ destroyed: true }), {}],
    [makeWindow({ wcDestroyed: true }), {}],
    [makeWindow({ throwOnGetBounds: true }), makeDeps(null, { current: null }).deps],
  ];
  const win = makeWindow();
  win.getBounds = () => { throw new TypeError("Object has been destroyed"); };
  const f = makeDeps(win, { walkActive: true });
  assert.equal(replayCrashRecovery(win, f.deps), "native-race", "身份全过但 native 恰在销毁瞬间抛错：兜底吸收，状态以返回值上报而非异常");
  for (const [w, d] of hostile) {
    let threw = false;
    try { replayCrashRecovery(w, { ...makeDeps(makeWindow()).deps, ...d }); } catch { threw = true; }
    assert.equal(threw, false, `${w === null ? "null window" : "hostile window"} 分支不得 throw`);
  }
  // 接线契约：gone 处理器捕获身份且旧裸用 win 的写法已消失；3s 节奏与外层 catch 不变
  assert.match(main, /const recoveryWindow = createdWindow;[\s\S]{0,120}setTimeout\(\(\) => \{\s*replayCrashRecovery\(recoveryWindow, \{/);
  assert.doesNotMatch(main, /updateUiEdgeCompactFromBounds\(win\.getBounds\(\)/, "延迟体内不再有对模块级 win 的裸 native 访问");
  assert.match(main, /\}, 3000\);/);
  assert.match(main, /catch \(e2\) \{ logTts\("render", "自动重载失败/);
  // 清理清单未被本修复改动（9 步语义不变，H1 只加身份守卫）
  assert.match(main, /runCleanupSteps\(\[[\s\S]*?"drag pause"[\s\S]*?"schedules\.stop"[\s\S]*?"barrier timer"[\s\S]*?"save position"[\s\S]*?"Agent API"[\s\S]*?"Genie"[\s\S]*?"GSV processes"[\s\S]*?"port 9881"[\s\S]*?"port 9880"/);
});
