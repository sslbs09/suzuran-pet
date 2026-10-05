"use strict";

/*
 * electron-preload.js — Phase 9-B 感知实验 Electron 启动前隔离闸门（researcher-only tooling）。
 *
 * 用法（必须作为 main.js 的第一条语句，先于任何 userData 读写）：
 *   require("./scripts/perception/electron-preload");
 *
 * 行为：
 *   - 未设置 SUZURAN_PERCEPTION_EXPERIMENT=1 → 立即返回，产品启动路径逐字不变（零副作用）；
 *   - 已声明实验模式但 userData 落在真实产品目录（%APPDATA%\<产品名> 或 %APPDATA% 之下）
 *     → 打印 PERCEPTION_ISOLATION_REFUSED 并以 app.exit(1) 终止，绝不继续启动。
 *
 * 事故背景：两个诊断 Electron 实例漏设 SUZURAN_TEST_USERDIR，落入真实产品 userData，
 * 写脏 logs/tts.log 与 Chromium cache。本闸门是"研究者手滑也炸不了真实数据"的最后一道兜底。
 */

const EXPERIMENT_ENV = "SUZURAN_PERCEPTION_EXPERIMENT";

if (String(process.env[EXPERIMENT_ENV] || "") === "1") {
  try {
    const { app } = require("electron");
    const isolation = require("./isolation");
    const userDataDir = app && typeof app.getPath === "function" ? app.getPath("userData") : "";
    isolation.assertExperimentMarkerIsolation({ userDataDir });
  } catch (e) {
    try {
      // 保持与其它入口一致的失败面：stderr 一行机器可读原因 + 非零退出。
      process.stderr.write("PERCEPTION_ISOLATION_REFUSED(electron): " + String((e && e.message) || e) + "\n");
    } catch { /* stderr 不可用时不阻塞退出 */ }
    try {
      const { app } = require("electron");
      if (app && typeof app.exit === "function") app.exit(1);
    } catch { /* 忽略：下方 process.exit 兜底 */ }
    process.exit(1);
  }
}

module.exports = {};
