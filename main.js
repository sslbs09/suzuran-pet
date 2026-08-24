/**
 * SuzuranPet 主进程
 * - 透明无边框置顶窗口（桌宠本体）
 * - 托盘菜单、窗口位置持久化
 * - IPC：聊天/任务路由、流式回传、停止、重载人设
 */
"use strict";

const { app, protocol, safeStorage, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage, screen, dialog, Notification } = require("electron");
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
let koffi = null;
try { koffi = require("koffi"); } catch (e) { console.warn("[SuzuranPet] koffi unavailable:", e && e.message || e); }

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
let agentApiAbort = null; // Agent 接口当前请求的中止控制器
let activeReq = null; // { id, abort }
let forcedMode = "auto"; // auto | chat | zcode
let personaCache = config.getPersonaText();
let quitting = false;
let renderCrashCount = 0;      // 渲染进程崩溃自动重载计数（60s 内连崩 3 次停止自愈）
let renderCrashWindowAt = 0;

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
    try {
      const b = win.getBounds();
      const wa = screen.getDisplayMatching(b).workArea;
      // 仅当窗口底部进入任务栏条带时临时置顶，避免坐姿被任务栏裁切。
      onTop = b.y + b.height > wa.y + wa.height - 2;
    } catch { onTop = true; }
  }
  if (!onTop && (walk.perched || walk.gotoPerch || walk.returning || walk.jump)) onTop = true;
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
  const wa = screen.getDisplayMatching(b).workArea;
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
    const wa = screen.getDisplayMatching(b).workArea;
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
    webPreferences: {
      preload: path.join(config.APP_DIR, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
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
    logTts("render", "渲染进程异常退出 reason=" + (d.reason || "?") +
      " exitCode=" + d.exitCode + " 第" + renderCrashCount + "次（60s内），自动重载");
    if (renderCrashCount > 3) { logTts("render", "渲染进程连续崩溃，停止自动重载（可手动重启桌宠）"); return; }
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

  // 启动时把窗口钳回屏幕工作区内（布局变宽后旧位置可能越界）
  clampPetToWorkArea("启动");

  // 位置持久化
  const savePos = () => {
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    const [x, y] = win.getPosition();
    // 屏幕外/异常位置不保存（被拖出屏幕后重启会恢复到屏幕外；跳过让下次启动钳回正常位置）
    try {
      const wa = screen.getDisplayMatching(win.getBounds()).workArea;
      if (y > wa.y + wa.height || y + 40 < wa.y) return;
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
  const modeLabel = !zcodeOn ? i18n.t(lang, "tray.modeChat")
    : forcedMode === "zcode" ? i18n.t(lang, "tray.modeZcode")
    : forcedMode === "chat" ? i18n.t(lang, "tray.modeChat") + i18n.t(lang, "tray.clickAutoSuffix")
    : i18n.t(lang, "tray.modeAuto");
  const ttsOn = !!(cfg.tts || {}).enabled;
  const rate = (cfg.tts || {}).rate || 0.9;
  const scale = clampScale((cfg.window || {}).scale);
  const speakJa = !!((cfg.ttsGenie || {}).speakJa);
  const walkingOn = !!cfg.walking && cfg.renderMode === "spine";
  const rateWord = rate <= 0.85 ? "tray.rateWordSlow" : rate <= 0.95 ? "tray.rateWordSlight" : rate >= 1.1 ? "tray.rateWordFast" : "tray.rateWordNormal";
  const sizeWord = scale <= 0.8 ? "tray.sizeWordSmall" : scale >= 1.6 ? "tray.sizeWordXLarge" : scale >= 1.2 ? "tray.sizeWordLarge" : "tray.sizeWordStandard";
  const items = [
    { label: isWindowVisible() ? i18n.t(lang, "tray.hidePet") : i18n.t(lang, "tray.showPet"), click: () => toggleWindow() },
    { type: "separator" },
    { label: modeLabel, enabled: false }
  ];
  if (zcodeOn) {
    items.push(
      { label: forcedMode === "auto" ? i18n.t(lang, "tray.forceChat") : forcedMode === "chat" ? i18n.t(lang, "tray.restoreAuto") : i18n.t(lang, "tray.switchChat"), click: () => setMode(forcedMode === "chat" ? "auto" : "chat") },
      { label: forcedMode === "auto" ? i18n.t(lang, "tray.forceZcode") : forcedMode === "zcode" ? i18n.t(lang, "tray.restoreAuto") : i18n.t(lang, "tray.switchTask"), click: () => setMode(forcedMode === "zcode" ? "auto" : "zcode") }
    );
  }
  items.push(
    { type: "separator" },
    { label: ttsOn ? i18n.t(lang, "tray.voiceOn") : i18n.t(lang, "tray.voiceOff"), click: () => setTts(!ttsOn) },
    { label: i18n.t(lang, "tray.rateLabel") + i18n.t(lang, rateWord), enabled: false },
    { label: i18n.t(lang, "tray.rateSlow"), type: "radio", checked: rate <= 0.85, click: () => setRate(0.85) },
    { label: i18n.t(lang, "tray.rateSlight"), type: "radio", checked: rate > 0.85 && rate <= 0.95, click: () => setRate(0.9) },
    { label: i18n.t(lang, "tray.rateNormal"), type: "radio", checked: rate > 0.95 && rate < 1.1, click: () => setRate(1.0) },
    { label: i18n.t(lang, "tray.rateFast"), type: "radio", checked: rate >= 1.1, click: () => setRate(1.1) },
    { label: speakJa ? i18n.t(lang, "tray.speakJaOn") : i18n.t(lang, "tray.speakJaOff"), click: () => setSpeakJa(!speakJa) },
    { label: walkingOn ? i18n.t(lang, "tray.walkOn") : i18n.t(lang, "tray.walkOff"), click: () => {
      const c = config.getConfig();
      if (!c.walking && c.renderMode !== "spine") {
        dialog.showMessageBox({
          type: "info",
          title: "SuzuranPet",
          message: i18n.t(lang, "tray.walkNeedSpine"),
          buttons: [i18n.t(lang, "common.ok", "OK")]
        }).catch(() => {});
        return;
      }
      setWalking(!c.walking);
    } },
    ...(() => { // 皮肤三层菜单：人物 > 角色（形态） > 皮肤
      const models = detectSpineModels();
      const persons = new Map(); // 人物编号 → Map(角色 → {name, items})
      for (const m of models) {
        let num, chKey, skin = "";
        const dir = String(m.id).split("/")[0];
        if (m.id === "builtin" || dir === "summer" || dir === "winter") {
          num = "298"; chKey = "298_susuro";
          if (dir === "summer") skin = "summer";
          if (dir === "winter") skin = "winter";
        } else {
          const p = skinParseDir(dir);
          if (!p) continue;
          num = p.num; chKey = p.num + "_" + p.ch; skin = p.skin;
        }
        if (!persons.has(num)) persons.set(num, new Map());
        const chars = persons.get(num);
        if (!chars.has(chKey)) {
          chars.set(chKey, { name: SKIN_CHAR_NAMES[chKey] || chKey.split("_").slice(1).join("_"), items: [] });
        }
        chars.get(chKey).items.push({
          label: (() => { // 皮肤名：优先取 SPINE_CN 全名「人物·皮肤」里「·」后的部分；summer/winter 同理
            const cn = SPINE_CN[dir];
            if (skin && cn && cn.includes("·")) return cn.split("·").slice(1).join("·");
            return skin ? skin.replace(/_/g, " ") : "默认";
          })(),
          type: "radio",
          checked: (cfg.spineSkinId || "builtin") === m.id,
          click: () => setSpineSkin(m.id)
        });
      }
      const order = ["298", "002", "1001", "1037", "172", "391", "4042", "4235", "003", "1052", "254", "358", "2015", "2025"];
      const nums = [...persons.keys()].sort((a, b) => {
        const ia = order.indexOf(a), ib = order.indexOf(b);
        return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || a.localeCompare(b);
      });
      return [{
        label: i18n.t(lang, "tray.personLabel"),
        submenu: nums.map((num) => ({
          label: (SKIN_PERSON_NAMES[num] || {})[lang] || num,
          submenu: [...persons.get(num).entries()].map(([chKey, ch]) => ({
            label: ch.name,
            submenu: ch.items
          }))
        }))
      }];
    })(),
    { label: i18n.t(lang, "tray.animDemoLabel"),
      enabled: cfg.renderMode === "spine",
      submenu: ["Relax", "Move", "Sit", "Sleep", "Interact"].map((a) => ({
        label: a, click: () => sendToRenderer("pet:play-anim", a)
      }))
    },
    { label: i18n.t(lang, "tray.layerLabel"),
      submenu: [
        { label: i18n.t(lang, "tray.layerTop"), type: "radio", checked: (cfg.layer || "top") !== "desktop", click: () => setPetLayer("top") },
        { label: i18n.t(lang, "tray.layerDesktop"), type: "radio", checked: cfg.layer === "desktop", click: () => setPetLayer("desktop") }
      ]
    },
    { label: "🌗 半透明模式", type: "checkbox", checked: !!cfg.dimMode, click: () => setDimMode(!cfg.dimMode) },
    { label: i18n.t(lang, "tray.sitTaskbar"), click: () => sitOnTaskbar() },
    { label: i18n.t(lang, "tray.sizeLabel") + i18n.t(lang, sizeWord), enabled: false },
    { label: i18n.t(lang, "tray.sizeSmall"), type: "radio", checked: scale <= 0.8, click: () => setScale(0.75) },
    { label: i18n.t(lang, "tray.sizeStandard"), type: "radio", checked: scale > 0.8 && scale < 1.2, click: () => setScale(1.0) },
    { label: i18n.t(lang, "tray.sizeLarge"), type: "radio", checked: scale >= 1.2 && scale < 1.6, click: () => setScale(1.25) },
    { label: i18n.t(lang, "tray.sizeXLarge"), type: "radio", checked: scale >= 1.6, click: () => setScale(1.5) },
    { label: "🚶 散步速度", submenu: [
      { label: "🐢 慢速", type: "radio", checked: (cfg.walkSpeedMul || 1) <= 0.8, click: () => setWalkSpeed(0.6) },
      { label: "🚶 标准", type: "radio", checked: !cfg.walkSpeedMul || ((cfg.walkSpeedMul > 0.8) && (cfg.walkSpeedMul < 1.4)), click: () => setWalkSpeed(1) },
      { label: "🏃 快速", type: "radio", checked: cfg.walkSpeedMul >= 1.4 && cfg.walkSpeedMul < 2.2, click: () => setWalkSpeed(1.6) },
      { label: "⚡ 飞快", type: "radio", checked: cfg.walkSpeedMul >= 2.2, click: () => setWalkSpeed(2.5) }
    ]},
    { type: "separator" },
    { label: "📅 日程安排", click: () => openSchedule() },
    { label: i18n.t(lang, "tray.settings"), click: () => openSettings() },
    { label: i18n.t(lang, "tray.moodManager"), click: () => openMoodManager() },
    { label: i18n.t(lang, "tray.voiceStudio"), click: () => openVoiceStudio() },
    { label: i18n.t(lang, "tray.ttsGuide"), click: () => openTtsGuide() },
    { label: i18n.t(lang, "tray.reloadPersona"), click: () => { personaCache = config.getPersonaText(); sendToRenderer("pet:toast", i18n.t(lang, "tray.personaReloaded")); } },
    { label: i18n.t(lang, "tray.quickstart"), click: () => openQuickstart() },
    { label: i18n.t(lang, "tray.help"), click: () => openHelp() },
    { label: i18n.t(lang, "tray.openConfig"), click: () => shell.openPath(config.CONFIG_PATH) },
    { label: i18n.t(lang, "tray.openPersona"), click: () => shell.openPath(config.PERSONA_PATH) },
    { type: "separator" },
    { label: i18n.t(lang, "tray.exit"), click: () => { quitting = true; savePosSafe(); app.quit(); } }
  );
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
    webPreferences: {
      preload: path.join(config.APP_DIR, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  quickstartWin.setMenuBarVisibility(false);
  quickstartWin.loadFile(path.join(config.APP_DIR, "renderer", "quickstart.html"));
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
      genieServerChecked = false;
      genieServerUp = false;
      ensureGenieServer(q).then((ok) => logTts("genie", "语音开启 → 服务器: " + (ok ? "已就绪" : "不可用")));
    }
  } else {
    // 语音关 → 停掉本地 TTS 服务器，释放显存
    shutdownGenieServer();
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

function shutdownGenieServer() {
  genieServerChecked = false;
  genieServerUp = false;
  try {
    // 注意：服务器跑在 pythonw.exe（无控制台），必须匹配 python% 而非 python.exe
    const ps = spawn("powershell", ["-NoProfile", "-Command",
      "Get-CimInstance Win32_Process -Filter \"Name like 'python%'\" | Where-Object { $_.CommandLine -like '*genie_tts_server*' } | ForEach-Object { & taskkill /PID $_.ProcessId /T /F 2>&1 | Out-Null }"],
      { windowsHide: true });
    ps.on("error", () => {});
    logTts("genie", "语音关闭 → 停止本地服务器");
  } catch { /* 忽略 */ }
}

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
    webPreferences: {
      preload: path.join(config.APP_DIR, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  settingsWin.setMenuBarVisibility(false);
  settingsWin.loadFile(path.join(config.APP_DIR, "renderer", "settings.html"));
  settingsWin.on("closed", () => { settingsWin = null; });
}

function openSchedule() {
  if (scheduleWin && !scheduleWin.isDestroyed()) { scheduleWin.focus(); return; }
  scheduleWin = new BrowserWindow({ width: 820, height: 700, minWidth: 620, minHeight: 520, resizable: true, title: "苏苏洛 · 日程安排", autoHideMenuBar: true,
    webPreferences: { preload: path.join(config.APP_DIR, "preload.js"), contextIsolation: true, nodeIntegration: false } });
  scheduleWin.setMenuBarVisibility(false);
  scheduleWin.loadFile(path.join(config.APP_DIR, "renderer", "schedule.html"));
  scheduleWin.on("closed", () => { scheduleWin = null; });
}

/* ---------- 表情管理（换装，动态情绪表） ---------- */
const SPRITE_USER_DIR = config.STORAGE.spritesUser;
const SPRITE_DEFAULT_DIR = config.STORAGE.spritesDefault;

/** 情绪表来自 config.json（moods），支持自定义增删 */
function getMoodList() {
  const cfg = config.getConfig();
  return Array.isArray(cfg.moods) && cfg.moods.length ? cfg.moods : [];
}

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
    webPreferences: {
      preload: path.join(config.APP_DIR, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  moodWin.setMenuBarVisibility(false);
  moodWin.loadFile(path.join(config.APP_DIR, "renderer", "moods.html"));
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
    console.error("[SuzuranPet] 备份表情失败:", e.message);
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
    webPreferences: {
      preload: path.join(config.APP_DIR, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  termsWin.setMenuBarVisibility(false);
  termsWin.loadFile(path.join(config.APP_DIR, "renderer", "terms.html"));
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
function clampScale(s) {
  return Math.max(0.6, Math.min(2.0, parseFloat(s) || 1.0));
}

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
      const wa = screen.getDisplayMatching(win.getBounds()).workArea;
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
        send(200, { ok: true, name: (cfg.pet || {}).name || "苏苏洛", agreed: !!cfg.agreed, invokeWord: apiCfg.invokeWord || "", authRequired: !!token });
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
      try {
        const r = await chatClient.chat({ persona: personaCache || config.getPersonaText(), history: history.recent("chat", cfg.chat.maxHistoryTurns || 10), text, signal: abort.signal, onChunk: () => {} });
        history.append({ ts: Date.now(), mode: "chat", role: "user", content: text });
        history.append({ ts: Date.now(), mode: "chat", role: "assistant", content: r.text });
        send(200, { ok: true, reply: r.text, emotion: r.emotion || "" });
      } finally {
        if (agentApiAbort === abort) agentApiAbort = null;
      }
    } catch (e) {
      send(500, { ok: false, error: String(e.message || e) });
    }
  });
  server.on("error", (e) => console.error("[SuzuranPet] Agent 接口启动失败:", e.message));
  server.listen(port, "127.0.0.1", () => console.log("[SuzuranPet] Agent 接口已启动 http://127.0.0.1:" + port));
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
    webPreferences: {
      preload: path.join(config.APP_DIR, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  voiceWin.setMenuBarVisibility(false);
  voiceWin.loadFile(path.join(config.APP_DIR, "renderer", "voice.html"));
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
    const up = await ensureGenieServer(g);
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

ipcMain.handle("pet:tts-preview", async (_e, { text, refAudio, refText }) => {
  // 用「指定参考音频」合成一段试听（不修改已应用音色）
  try {
    const cfg = config.getConfig();
    const g = cfg.ttsGenie || {};
    if (!g.python || !g.serverScript) return { ok: false, message: "未部署 Genie 语音" };
    const up = await ensureGenieServer(g);
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

/* ---------- 对话核心 ---------- */
/** 对话期间暂停散步（busy 时渲染层不切 Move 动画，若窗口仍移动会出现“坐着滑行”）：
 *  进入对话暂停、结束（done/error/中止/快捷回复）统一在 finally 恢复。 */
function chatPauseWalk(p) {
  if (!walk.active) return;
  walk.chatPaused = !!p;
  if (p) { cancelFlight(); cancelWalkJump(); walk.taskbarHang = false; }
  walk.paused = walk.dragPaused || walk.chatPaused;
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
    sender.send("pet:error", { id, message: "上一句还没说完哦，先让我把话讲完？(可以先点停止)" });
    return;
  }
  const clean = (text || "").trim();
  if (!clean) return;

  // 标记用户活跃（重置主动搭话计时）
  features.touchChat();

  // === 日程提醒检测 ===
  if (/提醒|记得|别忘/.test(clean)) {
    const at = features.parseTime(clean);
    const reminderText = features.extractReminder(clean);
    if (at && reminderText) {
      const ok = features.setReminder(reminderText, at, (msg) => {
        sendProactive(msg, "happy", { force: true });
      });
      if (ok) {
        const timeStr = new Date(at).toLocaleString("zh-CN", { hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" });
        sender.send("pet:done", { id, mode: "chat", full: `好的博士，我已经记住了！${timeStr}会提醒你：${reminderText} ⏰`, emotion: "happy" });
        return;
      }
    }
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
  activeReq = { id, abort, cancelled: false };
  const isCurrent = () => activeReq && activeReq.id === id && !activeReq.cancelled;
  history.append({ ts: Date.now(), mode, role: "user", content: clean });

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
      const persona = personaCache || config.getPersonaText();
      const r = await chatClient.chat({
        persona,
        history: history.recent("chat", config.getConfig().chat.maxHistoryTurns || 20),
        text: clean,
        signal: abort.signal,
        onChunk: (d) => { if (isCurrent()) sender.send("pet:chunk", { id, mode, text: d }); }
      });
      full = r.text;
      emotion = r.emotion || ""; // 模型选的情绪词（≤5字，已在 chat-client 里校验过词表）
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
  if (activeReq) {
    activeReq.cancelled = true;
    activeReq.abort.abort();
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
    ttsCloud: { enabled: !!(cfg.ttsCloud?.enabled || cfg.ttsCosy?.enabled || cfg.ttsGenie?.enabled) },
    winSize: { width: cfg.window.width || 260, height: cfg.window.height || 200 },
    hasUserSprite: fs.existsSync(path.join(config.STORAGE.spritesUser, "sprite.png")),
    renderMode: cfg.renderMode === "spine" ? "spine" : "gif",
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
  try {
    if (!audioB64 || audioB64.length < 100) return { ok: false, text: "", error: "音频过短" };
    const tmpPath = path.join(require("os").tmpdir(), `pet_voice_${Date.now()}.webm`);
    fs.writeFileSync(tmpPath, Buffer.from(audioB64, "base64"));
    const result = await features.speechToText(tmpPath, lang || "ja");
    try { fs.unlinkSync(tmpPath); } catch { /* 忽略 */ }
    return result;
  } catch (e) {
    return { ok: false, text: "", error: String(e.message || e) };
  }
});

// 日程提醒（持久化 schedule 引擎）
ipcMain.handle("pet:get-schedules", () => schedules.list());
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
ipcMain.handle("pet:import-schedule-workbook", (_e, filePath) => {
  try {
    if (!filePath || path.extname(filePath).toLowerCase() !== ".xlsx" || !fs.existsSync(filePath) || fs.statSync(filePath).size > 5 * 1024 * 1024) throw new Error("Excel 文件无效或超过 5MB");
    const wb = XLSX.readFile(filePath, { cellFormula: false, cellHTML: false, cellText: true });
    if (wb.SheetNames.length !== 1) throw new Error("Excel 必须只包含一个工作表");
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "", raw: false });
    if (!rows.length || rows.length > 500) throw new Error("Excel 需包含 1~500 条日程");
    const items = rows.map((r, i) => ({ title: r.title, date: r.date, time: r.time, recurrence: r.recurrence || "none", enabled: r.enabled, emotion: r.emotion || "happy", notes: r.notes || "", externalId: r.externalId || `xlsx-${i + 2}` }));
    const saved = items.map((item) => schedules.add(item, { type: "xlsx", fileName: path.basename(filePath), row: items.indexOf(item) + 2 }));
    return { ok: true, count: saved.length };
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
  const wa = screen.getDisplayMatching(b).workArea;
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
const walk = {
  active: false,    // 引擎运行中（配置开关 + spine 模式才为 true）
  paused: false,    // 当前是否暂停（= dragPaused || chatPaused）
  dragPaused: false, // 拖拽暂停（来源1：mousedown/松开）
  chatPaused: false, // 用户对话期间暂停（来源2：避免 busy 时动画不切 Move，Sit 被窗口带着滑行）
  sleeping: false,  // 渲染层睡觉状态：原地待命不移动
  face: 1,          // 视觉朝向：+1 右 / -1 左（按实际水平位移计算）
  resting: true,    // true=原地不动（地面 Relax / 窗顶 Sit） false=走动（Move）
  perched: false,   // 正坐在窗口顶上
  iconRest: false,  // 正站在桌面图标上（Rest 待机，非 Sit）
  seated: false,    // 坐下（任务栏上沿/桌面图标顶）：Sit 动画不移动
  groundGap: 0,     // 角色脚底到窗口底边的空隙（渲染层上报）：贴地定位时窗口下探补偿
  charInset: 0,     // 窗口左缘到角色左缘的距离（渲染层上报）：行走左边界按此放宽，角色能贴到屏幕左缘
  edgeLeft: false,  // 当前是否探出屏幕左侧（气泡需切到头顶模式）
  sunk: false,      // 当前是否处于坐姿下沉状态
  gotoPerch: false, // 正走向/爬向窗口顶
  iconTarget: false,// 本次跳的目标是桌面图标（决定跳上后站或坐）
  freeStand: false, // 桌面层级下被自由放置在桌面上（站姿待命，不被相位机拉回任务栏）
  pausedAt: 0,      // 进入拖拽暂停的时刻（用于 mouseup 丢失自愈）
  returning: false, // 坐完正回到地面
  flight: null,    // 拖拽抛掷中的短生命周期物理状态
  jump: null,      // 缓动跳窗状态
  perchBarrier: null, // 当前驻留的窗口屏障快照
  taskbarHang: false, // 用户拖拽到任务栏带内的半挂状态
  dir: 1,           // 漫游方向
  targetX: null,
  perchTopY: 0,
  timer: null,
  phaseTimer: null
};
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
const randInt = (a, b) => Math.floor(a + Math.random() * (b - a + 1));

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
function easeOutCubic(t) {
  const n = Math.max(0, Math.min(1, t));
  return 1 - Math.pow(1 - n, 3);
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
  walk.paused = false;
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
  const wa = screen.getDisplayMatching(b).workArea;
  const minX = walkMinX(wa);
  const maxX = Math.max(minX, wa.x + wa.width - b.width);
  const groundY = Math.max(wa.y, wa.y + wa.height - b.height) + walk.groundGap;
  const barrier = barrierFloorFor(b, b.x, wa);
  const floorY = barrier ? barrier.top + walk.groundGap - b.height : groundY;

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
  const landingBarrier = barrierFloorFor(b, nx, wa);
  const landingFloorY = landingBarrier ? landingBarrier.top + walk.groundGap - b.height : groundY;
  if (ny < landingFloorY) {
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
  return true;
}

/** 相位切换：走↔停↔坐窗循环；休息结束时 35% 概率尝试跳上桌面程序窗口 */

/* ---------- 坐姿下沉量分档 ----------
 * 小尺寸（≤80%）窗口矮、腿短，固定下沉会陷得过深；冬季皮肤大尺寸单独一档；
 * 其余档位（含普通大/特大）统一用标准值。设置页滑杆可按档位覆盖，存 config.walkSeatSink。 */
const SEAT_SINK_DEFAULTS = { small: 22, standard: 30, winterLarge: 30 };
function seatSinkTier() {
  const cfg = config.getConfig();
  const scale = clampScale((cfg.window || {}).scale);
  if (/winter/i.test(String(cfg.spineSkinId || "")) && scale >= 1.2 && scale < 1.6) return "winterLarge";
  if (scale <= 0.8) return "small";
  return "standard";
}
function getSeatSink() {
  const t = seatSinkTier();
  const v = Number((config.getConfig().walkSeatSink || {})[t]);
  return Number.isFinite(v) && v >= 0 ? Math.round(v) : SEAT_SINK_DEFAULTS[t];
}

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
function clampWalkX(x, wa, width) {
  const rawMax = wa.x + wa.width - width;
  const inset = Math.max(0, Math.min(Number(walk.charInset) || 0, Math.max(0, width - 1)));
  const minX = wa.x - inset;
  const maxX = Math.max(minX, rawMax);
  const value = Math.min(Math.max(Number(x), minX), maxX);
  return { x: value, minX, maxX, rawMax, inset, collapsed: rawMax < minX };
}
function walkMinX(wa) {
  return wa.x - Math.max(0, Math.min(Number(walk.charInset) || 0, 399));
}
function setEdgeLeft(v) {
  v = !!v;
  if (walk.edgeLeft === v) return;
  // 气泡翻边：角色条带从窗口右缘切到左缘（或反向），同步平移窗口保持角色屏幕位置不变
  // （条带位移 = 窗口宽-124；配合渲染层 body.edge-left 的 .pet left:2）
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
const SIT_MIN_MS = 10000, WALK_MIN_MS = 8000; // 相位保底时长
function sitPhaseMs() {   // 单次坐下：10s ~ 设置上限（默认30s）
  const cap = (timingSec("sitMaxSec", 15, 180) || 30) * 1000;
  return randInt(SIT_MIN_MS, Math.max(SIT_MIN_MS, cap));
}
function walkPhaseMs() {  // 单次散步：8s ~ 设置上限（默认20s）
  const cap = (timingSec("walkMaxSec", 8, 120) || 20) * 1000;
  return randInt(WALK_MIN_MS, Math.max(WALK_MIN_MS, cap));
}

/** 坐姿定位（绝对）：按当前 seated 状态把窗口摆到正确高度——
 *  站=脚踩任务栏上沿；坐=下沉 seatSink 腿垂进任务栏。幂等自愈，
 *  任何中间位移（拖拽/重启钳制）都会在下一次调用时纠正。仅 Spine 模式。 */
function applySeatPosition() {
  if (!win || win.isDestroyed() || config.getConfig().renderMode !== "spine") return;
  const b = win.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  const baseY = wa.y + wa.height + walk.groundGap - b.height;   // 站立贴地
  const targetY = walk.seated ? baseY + getSeatSink() : baseY;  // 坐姿下沉（按尺寸档位）
  walk.sunk = walk.seated;
  if (Math.abs(b.y - targetY) > 1) win.setPosition(b.x, Math.round(targetY));
  applyLayer(walk.seated || walk.active); // 接触任务栏表面时保证在任务栏之上
}

function chooseWalkBehavior() {
  const defaults = { idle: 0.45, walk: 0.40, perch: 0.15 };
  const weights = defaults;
  const total = weights.idle + weights.walk + weights.perch;
  if (!(total > 0)) return "walk";
  const r = Math.random() * total;
  if (r < weights.idle) return "idle";
  if (r < weights.idle + weights.walk) return "walk";
  return "perch";
}

async function walkOnPhaseEnd() {
  if (!walk.active) return;
  if (walk.paused) {                        // 拖拽中冻结一切相位动作（防 applySeatPosition 把窗口弹回任务栏）
    walkSchedulePhase(randInt(3000, 6000));
    return;
  }
  if (walk.sleeping) { walkSchedulePhase(randInt(10000, 20000)); return; } // 睡觉中不切换相位
  if (walk.perched || walk.iconRest) {      // 图标/窗顶待够 → 回到地面
    walk.iconRest = false;
    walk.perched = false;
    walk.returning = true;
    walk.resting = false;
    walk.seated = false;
    walk.sunk = false;
    walkBroadcast();
    return;                                 // walkTick 完成下降后再排下一相位
  }
  if (walk.resting && !walk.seated) {       // 拖拽吸附久坐（保持到被拖走/到期回归循环）
    if (walk.freeStand) {
      walk.freeStand = false;               // 桌面自由放置到期 → 继续往下走正常决策（散步/跳图标）
    } else {
      walkSchedulePhase(randInt(8000, 15000));
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
    if (f !== walk.face) { walk.face = f; walkBroadcast(); }
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
    const wa = screen.getDisplayMatching(b).workArea;
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
      const wa = screen.getDisplayMatching(b).workArea;
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

function walkTick() {
  if (!win || win.isDestroyed()) return;
  // 左缘翻边判定（坐下/静止在左缘也要切；拖拽/飞行/跳跃中不切防干扰）
  // 用「角色条带左缘」判断而非窗口 x：切边/切回时窗口被平移 ±276，用窗口 x 会立即再次触发形成左右横跳
  if (!walk.paused && !walk.sleeping && !walk.flight && !walk.jump) {
    try {
      const eb = win.getBounds();
      const ewa = screen.getDisplayMatching(eb).workArea;
      // 垂直兜底：窗口底超出工作区（被拖出屏幕/掉出屏幕）→ 钳回地面线
      const groundY = Math.max(ewa.y, ewa.y + ewa.height - eb.height) + (walk.groundGap || 0);
      if (eb.y > groundY + 120) {
        if (Date.now() - (walk._vLog || 0) > 10000) { walk._vLog = Date.now(); logTts("walk", `垂直出屏钳回: y=${eb.y}→${Math.round(groundY)}`); }
        win.setPosition(eb.x, Math.round(groundY));
        if (walk.seated) applySeatPosition(); // 应坐姿时再校正下沉
      }
      const inset = walk.edgeLeft ? 2 : (Number(walk.charInset) || 0);
      let charLeft = eb.x + inset;
      // 出屏兜底：角色条带左缘 < 屏幕左缘 → 钳回贴边（崩溃/状态错乱后角色滑出屏幕）
      if (charLeft < ewa.x) {
        const fixX = ewa.x - inset;
        if (Date.now() - (walk._dbgAt || 0) > 10000) { walk._dbgAt = Date.now(); logTts("walk", `出屏钳回: x=${eb.x}→${fixX} edgeLeft=${walk.edgeLeft} inset=${inset}`); }
        win.setPosition(Math.round(fixX), eb.y);
        charLeft = ewa.x;
      }
      if (walk.edgeLeft) { if (charLeft > ewa.x + 80) setEdgeLeft(false); }
      else if (charLeft <= ewa.x + 2) setEdgeLeft(true);
    } catch { /* 忽略 */ }
  }
  // 自愈①：拖拽 mouseup 丢失导致 paused 卡死——60s 无移动事件自动解除（对话暂停不受此影响）
  if (walk.paused && walk.pausedAt && !walk.chatPaused && Date.now() - walk.pausedAt > 60000 && Date.now() - (dbgLastMoveTs || 0) > 5000) {
    walk.paused = false;
    walk.pausedAt = 0;
    walkBroadcast(); // 自愈解除暂停，同步渲染层动画
    logTts("walk", "拖拽暂停超时，自动恢复");
  }
  if (walkFlightTick()) return;
  if (walk.jump) {
    const j = walk.jump;
    const p = easeOutCubic((Date.now() - j.started) / j.duration);
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
      if (onIcon && Math.random() < 0.45) {
        walk.iconRest = true;
        walk.resting = true;
      } else {
        walk.perched = true;
        walk.resting = true;
      }
      if (walk.perched && onIcon) walkSetPosition(j.tx, walk.perchTopY + getSeatSink(), "jump-perch-sink");
      walkBroadcast();
      applyLayer();
      walkSchedulePhase(sitPhaseMs());
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
    logTts("walk", "相位定时器丢失，自动恢复"); // TODO 心跳诊断期保留
    walkSchedulePhase(randInt(3000, 8000));
  }
  const b = win.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  const xRange = clampWalkX(b.x, wa, b.width);
  const minX = xRange.minX;
  const maxX = xRange.maxX;
  const groundY = Math.max(wa.y, wa.y + wa.height - b.height) + walk.groundGap;
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

  /* —— 地面状态 —— */
  if (walk.resting || walk.sleeping) return;        // 放松/睡觉：站着不动

  walkUpdateFace(walk.dir);                         // 朝向跟随实际位移方向
  let nx = x + walk.dir * walkSpeed();
  if (nx <= minX || nx >= maxX) {                   // 到屏幕边折返（左侧已按角色条带补偿）
    walk.dir *= -1;
    nx = Math.min(Math.max(nx, minX), maxX);
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
    const wa0 = screen.getDisplayMatching(b0).workArea;
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
ipcMain.on("pet:walking-pause", (_e, p) => {
  if (p) { cancelFlight(); cancelWalkJump(); walk.taskbarHang = false; } // 鼠标重新抓住时立即停止飞行/跳跃/半挂
  walk.dragPaused = !!p;
  walk.pausedAt = p ? Date.now() : 0;
  walk.paused = walk.dragPaused || walk.chatPaused; // 拖拽/对话任一暂停都停住
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
    walk.paused = walk.chatPaused; // 对话暂停不受拖拽恢复影响
    walk.pausedAt = 0;
    if (walk.active) walkBroadcast();
  }
});
ipcMain.on("pet:set-sleeping", (_e, v) => {
  walk.sleeping = !!v;
  if (walk.sleeping) { cancelFlight(); cancelWalkJump(); }
}); // 睡觉时行走引擎原地待命
ipcMain.on("pet:set-ground-gap", (_e, px) => {
  const v = Number(px);
  if (!Number.isFinite(v)) return;
  const next = Math.max(0, Math.min(80, Math.round(v)));
  if (next === walk.groundGap) return;
  walk.groundGap = next;
  if (!walk.paused && !walk.flight && !walk.jump && walk.seated) applySeatPosition();
});
ipcMain.on("pet:set-char-inset", (_e, px) => { // 渲染层上报：窗口左缘到角色左缘的距离
  const v = Number(px);
  if (Number.isFinite(v)) walk.charInset = Math.max(0, Math.min(400, Math.round(v)));
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
  "391_rosmon_sale_16": "迷迭香·忒斯特收藏 XVIII",
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
  win.setSize(ws, hs);
  setTimeout(() => clampPetToWorkArea("窗口尺寸"), 120);
});
let ttsQueue = Promise.resolve(); // 合成串行队列：GSV/Genie 单模型串行处理，并发施压是毛刺诱因之一
const gsvBreaker = { failures: 0, openedAt: 0, cooldownMs: 60000 };
function gsvAvailableNow() {
  if (!gsvBreaker.openedAt) return true;
  if (Date.now() - gsvBreaker.openedAt >= gsvBreaker.cooldownMs) {
    logTts("gsv", "冷却结束，允许一次恢复探测");
    gsvBreaker.openedAt = 0;
    return true;
  }
  return false;
}
function recordGsvResult(ok) {
  if (ok) { gsvBreaker.failures = 0; return; }
  gsvBreaker.failures += 1;
  if (gsvBreaker.failures >= 2) {
    gsvBreaker.openedAt = Date.now();
    logTts("gsv", "连续失败 " + gsvBreaker.failures + " 次，进入 60 秒冷却并回退中文语音");
  }
}
ipcMain.handle("pet:tts-clone", (_e, text) => {
  const task = ttsQueue.then(() => ttsCloneImpl(text));
  ttsQueue = task.then(() => {}, () => {}); // 单次失败不中断后续排队
  return task;
});

async function ttsCloneImpl(text) {
  // 语音链路：本地 Genie（ttsGenie，主，克隆音色）→ 百炼 CosyVoice（ttsCosy，默认停用）→ edge-tts（ttsCloud）→ 空（渲染层回退系统语音）
  try {
    const dumpWav = (b64) => { // 调试转储：保存最终交付的音频，便于排查播放端问题
      try {
        fs.mkdirSync(config.STORAGE.audio, { recursive: true });
        fs.writeFileSync(path.join(config.STORAGE.audio, "tts_last.wav"), Buffer.from(b64, "base64"));
      } catch { /* 转储失败不影响主流程 */ }
    };
    const cfg = config.getConfig();
    const clean = String(text || "").slice(0, 200);
    // 游戏习惯称呼：中文朗读用“刀客塔”；日语翻译仍用原文“博士”（让翻译器输出ドクター）
    const cleanZh = clean.replace(/博士/g, "刀客塔");
    const q = cfg.ttsGenie || {};
    // 日语语音模式（speakJa）：先把中文翻译成日语，再用 GPT-SoVITS（ttsGsv）日语微调音色说话；文字/聊天保持中文
    let ttsText = cleanZh;
    let jaText = "";
    if (q.speakJa) {
      const ja = await translateToJa(clean);
      if (ja) { jaText = ja; ttsText = ja; logTts("ja", "翻译: " + clean + " → " + ja); }
      else logTts("ja", "翻译失败，退回中文合成");
    }
    if (jaText) {
      // 日语模式：优先本地 GPT-SoVITS 日语合成（苏苏洛音色）。
      // 微调模型一次只能生成一句，因此按句切分逐句合成后拼接，保证完整读完回复。
      const g = cfg.ttsGsv || {};
      if (g.enabled && gsvAvailableNow()) {
        const up = await ensureGsvServer(g);
        if (up) {
          const sents = splitJaSentences(sanitizeJaText(jaText));
          const parts = [];
          let skipped = 0;
          for (const s of sents) {
            const b64 = await gsvTtsJa(g, s);
            if (b64) { parts.push(b64); continue; }
            skipped += 1;
            logTts("gsv", `单句失败跳过（${skipped}/${sents.length}）: ${String(s).slice(0, 24)}`);
          }
          if (parts.length) { // 部分成功也交付（失败句跳过），避免一句毛刺整段变中文
            const merged = mergeWavBase64(parts);
            if (merged) {
              recordGsvResult(true);
              logTts("route", skipped
                ? `gsv-ja 部分成功 ${parts.length}/${sents.length}句（跳过${skipped}）len=${merged.length}`
                : `gsv-ja ok ${parts.length}/${sents.length}句 len=${merged.length}`);
              dumpWav(merged);
              return merged;
            }
          }
          recordGsvResult(false);
          logTts("route", "gsv-ja 无可用句 → 回退中文链路");
        } else {
          recordGsvResult(false);
          logTts("route", "gsv-ja 服务不可用 → 回退中文链路");
        }
      } else if (g.enabled) {
        logTts("route", "gsv-ja 冷却中 → 回退中文链路");
      }
      ttsText = cleanZh;
    }
    if (q.enabled) {
      const up = await ensureGenieServer(q);
      if (up) {
        const b64 = await genieTts(q, ttsText);
        if (b64) { logTts("route", "genie ok len=" + b64.length); return b64; }
        logTts("route", "genie 返回空 → 走 cosy/edge 回退");
      } else {
        logTts("route", "genie 服务不可用 → 走 cosy/edge 回退");
      }
    } else {
      logTts("route", "genie 未启用");
    }
    const cosy = cfg.ttsCosy || {};
    if (cosy.enabled && cosy.voice && cosy.apiKey) {
      let b64 = await cosyTts(cosy, ttsText);
      if (!b64) { // 偶发网络/服务抖动时重试一次
        logTts("route", "cosy 首次失败，重试一次");
        await new Promise((r) => setTimeout(r, 800));
        b64 = await cosyTts(cosy, ttsText);
      }
      if (b64) { logTts("route", "cosy ok len=" + b64.length); return b64; }
      logTts("route", "cosy 仍失败 → 走 edge 回退");
    } else {
      logTts("route", "cosy 未启用/缺voice/缺key: " + JSON.stringify({ e: cosy.enabled, v: !!cosy.voice, k: !!cosy.apiKey }));
    }
    const c = cfg.ttsCloud || {};
    if (c.enabled) {
      const b64 = await edgeTts(c, cleanZh);
      if (b64) { logTts("route", "edge ok len=" + b64.length); return b64; }
      logTts("route", "edge 返回空 → 回退系统语音");
    }
    return "";
  } catch (e) {
    console.error("[SuzuranPet] 语音合成失败:", e.message);
    return "";
  }
}

/* ---------- 本地 Genie (GPT-SoVITS) TTS（ttsGenie） ---------- */
function resolveTtsEndpoint(engine, fallbackPort) {
  try {
    const url = new URL(String(engine.server || `http://127.0.0.1:${fallbackPort}`));
    if (url.username || url.password || url.hash || !["http:", "https:"].includes(url.protocol)) return null;
    const host = url.hostname.toLowerCase();
    const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
    if (!loopback && (!engine.allowRemote || url.protocol !== "https:")) return null;
    url.pathname = url.pathname.replace(/\/+$/, "");
    return { base: url.toString().replace(/\/$/, ""), loopback, autoStart: loopback && engine.autoStart !== false };
  } catch { return null; }
}
let genieServerChecked = false;
let genieServerUp = false;
let genieEnsurePromise = null;

/** 确保本地 Genie TTS 服务器在运行（最多等 ~240 秒模型加载）；返回是否可用 */
async function ensureGenieServer(q) {
  if (genieServerChecked) return genieServerUp;
  if (genieEnsurePromise) return genieEnsurePromise;
  genieEnsurePromise = (async () => {
  genieServerChecked = true;
  const endpoint = resolveTtsEndpoint(q, 9881);
  if (!endpoint) { logTts("genie", "拒绝非 loopback 或未授权的远端端点"); return false; }
  const base = endpoint.base;
  const health = async () => {
    try {
      const r = await fetch(base + "/health", { signal: AbortSignal.timeout(2000) });
      return r.ok && (await r.text()) === "ok";
    } catch { return false; }
  };
  if (await health()) { genieServerUp = true; logTts("genie", "服务器已在运行"); return true; }
  if (!endpoint.autoStart) {
    logTts("genie", "远端端点未响应，跳过本地拉起");
    return false;
  }
  if (!q.python || !q.serverScript) {
    logTts("genie", "配置不完整（python/serverScript）");
    return false;
  }
  logTts("genie", "服务器未运行，尝试拉起...");
  try {
    const child = spawn(q.python, [q.serverScript, "--port", String(new URL(base).port || 9881)], {
      detached: true, windowsHide: true, stdio: "ignore"
    });
    child.unref();
  } catch (e) {
    logTts("genie", "拉起失败: " + (e && e.message || e));
    return false;
  }
  const deadline = Date.now() + (q.startTimeout || 240000); // 模型加载最长 ~4 分钟
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    if (await health()) { genieServerUp = true; logTts("genie", "服务器就绪"); return true; }
  }
  logTts("genie", "等待超时（150s 未就绪）");
  return false;
  })();
  try {
    return await genieEnsurePromise;
  } finally {
    genieEnsurePromise = null;
  }
}

/** 调本地服务器合成克隆音色；返回 base64，失败返回空。
 *  引擎长时间运行后会劣化（输出极短碎片），检测到就自动重启服务再试一次。 */
async function genieTts(q, clean) {
  const base = String(q.server || "").replace(/\/+$/, "");
  const callOnce = async () => {
    const resp = await fetch(base + "/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: clean,
        ref_audio: q.refAudio || "",
        ref_text: q.refText || ""
      }),
      signal: AbortSignal.timeout(120000)
    });
    if (!resp.ok) {
      const t = (await resp.text()).slice(0, 200);
      logTts("genie", "HTTP " + resp.status + ": " + t);
      return null;
    }
    return Buffer.from(await resp.arrayBuffer());
  };
  try {
    let buf = await callOnce();
    if (buf === null) return "";
    // 劣化自愈：文本不短但音频极小（<60KB）→ 重启 Genie 服务后重试一次
    if (buf.length < 60000 && clean.length > 6) {
      logTts("genie", `疑似引擎劣化（${buf.length}B / 文本${clean.length}字）→ 重启服务重试`);
      shutdownGenieServer();
      const up = await ensureGenieServer(q);
      if (!up) return "";
      buf = await callOnce();
      if (buf === null) return "";
    }
    if (buf.length < 100) { logTts("genie", "返回过短"); return ""; }
    return buf.toString("base64");
  } catch (e) {
    logTts("genie", "请求失败: " + (e && e.message || e));
    return "";
  }
}

/* ---------- 本地 GPT-SoVITS 日语 TTS（ttsGsv，配合 speakJa 日语模式） ---------- */
let gsvServerChecked = false;
let gsvServerUp = false;
let gsvEnsurePromise = null; // 拉起流程单飞：进行中的拉起由后续调用共享等待
let gsvWarmupPromise = null;

/** 确保 GPT-SoVITS 日语推理服务器在运行（端口 9880）；返回是否可用。
 *  启动预热与第一句话可能同时触发本函数：拉起进行中时后来者必须共用同一次等待，
 *  而不是各自探活误判「服务不可用」回退中文（曾导致引擎拉起窗口期的句子全部丢音色）。 */
function ensureGsvServer(g) {
  if (gsvEnsurePromise) return gsvEnsurePromise;
  gsvEnsurePromise = ensureGsvServerImpl(g).finally(() => { gsvEnsurePromise = null; });
  return gsvEnsurePromise;
}
async function ensureGsvServerImpl(g) {
  if (gsvServerChecked) return gsvServerUp;
  gsvServerChecked = true;
  const endpoint = resolveTtsEndpoint(g, 9880);
  if (!endpoint) { logTts("gsv", "拒绝非 loopback 或未授权的远端端点"); return false; }
  const base = endpoint.base;
  const alive = async () => {
    try {
      const r = await fetch(base + "/set_model", { signal: AbortSignal.timeout(2000) });
      return r.status === 400 || r.ok; // 服务器在线即返回 400/200
    } catch { return false; }
  };
  if (await alive()) {
    gsvServerUp = true;
    logTts("gsv", "服务器已在运行");
    await warmupGsv(g);
    return true;
  }
  if (!endpoint.autoStart) {
    logTts("gsv", "远端端点未响应，跳过本地拉起");
    return false;
  }
  if (!g.python || !g.serverScript) {
    logTts("gsv", "配置不完整（python/serverScript）");
    return false;
  }
  logTts("gsv", "服务器未运行，尝试拉起...");
  try {
    const args = [
      g.serverScript,
      "-s", g.sovitsPath,
      "-g", g.gptPath,
      "-dr", g.refAudio,
      "-dt", g.refText,
      "-dl", "ja",
      "-a", "127.0.0.1",
      "-p", String(new URL(base).port || 9880)
      // 不传 -hp（半精度 fp16）：此环境偶发数值不稳定，输出破碎电音/极短碎片且随机分布；
      // 全精度略慢更稳（4060 8GB 显存充足）。若确认需要半精度可在此手动加回 "-hp"
    ];
    let device = String(g.device || "").trim();
    if (!device) device = await detectGsvDevice(); // 未配置时自动检测：有 N 卡用 CUDA，否则 CPU
    if (device) args.push("-d", device); // 显存紧张时可配 "cpu"（慢但稳定）
    // api.py 必须以 GPT-SoVITS 根目录为工作目录启动（否则 ModuleNotFoundError: text）
    const child = spawn(g.python, args, {
      detached: true, windowsHide: true, stdio: "ignore",
      cwd: path.dirname(String(g.serverScript || ""))
    });
    child.on("error", (e) => logTts("gsv", "拉起进程错误: " + (e && e.message || e)));
    child.unref();
  } catch (e) {
    logTts("gsv", "拉起失败: " + (e && e.message || e));
    return false;
  }
  const deadline = Date.now() + (g.startTimeout || 240000);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    if (await alive()) {
      gsvServerUp = true;
      logTts("gsv", "服务器就绪");
      await warmupGsv(g);
      return true;
    }
  }
  logTts("gsv", "等待超时");
  return false;
}

/** 读取 WAV 时长（毫秒）；解析失败返回 -1 */
function wavDurationMs(buf) {
  try {
    if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF") return -1;
    let off = 12, sr = 32000, ch = 1, bits = 16, dataSize = 0;
    while (off + 8 <= buf.length) {
      const id = buf.toString("ascii", off, off + 4);
      const size = Math.min(buf.readUInt32LE(off + 4), buf.length - off - 8);
      if (id === "fmt " && size >= 16) { ch = buf.readUInt16LE(off + 10); sr = buf.readUInt32LE(off + 12); bits = buf.readUInt16LE(off + 22); }
      if (id === "data") { dataSize = size; break; }
      off += 8 + size + (size % 2);
    }
    if (!dataSize || !sr) return -1;
    return dataSize / (sr * ch * (bits / 8)) * 1000;
  } catch { return -1; }
}

/** 调 GPT-SoVITS 服务器合成日语；返回 base64，失败返回空 */
async function gsvTtsJa(g, text) {
  const clean = sanitizeJaText(text); // ～ —— 引号等符号会让引擎输出碎片，先清洗
  const base = String(g.server || "").replace(/\/+$/, "");
  const params = new URLSearchParams({ text: clean.slice(0, 300), text_language: "ja" });
  // 质量门：只查时长碎片（引擎偶发输出 1s 碎片）。
  // 注：不做高频频谱质检——日语摩擦音天然高频，误判率过高（曾导致大量跳句）。
  // 阈值 0.75：实测正常输出时长恒为预期的 1.5 倍以上，毛刺碎片 ≤0.4，
  // 0.5~0.75 区间的「半残音频」（说到一半截断）同样需要重试兜底。
  const expectMs = Math.max(400, clean.length * 90);
  const durOk = (b) => {
    const d = wavDurationMs(b);
    return !(d > 0 && clean.length > 6 && d < expectMs * 0.75);
  };
  try {
    const resp = await fetch(base + "/?" + params.toString(), { signal: AbortSignal.timeout(60000) });
    if (!resp.ok) {
      logTts("gsv", "HTTP " + resp.status);
      return "";
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length < 100) { logTts("gsv", "返回过短"); return ""; }
    let best = buf;
    if (durOk(buf)) return best.toString("base64");
    for (let att = 2; att <= 3; att++) {
      const d0 = wavDurationMs(buf);
      logTts("gsv", `疑似引擎毛刺（时长${Math.round(d0)}ms << 预期${expectMs}ms）→ 第${att}/3次重试`);
      await new Promise((r) => setTimeout(r, 800 * att)); // 退避重试：引擎坏状态连发更容易连环失败
      const resp2 = await fetch(base + "/?" + params.toString(), { signal: AbortSignal.timeout(60000) });
      if (!resp2.ok) continue;
      best = Buffer.from(await resp2.arrayBuffer());
      if (best.length >= 100 && durOk(best)) return best.toString("base64");
    }
    // 三连击仍碎片化：引擎整体劣化 → 自动重启一次再合成；防重入避免嵌套互杀
    if (gsvAutoRestarting || gsvWarmingUp) { logTts("gsv", "引擎自愈进行中，跳过该句: " + clean.slice(0, 24)); return ""; }
    gsvAutoRestarting = true;
    try {
      logTts("gsv", "连续3次碎片化 → 自动重启日语引擎...");
      if (gsvDeviceCache === "cuda") gpuMemoryLog(); // CUDA 模式下记录显存占用，辅助定位毛刺根因
      const g2 = config.getConfig().ttsGsv || {};
      await killGsvProcesses(g2);
      for (let i = 0; i < 8; i++) {
        await new Promise((r) => setTimeout(r, 800));
        if (!(await portAlive(base))) break;
      }
      gsvServerChecked = false;
      gsvServerUp = false;
      const up = await ensureGsvServer(g2);
      if (up) {
        await warmupGsv(g2); // 烧机一次吸收冷启动毛刺，再合成正式句子
        const resp3 = await fetch(base + "/?" + params.toString(), { signal: AbortSignal.timeout(180000) });
        if (resp3.ok) {
          const b3 = Buffer.from(await resp3.arrayBuffer());
          if (b3.length >= 100 && durOk(b3)) { logTts("gsv", "引擎重启后恢复正常输出"); return b3.toString("base64"); }
        }
      }
    } catch (e2) {
      logTts("gsv", "自动重启失败: " + (e2 && e2.message || e2));
    } finally {
      gsvAutoRestarting = false;
    }
    logTts("gsv", "跳过该句: " + clean.slice(0, 24));
    return "";
  } catch (e) {
    const msg = String(e && e.message || e);
    logTts("gsv", "请求失败: " + msg);
    if (!/fetch failed|ECONNREFUSED|aborted|timeout/i.test(msg)) return ""; // 非连接类错误不走重启
    // 连接被拒/超时：服务器很可能已死或挂死——若只重置缓存等下一句，本句会丢失/变中文音色。
    // 改为当场杀进程→重拉→预热→重试本句一次；60s 节流防止连环崩溃时反复重启。
    if (gsvAutoRestarting || gsvWarmingUp) return "";
    const now = Date.now();
    if (now - gsvCrashRecoveryAt < 60000) {
      logTts("gsv", "引擎崩掉（60s内已自愈过），跳过本句回退中文");
      return "";
    }
    gsvCrashRecoveryAt = now;
    gsvAutoRestarting = true;
    try {
      logTts("gsv", "引擎崩掉 → 当场自动重启并重试本句...");
      await killGsvProcesses(config.getConfig().ttsGsv || {});
      for (let i = 0; i < 8; i++) {
        await new Promise((r) => setTimeout(r, 800));
        if (!(await portAlive(base))) break;
      }
      gsvServerChecked = false;
      gsvServerUp = false;
      const g2 = config.getConfig().ttsGsv || {};
      const up = await ensureGsvServer(g2);
      if (up) {
        await warmupGsv(g2); // 烧机吸收冷启动毛刺，再正式重试本句
        const resp2 = await fetch(base + "/?" + params.toString(), { signal: AbortSignal.timeout(180000) });
        if (resp2.ok) {
          const b2 = Buffer.from(await resp2.arrayBuffer());
          if (b2.length >= 100 && durOk(b2)) { logTts("gsv", "引擎重启后本句恢复合成"); return b2.toString("base64"); }
        }
      }
    } catch (e2) {
      logTts("gsv", "崩溃自愈失败: " + (e2 && e2.message || e2));
    } finally {
      gsvAutoRestarting = false;
    }
    return "";
  }
}

/* ---------- 显卡检测与显存观测（GSV 设备自动选择／毛刺排查） ---------- */
function gpuMemoryLog() {
  execFile("nvidia-smi", ["--query-gpu=memory.used,memory.total", "--format=csv,noheader,nounits"],
    { windowsHide: true, timeout: 5000 },
    (err, stdout) => {
      if (err) return;
      const [u, t] = String(stdout || "").split(",").map((s) => parseInt(s, 10));
      if (Number.isFinite(u) && Number.isFinite(t)) {
        const free = t - u;
        logTts("gsv", `显卡显存: ${u}/${t} MiB 已用` +
          (free < 1500 ? "（空闲不足 1.5GB——显存紧张可能引发输出毛刺，建议关闭占显存的程序）" : ""));
      }
    });
}
let gsvDeviceCache = null; // 检测结果缓存（null=未检测）
async function detectGsvDevice() { // 用户未配置 device 时自动选择：有 NVIDIA 卡→CUDA，否则 CPU
  if (gsvDeviceCache) return gsvDeviceCache;
  const has = await new Promise((resolve) => {
    execFile("nvidia-smi", ["-L"], { windowsHide: true, timeout: 5000 },
      (err, stdout) => resolve(!err && /GPU/i.test(String(stdout || ""))));
  });
  gsvDeviceCache = has ? "cuda" : "cpu";
  if (has) {
    logTts("gsv", "检测到 NVIDIA 显卡 → 引擎使用 CUDA");
    gpuMemoryLog();
  } else {
    logTts("gsv", "未检测到 NVIDIA 显卡 → 引擎使用 CPU");
  }
  return gsvDeviceCache;
}

/** 引擎就绪后先烧掉一次试合成，吸收闲置/冷启动后的首次碎片输出。
 *  返回 Promise，调用方可 await 完成后再发正式请求。 */
let gsvAutoRestarting = false; // 自动重启进行中（防嵌套）
let gsvWarmingUp = false;      // 预热进行中（防重入）
let gsvCrashRecoveryAt = 0;    // 上次崩溃自愈时刻（60s 节流，防连环重启）
function warmupGsv(g) {
  if (gsvWarmupPromise) return gsvWarmupPromise;
  if (gsvAutoRestarting) return Promise.resolve(false);
  gsvWarmingUp = true;
  gsvWarmupPromise = (async () => {
    try {
      const b64 = await gsvTtsJa(g, "テスト、おはようございます");
      logTts("gsv", b64 ? "预热完成" : "预热输出异常，暂时回退中文语音");
      return !!b64;
    } finally {
      gsvWarmingUp = false;
    }
  })().finally(() => { gsvWarmupPromise = null; });
  return gsvWarmupPromise;
}

/* ---------- 手动重启日语 TTS 服务 ---------- */
function runPowerShell(ps) {
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-Command", ps],
      { windowsHide: true, timeout: 15000 },
      (err, stdout) => resolve(err ? "" : String(stdout || "").trim()));
  });
}

/** 按命令行匹配结束 GSV 推理服务进程（绝对路径启动 / 相对路径+端口启动 两种方式都覆盖） */
async function killGsvProcesses(g) {
  let port = "";
  try { port = String(new URL(String(g.server || "")).port || ""); } catch { /* 保持空 */ }
  const conds = [];
  const pat = String(g.serverScript || "").replace(/'/g, "''");
  if (pat) conds.push("$_.CommandLine -like '*" + pat + "*'");
  const script = String(g.serverScript || "").toLowerCase();
  if (port && script.endsWith("api.py")) {
    conds.push("($_.CommandLine -like '*api.py*' -and $_.CommandLine -like '*-p " + port + "*')");
  }
  if (!conds.length) return;
  const out = await runPowerShell(
    "Get-CimInstance Win32_Process -Filter \"Name='python.exe' or Name='pythonw.exe'\" | " +
    "Where-Object { " + conds.join(" -or ") + " } | " +
    "ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Output $_.ProcessId }");
  if (out) logTts("gsv", "已结束旧进程 PID: " + out.replace(/\s+/g, ","));
}

/** 结束占用指定 TCP 端口的监听进程（兜底） */
function killPortListener(port) {
  return new Promise((resolve) => {
    exec("netstat -ano -p tcp", { windowsHide: true, timeout: 10000 }, (err, stdout) => {
      if (err) return resolve(false);
      let killed = false;
      for (const ln of String(stdout || "").split(/\r?\n/)) {
        const m = ln.match(new RegExp(":" + port + "\\s+\\S+\\s+LISTENING\\s+(\\d+)"));
        if (m) { try { process.kill(Number(m[1])); killed = true; } catch { /* 已退出 */ } }
      }
      resolve(killed);
    });
  });
}

async function portAlive(base) {
  try {
    const r = await fetch(base + "/set_model", { signal: AbortSignal.timeout(1500) });
    return r.status === 400 || r.ok; // 与 ensureGsvServer 相同的在线判定
  } catch { return false; }
}

/** 一键重启日语 TTS：杀旧进程→等端口释放→拉起→试合成验证；返回 {ok, code} 供界面本地化提示 */
ipcMain.handle("pet:restart-gsv", async () => {
  const g = config.getConfig().ttsGsv || {};
  if (!g.enabled || !g.python || !g.serverScript) return { ok: false, code: "disabled" };
  const base = String(g.server || "").replace(/\/+$/, "");
  let port = 9880;
  try { port = Number(new URL(base).port) || 9880; } catch { /* 用默认端口 */ }
  logTts("gsv", "手动重启：停止旧服务...");
  await killGsvProcesses(g);
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 800));
    if (!(await portAlive(base))) break;
    if (i === 3) await killPortListener(port); // 迟迟不退出则按端口兜底清理
  }
  gsvServerChecked = false;
  gsvServerUp = false;
  logTts("gsv", "手动重启：重新拉起（模型加载约需 1~2 分钟）...");
  const up = await ensureGsvServer(g);
  if (!up) { logTts("gsv", "手动重启：失败（服务未就绪）"); return { ok: false, code: "timeout" }; }
  const b64 = await gsvTtsJa(g, "おはようございます");
  if (!b64) { logTts("gsv", "手动重启：失败（试合成无输出）"); return { ok: false, code: "synth" }; }
  logTts("gsv", "手动重启：成功");
  return { ok: true, code: "success" };
});

/** 清洗日语合成文本：GPT-SoVITS 对 ～ —— 引号 emoji 等符号处理不稳（易输出碎片），替换或剔除 */
function sanitizeJaText(t) {
  return String(t || "")
    .replace(/[～〜]/g, "ー")
    .replace(/[-—]{2,}/g, "、")
    .replace(/[“”„«»「」『』【】（）()【】]/g, "")
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 日语文本按句切分（保留标点），丢弃纯标点碎片（如单独的 … 或 」），最多 10 句 */
function splitJaSentences(text) {
  const speakable = (s) => /[\u3040-\u30FF\u4E00-\u9FFFa-zA-Z0-9]/.test(s);
  const parts = String(text || "").split(/(?<=[。！？…\n])/).map((s) => s.trim()).filter(speakable);
  if (!parts.length) parts.push(String(text || "").trim());
  if (parts.length <= 10) return parts;
  const head = parts.slice(0, 9);
  head.push(parts.slice(9).join(""));
  return head;
}

/** 裁掉 16bit PCM 段首尾的静音；尾部多留余量以保留句尾语调下降的自然衰减。
 *  GPT-SoVITS 每段输出首尾带 0.2~0.5s 纯静音，直接拼接会产生明显卡顿感，故先裁剪。 */
function trimPcmSilence(pcm, sampleRate, channels, bits, headPadMs = 90, tailPadMs = 260) {
  try {
    if (bits !== 16 || !sampleRate || !channels) return pcm;
    const frame = channels * 2;
    const n = Math.floor(pcm.length / frame);
    if (n < 1) return pcm;
    // 按人声电平回溯裁剪：引擎偶发在句尾输出白噪嘶声（广播调频感），其电平
    // 高于普通静音阈值会被误保留。从两端向内找最后一个「明显人声」帧
    // （窗口 RMS ≥ -31dB），之外的全部丢弃——无论残余噪声多响。
    const hop = Math.max(1, Math.floor(sampleRate * 0.01));
    const win = Math.max(hop, Math.floor(sampleRate * 0.02));
    const VOICE = 900; // 窗口 RMS ≈ -31dB，明确的人声电平
    let firstVoice = -1, lastVoice = -1;
    for (let i = 0; i + win <= n; i += hop) {
      let s = 0;
      for (let j = 0; j < win; j++) {
        for (let c = 0; c < channels; c++) { const v = pcm.readInt16LE((i + j) * frame + c * 2); s += v * v; }
      }
      const rms = Math.sqrt(s / (win * channels));
      if (rms >= VOICE) { if (firstVoice < 0) firstVoice = i; lastVoice = i + win - 1; }
    }
    if (firstVoice < 0) return pcm.subarray(0, Math.min(pcm.length, frame * win)); // 全程无人声：只留开头防空音频
    const start = Math.max(0, firstVoice - Math.ceil((headPadMs / 1000) * sampleRate));
    const end = Math.min(n - 1, lastVoice + Math.ceil((tailPadMs / 1000) * sampleRate));
    return pcm.subarray(start * frame, (end + 1) * frame);
  } catch { return pcm; }
}

/** 把多段相同参数的 base64 WAV 拼接成单一 WAV：裁各段首部纯静音、保留句尾语调衰减（尾部 260ms），
 *  句间补 150~220ms 随机停顿——加上尾部余量后总停顿约 500ms，接近真人换句节奏 */
function mergeWavBase64(list) {
  try {
    const datas = [];
    let fmt = null;
    let sampleRate = 32000, channels = 1;
    for (const b64 of list) {
      const buf = Buffer.from(b64, "base64");
      if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF") continue;
      let off = 12;
      while (off + 8 <= buf.length) {
        const id = buf.toString("ascii", off, off + 4);
        const size = Math.min(buf.readUInt32LE(off + 4), buf.length - off - 8);
        if (id === "fmt " && !fmt) {
          fmt = Buffer.from(buf.subarray(off + 8, off + 8 + size));
          if (fmt.length >= 16) { channels = fmt.readUInt16LE(2) || 1; sampleRate = fmt.readUInt32LE(4) || 32000; }
        }
        if (id === "data") { datas.push(buf.subarray(off + 8, off + 8 + size)); break; }
        off += 8 + size + (size % 2);
      }
    }
    if (!datas.length || !fmt || fmt.length < 16) return null;
    // 段间插入随机停顿（自然换句感），最后一段后不加
    const trimmed = [];
    datas.forEach((d, i) => {
      const seg = Buffer.from(trimPcmSilence(d, sampleRate, channels, 16)); // 拷贝为可写
      // 裁剪切口不在零交叉点会产生咔哒爆音：段首尾各做 10ms 淡入淡出消除
      const frame = channels * 2;
      const fade = Math.max(1, Math.min(Math.ceil((sampleRate * 0.01)), Math.floor(seg.length / frame / 2)));
      for (let i = 0; i < fade; i++) {
        const g = i / fade;
        for (let c = 0; c < channels; c++) {
          const oh = i * frame + c * 2;
          seg.writeInt16LE(Math.round(seg.readInt16LE(oh) * g), oh);
          const ot = seg.length - (i + 1) * frame + c * 2;
          seg.writeInt16LE(Math.round(seg.readInt16LE(ot) * g), ot);
        }
      }
      trimmed.push(seg);
      if (i < datas.length - 1) {
        // 句间停顿长度必须按 16bit 采样帧（frame 字节）取整：若为奇数字节，
        // 其后所有样本高低字节错位 → 从该句起整段电音杂讯（单句不插停顿故从无杂音）
        const silFrames = Math.ceil(sampleRate * (0.15 + Math.random() * 0.07));
        trimmed.push(Buffer.alloc(silFrames * frame));
      }
    });
    const pcm = Buffer.concat(trimmed);
    // 抑制引擎偶发的 sr/4（32k 时即 8kHz）窄带啸叫：双二阶陷波滤波器，Q=6 只挖 7.5~8.5kHz，
    // 语音基元与摩擦音几乎不受影响；无啸叫时该频段本就近似无声，处理无副作用
    if (sampleRate >= 16000) {
      const w0 = 2 * Math.PI * (sampleRate / 4) / sampleRate;
      const alpha = Math.sin(w0) / (2 * 6);
      const a0 = 1 + alpha;
      const b0n = 1 / a0, b1n = (-2 * Math.cos(w0)) / a0, b2n = 1 / a0;
      const a1n = (-2 * Math.cos(w0)) / a0, a2n = (1 - alpha) / a0;
      const frameN = channels * 2;
      const total = Math.floor(pcm.length / frameN);
      const x1 = new Float64Array(channels), x2 = new Float64Array(channels);
      const y1 = new Float64Array(channels), y2 = new Float64Array(channels);
      for (let i = 0; i < total; i++) {
        for (let c = 0; c < channels; c++) {
          const o = i * frameN + c * 2;
          const x0 = pcm.readInt16LE(o);
          const y0 = b0n * x0 + b1n * x1[c] + b2n * x2[c] - a1n * y1[c] - a2n * y2[c];
          x2[c] = x1[c]; x1[c] = x0;
          y2[c] = y1[c]; y1[c] = y0;
          pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(y0))), o);
        }
      }
    }
    const out = Buffer.alloc(44 + pcm.length);
    out.write("RIFF", 0, "ascii"); out.write("WAVE", 8, "ascii");
    out.writeUInt32LE(36 + pcm.length, 4);
    out.write("fmt ", 12, "ascii"); out.writeUInt32LE(16, 16);
    fmt.copy(out, 20, 0, 16);
    out.write("data", 36, "ascii"); out.writeUInt32LE(pcm.length, 40);
    pcm.copy(out, 44);
    return out.toString("base64");
  } catch (e) {
    logTts("gsv", "合并失败: " + (e && e.message || e));
    return null;
  }
}

/* ---------- 中日翻译（日语语音模式） ---------- */
/** 把中文翻译成自然口语的日语；失败/空结果自动重试一次；全部失败返回空串（调用方回退中文合成） */
async function translateToJa(text) {
  const cfg = config.getConfig();
  const c = cfg.chat || {};
  if (!c.apiKey || !c.baseUrl || String(c.apiType || "openai") === "anthropic") return "";
  const base = String(c.baseUrl || "").replace(/\/+$/, "");
  const sys = "你是中日翻译器。把用户输入的中文翻译成自然流畅、口语化的日语。只输出译文本身，不要任何解释、引号或多余内容。强制术语：任何‘博士’一律输出为日语片假名 ドクター（玩家称呼，发音 do-ku-tā，对应游戏里的“刀客塔”），不得输出日语汉字‘博士’，也不得输出英文 doctor。";
  for (let attempt = 1; attempt <= 2; attempt++) {
    let retryWaitMs = 1200;
    try {
      const resp = await fetch(base + "/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + c.apiKey },
        body: JSON.stringify({
          model: c.model || "deepseek-chat",
          messages: [
            { role: "system", content: sys },
            { role: "user", content: String(text || "").slice(0, 200) }
          ],
          temperature: 0.3,
          max_tokens: 2000, // 推理模型（如 deepseek-v4-flash）先消耗思考 token，太小会截断到 content 为空
          stream: false
        }),
        signal: AbortSignal.timeout(45000)
      });
      if (!resp.ok) {
        const t = (await resp.text()).slice(0, 120);
        if (resp.status === 429) { // 限流：按服务端 retryAfterSeconds 等待（上限 15s），否则 1.2s 后重试必再 429
          try {
            const j = JSON.parse(t);
            const ra = Number(j && j.data && j.data.retryAfterSeconds);
            if (Number.isFinite(ra) && ra > 0) retryWaitMs = Math.min(15000, Math.round(ra * 1000));
          } catch { /* 忽略 */ }
        }
        logTts("ja", "翻译 HTTP " + resp.status + (attempt < 2 ? "，" + retryWaitMs + "ms 后重试" : "") + ": " + t);
      } else {
        const j = await resp.json();
        const out = String((j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "").trim();
        const forced = out.replace(/博士/g, "ドクター").replace(/\b[Dd]octor\b/g, "ドクター");
        if (forced && forced.length > 0 && forced.length < 400) return forced;
        logTts("ja", "翻译返回为空" + (attempt < 2 ? "，重试" : ""));
      }
    } catch (e) {
      logTts("ja", "翻译异常(" + attempt + "): " + (e && e.message || e));
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, retryWaitMs));
  }
  return "";
}

/* ---------- 云端语音合成助手 ---------- */
function logTts(event, msg) {
  try {
    const file = path.join(config.STORAGE.logs, "tts.log");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > 2 * 1024 * 1024) {
      const prev = file + ".1";
      try { fs.unlinkSync(prev); } catch { /* 忽略 */ }
      fs.renameSync(file, prev);
    }
    fs.appendFileSync(file, new Date().toISOString() + " [" + event + "] " + msg + "\n");
  } catch { /* 日志失败不影响主流程 */ }
}

function runPythonWithTimeout(args, options, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const child = spawn("python", args, { windowsHide: true, ...options });
    let settled = false, err = "";
    const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); fn(value); };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 忽略 */ }
      finish(reject, new Error(label + " 超时"));
    }, timeoutMs);
    child.stderr?.on("data", (d) => { err += d; });
    child.on("error", (e) => finish(reject, e));
    child.on("close", (code) => code === 0 ? finish(resolve) : finish(reject, new Error(label + " 退出 " + code + ": " + err.slice(-300))));
  });
}

