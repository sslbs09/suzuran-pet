"use strict";

/**
 * BUG-07 回归：大透明 Chibi canvas 被当成交互范围。
 * 根因：legacy pixi-live2d 栈没有 interactiveAt——petUiHit 的 live2dInteractiveAt 钩子在
 * 每次 mousemove 抛 TypeError（clickability 刷新冻结），透明画布整体保持可交互。
 * 合同：
 *  ① petUiHit：live2d 画布命中时由 interactiveAt 决定（透明区 false / 模型上 true）；
 *  ② interactiveAt 缺席的替身栈退回旧整画布语义（不抛错）；
 *  ③ legacy live2d-runtime 必须暴露 interactiveAt（模型包围盒收缩）；产品栈已有 alpha 精判（源码合同）。
 */
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { petUiHit } = require("../src/clickability");

function fakeEl(ancestors, tagName) {
  return {
    tagName: tagName || "DIV",
    closest: (sel) => (ancestors.includes(sel) ? { id: sel.replace(/[#.]/, "") } : null)
  };
}

test("petUiHit：live2d 画布命中由 interactiveAt 决定（透明区穿透）", () => {
  const canvasEl = fakeEl(["#live2d-canvas"], "CANVAS");
  const e = { clientX: 30, clientY: 40 };

  // 模型上（interactiveAt=true）→ 可交互
  assert.equal(petUiHit(canvasEl, e, { live2dInteractiveAt: () => true }), true);
  // 画布透明区（interactiveAt=false）→ 穿透（BUG-07 主断言：大透明 canvas 不再整体拦截）
  assert.equal(petUiHit(canvasEl, e, { live2dInteractiveAt: () => false }), false);
});

test("petUiHit：interactiveAt 缺席的替身栈退回旧整画布语义且不抛错", () => {
  const canvasEl = fakeEl(["#live2d-canvas"], "CANVAS");
  const e = { clientX: 30, clientY: 40 };
  assert.equal(petUiHit(canvasEl, e, {}), true, "无钩子 → closest(#live2d-canvas) 旧语义保留");
  assert.doesNotThrow(() => petUiHit(canvasEl, e, { live2dInteractiveAt: undefined }));
});

test("legacy live2d-runtime 暴露 interactiveAt；renderer 钩子 typeof 守卫（源码合同）", () => {
  const fs = require("node:fs");
  const runtimeSrc = fs.readFileSync(require.resolve("../renderer/live2d-runtime.js"), "utf8").replace(/\r\n/g, "\n");
  assert.match(runtimeSrc, /function interactiveAt\(x, y\)/, "legacy 栈实现 interactiveAt（模型包围盒命中）");
  assert.match(runtimeSrc, /interactiveAt,\s*\/\/ BUG-07/, "API 面暴露 interactiveAt");
  const petSrc = fs.readFileSync(require.resolve("../renderer/pet.js"), "utf8").replace(/\r\n/g, "\n");
  assert.match(petSrc, /typeof window\.Live2DRuntime\.interactiveAt === "function"/,
    "钩子必须 typeof 守卫：缺失函数绝不能抛 TypeError（抛错=clickability 刷新冻结=BUG-07 根因）");
  // 产品栈（Cubism Web）alpha 精判保持可用
  const runtimeTs = fs.readFileSync(require.resolve("../tools/live2d-cubism-web/src/runtime.ts"), "utf8");
  assert.match(runtimeTs, /interactiveAt\(x: number, y: number\)/, "产品栈 alpha 精判在位");
});
