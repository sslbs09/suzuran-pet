/**
 * SuzuranPet 主进程
 * - 透明无边框置顶窗口（桌宠本体）
 * - 托盘菜单、窗口位置持久化
 * - IPC：聊天/任务路由、流式回传、停止、重载人设
 */
"use strict";

const { app, protocol, safeStorage, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage, screen, dialog, Notification } = require("electron");
// 渲染进程偶发崩溃（reason=crashed，疑似 GPU/WebGL）→ 禁用硬件加速回退软件渲染（SwiftShader）。
// 桌宠画布小，性能影响可接受；若确认崩溃消失则保留，否则可移除此行恢复硬件加速。
app.disableHardwareAcceleration();
protocol.registerSchemesAsPrivileged([{ scheme: "pet-user", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
const { spawn, exec, execFile } = require("child_process");
const http = require("http");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const XLSX = require("xlsx");

const config = require("./src/config");
const router = require("./src/router");
const chatClient = require("./src/chat-client");
const zcodeClient = require("./src/zcode-client");
const history = require("./src/history");
const schedules = require("./src/schedules");
const i18n = require("./src/i18n");
const features = require("./src/features");
const { logTts } = require("./src/logger");
const { translateToJa } = require("./src/ja-translate");
const { buildTrayItems } = require("./src/tray-menu");
const fileGuard = require("./src/file-guard");
const lines = require("./src/lines");
const memory = require("./src/memory");
const bond = require("./src/bond");
const { randInt, clamp, easeOutCubic, easeImpact, clampScale, runPowerShell } = require("./src/utils");
const walkGeo = require("./src/walk-geo"); // 行走几何纯函数（2026-08-27 收敛）
const walkCore = require("./src/walk-core");
const { createAskQueue } = require("./src/ask-queue"); // /chat 串行化并发锁（2026-08-27 提取，可单测）
const { createDebounceBuffer } = require("./src/message-buffer"); // 消息生成防抖缓冲（2026-08-27 提取，可单测）
const renderModeMod = require("./src/render-mode"); // 渲染模式归一化 + 切换贴地坐标（2026-08-27 提取，可单测）
const { planRigDelete } = require("./src/rig-delete"); // 2.5D 皮肤删除计划（2026-08-27 提取，可单测）
const dllGuard = require("./src/dll-guard"); // 可执行目录 DLL 完整性自检（§14 追加 98）
const winChild = require('./src/windows'); // child window shared prefs // 行走核心：状态 + 行为决策（2026-08-27 拆出）
const tts = require("./src/tts-manager");
let koffi = null;
try { koffi = require("koffi"); } catch (e) { try { logTts("main", "koffi unavailable: " + (e && e.message || e)); } catch { /* 日志不可用则忽略 */ } }

// 全局兜底（v2.6）：主进程任何未捕获异常/未处理拒绝只记日志绝不弹冻结对话框
// （此前缺失时 spawn ENOENT 等会弹模态框冻结整个应用）
process.on("uncaughtException", (e) => { try { logTts("main", "未捕获异常: " + String((e && (e.stack || e.message)) || e).slice(0, 300)); } catch { /* 日志失败忽略 */ } });
process.on("unhandledRejection", (e) => { try { logTts("main", "未处理拒绝: " + String((e && (e.stack || e.message)) || e).slice(0, 200)); } catch { /* 日志失败忽略 */ } });

// 软件渲染（设置-实验性开关，重启生效）：无独显/显卡驱动异常环境用 CPU 渲染兜底。
// 必须在 app ready 前调用；开启后 WebGL 走 SwiftShader（Spine/PIXI 与 2.5D rig 均可运行，仅变慢）。
try { if (config.getConfig().softRender) app.disableHardwareAcceleration(); } catch { /* 配置不可读则默认硬件渲染 */ }

const ICON_PATH = path.join(config.APP_DIR, "icon.png");
const USER_ASSET_DIR = path.join(config.STORAGE.userDir, "assets");

function registerUserAssetProtocol() {
  protocol.handle("pet-user", (request) => {
    try {
      const url = new URL(request.url);
      const rel = decodeURIComponent(url.hostname + url.pathname).replace(/^[/\\]+/, "");
      const file = path.resolve(USER_ASSET_DIR, rel);
      if (file !== USER_ASSET_DIR && !file.startsWith(USER_ASSET_DIR + path.sep)) return new Response("forbidden", { status: 403 });
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return new Response("not found", { status: 404 });
      const ext = path.extname(file).toLowerCase();
      const type = { ".png": "image/png", ".gif": "image/gif", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf", ".json": "application/json", ".atlas": "text/plain", ".skel": "application/octet-stream" }[ext] || "application/octet-stream";
      return new Response(fs.readFileSync(file), { headers: { "content-type": type } });
    } catch { return new Response("bad request", { status: 400 }); }
  });
}

let win = null;
let tray = null;
let helpWin = null; // 使用说明窗口
let quickstartWin = null; // 新手教程窗口
let settingsWin = null; // 设置窗口
let voiceWin = null; // 音色克隆与训练窗口
let moodWin = null; // 表情管理窗口
let termsWin = null; // 使用条款确认窗口
let scheduleWin = null; // 日程管理窗口
let psdWin = null;      // PSD 角色工具窗口（v2.1）
let agentApiAbort = null; // Agent 接口当前请求的中止控制器
let agentAskQueue = createAskQueue(3);   // /chat 串行化并发锁（v2.6：防双发双倍 API 费 + 历史乱序；队列满 429 兜底）
let activeReq = null; // { id, sender, abort }
const askBuffer = createDebounceBuffer(); // 消息生成防抖（v2.6）：生成/合成中来的消息只留最新一条，回合结束补发
let pendingAskTimer = null;               // 合并窗口定时器（每次新消息重置）
const ASK_COALESCE_MS = 300;              // 连续快速发送的合并窗口：窗口内多条只留最后一条
let forcedMode = "auto"; // auto | chat | zcode
let personaCache = config.getPersonaText();
let quitting = false;
let renderCrashCount = 0;      // 渲染进程崩溃自动重载计数（60s 内连崩 3 次停止自愈）
let renderCrashWindowAt = 0;
/** §14 追加 102：任意窗口渲染进程崩溃诊断+自愈——日志带窗口标识与关键状态，连续 3 次停止自愈 */
function attachCrashDiag(w, label) {
  if (!w || w.__crashDiag) return;
  w.__crashDiag = true;
  w.webContents.on("render-process-gone", (_e, d) => {
    const now = Date.now();
    if (now - renderCrashWindowAt > 60000) { renderCrashWindowAt = now; renderCrashCount = 0; }
    renderCrashCount += 1;
    logTts("render", "渲染进程异常退出 窗口=" + label +
      " reason=" + (d && d.reason || "?") + " exitCode=" + (d && d.exitCode) +
      " 状态=" + (config.getConfig().renderMode || "gif") + (walk.active ? "/走" : "/停") +
      " 第" + renderCrashCount + "次（60s内），自动重载");
    if (renderCrashCount >= 3) { logTts("render", "渲染进程连续崩溃，停止自动重载（可手动重启桌宠）"); return; }
    try { w.reload(); } catch { /* 窗口已销毁 */ }
  });
}

/* ---------- 隐藏 / 显示 ---------- */
function isWindowVisible() {
  return win && !win.isDestroyed() && win.isVisible();
}
function showWindow() {
  if (!win || win.isDestroyed()) return;
  win.show();
  // 从托盘恢复时先接收一次鼠标命中，渲染层后续会按透明区域重新开启穿透。
  win.setIgnoreMouseEvents(false);
  applyLayer(walk.active || walk.seated);
  win.focus();
}
function hideWindow() {
  cancelFlight();
  cancelWalkJump();
  if (win && !win.isDestroyed()) win.hide();
}
function toggleWindow() {
  if (isWindowVisible()) hideWindow();
  else showWindow();
}

/* ---------- 显示层级（置顶眼前 / 桌面层级）与坐任务栏 ---------- */
/** 应用显示层级：top=置顶（所有窗口之上）| desktop=桌面层级（可被其他程序窗口遮挡）。
 *  桌面层级下仅当窗口接触任务栏表面（贴地/坐姿下沉探入任务栏区）时才置顶，防止被任务栏盖住；
 *  其余情况（走在图标区、跳上图标/窗顶）让位于普通程序窗口＝真的在桌面上。
 *  参数已废弃：是否接触任务栏改由窗口几何位置判断，调用处无需再传。 */
function applyLayer(_forceTop) {
  if (!win || win.isDestroyed()) return;
  let onTop = (config.getConfig().layer || "top") !== "desktop";
  if (!onTop) {
    // desktop 层级：仅主动交互（跳窗顶/跳跃/返回）临时置顶；坐姿/行走不再置顶（用户诉求：桌面级可被普通窗口覆盖）
    if (walk.perched || walk.gotoPerch || walk.returning || walk.jump) onTop = true;
  }
  win.setAlwaysOnTop(onTop, "screen-saver");
}
function setPetLayer(v) {
  config.saveConfig({ layer: v === "desktop" ? "desktop" : "top" });
  refreshTrayMenu();
  applyLayer(walk.active || walk.seated); // 接触任务栏表面时仍保持置顶
  logTts("walk", "显示层级: " + config.getConfig().layer);
}
ipcMain.handle("pet:set-layer", (_e, v) => { setPetLayer(v); return true; });

/** 一键坐到任务栏上：角色脚底贴齐任务栏上沿（窗口按 groundGap 下探补偿），播放 Sit 坐姿 */
function sitOnTaskbar() {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  const wa = walkGeo.workAreaOf(screen, b);
  win.setPosition(
    Math.min(Math.max(b.x, walkMinX(wa)), wa.x + wa.width - b.width),
    wa.y + wa.height + walk.groundGap - b.height
  );
  showWindow();
  walk.seated = true;
  walk.resting = true;
  walk.perched = false;
  walk.gotoPerch = false;
  walk.returning = false;
  applySeatPosition();
  walkBroadcast(); // 渲染层切 Sit 坐姿
  logTts("walk", "坐到任务栏上");
}
ipcMain.handle("pet:sit-taskbar", () => { sitOnTaskbar(); return true; });

function clampPetToWorkArea(reason = "显示器变化") {
  if (!win || win.isDestroyed()) return;
  try {
    const b = win.getBounds();
    const wa = walkGeo.workAreaOf(screen, b);
    const x = Math.min(Math.max(b.x, walkMinX(wa)), Math.max(walkMinX(wa), wa.x + wa.width - b.width));
    const maxY = wa.y + wa.height - b.height + 80; // 保留坐姿下沉到任务栏的空间
    const y = Math.min(Math.max(b.y, wa.y), Math.max(wa.y, maxY));
    if (x !== b.x || y !== b.y) {
      win.setPosition(Math.round(x), Math.round(y));
      logTts("display", reason + "，已钳制到工作区");
    }
    applyLayer();
  } catch (e) {
    logTts("display", reason + "，坐标钳制失败: " + (e && e.message || e));
  }
}
let displayClampTimer = null;
function scheduleDisplayClamp(reason) {
  clearTimeout(displayClampTimer);
  displayClampTimer = setTimeout(() => clampPetToWorkArea(reason), 180);
}

/* ---------- 窗口 ---------- */
function createWindow() {
  const cfg = config.getConfig();
  const scale = clampScale(cfg.window.scale);
  const w = Math.round((cfg.window.width || 260) * scale);
  const h = Math.round((cfg.window.height || 200) * scale);

  win = new BrowserWindow({
    width: w,
    height: h,
    title: config.fillTokens("{{petName}}桌宠"),
    x: cfg.window.x ?? undefined,
    y: cfg.window.y ?? undefined,
    transparent: true,
    backgroundColor: "#00000000",
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    webPreferences: winChild.childWebPrefs(config.APP_DIR)
  });

  applyLayer();
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(config.APP_DIR, "renderer", "index.html"));
  // 渲染进程异常退出（崩溃/OOM/被系统回收）：自动重载恢复，防桌宠无声消失；60s 内连续 3 次则停止自愈
    win.webContents.on("render-process-gone", (_e, details) => {
    const now = Date.now();
    if (now - renderCrashWindowAt > 60000) { renderCrashWindowAt = now; renderCrashCount = 0; }
    renderCrashCount += 1;
    // 全量崩溃详情（exitCode/reason/内存），minidump 在 userData 下由 crashReporter 收集
    const d = details || {};
    logTts("render", "渲染进程异常退出 窗口=main(" + require("path").basename(win.webContents.getURL() || "") + ")" +
      " reason=" + (d.reason || "?") + " exitCode=" + d.exitCode +
      " 状态=" + (config.getConfig().renderMode || "gif") + (walk.active ? "/走" : "/停") +
      " 第" + renderCrashCount + "次（60s内），自动重载");
    if (renderCrashCount >= 3) { logTts("render", "渲染进程连续崩溃，停止自动重载（可手动重启桌宠）"); return; }
    try {
      win.reload();
      setTimeout(() => {
        if (walk.active) walkBroadcast();
        if (walk.edgeLeft) sendToRenderer("pet:edge-left", true); // 重载后恢复翻边布局，避免条带位置不一致
      }, 3000);
    } catch (e2) { logTts("render", "自动重载失败: " + (e2 && e2.message || e2)); }
  });
  // 初始即开启点击穿透（透明区域不挡下层应用），由渲染层按需放行
  win.setIgnoreMouseEvents(true, { forward: true });
  startOutOfScreenGuard(); // 出屏哨兵：任何路径导致窗口严重滑出屏幕时 2s 内钳回（防角色在屏幕边缘“闪现”/消失）

  // 启动时把窗口钳回屏幕工作区内（布局变宽后旧位置可能越界）
  clampPetToWorkArea("启动");

  // 位置持久化
  const savePos = () => {
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    const [x, y] = win.getPosition();
    // 屏幕外/异常位置不保存（被拖出屏幕后重启会恢复到屏幕外；跳过让下次启动钳回正常位置）
    try {
      const wa = walkGeo.workAreaOf(screen, win.getBounds());
      if (y > wa.y + wa.height || y + 40 < wa.y) return;
      if (x < wa.x - 200 || x > wa.x + wa.width) return; // 水平出屏不保存（异常 charInset/切边导致 x 滑出屏幕时，重启回到正常位置而非屏幕外）
    } catch { /* 忽略，照常保存 */ }
    config.saveConfig({ window: { x, y } });
  };
  win.on("moved", debounce(savePos, 500));
  win.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      hideWindow(); // 关窗 = 隐藏到托盘
    }
  });
  win.on("closed", () => { win = null; });

  // 启动即隐藏（仅托盘运行）
  if (config.getConfig().startHidden) hideWindow();
}

// 出屏哨兵：异常 charInset 上报/拖拽/抛掷/崩溃重载都可能把窗口推出屏幕，
// 独立定时器每 2s 检查一次，严重出屏立即钳回可见工作区（水平容差 200px 内不干预正常贴边；垂直只处理完全不可见的越界，坐姿下沉不受影响）。
let outOfScreenTimer = null;
function startOutOfScreenGuard() {
  if (outOfScreenTimer) return;
  outOfScreenTimer = setInterval(() => {
    try { outOfScreenGuard(); } catch { /* 忽略 */ }
  }, 2000);
}
function stopOutOfScreenGuard() {
  if (outOfScreenTimer) { clearInterval(outOfScreenTimer); outOfScreenTimer = null; }
}

function debounce(fn, ms) {
  let t = null;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/* ---------- 托盘 ---------- */
function createTray() {
  let icon = nativeImage.createEmpty();
  try { icon = nativeImage.createFromPath(ICON_PATH); } catch { /* 无图标用空图 */ }
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip("苏苏洛桌宠（点击隐藏/显示）");
  refreshTrayMenu();
  tray.on("click", () => toggleWindow());
  tray.on("double-click", () => {
    showWindow();
    sendToRenderer("pet:toggle-input");
  });
}

function refreshTrayMenu() {
  const cfg = config.getConfig();
  const lang = cfg.uiLang || "zh";
  const zcodeOn = !!cfg.zcodeEnabled;
  const items = buildTrayItems({
    cfg, lang, i18n, zcodeOn, forcedMode,
    isWindowVisible, toggleWindow, setMode, setTts, setRate, setSpeakJa, setWalking,
    detectSpineModels, skinParseDir, SPINE_CN, SKIN_CHAR_NAMES, SKIN_PERSON_NAMES, setSpineSkin,
    sendToRenderer, setPetLayer, openPsdWindow, rigSkinList, setRigSkin,
    setDimMode, sitOnTaskbar, setScale, clampScale, setWalkSpeed, setCatToy,
    setFileGuard,
    openSchedule, openSettings, openMoodManager, openVoiceStudio, openTtsGuide, openQuickstart, openHelp, openAddChar,
    openDocs,
    reloadPersona: () => { personaCache = config.getPersonaText(); sendToRenderer("pet:toast", i18n.t(lang, "tray.personaReloaded")); },
    openConfigPath: () => shell.openPath(config.CONFIG_PATH),
    openPersonaPath: () => shell.openPath(config.PERSONA_PATH),
    quitApp: () => { quitting = true; savePosSafe(); app.quit(); }
  });
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

/* ---------- 使用说明窗口 ---------- */
function openHelp() {
  if (helpWin && !helpWin.isDestroyed()) { helpWin.focus(); return; }
  helpWin = new BrowserWindow({
    width: 470,
    height: 620,
    minWidth: 420,
    minHeight: 520,
    resizable: true,
    title: "苏苏洛使用说明",
    autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });
  helpWin.setMenuBarVisibility(false);
  helpWin.loadFile(path.join(config.APP_DIR, "renderer", "help.html"));
attachCrashDiag(helpWin, "help");
    helpWin.on("closed", () => { helpWin = null; });
}

/* ---------- 新手教程窗口 ---------- */
function openQuickstart() {
  if (quickstartWin && !quickstartWin.isDestroyed()) { quickstartWin.focus(); return; }
  quickstartWin = new BrowserWindow({
    width: 700,
    height: 780,
    minWidth: 520,
    minHeight: 560,
    resizable: true,
    title: "苏苏洛 · 快速开始（新手教程）",
    autoHideMenuBar: true,
    webPreferences: winChild.childWebPrefs(config.APP_DIR)
  });
  quickstartWin.setMenuBarVisibility(false);
  quickstartWin.loadFile(path.join(config.APP_DIR, "renderer", "quickstart.html"));
attachCrashDiag(quickstartWin, "quickstart");
    quickstartWin.on("closed", () => { quickstartWin = null; });
}

function setTts(enabled) {
  config.saveConfig({ tts: { enabled: !!enabled } });
  refreshTrayMenu();
  sendToRenderer("pet:tts-changed", !!enabled);
  if (enabled) {
    // 语音开 → 确保本地 Genie TTS 服务器可用（后台拉起）
    const q = config.getConfig().ttsGenie || {};
    if (q.enabled) {
      tts.resetGenieServer(); // 重置 Genie 状态标志（tts-manager 内部管理），下次 ensureGenieServer 重新探活/拉起
      tts.ensureGenieServer(q).then((ok) => logTts("genie", "语音开启 → 服务器: " + (ok ? "已就绪" : "不可用")));
    }
  } else {
    // 语音关 → 停掉本地 TTS 服务器，释放显存
    tts.shutdownGenieServer();
  }
}

/** 调整语速（0.6~1.5，<1 更慢，>1 更快），保存到 tts.rate 并通知渲染层 */
function setRate(rate) {
  const v = Math.max(0.6, Math.min(1.5, parseFloat(rate) || 0.9));
  config.saveConfig({ tts: { rate: v } });
  refreshTrayMenu();
  sendToRenderer("pet:tts-rate-changed", v);
}
ipcMain.handle("pet:set-rate", (_e, rate) => { setRate(rate); return true; });
ipcMain.handle("pet:set-speak-ja", (_e, v) => { setSpeakJa(!!v); return true; });

/** 日语语音模式：说话前把中文翻译成日语（文字/聊天保持中文）；保存并通知渲染层 */
function setSpeakJa(v) {
  config.saveConfig({ ttsGenie: { speakJa: !!v } });
  refreshTrayMenu();
  sendToRenderer("pet:speak-ja-changed", !!v);
  logTts("ja", "日语语音模式: " + (!!v ? "开" : "关"));
}

/* ---------- 界面语言（中 / 英 / 日，可切换；聊天内容始终中文） ---------- */
function sendToAllWindows(channel, ...args) {
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.webContents.send(channel, ...args); } catch { /* 忽略 */ }
  }
}
ipcMain.handle("pet:get-i18n", () => {
  const lang = config.getConfig().uiLang || "zh";
  return { lang, dict: i18n.getDict(lang) };
});
ipcMain.handle("pet:set-ui-lang", (_e, lang) => {
  const v = ["zh", "en", "ja"].includes(String(lang)) ? String(lang) : "zh";
  config.saveConfig({ uiLang: v });
  refreshTrayMenu();
  sendToAllWindows("pet:ui-lang-changed", v);
  return true;
});


/* ---------- 设置窗口 ---------- */
function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 720,
    height: 800,
    minWidth: 560,
    minHeight: 620,
    resizable: true,
    title: "苏苏洛 · 设置",
    autoHideMenuBar: true,
    webPreferences: winChild.childWebPrefs(config.APP_DIR)
  });
  settingsWin.setMenuBarVisibility(false);
  settingsWin.loadFile(path.join(config.APP_DIR, "renderer", "settings.html"));
attachCrashDiag(settingsWin, "settings");
    settingsWin.on("closed", () => { settingsWin = null; });
}

function openSchedule() {
  if (scheduleWin && !scheduleWin.isDestroyed()) { scheduleWin.focus(); return; }
  scheduleWin = new BrowserWindow({ width: 820, height: 700, minWidth: 620, minHeight: 520, resizable: true, title: "苏苏洛 · 日程安排", autoHideMenuBar: true,
    webPreferences: winChild.childWebPrefs(config.APP_DIR) });
  scheduleWin.setMenuBarVisibility(false);
  scheduleWin.loadFile(path.join(config.APP_DIR, "renderer", "schedule.html"));
attachCrashDiag(scheduleWin, "schedule");
    scheduleWin.on("closed", () => { scheduleWin = null; });
}

function openPsdWindow() {
  if (psdWin && !psdWin.isDestroyed()) { psdWin.focus(); return; }
  psdWin = new BrowserWindow({ width: 860, height: 720, minWidth: 640, minHeight: 520, resizable: true, title: "苏苏洛 · PSD 角色工具", autoHideMenuBar: true,
    webPreferences: winChild.childWebPrefs(config.APP_DIR) });
  psdWin.setMenuBarVisibility(false);
  psdWin.loadFile(path.join(config.APP_DIR, "renderer", "psd.html"));
attachCrashDiag(psdWin, "psd");
    psdWin.on("closed", () => { psdWin = null; });
}

/* ---------- 文档中心（v2.5.1）---------- */
let docsWin = null;

