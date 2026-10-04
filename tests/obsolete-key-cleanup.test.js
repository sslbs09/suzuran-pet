"use strict";

/**
 * Phase 5-F3 契约：obsolete key 清理。
 *  - 被 presenter / err.gsv* 取代的死键必须已从三语移除
 *  - 预留键（动态构造、未来绑定）必须仍在，防止过度清理
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const i18n = require(path.join(root, "src/i18n.js"));
const locales = (lang) => JSON.parse(fs.readFileSync(path.join(root, "src/locales", `${lang}.json`), "utf8"));

/** 5-B legacy fallback：presenter 接管后 renderer 不再回落到这些文案 */
const LEGACY_FALLBACK_KEYS = [
  "set.delFailed", "set.agentAddFailed", "set.clearFailed", "set.credScanFailed",
  "set.credImportFailed", "set.memEditFailed", "set.memAddFailed", "set.audFailed",
  "set.personaResetFail", "set.fixedReloadFail", "set.fixedClearFail",
  "set.fixedClearOldFail", "set.fixedNotStartedRun", "set.logdiagReadFail"
];
/** GSV 迁移旧键：由 err.gsv* 取代（presenter 的小写 GSV 命名空间可达） */
const GSV_LEGACY_KEYS = ["set.gsvTimeout", "set.gsvSynthFail", "set.gsvDisabled", "set.gsvNoPath"];
const REMOVED = [...LEGACY_FALLBACK_KEYS, ...GSV_LEGACY_KEYS];

/** 动态构造 / 预留键：字面量扫描永远命中不到，任何清理都必须放过它们 */
const RESERVED = [
  "set.seatTier.small", "set.seatTier.standard", "set.seatTier.winterLarge", // L("set.seatTier." + t)
  "set.pool.pat", "set.pool.proactive.morning", "set.pool.state.walking",    // L("set.pool." + …)
  "set.loading", "set.bubbleAuto", "set.rmHint", "set.fixedBtnToggle",
  "set.fixedProfileLoading", "set.fixedStateUnchecked", "set.fixedSummaryInit",
  "set.agentTokenPh", "ui.petAlt", "ui.ttsTitle", "ui.modeChipTitle", "pet.poutPrefix",
  "tray.sizeWordSmall", "tray.rateWordSlow", "common.ok", "skin.builtin"
];

test("obsolete keys are gone from all three locales", () => {
  for (const lang of ["zh", "en", "ja"]) {
    const dict = locales(lang);
    for (const key of REMOVED) {
      assert.equal(dict[key], undefined, `${lang}:${key} should have been removed`);
    }
  }
});

test("the replacements those keys deferred to are still present", () => {
  for (const lang of ["zh", "en", "ja"]) {
    const dict = locales(lang);
    assert.ok(String(dict["err.unknown"] || "").trim(), `${lang}:err.unknown is the fallback now in use`);
    assert.ok(String(dict["err.internal"] || "").trim(), `${lang}:err.internal`);
    for (const key of ["err.gsvTimeout", "err.gsvSynthFail", "err.gsvDisabled", "err.gsvNoPath"]) {
      assert.ok(String(dict[key] || "").trim(), `${lang}:${key} must remain — it replaced set.gsv*`);
    }
  }
});

test("the GSV replacement keys are still reachable from a presenter code", () => {
  const presenter = require(path.join(root, "src/error-presenter.js"));
  for (const [code, key] of [["timeout", "err.gsvTimeout"], ["synth", "err.gsvSynthFail"],
    ["disabled", "err.gsvDisabled"], ["nopath", "err.gsvNoPath"]]) {
    assert.equal(presenter.ERROR_PRESENTATIONS[code], key, `code "${code}" must still map to ${key}`);
    assert.deepEqual(presenter.toPresentation({ code }), { key, params: {} }, code);
  }
});

test("dynamically constructed / reserved keys were NOT over-cleaned", () => {
  for (const lang of ["zh", "en", "ja"]) {
    const dict = locales(lang);
    for (const key of RESERVED) {
      assert.ok(String(dict[key] || "").trim(), `${lang}:${key} is reserved and must stay`);
    }
  }
});

test("deletion preserved catalog invariants", () => {
  const zh = Object.keys(i18n.DICT.zh), en = Object.keys(i18n.DICT.en), ja = Object.keys(i18n.DICT.ja);
  assert.equal(zh.length, 959);
  assert.equal(en.length, zh.length, "en key count matches zh");
  assert.equal(ja.length, zh.length, "ja key count matches zh");
  assert.deepEqual(zh.filter((k) => !en.includes(k)), [], "zh/en key sets identical");
  assert.deepEqual(zh.filter((k) => !ja.includes(k)), [], "zh/ja key sets identical");
  const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const k of zh) {
    assert.deepEqual(ph(i18n.DICT.en[k]), ph(i18n.DICT.zh[k]), `${k} en params`);
    assert.deepEqual(ph(i18n.DICT.ja[k]), ph(i18n.DICT.zh[k]), `${k} ja params`);
  }
});

test("no dangling reference to a removed key anywhere in the repo", () => {
  const files = [];
  const self = path.join(root, "tests/obsolete-key-cleanup.test.js");
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (/node_modules|\.git|locales/.test(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (/\.(js|html)$/.test(e.name)) files.push(p);
    }
  };
  walk(path.join(root, "renderer")); walk(path.join(root, "src")); walk(path.join(root, "tests"));
  files.push(path.join(root, "main.js"));
  const offenders = [];
  for (const f of files) {
    if (f === self) continue; // 本文件以「键名清单」为测试数据，不算引用
    const s = fs.readFileSync(f, "utf8");
    for (const key of REMOVED) {
      if (s.includes(`"${key}"`) || s.includes(`'${key}'`)) offenders.push(`${path.relative(root, f)} → ${key}`);
    }
  }
  assert.deepEqual(offenders, [], `removed keys are still referenced: ${offenders.join(", ")}`);
});