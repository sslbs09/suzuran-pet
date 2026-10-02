"use strict";

/**
 * localization substrate v1 契约测试（2026-10-03，Phase 1）：
 * 覆盖 normalizeLocale / config admission / effective dictionary /
 * main fallback / renderer contract / live-switch wiring / packaging(asar) contract。
 * catalog 本身的 parity / nonempty / param-parity 由 tests/i18n.test.js 负责。
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");

const locale = require("../src/locale");
const i18n = require("../src/i18n");
const mainSource = fs.readFileSync(require.resolve("../main.js"), "utf8");
const rendererI18n = fs.readFileSync(require.resolve("../renderer/i18n.js"), "utf8");
const pkg = JSON.parse(fs.readFileSync(require.resolve("../package.json"), "utf8"));

/* ---------------- 1. NORMALIZE（唯一规范化实现） ---------------- */

test("NORMALIZE: 区域变体归一到 canonical ID；unknown/null/空 → zh", () => {
  const cases = [
    ["zh", "zh"], ["zh-CN", "zh"], ["zh-cn", "zh"], ["zh-TW", "zh"], ["zh-HK", "zh"], ["zh_SG", "zh"],
    ["en", "en"], ["en-US", "en"], ["en-GB", "en"],
    ["ja", "ja"], ["ja-JP", "ja"],
    ["ko", "ko"], ["ko-KR", "ko"],
    ["fr", "zh"], ["xx", "zh"], ["", "zh"], [null, "zh"], [undefined, "zh"], [42, "zh"], ["  EN-us  ", "en"]
  ];
  for (const [input, want] of cases) assert.equal(locale.normalizeLocale(input), want, `normalizeLocale(${JSON.stringify(input)})`);
  assert.equal(locale.DEFAULT_LOCALE, "zh");
});

/* ---------------- 2. CONFIG ADMISSION（ko 预备但未开放） ---------------- */

test("ADMISSION: 当前仅 zh/en/ja 可持久化；ko/区域变体/未知拒绝", () => {
  assert.deepEqual(locale.ADMITTED_LOCALES, ["zh", "en", "ja"], "Phase 6 前不开放 ko");
  assert.deepEqual(locale.KNOWN_LOCALES, ["zh", "en", "ja", "ko"], "normalize 认识 ko（预备）");
  assert.equal(locale.isAdmittedLocale("zh"), true);
  assert.equal(locale.isAdmittedLocale("en"), true);
  assert.equal(locale.isAdmittedLocale("ja"), true);
  assert.equal(locale.isAdmittedLocale("ko"), false, "ko 未开放准入");
  assert.equal(locale.isAdmittedLocale("zh-CN"), false, "区域变体不作为持久值");
  assert.equal(locale.isAdmittedLocale("unknown"), false);
});

/* ---------------- 3. MAIN FALLBACK / PARAM ---------------- */

test("MAIN-FALLBACK: t() 经 normalize；selected 缺键回落 zh 值；彻底未知键 fail-safe 返回 key 不 throw", () => {
  // probe 置于本用例最前：需在任何 getEffectiveDict("en") 之前删除键（缓存未生成时验证现算 overlay）
  const probe = "tray.exit";
  const saved = i18n.DICT.en[probe];
  try {
    delete i18n.DICT.en[probe];
    assert.equal(i18n.getEffectiveDict("en")[probe], i18n.DICT.zh[probe], "effective dict 中 selected 缺键已回落 zh");
    assert.equal(i18n.t("en", probe), i18n.DICT.zh[probe], "t() 同样回落 zh（不跨语言泄漏）");
  } finally {
    i18n.DICT.en[probe] = saved;
    i18n.resetEffectiveCache(); // probe 期间生成的缓存已 stale（缺键态），重建后再继续后续断言
  }
  assert.equal(i18n.t("zh-CN", "tray.exit"), i18n.DICT.zh["tray.exit"], "区域变体归一后取 zh");
  assert.equal(i18n.t("en", "tray.exit"), "Exit");
  assert.equal(i18n.t("en", "__no_such_key__"), "__no_such_key__", "未知键 fail-safe=key");
  assert.equal(i18n.t("en", "__no_such_key__", "备用文案"), "备用文案", "旧式字符串 fallback 兼容");
});

test("PARAM: {name} 占位符插值；缺参数保留占位不炸", () => {
  assert.equal(i18n.t("zh", "set.logdiagStats", { n: 12, e: 1, w: 3 }), "共 12 行：错误 1 / 警告 3");
  assert.equal(i18n.t("en", "set.logdiagStats", { n: 12, e: 1, w: 3 }), "12 lines: 1 errors / 3 warnings");
  assert.ok(i18n.t("zh", "set.logdiagStats").includes("{n}"), "无参数时占位符原样保留");
});

/* ---------------- 4. EFFECTIVE DICT（zh base + overlay） ---------------- */

