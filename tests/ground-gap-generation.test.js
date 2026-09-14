"use strict";
/**
 * F6 修复回归测试：ground-gap 上报的"文档纪元"（docEpoch）换代语义。
 * 三个概念严格分开：
 *   docEpoch        = renderer 文档启动时刻的 main renderModeSeq（跨 reload 单调、文档内恒定）
 *   renderGeneration = renderer 文档内部的 render-owner 计数（随模式切换递增，reload 归零重启）
 *   geometryRevision = GIF 几何修订计数（同上，reload 归零重启）
 * 纯函数测试 + 源码接线契约；不启动 Electron。
 */
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const RM = require("../src/render-mode");

const main = fs.readFileSync(require.resolve("../main.js"), "utf8").replace(/\r\n/g, "\n");
const pet = fs.readFileSync(require.resolve("../renderer/pet.js"), "utf8").replace(/\r\n/g, "\n");

const gif = (over = {}) => ({
  mode: "gif", sourceMode: "gif", current: 0, gifCurrent: 24, px: 26,
  geometryRevision: 1, renderGeneration: 1, docEpoch: 8, epochFloor: 0, ...over
});
const spine = (over = {}) => ({
  mode: "spine", sourceMode: "spine", current: 12, gifCurrent: 24, px: 30,
  renderGeneration: 1, docEpoch: 8, epochFloor: 0, ...over
});

test("T1 same docEpoch, revision ascending: both accepted (legacy ordering rule intact)", () => {
  const r1 = RM.groundGapReportDecision(gif({ geometryRevision: 1 }));
  assert.equal(r1.accepted, true);
  const r2 = RM.groundGapReportDecision(gif({ geometryRevision: 2, gifCurrent: r1.value, lastReport: r1.identity }));
  assert.equal(r2.accepted, true);
  assert.equal(r2.value, 26);
});

test("T2 same docEpoch, revision rollback: old packet still rejected (B 防乱序不回归)", () => {
  const hi = RM.groundGapReportDecision(gif({ geometryRevision: 12 }));
  const lo = RM.groundGapReportDecision(gif({ geometryRevision: 10, gifCurrent: hi.value, lastReport: hi.identity }));
  assert.equal(lo.accepted, false);
  assert.equal(lo.stale, true);
  assert.equal(lo.value, hi.value, "拒绝时保持现值");
});

test("T3 new docEpoch with small revision must be ACCEPTED (the F6 regression)", () => {
  const old = RM.groundGapReportDecision(gif({ geometryRevision: 40, renderGeneration: 8 }));
  assert.equal(old.accepted, true);
  const fresh = RM.groundGapReportDecision(gif({
    geometryRevision: 1, renderGeneration: 1, docEpoch: 9, px: 18,
    gifCurrent: old.value, lastReport: old.identity,
  }));
  assert.equal(fresh.accepted, true, "旧文档 rev40/gen8 不得把新文档首包判为 stale");
  assert.equal(fresh.value, 18, "新文档首包实际更新状态（T5）");
  assert.equal(fresh.identity.docEpoch, 9, "identity 换代携带新纪元");
});

test("T4 after docEpoch 9 established, late docEpoch 8 packet must be REJECTED", () => {
  const fresh = RM.groundGapReportDecision(gif({ geometryRevision: 1, renderGeneration: 1, docEpoch: 9 }));
  const late = RM.groundGapReportDecision(gif({
    geometryRevision: 999, renderGeneration: 99, docEpoch: 8, px: 77,
    gifCurrent: fresh.value, lastReport: fresh.identity,
  }));
  assert.equal(late.accepted, false, "D：旧文档晚到的超高 rev 不得覆盖新文档基准");
  assert.equal(late.value, fresh.value);
});

test("T5 spine new-epoch first report updates walk gap; legacy spine rule within epoch intact", () => {
  const s8 = RM.groundGapReportDecision(spine({ renderGeneration: 20 }));
  assert.equal(s8.accepted, true);
  assert.equal(s8.value, 30);
  const s9low = RM.groundGapReportDecision(spine({ renderGeneration: 1, px: 44, current: s8.value, lastReport: s8.identity, docEpoch: 9 }));
  assert.equal(s9low.accepted, true, "gen 从旧文档 20 重启为 1 不再被误拒");
  assert.equal(s9low.value, 44);
  const s9back = RM.groundGapReportDecision(spine({ renderGeneration: 0, current: s9low.value, lastReport: s9low.identity }));
  assert.equal(s9back.accepted, false, "同纪元内 gen 回退仍拒（spine 单调语义保留）");
});

test("T6 source/mode bucket semantics unchanged", () => {
  assert.equal(RM.groundGapReportDecision(gif({ mode: "rig", sourceMode: "rig" })).accepted, false, "Rig 仍拒绝 ground-gap 写入");
  assert.equal(RM.groundGapReportDecision(gif({ mode: "live2d", sourceMode: "live2d" })).accepted, false);
  assert.equal(RM.groundGapReportDecision(gif({ sourceMode: "spine" })).accepted, false, "sourceMode 与 mode 不符仍拒（epoch 之前拦截）");
  assert.equal(RM.groundGapReportDecision(spine({ mode: "spine", sourceMode: "spine", px: "NaN" })).accepted, false);
});

