"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");
const i18n = require("../src/i18n");
const errorFacts = require("../src/error-facts");
const errorPresenter = require("../src/error-presenter");
const locale = require("../src/locale");

const root = path.join(__dirname, "..");
const baseline = process.env.ERROR_SURFACE_BASELINE === "1";
const langs = ["zh", "en", "ja"];
const hostile = "PRIVATE provider body sk-live-exampleabcdefgh123 Bearer TOKEN_EXAMPLE_SECRET https://alice:password@example.invalid/path";
const sources = new Map();
const plain = (value) => JSON.parse(JSON.stringify(value));
function read(file) { return fs.readFileSync(path.join(root, file), "utf8"); }
function source(file) {
  if (!sources.has(file)) sources.set(file, baseline
    ? execFileSync("git", ["show", `2d58477:${file}`], { cwd: root, encoding: "utf8" })
    : read(file));
  return sources.get(file);
}
// Parse complete declarations/statements rather than counting braces inside
// templates or default arguments. Missing markers are fixture errors, not RED.
function extract(text, marker, terminator) {
  const start = text.indexOf(marker);
  assert.notEqual(start, -1, `production source contains ${marker}`);
  for (let end = text.indexOf(terminator, start); end >= 0; end = text.indexOf(terminator, end + 1)) {
    const candidate = text.slice(start, end + 1);
    try { new vm.Script(candidate); return candidate; } catch { /* incomplete */ }
  }
  throw new Error(`No complete production region: ${marker}`);
}
const fn = (text, marker) => extract(text, marker, "}");
const statement = (text, marker) => extract(text, marker, ";");
function functions(s, file, markers) {
  for (const marker of markers) vm.runInContext(fn(source(file), marker), s);
}
/** Phase 5-G2：共享 renderer 适配器——页面不再自带 presentError 实现，
 *  测试沙箱必须装载与生产同一份 error-present.js（只装载，不替换生产实现）。 */
