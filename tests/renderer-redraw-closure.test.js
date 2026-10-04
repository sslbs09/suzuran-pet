"use strict";

/**
 * Phase 5-E3 契约：schedule / addchar 动态重绘闭合。
 *  1. 两页都注册 I18N.onChange
 *  2. locale 重绘只从既有 state 投影：不重新请求 IPC / 不重新导入 / 不重建业务状态
 *  3. 运行时文本来自 catalog，不含硬编码中文
 *  4. locale 切换不改变业务 state（列表/结果/预览数据不变）
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, "renderer", f), "utf8");
const code = (f) => read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const i18n = require(path.join(root, "src/i18n.js"));

const PAGES = ["schedule.js", "addchar.js"];

/* 1) 两页都订阅 I18N.onChange */
test("schedule and addchar subscribe to locale changes", () => {
  for (const page of PAGES) {
    const src = code(page);
    assert.match(src, /if \(window\.I18N && window\.I18N\.onChange\) window\.I18N\.onChange\(/, `${page} registers I18N.onChange`);
  }
});

/** 取 onChange 注册的回调体：内联箭头直接用；注册具名函数则展开该函数体。
 *  参数用括号配平截取（箭头函数体里含分号，按 ');' 截会截断）。 */
function registeredCallback(page) {
  const src = code(page);
  const at = src.indexOf("window.I18N.onChange(");
  assert.notEqual(at, -1, `${page} onChange present`);
  const argStart = src.indexOf("onChange(", at) + "onChange(".length;
  let depth = 1, i = argStart;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    i++;
  }
  const arg = src.slice(argStart, i - 1).trim();
  if (arg.includes("=>")) return arg;
  const fnAt = src.indexOf(`function ${arg}(`);
  assert.notEqual(fnAt, -1, `${page} callback ${arg} is defined`);
  const open = src.indexOf("{", fnAt);
  let d = 0;
  for (let k = open; k < src.length; k++) {
    if (src[k] === "{") d++;
    else if (src[k] === "}" && --d === 0) return src.slice(open, k + 1);
  }
  throw new Error("unterminated callback");
}

test("the redraw callback is a projection of existing state, nothing more", () => {
  const FORBIDDEN = [
    "petAPI.", "getSchedules", "getSpineModels", "importSpine", "addSchedule",
    "importScheduleWorkbook", "previewScheduleWorkbook", "exportScheduleTemplate",
    "completeSchedule", "snoozeSchedule", "cancelSchedule", "pickScheduleWorkbook",
    "location.reload", "window.close"
  ];
  for (const page of PAGES) {
    const cb = registeredCallback(page);
    for (const f of FORBIDDEN) {
      assert.ok(!cb.includes(f), `${page} locale redraw must not call ${f}`);
    }
  }
});

test("the redraw callback only invokes render helpers", () => {
  const expectations = {
    "schedule.js": [/renderSummary\(\)/, /renderList\(\)/, /renderResult\(\)/, /renderPreview\(\)/],
    "addchar.js": [/renderList\(\)/, /renderStatus\(\)/]
  };
  for (const page of PAGES) {
    const cb = registeredCallback(page);
    for (const rx of expectations[page]) assert.match(cb, rx, `${page} redraw must include ${rx}`);
    assert.ok(!/await\b/.test(cb), `${page} redraw must not await anything`);
  }
});

/* 2) 运行时文本来自 catalog */
test("schedule/addchar carry no hardcoded Chinese UI copy", () => {
  for (const page of PAGES) {
    const src = code(page);
    const hits = src.match(/"[^"]*[\u4e00-\u9fff][^"]*"/g) || [];
    assert.deepEqual(hits, [], `${page} hardcoded CJK literals: ${hits.join(" | ")}`);
  }
});

