"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const gate = require("../src/consent-gate");
const { createOnceRunner } = require("../src/runtime-lifecycle");
const main = fs.readFileSync(require.resolve("../main.js"), "utf8");
function section(start, end) {
  const a = main.indexOf(start), b = main.indexOf(end, a);
  assert.ok(a >= 0 && b > a, "production source boundaries exist");
  return main.slice(a, b);
}
// Execute production ready/activate/second-instance, initializer, window gate and
// accept IPC verbatim. Only Electron and external service effects are replaced.
function boot(agreed, options = {}) {
  const calls = {}, timers = [], events = {}, ipc = {}, order = [];
  const hit = name => { calls[name] = (calls[name] || 0) + 1; order.push(name); };
  const stub = name => () => hit(name);
  const cfg = { agreed, firstRun: !!options.firstRun, firstRunAt: 1, chat: { apiKey: "" },
    tts: { enabled: true }, ttsGenie: { enabled: true }, agentApi: { enabled: true },
    features: { workspaceWatch: { enabled: true }, clipboardWatch: true, systemMonitor: true } };
  let ready;
  const context = {
    ...gate, createOnceRunner, gotLock: true, quitting: false, win: null, termsWin: null,
    barrierTimer: null, walk: {}, personaCache: "", path, safeStorage: {},
    console: { log() {}, error() {} }, PROACTIVE_DEFAULTS: { intervalMin: 1, chance: 1 },
    app: { isReady: () => true, whenReady: () => ({ then(fn) { ready = fn; } }),
      on(name, fn) { assert.ok(!events[name], "handler registered once"); events[name] = fn; }, quit: stub("quit") },
    ipcMain: { handle(name, fn) { ipc[name] = fn; } },
    config: { APP_DIR: "/mock", getConfig(force) { if (force) hit("forceRead"); return cfg; },
      saveConfig(patch) { if (options.saveFailure) throw new Error("save failure"); hit("persist"); Object.assign(cfg, patch); },
      initializeSecretStorage: () => ({}), getPersonaText: () => "" },
    logTts() {}, refreshTrayMenu: stub("refreshMenu"), sendToRenderer: stub("send"),
    // 5-E2：窗口 title 改走 catalog，本 harness 需提供 i18n / currentUiLang / setTitle
    i18n: { t: (lang, key) => key },
    locale: { normalizeLocale: (v) => v || "zh", isAdmittedLocale: () => true },
    createTray() { hit(cfg.agreed === true ? "normalTray" : "pendingTray"); },
    createWindow() { hit("createWindow"); context.win = { isDestroyed: () => false, isVisible: () => false,
      show: stub("show"), focus: stub("focus"), setIgnoreMouseEvents() {}, setTitle() {} }; },
    applyNetProxy() { hit("runtime"); if (options.runtimeFailure) throw new Error("injected startup failure"); },
    memory: { init() {}, load() {}, wasTampered: () => false },
    screen: { on: stub("screenListener") }, schedules: { initialize: stub("schedule") },
    features: { setProactiveEnabled() {}, startProactive: stub("proactive"), startJaPrewarm: stub("translation"),
      startClipboardWatch: stub("clipboard"), startSystemMonitor: stub("system") },
    tts: { ensureGenieServer() { hit("tts"); return Promise.resolve(true); } },
    setTimeout(fn, delay) { timers.push({ fn, delay }); return timers.length; },
    setInterval() { hit("interval"); return calls.interval; }, clearInterval() {},
    require(name) {
      if (name === "electron") return { crashReporter: { start() {} }, session: { defaultSession: {
        setPermissionCheckHandler() {}, setPermissionRequestHandler() {} } }, globalShortcut: { register: stub("shortcut") } };
      if (name === "./src/vector-memory") return { init() {} };
      throw new Error("unexpected dependency: " + name);
    },
    BrowserWindow: class {
      constructor() { hit("terms"); this.handlers = {}; this.destroyed = false; this.minimized = false; }
      isDestroyed() { return this.destroyed; }
      isMinimized() { return this.minimized; }
      restore() { this.minimized = false; hit("restoreTerms"); }
      show() { hit("showTerms"); }
      focus() { hit("focusTerms"); }
      setTitle() {}
      on(name, fn) { this.handlers[name] = fn; }
      setMenuBarVisibility() {}
      loadFile() {}
    }, winChild: { childWebPrefs: () => ({}) }, attachCrashDiag() {}
  };
  for (const name of ["syncNativeTheme", "relaunchIfAppDirNewer", "registerUserAssetProtocol", "startupUpdateCheck",
    "sendScheduleDue", "refreshPetName", "applyPetWindowTitle", "applyNativeWindowTitles", "currentUiLang",
    "scheduleDisplayClamp", "refreshWinBarriers", "syncWalkingEngine",
    "walkDiag", "setFileGuard", "runDllGuard", "startAgentApi", "sendProactive", "proactiveStateFn",
    "startFocusWatch", "startWeatherWatch", "startWorkspaceWatch", "openSettings", "applyLayer", "clearDragPause",
    "cancelFlight", "cancelWalkJump"]) context[name] = stub(name);
  context.applyNativeIgnore = () => {}; // native 穿透写唯一入口（定义于下部切片外）：静默 no-op，本测试只验窗口/生命周期接线，不记录 order
  if (options.partialFailure) context.startAgentApi = () => { hit("startAgentApi"); throw new Error("partial startup failure"); };
  vm.createContext(context);
  vm.runInContext(section("function isWindowVisible()", "/* ---------- 显示层级"), context);
  vm.runInContext(section("function openTerms()", 'ipcMain.handle("pet:open-terms"'), context);
  vm.runInContext(section("let normalRuntimeRunner = null;", '  app.on("window-all-closed"') + "\n}", context);
  ready();
  return { context, calls, cfg, events, ipc, timers, order,
    count: name => calls[name] || 0,
    state: () => vm.runInContext("normalRuntimeRunner && normalRuntimeRunner.state", context),
    fire: delay => timers.filter(t => t.delay === delay).forEach(t => t.fn()) };
}
function assertNoRuntime(h) {
  for (const key of ["runtime", "createWindow", "normalTray", "syncWalkingEngine", "startAgentApi", "schedule",
    "tts", "proactive", "translation", "startFocusWatch", "startWeatherWatch", "startWorkspaceWatch", "interval", "shortcut"])
    assert.equal(h.count(key), 0, key);
}
test("production pending ready never starts pet/services", () => {
  const h = boot(false); assertNoRuntime(h); assert.equal(h.count("pendingTray"), 1);
  h.fire(600); assert.equal(h.count("terms"), 1);
});
test("production accepted ready initializes exactly once", () => {
  const h = boot(true); h.events.activate(); h.events["second-instance"]();
  for (const key of ["runtime", "createWindow", "normalTray", "syncWalkingEngine", "startAgentApi", "schedule", "tts", "shortcut"])
    assert.equal(h.count(key), 1, key);
  assert.equal(h.state(), "started");
});
test("production accept persists before startup and succeeds once", () => {
  const h = boot(false); assert.equal(h.ipc["pet:agree-terms"]().ok, true);
  assert.equal(h.cfg.agreed, true); assert.ok(h.order.indexOf("persist") < h.order.indexOf("runtime"));
  assert.equal(h.ipc["pet:agree-terms"]().ok, true); assert.equal(h.count("runtime"), 1);
  assert.equal(h.count("createWindow"), 1);
});
test("production accept save failure stays pending", () => {
  const h = boot(false, { saveFailure: true }); assert.equal(h.ipc["pet:agree-terms"]().ok, false);
  assert.equal(h.cfg.agreed, false); assertNoRuntime(h);
});
test("production accept runtime failure preserves acceptance without retry", () => {
  const h = boot(false, { runtimeFailure: true }); const result = h.ipc["pet:agree-terms"]();
  assert.equal(result.ok, false); assert.equal(result.accepted, true); assert.equal(result.runtimeFailed, true);
  assert.equal(h.cfg.agreed, true); assert.equal(h.state(), "failed");
  h.ipc["pet:agree-terms"](); h.events.activate(); h.context.showWindow();
  assert.equal(h.count("runtime"), 1); assert.equal(h.count("createWindow"), 0);
});
test("production partial startup failure never duplicates initialized services", () => {
  const h = boot(false, { partialFailure: true });
  assert.equal(h.ipc["pet:agree-terms"]().runtimeFailed, true);
  assert.equal(h.count("createWindow"), 1);
  const intervals = h.count("interval");
  h.ipc["pet:agree-terms"](); h.events.activate(); h.context.showWindow();
  assert.equal(h.cfg.agreed, true); assert.equal(h.state(), "failed");
  assert.equal(h.count("runtime"), 1); assert.equal(h.count("createWindow"), 1);
  assert.equal(h.count("syncWalkingEngine"), 1); assert.equal(h.count("startAgentApi"), 1);
  assert.equal(h.count("interval"), intervals);
});
for (const action of ["activate", "showWindow", "toggleWindow", "second-instance"]) {
  test("production accepted destroyed window recovers via " + action, () => {
    const h = boot(true); h.context.win = { isDestroyed: () => true };
    const intervals = h.count("interval"), listeners = h.count("screenListener");
    if (h.events[action]) h.events[action](); else h.context[action]();
    assert.equal(h.count("createWindow"), 2); assert.equal(h.count("runtime"), 1);
    assert.equal(h.count("startAgentApi"), 1); assert.equal(h.count("syncWalkingEngine"), 1);
    assert.equal(h.count("interval"), intervals); assert.equal(h.count("screenListener"), listeners);
    assert.equal(h.count("normalTray"), 1);
    if (action !== "activate") assert.ok(h.count("show") > 0);
  });
}
test("production pending activate/show/toggle/second-instance only open terms", () => {
  const h = boot(false); h.events.activate(); h.context.showWindow(); h.context.toggleWindow(); h.events["second-instance"]();
  assertNoRuntime(h); assert.equal(h.count("terms"), 1);
});
test("production delayed terms rechecks persisted consent", () => {
  const h = boot(false); h.cfg.agreed = true; h.fire(600);
  assert.equal(h.count("terms"), 0); assert.ok(h.count("forceRead") > 0);
});
test("production delayed terms does not open during quit", () => {
  const h = boot(false); h.context.quitting = true; h.fire(600); assert.equal(h.count("terms"), 0);
});
test("production terms singleton restores hidden/minimized window", () => {
  const h = boot(false); h.events.activate(); h.context.termsWin.minimized = true;
  h.events.activate(); assert.equal(h.count("terms"), 1); assert.equal(h.count("restoreTerms"), 1);
  assert.equal(h.count("showTerms"), 1); assert.equal(h.count("focusTerms"), 1);
});
test("production pending terms close quits without accepting", () => {
  const h = boot(false); h.fire(600); h.context.termsWin.handlers.closed();
  assert.equal(h.cfg.agreed, false); assert.equal(h.count("quit"), 1); assertNoRuntime(h);
});
test("production accepted terms close does not quit", () => {
  const h = boot(false); h.fire(600); h.ipc["pet:agree-terms"](); h.context.termsWin.handlers.closed();
  assert.equal(h.count("quit"), 0); assert.equal(h.cfg.agreed, true);
});
test("production firstRun is deferred and scheduled only once", () => {
  const h = boot(false, { firstRun: true }); assert.equal(h.timers.filter(t => t.delay === 1200).length, 0);
  h.ipc["pet:agree-terms"](); h.events.activate();
  assert.equal(h.cfg.firstRun, false); assert.equal(h.timers.filter(t => t.delay === 1200).length, 1);
});

