"use strict";
/**
 * H2 修复回归测试：crash 自愈预算按逻辑窗口 domain 分桶（消除跨窗 quota 串扰）。
 * 纯函数用显式 now（fake clock），接线用源码契约；不启 Electron、无 sleep。
 */
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const { createCrashBudget } = require("../src/crash-budget");

const main = fs.readFileSync(require.resolve("../main.js"), "utf8").replace(/\r\n/g, "\n");
const t0 = 1_000_000; // 任意固定起点（fake clock）

/* ---------- 桶隔离 ---------- */
test("T1 pet first crash counts into its own bucket", () => {
  const b = createCrashBudget();
  const r = b.record("pet", t0);
  assert.deepEqual(r, { count: 1, limited: false, windowStartedAt: t0 });
});
test("T2 auxiliary crashes never touch the pet bucket", () => {
  const b = createCrashBudget();
  b.record("settings", t0);
  b.record("settings", t0 + 1000);
  assert.equal(b.peek("pet"), null, "pet 域不存在=零消耗");
  assert.equal(b.record("pet", t0 + 2000).count, 1, "pet 首崩仍是自己的第 1 次");
});
test("T3 settings 2 + pet 1 keeps pet recovery allowed (the H2 regression)", () => {
  const b = createCrashBudget();
  b.record("settings", t0);
  b.record("settings", t0 + 1000);
  const pet = b.record("pet", t0 + 2000);
  assert.equal(pet.limited, false, "旧全局桶下此处 limited=true，主 pet 不再 reload 永久消失");
});
test("T4 pet alone still hits its own loop protection at the threshold", () => {
  const b = createCrashBudget();
  assert.equal(b.record("pet", t0).limited, false);
  assert.equal(b.record("pet", t0 + 5000).limited, false);
  const third = b.record("pet", t0 + 10000);
  assert.deepEqual({ count: third.count, limited: third.limited }, { count: 3, limited: true }, "阈值 3 不变");
  const fourth = b.record("pet", t0 + 15000);
  assert.equal(fourth.count, 4, "超限后继续累计（原“第 N 次”日志语义保留）");
});
test("T5 settings exhausting its quota restricts only settings", () => {
  const b = createCrashBudget();
  for (let i = 0; i < 3; i += 1) b.record("settings", t0 + i);
  assert.equal(b.record("settings", t0 + 3).limited, true);
  assert.equal(b.record("pet", t0).limited, false);
  assert.equal(b.record("docs", t0).limited, false, "docs 首崩不进限流（旧串扰场景）");
});
test("T6 different domains keep independent counts", () => {
  const b = createCrashBudget();
  b.record("settings", t0);
  b.record("settings", t0 + 1);
  const docs = b.record("docs", t0 + 2);
  assert.equal(docs.count, 1);
  assert.equal(b.peek("settings").count, 2);
});
test("T7 window destroy/recreate of the same logical window shares crash history", () => {
  const b = createCrashBudget();
  b.record("settings", t0); // 旧 settings 窗崩一次后 closed
  const afterRecreate = b.record("settings", t0 + 30000); // 重开的 settings（新 BrowserWindow 对象）
  assert.equal(afterRecreate.count, 2, "桶按 label 不按窗口对象：换对象绕不过 loop protection");
  assert.equal(afterRecreate.windowStartedAt, t0, "时间窗仍锚定同域首次崩溃");
});
/* ---------- 时间窗 ---------- */
test("T8 expired window renews that domain's quota", () => {
  const b = createCrashBudget();
  b.record("pet", t0);
  b.record("pet", t0 + 1000);
  const renewed = b.record("pet", t0 + 60001); // 超 60s → 开新窗重新计数
  assert.deepEqual(renewed, { count: 1, limited: false, windowStartedAt: t0 + 60001 });
  assert.equal(b.record("pet", t0 + 61000).count, 2, "新窗内继续正常累计");
});
test("T9 time windows are per-domain and do not reset each other", () => {
  const b = createCrashBudget();
  b.record("pet", t0);
  b.record("pet", t0 + 59000); // pet 第 2 次（旧窗内）
  b.record("settings", t0);
  const s = b.record("settings", t0 + 60001); // settings 自己的窗到期重置
  assert.equal(s.count, 1);
  assert.equal(b.peek("pet").count, 2, "pet 桶不受 settings 时间窗事件影响");
  assert.equal(b.peek("pet").windowStartedAt, t0, "pet 原时间窗锚点保持");
});

/* ---------- 接线契约 ---------- */
test("T10 no double-count for the main pet crash", () => {
  assert.doesNotMatch(main, /attachCrashDiag\(\s*win\s*,/, "主窗不得同时挂 attachCrashDiag 与专属 gone 处理器");
  assert.equal((main.match(/win\.webContents\.on\("render-process-gone"/g) || []).length, 1, "主窗只有一个 gone 处理器");
  assert.equal((main.match(/crashBudget\.record\("pet", now\)/g) || []).length, 1, "pet 域每次崩溃只记一次");
});
test("T11 within quota the pet recovery chain order is untouched (bump → reload → H1 delayed replay)", () => {
  assert.match(main, /const budget = crashBudget\.record\("pet", now\);[\s\S]*?if \(budget\.limited\)[\s\S]*?return; \}\n\s*try \{\n\s*bumpRenderModeIntentForRecovery\(\);\n\s*win\.reload\(\);\n\s*const recoveryWindow = win;/);
  assert.match(main, /replayCrashRecovery\(recoveryWindow, \{/);
  assert.match(main, /attachCrashDiag\(w, label\)[\s\S]{0,300}crashBudget\.record\(label, now\)/, "辅助窗沿用既有 label 作 domain");
});
test("T12 at quota neither reload nor bump runs; aux windows keep independent rate limits", () => {
  assert.match(main, /if \(budget\.limited\) \{ logTts\("render", "渲染进程连续崩溃，停止自动重载（可手动重启桌宠）"\); return; \}\n\s*try \{\n\s*bumpRenderModeIntentForRecovery/);
  const labels = [];
  for (const m of main.matchAll(/attachCrashDiag\(\w+, "(\w+)"\)/g)) labels.push(m[1]);
  assert.ok(labels.length >= 10 && new Set(labels).size === labels.length, "label 为固定有限集合且唯一：桶数有界，无需动态清理");
  assert.ok(!labels.includes("pet"), "pet 保留为专属主窗 domain，不与辅助窗 label 冲突");
});

/* ---------- 卫生 ---------- */
test("housekeeping: no leftovers, quota constants unchanged", () => {
  assert.doesNotMatch(main, /renderCrashCount|renderCrashWindowAt/, "旧全局桶变量已完全移除");
  assert.doesNotMatch(main, /CLICK-DIAG|RENDERER-DIAG|\[RECOVERY|pet:click-diag/);
  assert.doesNotMatch(main, /process\.on\("uncaughtException"[^)]*\{[^}]*throw/, "H1 成果未回退");
  const src = fs.readFileSync(require.resolve("../src/crash-budget.js"), "utf8");
  assert.match(src, /limit = 3/); assert.match(src, /windowMs = 60000/); // 阈值与时间窗原值
});
