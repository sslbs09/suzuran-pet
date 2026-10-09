"use strict";

/**
 * Phase 5-G1 契约：GSV error presentation 命名空间隔离。
 *
 * 修复前 ERROR_PRESENTATIONS 同时含 11 个大写通用码与 4 个 GSV 小写码，
 * 导致 toPresentation({code:"timeout"}) 与 ({code:"TIMEOUT"}) 仅差大小写却落到不同文案，
 * 且小写码得以绕过 error-facts.normalizeCode 进入通用错误事实层。
 *
 * 必覆盖：
 *   1. 普通 TIMEOUT 仍映射 err.timeout
 *   2. GSV timeout 仍显示原有文案
 *   3. ErrorWithCode 不接受小写 timeout
 *   4. 两套 namespace 不混淆
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const facts = require(path.join(root, "src/error-facts.js"));
const presenter = require(path.join(root, "src/error-presenter.js"));
const i18n = require(path.join(root, "src/i18n.js"));
const settingsJs = fs.readFileSync(path.join(root, "renderer/settings.js"), "utf8");

const GSV_CODES = ["timeout", "synth", "disabled", "nopath"];
const GSV_KEYS = { timeout: "err.gsvTimeout", synth: "err.gsvSynthFail", disabled: "err.gsvDisabled", nopath: "err.gsvNoPath" };

/* ---- 1. 普通 TIMEOUT 仍映射 err.timeout ---- */
test("1) the general vocabulary still maps the uppercase codes exactly as before", () => {
  assert.deepEqual(presenter.toPresentation({ code: "TIMEOUT" }), { key: "err.timeout", params: {} });
  assert.equal(presenter.ERROR_PRESENTATIONS.TIMEOUT, "err.timeout");
  // 13 个通用码逐个复核，确保隔离没有误伤（P0-B1 第 12 码 FORMAL_PROJECTION_UNAVAILABLE；
  // P0-B2 §16/§17 第 13 码 PROVIDER_EMPTY_RESPONSE——空 2xx 不得算认知成功）
  const expected = {
    AUTH_INVALID: "err.authInvalid", NO_API_KEY: "err.noApiKey", QUOTA_EXCEEDED: "err.quotaExceeded",
    TIMEOUT: "err.timeout", NETWORK_ERROR: "err.networkError", SSRF_BLOCKED: "err.ssrfBlocked",
    BAD_URL: "err.badUrl", HTTP_ERROR: "err.http", CANCELLED: "err.cancelled",
    BUSY: "err.busy", INTERNAL: "err.internal",
    FORMAL_PROJECTION_UNAVAILABLE: "err.formalProjection",
    PROVIDER_EMPTY_RESPONSE: "err.emptyResponse"
  };
  assert.deepEqual(presenter.ERROR_PRESENTATIONS, expected, "general table must match Phase 5-A + P0-B1/P0-B2 13th code");
  assert.equal(Object.keys(presenter.ERROR_PRESENTATIONS).length, 13);
});

/* ---- 2. GSV timeout 仍显示原有文案 ---- */
test("2) the GSV namespace still renders its original copy in every locale", () => {
  for (const code of GSV_CODES) {
    const got = presenter.toGsvPresentation({ code });
    assert.deepEqual(got, { key: GSV_KEYS[code], params: {} }, code);
    for (const lang of ["zh", "en", "ja"]) {
      const text = i18n.t(lang, got.key);
      assert.ok(String(text).trim() && !text.startsWith("err."), `${lang}:${code} must render real copy`);
    }
  }
  // 与隔离前的 5-D1 文案完全一致（未改任何 err.gsv* 字面量）
  assert.equal(i18n.t("zh", "err.gsvTimeout"), "❌ 重启失败：服务未能在超时内就绪（详见 tts.log）");
  assert.equal(i18n.t("zh", "err.gsvDisabled"), "日语语音服务未启用或配置不完整");
  assert.equal(i18n.t("zh", "err.gsvNoPath"), "语音引擎路径不存在（首次安装未配置）：请在语音设置里填写 Python 路径与服务脚本");
  assert.ok(i18n.t("zh", "err.gsvSynthFail").includes("试合成失败"));
});

/* ---- 3. ErrorWithCode 不接受小写 timeout ---- */
test("3) ErrorWithCode rejects the GSV lowercase codes", () => {
  for (const code of GSV_CODES) {
    assert.equal(facts.ERROR_CODES[code], undefined, `${code} is not a general error code`);
    assert.equal(facts.normalizeCode(code), "INTERNAL");
    const e = new facts.ErrorWithCode(code, { message: "gsv failure", meta: { status: 500 } });
    assert.equal(e.code, "INTERNAL", `ErrorWithCode must normalise ${code} to INTERNAL`);
    assert.deepEqual(e.meta, {}, "a normalised INTERNAL carries no HTTP meta");
    assert.deepEqual(facts.toPayload(e).code, "INTERNAL");
    assert.equal(facts.classifyError(e), "INTERNAL", "classification must not resurrect the lowercase code");
  }
});

