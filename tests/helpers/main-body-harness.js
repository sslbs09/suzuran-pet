"use strict";

/*
 * M1 production-path harness.
 * It evaluates the complete main.js source in a VM.  Electron and external
 * services are replaced at the require boundary; canonical State Core and
 * Runtime V2 modules are loaded from the repository unchanged.
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "../..");
const MAIN = path.join(ROOT, "main.js");

function noOp() {}
function asyncNoOp() { return Promise.resolve(null); }

function makeStub(name) {
  const target = { __name: name };
  return new Proxy(target, {
    get(obj, key) {
      if (key in obj) return obj[key];
      if (key === "default") return obj;
      if (typeof key === "symbol") return undefined;
      const fn = (...args) => {
        if (key === "getConfig") return {};
        if (/^(create|build|initialize|load|read|save|start|stop|ensure|open|set|apply|refresh|send|queue|run|dispatch|scan|list|delete|clear|update|add|remove|cancel|complete|snooze|preview|export|pick|import|test|regenerate|speak|playback|voice|translate|fetch)/i.test(String(key))) return null;
        return undefined;
      };
      obj[key] = fn;
      return fn;
    }
  });
}

function makeWindow() {
  const events = new Map();
  const frame = { routingId: 1 };
  const webEvents = new Map();
  let bounds = { x: 100, y: 100, width: 260, height: 200 };
  const webContents = {
    id: 7,
    mainFrame: frame,
    __events: webEvents,
    __messages: [],
    send(name, ...args) { webContents.__messages.push({ name, args }); },
    on(name, fn) { const list = webEvents.get(name) || []; list.push(fn); webEvents.set(name, list); },
    emit(name, ...args) { for (const fn of [...(webEvents.get(name) || [])]) fn(...args); },
    getURL: () => "file:///renderer/index.html",
    isDestroyed: () => false,
    reload() { webContents.__reloads = (webContents.__reloads || 0) + 1; webContents.emit("did-start-loading"); },
    __newDocument() { webContents.mainFrame = { routingId: (webContents.mainFrame.routingId || 0) + 1 }; return webContents.mainFrame; },
    setWindowOpenHandler: noOp,
    onBeforeInputEvent: noOp
  };
  const window = {
    __events: events,
    __setBounds(next) { bounds = { ...bounds, ...next }; },
    on(name, fn) { const list = events.get(name) || []; list.push(fn); events.set(name, list); },
    emit(name, ...args) { for (const fn of [...(events.get(name) || [])]) fn(...args); },
    isDestroyed: () => false,
    isVisible: () => true,
    isMinimized: () => false,
    isResizable: () => false,
    isAlwaysOnTop: () => true,
    getBounds: () => ({ ...bounds }),
    getPosition: () => [bounds.x, bounds.y],
    setPosition(x, y) { bounds = { ...bounds, x: Number(x), y: Number(y) }; },
    setSize(width, height) { bounds = { ...bounds, width: Number(width), height: Number(height) }; },
    setResizable: noOp,
    setIgnoreMouseEvents: noOp,
    setAlwaysOnTop: noOp,
    setVisibleOnAllWorkspaces: noOp,
    setTitle: noOp,
    show: noOp,
    hide: noOp,
    focus: noOp,
    restore: noOp,
    close() { window.__emitWindow("closed"); },
    destroy() { window.__emitWindow("closed"); },
    loadFile: noOp,
    reload: noOp,
    webContents
  };
  window.__emitRenderer = (name, ...args) => webContents.emit(name, ...args);
  window.__emitWindow = (name, ...args) => window.emit(name, ...args);
  return window;
}

function makeElectron() {
  const ipc = { handlers: new Map(), listeners: new Map(), handle(name, fn) { this.handlers.set(name, fn); }, on(name, fn) { this.listeners.set(name, fn); } };
  const appEvents = new Map();
  const app = {
    isReady: () => true,
    whenReady: () => ({ then(fn) { app.__ready = fn; return Promise.resolve(); } }),
    on(name, fn) { appEvents.set(name, fn); },
    emit(name, ...args) { const fn = appEvents.get(name); if (fn) return fn(...args); },
    getPath(name) { return name === "userData" ? path.join(ROOT, ".m1-harness-userdata") : ROOT; },
    setPath: noOp,
    quit: noOp,
    exit: noOp,
    commandLine: { appendSwitch: noOp },
    disableHardwareAcceleration: noOp,
    requestSingleInstanceLock: () => true,
    dock: { hide: noOp }
  };
  class BrowserWindow {
    constructor() { Object.assign(this, makeWindow()); BrowserWindow.instances.push(this); }
    static getAllWindows() { return BrowserWindow.instances.slice(); }
  }
  BrowserWindow.instances = [];
  const screen = { on: noOp, getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }), getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) };
  return {
    app, BrowserWindow, Tray: class { on() {} destroy() {} setToolTip() {} setContextMenu() {} },
    Menu: { buildFromTemplate: (x) => x }, ipcMain: ipc,
    protocol: { registerSchemesAsPrivileged: noOp, handle: noOp },
    safeStorage: { isEncryptionAvailable: () => false }, shell: { openExternal: noOp, openPath: asyncNoOp },
    nativeImage: { createFromPath: () => ({}), createEmpty: () => ({}) }, screen,
    dialog: { showMessageBox: asyncNoOp, showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async () => ({ canceled: true }) },
    Notification: class { show() {} }, powerMonitor: { on: noOp }, nativeTheme: { shouldUseDarkColors: false, on: noOp },
    session: { defaultSession: { setPermissionCheckHandler: noOp, setPermissionRequestHandler: noOp, webRequest: { onBeforeSendHeaders: noOp } } }
  };
}

function configStub() {
  const cfg = {
    agreed: true, firstRun: false, renderMode: "spine", uiLang: "zh", petName: "Test",
    zcodeEnabled: false, keyReady: true, hiddenAtStart: true, greetingOnStart: false,
    window: { width: 260, height: 200, x: 100, y: 100, scale: 1 },
    walk: { enabled: true, speed: 1, groundGap: 0, seatSink: 30 },
    features: {}, chat: { apiKey: "" }, tts: { enabled: false, fixedOnly: true },
    agentApi: { enabled: false }, render: {}, softRender: false
  };
  return {
    APP_DIR: ROOT, STORAGE: { userDir: path.join(ROOT, ".m1-harness-userdata") },
    getConfig: () => cfg, saveConfig: (patch) => Object.assign(cfg, patch),
    getPersonaText: () => "", fillTokens: (s) => s,
    initializeSecretStorage: () => ({}), getConfigPath: () => "", getUserDataDir: () => cfg
  };
}

function loadMain(options = {}) {
  const electron = makeElectron();
  const config = configStub();
  const canonical = {
    "./src/observed-body-truth": require(path.join(ROOT, "src/observed-body-truth")),
    "./src/state-core": require(path.join(ROOT, "src/state-core")),
    "./src/runtime-v2": require(path.join(ROOT, "src/runtime-v2")),
    "./src/walk-geo": require(path.join(ROOT, "src/walk-geo")),
    "./src/render-mode": require(path.join(ROOT, "src/render-mode")),
    "./src/walk-state": require(path.join(ROOT, "src/walk-state")),
    "./src/walk-core": require(path.join(ROOT, "src/walk-core")),
    "./src/character-runtime/sleep-intent": require(path.join(ROOT, "src/character-runtime/sleep-intent")),
    "./src/crash-budget": require(path.join(ROOT, "src/crash-budget")),
    "./src/crash-recovery": require(path.join(ROOT, "src/crash-recovery")),
    "./src/chat-ownership": require(path.join(ROOT, "src/chat-ownership")),
    "./src/clickability": require(path.join(ROOT, "src/clickability")),
    "./src/message-buffer": require(path.join(ROOT, "src/message-buffer")),
    "./src/quit-lifecycle": require(path.join(ROOT, "src/quit-lifecycle")),
    "./src/runtime-lifecycle": require(path.join(ROOT, "src/runtime-lifecycle")),
    "./src/task-queue": require(path.join(ROOT, "src/task-queue")),
    "./src/conversation-service": require(path.join(ROOT, "src/conversation-service"))
  };
  const explicit = {
    electron,
    "./src/config": config,
    "./src/logger": { logTts: noOp },
    "./src/i18n": { t: (_l, key) => key, DICT: { zh: {}, en: {}, ja: {} } },
    "./src/locale": { normalizeLocale: (x) => x || "zh", isAdmittedLocale: () => true },
    "./src/windows": { childWebPrefs: () => ({}) },
    ...canonical,
    ...(options.requireOverrides || {})
  };
  const requireStub = (request) => {
    if (explicit[request]) return explicit[request];
    if (request === "path") return path;
    if (request === "fs") return { ...fs, existsSync: () => false, readFileSync: fs.readFileSync, writeFileSync: noOp, appendFileSync: noOp, mkdirSync: noOp };
    if (request === "crypto") return require("node:crypto");
    if (request === "http") return makeStub("http");
    if (request.startsWith("./") || request.startsWith("../")) return makeStub(request);
    return makeStub(request);
  };
  const clock = { now: 0, nextId: 1, timers: new Map(), intervals: new Map() };
  function fakeSetTimeout(fn, delay = 0) { const id = clock.nextId++; clock.timers.set(id, { fn, at: clock.now + Number(delay || 0) }); return id; }
  function fakeSetInterval(fn, delay = 0) { const id = clock.nextId++; clock.intervals.set(id, { fn, every: Math.max(1, Number(delay || 1)), at: clock.now + Number(delay || 1) }); return id; }
  function fakeClear(id) { clock.timers.delete(id); clock.intervals.delete(id); }
  function advance(ms) {
    const target = clock.now + Number(ms || 0);
    while (true) {
      let next = null;
      for (const [id, t] of clock.timers) if (t.at <= target && (!next || t.at < next.at)) next = { kind: "timer", id, ...t };
      for (const [id, t] of clock.intervals) if (t.at <= target && (!next || t.at < next.at)) next = { kind: "interval", id, ...t };
      if (!next) break;
      clock.now = next.at;
      if (next.kind === "timer") clock.timers.delete(next.id);
      else { const t = clock.intervals.get(next.id); if (t) t.at += t.every; }
      next.fn();
    }
    clock.now = target;
  }
  class TestDate extends Date { static now() { return clock.now; } }
  const source = fs.readFileSync(MAIN, "utf8") + `\n;globalThis.__m1 = {\n  get() { return { win, walk, ipcMain, v2StateCore, v2Authority, v2Commit, v2Drag, v2Locomotion, RUNTIME_V2_LOCOMOTION_ENABLED, renderModeSeq, groundGapDocFloor }; },\n  setWindow(value) { win = value; },\n  setTray(value) { tray = value; },\n  probe(name) { return typeof globalThis[name] === "function" ? globalThis[name] : undefined; },\n  call(name, ...args) { return typeof globalThis[name] === "function" ? globalThis[name](...args) : undefined; },\n  createWindow, startWalkingEngine, stopWalkingEngine, walkOnPhaseEnd, chatPauseWalk, setBodyPosture, setBodyAirborne, startFlight, walkBroadcast, walkTick, chatOwnership\n};`;
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("SUSSURRO_RUNTIME_V2_")));
  Object.assign(cleanEnv, options.env || {});
  const context = { console: { log: noOp, error: noOp, warn: noOp }, require: requireStub, process: { ...process, env: cleanEnv, resourcesPath: ROOT, on: noOp, send: undefined }, __dirname: ROOT, __filename: MAIN, setTimeout: fakeSetTimeout, clearTimeout: fakeClear, setInterval: fakeSetInterval, clearInterval: fakeClear, Date: TestDate, URL, URLSearchParams, Buffer, Response };
  context.globalThis = context;
  vm.createContext(context);
  const savedRuntimeEnv = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("SUSSURRO_RUNTIME_V2_")) savedRuntimeEnv[key] = process.env[key];
  }
  try {
    for (const key of Object.keys(savedRuntimeEnv)) delete process.env[key];
    for (const [key, value] of Object.entries(options.env || {})) process.env[key] = value;
    vm.runInContext(source, context, { filename: MAIN });
  } finally {
    for (const key of Object.keys(process.env)) if (key.startsWith("SUSSURRO_RUNTIME_V2_")) delete process.env[key];
    Object.assign(process.env, savedRuntimeEnv);
  }
  const result = { context, electron, config, ipc: electron.ipcMain, clock, advance, window: electron.BrowserWindow.instances[0] || null,
    handler(name) { return electron.ipcMain.handlers.get(name) || electron.ipcMain.listeners.get(name); },
    setWindow(value) { context.__m1.setWindow(value); return context.__m1.get(); },
    setTray(value) { context.__m1.setTray(value); },
    createWindow() { context.__m1.createWindow(); return context.__m1.get().win; },
    event() { const w = context.__m1.get().win; return { sender: w.webContents, senderFrame: w.webContents.mainFrame, returnValue: undefined }; },
    syncDocument(event = result.event()) { const r = result.handler("pet:body-document-sync"); if (typeof r !== "function") return null; r(event); return event.returnValue; },
    ready(identity, detail = {}, event = result.event()) {
      const r = result.handler("pet:body-ready");
      if (typeof r !== "function") return null;
      const seq = context.__m1.get().renderModeSeq;
      const payload = Object.assign({
        renderModeSeq: seq,
        seq,
        committedMode: "spine",
        usable: true
      }, identity || {}, detail || {});
      return r(event, payload);
    },
    outcome(identity, detail = {}, event = result.event()) {
      const r = result.handler("pet:render-mode-outcome");
      if (typeof r !== "function") return null;
      const seq = context.__m1.get().renderModeSeq;
      const payload = Object.assign({
        seq,
        requestedMode: "spine",
        committedMode: "spine",
        ok: true,
        bodyIdentity: identity
      }, detail || {});
      return r(event, payload);
    },
    messages() { const w = context.__m1.get().win; return w && w.webContents ? w.webContents.__messages.slice() : []; } };
  Object.defineProperty(result, "state", { enumerable: true, get: () => context.__m1.get() });
  return result;
}

module.exports = { loadMain, ROOT };