function loadAdapter(s) {
  vm.runInContext(read("renderer/error-present.js"), s);
  assert.ok(s.ErrorPresent, "renderer/error-present.js installed window.ErrorPresent");
}
function presenter(s, file, name = "presentError") {
  // 5-G2 起页面只保留一行转发；先装适配器，再装页面转发
  loadAdapter(s);
  const marker = read(file).includes(`function ${name}(`) ? `function ${name}(` : `const ${name} =`;
  const text = source(file).includes(marker) ? source(file) : read(file);
  vm.runInContext(marker.startsWith("function") ? fn(text, marker) : statement(text, marker), s);
}
function node(tag = "div") {
  const classes = new Set();
  return {
    tag, children: [], listeners: new Map(), style: {}, dataset: {}, attributes: {},
    textContent: "", innerHTML: "", title: "", className: "", value: "", checked: false,
    disabled: false, hidden: false, scrollTop: 0, clientHeight: 100, scrollHeight: 100,
    classList: { add: (x) => classes.add(x), remove: (x) => classes.delete(x), contains: (x) => classes.has(x) },
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } },
    appendChild(child) { this.append(child); return child; },
    replaceChildren(...children) { this.children = []; this.append(...children); },
    addEventListener(event, callback) { this.listeners.set(event, callback); },
    setAttribute(key, value) { this.attributes[key] = value; },
    async fire(event = "click", value = {}) {
      const callback = this.listeners.get(event) || this[`on${event}`];
      assert.equal(typeof callback, "function", `registered ${event} handler`);
      return callback(value);
    }
  };
}
async function renderer(lang) {
  let currentLang = lang;
  let localeEvent;
  const nodes = new Map();
  const get = (id) => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); };
  const s = {
    console, window: null, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    document: { documentElement: {}, querySelectorAll: () => [], getElementById: get, createElement: node },
    petAPI: { getI18n: async () => ({ lang: currentLang, dict: i18n.getEffectiveDict(currentLang) }), onUiLangChanged: (cb) => { localeEvent = cb; } },
    addEventListener() {}, $: get
  };
  s.window = s;
  vm.createContext(s);
  vm.runInContext(read("src/error-presenter.js"), s);
  vm.runInContext(read("renderer/i18n.js"), s);
  await new Promise((resolve) => setImmediate(resolve));
  s.L = s.I18N.t;
  s.INTERNAL_FAILURE = Object.freeze({ code: "INTERNAL" });
  return { s, get, async changeLang(next) {
    currentLang = next;
    assert.equal(typeof localeEvent, "function");
    localeEvent();
    await new Promise((resolve) => setImmediate(resolve));
  } };
}
function safe(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const leak of ["PRIVATE", "sk-live-example", "TOKEN_EXAMPLE_SECRET", "alice:password", "provider body"]) {
    assert.ok(!text.includes(leak), `active output contains ${leak}: ${text}`);
  }
}
function expected(lang, code, meta) {
  const p = errorPresenter.toPresentation({ code, meta });
  return i18n.t(lang, p.key, p.params);
}
function scheduleModule(options = {}) {
  const s = { module: { exports: {} }, setTimeout: () => 0, clearTimeout() {}, require(name) {
    if (name === "./storage") return { PATHS: { userDir: "controlled-storage" }, atomicWrite: options.atomicWrite || (() => {}) };
    if (name === "fs") return { readFileSync: () => JSON.stringify({ schedules: options.records || [] }) };
    return require(name);
  } };
  vm.createContext(s);
  vm.runInContext(source("src/schedules.js"), s);
  return s.module.exports;
}
function main(overrides = {}) {
  const handlers = new Map(), logs = [];
  const s = {
    console, errorFacts, errorPresenter, i18n, locale, path, URL, Buffer, AbortSignal,
    schedules: scheduleModule(), app: { getVersion: () => "test-version" },
    config: { STORAGE: { logs: "controlled-logs" }, getConfig: () => ({ uiLang: "zh" }) },
    logTts: (event, message) => logs.push({ event, message }),
    ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) }, ...overrides
  };
  vm.createContext(s);
  // 5-E2：native 对话框/窗口标题改走 i18n.t(currentUiLang(), …)，本 harness 需提供该取名函数
  for (const marker of ["function projectedFailure(", "function localizedFailure(", "function currentUiLang("]) {
    vm.runInContext(fn(read("main.js"), marker), s);
  }
  return { s, logs, handler(channel) {
    vm.runInContext(statement(source("main.js"), `ipcMain.handle(${JSON.stringify(channel)}`), s);
    assert.ok(handlers.has(channel), `${channel} actually registered`);
    return handlers.get(channel);
  } };
}

test("D2 supplemental guards preserve shared wiring and remove direct UI catch echoes", { skip: baseline }, () => {
  for (const name of ["addchar", "docs", "voice", "psd", "schedule", "moods", "settings", "terms"]) {
    const html = read(`renderer/${name}.html`);
    assert.ok(html.includes("../src/error-presenter.js"));
    assert.ok(html.indexOf('src="../src/error-presenter.js"') < html.indexOf('src="error-present.js"'),
      `${name}: presenter loads before the shared adapter`);
    assert.ok(html.indexOf('src="error-present.js"') < html.indexOf(`src="${name}.js"`),
      `${name}: shared adapter loads before ${name}.js`);
    // 5-G2：页面不得再自带 ErrorPresenter 调用（映射决策只存在于 src/error-presenter.js）
    // 比对前剥掉注释——文档里描述数据流时提到该函数名不算实现。
    const pageCode = read(`renderer/${name}.js`).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(pageCode, /ErrorPresenter\.toPresentation/,
      `${name}.js must route through the shared adapter, not the presenter directly`);
    assert.match(pageCode, /ErrorPresent\./,
      `${name}.js must use the shared adapter`);
  }
  assert.doesNotMatch(read("renderer/pet.js"), /showError\(String\(e\)\)/);
  assert.doesNotMatch(read("renderer/settings.js"), /badge\.title = item\.errorCode/);
});

