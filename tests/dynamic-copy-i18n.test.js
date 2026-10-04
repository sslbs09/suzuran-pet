"use strict";

/**
 * Phase 4-B2.1 — renderer-owned dynamic product copy migration 契约：
 * voice/psd/moods/settings 四个页面脚本的动态 UI 文案全部经 L()/setStatusL(key, params)；
 * 重放回调零业务副作用；DATA/character/technical/INTERNAL 原文保持不被翻译；
 * 新引用键三语齐备（全 catalog parity 由 tests/i18n.test.js 继续守门）。
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");

const i18n = require("../src/i18n");

const SETTINGS_JS = fs.readFileSync(require.resolve("../renderer/settings.js"), "utf8");
const VOICE_JS = fs.readFileSync(require.resolve("../renderer/voice.js"), "utf8");
const PSD_JS = fs.readFileSync(require.resolve("../renderer/psd.js"), "utf8");
const MOODS_JS = fs.readFileSync(require.resolve("../renderer/moods.js"), "utf8");

const DYN_FILES = { settings: SETTINGS_JS, voice: VOICE_JS, psd: PSD_JS, moods: MOODS_JS };
const CN = "[\\u4e00-\\u9fff\\u3040-\\u30ff]";

test("B2.1-NO-RAW-UI-ASSIGNMENTS: 动态文件禁止把裸中文写进 DOM 文本/title/confirm/alert/dbg 以外通道", () => {
  for (const [name, src] of Object.entries(DYN_FILES)) {
    assert.doesNotMatch(src, new RegExp(`setStatus\\(\\s*"${CN}`), `${name}: setStatus 第一参必须是 key`);
    assert.doesNotMatch(src, new RegExp(`setStatusL\\(\\s*"${CN}`), `${name}: setStatusL 必须是 key`);
    assert.doesNotMatch(src, new RegExp(`confirm\\(\\s*["'\`]${CN}`), `${name}: confirm 文案必须 L()`);
    assert.doesNotMatch(src, new RegExp(`alert\\(\\s*["'\`]${CN}`), `${name}: alert 文案必须 L()（或透传 main message）`);
    assert.doesNotMatch(src, new RegExp(`\\.textContent\\s*=[^=\\n]*["'\`]${CN}[^"'\`]*["'\`]`, "m"), `${name}: textContent 禁止裸中文字面量`);
    assert.doesNotMatch(src, new RegExp(`\\.title\\s*=\\s*["'\`]${CN}`), `${name}: title 禁止裸中文字面量`);
  }
});

test("B2.1-RAW-KEPT: DATA / CHARACTER / TECHNICAL / INTERNAL 原文保持（防过度迁移）", () => {
  assert.ok(VOICE_JS.includes('"训练指南.html"') && VOICE_JS.includes('"总览.html"'), "guide 文件名=技术标识保持原样");
  assert.ok(SETTINGS_JS.includes('|| "苏苏洛"'), "默认宠物名=角色内容默认值保持原样");
  assert.ok(SETTINGS_JS.includes('new Error("读取超时")'), "内部 Error 文本=INTERNAL 保持原样");
  assert.ok(PSD_JS.includes('name: c.name || "组"') && PSD_JS.includes('"未命名", left:'), "进 rigger 管道的数据默认名保持原样（非 UI 显示）");
  assert.ok(PSD_JS.includes("dbg(\"开始解析 "), "dbg 日志=INTERNAL 不迁移");
  // 透传不二次翻译：main 已翻译 message 直接展示
  assert.ok(VOICE_JS.includes("r.ok ? r.message"), "voice apply 成功 message 透传");
  assert.ok(MOODS_JS.includes("result && result.ok ? result.message") && MOODS_JS.includes("presentError(result)"), "moods 成功 message 透传，失败经 presenter");
});

test("B2.1-REPLAY-REGISTERED: 四个文件都经 I18N.onChange 注册重放（单一订阅，无再监听 ui-lang-changed）", () => {
  for (const [name, src] of Object.entries(DYN_FILES)) {
    assert.ok(src.includes("window.I18N.onChange"), `${name}: 缺少 onChange 重放注册`);
    assert.ok(!src.includes("onUiLangChanged"), `${name}: 禁止再直接订阅 ui-lang-changed`);
  }
});

test("B2.1-REPLAY-PURE: 重放回调零业务副作用（无 await/petAPI 调用/mutation 函数）", () => {
  const cb = PSD_JS.slice(PSD_JS.lastIndexOf("window.I18N.onChange(() => {"));
  const body = cb.slice(0, cb.indexOf("\n});"));
  assert.ok(!/await |petAPI\.|doFlatten|doRigPreview|loadFile|pushSnap/.test(body), "psd 重放只做 render/纯树重建");
  const vcbStart = VOICE_JS.lastIndexOf("window.I18N.onChange(() => {");
  const vcb = VOICE_JS.slice(vcbStart, VOICE_JS.indexOf("\n});", vcbStart));
  assert.ok(!/petAPI\.|fetchAndRenderVoiceStatus|voiceStatus/.test(vcb), "voice 重放不调状态接口（6-A：refreshStatus→fetchAndRenderVoiceStatus）");
  const scb = SETTINGS_JS.slice(SETTINGS_JS.lastIndexOf("I18N.onChange(() => {"));
  const sbody = scb.slice(0, scb.indexOf("\n});"));
  assert.ok(!/petAPI\.|await |doSave|testConn|rigApply|deleteMemory|clearMemory/.test(sbody), "settings 重放纯投影");
  const mcb = MOODS_JS.slice(MOODS_JS.lastIndexOf("window.I18N.onChange(render)"));
  assert.ok(mcb.trim().length > 0, "moods 注册 render 投影");
});

test("B2.1-KEYS-EXIST: 全部新引用 key 三语存在且非空", () => {
  const KEYS = [
    "page.moods.count", "page.moods.renameTip", "page.voice.noFile", "page.voice.statusReady",
    "page.psd.scaled", "page.psd.meta", "page.psd.previewStats", "page.psd.rigInfo",
    "set.keyUnreadable", "set.agentAdded", "set.credImportConfirm", "set.bondProgress",
    "set.memStats", "set.rmHintSpine", "set.fontCustom", "set.credFound"
  ];
  for (const k of KEYS) {
    for (const lang of ["zh", "en", "ja"]) {
      assert.ok(typeof i18n.DICT[lang][k] === "string" && i18n.DICT[lang][k].length > 0, `${lang}:${k}`);
    }
  }
});

test("B2.1-INTERP: 参数化示例（数据作参数，不进 key 语义）", () => {
  assert.equal(i18n.t("zh", "set.bondMax", { level: 9, days: 30 }), "🥰 羁绊 Lv.9（MAX）· 已陪伴 30 天");
  assert.match(i18n.t("en", "page.psd.scaled", { name: "Head", pct: 120 }), /"Head" to 120%/);
  assert.match(i18n.t("ja", "page.voice.statusReady", { char: "sussurro" }), /sussurro/);
});
