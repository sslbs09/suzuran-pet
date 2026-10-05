"use strict";

/*
 * main.js — Phase 9-B Electron 冒烟探针（researcher-only tooling，非产品入口）。
 *
 * 用途：在"真实 Electron 进程 + 真实产品 main.js"下证明最短闭环可用：
 *   startup → isolated write → restart → shutdown（不含任何 proactive 等待）。
 *
 * 安全前提（由 scripts/perception/electron-launcher.js 保证，本文件自身不做产品改动）：
 *   SUZURAN_TEST_USERDIR     = <实验 workspace>（storage.js 据此重定向全部状态写入）
 *   --user-data-dir          = <实验 workspace>/udd-*（Chromium 缓存同 workspace）
 *   SUZURAN_PERCEPTION_EXPERIMENT=1（main.js 顶部的 fail-closed 闸门在此模式下生效）
 *
 * 启动方式：electron <本目录>，其中 package.json 的 main 指向本文件（因此不会被
 * electron . 的默认入口改写），本文件 require 的是仓库真正的 main.js。
 *
 * QUICK 退出语义（v2 修正）：不再用固定 2.5s 计时器——满载套件里产品初始化可能更慢，
 * 固定计时器会在落盘之前就 app.quit()，冒烟会"静默早退"。现在改为轮询
 * SUZURAN_TEST_USERDIR/.storage-migration-v1.json（只有真实 initializeStorage 才会写），
 * 观察到证据后再留 1.5s 让写入刷盘，才退出；超时上限 90s。
 */

const path = require("path");
const fs = require("fs");
const { app } = require("electron");

const REPO_MAIN = path.resolve(__dirname, "..", "..", "..", "..", "main.js");
const markerDir = process.env.SUZURAN_WM_MARKER_DIR;
const quick = process.env.SUZURAN_WM_SMOKE_QUICK === "1";
const userDirEnv = process.env.SUZURAN_TEST_USERDIR || "";
const MIGRATION_MARKER = userDirEnv ? path.join(userDirEnv, ".storage-migration-v1.json") : "";

function writeMarker(line) {
  if (!markerDir) return;
  try {
    fs.mkdirSync(markerDir, { recursive: true });
    fs.appendFileSync(path.join(markerDir, "electron-smoke.log"), line + "\n", "utf8");
  } catch { /* 冒烟标记写失败不影响主流程判定 */ }
}

writeMarker("launch userData=" + app.getPath("userData"));

require(REPO_MAIN); // 真实产品主进程：storage.js 会把状态写进 SUZURAN_TEST_USERDIR

if (quick) {
  const deadline = Date.now() + 90000;
  const poll = setInterval(() => {
    const wrote = MIGRATION_MARKER ? fs.existsSync(MIGRATION_MARKER) : true;
    if (wrote || Date.now() > deadline) {
      clearInterval(poll);
      writeMarker("write-observed=" + wrote);
      setTimeout(() => { writeMarker("quit"); app.quit(); }, 1500); // 留出刷盘时间
    }
  }, 250);
}