test("production voice status DOM rejects remote fail and respects invalid code presence", async () => {
  for (const lang of langs) {
    const { s, get } = await renderer(lang);
    presenter(s, "renderer/voice.js");
    vm.runInContext("let _voiceStatus = null;", s);
    functions(s, "renderer/voice.js", ["function renderStatus()"]);
    const cases = [
      [{ deployed: true, ready: false, fail: hostile }, i18n.t(lang, "page.voice.unknownReason")],
      [{ deployed: true, ready: false, code: "INTERNAL", fail: hostile }, expected(lang, "INTERNAL")],
      [{ deployed: true, ready: false, code: "HTTP_ERROR", meta: { status: 503 }, fail: hostile }, expected(lang, "HTTP_ERROR", { status: 503 })],
      ...["unknown", "", null, false, 0, {}].map((code) => [{ deployed: true, ready: false, code, fail: hostile, message: hostile }, expected(lang, code)])
    ];
    for (const [snapshot, reason] of cases) {
      s.snapshot = snapshot;
      vm.runInContext("_voiceStatus = snapshot; renderStatus();", s);
      assert.equal(get("status-card").textContent, i18n.t(lang, "page.voice.statusNotReady", { reason }));
      safe(get("status-card").textContent);
      assert.ok(get("clone-form").classList.contains("disabled"));
    }
    s.snapshot = { deployed: true, ready: true, character: "test-character" };
    vm.runInContext("_voiceStatus = snapshot; renderStatus();", s);
    assert.equal(get("status-card").textContent, i18n.t(lang, "page.voice.statusReady", { char: "test-character" }));
    assert.ok(!get("clone-form").classList.contains("disabled"));
  }
});

test("production fixed-line renderer attaches localized badge titles in all locales", async () => {
  for (const lang of langs) {
    const { s, get } = await renderer(lang);
    presenter(s, "renderer/settings.js", "presentResultError");
    Object.assign(s, { engineLabel: () => "system", poolLabel: () => "pool", stateLabel: () => "failed", formatBytes: () => "0 B", renderFixedLinePools() {}, fixedLineShowAll: true });
    functions(s, "renderer/settings.js", ["function renderFixedLinePool("]);
    const codes = ["INTERNAL", "HTTP_ERROR", "timeout", "synth", "disabled", "nopath", hostile];
    s.snapshot = { profile: { engine: "system" }, summary: { total: codes.length, failed: codes.length }, items: codes.map((code, index) => ({ state: "failed", text: "line", pool: "p", id: String(index), errorCode: code })) };
    vm.runInContext("renderFixedLinePool(snapshot)", s);
    const list = get("fixed-lines-list");
    assert.equal(list.children.length, codes.length);
    for (const [index, row] of list.children.entries()) {
      const badge = row.children.find((child) => child.className.startsWith("fixed-line-state "));
      assert.ok(badge && badge.parent === row && row.parent === list, "actual attached badge");
      assert.equal(badge.title, expected(lang, codes[index]));
      safe(badge.title);
    }
  }
});

test("production pet rejection renders INTERNAL and keeps bubble lifecycle", async () => {
  for (const lang of langs) {
    const { s } = await renderer(lang);
    loadAdapter(s); // 5-G2：pet.js 的错误呈现已走共享适配器
    const bubble = node();
    let asks = 0;
    Object.assign(s, { agreed: true, isSpeakingAudio: false, ttsConfig: { enabled: false }, inputEl: { value: "hello" }, replyBuffer: "", bubbleText: bubble, bubbleEl: bubble, busy: true, wake() {}, setMood() {}, showBubble() {}, hideThinking() {}, showThinking() {}, updateControls() {}, scheduleBubbleHide() {} });
    s.petAPI.ask = async () => { asks++; throw new Error(hostile); };
    // sendText owns the task before IPC; keep the extracted fixture on the
    // same production owner/id path so the rejection reaches its real catch.
    vm.runInContext("let chatTaskId = null; let chatTaskRevision = 0; let chatTaskSeq = 0;", s);
    functions(s, "renderer/pet.js", ["function beginChatTask(", "function showError(", "async function sendText("]);
    await vm.runInContext("sendText('hello')", s);
    assert.equal(bubble.textContent, "苏苏洛委屈地撇撇嘴：" + expected(lang, "INTERNAL"));
    safe(bubble.textContent);
    assert.equal(asks, 1);
    assert.equal(s.busy, false);
    assert.equal(s.inputEl.value, "");
    assert.ok(bubble.classList.contains("error"));
  }
});

