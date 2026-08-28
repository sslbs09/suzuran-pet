"use strict";
/**
 * 子窗口公共配置与工具（2026-08-27 拆，反复样板收敛）：
 * 统一 preload 沙箱默认，避免每个窗口重复写 webPreferences。
 */
const path = require("path");

/** 子窗口 webPreferences 默认（preload + 沙箱隔离） */
function childWebPrefs(appDir) {
  return { preload: path.join(appDir, "preload.js"), contextIsolation: true, nodeIntegration: false };
}

/** 加载子页面并隐藏菜单栏 */
function loadChildPage(win, appDir, file) {
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(appDir, "renderer", file));
}

module.exports = { childWebPrefs, loadChildPage };