test("T7 reload boundary via epochFloor: stale old-doc packet refused even with EMPTY bucket", () => {
  const late = RM.groundGapReportDecision(gif({ docEpoch: 6, epochFloor: 7, geometryRevision: 999, renderGeneration: 99, lastReport: null }));
  assert.equal(late.accepted, false);
  assert.equal(late.staleDoc, true, "floor 拦下（crash/reload 后、新文档首包前的晚到窗口）");
  const fresh = RM.groundGapReportDecision(gif({ docEpoch: 7, epochFloor: 7 }));
  assert.equal(fresh.accepted, true, "新文档（epoch==floor）首包畅通");
});

test("T8 formal mode switch (same document) neither resets nor clears buckets", () => {
  const r = RM.groundGapReportDecision(gif({ geometryRevision: 5, renderGeneration: 3 }));
  // 同文档内模式来回：epoch 不变 → 换代不清桶，rev 回退仍按老规则拒绝（说明"不该清的状态没被误清"）
  const back = RM.groundGapReportDecision(gif({ geometryRevision: 4, renderGeneration: 4, gifCurrent: r.value, lastReport: r.identity }));
  assert.equal(back.accepted, false);
  assert.equal(back.value, r.value);
  // main 接线：floor 只在文档重新生成的 3 个边界推进，正式模式切换路径不得赋值
  assert.equal((main.match(/groundGapDocFloor = renderModeSeq;/g) || []).length, 3);
  const intentBlock = main.slice(main.indexOf("function beginRenderModeIntent"), main.indexOf("function bumpRenderModeIntentForRecovery"));
  assert.doesNotMatch(intentBlock, /groundGapDocFloor/, "formal intent 不动纪元下限（T8）");
});

test("T9 duplicate identical revision stays idempotent-rejected (existing rule preserved)", () => {
  const r = RM.groundGapReportDecision(gif({ geometryRevision: 7 }));
  const dup = RM.groundGapReportDecision(gif({ geometryRevision: 7, lastReport: r.identity, gifCurrent: r.value }));
  assert.equal(dup.accepted, false, "gif `<=` 规则原样：重复同 rev 拒收（幂等由拒收表达）");
});

test("backward compatibility: calls without docEpoch/epochFloor behave exactly like before F6", () => {
  const legacy = (over = {}) => ({ mode: "gif", sourceMode: "gif", current: 0, gifCurrent: 24, px: 26, geometryRevision: 1, renderGeneration: 1, ...over });
  const a = RM.groundGapReportDecision(legacy());
  const b = RM.groundGapReportDecision(legacy({ geometryRevision: 1, lastReport: a.identity }));
  assert.equal(a.accepted, true);
  assert.equal(b.accepted, false, "无纪元参数的旧调用：同 rev 仍按旧规则拒（旧测试世界不变）");
});

test("wiring contracts: floor advances exactly at the three document-regeneration boundaries; meta carries epoch", () => {
  const gone = main.slice(main.indexOf('win.webContents.on("render-process-gone"'), main.indexOf("}, 3000);"));
  assert.match(gone, /bumpRenderModeIntentForRecovery\(\);\n      win\.reload\(\);/, "崩溃自愈：bump→reload 原序（H1/H2 邻接不动）");
  const goneTail = main.slice(main.indexOf('win.webContents.on("render-process-gone"'));
  assert.match(goneTail, /\}, 3000\);\n      groundGapDocFloor = renderModeSeq;[^\n]*\n    \} catch \(e2\)/, "崩溃自愈：floor 与 reload 同一同步块内推进（早于任何新 IPC）");
  const rStart = main.indexOf('ipcMain.handle("pet:reload-renderer"');
  const reload = main.slice(rStart, main.indexOf("return true;", rStart));
  assert.match(reload, /bumpRenderModeIntentForRecovery\(\);\n  groundGapDocFloor = renderModeSeq;[^\n]*\n  win\.webContents\.reload\(\);/);
  assert.match(main, /groundGapDocFloor = renderModeSeq;[\s\S]{0,120}win\.loadFile\(path\.join\(config\.APP_DIR, "renderer", "index\.html"\)\);/, "新窗：loadFile 前设 floor");
  assert.match(main, /docEpoch: meta && meta\.docEpoch,[\s\S]{0,60}epochFloor: groundGapDocFloor,/, "handler 把两参数注入决策");
  assert.match(pet, /let petDocEpoch = 0;/);
  assert.match(pet, /petDocEpoch = initialMainSeq === null \? 0 : initialMainSeq;/);
  assert.match(pet, /docEpoch: petDocEpoch/, "上报 meta 携带文档纪元");
});