test("production PSD parse failure replays through its existing locale owner without business actions", async () => {
  const { s, get, changeLang } = await renderer("zh");
  let parses = 0, reads = 0;
  const diagnostic = [];
  presenter(s, "renderer/psd.js");
  vm.runInContext("let psd = null, _lastStatus = null, _lastMeta = null, _parseHint = false, _rigInfo = null, previewImg = null, lastPsdBuf = null, lastPsdPath = null;", s);
  functions(s, "renderer/psd.js", ["function setStatusL(", "function renderStatus()", "function renderMeta()", "function renderPreviewHint()", "function renderRigInfo()", "function dbg(", "async function loadFile("]);
  s.petAPI.playback = (message) => diagnostic.push(message);
  s.agPsd = { readPsd() { parses++; throw new Error(hostile); } };
  // 6-A 重命名后：守卫名必须跟生产函数名一致，否则这个「意外调用即抛」的护栏会静默失效
  s.buildTree = s.renderSelButton = () => { throw new Error("unexpected tree action after failure"); };
  vm.runInContext(statement(source("renderer/psd.js"), "if (window.I18N && window.I18N.onChange) window.I18N.onChange("), s);
  s.file = { name: "fixture.psd", path: "controlled.psd", async arrayBuffer() { reads++; return new ArrayBuffer(1); } };
  await vm.runInContext("loadFile(file)", s);
  assert.equal(get("status").textContent, i18n.t("zh", "page.psd.parseFailed", { error: expected("zh", "INTERNAL") }));
  const before = { parses, reads, logs: diagnostic.length };
  for (const lang of ["en", "ja"]) {
    await changeLang(lang);
    assert.equal(get("status").textContent, i18n.t(lang, "page.psd.parseFailed", { error: expected(lang, "INTERNAL") }));
    safe(get("status").textContent);
    assert.deepEqual({ parses, reads, logs: diagnostic.length }, before);
  }
  assert.equal(parses, 1);
  assert.equal(reads, 1);
  assert.ok(diagnostic.some((message) => message.includes(hostile)), "existing explicit diagnostic route preserved");
  for (const emptyResult of [null, undefined, {}]) {
    s.emptyResult = emptyResult;
    vm.runInContext("setStatusL('page.psd.exportFailed', { error: emptyResult }, true)", s);
    assert.equal(get("status").textContent, i18n.t("ja", "page.psd.exportFailed", { error: expected("ja", "UNKNOWN") }));
  }
  assert.deepEqual({ parses, reads, logs: diagnostic.length }, before);
});

test("production native update dialog retains context and localizes hostile failure", async () => {
  for (const lang of langs) {
    const dialogs = [], toasts = [];
    let checks = 0;
    const { s } = main({ config: { getConfig: () => ({ uiLang: lang }) }, updater: { checkForUpdateDetailed: async () => ({ ok: false, error: hostile }) }, dialog: { showMessageBox: (value) => dialogs.push(value) }, sendToRenderer: (channel, message) => toasts.push({ channel, message }), noteUpdateChecked: () => { checks++; } });
    functions(s, "main.js", ["async function trayCheckUpdate()"]);
    await vm.runInContext("trayCheckUpdate()", s);
    assert.equal(dialogs.length, 1);
    assert.equal(dialogs[0].type, "error");
    assert.equal(dialogs[0].message, i18n.t(lang, "tray.updateCheckFail", { reason: expected(lang, "INTERNAL") }));
    safe(dialogs[0]);
    assert.equal(checks, 1);
    assert.equal(toasts.length, 1);
    safe(toasts);
  }
});

