"use strict";

/**
 * P1 user pet scale removal（settings redesign v0.1）契约测试。
 *
 * 产品裁决（FROZEN Design Doc §17 / Implementation Plan §6）：
 *   - canonical user pet scale = 1.0；存量任意值迁移到 1.0
 *   - Settings / Tray / preload / patch 白名单的全部用户写路径移除
 *   - 保留 window.scale = 1.0 兼容键（读方兼容 + 回滚安全；彻底删 key 归 Chibi closure）
 *   - 红线：display.scaleFactor / DPI / per-monitor geometry / rigScale / live2dScale 不受影响
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const config = require("../src/config");
const SP = require("../src/settings-patch");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

test("MIGRATE: 全部旧 scale 值收敛到 canonical 1.0", () => {
  const oldValues = [0.5, 0.6, 0.75, 0.9, 1.1, 1.25, 1.5, 1.8, 2.0, 0, -1, NaN, "0.6", "2.0", "abc", null, undefined];
  for (const v of oldValues) {
    const cfg = { window: { scale: v, x: 12, width: 300 } };
    const changed = config.normalizeUserScale(cfg);
    assert.equal(cfg.window.scale, 1.0, `scale=${String(v)} → 1.0`);
    assert.equal(changed, true, `scale=${String(v)} 标记为发生迁移`);
    assert.equal(cfg.window.x, 12, `scale=${String(v)} 不擦除 window.x`);
    assert.equal(cfg.window.width, 300, `scale=${String(v)} 不擦除 window.width`);
  }
});

test("MIGRATE: missing / 非对象 window → {scale:1.0}", () => {
  for (const w of [undefined, null, 42, "abc", [1, 2]]) {
    const cfg = { window: w };
    assert.equal(config.normalizeUserScale(cfg), true, `window=${JSON.stringify(w)} 重建`);
    assert.deepEqual(cfg.window, { scale: 1.0 });
  }
  const noWindow = {};
  assert.equal(config.normalizeUserScale(noWindow), true);
  assert.deepEqual(noWindow.window, { scale: 1.0 });
});

test("IDEMPOTENT: 已是 1.0 时二次调用零变更", () => {
  const cfg = { window: { scale: 1.0, x: 9, y: -3, width: 260, height: 200 } };
  assert.equal(config.normalizeUserScale(cfg), false);
  assert.equal(config.normalizeUserScale(cfg), false);
  assert.deepEqual(cfg.window, { scale: 1.0, x: 9, y: -3, width: 260, height: 200 });
});

test("PATCH: window 顶层出白名单——渲染层不得再写 window.scale", () => {
  const r = SP.filterSettingsPatch({ window: { scale: 2 } });
  assert.ok(r.unknown.includes("window"), "window 记入 unknown 留痕");
  assert.equal(r.patch.window, undefined);
});

test("CALLER-CLOSURE: 用户 scale 写路径全灭（静态源码断言）", () => {
  const tray = read("src/tray-menu.js");
  const settings = read("renderer/settings.js");
  const html = read("renderer/settings.html");
  const preload = read("preload.js");
  const main = read("main.js");
  const patch = read("src/settings-patch.js");

  assert.doesNotMatch(tray, /setScale/, "tray 无 setScale（含接线与菜单项）");
  assert.doesNotMatch(settings, /pet-scale|petAPI\.setScale/, "settings 无 pet-scale 控件引用");
  assert.doesNotMatch(html, /id="pet-scale"/, "settings.html 无 #pet-scale");
  assert.doesNotMatch(preload, /setScale/, "preload 不再暴露 setScale");
  assert.doesNotMatch(main, /pet:set-scale/, "main 无 pet:set-scale handler");
  assert.doesNotMatch(main, /function setScale\(/, "main 无 setScale 函数");
  assert.doesNotMatch(patch, /"window",/, "settings-patch 白名单无 window");
});

test("WRITER-CLOSURE: 渲染层保存 patch 不再含 window 段", () => {
  const settings = read("renderer/settings.js");
  assert.doesNotMatch(settings, /window:\s*\{\s*scale\s*\}/, "doSaveOther 不再提交 window.scale");
});

test("READER-PRESERVED: canonical 1.0 的内部读方与 DPI 无关代码原样保留", () => {
  const main = read("main.js");
  assert.match(main, /const scale = clampScale\(cfg\.window\.scale\);/, "启动读 canonical scale（main 权威）");
  assert.match(main, /scaleGeneration/, "V2 几何换代计数保留（内部）");
  assert.match(main, /seatSinkTierOf/, "walkSeatSink 分档读保留（Chibi closure 债，不在本批清理）");
  // 红线：rigScale / live2dScale（模型大小微调）不属于 user pet scale，必须保留
  const settings = read("renderer/settings.js");
  assert.match(settings, /rig-scale/);
  assert.match(settings, /live2d-scale/);
});