test("EFFECTIVE-DICT: zh 原引用；en/ja 为 zh base + selected overlay；引用稳定（缓存）", () => {
  assert.equal(i18n.getEffectiveDict("zh"), i18n.DICT.zh, "zh 即 base 本身（同引用）");
  assert.equal(i18n.getEffectiveDict("zh-CN"), i18n.DICT.zh, "归一后同引用");
  for (const l of ["en", "ja"]) {
    const eff = i18n.getEffectiveDict(l);
    assert.equal(Object.keys(eff).length, Object.keys(i18n.DICT.zh).length, `${l} 键数=zh`);
    for (const k of Object.keys(i18n.DICT.zh)) {
      const v = eff[k];
      assert.ok(v === i18n.DICT[l][k] || v === i18n.DICT.zh[k], `${l}[${k}] 只能来自 selected 或 zh（绝不来自其他语言）`);
    }
    assert.equal(i18n.getEffectiveDict(l), eff, "进程级缓存：同 locale 同引用");
  }
  assert.equal(i18n.getEffectiveDict("ko-KR"), i18n.DICT.zh, "未收录 locale（ko 未入 catalog）→ zh dict 兜底");
});

/* ---------------- 5. RENDERER CONTRACT（不持 catalog、不持久 locale） ---------------- */

test("RENDERER-CONTRACT: renderer 不 import locale JSON；只消费 IPC effective dict", () => {
  const pet = fs.readFileSync(require.resolve("../renderer/pet.js"), "utf8");
  const settings = fs.readFileSync(require.resolve("../renderer/settings.js"), "utf8");
  assert.doesNotMatch(pet, /require\(["'][^"']*locales\//, "pet.js 不 import locale 文件");
  assert.doesNotMatch(settings, /require\(["'][^"']*locales\//, "settings.js 不 import locale 文件");
  assert.doesNotMatch(rendererI18n, /require\(|import\s/, "renderer/i18n.js 零模块导入（词典仅经 IPC 注入）");
  assert.match(rendererI18n, /petAPI\.getI18n\(\)/, "词典来源=pet:get-i18n");
  assert.match(rendererI18n, /onUiLangChanged/, "订阅运行时切换广播");
  assert.match(rendererI18n, /renderer missing key/, "未知键 fail-safe 带 warn");
  assert.doesNotMatch(rendererI18n, /localStorage|sessionStorage/, "renderer 不持久化语言");
});

/* ---------------- 6. LIVE SWITCH CONTRACT（persist → tray rebuild → broadcast） ---------------- */

test("LIVE-SWITCH: set-ui-lang = normalize+admission → persist → refreshTrayMenu → broadcast 顺序不变", () => {
  const h = mainSource.slice(mainSource.indexOf('ipcMain.handle("pet:set-ui-lang"'), mainSource.indexOf("/** 更新确认框"));
  assert.match(h, /const v = locale\.normalizeLocale\(lang\);/);
  assert.match(h, /if \(!locale\.isAdmittedLocale\(v\)\) return false;/, "ko/未知拒绝准入");
  const persist = h.indexOf("config.saveConfig({ uiLang: v })");
  const rebuild = h.indexOf("refreshTrayMenu()");
  const broadcast = h.indexOf('sendToAllWindows("pet:ui-lang-changed", v)');
  assert.ok(persist !== -1 && rebuild > persist && broadcast > rebuild, "persist → tray rebuild → broadcast 顺序锁定");
  assert.match(mainSource, /const lang = locale\.normalizeLocale\(config\.getConfig\(\)\.uiLang\);\s*return \{ lang, dict: i18n\.getEffectiveDict\(lang\) \}/, "get-i18n 下发 effective dict");
  assert.doesNotMatch(mainSource, /uiLang \|\| "zh"/, "散落默认已收口");
  assert.doesNotMatch(mainSource, /\["zh", "en", "ja"\]\.includes/, "内联白名单已收口到 locale.js");
});

test("SAVE-SETTINGS: uiLang patch 同样经 admission（非 admitted 不写入）", () => {
  const h = mainSource.slice(mainSource.indexOf('ipcMain.handle("pet:save-settings"'), mainSource.indexOf("if (Object.keys(secrets).length)"));
  assert.match(h, /if \(safePatch\.uiLang !== undefined\) \{[\s\S]{0,200}locale\.normalizeLocale\(safePatch\.uiLang\)[\s\S]{0,200}locale\.isAdmittedLocale\(norm\)[\s\S]{0,80}delete safePatch\.uiLang;/);
});

/* ---------------- 7. PACKAGING / ASAR CONTRACT ---------------- */

test("PACKAGING: dist 走 --asar=false 且不排除 locales；三份 catalog 可直接 CommonJS require", () => {
  const dist = pkg.scripts.dist;
  assert.match(dist, /--asar=false/, "electron-packager 非 asar 打包：src/locales/*.json 随目录原样携带");
  assert.doesNotMatch(dist, /--ignore=[^\s]*locales/, "打包不得排除 src/locales");
  for (const l of ["zh", "en", "ja"]) {
    const j = JSON.parse(fs.readFileSync(require.resolve(`../src/locales/${l}.json`), "utf8"));
    assert.ok(Object.keys(j).length > 0, `${l}.json 可 require 且非空`);
  }
});