test("production voice HTTP failure exposes bounded envelopes and persists status only", async () => {
  for (const channel of ["pet:apply-voice", "pet:tts-preview"]) for (const status of [401, 429, 503]) {
    const requests = [];
    let bodyReads = 0, saves = 0;
    const m = main({ config: { getConfig: () => ({ ttsGenie: { python: "python", serverScript: "server.py", server: "http://127.0.0.1:9881" } }), saveConfig: () => { saves++; } }, tts: { ensureGenieServer: async () => true }, safeFetch: async (...args) => { requests.push(args); return { ok: false, status, async text() { bodyReads++; return hostile; } }; } });
    const result = await m.handler(channel)(null, { audioPath: "ref.wav", text: "test", refAudio: "ref.wav", refText: "test" });
    safe(result); safe(m.logs);
    const fact = errorFacts.codeForHttpStatus(status);
    assert.deepEqual(plain(result), { ok: false, message: channel === "pet:apply-voice" ? "服务器返回 " + status : "HTTP " + status, code: fact.code, meta: fact.meta });
    assert.deepEqual(m.logs, [{ event: "genie", message: (channel === "pet:apply-voice" ? "set_reference HTTP " : "tts preview HTTP ") + status }]);
    assert.equal(requests.length, 1); assert.equal(bodyReads, 1); assert.equal(saves, 0);
    assert.ok(requests[0][0].endsWith(channel === "pet:apply-voice" ? "/set_reference" : "/tts"));
  }
});

test("production schedule validation remains actionable while genuine storage exceptions are coded", () => {
  const valid = { title: "fixture", date: "2099-10-05", time: "09:00", recurrence: "none" };
  for (const [input, message] of [[{ ...valid, title: "" }, "日程标题不能为空且最多 160 字"], [{ ...valid, date: "invalid" }, "日期或时间无效，请使用 YYYY-MM-DD 和 HH:mm"], [{ ...valid, recurrence: "invalid" }, "重复规则无效"]]) {
    const result = main().handler("pet:add-schedule")(null, input);
    assert.deepEqual(plain(result), { ok: false, error: message });
    assert.ok(!Object.hasOwn(result, "code"));
  }
  const full = scheduleModule({ records: Array.from({ length: 500 }, (_, index) => ({ id: String(index), status: "completed", externalId: String(index) })) });
  full.initialize(() => {});
  assert.deepEqual(plain(main({ schedules: full }).handler("pet:add-schedule")(null, valid)), { ok: false, error: "日程数量已达上限" });
  const broken = scheduleModule({ atomicWrite() { throw new Error(hostile); } });
  const result = main({ schedules: broken }).handler("pet:add-schedule")(null, valid);
  assert.equal(result.code, "INTERNAL"); assert.deepEqual(plain(result.meta), {});
  // message remains a redacted compatibility field; presentation never uses it.
  assert.ok(!Object.hasOwn(result, "detail"));
  assert.ok(!result.error.includes("sk-live-example"));
  const reminder = main().handler("pet:set-reminder")(null, { text: "", at: Date.UTC(2099, 9, 5, 9) });
  assert.deepEqual(plain(reminder), { ok: false, message: "日程标题不能为空且最多 160 字" });
});

test("production workbook preserves static validation and codes parser/FS exceptions", () => {
  function workbook(overrides = {}) {
    const m = main({ fs: { existsSync: () => true, statSync: () => ({ size: 1 }) }, XLSX: { readFile: () => ({ SheetNames: ["sheet"], Sheets: { sheet: {} } }), utils: { sheet_to_json: () => [{ title: "fixture", date: "2099-10-05", time: "09:00" }] } }, ...overrides });
    functions(m.s, "main.js", ["function parseScheduleWorkbook("]);
    return m.handler("pet:preview-schedule-workbook");
  }
  assert.deepEqual(plain(workbook()(null, "wrong.txt")), { ok: false, error: "Excel 文件无效或超过 5MB" });
  assert.deepEqual(plain(workbook({ XLSX: { readFile: () => ({ SheetNames: ["a", "b"] }) } })(null, "fixture.xlsx")), { ok: false, error: "Excel 必须只包含一个工作表" });
  const emptyRows = { XLSX: { readFile: () => ({ SheetNames: ["a"], Sheets: { a: {} } }), utils: { sheet_to_json: () => [] } } };
  assert.deepEqual(plain(workbook(emptyRows)(null, "fixture.xlsx")), { ok: false, error: "Excel 需包含 1~500 条日程" });
  for (const overrides of [{ XLSX: { readFile() { throw new Error(hostile); } } }, { fs: { existsSync: () => true, statSync() { throw new Error(hostile); } } }]) {
    const result = workbook(overrides)(null, "fixture.xlsx");
    assert.equal(result.code, "INTERNAL"); assert.deepEqual(plain(result.meta), {});
    assert.ok(!Object.hasOwn(result, "detail")); assert.ok(!result.error.includes("sk-live-example"));
  }
});