/** 文档清单：新手教程在 exe 旁（发布目录），其余在应用内（asar）。白名单按此固定生成。 */
function docsManifest() {
  const exeDir = path.dirname(process.execPath || "");
  const appDir = config.APP_DIR;
  const items = [];
  try {
    const nb = path.join(exeDir, "新手教程");
    for (const f of fs.readdirSync(nb)) {
      if (f.endsWith(".md")) {
        items.push({ key: "newbie/" + f, name: f.replace(/^\d+-/, "").replace(/\.md$/, ""), group: "新手教程", file: path.join(nb, f), html: false });
      }
    }
  } catch (e) { /* dev 运行无发布目录时跳过新手教程 */ }
  const quickstart = path.join(appDir, "!!开箱必读-先看我.html");
  if (fs.existsSync(quickstart)) items.push({ key: "app/开箱必读.html", name: "⭐ 开箱必读（三步上手）", group: "使用说明", file: quickstart, html: true });
  const usage = path.join(appDir, "使用说明.html");
  if (fs.existsSync(usage)) items.push({ key: "app/使用说明.html", name: "使用说明", group: "使用说明", file: usage, html: true });
  const readme = path.join(appDir, "README.md");
  if (fs.existsSync(readme)) items.push({ key: "app/README.md", name: "README（项目介绍）", group: "项目文档", file: readme, html: false });
  const vg = path.join(appDir, "语音部署与训练指南", "总览.html");
  if (fs.existsSync(vg)) items.push({ key: "app/语音指南", name: "语音部署与训练指南", group: "进阶文档", file: vg, html: true });
  const apiguide = path.join(appDir, "API接入指南.html");
  if (fs.existsSync(apiguide)) items.push({ key: "app/API接入指南.html", name: "API 接入指南（学生白嫖版）", group: "进阶文档", file: apiguide, html: true });
  return items;
}

function openDocs() {
  if (docsWin && !docsWin.isDestroyed()) { docsWin.focus(); return; }
  docsWin = new BrowserWindow({ width: 940, height: 720, minWidth: 700, minHeight: 520, resizable: true, title: "苏苏洛 · 文档中心", autoHideMenuBar: true,
    webPreferences: winChild.childWebPrefs(config.APP_DIR) });
  docsWin.setMenuBarVisibility(false);
  docsWin.loadFile(path.join(config.APP_DIR, "renderer", "docs.html"));
  attachCrashDiag(docsWin, "docs");
  docsWin.on("closed", () => { docsWin = null; });
}
ipcMain.handle("docs:list", () => docsManifest().map(({ key, name, group, html }) => ({ key, name, group, html })));
ipcMain.handle("docs:read", (_e, key) => {
  try {
    const it = docsManifest().find((d) => d.key === key);
    if (!it) return { ok: false, error: "文档不存在" };
    if (it.html) return { ok: true, html: true, url: require("url").pathToFileURL(it.file).href }; // 中文路径必须编码，否则 iframe 打不开
    return { ok: true, html: false, text: fs.readFileSync(it.file, "utf8") };
  } catch (e) { return { ok: false, error: e && e.message }; }
});
ipcMain.handle("pet:open-docs", () => { openDocs(); return true; });

/* ---------- Live2D 模型扫描（v2.5.1）---------- */
/** 列出可用 Live2D 模型：内置示例（asar 内 renderer/live2d/models/）+ 用户模型（userData assets/live2d/） */
ipcMain.handle("pet:live2d-list", () => {
  const out = [];
  const scan = (base, prefix, nameSuffix, urlOf) => {
    try {
      for (const dir of fs.readdirSync(base)) {
        const full = path.join(base, dir);
        if (!fs.statSync(full).isDirectory()) continue;
        const mf = fs.readdirSync(full).find((f) => f.endsWith(".model3.json"));
        if (mf) out.push({ id: prefix + dir, name: dir + nameSuffix, url: urlOf(dir, mf) });
      }
    } catch (e) { /* 目录不存在则跳过 */ }
  };
  scan(path.join(config.APP_DIR, "renderer", "live2d", "models"), "builtin/", "（内置示例）",
    (dir, mf) => "live2d/models/" + encodeURIComponent(dir) + "/" + encodeURIComponent(mf));
  scan(path.join(config.STORAGE.userDir, "assets", "live2d"), "user/", "",
    (dir, mf) => "pet-user://live2d/" + encodeURIComponent(dir) + "/" + encodeURIComponent(mf));
  return out;
});
let rendererReloadAt = 0;
ipcMain.handle("pet:reload-renderer", () => { // WebGL 上下文丢失等场景的渲染层自愈（60s 节流）
  const now = Date.now();
  if (!win || win.isDestroyed() || now - rendererReloadAt < 60000) return false;
  rendererReloadAt = now;
  logTts("render", "渲染层自愈：webContents.reload（WebGL 上下文丢失/渲染异常）");
  win.webContents.reload();
  return true;
});
app.whenReady().then(() => { // 低配/软件渲染提示（无硬加速能跑但慢）
  try {
    const st = app.getGPUFeatureStatus();
    if (String(st.webgl || "").includes("software") || String(st.webgl || "") === "disabled") {
      logTts("render", "GPU 状态: webgl=" + (st.webgl || "?") + "（软件渲染/无硬件加速，动画可能卡顿，建议更新显卡驱动）");
    }
  } catch { /* 忽略 */ }
});
ipcMain.handle("pet:live2d-select", (_e, id) => {
  config.saveConfig({ live2dSkinId: String(id || "") });
  sendToRenderer("pet:live2d-changed", String(id || ""));
  return true;
});

ipcMain.handle("pet:psd-open", () => { openPsdWindow(); return true; });
ipcMain.handle("pet:psd-save", (_e, dataUrl, label) => { // 保存扁平化 PNG 到用户数据目录
  try {
    const m = String(dataUrl || "").match(/^data:image\/png;base64,(.+)$/);
    if (!m) return { ok: false, message: "非 PNG dataURL" };
    const dir = config.STORAGE.psdExport;
    fs.mkdirSync(dir, { recursive: true });
    const safe = String(label || "psd").replace(/[^\w\u4e00-\u9fa5-]+/g, "_").slice(0, 40);
    const file = path.join(dir, "psd-export-" + Date.now() + "-" + safe + ".png");
    fs.writeFileSync(file, Buffer.from(m[1], "base64"));
    logTts("psd", "导出: " + file);
    return { ok: true, path: file };
  } catch (e) {
    return { ok: false, message: String(e.message || e) };
  }
});

/* ---------- 表情管理（换装，动态情绪表） ---------- */
const SPRITE_USER_DIR = config.STORAGE.spritesUser;
const SPRITE_DEFAULT_DIR = config.STORAGE.spritesDefault;

/** 情绪表来自 config.json（moods），支持自定义增删 */
function getMoodList() {
  const cfg = config.getConfig();
  return Array.isArray(cfg.moods) && cfg.moods.length ? cfg.moods : [];
}

/* ---------- 添加人物窗口（v2.5.7）：文件夹导入 Spine 模型 → spine/user/<名>/ → 自动切换 ---------- */
let addCharWin = null;
function openAddChar() {
  if (addCharWin && !addCharWin.isDestroyed()) { addCharWin.focus(); return; }
  addCharWin = new BrowserWindow({
    width: 640,
    height: 480,
    minWidth: 520,
    minHeight: 400,
    resizable: true,
    title: "苏苏洛 · 添加人物",
    autoHideMenuBar: true,
    webPreferences: winChild.childWebPrefs(config.APP_DIR)
  });
  addCharWin.setMenuBarVisibility(false);
  addCharWin.loadFile(path.join(config.APP_DIR, "renderer", "addchar.html"));
attachCrashDiag(addCharWin, "addchar");
    addCharWin.on("closed", () => { addCharWin = null; });
}
ipcMain.handle("pet:import-spine", async () => {
  try {
    const r = await dialog.showOpenDialog(addCharWin || win, {
      title: "选择包含人物模型文件的文件夹（.atlas + .skel/.json + .png）",
      properties: ["openDirectory"]
    });
    if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, error: "已取消" };
    const dir = r.filePaths[0];
    let files = [];
    try { files = fs.readdirSync(dir); } catch { return { ok: false, error: "无法读取该文件夹" }; }
    const atlas = files.find((f) => f.toLowerCase().endsWith(".atlas"));
    if (!atlas) return { ok: false, error: "文件夹里没有 .atlas 文件（Spine 模型必需）" };
    const base = atlas.slice(0, -".atlas".length);
    const skel = files.find((f) => f.toLowerCase() === (base + ".skel").toLowerCase())
      || files.find((f) => f.toLowerCase() === (base + ".json").toLowerCase());
    if (!skel) return { ok: false, error: "缺少与图集同名的 .skel/.json 骨架文件" };
    const png = files.find((f) => f.toLowerCase().endsWith(".png"));
    if (!png) return { ok: false, error: "缺少 .png 图集贴图（Spine 导出通常 atlas+skel+png 三个文件）" };
    const dirName = path.basename(dir).replace(/[^\w一-龥-]+/g, "_").slice(0, 40) || ("model_" + Date.now().toString(36));
    const target = path.join(config.STORAGE.spineUser, dirName);
    fs.mkdirSync(target, { recursive: true });
    for (const f of [atlas, skel, png]) fs.copyFileSync(path.join(dir, f), path.join(target, f));
    const list = detectSpineModels();
    const entry = list.find((m) => m.id === dirName + "/" + base);
    if (entry) setSpineSkin(entry.id); // 导入后自动切换
    logTts("spine", "导入人物: " + dirName + "/" + base + " ← " + dir);
    return { ok: true, id: entry ? entry.id : dirName + "/" + base, name: entry ? entry.name : base, list: list.map((m) => ({ id: m.id, name: m.name })) };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});
function openMoodManager() {
  if (moodWin && !moodWin.isDestroyed()) { moodWin.focus(); return; }
  moodWin = new BrowserWindow({
    width: 760,
    height: 680,
    minWidth: 560,
    minHeight: 520,
    resizable: true,
    title: "苏苏洛 · 表情管理",
    autoHideMenuBar: true,
    webPreferences: winChild.childWebPrefs(config.APP_DIR)
  });
  moodWin.setMenuBarVisibility(false);
  moodWin.loadFile(path.join(config.APP_DIR, "renderer", "moods.html"));
attachCrashDiag(moodWin, "mood");
    moodWin.on("closed", () => { moodWin = null; });
}

/** 首次打开时把当前表情备份到 sprites/default/（供「恢复默认」） */
function ensureSpriteBackup() {
  try {
    if (fs.existsSync(SPRITE_DEFAULT_DIR)) return true;
    if (!fs.existsSync(SPRITE_USER_DIR)) return false;
    fs.mkdirSync(SPRITE_DEFAULT_DIR, { recursive: true });
    for (const f of fs.readdirSync(SPRITE_USER_DIR)) {
      if (/\.(gif|png|webp|jpg)$/i.test(f)) {
        fs.copyFileSync(path.join(SPRITE_USER_DIR, f), path.join(SPRITE_DEFAULT_DIR, f));
      }
    }
    return true;
  } catch (e) {
    try { logTts("sprites", "备份表情失败: " + (e && e.message || e)); } catch { /* 忽略 */ }
    return false;
  }
}

ipcMain.handle("pet:get-moods", () => {
  ensureSpriteBackup();
  const out = [];
  for (const m of getMoodList()) {
    const f = path.join(SPRITE_USER_DIR, m.name + ".gif");
    let exists = false, size = 0;
    try { exists = fs.existsSync(f); if (exists) size = fs.statSync(f).size; } catch { /* 忽略 */ }
    out.push({ name: m.name, label: m.label, emotion: !!m.emotion, custom: !!m.custom, exists, size });
  }
  return { moods: out, userDir: SPRITE_USER_DIR };
});

ipcMain.handle("pet:pick-gif", async () => {
  const parent = (moodWin && !moodWin.isDestroyed()) ? moodWin : win;
  const r = await dialog.showOpenDialog(parent, {
    properties: ["openFile"],
    title: "选择表情 GIF（透明背景）",
    filters: [
      { name: "GIF 表情", extensions: ["gif"] },
      { name: "图片", extensions: ["png", "webp", "jpg", "jpeg"] },
      { name: "所有文件", extensions: ["*"] }
    ]
  });
  return r.canceled ? "" : r.filePaths[0];
});

ipcMain.handle("pet:apply-gif", (_e, { name, filePath }) => {
  try {
    if (!name || !filePath) return { ok: false, message: "参数缺失" };
    if (!getMoodList().some((m) => m.name === name)) return { ok: false, message: "未知情绪: " + name };
    if (!fs.existsSync(filePath)) return { ok: false, message: "文件不存在: " + filePath };
    fs.mkdirSync(SPRITE_USER_DIR, { recursive: true });
    fs.copyFileSync(filePath, path.join(SPRITE_USER_DIR, name + ".gif"));
    sendToRenderer("pet:sprites-changed", { name, moods: getMoodList() });
    return { ok: true, message: "已应用 ✅" };
  } catch (e) {
    return { ok: false, message: String(e.message || e) };
  }
});

ipcMain.handle("pet:reset-gif", (_e, name) => {
  try {
    if (!name) return { ok: false, message: "参数缺失" };
    const from = path.join(SPRITE_DEFAULT_DIR, name + ".gif");
    if (!fs.existsSync(from)) return { ok: false, message: "没有可恢复的默认表情（备份不存在）" };
    fs.copyFileSync(from, path.join(SPRITE_USER_DIR, name + ".gif"));
    sendToRenderer("pet:sprites-changed", { name, moods: getMoodList() });
    return { ok: true, message: "已恢复默认 ✅" };
  } catch (e) {
    return { ok: false, message: String(e.message || e) };
  }
});

ipcMain.handle("pet:add-mood", (_e, label) => {
  try {
    const clean = String(label || "").trim();
    if (!clean) return { ok: false, message: "情绪名不能为空" };
    if (clean.length > 5) return { ok: false, message: "情绪名不能超过 5 个字（当前 " + clean.length + " 字）" };
    if (/[/\\:*?"<>|]/.test(clean)) return { ok: false, message: "情绪名不能包含特殊字符" };
    const list = getMoodList();
    if (list.length >= 30) return { ok: false, message: "情绪数量已达上限（最多 30 个）" };
    if (list.some((m) => m.label === clean || m.name === clean)) return { ok: false, message: "已存在同名情绪: " + clean };
    list.push({ name: clean, label: clean, emotion: true, custom: true });
    config.saveConfig({ moods: list });
    sendToRenderer("pet:sprites-changed", { name: clean, moods: list });
    return { ok: true, message: "已添加情绪「" + clean + "」，去选一个 GIF 吧" };
  } catch (e) {
    return { ok: false, message: String(e.message || e) };
  }
});

ipcMain.handle("pet:remove-mood", (_e, name) => {
  try {
    const list = getMoodList();
    const m = list.find((x) => x.name === name);
    if (!m) return { ok: false, message: "未知情绪" };

    // 最少保留检查：至少各保留 1 个待机和 1 个情绪
    const remaining = list.filter((x) => x.name !== name);
    const hasIdle = remaining.some((x) => !x.emotion);
    const hasEmotion = remaining.some((x) => x.emotion);
    if (!hasIdle || !hasEmotion) {
      return { ok: false, message: "至少需要保留 1 个待机表情和 1 个情绪表情，无法继续删除" };
    }

    const list2 = remaining;
    config.saveConfig({ moods: list2 });
    fs.unlink(path.join(SPRITE_USER_DIR, name + ".gif"), () => {});
    sendToRenderer("pet:sprites-changed", { name, moods: list2 });
    return { ok: true, message: "已删除情绪「" + m.label + "」" };
  } catch (e) {
    return { ok: false, message: String(e.message || e) };
  }
});

ipcMain.handle("pet:rename-mood", (_e, { name, newLabel }) => {
  // 改「用途/名字」：GIF 文件不动，只改情绪词（模型按新词理解）
  try {
    const clean = String(newLabel || "").trim();
    if (!clean) return { ok: false, message: "名字不能为空" };
    if (clean.length > 5) return { ok: false, message: "名字不能超过 5 个字（当前 " + clean.length + " 字）" };
    const list = getMoodList();
    const m = list.find((x) => x.name === name);
    if (!m) return { ok: false, message: "未知情绪" };
    if (list.some((x) => x !== m && x.label === clean)) return { ok: false, message: "已存在同名情绪: " + clean };
    m.label = clean;
    config.saveConfig({ moods: list });
    sendToRenderer("pet:sprites-changed", { name, moods: list });
    return { ok: true, message: "已改名为「" + clean + "」" };
  } catch (e) {
    return { ok: false, message: String(e.message || e) };
  }
});

ipcMain.handle("pet:set-mood-type", (_e, { name, emotion }) => {
  // 切换「待机 ↔ 情绪」用途：待机只作休息循环图，情绪词会进 AI 理解词表
  try {
    const list = getMoodList();
    const m = list.find((x) => x.name === name);
    if (!m) return { ok: false, message: "未知情绪" };
    const isEmotion = !!emotion;
    if (isEmotion) {
      const idleCount = list.filter((x) => !x.emotion && x.name !== name).length;
      if (idleCount === 0) return { ok: false, message: "至少要留一个「待机」作为休息循环图" };
    }
    m.emotion = isEmotion;
    config.saveConfig({ moods: list });
    sendToRenderer("pet:sprites-changed", { name, moods: list });
    return { ok: true, message: isEmotion ? "已设为「情绪」（AI 会用它）" : "已设为「待机」（休息循环用）" };
  } catch (e) {
    return { ok: false, message: String(e.message || e) };
  }
});

/* ---------- 使用条款强制确认 ---------- */
function openTerms() {
  if (termsWin && !termsWin.isDestroyed()) { termsWin.focus(); return; }
  termsWin = new BrowserWindow({
    width: 660,
    height: 760,
    minWidth: 520,
    minHeight: 560,
    resizable: true,
    title: "苏苏洛 · 使用条款与隐私政策",
    autoHideMenuBar: true,
    webPreferences: winChild.childWebPrefs(config.APP_DIR)
  });
  termsWin.setMenuBarVisibility(false);
  termsWin.loadFile(path.join(config.APP_DIR, "renderer", "terms.html"));
attachCrashDiag(termsWin, "terms");
    termsWin.on("closed", () => { termsWin = null; });
}

ipcMain.handle("pet:agree-terms", () => {
  config.saveConfig({ agreed: true });
  refreshTrayMenu();
  sendToRenderer("pet:terms-agreed");
  // 同意后：首次运行且无 Key → 自动打开设置引导
  const cfg = config.getConfig(true);
  if (cfg.firstRun) {
    config.saveConfig({ firstRun: false });
    if (!cfg.chat.apiKey) {
      setTimeout(() => {
        openSettings();
        sendToRenderer("pet:toast", "首次使用：请在设置里填写 API Key 与称呼 💕");
      }, 800);
    }
  }
  return true;
});

ipcMain.handle("pet:refuse-terms", () => {
  quitting = true;
  app.quit();
  return true;
});
ipcMain.handle("pet:open-terms", () => { openTerms(); return true; });
ipcMain.handle("pet:open-quickstart", () => { openQuickstart(); return true; });

/* ---------- 桌宠大小缩放 ---------- */
function setScale(scale) {
  const s = clampScale(scale);
  config.saveConfig({ window: { scale: s } });
  if (win && !win.isDestroyed()) {
    const cfg = config.getConfig();
    const ws = Math.round((cfg.window.width || 260) * s);
    const hs = Math.round((cfg.window.height || 200) * s);
    win.setSize(ws, hs);
    setTimeout(() => clampPetToWorkArea("缩放"), 120);
    try {
      const wa = walkGeo.workAreaOf(screen, win.getBounds());
      const [x, y] = win.getPosition();
      win.setPosition(Math.min(Math.max(x, walkMinX(wa)), wa.x + wa.width - ws),
                      Math.min(Math.max(y, wa.y), wa.y + wa.height - hs + 80));
    } catch { /* 忽略 */ }
    applySeatPosition(); // 尺寸档位变了，若正处于坐姿立即按新档位重新落座
  }
  refreshTrayMenu();
  sendToRenderer("pet:scale-changed", s);
}
ipcMain.handle("pet:set-scale", (_e, scale) => { setScale(scale); return true; });
function setWalkSpeed(mul) { // 散步速度档位（借鉴 Ark-Pets 可调移速）
  const v = Math.max(0.4, Math.min(3, Number(mul) || 1));
  config.saveConfig({ walkSpeedMul: v });
  logTts("walk", "散步速度: x" + v);
  refreshTrayMenu();
}
function setDimMode(v) { // 半透明模式：角色变淡不挡视线（借鉴 Ark-Pets opacity_dim）
  config.saveConfig({ dimMode: !!v });
  sendToRenderer("pet:set-dim", !!v);
  logTts("walk", "半透明: " + (!!v ? "开" : "关"));
  refreshTrayMenu();
}
ipcMain.handle("pet:get-seat-sink", () => {
  const t = seatSinkTier();
  return { tier: t, value: getSeatSink(), default: SEAT_SINK_DEFAULTS[t] };
});
ipcMain.handle("pet:set-seat-sink", (_e, v) => {
  const n = Math.max(0, Math.min(80, Math.round(Number(v) || 0)));
  const t = seatSinkTier();
  config.saveConfig({ walkSeatSink: { ...config.getConfig().walkSeatSink, [t]: n } });
  applySeatPosition();
  return { tier: t, value: getSeatSink(), default: SEAT_SINK_DEFAULTS[t] };
});

/* ---------- 本地 Agent 调用接口（仅 127.0.0.1；可选 Bearer token） ---------- */
function safeTokenEqual(actual, expected) {
  const a = Buffer.from(String(actual || ""));
  const b = Buffer.from(String(expected || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
async function readAgentJson(req, maxBytes) {
  const declared = Number(req.headers["content-length"] || 0);
  if (declared > maxBytes) return { error: 413 };
  const parts = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) return { error: 413 };
    parts.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(parts).toString("utf8") || "{}");
    return body && typeof body === "object" && !Array.isArray(body) ? { body } : { error: 400 };
  } catch { return { error: 400 }; }
}
function startAgentApi() {
  const a = config.getConfig().agentApi || {};
  if (!a.enabled) return;
  const port = Math.max(1, Math.min(65535, parseInt(a.port, 10) || 8765));
  const server = http.createServer(async (req, res) => {
    let sent = false;
    const send = (code, obj, headers = {}) => {
      if (sent) return;
      sent = true;
      const body = JSON.stringify(obj);
      res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body), ...headers });
      res.end(body);
    };
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (url.search || !["/health", "/chat", "/stop"].includes(url.pathname)) { send(404, { ok: false, error: "not found" }); return; }
      const allowed = url.pathname === "/health" ? "GET" : "POST";
      if (req.method !== allowed) { send(405, { ok: false, error: "method not allowed" }, { Allow: allowed }); return; }
      const cfg = config.getConfig();
      const apiCfg = cfg.agentApi || {};
      const token = String(apiCfg.bearerToken || "");
      if (token) {
        const auth = String(req.headers.authorization || "");
        const match = auth.match(/^Bearer ([^\s]+)$/i);
        if (!match || !safeTokenEqual(match[1], token)) { send(401, { ok: false, error: "unauthorized" }, { "WWW-Authenticate": "Bearer" }); return; }
      }
      if (url.pathname === "/health") {
        send(200, { ok: true, name: (cfg.pet || {}).name || "苏苏洛", invokeWord: apiCfg.invokeWord || "", authRequired: !!token }); // v2.6 收敛：不暴露 agreed
        return;
      }
      if (url.pathname === "/stop") {
        if (agentApiAbort) agentApiAbort.abort();
        send(200, { ok: true });
        return;
      }
      if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers["content-type"] || ""))) { send(415, { ok: false, error: "application/json required" }); return; }
      if (!cfg.agreed) { send(403, { ok: false, error: "请先同意《使用条款与隐私政策》" }); return; }
      const maxBytes = Math.max(1024, Math.min(1024 * 1024, Number(apiCfg.maxBodyBytes) || 65536));
      const parsed = await readAgentJson(req, maxBytes);
      if (parsed.error) { send(parsed.error, { ok: false, error: parsed.error === 413 ? "payload too large" : "invalid json" }); return; }
      let text = String(parsed.body.text || "").trim();
      if (apiCfg.invokeWord) {
        const w = String(apiCfg.invokeWord).trim();
        if (!text.startsWith(w)) { send(400, { ok: false, error: "消息需以调用词「" + w + "」开头" }); return; }
        text = text.slice(w.length).trim();
      }
      if (!text) { send(400, { ok: false, error: "text 不能为空" }); return; }
      const abort = new AbortController();
      agentApiAbort = abort;
      // 并发锁：队列深度兜底（防并发轰炸拖垮服务/双倍 API 费）
      const enq = agentAskQueue.enqueue(() => chatClient.chat({
        persona: buildChatPersona(),
        history: history.recent("chat", cfg.chat.maxHistoryTurns || 10),
        text,
        state: petStateNote(),
        signal: abort.signal,
        onChunk: () => {},
      }));
      if (enq.busy) {
        if (agentApiAbort === abort) agentApiAbort = null; // 未入队的请求不挂 abort
        send(429, { ok: false, error: "请求繁忙（并发队列已满），请稍后重试" });
        return;
      }
      try {
        // /chat 串行化（v2.6）：并发请求依次处理，历史不乱序、不多花 API 费；失败不断链（src/ask-queue）
        const r = await enq.done;
        history.append({ ts: Date.now(), mode: "chat", role: "user", content: text });
        history.append({ ts: Date.now(), mode: "chat", role: "assistant", content: r.text });
        send(200, { ok: true, reply: r.text, emotion: r.emotion || "" });
        maybeWorkflowComment(); // 观察 AI 工作流：外部 AI/脚本通过 Agent 接口找她时偶尔嘀咕
      } catch (e) {
        send(500, { ok: false, error: String(e.message || e) });
      } finally {
        if (agentApiAbort === abort) agentApiAbort = null;
      }
    } catch (e) {
      send(500, { ok: false, error: String(e.message || e) });
    }
  });
  server.on("error", (e) => console.error("[SuzuranPet] Agent 接口启动失败:", e.message));
  server.listen(port, "127.0.0.1", () => console.log("[SuzuranPet] Agent 接口已启动 http://127.0.0.1:" + port));
  // Slowloris/慢速连接防御：请求头/体超时收紧 + 连接数上限（此前挂起连接可占住资源导致正常请求超时）
  try {
    server.requestTimeout = 10000;   // 完整请求超时 10s
    server.headersTimeout = 10000;   // 请求头超时 10s
    server.keepAliveTimeout = 5000;  // 长连接空闲 5s 回收
    server.maxConnections = 50;      // 并发连接上限
  } catch { /* 旧版 Node 无部分字段则忽略 */ }
}