test("new schedule/addchar keys exist in all three locales with identical placeholders", () => {
  const keys = [
    "page.schedule.summary", "page.schedule.btnDone", "page.schedule.btnSnooze",
    "page.schedule.added", "page.schedule.importedCount", "page.schedule.previewMeta",
    "page.schedule.colRow", "page.schedule.templateSaved", "page.schedule.templateCancelled",
    "page.addchar.builtinOnly", "page.addchar.currentTag", "page.addchar.loadFail",
    "page.addchar.pickHint", "page.addchar.imported"
  ];
  for (const key of keys) {
    for (const lang of ["zh", "en", "ja"]) {
      assert.ok(String(i18n.DICT[lang][key] || "").trim(), `${lang}:${key} missing/empty`);
    }
    const ph = (lang) => [...i18n.DICT[lang][key].matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    assert.deepEqual(ph("en"), ph("zh"), `${key} zh/en params`);
    assert.deepEqual(ph("ja"), ph("zh"), `${key} zh/ja params`);
  }
});

test("runtime text actually differs per locale (guards against a no-op lookup)", () => {
  for (const key of ["page.schedule.summary", "page.schedule.btnDone", "page.schedule.previewMeta",
    "page.addchar.builtinOnly", "page.addchar.loadFail", "page.addchar.imported"]) {
    const v = ["zh", "en", "ja"].map((lang) => i18n.DICT[lang][key]);
    assert.equal(new Set(v).size, 3, `${key} must differ across zh/en/ja`);
  }
});

/* 3) state 与渲染分离：locale 切换不改变业务 state */
test("runtime data lives in module state, never in the DOM as the source of truth", () => {
  const schedule = code("schedule.js");
  assert.match(schedule, /let lastItems = null;/, "schedule keeps the item list in state");
  assert.match(schedule, /let lastPreview = null;/, "schedule keeps the preview payload in state");
  assert.match(schedule, /let lastResult = null;/, "schedule keeps the last result in state");
  assert.match(schedule, /lastItems = items;/, "refresh assigns state, then projects");
  assert.match(schedule, /renderSummary\(\);\s*renderList\(\);/, "refresh projects from state");

  const addchar = code("addchar.js");
  assert.match(addchar, /let lastList = null;/, "addchar keeps the model list in state");
  assert.match(addchar, /let lastStatus = null;/, "addchar keeps the status in state");
  assert.match(addchar, /lastList = await window\.petAPI\.getSpineModels\(\);/, "load assigns state, then projects");
});

test("error results are stored by source so they re-localize instead of freezing text", () => {
  const schedule = code("schedule.js");
  // 生产写法是三元：lastResult = r.ok ? { key } : { error: r }
  assert.match(schedule, /: \{ error: r \}/, "schedule stores the raw result for re-presentation");
  assert.match(schedule, /lastResult = \{ error: p \}/, "preview failure is stored by source too");
  assert.match(schedule, /presentError\(lastResult\.error\)/, "schedule re-derives error text on redraw");
  assert.ok(!/lastResult\s*=\s*presentError\(/.test(schedule), "schedule must not freeze a rendered error string");

  const addchar = code("addchar.js");
  assert.match(addchar, /lastStatus = \{ error: r \}/, "addchar stores the raw result");
  assert.match(addchar, /lastStatus = \{ error: \{ code: "INTERNAL" \} \}/, "local exception becomes a coded fact");
  assert.match(addchar, /presentError\(lastStatus\.error\)/);
  assert.ok(!/lastStatus\s*=\s*presentError\(/.test(addchar), "addchar must not freeze a rendered error string");
});

test("success results keep their parameters so counts localize too", () => {
  const schedule = code("schedule.js");
  assert.match(schedule, /lastResult = r\.ok \? \{ key: "page\.schedule\.importedCount", params: \{ n: r\.count \} \}/,
    "import count is kept as a parameter, not baked into text");
  const addchar = code("addchar.js");
  assert.match(addchar, /params: \{ name: r\.name, id: r\.id \}/, "imported name/id stay as parameters (DATA)");
});

/* 4) 重投影不触碰用户输入 */
test("locale redraw never rewrites form inputs", () => {
  for (const page of PAGES) {
    const src = code(page);
    for (const id of ["title", "date", "time", "recurrence", "emotion", "notes"]) {
      const re = new RegExp(`\\$\\("${id}"\\)\\.value\\s*=`);
      const before = src.split(re).length - 1;
      const at = src.indexOf("window.I18N.onChange(");
      const stmt = src.slice(src.lastIndexOf("if (window.I18N", at), src.indexOf(";", at) + 1);
      assert.equal(before - (stmt.split(re).length - 1), before, `${page} redraw must not assign #${id}.value`);
    }
  }
});

test("preview dialog focus handling is untouched by the refactor", () => {
  const schedule = code("schedule.js");
  assert.match(schedule, /previewReturnFocus = document\.activeElement;/, "focus is still remembered");
  assert.match(schedule, /\$\("preview-cancel"\)\.focus\(\)/, "focus still enters the dialog");
  assert.match(schedule, /previewReturnFocus\.focus\(\)/, "focus is still restored");
});