test("production schedule add DOM maps storage failure and retains source validation", async () => {
  for (const lang of langs) {
    const { s, get } = await renderer(lang);
    loadAdapter(s); // 5-G2：整文件装载前先装共享适配器
    for (const [id, value] of Object.entries({ title: "fixture", date: "2099-10-05", time: "09:00", recurrence: "none" })) get(id).value = value;
    const broken = scheduleModule({ atomicWrite() { throw new Error(hostile); } });
    let add = main({ schedules: broken }).handler("pet:add-schedule");
    s.petAPI.addSchedule = (input) => Promise.resolve(add(null, input));
    // 5-E3 起 schedule.js 的失败文案先落 module state 再投影，抽取单条语句不再自洽：
    // 改为装载真实模块（含 state 声明与 render*），保持"跑生产代码本身"不变。
    s.petAPI.getSchedules = async () => [];
    s.petAPI.onScheduleDue = () => {};
    vm.runInContext(read("renderer/schedule.js"), s);
    await get("add").fire();
    assert.equal(get("result").textContent, expected(lang, "INTERNAL")); safe(get("result").textContent);
    add = main().handler("pet:add-schedule");
    get("title").value = "";
    await get("add").fire();
    assert.equal(get("result").textContent, "日程标题不能为空且最多 160 字");
  }
});

test("production docs FS failure renders escaped localized DOM through actual IPC result", async () => {
  for (const lang of langs) {
    const { s, get } = await renderer(lang);
    const readDoc = main({ docsManifest: () => [{ key: "fixture", file: "fixture.md" }], fs: { readFileSync() { throw new Error(hostile); } } }).handler("docs:read");
    s.petAPI.docsRead = (key) => Promise.resolve(readDoc(null, key));
    presenter(s, "renderer/docs.js");
    functions(s, "renderer/docs.js", ["function esc(", "async function openDoc("]);
    await vm.runInContext("openDoc({key:'fixture',name:'Fixture'})", s);
    assert.equal(get("docs-content").innerHTML, '<p style="color:#c0392b">文档读取失败：' + expected(lang, "INTERNAL") + "</p>");
    safe(get("docs-content").innerHTML);
    assert.equal(get("docs-content").hidden, false); assert.equal(get("docs-loading").hidden, true);
    await vm.runInContext("openDoc({key:'missing',name:'Fixture'})", s);
    assert.ok(get("docs-content").innerHTML.includes("文档不存在"));
  }
});

test("production add-character click maps main/local errors and retains legacy cancellation", async () => {
  for (const lang of langs) {
    const { s, get } = await renderer(lang);
    let dialogs = 0;
    const importSpine = main({ addCharWin: null, win: null, dialog: { showOpenDialog() { dialogs++; throw new Error(hostile); } } }).handler("pet:import-spine");
    s.btn = get("btn-import"); s.statusEl = get("status");
    s.petAPI.importSpine = () => importSpine();
    // 5-E3 起 addchar.js 的状态文案先落 module state 再投影，改为装载真实模块
    // （presentError 由模块自身的一行转发提供，不再单独预载，否则重复声明）
    loadAdapter(s);
    s.petAPI.getSpineModels = async () => ({ list: [] });
    vm.runInContext(read("renderer/addchar.js"), s);
    await get("btn-import").fire();
    assert.equal(dialogs, 1, "actual external dialog boundary was reached");
    assert.equal(get("status").textContent, "❌ " + expected(lang, "INTERNAL")); safe(get("status").textContent);
    s.petAPI.importSpine = async () => { throw new Error(hostile); };
    await get("btn-import").fire();
    assert.equal(get("status").textContent, "❌ " + expected(lang, "INTERNAL"));
    s.petAPI.importSpine = async () => ({ ok: false, error: "取消" });
    await get("btn-import").fire();
    assert.equal(get("status").textContent, "❌ 取消");
  }
});