async function cosyTts(cosy, clean) {
  const tag = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  fs.mkdirSync(config.STORAGE.audio, { recursive: true });
  const reqFile = path.join(config.STORAGE.audio, "tts_cosy_req_" + tag + ".json");
  const outFile = path.join(config.STORAGE.audio, "tts_cosy_" + tag + ".mp3");
  try {
    fs.writeFileSync(reqFile, JSON.stringify({
      model: cosy.model || "cosyvoice-v3.5-plus",
      voice: cosy.voice,
      text: clean,
      out: outFile,
      rate: cosy.rate,
      pitch: cosy.pitch,
      volume: cosy.volume
    }));
    await runPythonWithTimeout([path.join(config.APP_DIR, "scripts", "cosy_tts.py"), reqFile], { env: { ...process.env, DASHSCOPE_API_KEY: cosy.apiKey } }, 120000, "CosyVoice");
    const buf = fs.readFileSync(outFile);
    return buf.length >= 100 ? buf.toString("base64") : "";
  } catch (e) {
    logTts("cosy", "fail: " + (e && e.message || e));
    return "";
  } finally {
    try { fs.unlinkSync(reqFile); } catch { /* 忽略 */ }
    try { fs.unlinkSync(outFile); } catch { /* 忽略 */ }
  }
}

