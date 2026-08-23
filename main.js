/**
 * SuzuranPet 主进程
 * - 透明无边框置顶窗口（桌宠本体）
 * - 托盘菜单、窗口位置持久化
 * - IPC：聊天/任务路由、流式回传、停止、重载人设
 */
"use strict";

const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage, screen, dialog } = require("electron");
const { spawn, exec, execFile } = require("child_process");
const http = require("http");
const path = require("path");
const fs = require("fs");

const config = require("./src/config");
const router = require("./src/router");
const chatClient = require("./src/chat-client");
const zcodeClient = require("./src/zcode-client");
const history = require("./src/history");
const i18n = require("./src/i18n");
const features = require("./src/features");

const ICON_PATH = path.join(config.APP_DIR, "icon.png");

let win = null;
let tray = null;
let helpWin = null; // 使用说明窗口
let settingsWin = null; // 设置窗口
let voiceWin = null; // 音色克隆与训练窗口
let moodWin = null; // 表情管理窗口
let termsWin = null; // 使用条款确认窗口
let agentApiAbort = null; // Agent 接口当前请求的中止控制器
let activeReq = null; // { id, abort }
let forcedMode = "auto"; // auto | chat | zcode
let personaCache = config.getPersonaText();
let quitting = false;

/* ---------- 隐藏 / 显示 ---------- */
function isWindowVisible() {
  return win && !win.isDestroyed() && win.isVisible();
}
function showWindow() {
  if (!win || win.isDestroyed()) return;
  win.show();
  applyLayer(walk.active || walk.seated); // 行走/坐下中保持任务栏之上
  win.focus();
}
function hideWindow() {
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
      onTop = b.y + b.height > wa.y + wa.height - 2; // 窗口底探入任务栏区
    } catch { onTop = true; }
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

/* ---------- 窗口 ---------- */
function createWindow() {
  const cfg = config.getConfig();
  const scale = clampScale(cfg.window.scale);
  const w = Math.round((cfg.window.width || 260) * scale);
  const h = Math.round((cfg.window.height || 200) * scale);

  win = new BrowserWindow({
    width: w,
    height: h,
    x: cfg.window.x ?? undefined,
    y: cfg.window.y ?? undefined,
    transparent: true,
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
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(config.APP_DIR, "renderer", "index.html"));
  // 初始即开启点击穿透（透明区域不挡下层应用），由渲染层按需放行
  win.setIgnoreMouseEvents(true, { forward: true });

  // 启动时把窗口钳回屏幕工作区内（布局变宽后旧位置可能越界）
  try {
    const wa = screen.getDisplayMatching(win.getBounds()).workArea;
    const [x, y] = win.getPosition();
    const [cw, ch] = win.getSize();
    win.setPosition(
      Math.min(Math.max(x, walkMinX(wa)), wa.x + wa.width - cw),
      Math.min(Math.max(y, wa.y), wa.y + wa.height - ch + 80) // +80 允许坐姿下沉探入任务栏区
    );
  } catch { /* 忽略 */ }

  // 位置持久化
  const savePos = () => {
    if (!win || win.isDestroyed()) return;
    const [x, y] = win.getPosition();
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
    { label: i18n.t(lang, "tray.skinLabel"),
      enabled: cfg.renderMode === "spine",
      submenu: detectSpineModels().map((m) => ({
        label: spineSkinDisplayName(m.id, m.name, lang),
        type: "radio",
        checked: (cfg.spineSkinId || "builtin") === m.id,
        click: () => setSpineSkin(m.id)
      }))
    },
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
    { label: i18n.t(lang, "tray.sitTaskbar"), click: () => sitOnTaskbar() },
    { label: i18n.t(lang, "tray.sizeLabel") + i18n.t(lang, sizeWord), enabled: false },
    { label: i18n.t(lang, "tray.sizeSmall"), type: "radio", checked: scale <= 0.8, click: () => setScale(0.75) },
    { label: i18n.t(lang, "tray.sizeStandard"), type: "radio", checked: scale > 0.8 && scale < 1.2, click: () => setScale(1.0) },
    { label: i18n.t(lang, "tray.sizeLarge"), type: "radio", checked: scale >= 1.2 && scale < 1.6, click: () => setScale(1.25) },
    { label: i18n.t(lang, "tray.sizeXLarge"), type: "radio", checked: scale >= 1.6, click: () => setScale(1.5) },
    { type: "separator" },
    { label: i18n.t(lang, "tray.settings"), click: () => openSettings() },
    { label: i18n.t(lang, "tray.moodManager"), click: () => openMoodManager() },
    { label: i18n.t(lang, "tray.voiceStudio"), click: () => openVoiceStudio() },
    { label: i18n.t(lang, "tray.ttsGuide"), click: () => openTtsGuide() },
    { label: i18n.t(lang, "tray.reloadPersona"), click: () => { personaCache = config.getPersonaText(); sendToRenderer("pet:toast", i18n.t(lang, "tray.personaReloaded")); } },
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
    title: "苏苏洛使用说明",
    autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });
  helpWin.setMenuBarVisibility(false);
  helpWin.loadFile(path.join(config.APP_DIR, "renderer", "help.html"));
  helpWin.on("closed", () => { helpWin = null; });
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

/* ---------- 表情管理（换装，动态情绪表） ---------- */
const SPRITE_USER_DIR = path.join(config.APP_DIR, "renderer", "sprites", "user");
const SPRITE_DEFAULT_DIR = path.join(config.APP_DIR, "renderer", "sprites", "default");

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
    try {
      const wa = screen.getDisplayMatching(win.getBounds()).workArea;
      const [x, y] = win.getPosition();
      win.setPosition(Math.min(Math.max(x, walkMinX(wa)), wa.x + wa.width - ws),
                      Math.min(Math.max(y, wa.y), wa.y + wa.height - hs + 80)); // +80 允许坐姿下沉探入任务栏区
    } catch { /* 忽略 */ }
    applySeatPosition(); // 尺寸档位变了，若正处于坐姿立即按新档位重新落座
  }
  refreshTrayMenu();
  sendToRenderer("pet:scale-changed", s);
}
ipcMain.handle("pet:set-scale", (_e, scale) => { setScale(scale); return true; });
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