test("production moods click maps config write failure and preserves success/legacy messages", async () => {
  for (const lang of langs) {
    const { s, get } = await renderer(lang);
    const addMood = main({ getMoodList: () => [], config: { saveConfig() { throw new Error(hostile); } } }).handler("pet:add-mood");
    get("new-mood").value = "test";
    let refreshes = 0;
    // 6-A 重命名：生产侧为 fetchAndRenderMoods，护栏名同步
    s.fetchAndRenderMoods = async () => { refreshes++; };
    s.petAPI.addMood = (label) => Promise.resolve(addMood(null, label));
    presenter(s, "renderer/moods.js");
    functions(s, "renderer/moods.js", ["function setMsg("]);
    if (source("renderer/moods.js").includes("function setResultMessage(")) functions(s, "renderer/moods.js", ["function setResultMessage("]);
    vm.runInContext(statement(source("renderer/moods.js"), 'document.getElementById("btn-add-mood").addEventListener('), s);
    await get("btn-add-mood").fire();
    assert.equal(get("add-result").textContent, expected(lang, "INTERNAL")); safe(get("add-result").textContent);
    assert.equal(refreshes, 0);
    s.petAPI.addMood = async () => ({ ok: false, message: "已有该情绪" });
    await get("btn-add-mood").fire(); assert.equal(get("add-result").textContent, "已有该情绪");
    s.petAPI.addMood = async () => ({ ok: true, message: "fixture success" });
    await get("btn-add-mood").fire();
    assert.equal(get("add-result").textContent, "fixture success");
    assert.equal(get("new-mood").value, ""); assert.equal(refreshes, 1);
  }
});

test("production settings log DOM maps actual FS/read and local rejection failures and releases export button", async () => {
  for (const lang of langs) {
    const { s, get } = await renderer(lang);
    presenter(s, "renderer/settings.js", "presentResultError");
    functions(s, "renderer/settings.js", ["function setResult("]);
    vm.runInContext(`(${fn(source("renderer/settings.js"), "function setupLogDiag()")})()`, s);
    get("logdiag-lines").value = "500";
    const logModule = { module: { exports: {} }, require(name) {
      return name === "fs" ? { existsSync: () => true, statSync: () => ({ size: 10 }), readFileSync() { throw new Error(hostile); } } : require(name);
    } };
    vm.createContext(logModule); vm.runInContext(source("src/log-diag.js"), logModule);
    const m = main({ logDiag: logModule.module.exports });
    const readLog = m.handler("pet:log-read"), exportLog = m.handler("pet:log-export");
    s.petAPI.logRead = (count) => Promise.resolve(readLog(null, count));
    s.petAPI.logExport = (count) => exportLog(null, count);
    await get("logdiag-refresh").fire();
    assert.equal(get("logdiag-result").textContent, expected(lang, "INTERNAL")); safe(get("logdiag-result").textContent);
    await get("logdiag-export").fire();
    assert.equal(get("logdiag-result").textContent, expected(lang, "INTERNAL")); assert.equal(get("logdiag-export").disabled, false);
    s.petAPI.logRead = s.petAPI.logExport = async () => { throw new Error(hostile); };
    await get("logdiag-refresh").fire(); assert.equal(get("logdiag-result").textContent, expected(lang, "INTERNAL"));
    await get("logdiag-export").fire(); assert.equal(get("logdiag-result").textContent, expected(lang, "INTERNAL"));
    assert.equal(get("logdiag-export").disabled, false);
    s.petAPI.logExport = async () => ({ ok: false, canceled: true });
    await get("logdiag-export").fire(); assert.equal(get("logdiag-result").textContent, i18n.t(lang, "set.logdiagExportCancel"));
    s.petAPI.logRead = async () => ({ ok: true, lines: ["<masked> diagnostic"] });
    await get("logdiag-refresh").fire(); assert.ok(get("logdiag-pre").innerHTML.includes("&lt;masked&gt; diagnostic"));
    s.petAPI.logExport = async () => ({ ok: true, path: "controlled-export.txt" });
    await get("logdiag-export").fire();
    assert.equal(get("logdiag-result").textContent, i18n.t(lang, "set.logdiagExportDone") + " controlled-export.txt");
  }
});
