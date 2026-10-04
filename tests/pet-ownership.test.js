"use strict";

/**
 * Phase 5-F1 契约：pet 渲染层 ownership 收敛。
 *  - document.title 唯一 owner = 主进程（renderer 不再写）
 *  - input.placeholder 唯一 owner = 本文件末尾唯一的 I18N.onChange
 *  - spriteEl.alt 保留为 DATA owner
 *  - 宠物名解析逻辑未改动；未新增 onChange 订阅
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const petJs = fs.readFileSync(path.join(root, "renderer/pet.js"), "utf8");
const petHtml = fs.readFileSync(path.join(root, "renderer/index.html"), "utf8");
const mainSource = fs.readFileSync(path.join(root, "main.js"), "utf8");
const i18n = require(path.join(root, "src/i18n.js"));

function functionBody(name) {
  const at = petJs.indexOf(`function ${name}(`);
  assert.notEqual(at, -1, `function ${name} exists`);
  const open = petJs.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < petJs.length; i++) {
    if (petJs[i] === "{") depth++;
    else if (petJs[i] === "}" && --depth === 0) return petJs.slice(open, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

/* --- title 唯一 owner --- */
test("renderer pet no longer owns the window title", () => {
  const body = functionBody("applyPetName");
  assert.ok(!/document\.title/.test(body), "applyPetName must not write document.title");
  assert.ok(!/setTitle\(/.test(body), "applyPetName must not call setTitle");
  // 全文件层面：renderer 侧不再有任何 document.title 写入
  const writes = [...petJs.matchAll(/document\.title\s*=/g)];
  assert.deepEqual(writes.map((m) => petJs.slice(Math.max(0, m.index - 60), m.index + 40)),
    [], "pet.js must not assign document.title anywhere");
});

test("the main process is the single title owner and covers rename + locale change", () => {
  const pet = mainSource.slice(mainSource.indexOf("function applyPetWindowTitle()"));
  const petFn = pet.slice(0, pet.indexOf("\n}"));
  assert.match(petFn, /win\.setTitle\(i18n\.t\(currentUiLang\(\), "ui\.petWindowTitle", \{ name \}\)\)/,
    "main sets the title from the catalog with the pet name");
  assert.match(mainSource, /function refreshPetName\(\) \{\s*applyPetWindowTitle\(\);/,
    "rename path drives the title through the same owner");
  const handler = mainSource.slice(mainSource.indexOf('ipcMain.handle("pet:set-ui-lang"'),
    mainSource.indexOf("\n});", mainSource.indexOf('ipcMain.handle("pet:set-ui-lang"')));
  assert.match(handler, /applyNativeWindowTitles\(\)/, "locale change drives the title through the same owner");
  assert.match(mainSource.slice(mainSource.indexOf("function applyNativeWindowTitles()"), mainSource.indexOf("function applyNativeWindowTitles()") + 800),
    /applyPetWindowTitle\(\)/, "the locale retitle pass includes the pet window");
});

/* --- placeholder 唯一 owner --- */
test("applyPetName no longer writes the placeholder", () => {
  const body = functionBody("applyPetName");
  assert.ok(!/placeholder/.test(body), "placeholder is not this function's business any more");
  assert.ok(!/和.*说点什么/.test(body), "no hardcoded Chinese placeholder remains");
});

test("pet.js has exactly one onChange subscription and it owns the placeholder", () => {
  const subs = [...petJs.matchAll(/window\.I18N\.onChange\(/g)];
  assert.equal(subs.length, 1, `expected exactly one I18N.onChange in pet.js, found ${subs.length}`);
  assert.match(petJs, /inputEl\.placeholder = isRecording \? I18N\.t\("ui\.micRecording"\) : I18N\.t\("ui\.placeholder"\);/,
    "the single subscription renders the recording-aware localized placeholder");
});

test("the placeholder is written from the catalog in every locale", () => {
  for (const lang of ["zh", "en", "ja"]) {
    for (const key of ["ui.placeholder", "ui.micRecording"]) {
      const v = i18n.t(lang, key);
      assert.ok(String(v).trim() && !v.includes(key), `${lang}:${key} resolves to real text`);
    }
    assert.notEqual(i18n.t(lang, "ui.placeholder"), i18n.t(lang, "ui.micRecording"),
      `${lang}: idle and recording placeholders must differ`);
  }
});

test("recording state still wins over the idle placeholder", () => {
  // 录音中切语言仍应显示「录音中…」，这是 Phase 4-B 的既有语义，F1 未改变
  assert.match(petJs, /isRecording \? I18N\.t\("ui\.micRecording"\) : I18N\.t\("ui\.placeholder"\)/);
});

/* --- alt 仍是 DATA owner --- */
test("sprite alt stays owned by applyPetName as DATA", () => {
  const body = functionBody("applyPetName");
  assert.match(body, /spriteEl\.alt = value;/, "alt is written from the pet name (DATA)");
  assert.ok(!/I18N|window\.I18N/.test(body), "alt is data, never looked up in the catalog");
  assert.ok(!petHtml.includes('data-i18n-alt="ui.petAlt"'),
    "index.html must not re-bind alt (that would restore the dual owner)");
});

/* --- 宠物名逻辑未改动 --- */
test("pet name parsing is untouched", () => {
  const body = functionBody("applyPetName");
  assert.match(body, /String\(name \|\| "苏苏洛"\)\.trim\(\) \|\| "苏苏洛"/,
    "name normalisation (default + trim + fallback) is byte-identical");
  assert.equal((body.match(/=/g) || []).length, 2, "only the name normalisation and the alt assignment remain");
});

test("applyPetName is still wired to both rename paths", () => {
  assert.match(petJs, /window\.petAPI\.onNameChanged\(\(name\) => applyPetName\(name\)\);/, "rename event still calls it");
  assert.match(petJs, /if \(typeof state\.petName === "string"\) applyPetName\(state\.petName\);/, "bootstrap still calls it");
});

test("pet.js carries no hardcoded Chinese UI copy in the touched region", () => {
  const body = functionBody("applyPetName").replace(/\/\/.*$/gm, "");
  const hits = body.match(/"[^"]*[\u4e00-\u9fff][^"]*"/g) || [];
  // 「苏苏洛」是宠物名默认值（DATA/品牌标识），不是 UI 文案
  assert.deepEqual(hits.filter((h) => !h.includes("苏苏洛")), [],
    `unexpected UI copy left in applyPetName: ${hits.join(" | ")}`);
});