/* ---------- 音色克隆与训练窗口 ---------- */
function openVoiceStudio() {
  if (voiceWin && !voiceWin.isDestroyed()) { voiceWin.focus(); return; }
  voiceWin = new BrowserWindow({
    width: 640,
    height: 720,
    minWidth: 540,
    minHeight: 560,
    resizable: true,
    title: "苏苏洛 · 音色克隆与训练",
    autoHideMenuBar: true,
    webPreferences: winChild.childWebPrefs(config.APP_DIR)
  });
  voiceWin.setMenuBarVisibility(false);
  voiceWin.loadFile(path.join(config.APP_DIR, "renderer", "voice.html"));
attachCrashDiag(voiceWin, "voice");
    voiceWin.on("closed", () => { voiceWin = null; });
}

/* ---------- 音色克隆 IPC ---------- */
ipcMain.handle("pet:pick-file", async () => {
  const parent = (voiceWin && !voiceWin.isDestroyed()) ? voiceWin : (settingsWin && !settingsWin.isDestroyed()) ? settingsWin : win;
  const r = await dialog.showOpenDialog(parent, {
    properties: ["openFile"],
    title: "选择参考音频（3~10 秒干净人声）",
    filters: [
      { name: "音频文件", extensions: ["wav", "flac", "ogg", "aiff", "aif", "mp3"] },
      { name: "所有文件", extensions: ["*"] }
    ]
  });
  return r.canceled ? "" : r.filePaths[0];
});

ipcMain.handle("pet:voice-status", async () => {
  const cfg = config.getConfig();
  const g = cfg.ttsGenie || {};
  if (!g.python || !g.serverScript) return { deployed: false };
  const base = String(g.server || "http://127.0.0.1:9881").replace(/\/+$/, "");
  try {
    const r = await fetch(base + "/status", { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return { deployed: true, ready: false, fail: "服务器 HTTP " + r.status };
    const j = await r.json();
    return { deployed: true, ready: !!j.ready, character: j.character || "", fail: j.fail || "" };
  } catch (e) {
    return { deployed: true, ready: false, fail: "服务器未响应（未启动？）" };
  }
});

ipcMain.handle("pet:apply-voice", async (_e, { audioPath, text }) => {
  try {
    const cfg = config.getConfig();
    const g = cfg.ttsGenie || {};
    if (!g.python || !g.serverScript) {
      return { ok: false, message: "尚未部署本地 Genie 语音。请先打开「语音部署与训练指南」完成部署。" };
    }
    const cleanText = String(text || "").trim();
    if (!cleanText) return { ok: false, message: "请填写参考音频的原文（逐字对应，越准越像）" };
    const up = await tts.ensureGenieServer(g);
    if (!up) return { ok: false, message: "Genie 服务器不可用，请查看服务器日志" };
    const base = String(g.server || "http://127.0.0.1:9881").replace(/\/+$/, "");
    const resp = await fetch(base + "/set_reference", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref_audio: audioPath, ref_text: cleanText }),
      signal: AbortSignal.timeout(30000)
    });
    if (!resp.ok) {
      const t = (await resp.text()).slice(0, 200);
      return { ok: false, message: "服务器返回 " + resp.status + ": " + t };
    }
    // 同步桌宠配置，让 /tts 请求也带新参考音频
    config.saveConfig({ ttsGenie: { refAudio: audioPath, refText: cleanText } });
    logTts("genie", "音色已应用: " + audioPath);
    return { ok: true, message: "音色已应用 ✅" };
  } catch (e) {
    return { ok: false, message: String(e.message || e) };
  }
});

ipcMain.handle("pet:open-voice-studio", () => { openVoiceStudio(); return true; });

ipcMain.handle("pet:emotion-audition", async (_e, key) => { // v2.6 设置页情绪音色试听（真实 GSV 链路 + 参考音频）
  try { return await tts.emotionAudition(String(key || "")); }
  catch (e) { return { ok: false, message: String(e.message || e) }; }
});

ipcMain.handle("pet:tts-preview", async (_e, { text, refAudio, refText }) => {
  // 用「指定参考音频」合成一段试听（不修改已应用音色）
  try {
    const cfg = config.getConfig();
    const g = cfg.ttsGenie || {};
    if (!g.python || !g.serverScript) return { ok: false, message: "未部署 Genie 语音" };
    const up = await tts.ensureGenieServer(g);
    if (!up) return { ok: false, message: "Genie 服务器不可用" };
    const base = String(g.server || "http://127.0.0.1:9881").replace(/\/+$/, "");
    const clean = String(text || "").trim().slice(0, 120);
    if (!clean) return { ok: false, message: "试听内容为空" };
    const resp = await fetch(base + "/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: clean, ref_audio: refAudio || "", ref_text: refText || "" }),
      signal: AbortSignal.timeout(120000)
    });
    if (!resp.ok) {
      const t = (await resp.text()).slice(0, 200);
      return { ok: false, message: "HTTP " + resp.status + ": " + t };
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length < 100) return { ok: false, message: "合成结果为空" };
    return { ok: true, b64: buf.toString("base64") };
  } catch (e) {
    return { ok: false, message: String(e.message || e) };
  }
});

/* ---------- 语音部署与训练指南 ---------- */
function ttsGuideDir() {
  const candidates = [
    path.join(app.getAppPath(), "..", "..", "语音部署与训练指南"), // 打包后：包根目录
    path.join(config.APP_DIR, "语音部署与训练指南")                 // 开发模式：项目根目录
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* 忽略 */ }
  }
  return "";
}

function openTtsGuide(fileName) {
  const dir = ttsGuideDir();
  if (!dir) {
    sendToRenderer("pet:toast", "未找到「语音部署与训练指南」文件夹");
    return;
  }
  if (fileName) {
    const f = path.join(dir, fileName);
    if (fs.existsSync(f)) { shell.openPath(f); return; }
  }
  shell.openPath(dir);
}

function setMode(m) {
  if (m === "zcode" && !config.getConfig().zcodeEnabled) {
    sendToRenderer("pet:toast", "任务模式未启用（可在 config.json 开启 zcodeEnabled）");
    return;
  }
  forcedMode = m;
  refreshTrayMenu();
  sendToRenderer("pet:mode-changed", forcedMode);
}