/* ---------- 本地 Agent 调用接口（其他 agent / 脚本可调用，仅 127.0.0.1） ---------- */
function startAgentApi() {
  const a = config.getConfig().agentApi || {};
  if (!a.enabled) return;
  const port = Math.max(1, Math.min(65535, parseInt(a.port, 10) || 8765));
  const server = http.createServer(async (req, res) => {
    const send = (code, obj) => {
      const body = JSON.stringify(obj);
      res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
      res.end(body);
    };
    try {
      if (req.method === "GET" && req.url.startsWith("/health")) {
        const cfg = config.getConfig();
        send(200, { ok: true, name: (cfg.pet || {}).name || "苏苏洛", agreed: !!cfg.agreed, invokeWord: (cfg.agentApi || {}).invokeWord || "" });
        return;
      }
      if (req.method === "POST" && req.url.startsWith("/chat")) {
        if (!config.getConfig().agreed) { send(403, { ok: false, error: "请先同意《使用条款与隐私政策》" }); return; }
        let raw = "";
        for await (const chunk of req) raw += chunk;
        let body = {};
        try { body = JSON.parse(raw || "{}"); } catch { send(400, { ok: false, error: "invalid json" }); return; }
        let text = String(body.text || "").trim();
        const a2 = config.getConfig().agentApi || {};
        if (a2.invokeWord) {
          const w = String(a2.invokeWord).trim();
          if (!text.startsWith(w)) { send(400, { ok: false, error: "消息需以调用词「" + w + "」开头" }); return; }
          text = text.slice(w.length).trim();
        }
        if (!text) { send(400, { ok: false, error: "text 不能为空" }); return; }
        const abort = new AbortController();
        agentApiAbort = abort;
        try {
          const r = await chatClient.chat({
            persona: personaCache || config.getPersonaText(),
            history: history.recent("chat", config.getConfig().chat.maxHistoryTurns || 10),
            text,
            signal: abort.signal,
            onChunk: () => {}
          });
          history.append({ ts: Date.now(), mode: "chat", role: "user", content: text });
          history.append({ ts: Date.now(), mode: "chat", role: "assistant", content: r.text });
          send(200, { ok: true, reply: r.text, emotion: r.emotion || "" });
        } finally {
          if (agentApiAbort === abort) agentApiAbort = null;
        }
        return;
      }
      if (req.method === "POST" && req.url.startsWith("/stop")) {
        if (agentApiAbort) agentApiAbort.abort();
        send(200, { ok: true });
        return;
      }
      send(404, { ok: false, error: "not found" });
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

function savePosSafe() {
  if (win && !win.isDestroyed()) {
    const [x, y] = win.getPosition();
    config.saveConfig({ window: { x, y } });
  }
}

/* ---------- 对话核心 ---------- */
async function handleAsk(sender, { id, text }) {
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
  activeReq = { id, abort };
  history.append({ ts: Date.now(), mode, role: "user", content: clean });

  sender.send("pet:thinking", { id, mode });
  let emotion = "";
  try {
    let full = "";
    if (mode === "zcode") {
      full = await zcodeClient.runZcodeTask({
        prompt: taskText,
        persona: personaCache,
        signal: abort.signal,
        onChunk: (d) => sender.send("pet:chunk", { id, mode, text: d })
      });
    } else {
      const persona = personaCache || config.getPersonaText();
      const r = await chatClient.chat({
        persona,
        history: history.recent("chat", config.getConfig().chat.maxHistoryTurns || 20),
        text: clean,
        signal: abort.signal,
        onChunk: (d) => sender.send("pet:chunk", { id, mode, text: d })
      });
      full = r.text;
      emotion = r.emotion || ""; // 模型选的情绪词（≤5字，已在 chat-client 里校验过词表）
    }
    history.append({ ts: Date.now(), mode, role: "assistant", content: full });
    sender.send("pet:done", { id, mode, full, emotion });

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
    if (err.name === "AbortError") {
      sender.send("pet:done", { id, mode, full: "（已停止）" });
    } else {
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
    activeReq.abort.abort();
    activeReq = null;
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
    agentApi: cfg.agentApi,
    firstRun: !!cfg.firstRun,
    workspace: cfg.workspace,
    tts: cfg.tts || { enabled: false, voice: "", rate: 0.95, pitch: 1.1 },
    ttsCloud: { enabled: !!(cfg.ttsCloud?.enabled || cfg.ttsCosy?.enabled || cfg.ttsGenie?.enabled) },
    winSize: { width: cfg.window.width || 170, height: cfg.window.height || 260 },
    hasUserSprite: fs.existsSync(path.join(config.APP_DIR, "renderer", "sprites", "user", "sprite.png")),
    renderMode: cfg.renderMode === "spine" ? "spine" : "gif",
    walking: !!cfg.walking,
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

/* ---------- 设置窗口 IPC ---------- */
ipcMain.handle("pet:get-settings", () => {
  const cfg = config.getConfig();
  return {
    pet: cfg.pet,
    chat: {
      apiType: cfg.chat.apiType,
      baseUrl: cfg.chat.baseUrl,
      model: cfg.chat.model,
      apiKey: cfg.chat.apiKey,
      userName: cfg.chat.userName,
      temperature: cfg.chat.temperature,
      maxTokens: cfg.chat.maxTokens,
      maxHistoryTurns: cfg.chat.maxHistoryTurns
    },
    tts: cfg.tts,
    ttsCloud: cfg.ttsCloud,
    ttsCosy: cfg.ttsCosy,
    ttsGenie: cfg.ttsGenie,
    zcodeEnabled: !!cfg.zcodeEnabled,
    zcodeCli: cfg.zcodeCli,
    agreed: !!cfg.agreed,
    scale: cfg.window.scale || 1.0,
    agentApi: cfg.agentApi,
    hotkey: cfg.hotkey,
    startHidden: !!cfg.startHidden,
    uiLang: cfg.uiLang || "zh",
    renderMode: cfg.renderMode === "spine" ? "spine" : "gif",
    walking: !!cfg.walking,
    persona: config.getPersonaText(),
    hasPersonaDefault: fs.existsSync(config.PERSONA_DEFAULT_PATH),
    keySource: cfg._keySource
  };
});
ipcMain.handle("pet:save-settings", (_e, patch) => {
  if (!patch || typeof patch !== "object") return false;
  try {
    const before = config.getConfig();
    config.saveConfig(patch);
    refreshTrayMenu();
    const after = config.getConfig();
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
    fs.writeFileSync(path.join(config.APP_DIR, "data", "history.jsonl"), "", "utf8");
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

// 日程提醒
ipcMain.handle("pet:set-reminder", (_e, { text, at }) => {
  return features.setReminder(text, at, (msg) => {
    sendProactive(msg, "happy", { force: true });
  });
});
ipcMain.handle("pet:get-reminders", () => features.getReminders());
ipcMain.handle("pet:cancel-reminder", (_e, index) => features.cancelReminder(index));

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
  }
});

/** 拖拽落点吸附判定：底边接近任务栏上沿 → 贴齐坐下；
 *  在主屏左侧桌面图标网格区且底边接近某图标格顶部 → 坐到该图标上。
 *  返回是否处于坐下吸附。贴地定位统一用 groundGap 下探，让角色脚底真正踩在表面上。 */
function dragSeatUpdate() {
  if (!win || win.isDestroyed()) return false;
  const b = win.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  const feet = b.y + b.height - walk.groundGap; // 角色脚底实际屏幕位置
  const waBottom = wa.y + wa.height;
  let seated = false;
  let ny = b.y, nx = b.x;

  if (Math.abs(feet - waBottom) <= 48) {
    seated = true;                                   // 任务栏磁吸
    ny = waBottom + walk.groundGap - b.height;
    nx = Math.min(Math.max(b.x, walkMinX(wa)), wa.x + wa.width - b.width);
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

  const changed = seated !== walk.seated;
  walk.seated = seated;
  if (seated) {
    walk.resting = true;
    walk.gotoPerch = false;
    walk.returning = false;
    walk.perched = false;
    win.setPosition(Math.round(nx), Math.round(ny));
  }
  if (changed) {
    applySeatPosition(); // 坐下腿垂进任务栏/图标区，离开收腿
    walkBroadcast();
  }
  applyLayer(walk.seated || walk.active);
  return seated;
}

/* ---------- 桌面行走 v2（仅 Spine 模式，与 GIF 表情系统完全独立）
   地面 = 任务栏上沿；水平左右走动、走走停停；偶尔跳到桌面程序窗口顶上坐下休息（Sit）。 ---------- */
const walk = {
  active: false,    // 引擎运行中（配置开关 + spine 模式才为 true）
  paused: false,    // 渲染层拖拽等临时暂停
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
  returning: false, // 坐完正回到地面
  dir: 1,           // 漫游方向
  targetX: null,
  perchTopY: 0,
  timer: null,
  phaseTimer: null
};
const WALK_TICK_MS = 40;
const WALK_SPEED = 1.2;                        // 每 tick 像素 ≈ 30px/s
const randInt = (a, b) => Math.floor(a + Math.random() * (b - a + 1));

function walkBroadcast() {
  sendToRenderer("pet:walking", {
    active: walk.active, resting: walk.resting, perched: walk.perched, seated: walk.seated, face: walk.face
  });
}

function walkSchedulePhase(ms) {
  clearTimeout(walk.phaseTimer);
  walk.phaseTimer = setTimeout(walkOnPhaseEnd, ms);
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
function walkMinX(wa) {
  return wa.x - (walk.charInset || 0);
}
function setEdgeLeft(v) {
  v = !!v;
  if (walk.edgeLeft !== v) {
    walk.edgeLeft = v;
    sendToRenderer("pet:edge-left", v); // 渲染层据此把气泡切到头顶模式
  }
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

async function walkOnPhaseEnd() {
  if (!walk.active) return;
  if (walk.sleeping) { walkSchedulePhase(randInt(10000, 20000)); return; } // 睡觉中不切换相位
  if (walk.perched || walk.iconRest) {      // 图标/窗顶待够 → 回到地面
    walk.iconRest = false;
    walk.perched = false;
    walk.returning = true;
    walk.resting = false;
    walk.seated = false;
    applySeatPosition();
    walkBroadcast();
    return;                                 // walkTick 完成下降后再排下一相位
  }
  if (walk.resting && !walk.seated) {       // 久坐起身活动（拖拽吸附坐下保持到被拖走）
    walkSchedulePhase(randInt(8000, 15000));
    return;
  }
  if (walk.resting) {
    if (!walk.paused && desktopIconMode()) { // 桌面层级＋已授权：优先与桌面图标互动
      if (Math.random() < 0.7) {
        if (await walkAttemptIconPerch()) return;
        walk.resting = true;                // 图标不可用 → 就地坐下休息
        walk.seated = true;
        applySeatPosition();
        walkBroadcast();
        walkSchedulePhase(sitPhaseMs());
        return;
      }
      walkAttemptPerch();                   // 剩余概率仍可尝试跳程序窗
      return;
    }
    if (!walk.paused && Math.random() < 0.35) { walkAttemptPerch(); return; }
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

/** 枚举可见应用窗口（PowerShell user32），供「坐窗口」挑选落点 */
const PS_WINDOW_LIST =
  "Add-Type 'using System;using System.Runtime.InteropServices;public struct RECT{public int L,T,R,B;}public class WQ{" +
  "[DllImport(\"user32.dll\")]public static extern bool GetWindowRect(IntPtr h,out RECT r);" +
  "[DllImport(\"user32.dll\")]public static extern bool IsWindowVisible(IntPtr h);}';" +
  "$o=@();Get-Process|?{$_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -and $_.MainWindowTitle -notmatch '苏苏洛' }|%{" +
  "$r=New-Object RECT;if([WQ]::GetWindowRect($_.MainWindowHandle,[ref]$r) -and [WQ]::IsWindowVisible($_.MainWindowHandle)){" +
  "$o+=@{x=$r.L;y=$r.T;w=($r.R-$r.L);h=($r.B-$r.T)}}};" +
  "if($o.Count -eq 0){'[]'}else{$o|ConvertTo-Json -Compress}";

async function listAppWindows() {
  try {
    const txt = await runPowerShell(PS_WINDOW_LIST);
    const j = JSON.parse(txt || "[]");
    return Array.isArray(j) ? j : [j];
  } catch { return []; }
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

function desktopIconMode() { // 桌面层级＋用户授权 同时满足才启用图标互动
  const cfg = config.getConfig();
  return cfg.layer === "desktop" && !!((cfg.features || {}).desktopIcons);
}
let desktopIconCache = { at: 0, list: [] };

async function listDesktopIcons(force = false) {
  if (!desktopIconMode()) return [];
  if (!force && Date.now() - desktopIconCache.at < 5 * 60 * 1000) return desktopIconCache.list;
  try {
    const txt = await runPowerShell(PS_DESKTOP_ICONS);
    const j = JSON.parse(txt || "[]");
    const list = Array.isArray(j) ? j.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y)) : [];
    desktopIconCache = { at: Date.now(), list };
    logTts("walk", "桌面图标感知: " + list.length + " 个");
    return list;
  } catch { return []; }
}

/** 挑一个桌面图标走过去跳上去站/坐（复用跳窗的走近→一步跳→回落流程） */
async function walkAttemptIconPerch() {
  try {
    if (!win || win.isDestroyed()) return false;
    const b = win.getBounds();
    const wa = screen.getDisplayMatching(b).workArea;
    const icons = await listDesktopIcons(true);
    const cands = icons.filter((p) =>
      p.x >= wa.x + 8 && p.x <= wa.x + wa.width - 60 &&
      p.y >= wa.y && p.y + b.height <= wa.y + wa.height + 60 // 跳上后整窗不出屏（底部允许略探任务栏区）
    );
    if (!cands.length) return false;
    const t = cands[Math.floor(Math.random() * cands.length)];
    walk.perchTopY = Math.round(t.y);
    const charCx = (walk.charInset + b.width - 2) / 2; // 角色条带中心对准图标
    walk.targetX = Math.min(Math.max(Math.round(t.x - charCx), walkMinX(wa)), wa.x + wa.width - b.width);
    walk.iconTarget = true;
    walk.gotoPerch = true;
    walk.resting = false;
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
      const wins = await listAppWindows();
      const cands = wins.filter((r) =>
        r.w >= 280 && r.h >= 140 &&
        r.y >= wa.y + 60 &&                          // 太靠上的窗口坐上去会出屏
        r.y - b.height >= wa.y + 6 &&                // 上方要放得下整个小人
        r.x < wa.x + wa.width && r.x + r.w > wa.x    // 在当前屏幕内
      );
      if (!cands.length) {                           // 没有合适窗口 → 坐下休息
        walk.resting = true;
        walk.seated = true;
        applySeatPosition();
        walkBroadcast();
        walkSchedulePhase(sitPhaseMs());
        return;
      }
      const t = cands[Math.floor(Math.random() * cands.length)];
      walk.perchTopY = t.y;
      walk.targetX = Math.min(Math.max(t.x + t.w / 2 - b.width / 2, wa.x), wa.x + wa.width - b.width);
      walk.gotoPerch = true;
      walk.resting = false;
      walkBroadcast();
      logTts("walk", "跳上窗口: " + JSON.stringify(t));
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
  if (walk.paused || walk.seated || !win.isVisible()) return; // 拖拽中/坐下/隐藏到托盘时不移动
  const b = win.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  const minX = walkMinX(wa); // 左边界外扩角色条带宽：角色（而非透明气泡区）贴到屏幕左缘
  const maxX = Math.max(minX, wa.x + wa.width - b.width);
  const groundY = Math.max(wa.y, wa.y + wa.height - b.height) + walk.groundGap; // 窗口底边允许下探任务栏区，使角色脚底贴地
  let x = b.x;

  /* —— 去/回窗口：水平走到正下方后「一步跳」上去/跳下来，不做长距离垂直移动 —— */
  if ((walk.gotoPerch || walk.returning) && !walk.sleeping) {
    const tx = walk.targetX;
    if (tx != null && Math.abs(tx - x) > 2) {      // 水平接近窗口正下方
      const nx = Math.abs(tx - x) < WALK_SPEED ? tx : x + Math.sign(tx - x) * WALK_SPEED;
      walkUpdateFace(Math.sign(nx - x));
      win.setPosition(Math.round(nx), b.y);
      return;
    }
    // 到位 → 瞬间跳上窗顶（Sit）/ 跳回地面，避免在空中播放走路动画
    const ty = walk.returning ? groundY : walk.perchTopY;
    win.setPosition(Math.round(tx != null ? tx : x), Math.round(ty));
    if (walk.gotoPerch) {
      walk.gotoPerch = false;
      if (walk.iconTarget && Math.random() < 0.45) { // 图标上随机改为站立（Relax 待机）
        walk.iconRest = true;
        walk.resting = true;
      } else {
        walk.perched = true;                        // 坐着（Sit）
        walk.resting = true;
      }
      walkBroadcast();
      applyLayer();                                 // 已离开任务栏表面：桌面层级下让位程序窗口
      walkSchedulePhase(sitPhaseMs());
    } else {
      walk.returning = false;
      walk.resting = true;
      walk.seated = true; // 落地坐下
      applySeatPosition();
      walkBroadcast();
      walkSchedulePhase(sitPhaseMs());
    }
    return;
  }

  /* —— 地面状态 —— */
  if (walk.resting || walk.sleeping) return;        // 放松/睡觉：站着不动

  walkUpdateFace(walk.dir);                         // 朝向跟随实际位移方向
  let nx = x + walk.dir * WALK_SPEED;
  if (nx <= minX || nx >= maxX) {                   // 到屏幕边折返（左侧已按角色条带补偿）
    walk.dir *= -1;
    nx = Math.min(Math.max(nx, minX), maxX);
  }
  /* —— 桌面层级＋已授权：前进方向近处没有桌面图标就不硬走，就地坐下休息 —— */
  if (desktopIconMode() && desktopIconCache.list.length) {
    const lo = Math.min(x, nx) - 40, hi = Math.max(x, nx) + 140;
    if (!desktopIconCache.list.some((p) => p.x >= lo && p.x <= hi)) {
      walk.resting = true;
      walk.seated = true;
      applySeatPosition();
      walkBroadcast();
      walkSchedulePhase(sitPhaseMs());
      return;
    }
  }
  setEdgeLeft(nx < wa.x - 2);                       // 探出屏幕左侧：气泡切头顶模式
  win.setPosition(Math.round(nx), Math.round(groundY));
}

function startWalkingEngine() {
  if (walk.active) return true;
  if (config.getConfig().renderMode !== "spine") return false; // GIF 模式不可行走
  walk.active = true;
  walk.resting = true;
  walk.perched = false;
  walk.iconRest = false;
  walk.iconTarget = false;
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
  walk.paused = !!p;
  if (!p && walk.active) {
    // 松手/恢复：若之前处于坐窗流程中被拖走，就地转入「回到地面」下降流程
    if (walk.perched || walk.gotoPerch || walk.returning || walk.iconRest) {
      walk.perched = false;
      walk.iconRest = false;
      walk.iconTarget = false;
      walk.gotoPerch = false;
      walk.returning = true;
      walk.resting = false;
      walk.targetX = null; // 水平保持当前 x，只垂直落地
      clearTimeout(walk.phaseTimer);
      walkBroadcast();
    }
    // 拖拽落点定格：仍贴近任务栏/图标则保持坐下，否则恢复正常状态
    dragSeatUpdate();
  }
});
ipcMain.on("pet:set-sleeping", (_e, v) => { walk.sleeping = !!v; }); // 睡觉时行走引擎原地待命
ipcMain.on("pet:set-ground-gap", (_e, px) => {
  const v = Number(px);
  if (Number.isFinite(v)) walk.groundGap = Math.max(0, Math.min(80, Math.round(v)));
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
  const dir = path.join(config.APP_DIR, "renderer", "fonts", "user");
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(r.filePaths[0], path.join(dir, name));
  const prev = (config.getConfig().appearance || {}).customFonts || [];
  config.saveConfig({ appearance: { ...(config.getConfig().appearance || {}), customFonts: Array.from(new Set([...prev, name])) } });
  logTts("walk", "导入字体: " + name);
  return { customFonts: (config.getConfig().appearance || {}).customFonts || [] };
});

/** 扫描全部可用 Spine 皮肤：内置苏苏洛 + spine/user/ 下每个含 .atlas+.skel/.json 的模型（支持子文件夹分皮肤） */
function detectSpineModels() {
  const list = [{
    id: "builtin",
    name: "Sussurro",
    atlas: "spine/sussurro/build_char_298_susuro.atlas",
    skel: "spine/sussurro/build_char_298_susuro.skel"
  }];
  const userDir = path.join(config.APP_DIR, "renderer", "spine", "user");
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
        name: base.replace(/^(build_char_\d+_)/, "").replace(/_/g, " "),
        atlas: "spine/user/" + prefix + e.name,
        skel: "spine/user/" + prefix + skelName
      });
    }
  };
  scan("");
  return list;
}

function setSpineSkin(id) {
  config.saveConfig({ spineSkinId: String(id || "") });
  refreshTrayMenu();
  sendToRenderer("pet:spine-skin-changed", String(id || ""));
  logTts("walk", "切换小人皮肤: " + (id || "builtin"));
}

/** 皮肤显示名：已知 id 用三语文案，未知皮肤用清理后的文件名 */
function spineSkinDisplayName(id, fallbackName, lang) {
  if (id === "builtin") return i18n.t(lang, "skin.builtin", "Sussurro");
  if (/summer/i.test(id)) return i18n.t(lang, "skin.summer", "Sussurro Summer");
  if (/winter/i.test(id)) return i18n.t(lang, "skin.winter", "Sussurro Winter");
  return fallbackName || id;
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
  try { // 保持在屏幕工作区内，避免放大后跑出屏幕
    const wa = screen.getDisplayMatching(win.getBounds()).workArea;
    const [x, y] = win.getPosition();
    win.setPosition(Math.min(Math.max(x, wa.x), wa.x + wa.width - ws),
                    Math.min(Math.max(y, wa.y), wa.y + wa.height - hs + 80)); // +80 允许坐姿下沉
  } catch { /* 忽略 */ }
});
ipcMain.handle("pet:tts-clone", async (_e, text) => {
  // 语音链路：本地 Genie（ttsGenie，主，克隆音色）→ 百炼 CosyVoice（ttsCosy，默认停用）→ edge-tts（ttsCloud）→ 空（渲染层回退系统语音）
  try {
    const dumpWav = (b64) => { // 调试转储：保存最终交付的音频，便于排查播放端问题
      try {
        const dir = path.join(config.APP_DIR, "data");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "tts_last.wav"), Buffer.from(b64, "base64"));
      } catch { /* 转储失败不影响主流程 */ }
    };
    const cfg = config.getConfig();
    const clean = String(text || "").slice(0, 200);
    const q = cfg.ttsGenie || {};
    // 日语语音模式（speakJa）：先把中文翻译成日语，再用 GPT-SoVITS（ttsGsv）日语微调音色说话；文字/聊天保持中文
    let ttsText = clean;
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
      if (g.enabled) {
        const up = await ensureGsvServer(g);
        if (up) {
          const sents = splitJaSentences(sanitizeJaText(jaText));
          const parts = [];
          for (const s of sents) {
            const b64 = await gsvTtsJa(g, s);
            if (b64) parts.push(b64);
            else logTts("gsv", "单句失败（跳过）: " + String(s).slice(0, 30));
          }
          if (parts.length) {
            const merged = mergeWavBase64(parts); // 单句也走一遍：统一做首尾静音裁剪
            if (merged) {
              logTts("route", `gsv-ja ok ${parts.length}/${sents.length}句 len=${merged.length}`);
              dumpWav(merged);
              return merged;
            }
          }
          logTts("route", "gsv-ja 失败 → 回退中文链路");
        } else {
          logTts("route", "gsv-ja 服务不可用 → 回退中文链路");
        }
      }
      ttsText = clean; // 日语服务不可用 → 退回中文合成
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
      const b64 = await edgeTts(c, clean);
      if (b64) { logTts("route", "edge ok len=" + b64.length); return b64; }
      logTts("route", "edge 返回空 → 回退系统语音");
    }
    return "";
  } catch (e) {
    console.error("[SuzuranPet] 语音合成失败:", e.message);
    return "";
  }
});

/* ---------- 本地 Genie (GPT-SoVITS) TTS（ttsGenie） ---------- */
let genieServerChecked = false;
let genieServerUp = false;

/** 确保本地 Genie TTS 服务器在运行（最多等 ~240 秒模型加载）；返回是否可用 */
async function ensureGenieServer(q) {
  if (genieServerChecked) return genieServerUp;
  genieServerChecked = true;
  const base = String(q.server || "").replace(/\/+$/, "");
  const health = async () => {
    try {
      const r = await fetch(base + "/health", { signal: AbortSignal.timeout(2000) });
      return r.ok && (await r.text()) === "ok";
    } catch { return false; }
  };
  if (await health()) { genieServerUp = true; logTts("genie", "服务器已在运行"); return true; }
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

/** 确保 GPT-SoVITS 日语推理服务器在运行（端口 9880）；返回是否可用 */
async function ensureGsvServer(g) {
  if (gsvServerChecked) return gsvServerUp;
  gsvServerChecked = true;
  const base = String(g.server || "").replace(/\/+$/, "");
  const alive = async () => {
    try {
      const r = await fetch(base + "/set_model", { signal: AbortSignal.timeout(2000) });
      return r.status === 400 || r.ok; // 服务器在线即返回 400/200
    } catch { return false; }
  };
  if (await alive()) { gsvServerUp = true; logTts("gsv", "服务器已在运行"); warmupGsv(g); return true; }
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
      "-p", String(new URL(base).port || 9880),
      "-hp"
    ];
    if (g.device) args.push("-d", String(g.device)); // 显存紧张时可配 "cpu"（慢但稳定）
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
    if (await alive()) { gsvServerUp = true; logTts("gsv", "服务器就绪"); warmupGsv(g); return true; }
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
  try {
    const params = new URLSearchParams({ text: clean.slice(0, 300), text_language: "ja" });
    const resp = await fetch(base + "/?" + params.toString(), { signal: AbortSignal.timeout(120000) });
    if (!resp.ok) {
      logTts("gsv", "HTTP " + resp.status);
      return "";
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length < 100) { logTts("gsv", "返回过短"); return ""; }
    // 质量门：只查时长碎片（引擎偶发输出 1s 碎片）。最多重试 2 次，间隔递增。
    // 注：不做高频频谱质检——日语摩擦音天然高频，误判率过高（曾导致大量跳句）。
    const expectMs = Math.max(400, clean.length * 90);
    const durOk = (b) => {
      const d = wavDurationMs(b);
      return !(d > 0 && clean.length > 6 && d < expectMs * 0.5);
    };
    let best = buf;
    if (durOk(buf)) return best.toString("base64");
    for (let att = 2; att <= 3; att++) {
      const d0 = wavDurationMs(buf);
      logTts("gsv", `疑似引擎毛刺（时长${Math.round(d0)}ms << 预期${expectMs}ms）→ 第${att}/3次重试`);
      await new Promise((r) => setTimeout(r, 300 * att));
      const resp2 = await fetch(base + "/?" + params.toString(), { signal: AbortSignal.timeout(120000) });
      if (!resp2.ok) continue;
      best = Buffer.from(await resp2.arrayBuffer());
      if (best.length >= 100 && durOk(best)) return best.toString("base64");
    }
    // 三连击仍碎片化：引擎整体劣化 → 自动重启一次再合成；防重入避免嵌套互杀
    if (gsvAutoRestarting || gsvWarmingUp) { logTts("gsv", "引擎自愈进行中，跳过该句: " + clean.slice(0, 24)); return ""; }
    gsvAutoRestarting = true;
    try {
      logTts("gsv", "连续3次碎片化 → 自动重启日语引擎...");
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
    logTts("gsv", "请求失败: " + (e && e.message || e));
    // 连接被拒/超时：服务器很可能已死或挂死——重置探测缓存并清掉进程，
    // 让下一句话重新拉起（否则缓存的「在线」状态会让后续全部瞬间失败，永远哑巴）
    if (gsvAutoRestarting || gsvWarmingUp) return "";
    const msg = String(e && e.message || e);
    if (/fetch failed|ECONNREFUSED|aborted|timeout/i.test(msg)) {
      try {
        gsvServerChecked = false;
        gsvServerUp = false;
        await killGsvProcesses(config.getConfig().ttsGsv || {});
        logTts("gsv", "已重置引擎状态，下一句将自动重新拉起");
      } catch { /* 忽略 */ }
    }
    return "";
  }
}

/** 引擎就绪后先烧掉一次试合成，吸收闲置/冷启动后的首次碎片输出。
 *  返回 Promise，调用方可 await 完成后再发正式请求。 */
let gsvAutoRestarting = false; // 自动重启进行中（防嵌套）
let gsvWarmingUp = false;      // 预热进行中（防重入）
function warmupGsv(g) {
  if (gsvWarmingUp) return Promise.resolve(true);
  if (gsvAutoRestarting) return Promise.resolve(false);
  gsvWarmingUp = true;
  return (async () => {
    try {
      const b64 = await gsvTtsJa(g, "テスト、おはようございます");
      logTts("gsv", b64 ? "预热完成" : "预热输出异常（每句自愈仍会兜底）");
      return !!b64;
    } finally {
      gsvWarmingUp = false;
    }
  })();
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
        trimmed.push(Buffer.alloc(Math.ceil(sampleRate * channels * 2 * (0.15 + Math.random() * 0.07))));
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
  const sys = "你是中日翻译器。把用户输入的中文翻译成自然流畅、口语化的日语。只输出译文本身，不要任何解释、引号或多余内容。";
  for (let attempt = 1; attempt <= 2; attempt++) {
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
        logTts("ja", "翻译 HTTP " + resp.status + (attempt < 2 ? "，重试" : "") + ": " + t);
      } else {
        const j = await resp.json();
        const out = String((j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "").trim();
        if (out && out.length > 0 && out.length < 400) return out;
        logTts("ja", "翻译返回为空" + (attempt < 2 ? "，重试" : ""));
      }
    } catch (e) {
      logTts("ja", "翻译异常(" + attempt + "): " + (e && e.message || e));
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 1200));
  }
  return "";
}

/* ---------- 云端语音合成助手 ---------- */
function logTts(event, msg) {
  try {
    fs.appendFileSync(path.join(config.APP_DIR, "data", "tts.log"),
      new Date().toISOString() + " [" + event + "] " + msg + "\n");
  } catch { /* 日志失败不影响主流程 */ }
}

async function cosyTts(cosy, clean) {
  const tag = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  const reqFile = path.join(config.APP_DIR, "data", "tts_cosy_req_" + tag + ".json");
  const outFile = path.join(config.APP_DIR, "data", "tts_cosy_" + tag + ".mp3");
  try {
    fs.writeFileSync(reqFile, JSON.stringify({
      apiKey: cosy.apiKey,
      model: cosy.model || "cosyvoice-v3.5-plus",
      voice: cosy.voice,
      text: clean,
      out: outFile,
      rate: cosy.rate,
      pitch: cosy.pitch,
      volume: cosy.volume
    }));
    await new Promise((resolve, reject) => {
      const child = spawn("python", [path.join(config.APP_DIR, "scripts", "cosy_tts.py"), reqFile], { windowsHide: true });
      let err = "";
      child.stderr.on("data", (d) => { err += d; });
      child.on("error", (e) => reject(e));
      child.on("close", (code) => code === 0 ? resolve() : reject(new Error("CosyVoice 退出 " + code + ": " + err.slice(-300))));
    });
    const buf = fs.readFileSync(outFile);
    return buf.length >= 100 ? buf.toString("base64") : "";
  } catch (e) {
    logTts("cosy", "fail: " + (e && e.message || e));
    return "";
  } finally {
    fs.unlink(reqFile, () => {});
    fs.unlink(outFile, () => {});
  }
}

async function edgeTts(c, clean) {
  const tmp = path.join(config.APP_DIR, "data", "tts_tmp.mp3");
  try {
    await new Promise((resolve, reject) => {
      const args = ["-m", "edge_tts", "--voice", c.voice || "zh-CN-XiaoxiaoNeural",
                    "--text", clean, "--write-media", tmp];
      if (c.rate) args.push("--rate=" + c.rate);
      if (c.pitch) args.push("--pitch=" + c.pitch);
      const child = spawn("python", args, { windowsHide: true });
      let err = "";
      child.stderr.on("data", (d) => { err += d; });
      child.on("error", (e) => reject(e));
      child.on("close", (code) => code === 0 ? resolve() : reject(new Error("edge-tts 退出 " + code + ": " + err.slice(0, 200))));
    });
    const buf = fs.readFileSync(tmp);
    return buf.length >= 100 ? buf.toString("base64") : "";
  } catch (e) {
    logTts("edge", "fail: " + (e && e.message || e));
    return "";
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
    // 允许渲染层访问麦克风（语音输入功能）
    const { session } = require("electron");
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(permission === "media");
    });

    createWindow();
    createTray();
    syncWalkingEngine(); // 配置了 Spine+行走时，启动即开始桌面行走

    // 预热本地 Genie TTS 服务器（后台加载模型，不阻塞开窗；声音关闭时不拉起）
    const _q = config.getConfig().ttsGenie || {};
    const _ttsOn = !!(config.getConfig().tts || {}).enabled;
    if (_q.enabled && _ttsOn) {
      ensureGenieServer(_q).then((ok) => logTts("genie", "启动预热: " + (ok ? "已就绪" : "不可用")));
    } else {
      logTts("genie", "声音关闭，跳过服务器预热");
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