async function edgeTts(c, clean) {
  fs.mkdirSync(config.STORAGE.audio, { recursive: true });
  const tmp = path.join(config.STORAGE.audio, "tts_edge_" + Date.now() + "-" + Math.random().toString(36).slice(2, 8) + ".mp3");
  try {
    const args = ["-m", "edge_tts", "--voice", c.voice || "zh-CN-XiaoxiaoNeural",
                  "--text", clean, "--write-media", tmp];
    if (c.rate) args.push("--rate=" + c.rate);
    if (c.pitch) args.push("--pitch=" + c.pitch);
    await runPythonWithTimeout(args, {}, 120000, "edge-tts");
    const buf = fs.readFileSync(tmp);
    return buf.length >= 100 ? buf.toString("base64") : "";
  } catch (e) {
    logTts("edge", "fail: " + (e && e.message || e));
    return "";
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }
  }
}

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
    personaCache = config.getPersonaText();
    registerUserAssetProtocol();
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

    // 预热本地 Genie TTS 服务器（后台加载模型，不阻塞开窗；声音关闭时不拉起）
    const _q = config.getConfig().ttsGenie || {};
    const _ttsOn = !!(config.getConfig().tts || {}).enabled;
    if (_q.enabled && _ttsOn) {
      ensureGenieServer(_q).then((ok) => logTts("genie", "启动预热: " + (ok ? "已就绪" : "不可用")));
    } else {
      logTts("genie", "声音关闭，跳过服务器预热");
    }

    // GSV 日语引擎预启动：应用开启即后台拉起+预热，避免第一句话等几十秒冷启动
    const _gsv = config.getConfig().ttsGsv || {};
    if (_gsv.enabled && _ttsOn && _q.speakJa) {
      ensureGsvServer(_gsv).then((up) => {
        if (up) return warmupGsv(_gsv); // 内部自带"预热完成"日志
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

    // 主动搭话：闲置 8 分钟后 30% 概率开口
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