"use strict";

/**
 * Phase 5-E2 契约：native 表面标题本地化。
 *  - 所有 BrowserWindow title 走 i18n.t/currentUiLang（不硬编码）
 *  - 系统 showOpenDialog/showSaveDialog title 走 i18n.t
 *  - locale 切换会更新已打开窗口标题（含宠物窗口），且不重建窗口
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const mainSource = fs.readFileSync(path.join(root, "main.js"), "utf8");
const i18n = require(path.join(root, "src/i18n.js"));

const WINDOW_KEYS = [
  ["helpWin", "page.help.title"],
  ["quickstartWin", "page.quickstart.title"],
  ["settingsWin", "page.settings.title"],
  ["scheduleWin", "page.schedule.title"],
  ["psdWin", "page.psd.title"],
  ["docsWin", "page.docs.title"],
  ["addCharWin", "page.addchar.title"],
  ["moodWin", "page.moods.title"],
  ["termsWin", "page.terms.title"],
  ["voiceWin", "page.voice.title"]
];

/** 取 `new BrowserWindow(` 之后配平的 options 对象体（title 里含逗号，不能按逗号切）。 */
function browserWindowOptionBodies() {
  const out = [];
  const re = /new BrowserWindow\(/g;
  let m;
  while ((m = re.exec(mainSource))) {
    const open = mainSource.indexOf("{", m.index);
    if (open === -1) continue;
    let depth = 0, end = -1;
    for (let i = open; i < mainSource.length; i++) {
      if (mainSource[i] === "{") depth++;
      else if (mainSource[i] === "}" && --depth === 0) { end = i; break; }
    }
    if (end === -1) continue;
    out.push(mainSource.slice(open, end + 1));
  }
  return out;
}

test("every BrowserWindow title resolves through the catalog", () => {
  const bodies = browserWindowOptionBodies();
  assert.ok(bodies.length >= WINDOW_KEYS.length, `found ${bodies.length} BrowserWindow creations`);
  const titled = bodies.filter((b) => /\btitle:/.test(b));
  assert.ok(titled.length >= WINDOW_KEYS.length + 1, `found ${titled.length} titled windows`);
  for (const body of titled) {
    assert.match(body, /\btitle:\s*i18n\.t\(\s*(?:lang|currentUiLang\(\))\s*,/,
      `window title must come from the catalog, got: ${(body.match(/\btitle:[^,]*/) || [""])[0].trim()}`);
  }
});

test("no hardcoded CJK title literal remains in a user-visible surface", () => {
  // DATA 例外：Excel 模板示例行是业务数据对象（一条日程），不是窗口/对话框标题
  const ALLOWED_DATA = [/json_to_sheet\(\[\{ title:/];
  const titles = [...mainSource.matchAll(/\btitle:\s*"([^"]*)"/g)]
    .map((m) => ({ line: mainSource.slice(0, m.index).split("\n").length, value: m[1], at: m.index }));
  const hard = titles.filter((t) => /[\u4e00-\u9fff]/.test(t.value));
  const unexpected = hard.filter((t) => {
    const around = mainSource.slice(Math.max(0, t.at - 120), t.at + 40);
    return !ALLOWED_DATA.some((rx) => rx.test(around));
  });
  assert.deepEqual(unexpected.map((t) => `${t.line}: ${t.value}`), [],
    `hardcoded user-visible titles: ${unexpected.map((t) => t.value).join(" | ")}`);
});

test("every localized title site uses the shared native translator", () => {
  const sites = [...mainSource.matchAll(/\btitle:\s*(i18n\.t\()/g)];
  assert.ok(sites.length >= WINDOW_KEYS.length + 6,
    `expected every window + native dialog title to route through i18n.t, found ${sites.length}`);
  for (const m of sites) {
    const tail = mainSource.slice(m.index, m.index + 90);
    assert.match(tail, /^title:\s*i18n\.t\(\s*(lang|currentUiLang\(\))\s*,/, `unexpected translator: ${tail.slice(0, 60)}`);
  }
});

test("native dialog titles resolve through the catalog", () => {
  const keys = [...mainSource.matchAll(/show(?:Open|Save)Dialog\([\s\S]{0,300}?title:\s*i18n\.t\(currentUiLang\(\),\s*"([\w.]+)"\)/g)].map((m) => m[1]);
  assert.ok(keys.length >= 4, `found ${keys.length} localized native dialog titles`);
  for (const key of ["page.schedule.excelImportTitle", "page.schedule.excelExportTitle",
    "page.addchar.pickTitle", "page.moods.pickGifTitle", "page.voice.pickAudioTitle", "set.logdiagExportTitle"]) {
    assert.ok(keys.includes(key), `${key} dialog title localized`);
  }
});

test("every title key used by native surfaces exists in all three locales", () => {
  const keys = [...new Set([...WINDOW_KEYS.map(([, k]) => k), "page.schedule.excelImportTitle", "page.schedule.excelExportTitle", "ui.petWindowTitle"])];
  for (const key of keys) {
    for (const lang of ["zh", "en", "ja"]) {
      assert.ok(String(i18n.DICT[lang][key] || "").trim(), `${lang}:${key} missing/empty`);
    }
    const ph = (lang) => [...i18n.DICT[lang][key].matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    assert.deepEqual(ph("en"), ph("zh"), `${key} zh/en params`);
    assert.deepEqual(ph("ja"), ph("zh"), `${key} zh/ja params`);
  }
});

test("titles actually differ per locale (guards against a no-op substitution)", () => {
  for (const [handle, key] of WINDOW_KEYS) {
    const v = ["zh", "en", "ja"].map((lang) => i18n.DICT[lang][key]);
    assert.equal(new Set(v).size, 3, `${key} (${handle}) must differ in zh/en/ja — otherwise the title is effectively hardcoded`);
  }
});

/** 精确取出某个顶层函数的函数体（花括号配平），避免把后续代码算进来。 */
function functionBody(name) {
  const at = mainSource.indexOf(`function ${name}(`);
  assert.notEqual(at, -1, `function ${name} exists`);
  const open = mainSource.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < mainSource.length; i++) {
    if (mainSource[i] === "{") depth++;
    else if (mainSource[i] === "}" && --depth === 0) return mainSource.slice(open, i + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

test("pet window title is part of the locale retitle pass", () => {
  const at = mainSource.indexOf('ipcMain.handle("pet:set-ui-lang"');
  assert.notEqual(at, -1, "handler present");
  const body = mainSource.slice(at, mainSource.indexOf("\n});", at));
  assert.match(body, /applyNativeWindowTitles\(\)/, "locale change retitles native windows");
  assert.match(body, /refreshTrayMenu\(\)/, "tray still refreshed");
  assert.match(body, /sendToAllWindows\("pet:ui-lang-changed", v\)/, "renderer still notified");

  const helper = functionBody("applyNativeWindowTitles");
  assert.match(helper, /applyPetWindowTitle\(\)/, "the pet window is included in the retitle pass");
  for (const [handle] of WINDOW_KEYS) {
    assert.match(helper, new RegExp(`\\(\\)\\s*=>\\s*${handle}\\b`), `${handle} included in retitle list`);
  }
  const pet = functionBody("applyPetWindowTitle");
  assert.match(pet, /ui\.petWindowTitle/, "pet window title uses the existing catalog key");
});

test("locale change never rebuilds a window or re-requests data", () => {
  const helper = functionBody("applyNativeWindowTitles");
  assert.ok(!/new BrowserWindow/.test(helper), "must not construct windows");
  assert.ok(!/\.close\(\)|\.destroy\(\)|\.reload\(\)/.test(helper), "must not close/destroy/reload");
  assert.ok(!/ipcMain|webContents\.send/.test(helper), "helper only retitles");
  assert.ok(!/petAPI\.|getSettings|fetch\(/.test(helper), "no data reload");

  const pet = functionBody("applyPetWindowTitle");
  assert.ok(!/sendToAllWindows/.test(pet), "retitle must not broadcast a fake pet:name-changed");
  assert.ok(!/refreshPetName/.test(pet), "no recursion / tooltip side effect on the locale path");
  assert.match(mainSource, /function refreshPetName\(\) \{\s*applyPetWindowTitle\(\);/, "name change reuses the same helper");
});