/* ---- 4. 两套 namespace 不混淆 ---- */
test("4) the two namespaces cannot leak into each other", () => {
  const general = new Set(Object.keys(presenter.ERROR_PRESENTATIONS));
  const gsv = new Set(Object.keys(presenter.GSV_PRESENTATIONS));
  for (const code of gsv) assert.ok(!general.has(code), `${code} leaked into the general table`);
  for (const code of general) assert.ok(!gsv.has(code), `${code} leaked into the GSV table`);
  for (const code of Object.keys(presenter.ERROR_PRESENTATIONS)) {
    assert.ok(!Object.prototype.hasOwnProperty.call(presenter.GSV_PRESENTATIONS, code));
  }
  // 通用入口不认识小写码；GSV 入口不认识大写码
  for (const code of GSV_CODES) {
    assert.deepEqual(presenter.toPresentation({ code }), { key: "err.unknown", params: {} },
      `general entry must not resolve ${code}`);
  }
  for (const code of general) {
    assert.deepEqual(presenter.toGsvPresentation({ code }), { key: "err.unknown", params: {} },
      `GSV entry must not resolve ${code}`);
  }
  // 大小写仅差一字符时结果必须不同（隔离前二者都命中，只是命中不同表）
  assert.notDeepEqual(presenter.toPresentation({ code: "TIMEOUT" }), presenter.toPresentation({ code: "timeout" }));
  assert.ok(Object.isFrozen(presenter.GSV_PRESENTATIONS));
  assert.ok(Object.isFrozen(presenter.ERROR_PRESENTATIONS));
});

test("4b) unknown and hostile codes still degrade to err.unknown in both entries", () => {
  for (const code of ["__proto__", "constructor", "toString", "", null, undefined, 42, {}, []]) {
    assert.deepEqual(presenter.toPresentation({ code }), { key: "err.unknown", params: {} }, `general ${String(code)}`);
    assert.deepEqual(presenter.toGsvPresentation({ code }), { key: "err.unknown", params: {} }, `gsv ${String(code)}`);
  }
  assert.deepEqual(presenter.toPresentation(null), { key: "err.unknown", params: {} });
  assert.deepEqual(presenter.toGsvPresentation(undefined), { key: "err.unknown", params: {} });
});

/* ---- 消费端：restartGsv 显式分流，通用漏斗不变 ---- */
test("settings routes GSV codes through the shared adapter and leaves the general funnel untouched", () => {
  assert.match(settingsJs, /window\.ErrorPresent\.presentRestartGsv\(r, L\("set\.gsvOk"\)\)/,
    "restartGsv delegates the GSV/general split to the shared adapter");
  // 通用漏斗不得被 GSV 污染，也不得再自带映射逻辑
  const funnel = settingsJs.slice(settingsJs.indexOf("function presentResultError("),
    settingsJs.indexOf("const INTERNAL_FAILURE"));
  assert.match(funnel, /window\.ErrorPresent\.presentError\(result\)/, "general funnel is a thin delegation");
  assert.ok(!/toPresentation/.test(funnel), "presentResultError must stay mapping-free");
  assert.ok(!/gsv/i.test(funnel.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")),
    "presentResultError must stay GSV-free");
  assert.doesNotMatch(settingsJs, /function\s+(presentGsvError|isGsvCode)\s*\(/,
    "5-G2：GSV 分流助手已收口进适配器，页面不得再自建");
});

test("restartGsv IPC contract is untouched: main still returns lowercase GSV codes", () => {
  const mainSource = fs.readFileSync(path.join(root, "main.js"), "utf8");
  for (const code of GSV_CODES) {
    assert.ok(mainSource.includes(`return { ok: false, code: "${code}" }`),
      `pet:restart-gsv must keep emitting code "${code}" (IPC protocol unchanged)`);
  }
});

test("every code either namespace emits is renderable, and vice versa", () => {
  const all = [...Object.keys(presenter.ERROR_PRESENTATIONS), ...Object.keys(presenter.GSV_PRESENTATIONS)];
  assert.equal(new Set(all).size, 17, "13 general (incl. P0-B1 FORMAL_PROJECTION_UNAVAILABLE + P0-B2 PROVIDER_EMPTY_RESPONSE) + 4 GSV, no overlap");
  for (const key of [...Object.values(presenter.ERROR_PRESENTATIONS), ...Object.values(presenter.GSV_PRESENTATIONS)]) {
    for (const lang of ["zh", "en", "ja"]) {
      assert.ok(String(i18n.DICT[lang][key] || "").trim(), `${lang}:${key} missing from catalog`);
    }
  }
});