function termsRenderer(result, lang = "zh") {
  const callbacks = {}, hint = {}, button = {}, events = {};
  let closes = 0, refuses = 0, invokes = 0;
  button.addEventListener = (name, fn) => { callbacks[name] = fn; };
  const i18n = require("../src/i18n");
  // 5-E1：条款页失败提示改由 catalog 呈现，沙箱需提供真实 I18N 契约
  const I18N = {
    t: (key) => i18n.t(lang, key, key),
    apply: () => {}, onChange: () => () => {}, ready: () => true, lang: () => lang
  };
  const presenter = require("../src/error-presenter");
  const context = { document: { getElementById(id) { return id === "btn-agree" ? button : { addEventListener() {} }; },
    querySelector: () => hint },
    window: { I18N, ErrorPresenter: presenter,
      petAPI: { getI18n: async () => ({ lang, dict: i18n.getEffectiveDict(lang) }), onUiLangChanged() {},
        agreeTerms: async () => { invokes++; return result; },
      refuseTerms: () => { refuses++; } },
      close: () => { closes++; }, addEventListener(name, fn) { events[name] = fn; } } };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(require.resolve("../renderer/terms.js"), "utf8"), context);
  return { click: callbacks.click, unload: () => events.beforeunload(), hint, button,
    state: () => ({ agreed: vm.runInContext("agreed", context), closes, refuses, invokes }) };
}
test("production terms renderer keeps saved consent on runtime failure and disables retries", async () => {
  const h = termsRenderer({ ok: false, code: "INTERNAL", accepted: true, runtimeFailed: true, message: "已记录同意，但桌宠启动失败，请重启应用" });
  await h.click(); await h.click(); h.unload();
  assert.deepEqual(h.state(), { agreed: true, closes: 0, refuses: 0, invokes: 1 });
  assert.equal(h.button.disabled, true);
  // 5-E1：文案来自 catalog，不再是硬编码中文字面量
  assert.equal(h.hint.textContent, require("../src/i18n").t("zh", "page.terms.runtimeFailedHint"));
  assert.match(h.hint.textContent, /重启/, "仍保留可操作的重启指引");
});
test("production terms renderer renders consent failure in the active locale", async () => {
  for (const lang of ["zh", "en", "ja"]) {
    const i18n = require("../src/i18n");
    const h = termsRenderer({ ok: false, code: "INTERNAL", accepted: true, runtimeFailed: true }, lang);
    await h.click();
    assert.equal(h.hint.textContent, i18n.t(lang, "page.terms.runtimeFailedHint"), lang);
  }
});
test("production terms renderer allows retry only for save failure", async () => {
  const h = termsRenderer({ ok: false, code: "INTERNAL" }); await h.click();
  assert.equal(h.state().agreed, false); assert.equal(h.button.disabled, false);
  assert.equal(h.state().closes, 0); h.unload(); assert.equal(h.state().refuses, 1);
});
test("production terms renderer closes after success", async () => {
  const h = termsRenderer({ ok: true }); await h.click(); h.unload();
  assert.deepEqual(h.state(), { agreed: true, closes: 1, refuses: 0, invokes: 1 });
});