function sendToRenderer(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/** 主动类消息网关：桌宠隐藏到托盘时保持静默待命（不说话不出声）；
 *  提醒/番茄钟等用户明确设置的任务用 force=true 照常送达 */
function sendProactive(text, emotion, { force = false } = {}) {
  if (!force && !isWindowVisible()) return;
  sendToRenderer("pet:proactive", { text, emotion });
}

function sendScheduleDue(item) {
  const text = "⏰ 日程提醒：" + item.title + (item.notes ? "\n" + item.notes : "");
  sendProactive(text, item.emotion || "happy", { force: true });
  sendToRenderer("pet:schedule-due", item);
  if (!isWindowVisible() && Notification.isSupported()) {
    new Notification({ title: "苏苏洛桌宠日程提醒", body: item.title + (item.notes ? "\n" + item.notes : "") }).show();
  }
  logTts("schedule", "触发: " + item.id + " " + item.title);
}

function savePosSafe() {
  if (win && !win.isDestroyed()) {
    const [x, y] = win.getPosition();
    config.saveConfig({ window: { x, y } });
  }
}

/** 聊天人设：人设 + 长期记忆注入（v2.5，受 features.longTermMemory 开关控制） */
let lastReplyEmotion = ""; // 上一条回复的情绪（情绪衔接/浓度用）
let moodDayCache = { d: "", m: "" };
function todayMood() {
  const ds = new Date().toISOString().slice(0, 10);
  if (moodDayCache.d !== ds) {
    moodDayCache = { d: ds, m: require("./src/mood-day").moodOfTheDay(ds, bond.getDays()) };
  }
  return moodDayCache.m;
}
function chatVars() {
  const cfg = config.getConfig();
  return { name: (cfg.pet && cfg.pet.name) || "苏苏洛", user: (cfg.chat && cfg.chat.userName) || "主人" };
}
function buildChatPersona() {
  const base = personaCache || config.getPersonaText();
  const cfg = config.getConfig();
  if (!(cfg.features && cfg.features.longTermMemory)) return base;
  const parts = [];
  const mem = memory.getText();
  if (mem) parts.push(mem);
  // 2026-08-27 修复：return 原本在今日心情/情绪衔接之前（不可达代码），情绪衔接从未生效
  parts.push(bond.getText()); // v2.5.13 羁绊：相处越久越亲密
  parts.push("她今天的心情基调：" + todayMood());
  if (lastReplyEmotion && lastReplyEmotion !== "idle") {
    parts.push("（上一条回复的情绪是「" + lastReplyEmotion + "」，请自然地延续这种氛围，不要生硬转折）");
  }
  return base + "\n\n" + parts.join("\n");
}

/** 此刻状态注（v2.3）：每轮聊天注入时段+位置，让回复的情绪与桌宠当下处境一致 */
function petStateNote() {
  const h = new Date().getHours();
  const period = h < 5 ? "深夜" : h < 8 ? "清晨" : h < 11 ? "上午" : h < 14 ? "中午" : h < 18 ? "下午" : h < 23 ? "晚上" : "深夜";
  let loc = "静静待在你身边";
  if (walk.active) {
    if (walk.perched) loc = "坐在窗口顶上";
    else if (walk.sleeping) loc = "正在睡觉";
    else if (!walk.resting) loc = "在桌面上散步";
    else if (walk.seated) loc = "坐在任务栏上";
  }
  return `${period}，${loc}`;
}
/** 人格化事件台词（v2.3，设置页 personify 单独开关） ---------- */
const personifyCooldowns = {}; // event → 上次发言时间
const appBootTs = Date.now(); // 启动 15s 内不触发「睡醒」等开场台词（避免与开场白重复）
function maybePersonify(event, { chance = 0.3, cooldownMs = 60000 } = {}) {
  if (config.getConfig().personify === false) return; // 设置页开关
  if (activeReq) return; // 对话中不插话
  if (Date.now() - appBootTs < 15000 && event === "wake") return; // 启动开场白窗口
  if (Math.random() > chance) return;
  const last = personifyCooldowns[event] || 0;
  if (Date.now() - last < cooldownMs) return;
  const pool = lines.PERSONIFY_LINES[event];
  if (!pool || !pool.length) return;
  personifyCooldowns[event] = Date.now();
  sendProactive(lines.pickTpl(pool, chatVars()), "happy");
}
/** 观察 AI 工作流（v2.3）：Agent 接口被外部 AI/脚本调用时，偶尔小声嘀咕 */
const workflowCalls = [];
const workflowCommentThrottle = lines.throttled(8 * 60 * 1000); // 8 分钟只嘀咕一次
function maybeWorkflowComment() {
  const now = Date.now();
  while (workflowCalls.length && now - workflowCalls[0] > 10 * 60 * 1000) workflowCalls.shift();
  workflowCalls.push(now);
  if (!workflowCommentThrottle()) return;
  if (Math.random() > 0.25) return;
  sendProactive(lines.pickTpl(lines.WORKFLOW_LINES, chatVars()), "idle");
}

/* ---------- 对话核心 ---------- */
/** 对话期间暂停散步（busy 时渲染层不切 Move 动画，若窗口仍移动会出现“坐着滑行”）：
 *  进入对话暂停、结束（done/error/中止/快捷回复）统一在 finally 恢复。 */
function chatPauseWalk(p) {
  if (!walk.active) return;
  walk.chatPaused = !!p;
  if (p) { cancelFlight(); cancelWalkJump(); walk.taskbarHang = false; }
  walk.paused = walk.dragPaused || walk.chatPaused || walk.zoomPaused;
  walk.pausedAt = 0; // 对话暂停不参与拖拽 60s 自愈
  walkBroadcast();
  logTts("walk", p ? "对话暂停散步" : "对话结束恢复散步");
}
async function handleAsk(sender, payload) {
  chatPauseWalk(true);
  try {
    await handleAskInner(sender, payload);
  } finally {
    chatPauseWalk(false);
  }
}
async function handleAskInner(sender, { id, text }) {
  if (!config.getConfig().agreed) {
    sender.send("pet:error", { id, message: "请先阅读并同意《使用条款与隐私政策》后使用" });
    return;
  }
  if (activeReq) {
    // v2.6 消息生成防抖：上一句还在生成/合成时再来消息，不再直接报错——
    // 只缓冲最新一条（连续快速发送只留最后一条），当前回合结束后自动补发（src/message-buffer）
    askBuffer.push({ sender, payload });
    if (pendingAskTimer) clearTimeout(pendingAskTimer);
    pendingAskTimer = setTimeout(() => {
      pendingAskTimer = null;
      const p = askBuffer.take();
      if (p) handleAsk(p.sender, p.payload);
    }, ASK_COALESCE_MS);
    logTts("chat", "生成防抖: 缓冲新消息，当前回合结束后补发");
    return;
  }
  const clean = (text || "").trim();
  if (!clean) return;

  // 标记用户活跃（重置主动搭话计时）
  features.touchChat();

  // === 快捷命令：提醒 / 番茄钟 / 系统状态（v2.6 拆出 src/quick-commands.js，可单测） ===
  const qc = require("./src/quick-commands").tryQuickCommand(clean, {
    features,
    notify: (msg) => sendProactive(msg, "happy", { force: true }),
  });
  const qr = await Promise.resolve(qc);
  if (qr) {
    sender.send("pet:done", { id, mode: "chat", full: qr.reply, emotion: qr.emotion });
    return;
  }

  // === 番茄钟控制 ===
  if (/番茄钟|pomodoro/i.test(clean)) {
    if (/开始|启动|start/i.test(clean)) {
      features.startPomodoro((msg) => sendProactive(msg, "happy", { force: true }));
      sender.send("pet:done", { id, mode: "chat", full: "好的博士！🍅 番茄钟已启动（25分钟工作 + 5分钟休息），到时间我会提醒你的～", emotion: "happy" });
      return;
    }
    if (/停止|取消|stop/i.test(clean)) {
      features.stopPomodoro();
      sender.send("pet:done", { id, mode: "chat", full: "番茄钟已停止。博士辛苦了～", emotion: "happy" });
      return;
    }
    const st = features.getPomodoroStatus();
    if (st) {
      sender.send("pet:done", { id, mode: "chat", full: `当前番茄钟：${st.phase}，剩余 ${st.remaining}，已完成 ${st.count} 个 ⏱`, emotion: "think" });
      return;
    }
  }

  // === 系统状态查询（精确匹配，避免拦截普通聊天中的 CPU/内存话题） ===
  if (/^(电脑|系统|CPU|内存)状态$|^(查看|看看|检查).*(电脑|系统)状态|^CPU$|^内存$|^cpu使用率$|^内存使用率$/i.test(clean)) {
    const stats = await features.getSystemStats();
    if (stats) {
      const comment = features.systemStatsToSpeech(stats) || "";
      sender.send("pet:done", { id, mode: "chat", full: `📊 CPU: ${stats.cpu}% | 内存: ${stats.ramUsed}% (${stats.ramFree}/${stats.ramTotal}GB)\n${comment}`, emotion: "think" });
      return;
    }
  }

  let mode = forcedMode !== "auto" ? forcedMode : router.route(clean).mode;
  if (mode === "zcode" && !config.getConfig().zcodeEnabled) mode = "chat"; // 任务模式未启用 → 走聊天
  const taskText = mode === "zcode" ? router.route(clean).task : clean;

  const abort = new AbortController();
  activeReq = { id, sender, abort, cancelled: false };
  const isCurrent = () => activeReq && activeReq.id === id && !activeReq.cancelled;
  history.append({ ts: Date.now(), mode, role: "user", content: clean });
  // 长期记忆（v2.5）：规则式提取事实（称谓/喜好/生日/健康/近期安排），仅本机存储
  if (config.getConfig().features && config.getConfig().features.longTermMemory) {
    try { memory.addFacts(memory.extractFacts(clean)); } catch { /* 记忆失败不影响对话 */ }
  }
  // 羁绊（v2.5.13）：聊天 +1 经验；升级时 toast + 跨关系阶段解锁专属台词（B-1）
  try {
    const stageBefore = bond.getStage().key;
    const b = bond.addExp(1);
    if (b.leveledUp) {
      sendToRenderer("pet:toast", "🥰 羁绊升级 Lv." + b.level);
      const st = bond.getStage();
      if (st.key !== stageBefore && lines.STAGE_LINES[st.key] && lines.STAGE_LINES[st.key].length) {
        sendProactive(lines.pickTpl(lines.STAGE_LINES[st.key], chatVars()), "love");
      }
    }
  } catch { /* 羁绊失败不影响对话 */ }

  if (isCurrent()) sender.send("pet:thinking", { id, mode });
  let emotion = "";
  try {
    let full = "";
    if (mode === "zcode") {
      full = await zcodeClient.runZcodeTask({
        prompt: taskText,
        persona: personaCache,
        signal: abort.signal,
        onChunk: (d) => { if (isCurrent()) sender.send("pet:chunk", { id, mode, text: d }); }
      });
    } else {
      const persona = buildChatPersona();
      const r = await chatClient.chat({
        persona,
        history: history.recent("chat", config.getConfig().chat.maxHistoryTurns || 20),
        text: clean,
        state: petStateNote(), // v2.3 此刻状态注：时段/位置，驱动情绪与台词一致
        signal: abort.signal,
        onChunk: (d) => { if (isCurrent()) sender.send("pet:chunk", { id, mode, text: d }); }
      });
      full = r.text;
      emotion = r.emotion || ""; // 模型选的情绪词（≤5字，已在 chat-client 里校验过词表）
      if (emotion) lastReplyEmotion = emotion; // 情绪衔接（B2）
    }
    history.append({ ts: Date.now(), mode, role: "assistant", content: full });
    if (isCurrent()) sender.send("pet:done", { id, mode, full, emotion });

    // 长期记忆摘要：每 20 轮对话自动生成一次
    const _fc = config.getConfig();
    if (_fc.features && _fc.features.longTermMemory) {
      const turns = history.recent("chat", 999).length;
      if (turns > 0 && turns % 20 === 0) {
        const recent = history.recent("chat", 20);
        features.generateMemorySummary(chatClient, recent).then((summary) => {
          if (summary) {
            memory.updateSummary(summary); // v2.5：摘要真正入库，后续轮次注入人设
            logTts("memory", "记忆摘要: " + summary.slice(0, 80));
            sendToRenderer("pet:toast", "🧠 记忆已更新");
          }
        }).catch(() => {});
      }
    }
  } catch (err) {
    if (err.name !== "AbortError" && isCurrent()) {
      sender.send("pet:error", { id, message: String(err.message || err) });
    }
  } finally {
    if (activeReq && activeReq.id === id) activeReq = null;
  }
}

/* ---------- IPC ---------- */
ipcMain.handle("pet:ask", (e, payload) => { handleAsk(e.sender, payload); return true; });
ipcMain.on("pet:stop", () => {
  // 主动停止：同时丢弃生成防抖缓冲（用户要的是静默，不是补发）
  if (pendingAskTimer) { clearTimeout(pendingAskTimer); pendingAskTimer = null; }
  askBuffer.clear();
  if (activeReq) {
    activeReq.cancelled = true;
    const s = activeReq.sender;
    activeReq.abort.abort();
    // 通知渲染层复位 busy（中止路径不再发 done/error，仅靠主进程兜底会卡住输入/停止按钮）
    try { if (s && !s.isDestroyed()) s.send("pet:stopped", { id: activeReq.id }); } catch { /* 窗口已销毁忽略 */ }
  }
});
ipcMain.handle("pet:get-state", () => {
  const cfg = config.getConfig();
  return {
    personaOpening: openingLine(personaCache),
    greetingOnStart: cfg.greetingOnStart !== false,
    forcedMode,
    keyReady: !!cfg.chat.apiKey,
    keySource: cfg._keySource,
    zcodeCli: cfg.zcodeCli,
    zcodeEnabled: !!cfg.zcodeEnabled,
    petName: (cfg.pet && cfg.pet.name) || "苏苏洛",
    userName: (cfg.chat && cfg.chat.userName) || "主人",
    moods: getMoodList(),
    agreed: !!cfg.agreed,
    scale: cfg.window.scale || 1.0,
    agentApi: { ...cfg.agentApi, bearerToken: undefined }, // token 原值不回传 renderer
    firstRun: !!cfg.firstRun,
    workspace: cfg.workspace,
    tts: cfg.tts || { enabled: false, voice: "", rate: 0.95, pitch: 1.1 },
    emotionalVoice: !!(cfg.features && cfg.features.emotionalVoice !== false), // 情绪语音开关（语速/音调/语气词）
    emotionVoice: cfg.emotionVoice || {}, // 情绪音色分档开关（v2.6）：{撒娇:true,…}，缺省=启用
    firstRunAt: cfg.firstRunAt || 0, // 首次启动时间戳（陪伴时间）
    ttsCloud: { enabled: !!(cfg.ttsCloud?.enabled || cfg.ttsCosy?.enabled || cfg.ttsGenie?.enabled) },
    winSize: { width: cfg.window.width || 260, height: cfg.window.height || 200 },
    hasUserSprite: fs.existsSync(path.join(config.STORAGE.spritesUser, "sprite.png")),
    renderMode: renderModeMod.renderModeOf(cfg.renderMode),
    live2dSkinId: cfg.live2dSkinId || "",
    rigSkinId: cfg.rigSkinId || "", // PSD 2.5D 皮肤
    rigScale: Number(cfg.rigScale) > 0 ? Number(cfg.rigScale) : 1.0,
    rigMouseFollow: cfg.rigMouseFollow !== false, // 2.5D 头部/眼睛跟随鼠标
    mouseTrackGlobal: !!cfg.mouseTrackGlobal, // 全局鼠标跟踪（需许可，默认关）
    catToy: !!cfg.catToy, // 逗猫棒（需许可，默认关）
    walkGlobal: !!cfg.walkGlobal, // 桌面全域行走（实验，默认关）
    softRender: !!cfg.softRender, // 软件渲染（重启生效）
    fileGuard: !!cfg.fileGuard, // 蜜标监控（默认关）
    walking: !!cfg.walking,
    walkState: { active: walk.active, resting: walk.resting, perched: walk.perched, seated: walk.seated, face: walk.face, paused: walk.paused },
    dimMode: !!cfg.dimMode,
    hiddenAtStart: !isWindowVisible()
  };
});
ipcMain.handle("pet:set-tts", (e, enabled) => { setTts(!!enabled); return true; });
ipcMain.handle("pet:set-mode", (e, m) => { setMode(m === "zcode" ? "zcode" : m === "chat" ? "chat" : "auto"); });
ipcMain.handle("pet:reload-persona", () => {
  personaCache = config.getPersonaText();
  return personaCache.length > 0;
});
ipcMain.handle("pet:open-config", () => shell.openPath(config.CONFIG_PATH));

function refreshPetName() {
  const name = config.fillTokens("{{petName}}");
  if (win && !win.isDestroyed()) win.setTitle(name + "桌宠");
  if (tray) tray.setToolTip(name + "桌宠（点击隐藏/显示）");
  sendToAllWindows("pet:name-changed", name);
}

/* ---------- 设置窗口 IPC ---------- */
ipcMain.handle("pet:generate-agent-token", () => crypto.randomBytes(32).toString("base64url"));
ipcMain.handle("pet:get-settings", () => {
  const view = config.buildSettingsView();
  try { view.autoLaunch = app.getLoginItemSettings().openAtLogin; } catch { view.autoLaunch = false; }
  return view;
});
ipcMain.handle("pet:save-settings", (_e, patch) => {
  if (!patch || typeof patch !== "object") return false;
  try {
    if (Object.prototype.hasOwnProperty.call(patch, "autoLaunch")) { // 开机自启（系统级，不入 config）
      const al = !!patch.autoLaunch;
      delete patch.autoLaunch;
      try {
        app.setLoginItemSettings({ openAtLogin: al, openAsHidden: !!config.getConfig().startHidden });
        logTts("settings", "开机自启: " + (al ? "开" : "关"));
      } catch (e) { logTts("settings", "设置开机自启失败: " + (e && e.message || e)); }
    }
    const secretPatch = patch.secrets || {};
    delete patch.secrets;
    if (patch.chat && Object.prototype.hasOwnProperty.call(patch.chat, "apiKey")) {
      secretPatch.chatApiKey = { action: "replace", value: patch.chat.apiKey };
      delete patch.chat.apiKey;
    }
    if (patch.ttsCosy && Object.prototype.hasOwnProperty.call(patch.ttsCosy, "apiKey")) {
      secretPatch.ttsCosyApiKey = { action: "replace", value: patch.ttsCosy.apiKey };
      delete patch.ttsCosy.apiKey;
    }
    if (patch.agentApi && String(patch.agentApi.bearerToken || "").trim()) {
      secretPatch.agentBearerToken = { action: "replace", value: patch.agentApi.bearerToken };
      delete patch.agentApi.bearerToken;
    }
    const secretValues = {};
    if (secretPatch.chatApiKey && secretPatch.chatApiKey.action === "replace") secretValues.chatApiKey = String(secretPatch.chatApiKey.value || "");
    if (secretPatch.ttsCosyApiKey && secretPatch.ttsCosyApiKey.action === "replace") secretValues.ttsCosyApiKey = String(secretPatch.ttsCosyApiKey.value || "");
    if (secretPatch.agentBearerToken && secretPatch.agentBearerToken.action === "replace") secretValues.agentBearerToken = String(secretPatch.agentBearerToken.value || "");
    if (Object.keys(secretValues).length) config.replaceSecrets(secretValues);
    const before = config.getConfig();
    config.saveConfig(patch);
    refreshTrayMenu();
    const after = config.getConfig();
    if ((after.pet && after.pet.name) !== (before.pet && before.pet.name)) refreshPetName();
    if (after.renderMode !== before.renderMode) {
      sendToRenderer("pet:render-mode-changed", after.renderMode);
      syncWalkingEngine(); // 切回 GIF 时自动停走；切回 Spine 且开关开着则恢复
      // v2.5.13 模式切换后把窗口底边对齐任务栏上沿：三种模式窗口高度不同（rig 300×138 等），
      // 不做对齐会出现切模式后角色悬空/陷地的跳变
      try {
        if (win && !win.isDestroyed()) {
          // 强制对齐主屏任务栏上沿 + 钳回主屏水平范围：
          // getDisplayMatching 在窗口漂到显示边界/副屏时会取错 workArea，导致贴地失败、窗口悬空或跨屏
          const eb = win.getBounds();
          const wa = screen.getPrimaryDisplay().workArea;
          const al = renderModeMod.groundAlign(eb, wa, walk.groundGap);
          win.setPosition(al.x, al.y);
          logTts("walk", "模式切换贴地: " + after.renderMode + " → (" + al.x + "," + al.y + ") " + eb.width + "x" + eb.height);
          // 延迟二次贴地：渲染层模式初始化（setSize/几何上报）会异步挪动窗口，2.5s 后按实际尺寸再贴一次主屏任务栏
          setTimeout(() => {
            try {
              if (!win || win.isDestroyed()) return;
              const eb2 = win.getBounds();
              const wa2 = screen.getPrimaryDisplay().workArea;
              const al2 = renderModeMod.groundAlign(eb2, wa2, walk.groundGap);
              win.setPosition(al2.x, al2.y);
            } catch { /* 忽略 */ }
          }, 2500);
        }
      } catch (e) { logTts("walk", "贴地异常: " + (e && e.message || e)); }
    } else if (!!after.walking !== !!before.walking) {
      syncWalkingEngine();
    }
    return true;
  } catch (e) {
    return { ok: false, message: String(e.message || e) };
  }
});
ipcMain.handle("pet:save-persona", (_e, text) => {
  config.savePersonaText(String(text || ""));
  personaCache = config.getPersonaText();
  return personaCache.length > 0;
});
ipcMain.handle("pet:reset-persona", () => {
  try {
    const def = config.resetPersona();
    personaCache = config.getPersonaText();
    return { ok: true, persona: def };
  } catch (e) {
    return { ok: false, message: String(e.message || e) };
  }
});
ipcMain.handle("pet:test-chat", (_e, overrides) => chatClient.testConnection(overrides || {}));

/* ---------- 显式凭据导入与密钥清除（renderer 永远接触不到明文） ---------- */
const credentialImport = require("./src/credential-import");
ipcMain.handle("pet:scan-importable-credentials", () => credentialImport.scan());
ipcMain.handle("pet:import-credential", (_e, req) => credentialImport.importCredential(req || {}));
ipcMain.handle("pet:clear-secret", (_e, slot) => {
  const map = { chat: "chatApiKey", ttsCosy: "ttsCosyApiKey", agent: "agentBearerToken" };
  const key = map[slot];
  if (!key) return { ok: false, message: "未知的密钥槽位" };
  try {
    return { ok: true, status: config.replaceSecrets({ [key]: "" }), message: "已清除" };
  } catch (e) {
    return { ok: false, message: String(e.message || e), status: config.secretStatus() };
  }
});

ipcMain.handle("pet:list-models", async (_e, o = {}) => {
  // 读取 API 端口的可用模型列表（OpenAI 兼容 GET /v1/models；Anthropic GET /v1/models）
  try {
    const cfg = config.getConfig();
    const apiType = o.apiType || cfg.chat.apiType;
    const baseUrl = o.baseUrl || cfg.chat.baseUrl;
    const apiKey = o.apiKey || cfg.chat.apiKey;
    let b = String(baseUrl || "").replace(/\/+$/, "");
    if (!/\/v\d+$/.test(b)) b += "/v1";
    const headers = { "Content-Type": "application/json" };
    if (apiType === "anthropic") {
      if (!apiKey) return { ok: false, message: "请先填写 API Key" };
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else if (apiKey) {
      headers["Authorization"] = "Bearer " + apiKey;
    }
    const resp = await fetch(b + "/models", { headers, signal: AbortSignal.timeout(20000) });
    if (!resp.ok) {
      const t = (await resp.text()).slice(0, 200);
      return { ok: false, message: "HTTP " + resp.status + ": " + t };
    }
    const j = await resp.json();
    const raw = Array.isArray(j.data) ? j.data : Array.isArray(j.models) ? j.models : [];
    const ids = raw.map((m) => m.id || m.name || m.model).filter(Boolean);
    const uniq = [...new Set(ids)].sort((a, b) => a.localeCompare(b, "zh"));
    if (!uniq.length) return { ok: false, message: "端口返回了空模型列表（可能不支持该接口）" };
    return { ok: true, models: uniq, count: uniq.length };
  } catch (e) {
    return { ok: false, message: String(e.message || e) };
  }
});
ipcMain.handle("pet:open-tts-guide", (_e, fileName) => { openTtsGuide(fileName); return true; });
ipcMain.handle("pet:clear-history", () => {
  try {
    fs.mkdirSync(path.dirname(config.STORAGE.history), { recursive: true });
    fs.writeFileSync(config.STORAGE.history, "", "utf8");
    return true;
  } catch { return false; }
});

/* ---------- 新功能 IPC ---------- */

// 语音输入：接收音频文件路径 → whisper 转写 → 返回文字
ipcMain.handle("pet:voice-stt", async (_e, { audioPath, lang }) => {
  return features.speechToText(audioPath, lang || "ja");
});

// 语音输入：接收 base64 音频 → 保存临时文件 → whisper 转写
ipcMain.handle("pet:voice-stt-b64", async (_e, { audioB64, lang }) => {
  const tmpPath = path.join(require("os").tmpdir(), `pet_voice_${Date.now()}.webm`);
  try {
    if (!audioB64 || audioB64.length < 100) return { ok: false, text: "", error: "音频过短" };
    fs.writeFileSync(tmpPath, Buffer.from(audioB64, "base64"));
    return await features.speechToText(tmpPath, lang || "ja");
  } catch (e) {
    return { ok: false, text: "", error: String(e.message || e) };
  } finally {
    try { fs.unlinkSync(tmpPath); } catch { /* 忽略 */ } // 异常路径也清理临时文件
  }
});

// 日程提醒（持久化 schedule 引擎）
ipcMain.handle("pet:get-schedules", () => schedules.list());
ipcMain.handle("pet:get-info", () => { // 信息面板：陪伴时间 + 今日日程
  const cfg = config.getConfig();
  const all = schedules.list();
  const now = new Date();
  const todayStr = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-" + String(now.getDate()).padStart(2, "0");
  const today = all.filter((s) => {
    const d = s.display ? String(s.display.date || "") : "";
    return d === todayStr || (s.nextAt && new Date(s.nextAt).toDateString() === now.toDateString());
  }).slice(0, 8);
  return { firstRunAt: cfg.firstRunAt || 0, today };
});

/* ---------- PSD 2.5D 角色皮肤管理（v2.2） ---------- */
function rigSkinList() {
  try {
    const dir = config.STORAGE.rigUser;
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => /\.psd$/i.test(f)).map((f) => ({ id: f, file: path.join(dir, f) })).sort((a, b) => a.id.localeCompare(b.id));
  } catch { return []; }
}
function setRigSkin(id) {
  try {
    const list = rigSkinList();
    const hit = list.find((s) => s.id === String(id || ""));
    if (id && !hit) return false;
    config.saveConfig({ rigSkinId: id ? hit.id : "" });
    sendToRenderer("pet:rig-skin-changed", id ? hit.id : "");
    logTts("rig", id ? "切换 2.5D 皮肤: " + id : "关闭 2.5D 模式");
    return true;
  } catch { return false; }
}
ipcMain.handle("pet:rig-skins", () => rigSkinList());
ipcMain.handle("pet:rig-apply", (_e, srcPath) => { // 从 PSD 工具导入：复制到 rigUser 并设为当前
  try {
    const src = String(srcPath || "");
    if (!/\.psd$/i.test(src) || !fs.existsSync(src)) return { ok: false, message: "PSD 文件不存在" };
    fs.mkdirSync(config.STORAGE.rigUser, { recursive: true });
    const id = path.basename(src);
    const dest = path.join(config.STORAGE.rigUser, id);
    if (path.resolve(src) !== path.resolve(dest)) fs.copyFileSync(src, dest);
    config.saveConfig({ rigSkinId: id });
    sendToRenderer("pet:rig-skin-changed", id);
    logTts("rig", "应用 2.5D 皮肤: " + id);
    return { ok: true, id };
  } catch (e) { return { ok: false, message: String(e.message || e) }; }
});
ipcMain.handle("pet:rig-apply-buffer", (_e, name, b64) => { // PSD 工具图层编辑后：内存重序列化 → 落盘 rigUser 并设为当前
  try {
    const nm = String(name || "").replace(/[^\w\u4e00-\u9fa5.-]+/g, "_").slice(0, 60);
    if (!/\.psd$/i.test(nm)) return { ok: false, message: "文件名需以 .psd 结尾" };
    const raw = String(b64 || "");
    const m = raw.match(/^data:application\/octet-stream;base64,(.+)$/) || (raw && !raw.includes(",") ? { 1: raw } : null);
    if (!m || !m[1] || m[1].length < 16) return { ok: false, message: "PSD 数据为空" };
    const buf = Buffer.from(m[1], "base64");
    if (buf.length < 32) return { ok: false, message: "PSD 数据无效" };
    fs.mkdirSync(config.STORAGE.rigUser, { recursive: true });
    const dest = path.join(config.STORAGE.rigUser, nm);
    fs.writeFileSync(dest, buf);
    config.saveConfig({ rigSkinId: nm });
    sendToRenderer("pet:rig-skin-changed", nm);
    logTts("rig", "应用编辑后 2.5D 皮肤: " + nm + " (" + buf.length + "B)");
    return { ok: true, id: nm };
  } catch (e) { return { ok: false, message: String(e.message || e) }; }
});
ipcMain.handle("pet:rig-set", (_e, id) => { // 切换已导入皮肤（""=关闭 2.5D）
  const ok = setRigSkin(id);
  return ok ? { ok: true } : { ok: false, message: "皮肤不存在" };
});
ipcMain.handle("pet:rig-delete", (_e, id) => { // 删除已导入 2.5D 皮肤（rigUser/*.psd，§14 追加 96）
  try {
    const plan = planRigDelete(rigSkinList(), id, config.getConfig().rigSkinId);
    if (plan.error) return { ok: false, message: plan.error };
    fs.unlinkSync(plan.file);
    logTts("rig", "删除 2.5D 皮肤: " + id);
    if (plan.clearCurrent) {
      config.saveConfig({ rigSkinId: "" }); // 删的是当前皮肤 → 退出 2.5D 模式并通知渲染层
      sendToRenderer("pet:rig-skin-changed", "");
    }
    return { ok: true, clearedCurrent: plan.clearCurrent };
  } catch (e) { return { ok: false, message: String(e.message || e) }; }
});
ipcMain.on("pet:set-rig-scale", (_e, v) => { // 2.5D 角色大小（实时生效）
  const s = Math.max(0.3, Math.min(1.5, Number(v) || 1));
  config.saveConfig({ rigScale: s });
  sendToRenderer("pet:rig-scale-changed", s);
});
ipcMain.on("pet:set-rig-mouse-follow", (_e, v) => { // 2.5D 头部/眼睛跟随鼠标（实验性，实时生效）
  config.saveConfig({ rigMouseFollow: !!v });
  sendToRenderer("pet:rig-mouse-follow-changed", !!v);
});
// 全局鼠标跟踪（v2.2.1 实验性，需设置页显式许可默认关）：轮询全局鼠标位置广播给渲染层，让角色始终看向鼠标
let mouseTrackTimer = null;
let lastCursor = { x: NaN, y: NaN }; // 最近一次轮询的鼠标屏幕坐标（逗猫棒行走用）
function startMouseTrack() {
  if (mouseTrackTimer) return;
  const push = () => {
    try {
      const b = win.getBounds();
      const c = screen.getCursorScreenPoint();
      lastCursor = { x: c.x, y: c.y };
      sendToRenderer("pet:mouse-pos", { x: c.x, y: c.y, win: { x: b.x, y: b.y, width: b.width, height: b.height } });
    } catch { /* 窗口销毁等瞬时错误忽略 */ }
  };
  push();
  mouseTrackTimer = setInterval(push, 50);
}
function stopMouseTrack() {
  if (mouseTrackTimer) { clearInterval(mouseTrackTimer); mouseTrackTimer = null; }
}
ipcMain.on("pet:set-mouse-track-global", (_e, on) => {
  config.saveConfig({ mouseTrackGlobal: !!on });
  if (on) startMouseTrack(); else stopMouseTrack();
  sendToRenderer("pet:mouse-track-global-changed", !!on);
});
ipcMain.on("pet:set-walk-global", (_e, on) => { // 桌面全域行走（实验）：边界即时生效（walkTick 每帧读配置）
  config.saveConfig({ walkGlobal: !!on });
  logTts("walk", "全域行走实验: " + (on ? "开启（虚拟桌面全范围）" : "关闭"));
});
ipcMain.on("pet:set-soft-render", (_e, on) => { // 软件渲染（重启生效）：无显卡/驱动异常环境兜底
  config.saveConfig({ softRender: !!on });
  sendToRenderer("pet:toast", on ? "软件渲染已开启，重启应用后生效" : "已切换为硬件渲染，重启应用后生效");
  logTts("render", "软件渲染: " + (on ? "开启（重启生效）" : "关闭（重启生效）"));
});
ipcMain.on("pet:set-emotion-voice", (_e, key, on) => { // 情绪音色分档开关：该档停用后用默认音色（参考音频+语气词/语速一起关）
  const ev = Object.assign({}, config.getConfig().emotionVoice || {});
  ev[String(key || "")] = !!on;
  config.saveConfig({ emotionVoice: ev });
  sendToRenderer("pet:emotion-voice-changed", ev);
  logTts("render", "情绪音色分档: " + key + " → " + (on ? "启用" : "停用"));
});
// 逗猫棒（需显式许可默认关）：读取鼠标位置，角色追着鼠标水平走
function setCatToy(on) {
  config.saveConfig({ catToy: !!on });
  refreshTrayMenu();
  walk.catToy = !!on;
  if (on) {
    startMouseTrack(); // 需要鼠标位置（与全局鼠标跟踪共用轮询）
    if (config.getConfig().renderMode === "spine" && !walk.active) startWalkingEngine();
    // 逗猫棒强制起身：清除坐姿/下沉/驻留，否则 walkTick 因 seated 早退永远不追鼠标
    walk.seated = false;
    walk.sunk = false;
    walk.perched = false;
    walk.iconRest = false;
    walk.gotoPerch = false;
    walk.returning = false;
    walk.resting = false;
    walkBroadcast();
  } else {
    // 恢复普通行走节奏（站立/散步由相位机管理）；原本没开行走则停引擎
    walkSchedulePhase(randInt(3000, 6000));
    if (!config.getConfig().walking) stopWalkingEngine();
    // 关闭逗猫棒：若全局鼠标跟踪也关着，停止鼠标轮询（避免空耗 CPU/电量）
    if (!config.getConfig().mouseTrackGlobal) stopMouseTrack();
  }
}
ipcMain.on("pet:set-cat-toy", (_e, on) => { setCatToy(!!on); });
// 摸头互动（v2.3）：渲染层快速连点角色触发；主进程 10s 节流回复台词（避免连点刷屏）
const patThrottle = lines.throttled(10000);
ipcMain.on("pet:pat", () => {
  try {
    const b = bond.addExp(1); // 摸头 +1 经验
    if (b.leveledUp) sendToRenderer("pet:toast", "🥰 羁绊升级 Lv." + b.level);
  } catch { /* 忽略 */ }
  if (!patThrottle()) return;
  sendProactive(lines.pickTpl(lines.PAT_LINES, chatVars()), "happy", { force: true });
});
// 主动搭话 / 人格化开关（v2.3，设置页单独开启）
function proactiveMin() { return (config.getConfig().features && config.getConfig().features.proactiveMin) || 8; }
// 记忆管理（v2.5.2）：设置页查看/删除/清空
ipcMain.handle("pet:get-memory", () => {
  try {
    const facts = memory.getFactsList();
    return { facts, summary: memory.getSummary(), bond: { level: bond.getLevel(), days: bond.getDays() } };
  } catch (e) { logTts("memory", "getMemory 异常: " + (e && e.stack || e)); return { facts: [], summary: "", bond: null }; }
});
ipcMain.handle("pet:delete-memory-fact", (_e, id) => {
  try { memory.deleteFact(String(id || "")); return true; } catch { return false; }
});
ipcMain.handle("pet:update-memory-fact", (_e, id, text) => { // 编辑单条记忆（§14 追加 103）
  try {
    const ok = memory.updateFact(String(id || ""), String(text || ""));
    return { ok, message: ok ? "" : "记忆不存在或内容无效（需 2-120 字）" };
  } catch (e) { return { ok: false, message: String(e.message || e) }; }
});
ipcMain.handle("pet:clear-memory", () => {
  try { memory.clear(); return true; } catch { return false; }
});
ipcMain.on("pet:set-proactive-chat", (_e, on) => {
  config.saveConfig({ proactiveChat: !!on });
  features.setProactiveEnabled(!!on);
  if (on) features.startProactive((msg) => sendProactive(msg, "idle"), proactiveMin());
});
ipcMain.on("pet:set-personify", (_e, on) => {
  config.saveConfig({ personify: !!on });
});
// 蜜标监控（honeytoken）：检测其他程序访问桌宠敏感配置区域（默认关；进程名需管理员 ETW，普通权限仅能检测"被访问"）
function setFileGuard(on) {
  config.saveConfig({ fileGuard: !!on });
  refreshTrayMenu();
  if (on) {
    fileGuard.start((type, fileName, detail) => {
      const msgs = {
        honey: "检测到有程序访问了我的敏感配置区域（" + (detail || fileName) + "）。请确认是否是您自己操作的。",
        tamper: "⚠ 我的配置文件被外部程序修改（" + (detail || fileName) + "）！请检查是否有恶意软件在篡改设置。",
        worm: "⚠ 用户数据目录出现可疑新文件（" + (detail || fileName) + "），可能是恶意程序复制自身。",
        ransom: "⚠ 检测到异常批量文件操作（疑似勒索加密特征），请注意备份重要数据！"
      };
      logTts("guard", "⚠ 防御触发[" + type + "]: " + (detail || fileName));
      sendProactive(msgs[type] || msgs.honey, "surprised", { force: true });
    });
  } else {
    fileGuard.stop();
  }
}
ipcMain.on("pet:set-file-guard", (_e, on) => { setFileGuard(!!on); });
/** §14 追加 98：DLL 侧载自检——exe 目录 dll 清单与基线对比，发现新增/被替换 dll 即告警；
 *  变化量大（升级/重装）自动重建基线。基线存 userData/security-dll-baseline.json。 */
function runDllGuard() {
  try {
    const dir = path.dirname(process.execPath);
    const basePath = path.join(config.STORAGE.userDir, "security-dll-baseline.json");
    const cur = dllGuard.snapshotDlls(dir);
    let base = null;
    try { base = JSON.parse(fs.readFileSync(basePath, "utf8")); } catch { /* 无基线 */ }
    if (!base || typeof base !== "object" || !base.dlls) {
      fs.writeFileSync(basePath, JSON.stringify({ at: new Date().toISOString(), dlls: cur }, null, 2), "utf8");
      logTts("security", "DLL 基线已建立（" + Object.keys(cur).length + " 个）");
      return;
    }
    const d = dllGuard.decide(base.dlls || {}, cur);
    if (!d.ok) {
      const names = d.suspicious.added.concat(d.suspicious.replaced);
      // §14 追加 101：对新增/替换 dll 做 Authenticode 签名校验——无签名的变化 = 高强度侧载嫌疑
      let unsignedNote = "";
      try {
        const sig = dllGuard.signerOf(names.map((n) => path.join(dir, n)));
        const noSig = sig.filter((s) => !s.hasSigner).map((s) => path.basename(s.file || ""));
        if (noSig.length) unsignedNote = "（其中未签名文件: " + noSig.join(", ") + "——高强度侧载嫌疑）";
      } catch { /* 签名校验失败不阻断告警 */ }
      logTts("security", "⚠ 检测到新增/被替换的 DLL（疑似 DLL 侧载）: " + names.join(", ") + unsignedNote);
      try {
        if (win && !win.isDestroyed()) sendProactive("（表情认真）博士，我的程序目录里出现了不认识的 DLL 文件（" + names.slice(0, 3).join(", ") + "），可能是恶意程序放进来的，麻烦检查一下。", "surprised", { force: true });
      } catch { /* 提示失败不影响 */ }
    } else if (d.note === "upgrade") {
      fs.writeFileSync(basePath, JSON.stringify({ at: new Date().toISOString(), dlls: cur }, null, 2), "utf8");
      logTts("security", "DLL 变化量较大（" + (d.changes.added.length + d.changes.replaced.length) + " 个），判定为应用升级，已更新基线");
    }
  } catch (e) { logTts("security", "DLL 自检异常: " + (e && e.message || e)); }
}
ipcMain.handle("pet:add-schedule", (_e, item) => { try { return { ok: true, item: schedules.add(item) }; } catch (err) { return { ok: false, error: String(err.message || err) }; } });
ipcMain.handle("pet:cancel-schedule", (_e, id) => schedules.cancel(String(id || "")));
ipcMain.handle("pet:complete-schedule", (_e, id) => schedules.complete(String(id || "")));
ipcMain.handle("pet:snooze-schedule", (_e, { id, minutes }) => schedules.snooze(String(id || ""), minutes));
ipcMain.handle("pet:open-schedule", () => { openSchedule(); return true; });
ipcMain.handle("pet:set-reminder", (_e, { text, at }) => {
  const date = new Date(Number(at));
  if (!Number.isFinite(date.getTime())) return { ok: false, message: "提醒时间无效" };
  try {
    const item = schedules.add({ title: text, date: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`, time: `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`, recurrence: "none", emotion: "happy" }, { type: "chat" });
    return { ok: true, message: "提醒已保存", item };
  } catch (err) { return { ok: false, message: String(err.message || err) }; }
});
ipcMain.handle("pet:get-reminders", () => schedules.list().filter((s) => s.source?.type === "chat"));
ipcMain.handle("pet:cancel-reminder", (_e, id) => schedules.cancel(String(id || "")));

ipcMain.handle("pet:pick-schedule-workbook", async () => {
  const r = await dialog.showOpenDialog(scheduleWin || win, { title: "选择日程 Excel", filters: [{ name: "Excel", extensions: ["xlsx"] }], properties: ["openFile"] });
  return r.canceled ? "" : r.filePaths[0];
});
function parseScheduleWorkbook(filePath) {
  if (!filePath || path.extname(filePath).toLowerCase() !== ".xlsx" || !fs.existsSync(filePath) || fs.statSync(filePath).size > 5 * 1024 * 1024) throw new Error("Excel 文件无效或超过 5MB");
  const wb = XLSX.readFile(filePath, { cellFormula: false, cellHTML: false, cellText: true });
  if (wb.SheetNames.length !== 1) throw new Error("Excel 必须只包含一个工作表");
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "", raw: false });
  if (!rows.length || rows.length > 500) throw new Error("Excel 需包含 1~500 条日程");
  return rows.map((r, i) => ({ title: r.title, date: r.date, time: r.time, recurrence: r.recurrence || "none", enabled: r.enabled, emotion: r.emotion || "happy", notes: r.notes || "", externalId: r.externalId || `xlsx-${i + 2}` }));
}
ipcMain.handle("pet:import-schedule-workbook", (_e, filePath) => {
  try {
    const items = parseScheduleWorkbook(filePath);
    const saved = items.map((item) => schedules.add(item, { type: "xlsx", fileName: path.basename(filePath), row: items.indexOf(item) + 2 }));
    return { ok: true, count: saved.length };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});
ipcMain.handle("pet:preview-schedule-workbook", (_e, filePath) => {
  try {
    const items = parseScheduleWorkbook(filePath);
    const rows = items.slice(0, 20).map((it, i) => ({ row: i + 2, title: it.title, date: it.date, time: it.time, recurrence: it.recurrence, emotion: it.emotion, notes: it.notes }));
    return { ok: true, fileName: path.basename(filePath), total: items.length, rows };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});
ipcMain.handle("pet:export-schedule-template", async () => {
  const r = await dialog.showSaveDialog(scheduleWin || win, { title: "保存日程 Excel 模板", defaultPath: "日程模板.xlsx", filters: [{ name: "Excel", extensions: ["xlsx"] }] });
  if (r.canceled || !r.filePath) return false;
  const ws = XLSX.utils.json_to_sheet([{ title: "喝药", date: "2026-08-25", time: "09:30", recurrence: "daily", enabled: "true", emotion: "happy", notes: "饭后服用", externalId: "med-001" }]);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "日程"); XLSX.writeFile(wb, r.filePath); return true;
});

// 番茄钟
ipcMain.handle("pet:pomodoro-start", (_e, { workMin, restMin }) => {
  features.startPomodoro((msg) => {
    sendProactive(msg, "happy", { force: true });
  }, workMin, restMin);
  return true;
});
ipcMain.handle("pet:pomodoro-stop", () => { features.stopPomodoro(); return true; });
ipcMain.handle("pet:pomodoro-status", () => features.getPomodoroStatus());

// 系统监控
ipcMain.handle("pet:get-sysstats", () => features.getSystemStats());

// 功能开关
ipcMain.handle("pet:toggle-feature", (_e, { name, value }) => {
  config.saveConfig({ features: { [name]: !!value } });
  if (name === "clipboardWatch") {
    if (value) {
      features.startClipboardWatch((msg) => {
        sendProactive(msg, "idle");
      }, 3000);
    } else {
      features.stopClipboardWatch();
    }
  }
  if (name === "systemMonitor") {
    if (value) {
      features.startSystemMonitor(
        () => features.getSystemStats(),
        (msg) => { sendProactive(msg, "think"); },
        15
      );
    } else {
      features.stopSystemMonitor();
    }
  }
  return true;
});
ipcMain.on("pet:move", (_e, dx, dy) => {
  if (win && !win.isDestroyed()) {
    const [x, y] = win.getPosition();
    win.setPosition(Math.round(x + dx), Math.round(y + dy));
    dragSeatUpdate(); // 拖拽落点吸附：接近任务栏/桌面图标自动坐下
    dbgLastMoveTs = Date.now();
  }
});
let dbgLastMoveTs = 0; // 最近一次拖拽移动时刻（paused 卡死自愈用）

/** 拖拽落点吸附判定（final=true 表示松手时刻）：
 *  桌面层级＋已授权：拖拽途中完全自由（任何磁吸都关掉，防任务栏 48px 带把人钉死），
 *  松手瞬间判定——贴近任务栏上沿坐下／贴近真实桌面图标顶坐上／其余位置自由放置；
 *  置顶模式沿用旧行为（边拖边吸：任务栏带＋估算网格）。 */
function dragSeatUpdate(final = false) {
  if (!win || win.isDestroyed()) return false;
  const b = win.getBounds();
  const wa = walkGeo.workAreaOf(screen, b);
  const feet = b.y + b.height - walk.groundGap; // 角色脚底实际屏幕位置
  const waBottom = wa.y + wa.height;
  let seated = false;
  let magnet = null;                                // 本次吸附类型："taskbar"|"icon"|null
  let ny = b.y, nx = b.x;

  const freeDragMode = config.getConfig().layer === "desktop";
  if (final) { // 拖动中完全不磁吸（含置顶模式），松手才判定——降低任务栏吸附感
    if (Math.abs(feet - waBottom) <= 12) {          // 任务栏完整坐姿磁吸（48→24→12：进一步降低吸附权重）
      seated = true;                                   // 任务栏完整坐姿磁吸
      magnet = "taskbar";
      walk.taskbarHang = false;
      ny = waBottom + walk.groundGap - b.height + getSeatSink();
      nx = Math.min(Math.max(b.x, walkMinX(wa)), wa.x + wa.width - b.width);
    } else if (freeDragMode && final && feet > waBottom - 40 && feet < waBottom + 20) {
      // 任务栏半挂：保留释放高度，仅有限下探，不强制塞入坐姿下沉量（原 -120/+80 → -40/+20 收窄）
      walk.taskbarHang = true;
      walk.resting = true;
      walk.seated = false;
      walk.sunk = false;
      walk.freeStand = true;
      // 半挂只允许在可见工作区内，避免透明窗口底部落到屏幕外被裁切。
      const visibleFeetY = Math.min(feet + walk.groundGap, waBottom);
      ny = Math.round(Math.max(wa.y, visibleFeetY - b.height + 22));
      nx = Math.min(Math.max(b.x, walkMinX(wa)), wa.x + wa.width - b.width);
      walkSetPosition(nx, ny, "taskbar-half-hang");
      walkBroadcast();
      applyLayer();
      return false;
    } else if (desktopIconMode()) {
      // 桌面层级＋已授权：松手贴近真实桌面图标顶(±44px)才坐上
      const charCx = (walk.charInset + b.width - 2) / 2;
      let best = null, bestD = Infinity;
      for (const p of desktopIconCache.list) {
        const d = Math.abs(feet - p.y);
        if (d <= 44 && d < bestD && Math.abs((b.x + charCx) - p.x) <= 60) { best = p; bestD = d; }
      }
      if (best) {
        seated = true;                                 // 图标顶磁吸
        magnet = "icon";
        ny = best.y + walk.groundGap - b.height + getSeatSink(); // 任务栏同款下沉：臀坐图标沿、腿垂进图标格
        nx = Math.round(best.x - charCx);
      }
    } else {
      // 桌面图标网格近似（主屏左侧区域；格尺寸按常见 DPI 估算）
      const pd = screen.getPrimaryDisplay().workArea;
      const cx = b.x + b.width / 2;
      const regionW = Math.min(pd.width * 0.32, 560);
      if (cx > pd.x && cx < pd.x + regionW) {
        const cellW = 76, cellH = 92, ox = pd.x + 6, oy = pd.y + 6;
        const col = Math.floor((cx - ox) / cellW);
        const cellCx = ox + col * cellW + cellW / 2;
        const rowTop = oy + Math.max(0, Math.round((feet - oy) / cellH)) * cellH;
        if (col >= 0 && Math.abs(feet - rowTop) <= 44) {
          seated = true;                               // 图标顶磁吸
          ny = rowTop + walk.groundGap - b.height;
          nx = Math.round(cellCx - b.width / 2);
        }
      }
    }
  }

  const changed = seated !== walk.seated;
  walk.seated = seated;
  if (!seated && final && freeDragMode) {
    walk.perched = false;
    walk.iconRest = false;
    walk.gotoPerch = false;
    walk.returning = false;
    walk.iconTarget = false;
    walk.resting = true;
    walk.freeStand = true;
    clearTimeout(walk.phaseTimer);
    walk.phaseTimer = null;
    walkSchedulePhase(randInt(15000, 35000));
  }
  if (seated) {
    walk.resting = true;
    walk.freeStand = false;
    walk.gotoPerch = false;
    walk.returning = false;
    walk.perched = false;
    win.setPosition(Math.round(nx), Math.round(ny));
  }
  if (changed) {
    if (!seated && desktopIconMode()) {       // 桌面模式离开吸附区＝自由放置：保持松手位置站姿，不自愈回任务栏
      walk.resting = true;
      walk.freeStand = true;
    } else if (!(seated && magnet === "icon") && !freeDragMode) {
      // 图标吸附的位置已是精确落点（脚踩图标顶），不能再用任务栏贴地定位覆盖；
      // 其余情况（任务栏磁吸/置顶模式）按地面线自愈
      applySeatPosition();
    }
    walkBroadcast();
  }
  applyLayer(walk.seated || walk.active);
  return seated;
}

/* ---------- 桌面行走 v2（仅 Spine 模式，与 GIF 表情系统完全独立）
   地面 = 任务栏上沿；水平左右走动、走走停停；偶尔跳到桌面程序窗口顶上坐下休息（Sit）。 ---------- */
const walk = walkCore.createWalkState(); // 行走状态（walk-core 提供，纯数据）
const WALK_TICK_MS = 40;
const WALK_SPEED = 1.2;                        // 每 tick 像素 ≈ 30px/s
function walkSpeed() {                         // 托盘速度档位倍率（借鉴 Ark-Pets 可调移速）
  return WALK_SPEED * (Number(config.getConfig().walkSpeedMul) || 1);
}
/** 行走引擎统一落点：坐标出现 NaN/Infinity 时拦截并记诊断日志。
 *  win.setPosition 收到非有限值会抛 "Error processing argument…"，
 *  未捕获异常会弹模态错误框冻结主进程（2026-08-24 walkTick:2148 实测发生）。 */
function walkSetPosition(x, y, where) {
  if (!win || win.isDestroyed()) return false;
  // 允许 x 为负（角色条带左移贴屏幕左缘，charInset 补偿），只拦截 NaN/越界；曾强制 x≥1 导致左侧“空气墙”
  const px = Math.round(Number(x)) || 0, py = Math.round(Number(y)) || 0; // ||0 归一化 -0（Electron setPosition(-0) 会 conversion failure）
  if (!Number.isSafeInteger(px) || !Number.isSafeInteger(py) || Math.abs(px) > 1000000 || Math.abs(py) > 1000000) {
    logTts("walk", "拦截非法窗口坐标(" + where + "): x=" + px + " y=" + py);
    return false;
  }
  try { win.setPosition(px, py); return true; }
  catch (e) {
    let bounds = "";
    try { bounds = " bounds=" + JSON.stringify(win.getBounds()); } catch { /* 忽略 */ }
    if (Date.now() - (walkSetPosition._lastLog || 0) > 5000) { // 节流
      walkSetPosition._lastLog = Date.now();
      logTts("walk", "setPosition 失败(" + where + "): x=" + px + " y=" + py + bounds + " err=" + (e && e.message || e) + " raw=(" + x + "," + y + ")");
    }
    return false;
  }
}

function walkBroadcast() {
  sendToRenderer("pet:walking", {
    active: walk.active, resting: walk.resting, perched: walk.perched, seated: walk.seated, face: walk.face,
    paused: walk.paused // 暂停也广播：渲染层据此切站立待机，不挂走路动画
  });
}

function walkSchedulePhase(ms) {
  clearTimeout(walk.phaseTimer);
  walk.phaseTimer = setTimeout(walkOnPhaseEnd, ms);
}

function cancelFlight() {
  if (!walk.flight) return false;
  walk.flight = null;
  return true;
}
function beginWalkJump(targetX, targetY) {
  if (!win || win.isDestroyed()) return false;
  const b = win.getBounds();
  walk.jump = { sx: b.x, sy: b.y, tx: Math.round(targetX), ty: Math.round(targetY), started: Date.now(), duration: 350 };
  clearTimeout(walk.phaseTimer);
  walk.phaseTimer = null;
  return true;
}
function cancelWalkJump() {
  if (!walk.jump) return false;
  walk.jump = null;
  return true;
}

function startFlight(vx, vy) {
  if (!win || win.isDestroyed() || !walk.active || walk.sleeping || !win.isVisible()) return false;
  const speed = Math.hypot(vx, vy);
  if (!Number.isFinite(speed) || speed <= 200) return false;
  const limit = Math.min(1, 1200 / speed);
  clearTimeout(walk.phaseTimer);
  walk.phaseTimer = null;
  walk.paused = walk.zoomPaused; // 放大暂停独立于抛掷：放大中抛掷落地后仍不恢复行走
  walk.pausedAt = 0;
  walk.resting = true;
  walk.seated = false;
  walk.perched = false;
  walk.iconRest = false;
  walk.iconTarget = false;
  walk.freeStand = false;
  walk.gotoPerch = false;
  walk.returning = false;
  walk.targetX = null;
  walk.flight = { vx: vx * limit, vy: vy * limit, bounces: 0 };
  walkBroadcast();
  applyLayer();
  logTts("walk", `抛掷: vx=${Math.round(vx * limit)} vy=${Math.round(vy * limit)}`);
  return true;
}

function walkFlightTick() {
  const flight = walk.flight;
  if (!flight || !win || win.isDestroyed()) return false;
  if (!win.isVisible() || walk.sleeping) { cancelFlight(); return true; }
  const dt = WALK_TICK_MS / 1000;
  const b = win.getBounds();
  const wa = walkGeo.workAreaOf(screen, b);
  const minX = walkMinX(wa);
  const maxX = Math.max(minX, wa.x + wa.width - b.width);
  const groundY = walkGeo.groundLine(wa, b.height, walk.groundGap);

  flight.vy = Math.min(1200, flight.vy + 900 * dt);
  flight.vx *= 0.995;
  let nx = b.x + flight.vx * dt;
  let ny = b.y + flight.vy * dt;
  if (nx < minX || nx > maxX) {
    nx = Math.min(Math.max(nx, minX), maxX);
    flight.vx *= -0.35;
  }
  if (ny < wa.y) {
    ny = wa.y;
    if (flight.vy < 0) flight.vy *= -0.35;
  }
  let landingBarrier = barrierFloorFor(b, nx, wa);
  let landingFloorY = groundY;
  let catchBarrier = false;
  if (landingBarrier) {
    const bt = landingBarrier.top;
    const prevBottom = b.y + b.height;
    const bot = ny + b.height;
    if ((prevBottom - bt) * (bot - bt) <= 0 && flight.vy >= 0) {
      // 底边本 tick 与窗顶交叉且在下落：落在窗顶（无条件落点，避免差几像素时落入"未交叉"死区）
      landingFloorY = bt + walk.groundGap - b.height;
      catchBarrier = true;
    } else {
      // 上升穿越/从下方穿过/全程低于窗顶：窗口不算落点，落回真实地面
      landingBarrier = null;
    }
  }
  if (!catchBarrier && ny < landingFloorY) {
    walkSetPosition(nx, ny, "flight-move"); // 坐标异常时自动拦截跳过，下一 tick 重新读取
    return true;
  }

  if (!walkSetPosition(nx, landingFloorY, "flight-land")) { // 坐标异常：放弃本次抛掷，恢复地面节奏
    cancelFlight();
    walk.resting = true;
    walkSchedulePhase(sitPhaseMs());
    return true;
  }
  if (flight.vy > 250) {
    flight.vy *= -0.35;
    flight.bounces += 1;
    return true;
  }
  cancelFlight();
  walk.resting = true;
  if (landingBarrier) {
    walk.perched = true;
    walk.seated = false;
    walk.sunk = false;
    walk.perchBarrier = { hwnd: landingBarrier.hwnd, left: landingBarrier.left, right: landingBarrier.right, top: landingBarrier.top, title: landingBarrier.title };
  } else {
    // 物理积分已经精确落在任务栏地面；不可再由坐姿定位叠加下沉量。
    walk.seated = true;
    walk.sunk = true;
  }
  walkSetPosition(nx, landingFloorY, "flight-settle");
  walkBroadcast();
  sendToRenderer("pet:dropped");
  walkSchedulePhase(sitPhaseMs());
  logTts("walk", "抛掷落地");
  // 人格化：被抛掷落地 / 抛掷落在窗顶
  if (landingBarrier) maybePersonify("perch", { chance: 0.25, cooldownMs: 120000 });
  else maybePersonify("thrown", { chance: 0.35, cooldownMs: 90000 });
  return true;
}

/** 相位切换：走↔停↔坐窗循环；休息结束时 35% 概率尝试跳上桌面程序窗口 */

/* ---------- 坐姿下沉量分档 ----------
 * 小尺寸（≤80%）窗口矮、腿短，固定下沉会陷得过深；冬季皮肤大尺寸单独一档；
 * 其余档位（含普通大/特大）统一用标准值。设置页滑杆可按档位覆盖，存 config.walkSeatSink。 */
function seatSinkTier() { return walkGeo.seatSinkTierOf(clampScale((config.getConfig().window || {}).scale), config.getConfig().spineSkinId); }
function getSeatSink() { return walkGeo.seatSinkOf(clampScale((config.getConfig().window || {}).scale), config.getConfig().spineSkinId, config.getConfig().walkSeatSink); }

/* ---------- 行走左边界补偿＋动作时长 ----------
 * 角色渲染在窗口右侧条带内、左侧是气泡预留区：按 charInset 放宽左边界，让角色能贴到屏幕左缘；
 * 坐/走时长在设置页调上限（保底随机），每个相位调度时实时读配置，改了立即生效。 */
function safeSetPosition(x, y, source = "position") {
  if (!win || win.isDestroyed()) return false;
  // 允许 x 为负（贴屏幕左缘），只拦截 NaN/越界
  const px = Math.round(Number(x)) || 0, py = Math.round(Number(y)) || 0; // ||0 归一化 -0
  if (!Number.isSafeInteger(px) || !Number.isSafeInteger(py) || Math.abs(px) > 1000000 || Math.abs(py) > 1000000) {
    logTts("walk", source + " 坐标越界：x=" + px + " y=" + py);
    return false;
  }
  try { win.setPosition(px, py); return true; }
  catch (e) {
    if (Date.now() - (safeSetPosition._lastLog || 0) > 5000) { // 节流：防连续失败刷爆日志
      safeSetPosition._lastLog = Date.now();
      logTts("walk", source + " setPosition 失败：" + (e && e.message || e) + " px=" + px + " py=" + py + " raw=(" + x + "," + y + ")");
    }
    return false;
  }
}
function clampWalkX(x, wa, width) { return walkGeo.clampWalkX(x, wa, width, walk.edgeLeft, walk.charInset); }
function walkSpan() { return walkGeo.spanOf(() => screen.getAllDisplays(), config.getConfig().walkGlobal); }
function clampWalkSpan(x, span, width) { return walkGeo.clampWalkSpan(x, span, width, walk.edgeLeft, walk.charInset); }
function walkMinX(wa) { return walkGeo.walkMinX(wa, walk.edgeLeft, walk.charInset); }
function setEdgeLeft(v) {
  v = !!v;
  if (walk.edgeLeft === v) return;
  // 气泡翻边：角色条带从窗口右缘切到左缘（或反向），同步平移窗口保持角色屏幕位置不变
  // （条带位移 = 窗口宽-124；配合渲染层 body.edge-left 的 .pet left:2）
  // 注意：必须「窗口平移 + 渲染层条带切换」在同一同步块内一次完成。
  // 曾实验 4×45ms 快滑 + CSS transition —— 主进程 setTimeout 时钟与渲染 CSS 动画时钟无法
  // 对齐，滑动中途 walkTick(40ms) 用新 charInset 判旧位置，把窗口硬拽回去，形成来回拉锯
  // （日志「边翻滑移 -20px → 160ms 后 出屏钳回 x=-20→-2」），视觉抖动比一步切换更严重。
  let delta = 0, width = 0;
  try { if (win && !win.isDestroyed()) { width = win.getBounds().width; delta = width - 124; } } catch { /* 忽略 */ }
  walk.edgeLeft = v;
  walk.charInset = v ? 2 : Math.max(0, width - 122); // 同步条带切换后的布局偏移（避免判定/边界用旧值）
  if (delta > 0 && win && !win.isDestroyed()) {
    try {
      const [x, y] = win.getPosition();
      win.setPosition(Math.round(x + (v ? delta : -delta)), y);
    } catch { /* 忽略 */ }
  }
  sendToRenderer("pet:edge-left", v); // 渲染层据此把角色条带切到左侧、气泡翻到右侧
}
function timingSec(key, min, max) {
  const n = Number((config.getConfig().walkTiming || {})[key]);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : null;
}
const SIT_MIN_MS = 10000, WALK_MIN_MS = 8000; // 相位保底时长（walkGeo.phaseMs 使用）
function sitPhaseMs() {   // 单次坐下：10s ~ 设置上限（默认30s）
  return walkGeo.phaseMs(randInt, config.getConfig(), "sitMaxSec", SIT_MIN_MS, 30, 15, 180);
}
function walkPhaseMs() {  // 单次散步：8s ~ 设置上限（默认20s）
  return walkGeo.phaseMs(randInt, config.getConfig(), "walkMaxSec", WALK_MIN_MS, 20, 8, 120);
}

/** 坐姿定位（绝对）：按当前 seated 状态把窗口摆到正确高度——
 *  站=脚踩任务栏上沿；坐=下沉 seatSink 腿垂进任务栏。幂等自愈，
 *  任何中间位移（拖拽/重启钳制）都会在下一次调用时纠正。仅 Spine 模式。 */
function applySeatPosition() {
  if (!win || win.isDestroyed() || config.getConfig().renderMode !== "spine") return;
  const b = win.getBounds();
  const wa = walkGeo.workAreaOf(screen, b);
  const baseY = wa.y + wa.height + walk.groundGap - b.height;   // 站立贴地
  const targetY = walk.seated ? baseY + getSeatSink() : baseY;  // 坐姿下沉（按尺寸档位）
  walk.sunk = walk.seated;
  if (Math.abs(b.y - targetY) > 1) win.setPosition(b.x, Math.round(targetY));
  applyLayer(walk.seated || walk.active); // 接触任务栏表面时保证在任务栏之上
}

function chooseWalkBehavior() { return walkCore.behaviorOf({ now: Date.now(), lastPerchEnd: walk._lastPerchEnd }); }

async function walkOnPhaseEnd() {
  if (!walk.active) return;
  if (walk.catToy) { walkSchedulePhase(randInt(400, 900)); return; } // 逗猫棒：相位机让位，由 walkTick 持续追鼠标
  if (walk.paused) {                        // 拖拽中冻结一切相位动作（防 applySeatPosition 把窗口弹回任务栏）
    walkSchedulePhase(randInt(3000, 6000));
    return;
  }
  if (walk.sleeping) { walkSchedulePhase(randInt(10000, 20000)); return; } // 睡觉中不切换相位
  if (walk.perched || walk.iconRest) {      // 图标/窗顶待够 → 回到地面
    walk._lastPerchEnd = Date.now();        // 跳窗顶冷却起点：刚下来 60s 内不再跳（降低"窗口吸力"感）
    walk.iconRest = false;
    walk.perched = false;
    walk.returning = true;
    walk.resting = false;
    walk.seated = false;
    walk.sunk = false;
    walkBroadcast();
    return;                                 // walkTick 完成下降后再排下一相位
  }
  if (walk.resting && !walk.seated) {       // 站立待命（拖拽松手未吸附/freeStand 到期回归）：
    if (walk.freeStand) {
      walk.freeStand = false;               // 桌面自由放置到期 → 继续往下走正常决策（散步/跳图标）
      walk._standLoops = 0;
    } else if ((walk._standLoops = (walk._standLoops || 0) + 1) < 2) {
      walkSchedulePhase(randInt(8000, 15000));   // 刚站下先稳住两轮（避免反复起坐），到期还没动作再落座
      return;
    } else {
      walk._standLoops = 0;                 // 站够仍无新决策 → 落座休息，避免永久站桩
      walk.seated = true;
      applySeatPosition();
      walkBroadcast();
      walkSchedulePhase(sitPhaseMs());
      return;
    }
  }
  if (walk.resting) {
    const behavior = chooseWalkBehavior();
    if (behavior === "perch") {
      if (!walk.paused && desktopIconMode()) {
        if (await walkAttemptIconPerch()) return;
      } else if (!walk.paused) {
        walkAttemptPerch();
        return;
      }
      // 屏障/图标不可用时，沿用普通待机回退。
      walk.resting = true;
      walk.seated = true;
      applySeatPosition();
      walkBroadcast();
      walkSchedulePhase(sitPhaseMs());
      return;
    }
    if (behavior === "idle") {
      walk.resting = true;
      walk.seated = true;
      applySeatPosition();
      walkBroadcast();
      walkSchedulePhase(sitPhaseMs());
      return;
    }
    walk.resting = false;                   // 开始散步
    walk.seated = false;
    applySeatPosition();                    // 起身：腿从任务栏里收回来
    walk.dir = Math.random() < 0.5 ? -1 : 1;
    walkBroadcast();
    if (desktopIconMode()) listDesktopIcons(); // 预取图标缓存，供行走引导判断
    walkSchedulePhase(walkPhaseMs());
  } else {                                  // 散步结束 → 坐下休息（Sit）
    walk.resting = true;
    walk.seated = true;
    applySeatPosition();                   // 坐下：腿垂进任务栏
    walkBroadcast();
    walkSchedulePhase(sitPhaseMs());
  }
}

function walkUpdateFace(dx) {
  if (dx !== 0) {
    const f = dx > 0 ? 1 : -1;
    if (f !== walk.face) {
      // 防抖：贴边连续折返时 face 不逐帧翻转（避免角色左右镜像不断闪现），150ms 后才允许再次翻转
      const now = Date.now();
      if (now - (walk._lastFaceFlip || 0) > 150) {
        walk._lastFaceFlip = now;
        walk.face = f;
        walkBroadcast();
      }
    }
  }
}

/** Win32 应用窗口屏障缓存（主进程坐标与 BrowserWindow 坐标统一为屏幕 DIP）。 */
let winBarriers = [];
let barrierTimer = null;
let barrierApi = null;
function initBarrierApi() {
  if (barrierApi || !koffi || process.platform !== "win32") return barrierApi;
  try {
    const user32 = koffi.load("user32.dll");
    const dwmapi = koffi.load("dwmapi.dll");
    const HWND = koffi.pointer(koffi.opaque());
    const RECT = koffi.struct("BarrierRect", { left: "int32", top: "int32", right: "int32", bottom: "int32" });
    const EnumProc = koffi.proto("bool __stdcall EnumProc(void *hwnd, long lParam)");
    barrierApi = {
      HWND, RECT,
      enumWindows: user32.func("bool __stdcall EnumWindows(EnumProc *lpEnumFunc, long lParam)"),
      isVisible: user32.func("bool __stdcall IsWindowVisible(void *hWnd)"),
      getRect: user32.func("bool __stdcall GetWindowRect(void *hWnd, _Out_ BarrierRect *lpRect)"),
      getText: user32.func("int __stdcall GetWindowTextW(void *hWnd, _Out_ uint16_t *lpString, int nMaxCount)"),
      getClass: user32.func("int __stdcall GetClassNameW(void *hWnd, _Out_ uint16_t *lpClassName, int nMaxCount)"),
      cloaked: dwmapi.func("int __stdcall DwmGetWindowAttribute(void *hwnd, uint32_t dwAttribute, _Out_ uint32_t *pvAttribute, uint32_t cbAttribute)"),
      EnumProc
    };
    return barrierApi;
  } catch (e) {
    barrierApi = null;
    logTts("walk", "窗口屏障初始化失败: " + (e && e.message || e));
    return null;
  }
}
function readWide(buf, length) {
  let end = Math.max(0, Math.min(length, buf.length / 2));
  while (end > 0 && buf[end - 1] === 0) end--;
  return Buffer.from(buf.buffer, buf.byteOffset, end * 2).toString("utf16le");
}
function winRectToDip(rect) {
  const width = rect.right - rect.left, height = rect.bottom - rect.top;
  const display = screen.getDisplayMatching({ x: rect.left, y: rect.top, width, height });
  const scale = display.scaleFactor || 1;
  const origin = display.bounds;
  return {
    left: Math.round(origin.x + (rect.left - origin.x * scale) / scale),
    top: Math.round(origin.y + (rect.top - origin.y * scale) / scale),
    right: Math.round(origin.x + (rect.right - origin.x * scale) / scale),
    bottom: Math.round(origin.y + (rect.bottom - origin.y * scale) / scale)
  };
}
function refreshWinBarriers() {
  const api = initBarrierApi();
  if (!api || !win || win.isDestroyed()) { winBarriers = []; return []; }
  try {
    const next = [];
    const cb = (hwnd) => {
      if (!hwnd || !api.isVisible(hwnd)) return true;
      const rect = {};
      if (!api.getRect(hwnd, rect)) return true;
      const w = rect.right - rect.left, h = rect.bottom - rect.top;
      if (w < 150 || h < 100) return true;
      const titleBuf = new Uint16Array(512), classBuf = new Uint16Array(256);
      const titleLen = api.getText(hwnd, titleBuf, titleBuf.length);
      const classLen = api.getClass(hwnd, classBuf, classBuf.length);
      const title = readWide(titleBuf, titleLen), cls = readWide(classBuf, classLen);
      if (!title || title.includes("苏苏洛") || /^(WorkerW|Progman|Shell_TrayWnd)$/.test(cls)) return true;
      const cloak = new Uint32Array(1);
      if (api.cloaked(hwnd, 14, cloak, 4) === 0 && cloak[0]) return true;
      const dip = winRectToDip(rect);
      next.push({ top: dip.top, left: dip.left, right: dip.right, bottom: dip.bottom, hwnd, title });
      return true;
    };
    api.enumWindows(cb, 0);
    winBarriers = next;
    invalidatePerchIfNeeded();
    logTts("walk", "窗口屏障刷新: " + next.length + " 个");
  } catch (e) {
    winBarriers = [];
    logTts("walk", "窗口屏障刷新失败: " + (e && e.message || e));
  }
  return winBarriers;
}
function barrierFloorFor(b, x, wa) {
  const cx = x + b.width / 2;
  const candidates = winBarriers.filter((r) =>
    r.right > x + 12 && r.left < x + b.width - 12 &&
    r.top > wa.y + 20 && r.top < wa.y + wa.height
  );
  if (!candidates.length) return null;
  const r = candidates.reduce((best, item) => item.top < best.top ? item : best);
  if (cx < r.left - b.width / 2 || cx > r.right + b.width / 2) return null;
  return r;
}

function barrierRects() {
  return winBarriers.map((r) => ({ x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top, top: r.top, right: r.right, title: r.title, hwnd: r.hwnd }));
}
function hwndKey(hwnd) {
  try { return String(hwnd); } catch { return ""; }
}
function barrierIsCurrent(p) {
  return !!p && winBarriers.some((r) => hwndKey(r.hwnd) === hwndKey(p.hwnd) && Math.abs(r.top - p.top) <= 2 && Math.abs(r.left - p.left) <= 2 && Math.abs(r.right - p.right) <= 2);
}
function invalidatePerchIfNeeded() {
  if (!walk.perched || !walk.perchBarrier || barrierIsCurrent(walk.perchBarrier)) return;
  walk.perched = false;
  walk.perchBarrier = null;
  walk.returning = true;
  walk.resting = false;
  walk.seated = false;
  walk.targetX = null;
  cancelWalkJump();
  walkBroadcast();
  logTts("walk", "窗口屏障失效，返回地面");
}

/** 兼容旧调用方：窗口候选由屏障缓存提供。 */
async function listAppWindows() {
  return barrierRects().map((r) => ({ x: r.x, y: r.top, w: r.w, h: r.h, right: r.right, title: r.title, hwnd: r.hwnd }));
}


/* ---------- 桌面图标感知（需 features.desktopIcons 授权，默认关） ----------
 * 只读桌面图标的屏幕坐标（Win32 SysListView32 + ReadProcessMemory，不读内容、不上传），
 * 供她走到图标上站/坐、以及「前方没图标就不硬走」。结果缓存 5 分钟。
 * 注意：部分环境下 FindWindow 查不到 Progman，故统一用 EnumWindows/EnumChildWindows 枚举定位。 */
const PS_DESKTOP_ICONS = `
$sig = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public struct IRECT { public int L, T, R, B; }
public class DI {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr wp, IntPtr lp);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out IRECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint a, bool ih, uint pid);
  [DllImport("kernel32.dll")] public static extern IntPtr VirtualAllocEx(IntPtr h, IntPtr a, uint s, uint t, uint p);
  [DllImport("kernel32.dll")] public static extern bool ReadProcessMemory(IntPtr h, IntPtr b, byte[] buf, uint s, out IntPtr r);
  [DllImport("kernel32.dll")] public static extern bool VirtualFreeEx(IntPtr h, IntPtr b, uint s, uint t);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
}
'@
Add-Type -TypeDefinition $sig

$script:progman = [IntPtr]::Zero
$script:workers = New-Object System.Collections.Generic.List[IntPtr]
$cbTop = [DI+EnumProc]{
  param($h, $l)
  $sb = New-Object System.Text.StringBuilder 256
  [DI]::GetClassName($h, $sb, 256) | Out-Null
  $cls = $sb.ToString()
  if ($cls -eq "Progman" -and $script:progman -eq [IntPtr]::Zero) { $script:progman = $h }
  elseif ($cls -eq "WorkerW") { $script:workers.Add($h) }
  $true
}
[DI]::EnumWindows($cbTop, [IntPtr]::Zero) | Out-Null

$script:defview = [IntPtr]::Zero
$parents = New-Object System.Collections.Generic.List[IntPtr]
if ($script:progman -ne [IntPtr]::Zero) { $parents.Add($script:progman) }
foreach ($w in $script:workers) { $parents.Add($w) }

foreach ($p in $parents) {
  if ($script:defview -ne [IntPtr]::Zero) { break }
  $cbChild = [DI+EnumProc]{
    param($h, $l)
    $sb = New-Object System.Text.StringBuilder 256
    [DI]::GetClassName($h, $sb, 256) | Out-Null
    if ($sb.ToString() -eq "SHELLDLL_DefView") { $script:defview = $h; return $false }
    return $true
  }
  [DI]::EnumChildWindows($p, $cbChild, [IntPtr]::Zero) | Out-Null
}

if ($script:defview -eq [IntPtr]::Zero) { "[]"; exit }

$script:lv = [IntPtr]::Zero
$cbLv = [DI+EnumProc]{
  param($h, $l)
  $sb = New-Object System.Text.StringBuilder 256
  [DI]::GetClassName($h, $sb, 256) | Out-Null
  if ($sb.ToString() -eq "SysListView32") { $script:lv = $h; return $false }
  return $true
}
[DI]::EnumChildWindows($script:defview, $cbLv, [IntPtr]::Zero) | Out-Null
if ($script:lv -eq [IntPtr]::Zero) { "[]"; exit }

$rc = New-Object IRECT
[DI]::GetWindowRect($script:lv, [ref]$rc) | Out-Null
$count = [DI]::SendMessage($script:lv, 0x1004, [IntPtr]::Zero, [IntPtr]::Zero).ToInt32()
$procId = 0
[DI]::GetWindowThreadProcessId($script:lv, [ref]$procId) | Out-Null
$proc = [DI]::OpenProcess(0x38, $false, $procId)
if ($proc -eq [IntPtr]::Zero -or $count -le 0) { "[]"; exit }

$ptr = [DI]::VirtualAllocEx($proc, [IntPtr]::Zero, 16, 0x3000, 0x04)
$out = @()
for ($i = 0; $i -lt $count; $i++) {
  [DI]::SendMessage($script:lv, 0x1010, [IntPtr]$i, $ptr) | Out-Null
  $buf = New-Object byte[] 8
  $rd = [IntPtr]::Zero
  [DI]::ReadProcessMemory($proc, $ptr, $buf, 8, [ref]$rd) | Out-Null
  $out += @{ x = $rc.L + [BitConverter]::ToInt32($buf, 0); y = $rc.T + [BitConverter]::ToInt32($buf, 4) }
}
[DI]::VirtualFreeEx($proc, $ptr, 0, 0x8000) | Out-Null
[DI]::CloseHandle($proc) | Out-Null
if ($out.Count -eq 0) { "[]" }
elseif ($out.Count -eq 1) { "[" + ($out[0] | ConvertTo-Json -Compress) + "]" }
else { $out | ConvertTo-Json -Compress }
`;

function desktopIconMode() { // 仅 Spine 行走系统＋桌面层级＋授权 同时满足才启用（GIF 模式无坐图标系统）
  const cfg = config.getConfig();
  return cfg.renderMode === "spine" && cfg.layer === "desktop" && !!((cfg.features || {}).desktopIcons);
}
let desktopIconCache = { at: 0, list: [] };

async function listDesktopIcons(force = false) {
  if (!desktopIconMode()) return [];
  if (!force && Date.now() - desktopIconCache.at < 5 * 60 * 1000) return desktopIconCache.list;
  let txt = await runPowerShell(PS_DESKTOP_ICONS);
  if (!txt && !desktopIconCache.list.length) { // PowerShell 偶发失败：稍候重试一次
    await new Promise((r) => setTimeout(r, 1200));
    txt = await runPowerShell(PS_DESKTOP_ICONS);
  }
  try {
    const j = JSON.parse(txt || "[]");
    const display = screen.getPrimaryDisplay();
    const scale = display.scaleFactor || 1;
    const origin = display.bounds;
    const list = (Array.isArray(j) ? j : [])
      .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
      .map((p) => ({
        x: Math.round(origin.x + (p.x - origin.x * scale) / scale),
        y: Math.round(origin.y + (p.y - origin.y * scale) / scale)
      }));
    desktopIconCache = { at: Date.now(), list };
    logTts("walk", "桌面图标感知: " + list.length + " 个 (scale=" + scale + ")");
    return list;
  } catch { return []; }
}

/** 挑一个桌面图标走过去跳上去站/坐（复用跳窗的走近→一步跳→回落流程） */
async function walkAttemptIconPerch() {
  try {
    if (!win || win.isDestroyed()) return false;
    const b = win.getBounds();
    const wa = walkGeo.workAreaOf(screen, b);
    let icons = await listDesktopIcons(false);               // 优先用缓存（≤5 分钟），避免频繁起 PowerShell 偶发失败导致静默长坐
    if (!icons.length) icons = await listDesktopIcons(true); // 无缓存/上次失败再强取一次
    const cands = icons.filter((p) =>
      p.x >= wa.x + 8 && p.x <= wa.x + wa.width - 60 &&
      p.y >= wa.y &&                                        // 图标顶不出屏幕顶
      p.y + walk.groundGap - b.height >= wa.y - 8 &&        // 站上去后窗口顶部（头）也不出屏幕顶
      p.y + walk.groundGap <= wa.y + wa.height + 60         // 脚底不超出工作区底太多
    );
    if (!cands.length) return false;
    const t = cands[Math.floor(Math.random() * cands.length)];
    walk.perchTopY = Math.round(t.y + walk.groundGap - b.height); // 窗口底=图标顶+脚下空隙 → 角色脚踩图标顶
    const charCx = (walk.charInset + b.width - 2) / 2; // 角色条带中心对准图标
    walk.targetX = Math.min(Math.max(Math.round(t.x - charCx), walkMinX(wa)), wa.x + wa.width - b.width);
    walk.iconTarget = true;
    walk.gotoPerch = true;
    walk.resting = false;
    walk.seated = false;
    walk.sunk = false;
    walkBroadcast();
    logTts("walk", "跳上桌面图标: " + JSON.stringify(t));
    return true;
  } catch {
    return false;
  }
}

/** 挑一个合适的程序窗口，走过去跳上去坐 */
function walkAttemptPerch() {
  (async () => {
    try {
      if (!win || win.isDestroyed()) return;
      const b = win.getBounds();
      const wa = walkGeo.workAreaOf(screen, b);
      const wins = barrierRects();
      const cands = wins.filter((r) =>
        r.w >= 280 && r.h >= 140 &&
        r.y >= wa.y + 60 &&
        r.y - b.height >= wa.y + 6 &&
        r.x < wa.x + wa.width && r.x + r.w > wa.x
      );
      if (!cands.length) {                           // 没有合适窗口 → 坐下休息
        logTts("walk", "无合适窗口可坐，就地休息"); // 失败可观测：避免静默长坐无从排查
        walk.resting = true;
        walk.seated = true;
        applySeatPosition();
        walkBroadcast();
        walkSchedulePhase(sitPhaseMs());
        return;
      }
      const t = cands[Math.floor(Math.random() * cands.length)];
      walk.perchBarrier = { hwnd: t.hwnd, left: t.x, right: t.x + t.w, top: t.y, title: t.title };
      walk.perchTopY = t.y - b.height + walk.groundGap;
      walk.targetX = Math.min(Math.max(t.x + t.w / 2 - b.width / 2, wa.x), wa.x + wa.width - b.width);
      walk.gotoPerch = true;
      walk.resting = false;
      walk.seated = false;
      walk.sunk = false;
      walkBroadcast();
      logTts("walk", "跳上窗口: " + JSON.stringify({ x: t.x, y: t.y, w: t.w, h: t.h, title: t.title }));
    } catch (e) {
      logTts("walk", "坐窗口失败: " + (e && e.message || e));
      walk.resting = true;
      walkBroadcast();
      walkSchedulePhase(sitPhaseMs());
    }
  })();
}

/** 出屏兜底（独立定时器，不依赖行走引擎）：窗口被拖出屏幕（下方/左侧）自动钳回可见位置。
 *  行走引擎未开启时 walkTick 不跑，此兜底仍生效，防止桌宠"消失"。 */
function outOfScreenGuard() {
  try {
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    if (walk.paused || walk.flight || walk.jump) return; // 拖拽/飞行中不干预
    const b = win.getBounds();
    const wa = walkGeo.workAreaOf(screen, b);
    // 垂直：窗口底超出工作区底太多（含被拖到屏幕下方）→ 钳回地面线
    const groundY = Math.max(wa.y, wa.y + wa.height - b.height) + (walk.groundGap || 0);
    if (b.y > groundY + 120) {
      if (Date.now() - (walk._vLog || 0) > 10000) { walk._vLog = Date.now(); logTts("walk", `垂直出屏钳回: y=${b.y}→${Math.round(groundY)}`); }
      win.setPosition(b.x, Math.round(groundY));
      if (walk.seated) applySeatPosition();
    }
    // 水平：角色条带左缘越出工作区左缘 → 钳回贴边（与 walkTick 同款死区，越界 ≤8px 不干预）
    const inset = walk.edgeLeft ? 2 : (Number(walk.charInset) || 0);
    const charLeft = b.x + inset;
    if (walkGeo.clampNeeded(wa.x, charLeft).overdue) {
      const fixX = wa.x - inset;
      win.setPosition(Math.round(fixX), b.y);
    }
  } catch { /* 忽略 */ }
}
// 出屏哨兵由 startOutOfScreenGuard() 统一管理（createWindow 调用），此处不再重复启动

function walkTick() {
  if (!win || win.isDestroyed()) return;
  // 左缘翻边判定（坐下/静止在左缘也要切；拖拽/飞行/跳跃中不切防干扰）
  // 用「角色条带左缘」判断而非窗口 x：切边/切回时窗口被平移 ±276，用窗口 x 会立即再次触发形成左右横跳
  if (!walk.paused && !walk.sleeping && !walk.flight && !walk.jump) {
    try {
      const eb = win.getBounds();
      const ewa = walkGeo.workAreaOf(screen, eb);
      const edgeSpan = walkSpan(); // 全域行走（实验）：左缘=整个虚拟桌面左缘，否则=当前显示器
      const edgeL = edgeSpan ? edgeSpan.x : ewa.x;
      // 垂直兜底：窗口底超出工作区（被拖出屏幕/掉出屏幕）→ 钳回地面线
      const groundY = walkGeo.groundLine(ewa, eb.height, walk.groundGap);
      if (eb.y > groundY + 120) {
        if (Date.now() - (walk._vLog || 0) > 10000) { walk._vLog = Date.now(); logTts("walk", `垂直出屏钳回: y=${eb.y}→${Math.round(groundY)}`); }
        win.setPosition(eb.x, Math.round(groundY));
        if (walk.seated) applySeatPosition(); // 应坐姿时再校正下沉
      }
      const inset = walk.edgeLeft ? 2 : (Number(walk.charInset) || 0);
      let charLeft = eb.x + inset;
      // 出屏兜底：角色条带左缘越出边界 → 钳回贴边（崩溃/状态错乱后角色滑出屏幕）。
      // 死区处理（§14 追加 89 遗留）：越界 ≤8px 视为行走推进/贴边翻边的瞬时像素噪声，
      // 只记录不 setPosition——否则高频钳位与行走推进成「推出→拽回」拉锯 = 左缘微闪。
      if (charLeft < edgeL) {
        const ck = walkGeo.clampNeeded(edgeL, charLeft);
        if (Date.now() - (walk._dbgAt || 0) > 10000) { walk._dbgAt = Date.now(); logTts("walk", ck.overdue
          ? `出屏钳回: x=${eb.x}→${edgeL - inset} 越界${ck.deficit}px edgeLeft=${walk.edgeLeft} inset=${inset}`
          : `出屏越界(死区内) x=${eb.x} 越界${ck.deficit}px 不钳`); }
        if (ck.overdue) {
          win.setPosition(Math.round(edgeL - inset), eb.y);
          charLeft = edgeL;
        }
      }
      // 切边防抖：edgeLeft 切换会平移窗口 ±(width-124)，500ms 内不反向切换，避免贴边临界时左右瞬移「闪现」
      const nowE = Date.now();
      if (walk.edgeLeft) { if (charLeft > edgeL + 80 && nowE - (walk._edgeFlipAt || 0) > 500) { walk._edgeFlipAt = nowE; setEdgeLeft(false); } }
      else if (charLeft <= edgeL + 2 && nowE - (walk._edgeFlipAt || 0) > 500) { walk._edgeFlipAt = nowE; setEdgeLeft(true); }
    } catch { /* 忽略 */ }
  }
  // 自愈①：拖拽 mouseup 丢失导致 paused 卡死——60s 无移动事件自动解除（对话暂停/放大暂停不受此影响）
  if (walk.dragPaused && walk.pausedAt && !walk.chatPaused && !walk.zoomPaused && Date.now() - walk.pausedAt > 60000 && Date.now() - (dbgLastMoveTs || 0) > 5000) {
    walk.dragPaused = false;
    walk.pausedAt = 0;
    walk.paused = walk.chatPaused || walk.zoomPaused;
    walkBroadcast(); // 自愈解除暂停，同步渲染层动画
    logTts("walk", "拖拽暂停超时，自动恢复");
  }
  // 瞬态守卫（ottopet restore_timer 借鉴）：gotoPerch/returning 长时间未完成（屏障/状态错乱）→ 强制回地面
  if ((walk.gotoPerch || walk.returning) && !walk.paused && !walk.sleeping) {
    if (!walk._transientAt) walk._transientAt = Date.now();
    if (Date.now() - walk._transientAt > 10000) {
      const what = walk.gotoPerch ? "gotoPerch" : "returning";
      logTts("walk", "瞬态守卫: " + what + " 超时10s，强制回地面");
      walk.gotoPerch = false;
      walk.returning = false;
      walk.iconTarget = false;
      walk.jump = null;
      walk.resting = true;
      walk.seated = true;
      walk.sunk = false;
      applySeatPosition();
      walkBroadcast();
      walkSchedulePhase(sitPhaseMs());
    }
  } else walk._transientAt = 0;
  // 抛掷守卫：飞行超过 15s（物理异常）→ 强制落地
  if (walk.flight && !walk._flightAt) walk._flightAt = Date.now();
  if (walk.flight && Date.now() - (walk._flightAt || 0) > 15000) {
    logTts("walk", "瞬态守卫: flight 超时15s，强制落地");
    cancelFlight();
    walk.resting = true;
    walk.seated = true;
    applySeatPosition();
    walkBroadcast();
    walkSchedulePhase(sitPhaseMs());
  } else if (!walk.flight) walk._flightAt = 0;
  if (walkFlightTick()) return;
  if (walk.jump) {
    const j = walk.jump;
    const p = easeImpact((Date.now() - j.started) / j.duration); // 快进-滞空-快退
    const nx = Math.round(j.sx + (j.tx - j.sx) * p);
    const ny = Math.round(j.sy + (j.ty - j.sy) * p);
    if (!walkSetPosition(nx, ny, "jump-ease")) { // 坐标异常：放弃本次跳跃，自愈回地面节奏
      walk.jump = null;
      walk.gotoPerch = false;
      walk.returning = false;
      walk.resting = true;
      walkSchedulePhase(sitPhaseMs());
      return;
    }
    if (p < 1) return;
    walk.jump = null;
    if (walk.gotoPerch) {
      walk.gotoPerch = false;
      const onIcon = walk.iconTarget;
      // 坐到图标/窗顶统一走 perched：渲染层播 Sit、按边缘下沉腿垂入图标格/窗口沿，
      // 不再区分 iconRest（旧逻辑下图标坐 45% 概率无下沉且站姿，视觉不一致）
      walk.iconRest = onIcon && Math.random() < 0.45;
      walk.perched = true;
      walk.resting = true;
      if (walk.perched && onIcon) walkSetPosition(j.tx, walk.perchTopY + getSeatSink(), "jump-perch-sink");
      walkBroadcast();
      applyLayer();
      walkSchedulePhase(sitPhaseMs());
      // 人格化：平时散步跳到窗口顶上时偶尔嘀咕
      maybePersonify("perch", { chance: 0.2, cooldownMs: 150000 });
    } else if (walk.returning) {
      walk.returning = false;
      walk.resting = true;
      walk.seated = true;
      applySeatPosition();
      walkBroadcast();
      walkSchedulePhase(sitPhaseMs());
    }
    return;
  }
  if (walk.paused || walk.seated || !win.isVisible()) return; // 拖拽中/坐下/隐藏到托盘时不移动
  // 自愈②：相位定时器丢失（不在任何过渡流程却无人排程）→ 自动重启循环，防永久静止
  if (!walk.paused && !walk.sleeping && !walk.phaseTimer &&
      !walk.gotoPerch && !walk.returning && !walk.perched && !walk.iconRest && !walk.seated) {
    logTts("walk", "相位定时器丢失，自动恢复"); // 自愈日志（低频：出现即说明某路径打断后未重新排程；2026-08-27 收敛 TODO）
    walkSchedulePhase(randInt(3000, 8000));
  }
  const b = win.getBounds();
  const wa = walkGeo.workAreaOf(screen, b);
  const gSpan = walkSpan(); // 全域行走（实验）：水平范围=整个虚拟桌面
  const xRange = gSpan ? clampWalkSpan(b.x, gSpan, b.width) : clampWalkX(b.x, wa, b.width);
  const minX = xRange.minX;
  const maxX = xRange.maxX;
  const groundY = walkGeo.groundLine(wa, b.height, walk.groundGap);
  let x = xRange.x;
  if (xRange.collapsed && !walk._loggedCollapsedRange) {
    walk._loggedCollapsedRange = true;
    logTts("walk", "水平范围坍缩，使用可见边界：rawMax=" + xRange.rawMax + " minX=" + xRange.minX + " inset=" + xRange.inset);
  } else if (!xRange.collapsed) {
    walk._loggedCollapsedRange = false;
  }

  /* —— 去/回窗口：水平走到正下方后「一步跳」上去/跳下来，不做长距离垂直移动 —— */
  if ((walk.gotoPerch || walk.returning) && !walk.sleeping) {
    const tx = walk.targetX;
    if (tx != null && Math.abs(tx - x) > 2) {      // 水平接近窗口正下方
      const nx = Math.abs(tx - x) < walkSpeed() ? tx : x + Math.sign(tx - x) * walkSpeed();
      walkUpdateFace(Math.sign(nx - x));
      walkSetPosition(nx, b.y, "walk-approach");
      return;
    }
    // 到位后启动约 350ms 缓动跳跃，完成时再提交坐/回地状态
    beginWalkJump(tx != null ? tx : x, walk.returning ? groundY : walk.perchTopY);
    return;
  }

  /* —— 逗猫棒：追鼠标（水平移动），到达鼠标正下方后站立 —— */
  if (walk.catToy && !walk.sleeping) {
    if (Number.isFinite(lastCursor.x)) {
      const tx = Math.min(Math.max(lastCursor.x - (walk.edgeLeft ? 2 : (walk.charInset || 0)), minX), maxX);
      const dx = tx - x;
      const moving = Math.abs(dx) > 4;
      if (moving !== !walk.resting) { walk.resting = !moving; walkBroadcast(); } // 走/停状态变化才广播（动画 Move↔idle）
      if (moving) {
        const step = walkSpeed();
        const nx3 = Math.abs(dx) < step ? tx : x + Math.sign(dx) * step;
        walkUpdateFace(Math.sign(dx));
        safeSetPosition(Math.round(nx3), Math.round(groundY), "cat-toy");
      }
    }
    return;
  }

  /* —— 地面状态 —— */
  if (walk.resting || walk.sleeping) return;        // 放松/睡觉：站着不动
  if (xRange.collapsed) {
    // 可走范围坍缩（窗口比工作区宽）：行走中窗口被意外加宽（如气泡触发 setSize）会静默卡住“走路不移动”——恢复标准尺寸后继续
    try {
      const wc = config.getConfig().window || {};
      win.setSize(Math.round(wc.width || 260), Math.round(wc.height || 200));
      logTts("walk", "坍缩恢复标准窗口: w=" + b.width + "→" + Math.round((config.getConfig().window || {}).width || 260));
    } catch { /* 忽略 */ }
    return;
  }

  let nx = x + walk.dir * walkSpeed();
  if (nx <= minX || nx >= maxX) {                   // 到屏幕边折返（左侧已按角色条带补偿）
    walk.dir *= -1;
    nx = Math.min(Math.max(nx, minX), maxX);
    walkUpdateFace(walk.dir);                       // 折返：立即用新方向同步朝向（原来翻转前调旧 dir、下一帧才翻，贴边连续折返时角色左右镜像闪现）
  } else {
    walkUpdateFace(walk.dir);                       // 朝向跟随实际位移方向
  }
  /* 桌面图标缓存仅用于跳图标目标；缓存缺口不应打断普通地面行走。 */
  /* 桌面图标缓存仅用于跳图标目标；缓存缺口不应打断普通地面行走。 */
  const px = Math.round(nx), py = Math.round(groundY);
  if (!Number.isSafeInteger(px) || !Number.isSafeInteger(py) || Math.abs(px) > 1000000 || Math.abs(py) > 1000000) {
    logTts("walk", "walkTick 坐标越界，跳过本 tick：x=" + px + " y=" + py +
      " dir=" + walk.dir + " speedMul=" + config.getConfig().walkSpeedMul +
      " groundGap=" + walk.groundGap + " bounds=" + JSON.stringify(b) + " workArea=" + JSON.stringify(wa));
    return;
  }
  safeSetPosition(px, py, "walkTick");
}

function startWalkingEngine() {
  if (walk.active) return true;
  if (config.getConfig().renderMode !== "spine") return false; // GIF 模式不可行走
  // 行走前恢复标准窗口尺寸：气泡加宽的大窗口会让 charInset=宽-122 超上限 → 行走左边界扩到屏幕外（“闪现”/出屏）
  try {
    const wc = config.getConfig().window || {};
    win.setSize(Math.round(wc.width || 260), Math.round(wc.height || 200));
  } catch { /* 忽略 */ }
  walk.active = true;
  walk.resting = true;
  walk.perched = false;
  walk.iconRest = false;
  walk.iconTarget = false;
  walk.freeStand = false;
  walk.gotoPerch = false;
  walk.returning = false;
  walk.seated = true; // 启动先坐下，片刻后起身散步
  walk.face = Math.random() < 0.5 ? -1 : 1;
  try { // 已在地面线附近则直接进入下沉坐姿
    const b0 = win.getBounds();
    const wa0 = walkGeo.workAreaOf(screen, b0);
    if (Math.abs(b0.y + b0.height - walk.groundGap - (wa0.y + wa0.height)) < 60) applySeatPosition();
  } catch { /* 忽略 */ }
  walk.timer = setInterval(walkTick, WALK_TICK_MS);
  walkBroadcast();
  walkSchedulePhase(randInt(5000, 15000));
  applyLayer(true); // 行走全程贴任务栏，需在任务栏之上
  logTts("walk", "桌面行走开启");
  return true;
}

function stopWalkingEngine(silent = false) {
  if (!walk.active) return; // 停止行走保持当前坐姿（seated 不重置，仍坐在任务栏上）
  cancelFlight();
  cancelWalkJump();
  if (walk.iconRest || walk.perched || walk.gotoPerch || walk.returning) {
    // 正在图标/窗顶时关掉行走：清掉空中状态，落回任务栏坐下
    walk.iconRest = false;
    walk.iconTarget = false;
    walk.perched = false;
    walk.gotoPerch = false;
    walk.returning = false;
    walk.resting = true;
    walk.seated = true;
    applySeatPosition();
  }
  applyLayer(walk.seated);
  walk.active = false;
  clearInterval(walk.timer); walk.timer = null;
  clearTimeout(walk.phaseTimer); walk.phaseTimer = null;
  if (!silent) walkBroadcast();
  logTts("walk", "桌面行走关闭");
}

/** renderMode/walking 配置变化后同步引擎状态；切回 GIF 时自动停走（walking 记忆保留，回 Spine 后恢复） */
function syncWalkingEngine() {
  const cfg = config.getConfig();
  const shouldRun = cfg.walking === true && cfg.renderMode === "spine";
  if (shouldRun && !walk.active) startWalkingEngine();
  else if (!shouldRun && walk.active) stopWalkingEngine();
}

/* 行走状态变化诊断（低噪）：状态签名变化才记日志，卡住时日志里能直接看到
 * 最后活跃状态；另对「引擎活跃却 90s+ 站着不动」给一次警告（排查相位机停摆）。 */
let walkDiagAt = 0;
let walkDiagLastSig = "";
function walkDiag() {
  try {
    const b = (win && !win.isDestroyed()) ? win.getBounds() : null;
    const sig = [walk.active, walk.resting, walk.seated, walk.perched, walk.paused, walk.sleeping, walk.catToy, !!walk.phaseTimer, !!walk.timer].join("|");
    if (sig !== walkDiagLastSig) {
      walkDiagLastSig = sig;
      logTts("walk", "状态 " + sig + " x=" + (b ? b.x : "?") + " y=" + (b ? b.y : "?"));
      walkDiagAt = Date.now();
    } else if (walk.active && !walk.paused && walk.timer && Date.now() - walkDiagAt > 90000) {
      walkDiagAt = Date.now();
      logTts("walk", "状态告警: 90s 无变化（含站着不动检查）x=" + (b ? b.x : "?") + " resting=" + walk.resting + " seated=" + walk.seated + " sleeping=" + walk.sleeping + " phaseTimer=" + !!walk.phaseTimer);
    }
  } catch { /* 忽略 */ }
}
setInterval(walkDiag, 20000);

function setWalking(on) {
  config.saveConfig({ walking: !!on });
  refreshTrayMenu();
  if (on) {
    if (startWalkingEngine()) {
      if (win && !win.isDestroyed()) showWindow();
    } else {
      config.saveConfig({ walking: false }); // 非 Spine 模式：拒绝并回滚开关
      refreshTrayMenu();
      sendToRenderer("pet:toast", i18n.t(config.getConfig().uiLang || "zh", "tray.walkNeedSpine"));
    }
  } else {
    stopWalkingEngine();
  }
}
ipcMain.handle("pet:set-walking", (_e, on) => {
  const cfg = config.getConfig();
  if (on && cfg.renderMode !== "spine") {
    return { ok: false, message: i18n.t(cfg.uiLang || "zh", "tray.walkNeedSpine") };
  }
  setWalking(!!on);
  return { ok: true };
});
ipcMain.on("pet:walking-engine-stop", () => { // 运行时停走（不持久化）：2.5D 模式停引擎但保留用户行走意图，切回 Spine 由 syncWalkingEngine 恢复
  stopWalkingEngine();
});
ipcMain.on("pet:walking-pause", (_e, p, source) => {
  if (p) { cancelFlight(); cancelWalkJump(); walk.taskbarHang = false; } // 鼠标重新抓住时立即停止飞行/跳跃/半挂
  if (source === "zoom") { // 放大聊天框暂停：独立标志，60s 拖拽自愈不得解除（否则大窗口下恢复行走会打乱几何）
    walk.zoomPaused = !!p;
    walk.pausedAt = p ? Date.now() : 0;
  } else {
    walk.dragPaused = !!p;
    walk.pausedAt = p ? Date.now() : 0;
    // 人格化：被抓住/点按时偶尔嘀咕
    if (p) maybePersonify("grabbed", { chance: 0.2, cooldownMs: 90000 });
  }
  walk.paused = walk.dragPaused || walk.chatPaused || walk.zoomPaused; // 拖拽/对话/放大任一暂停都停住
  if (walk.active) walkBroadcast(); // 暂停/恢复即时同步渲染层动画（暂停时切站立待机）
  if (!p && walk.active && !walk.flight && !walk.jump) {
    // 松手/恢复：若之前处于坐窗流程中被拖走，就地转入「回到地面」下降流程
    if (walk.perched || walk.gotoPerch || walk.returning || walk.iconRest) {
      walk.perched = false;
      walk.iconRest = false;
      walk.iconTarget = false;
      walk.gotoPerch = false;
      walk.returning = true;
      walk.resting = false;
      walk.seated = false;
      walk.sunk = false;
      walk.targetX = null; // 水平保持当前 x，只垂直落地
      clearTimeout(walk.phaseTimer);
      walkBroadcast();
    }
    // 拖拽落点定格（松手时刻）：贴近任务栏/真实图标则吸附坐下，否则自由放置/恢复正常状态
    const sat = dragSeatUpdate(true);
    if (!sat && walk.freeStand && desktopIconMode()) { // 自由放置在桌面：原地站一会儿再回归正常循环
      clearTimeout(walk.phaseTimer);
      walkSchedulePhase(randInt(15000, 35000));
    }
  }
});
ipcMain.on("pet:throw", (_e, vx, vy) => {
  vx = Number(vx); vy = Number(vy);
  if (Number.isFinite(vx) && Number.isFinite(vy) && startFlight(vx, vy)) return;
  // 渲染层甩动后不再发送 walkingPause(false)；拒绝飞行时必须立即恢复，不能等 60 秒看门狗。
  if (walk.dragPaused) {
    walk.dragPaused = false;
    walk.paused = walk.chatPaused || walk.zoomPaused; // 对话/放大暂停不受拖拽恢复影响
    walk.pausedAt = 0;
    if (walk.active) walkBroadcast();
  }
});
ipcMain.on("pet:set-sleeping", (_e, v) => {
  walk.sleeping = !!v;
  if (walk.sleeping) { cancelFlight(); cancelWalkJump(); }
  // 人格化：入睡/睡醒时偶尔嘀咕
  if (v) maybePersonify("sleep", { chance: 0.25, cooldownMs: 180000 });
  else maybePersonify("wake", { chance: 0.35, cooldownMs: 60000 });
}); // 睡觉时行走引擎原地待命
ipcMain.on("pet:set-ground-gap", (_e, px) => {
  const v = Number(px);
  if (!Number.isFinite(v)) return;
  const next = Math.max(0, Math.min(80, Math.round(v)));
  if (next === walk.groundGap) return;
  walk.groundGap = next;
  if (!walk.paused && !walk.flight && !walk.jump && walk.seated) applySeatPosition();
});
ipcMain.on("pet:set-char-inset", (_e, px) => { // 渲染层上报：窗口左缘到角色左缘的距离（上限 200=正常贴左缘值；异常上报会把行走左边界扩到屏幕外导致“闪现”）
  const v = Number(px);
  if (Number.isFinite(v)) walk.charInset = Math.max(0, Math.min(200, Math.round(v)));
});
ipcMain.handle("pet:get-walk-timing", () => ({
  sitMaxSec: timingSec("sitMaxSec", 15, 180) || 30,
  walkMaxSec: timingSec("walkMaxSec", 8, 120) || 20
}));
ipcMain.handle("pet:set-walk-timing", (_e, patch) => {
  patch = patch || {};
  if (patch.sitMaxSec != null) {
    config.saveConfig({ walkTiming: { sitMaxSec: Math.max(15, Math.min(180, Math.round(Number(patch.sitMaxSec) || 30))) } });
  }
  if (patch.walkMaxSec != null) {
    config.saveConfig({ walkTiming: { walkMaxSec: Math.max(8, Math.min(120, Math.round(Number(patch.walkMaxSec) || 20))) } });
  }
  return {
    sitMaxSec: timingSec("sitMaxSec", 15, 180) || 30,
    walkMaxSec: timingSec("walkMaxSec", 8, 120) || 20
  };
});

/* ---------- 聊天外观（字号/字体/气泡宽度，设置页即时下发并广播渲染层） ---------- */
ipcMain.handle("pet:get-appearance", () => config.getConfig().appearance || {});
ipcMain.handle("pet:set-appearance", (_e, patch) => {
  patch = patch && typeof patch === "object" ? patch : {};
  config.saveConfig({ appearance: { ...(config.getConfig().appearance || {}), ...patch } });
  const a = config.getConfig().appearance || {};
  sendToRenderer("pet:appearance-changed", a);
  return a;
});
ipcMain.handle("pet:import-font", async () => { // 选本地字体文件→复制到 renderer/fonts/user/→记入配置
  if (!win || win.isDestroyed()) return null;
  const r = await dialog.showOpenDialog(win, {
    title: "选择字体文件",
    filters: [{ name: "字体文件", extensions: ["ttf", "otf", "woff", "woff2"] }],
    properties: ["openFile"]
  });
  if (!r.filePaths || !r.filePaths.length) return null;
  const name = path.basename(r.filePaths[0]);
  if (!/\.(ttf|otf|woff2?)$/i.test(name)) return null;
  const dir = config.STORAGE.fontsUser;
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(r.filePaths[0], path.join(dir, name));
  const prev = (config.getConfig().appearance || {}).customFonts || [];
  config.saveConfig({ appearance: { ...(config.getConfig().appearance || {}), customFonts: Array.from(new Set([...prev, name])) } });
  logTts("walk", "导入字体: " + name);
  return { customFonts: (config.getConfig().appearance || {}).customFonts || [] };
});

/** 皮肤目录 → 中文显示名（托盘菜单用；新皮肤目录名需手动加进这张表，缺了会回退到英文目录名） */
const SPINE_CN = {
  "002_amiya": "阿米娅",
  "002_amiya_epoque_4": "阿米娅·忒斯特收藏 II",
  "002_amiya_test_1": "阿米娅·忒斯特收藏 IV",
  "002_amiya_winter_1": "阿米娅·忒斯特收藏 I",
  "1001_amiya2_casc_1": "阿米娅·CASC",
  "1001_amiya2_sale_16": "阿米娅·忒斯特收藏 XVIII",
  "1037_amiya3": "阿米娅(升变)",
  "1037_amiya3_sale_13": "阿米娅(升变)·忒斯特收藏 XIV",
  "172_svrash": "银灰",
  "172_svrash_ambiencesynesthesia_4": "银灰·音律联觉 IV",
  "172_svrash_snow_1": "银灰·冰原信使 I",
  "172_svrash_summer_4": "银灰·珊瑚海岸 IV",
  "2015_dusk": "夕",
  "2015_dusk_nian_12": "夕·0011制造 XII",
  "2015_dusk_nian_7": "夕·0011制造 VI",
  "2025_shu": "黍",
  "2025_shu_nian_11": "黍·0011制造 XI",
  "254_vodfox": "巫恋",
  "254_vodfox_witch_2": "巫恋·巫异盛宴 II",
  "254_vodfox_yun_8": "巫恋·0011韵系列 VIII",
  "358_lisa": "铃兰",
  "358_lisa_epoque_22": "铃兰·时代 XXII",
  "358_lisa_lxh_1": "铃兰·罗小黑战记",
  "358_lisa_wild_3": "铃兰·生命之地 III",
  "391_rosmon": "迷迭香",
  "391_rosmon_epoque_17": "迷迭香·时代 XVII",
  "4042_lumen": "流明",
  "4042_lumen_ambiencesynesthesia_3": "流明·音律联觉 III",
  "4042_lumen_sanrio_2": "流明·三丽鸥家族 II",
  "4179_monstr": "Mon3tr",
  "4179_monstr_boc_11": "Mon3tr·斗争血脉 XI",
  "4235_thumpy": "珊比",
  "summer": "苏苏洛·夏卉",
  "winter": "苏苏洛·寒冬"
};

/** 扫描全部可用 Spine 皮肤：内置苏苏洛 + spine/user/ 下每个含 .atlas+.skel/.json 的模型（支持子文件夹分皮肤） */
function detectSpineModels() {
  const list = [{
    id: "builtin",
    name: "苏苏洛",
    atlas: "spine/sussurro/build_char_298_susuro.atlas",
    skel: "spine/sussurro/build_char_298_susuro.skel"
  }];
  const userDir = config.STORAGE.spineUser;
  const scan = (relDir) => {
    let entries = [];
    try { entries = fs.readdirSync(path.join(userDir, relDir), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory() && relDir === "") { scan(e.name); continue; }
      if (!e.isFile() || !e.name.toLowerCase().endsWith(".atlas")) continue;
      const base = e.name.slice(0, -".atlas".length);
      const skelName = ["skel", "json"].map((ext) => base + "." + ext)
        .find((n) => fs.existsSync(path.join(userDir, relDir, n)));
      if (!skelName) continue;
      const prefix = relDir ? relDir + "/" : "";
      list.push({
        id: prefix + base,
        name: SPINE_CN[relDir] || base.replace(/^(build_char_\d+_)/, "").replace(/_/g, " "),
        atlas: "pet-user://spine/user/" + prefix + e.name,
        skel: "pet-user://spine/user/" + prefix + skelName
      });
    }
  };
  scan("");
  return list;
}

/** v2.5.10 按皮肤窗口宽度：渲染层上报宽模型需要的窗口宽（如迷迭香第三皮肤），
 *  行走启动/坍缩恢复时用它替代默认 260，让宽模型角色有空间完整放大。 */

function setSpineSkin(id) {
  config.saveConfig({ spineSkinId: String(id || "") });
  // 选择皮肤即进入 Spine 渲染模式（GIF 模式下只换模型不换画面，会让人以为切换无效）
  if (config.getConfig().renderMode !== "spine") {
    config.saveConfig({ renderMode: "spine" });
    sendToRenderer("pet:render-mode-changed", "spine");
    syncWalkingEngine();
    logTts("walk", "选择新皮肤，已自动切换到 Spine 模式");
  }
  refreshTrayMenu();
  sendToRenderer("pet:spine-skin-changed", String(id || ""));
  logTts("walk", "切换小人皮肤: " + (id || "builtin"));
}

/** 皮肤三层菜单：人物 > 角色（形态） > 皮肤 */
const SKIN_PERSON_NAMES = {
  "298": { zh: "苏苏洛", en: "Sussurro", ja: "スズラン" },
  "002": { zh: "阿米娅", en: "Amiya", ja: "アーミヤ" },
  "1001": { zh: "阿米娅", en: "Amiya", ja: "アーミヤ" },
  "1037": { zh: "阿米娅", en: "Amiya", ja: "アーミヤ" },
  "172": { zh: "银灰", en: "SilverAsh", ja: "シルバーアッシュ" },
  "391": { zh: "迷迭香", en: "Rosmontis", ja: "ローズモンティス" },
  "4042": { zh: "流明", en: "Lumen", ja: "ルーメン" },
  "4235": { zh: "珊比", en: "Thumpy", ja: "タンピー" },
  "003": { zh: "凯尔希", en: "Kal'tsit", ja: "ケルシー" },
  "1052": { zh: "凯尔希", en: "Kal'tsit", ja: "ケルシー" },
  "254": { zh: "巫恋", en: "Shamare", ja: "シャマール" },
  "358": { zh: "铃兰", en: "Suzuran", ja: "スズラン" },
  "2015": { zh: "夕", en: "Dusk", ja: "ダスク" },
  "2025": { zh: "黍", en: "Shu", ja: "シュウ" },
  "4179": { zh: "Mon3tr", en: "Mon3tr", ja: "Mon3tr" }
};
const SKIN_CHAR_NAMES = { // 角色（形态）中文名；未收录的用目录代号
  "002_amiya": "本体",
  "1001_amiya2": "升变",
  "1037_amiya3": "异格形态",
  "003_kalts": "本体",
  "1052_kalts2": "Mon3tr 形象",
  "4179_monstr": "Mon3tr",
  "172_svrash": "本体",
  "391_rosmon": "本体",
  "4042_lumen": "本体",
  "4235_thumpy": "本体",
  "298_susuro": "本体",
  "254_vodfox": "本体",
  "358_lisa": "本体",
  "2015_dusk": "本体",
  "2025_shu": "本体"
};
function skinParseDir(dir) { // "002_amiya_epoque#4" → {num:"002", ch:"amiya", skin:"epoque#4"}
  const m = String(dir || "").match(/^(\d{3,4})_([a-z0-9]+)(?:_(.+))?$/i);
  return m ? { num: m[1], ch: m[2].toLowerCase(), skin: m[3] || "" } : null;
}
ipcMain.handle("pet:get-spine-models", () => ({ list: detectSpineModels(), current: config.getConfig().spineSkinId || "builtin" }));
ipcMain.handle("pet:set-spine-skin", (_e, id) => { setSpineSkin(id); return true; });
/* ---------- 桌面行走 结束 ---------- */

ipcMain.on("pet:hide", () => hideWindow());
ipcMain.on("pet:tts-playback", (_e, msg) => logTts("render", String(msg || "")));
ipcMain.on("pet:set-clickable", (_e, clickable) => {
  // 透明区域点击穿透：只有鼠标在 桌宠/气泡/输入栏 上时才接收鼠标事件，其余穿透给下层应用
  if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(!clickable, { forward: true });
});
ipcMain.on("pet:set-size", (_e, w, h) => {
  if (!win || win.isDestroyed()) return;
  const ws = Math.max(120, Math.min(1200, Math.round(w || 170)));
  const hs = Math.max(120, Math.min(900, Math.round(h || 260)));
  // resizable:false 时 setSize 缩小会被忽略（放大接近原值看不出），先临时允许缩放
  try { if (!win.isResizable()) win.setResizable(true); } catch { /* 忽略 */ }
  win.setSize(ws, hs);
  setTimeout(() => {
    try { win.setResizable(false); } catch { /* 忽略 */ }
    clampPetToWorkArea("窗口尺寸");
  }, 150);
});
ipcMain.handle("pet:tts-clone", (_e, text, opts) => {
  return tts.queueTts(text, opts);
});
tts.setPartSender((part) => sendToRenderer("pet:tts-part", part)); // v2.5.5 逐句流式推送
tts.setJaFallbackCb(() => sendToRenderer("pet:toast", "⚠️ 日语翻译失败，暂时用中文音色说话（请检查①聊天 API 的配额或 Key）"));


/* ---------- 本地 Genie (GPT-SoVITS) TTS（ttsGenie） ---------- */

/** 确保本地 Genie TTS 服务器在运行（最多等 ~240 秒模型加载）；返回是否可用 */

/** 调本地服务器合成克隆音色；返回 base64，失败返回空。
 *  引擎长时间运行后会劣化（输出极短碎片），检测到就自动重启服务再试一次。 */

/* ---------- 本地 GPT-SoVITS 日语 TTS（ttsGsv，配合 speakJa 日语模式） ---------- */

/** 确保 GPT-SoVITS 日语推理服务器在运行（端口 9880）；返回是否可用。
 *  启动预热与第一句话可能同时触发本函数：拉起进行中时后来者必须共用同一次等待，
 *  而不是各自探活误判「服务不可用」回退中文（曾导致引擎拉起窗口期的句子全部丢音色）。 */

/** 读取 WAV 时长（毫秒）；解析失败返回 -1 */

/** 调 GPT-SoVITS 服务器合成日语；返回 base64，失败返回空 */
/** 结束占用指定 TCP 端口的监听进程（兜底） */


/** 一键重启日语 TTS：杀旧进程→等端口释放→拉起→试合成验证；返回 {ok, code} 供界面本地化提示 */
ipcMain.handle("pet:restart-gsv", async () => {
  const g = config.getConfig().ttsGsv || {};
  if (!g.enabled || !g.python || !g.serverScript) return { ok: false, code: "disabled" };
  const gMiss = tts.missingEnginePath ? tts.missingEnginePath(g) : null; // §14 追加 94：路径不存在先明确提示
  if (gMiss) { logTts("gsv", "手动重启：路径不存在 " + gMiss); return { ok: false, code: "nopath" }; }
  const base = String(g.server || "").replace(/\/+$/, "");
  let port = 9880;
  try { port = Number(new URL(base).port) || 9880; } catch { /* 用默认端口 */ }
  logTts("gsv", "手动重启：停止旧服务...");
  await tts.killGsvProcesses(g);
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 800));
    if (!(await tts.portAlive(base))) break;
    if (i === 3) await tts.killPortListener(port); // 迟迟不退出则按端口兜底清理
  }
  logTts("gsv", "手动重启：重新拉起（模型加载约需 1~2 分钟）...");
  const up = await tts.ensureGsvServer(g);
  if (!up) { logTts("gsv", "手动重启：失败（服务未就绪）"); return { ok: false, code: "timeout" }; }
  const b64 = await tts.gsvTtsJa(g, "おはようございます");
  if (!b64) { logTts("gsv", "手动重启：失败（试合成无输出）"); return { ok: false, code: "synth" }; }
  logTts("gsv", "手动重启：成功");
  return { ok: true, code: "success" };
});

/** 清洗日语合成文本：GPT-SoVITS 对 ～ —— 引号 emoji 等符号处理不稳（易输出碎片），替换或剔除 */

/** 日语文本按句切分（保留标点），丢弃纯标点碎片（如单独的 … 或 」），最多 10 句 */

/** 裁掉 16bit PCM 段首尾的静音；尾部多留余量以保留句尾语调下降的自然衰减。
 *  GPT-SoVITS 每段输出首尾带 0.2~0.5s 纯静音，直接拼接会产生明显卡顿感，故先裁剪。 */

/** 把多段相同参数的 base64 WAV 拼接成单一 WAV：裁各段首部纯静音、保留句尾语调衰减（尾部 260ms），
 *  句间补 150~220ms 随机停顿——加上尾部余量后总停顿约 500ms，接近真人换句节奏 */

/* ---------- 云端语音合成助手 ---------- */



/* ---------- 开场白：从 persona 第 5 节提取 ---------- */
function openingLine(personaText) {
  const lines = (personaText || "").split(/\r?\n/);
  const idx = lines.findIndex((l) => /对话启动指令/.test(l));
  if (idx < 0) return "";
  const quotes = [];
  let collecting = false;
  for (const l of lines.slice(idx + 1)) {
    if (/^>\s*/.test(l)) {
      const content = l.replace(/^>\s*/, "").trim();
      if (content && (content.startsWith("（") || collecting)) { collecting = true; }
      if (collecting && content) quotes.push(content);
      if (content.includes("不许拒绝")) break;
    } else if (collecting) break;
  }
  return config.fillTokens(quotes.join("\n"));
}

/* ---------- 生命周期 ---------- */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) { win.show(); win.focus(); }
  });

  app.whenReady().then(() => {
    try {
      // 崩溃收集：minidump 存到 userData/crashes（不自动上传），便于排查渲染层 crashed
      const { crashReporter } = require("electron");
      crashReporter.start({
        productName: "SuzuranPet",
        companyName: "SuzuranPet",
        submitURL: "",
        uploadToServer: false,
        compress: true
      });
    } catch (e) { /* crashReporter 不可用不影响启动 */ }
    try {
      const secretInfo = config.initializeSecretStorage(safeStorage);
      logTts("security", "safeStorage=" + (secretInfo.chatApiKey?.available ? "available" : "unavailable") + " chat=" + (secretInfo.chatApiKey?.saved ? "saved" : "missing") + " cosy=" + (secretInfo.ttsCosyApiKey?.saved ? "saved" : "missing"));
    } catch (e) {
      logTts("security", "safeStorage 初始化失败（保留旧配置）: " + (e && e.message || e));
    }
    // v2.5.2 记忆加密（DPAPI/safeStorage）：防外部偷读明文 + 篡改检测（解密失败即视为被篡改，重置并提示）
    try {
      memory.init({
        encrypt: (s) => safeStorage.encryptString(s).toString("base64"),
        decrypt: (s) => safeStorage.decryptString(Buffer.from(s, "base64")),
      });
      memory.load();
      if (memory.wasTampered()) {
        const _err = memory.lastLoadError ? memory.lastLoadError() : "";
        const _had = memory.lastHadData ? memory.lastHadData() : false;
        logTts("security", "记忆文件异常" + (_had ? "（文件有内容但读取失败）" : "（首启空文件）") + "，已重置为空" + (_err ? " | 原因: " + _err : ""));
        if (_had) sendToRenderer("pet:toast", "⚠️ 记忆文件异常（可能被外部修改），已重置为空");
      }
      // §14 追加 102：向量记忆同款加密（只存经语义去重的对话片段，"上次她说…"级细节回引）
      require("./src/vector-memory").init({
        encrypt: (s) => safeStorage.encryptString(s).toString("base64"),
        decrypt: (s) => safeStorage.decryptString(Buffer.from(s, "base64")),
      });
    } catch (e) {
      logTts("security", "记忆加密初始化失败: " + (e && e.message || e));
    }
    personaCache = config.getPersonaText();
    registerUserAssetProtocol();
    logTts("memory", "v2.5.13 bond+羁绊 已加载"); // 启动标记：确认部署版 main.js 生效
    // 陪伴时间：首次启动记录
    try { if (!config.getConfig().firstRunAt) config.saveConfig({ firstRunAt: Date.now() }); } catch { /* 忽略 */ }
    // 允许渲染层访问麦克风（语音输入功能）
    const { session } = require("electron");
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === "media");
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      const isPetWindow = !!win && !win.isDestroyed() && webContents.id === win.webContents.id;
      callback(isPetWindow && permission === "media");
    });

    createWindow();
    createTray();
    schedules.initialize(sendScheduleDue);
    refreshPetName();
    screen.on("display-added", () => scheduleDisplayClamp("新增显示器"));
    screen.on("display-removed", () => scheduleDisplayClamp("移除显示器"));
    screen.on("display-metrics-changed", (_event, _display, changed) => {
      if (changed.includes("bounds") || changed.includes("workArea") || changed.includes("scaleFactor")) scheduleDisplayClamp("显示器参数变化");
    });
    refreshWinBarriers();
    clearInterval(barrierTimer);
    barrierTimer = setInterval(refreshWinBarriers, 3000);
    syncWalkingEngine(); // 配置了 Spine+行走时，启动即开始桌面行走
    if (config.getConfig().fileGuard) setFileGuard(true); // 蜜标监控（检测敏感配置区域被其他程序访问）
    runDllGuard(); // §14 追加 98：DLL 侧载自检（exe 目录 dll 基线对比，可疑即告警）

    // 预热本地 Genie TTS 服务器（后台加载模型，不阻塞开窗；声音关闭时不拉起）
    const _q = config.getConfig().ttsGenie || {};
    const _ttsOn = !!(config.getConfig().tts || {}).enabled;
    if (_q.enabled && _ttsOn) {
      tts.ensureGenieServer(_q).then((ok) => logTts("genie", "启动预热: " + (ok ? "已就绪" : "不可用")));
    } else {
      logTts("genie", "声音关闭，跳过服务器预热");
    }

    // GSV 日语引擎预启动：应用开启即后台拉起+预热，避免第一句话等几十秒冷启动
    const _gsv = config.getConfig().ttsGsv || {};
    if (_gsv.enabled && _ttsOn && _q.speakJa) {
      tts.ensureGsvServer(_gsv).then((up) => {
        if (up) return tts.warmupGsv(_gsv); // 内部自带"预热完成"日志
        logTts("gsv", "启动预热失败，首句将再尝试拉起");
        return false;
      }).catch(() => {});
    } else if (_gsv.enabled) {
      logTts("gsv", "日语模式/声音开关未全开，跳过引擎预热");
    }

    // 使用条款强制确认：未同意 → 弹条款窗口，桌宠/聊天/Agent 均不可用
    const _cfg = config.getConfig();
    if (!_cfg.agreed) {
      setTimeout(() => openTerms(), 600);
      sendToRenderer("pet:terms-pending");
    }

    // 本地 Agent 调用接口（其他 agent / 脚本可调用，仅 127.0.0.1）
    startAgentApi();

    // 主动搭话（v2.3 增强）：闲置后 35% 概率开口；设置页 proactiveChat 可单独关闭
    features.setProactiveEnabled(_cfg.proactiveChat !== false);
    const _proactiveMin = (_cfg.features && _cfg.features.proactiveMin) || 8;
    features.startProactive((msg) => {
      sendProactive(msg, "idle"); // 隐藏到托盘时静默待命，不主动搭话
    }, _proactiveMin);

    // 剪贴板感知（默认关，用户在设置里勾选后启用）
    if (_cfg.features && _cfg.features.clipboardWatch) {
      features.startClipboardWatch((msg) => {
        sendProactive(msg, "idle");
      }, 3000);
      logTts("features", "剪贴板感知已启动");
    }

    // 系统监控播报（默认关，用户在设置里勾选后启用）
    if (_cfg.features && _cfg.features.systemMonitor) {
      features.startSystemMonitor(
        () => features.getSystemStats(),
        (msg) => { sendProactive(msg, "think"); },
        15
      );
      logTts("features", "系统监控已启动");
    }

    // 首次启动：已同意条款且无 API Key 时自动打开设置引导
    if (_cfg.agreed && _cfg.firstRun) {
      config.saveConfig({ firstRun: false });
      if (!_cfg.chat.apiKey) {
        setTimeout(() => {
          openSettings();
          sendToRenderer("pet:toast", "首次使用：请在设置里填写 API Key 与称呼 💕");
        }, 1200);
      }
    }

    // 全局热键：任意窗口下隐藏/显示桌宠
    const { globalShortcut } = require("electron");
    const hotkey = config.getConfig().hotkey || "Alt+Shift+S";
    try {
      const ok = globalShortcut.register(hotkey, toggleWindow);
      console.log(`[SuzuranPet] 全局热键 ${hotkey}: ${ok ? "已注册" : "注册失败（可能被占用）"}`);
    } catch (e) {
      console.error("[SuzuranPet] 热键注册异常:", e.message);
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", (e) => {
    // 桌宠常驻托盘，不随窗口退出
    e.preventDefault?.();
  });

  app.on("before-quit", () => {
    quitting = true;
    schedules.stop();
    clearInterval(barrierTimer);
    barrierTimer = null;
    savePosSafe();
  });
}

const _startupCfg = config.getConfig();
console.log("[SuzuranPet] main ready, zcodeCli =", _startupCfg.zcodeCli || "未探测到");
try {
  const _c = _startupCfg.ttsCosy || {};
  const _e = _startupCfg.ttsCloud || {};
  logTts("startup", JSON.stringify({
    cosy: { enabled: !!_c.enabled, model: _c.model, voice: (_c.voice || "").slice(0, 24) + "...", keyLen: (_c.apiKey || "").length },
    edge: { enabled: !!_e.enabled, voice: _e.voice }
  }));
} catch { /* 无妨 */ }