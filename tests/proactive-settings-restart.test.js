"use strict";
// Phase A（fix/proactive-settings-restart-v0.1）：Settings「主动搭话」OFF → ON 重开路径的
// 参数合同测试。缺陷形态：startProactive(sendFn, proactiveMin(), proactiveStateFn) 漏传第 3 参，
// stateFn 落入 chance 位 → proactiveOuterChance() 返回 function，Math.random() > fn 恒为 NaN
// 比较、永不 return → eligible tick 全放行（默认 18% 失效），且 stateFn 落空为 null。
// 本测试为源码级契约断言（不动态执行源码）：逐字校验 set-proactive-chat 行的参数顺序
// 与 startup 路径一致，并确认真模块的 canonical chance source 存在且为 0.18。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");

const main = fs.readFileSync(require.resolve("../main.js"), "utf8");

function settingsRestartHandler() {
  const start = main.indexOf('ipcMain.on("pet:set-proactive-chat"');
  assert.ok(start >= 0, "set-proactive-chat handler exists");
  const end = main.indexOf("\n});", start); // 处理函数收尾的列 0 "});"（避开内联 saveConfig 行的 "});"）
  assert.ok(end > start, "handler closes");
  return main.slice(start, end);
}

test("Settings 重启行：四参数合同 (sendFn, intervalMin, chance, stateFn)", () => {
  const call = settingsRestartHandler();
  // 参数合同逐位校验：第 2 参来自 config、第 3 参是 canonical chance 数值源、第 4 参是状态分流函数
  assert.match(
    call,
    /features\.startProactive\(\s*\(msg,\s*mood\)\s*=>\s*sendProactive\(msg,\s*mood \|\| "idle"\)\s*,\s*proactiveMin\(\)\s*,\s*PROACTIVE_DEFAULTS\.chance\s*,\s*proactiveStateFn\s*\)/,
    "restart passes (sendFn, proactiveMin(), PROACTIVE_DEFAULTS.chance, proactiveStateFn) in order"
  );
  assert.ok(
    !call.includes("proactiveMin(), proactiveStateFn)"),
    "regression guard: proactiveStateFn must never sit in the chance (3rd) slot"
  );
});

test("startup 路径不变：仍以 _proactiveMin, PROACTIVE_DEFAULTS.chance, proactiveStateFn 调用", () => {
  const idx = main.indexOf("features.startProactive((msg, mood) => {");
  assert.ok(idx >= 0, "startup call site exists");
  const startupCall = main.slice(idx, idx + 400);
  assert.ok(/_proactiveMin,\s*PROACTIVE_DEFAULTS\.chance,\s*proactiveStateFn\)/.test(startupCall),
    "startup keeps (sendFn, _proactiveMin, chance, proactiveStateFn) verbatim");
});

test("canonical chance source：features.PROACTIVE_DEFAULTS 冻结为 { intervalMin: 12, chance: 0.18 }", () => {
  const features = require("../src/features");
  assert.deepEqual({ ...features.PROACTIVE_DEFAULTS }, { intervalMin: 12, chance: 0.18 });
  assert.ok(Object.isFrozen(features.PROACTIVE_DEFAULTS), "defaults frozen");
});
