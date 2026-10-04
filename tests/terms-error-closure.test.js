"use strict";

/**
 * Phase 5-E1 契约：条款页错误面闭合。
 *  - terms 不直接渲染主进程 message / Error.message
 *  - terms.html 加载 error-presenter.js 且早于 terms.js
 *  - 已知状态用 catalog 键，未知状态走 presenter
 *  - locale 切换会重本地化失败提示（不冻结旧语言），且零 IPC / 零业务副作用
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const termsJs = fs.readFileSync(path.join(root, "renderer/terms.js"), "utf8");
/* 结构断言一律基于去注释后的代码：注释里出现旧标识符（例如描述被修掉的写法）
 * 不应让守卫误判，否则注释一变测试就假红。 */
const termsCode = termsJs.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const termsHtml = fs.readFileSync(path.join(root, "renderer/terms.html"), "utf8");
const mainSource = fs.readFileSync(path.join(root, "main.js"), "utf8");
const facts = require(path.join(root, "src/error-facts.js"));
const presenter = require(path.join(root, "src/error-presenter.js"));
const i18n = require(path.join(root, "src/i18n.js"));

/* 1) terms 不直接渲染 Error.message */
test("terms.js never writes a raw message into the DOM", () => {
  // 任何 .textContent = <...>.message / result.message 都是被修掉的旧路径
  assert.ok(!/textContent\s*=\s*[^;\n]*\.message/.test(termsCode),
    "terms.js must not assign any *.message to textContent");
  assert.ok(!/result\.message/.test(termsCode), "result.message must not be read at all");
  assert.ok(!/String\([^\n]*\.message/.test(termsCode), "no exception text is stringified into the UI");
  assert.ok(!/"[^"]*[\u4e00-\u9fff][^"]*"/.test(termsCode), "terms.js carries no hardcoded Chinese UI copy");
});

test("terms.js routes errors through the shared presenter contract", () => {
  assert.match(termsCode, /window\.ErrorPresenter\.toPresentation\(/, "presenter is used");
  assert.match(termsCode, /window\.I18N\.t\(/, "output goes through I18N");
  assert.match(termsCode, /hasOwnProperty\.call\(result,\s*"code"\)/,
    "code presence decided by hasOwnProperty so a present-but-invalid code cannot fall through");
});

test("an uncoded result degrades to err.unknown rather than echoing text", () => {
  const hostile = "C:\\Users\\alice\\secret.json sk-live-abcdef token";
  // 复刻 presentError 的无 code 分支语义：只允许落到 err.unknown
  assert.deepEqual(presenter.toPresentation({ code: hostile }), { key: "err.unknown", params: {} });
  assert.deepEqual(presenter.toPresentation(null), { key: "err.unknown", params: {} });
  assert.deepEqual(presenter.toPresentation(undefined), { key: "err.unknown", params: {} });
});

/* 2) terms.html 加载 presenter 且顺序正确 */
test("terms.html loads the Phase 5-A presenter before terms.js", () => {
  const tag = termsHtml.match(/<script\s+src="([^"]*error-presenter\.js)"\s*><\/script>/);
  assert.ok(tag, "terms.html loads src/error-presenter.js");
  assert.equal(path.resolve(path.dirname(path.join(root, "renderer/terms.html")), tag[1]),
    path.join(root, "src/error-presenter.js"), "loads the same presenter the tests exercise");
  assert.ok(termsHtml.indexOf(tag[0]) < termsHtml.indexOf('src="terms.js"'), "presenter precedes terms.js");
  assert.ok(termsHtml.indexOf('src="i18n.js"') < termsHtml.indexOf(tag[0]), "i18n precedes presenter");
});

/* 3) 主进程 pet:agree-terms 已带 code */
test("pet:agree-terms emits a code the presenter can render", () => {
  const at = mainSource.indexOf('ipcMain.handle("pet:agree-terms"');
  assert.notEqual(at, -1, "handler present");
  const body = mainSource.slice(at, mainSource.indexOf("\n});", at));
  const coded = [...body.matchAll(/return\s*\{\s*ok:\s*false[^}]*code:\s*"INTERNAL"/g)];
  assert.equal(coded.length, 2, "both failure returns carry code: INTERNAL");
  // INTERNAL 是既有 11 码之一，未新造错误码
  assert.ok(facts.ERROR_CODES.INTERNAL);
  assert.equal(presenter.toPresentation({ code: "INTERNAL" }).key, "err.internal");
});

/* 4) catalog 键齐备（三语 + 占位符） */
test("new terms hint keys exist in all three locales with identical placeholders", () => {
  const keys = ["page.terms.runtimeFailedHint", "page.terms.saveFailedHint"];
  for (const key of keys) {
    for (const lang of ["zh", "en", "ja"]) {
      const v = i18n.DICT[lang][key];
      assert.ok(typeof v === "string" && v.trim(), `${lang}:${key} missing or empty`);
    }
    const ph = (lang) => [...i18n.DICT[lang][key].matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    assert.deepEqual(ph("en"), ph("zh"), `${key} zh/en params`);
    assert.deepEqual(ph("ja"), ph("zh"), `${key} zh/ja params`);
  }
  // 新键不得含技术细节
  for (const lang of ["zh", "en", "ja"]) {
    for (const key of keys) {
      assert.ok(!/[A-Z]:\\|sk-|<html>/.test(i18n.DICT[lang][key]), `${lang}:${key} leaks technical detail`);
    }
  }
});

/* 5) locale 切换重本地化失败提示，且零副作用 */
test("failure hint is stored as a source, so locale change re-localizes it", () => {
  assert.ok(!/hintFailure\s*=\s*true/.test(termsCode), "no boolean flag freezing the old language");
  assert.match(termsCode, /hintFailure\s*=\s*null/, "failure state is a nullable union");
  assert.match(termsCode, /I18N\.onChange\(renderTermsHint\)/, "failure text re-renders on locale change");
  assert.match(termsCode, /hintFailure\.key\s*!==\s*undefined\s*\?\s*t\(/, "key form re-resolved from catalog");
  assert.match(termsCode, /presentError\(hintFailure\.result\)/, "result form re-presented from the stored fact");
});

test("locale change triggers no IPC and no business re-entry", () => {
  // 只截取 onChange 注册语句本身（不能切到文件尾，否则会把同意按钮处理器也算进来）
  const reg = termsCode.match(/if \(window\.I18N[\s\S]*?window\.I18N\.onChange\([^)]*\);/);
  assert.ok(reg, "onChange registration found");
  assert.ok(!/petAPI\./.test(reg[0]), "onChange callback must not call any petAPI method");
  assert.ok(!/agreeTerms|refuseTerms/.test(reg[0]), "no consent re-entry on locale change");
});

/* 6) 渲染层实跑：三语都走 presenter，且不泄漏 message */
test("a coded consent failure renders localized text and drops the message", async () => {
  const hostile = "C:\\Users\\alice\\AppData\\secret.json sk-live-abcdefgh1234567 stack at x.js:9";
  for (const lang of ["zh", "en", "ja"]) {
    for (const result of [
      { ok: false, code: "INTERNAL", message: hostile },
      { ok: false, code: "NOT_A_CODE", message: hostile },
      { ok: false, message: hostile } // 无 code → err.unknown，仍不得回显
    ]) {
      const out = Object.prototype.hasOwnProperty.call(result, "code")
        ? (() => { const p = presenter.toPresentation({ code: result.code, meta: result.meta }); return i18n.t(lang, p.key, p.params); })()
        : i18n.t(lang, "err.unknown");
      assert.ok(!out.includes("secret.json"), `${lang}: path leaked`);
      assert.ok(!out.includes("sk-live"), `${lang}: token leaked`);
      assert.ok(!out.includes("stack"), `${lang}: stack leaked`);
      assert.ok(out.trim().length > 0, `${lang}: produced text`);
    }
  }
});

test("the two known consent states use their own catalog copy in every locale", async () => {
  for (const lang of ["zh", "en", "ja"]) {
    assert.notEqual(i18n.t(lang, "page.terms.runtimeFailedHint"), i18n.t(lang, "err.internal"),
      `${lang}: restart advice must survive (err.internal alone would say only "try again later")`);
    assert.notEqual(i18n.t(lang, "page.terms.saveFailedHint"), i18n.t(lang, "err.internal"),
      `${lang}: save-failure guidance must survive too`);
  }
});

test("no consent hint key is left unreferenced", () => {
  const src = termsJs;
  for (const key of ["page.terms.runtimeFailedHint", "page.terms.saveFailedHint", "page.terms.footHint"]) {
    assert.ok(src.includes(`"${key}"`), `${key} must be referenced by terms.js`);
  }
});