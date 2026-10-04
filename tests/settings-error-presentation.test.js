"use strict";

/**
 * Phase 5-B 契约测试：设置页「结果错误」统一经 Phase 5-A error-presenter 呈现。
 * 覆盖：
 *   1) settings error code → error-presenter → I18N.t（生产函数，非复刻实现）
 *   2) unknown code fallback
 *   3) legacy {ok:false, message} 兼容
 *   4) renderer 不再直接 setResult(message)
 *   5) 技术详情不进入用户展示
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const i18n = require(path.join(root, "src/i18n.js"));

const settingsPath = path.join(root, "renderer/settings.js");
const settingsHtmlPath = path.join(root, "renderer/settings.html");
const mainPath = path.join(root, "main.js");
const credImportPath = path.join(root, "src/credential-import.js");

const settingsSource = fs.readFileSync(settingsPath, "utf8");
const mainSource = fs.readFileSync(mainPath, "utf8");
const credImportSource = fs.readFileSync(credImportPath, "utf8");
const presenterSource = fs.readFileSync(path.join(root, "src/error-presenter.js"), "utf8");
const rendererI18nSource = fs.readFileSync(path.join(root, "renderer/i18n.js"), "utf8");

function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `production function found: ${signature}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated production function: ${signature}`);
}

async function createSettings(lang) {
  const sandbox = {
    console,
    document: { documentElement: {}, querySelectorAll: () => [] },
    window: null,
    petAPI: {
      getI18n: async () => ({ lang, dict: i18n.getEffectiveDict(lang) }),
      onUiLangChanged() {}
    }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(presenterSource, sandbox, { filename: "src/error-presenter.js" });
  vm.runInContext(rendererI18nSource, sandbox, { filename: "renderer/i18n.js" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(sandbox.I18N && typeof sandbox.I18N.t === "function", "renderer I18N ready");
  assert.ok(sandbox.ErrorPresenter && typeof sandbox.ErrorPresenter.toPresentation === "function", "presenter loaded");
  vm.runInContext(extractFunction(settingsSource, "function presentResultError(result)"), sandbox, {
    filename: "renderer/settings.js"
  });
  assert.equal(typeof sandbox.presentResultError, "function", "production helper is callable");
  return sandbox;
}

async function createGsvRestartHandler(lang, outcome) {
  const elements = new Map();
  for (const id of ["btn-restart-gsv", "gsv-result"]) {
    elements.set(id, { disabled: false, textContent: "", className: "" });
  }
  const callbacks = {};
  const sandbox = {
    console,
    document: { documentElement: {}, querySelectorAll: () => [], getElementById: (id) => elements.get(id) },
    window: null,
    petAPI: {
      getI18n: async () => ({ lang, dict: i18n.getEffectiveDict(lang) }),
      onUiLangChanged() {},
      restartGsv: async () => {
        if (outcome instanceof Error) throw outcome;
        return outcome;
      }
    },
    setTimeout,
    clearTimeout
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(presenterSource, sandbox, { filename: "src/error-presenter.js" });
  vm.runInContext(rendererI18nSource, sandbox, { filename: "renderer/i18n.js" });
  await new Promise((resolve) => setImmediate(resolve));
  sandbox.$ = (id) => elements.get(id);
  sandbox.L = (key, params) => sandbox.I18N.t(key, params);
  vm.runInContext(extractFunction(settingsSource, "function setResult(el, text, ok)"), sandbox, { filename: "renderer/settings.js" });
  vm.runInContext(extractFunction(settingsSource, "function presentResultError(result)"), sandbox, { filename: "renderer/settings.js" });
  // 5-G1：restartGsv 的 GSV 分流助手（声明在监听器之前，需与点击处理器一并装载）
  vm.runInContext(extractFunction(settingsSource, "function presentGsvError(result)"), sandbox, { filename: "renderer/settings.js" });
  vm.runInContext(extractFunction(settingsSource, "function isGsvCode(result)"), sandbox, { filename: "renderer/settings.js" });
  const start = settingsSource.indexOf('$("btn-restart-gsv").addEventListener');
  const end = settingsSource.indexOf('$("btn-save-voice")', start);
  assert.ok(start !== -1 && end > start, "production restartGsv click handler found");
  sandbox.$("btn-restart-gsv").addEventListener = (event, cb) => { callbacks[event] = cb; };
  vm.runInContext(settingsSource.slice(start, end), sandbox, { filename: "renderer/settings.js" });
  return { elements, callbacks };
}

test("production restartGsv handler presents all four failure codes and preserves lifecycle", async () => {
  const cases = [
    ["timeout", "err.gsvTimeout"],
    ["synth", "err.gsvSynthFail"],
    ["disabled", "err.gsvDisabled"],
    ["nopath", "err.gsvNoPath"]
  ];
  for (const lang of ["zh", "en", "ja"]) {
    for (const [code, key] of cases) {
      const h = await createGsvRestartHandler(lang, { ok: false, code, message: "hostile technical detail" });
      const btn = h.elements.get("btn-restart-gsv");
      const out = h.elements.get("gsv-result");
      const run = h.callbacks.click();
      assert.equal(btn.disabled, true, `${lang} ${code} disables during restart`);
      await run;
      assert.equal(btn.disabled, false, `${lang} ${code} re-enables after restart`);
      assert.equal(out.textContent, i18n.t(lang, key));
      assert.equal(out.className, "result err");
      assert.ok(!out.textContent.includes("hostile"));
    }
    const success = await createGsvRestartHandler(lang, { ok: true, code: "success" });
    await success.callbacks.click();
    assert.equal(success.elements.get("gsv-result").textContent, i18n.t(lang, "set.gsvOk"));
    assert.equal(success.elements.get("gsv-result").className, "result ok");
    const rejected = await createGsvRestartHandler(lang, new Error("private stack/path"));
    await rejected.callbacks.click();
    assert.equal(rejected.elements.get("gsv-result").textContent, i18n.t(lang, "err.gsvTimeout"));
    const malformed = await createGsvRestartHandler(lang, { ok: false, code: "bad", message: "private detail" });
    await malformed.callbacks.click();
    assert.equal(malformed.elements.get("gsv-result").textContent, i18n.t(lang, "err.unknown"));
  }
});

/* 1) settings error code → error-presenter */
test("settings helper routes every coded result through the shared presenter", async () => {
  const cases = [
    ["AUTH_INVALID", {}, "err.authInvalid"],
    ["NO_API_KEY", {}, "err.noApiKey"],
    ["QUOTA_EXCEEDED", {}, "err.quotaExceeded"],
    ["TIMEOUT", {}, "err.timeout"],
    ["NETWORK_ERROR", {}, "err.networkError"],
    ["SSRF_BLOCKED", {}, "err.ssrfBlocked"],
    ["BAD_URL", {}, "err.badUrl"],
    ["CANCELLED", {}, "err.cancelled"],
    ["BUSY", {}, "err.busy"],
    ["INTERNAL", {}, "err.internal"],
    ["HTTP_ERROR", { status: 503 }, "err.http"]
  ];
  for (const lang of ["zh", "en", "ja"]) {
    const s = await createSettings(lang);
    for (const [code, meta, key] of cases) {
      const got = s.presentResultError({ ok: false, code, meta });
      assert.equal(got, i18n.t(lang, key, code === "HTTP_ERROR" ? { status: 503 } : {}), `${lang} ${code}`);
      assert.ok(got && got !== key, `${lang} ${code} resolves to catalog text, not the bare key`);
    }
  }
});

test("settings helper no longer resolves GSV codes — they belong to their own namespace (5-G1)", async () => {
  for (const lang of ["zh", "en", "ja"]) {
    const s = await createSettings(lang);
    for (const code of ["timeout", "synth", "disabled", "nopath"]) {
      assert.equal(s.presentResultError({ ok: false, code, message: "legacy text" }),
        i18n.t(lang, "err.unknown"),
        `${lang} ${code} must not resolve through the general funnel`);
    }
  }
});

test("settings helper interpolates only validated HTTP status and degrades to generic text", async () => {
  const s = await createSettings("en");
  assert.equal(s.presentResultError({ ok: false, code: "HTTP_ERROR", meta: { status: 404 } }), i18n.t("en", "err.http", { status: 404 }));
  assert.ok(s.presentResultError({ ok: false, code: "HTTP_ERROR", meta: { status: 404 } }).includes("404"));
  for (const status of [undefined, null, "503", 99, 600, 503.5, NaN]) {
    const got = s.presentResultError({ ok: false, code: "HTTP_ERROR", meta: { status } });
    assert.equal(got, i18n.t("en", "err.httpGeneric"), `invalid status ${String(status)}`);
    assert.ok(!got.includes("{status}"), "no placeholder survives");
  }
  assert.equal(s.presentResultError({ ok: false, code: "HTTP_ERROR" }), i18n.t("en", "err.httpGeneric"));
});

/* 2) unknown code fallback */
test("settings helper maps any unrecognized code to err.unknown, never to message", async () => {
  for (const lang of ["zh", "en", "ja"]) {
    const s = await createSettings(lang);
    for (const code of ["__proto__", "constructor", "toString", "NOT_A_CODE", "", 0, false, null, undefined, {}, []]) {
      const got = s.presentResultError({ ok: false, code, message: "legacy text that must not surface" });
      assert.equal(got, i18n.t(lang, "err.unknown"), `${lang} code=${String(code)}`);
      assert.ok(!got.includes("legacy text"), "unknown code must not fall back to message");
    }
  }
});

test("settings helper returns err.unknown for results with neither code nor message", async () => {
  for (const lang of ["zh", "en", "ja"]) {
    const s = await createSettings(lang);
    for (const r of [null, undefined, false, 0, "", { ok: false }, { ok: false, message: "" }]) {
      assert.equal(s.presentResultError(r), i18n.t(lang, "err.unknown"), `${lang} ${JSON.stringify(r) ?? "undefined"}`);
    }
  }
});

/* 3) legacy {ok:false, message} compatibility */
test("settings helper preserves exact legacy message when no code field is present", async () => {
  for (const lang of ["zh", "en", "ja"]) {
    const s = await createSettings(lang);
    const legacy = "该名称已存在，请换一个";
    assert.equal(s.presentResultError({ ok: false, message: legacy }), legacy);
    assert.equal(s.presentResultError({ message: legacy }), legacy);
    const englishLegacy = "The entry already exists, please pick another";
    assert.equal(s.presentResultError({ ok: false, message: englishLegacy }), englishLegacy);
  }
});

test("settings helper prefers presenter over message whenever a code field exists", async () => {
  for (const lang of ["zh", "en", "ja"]) {
    const s = await createSettings(lang);
    assert.equal(
      s.presentResultError({ ok: false, code: "TIMEOUT", message: "legacy timeout text" }),
      i18n.t(lang, "err.timeout"),
      "a valid code must win over a legacy message"
    );
  }
});

/* 4) renderer 不再直接 setResult(message) */
test("settings.html loads the Phase 5-A presenter before settings.js", () => {
  const html = fs.readFileSync(settingsHtmlPath, "utf8");
  const presenterTag = html.match(/<script\s+src="([^"]*error-presenter\.js)"\s*><\/script>/);
  assert.ok(presenterTag, "settings.html loads src/error-presenter.js");
  assert.equal(
    path.resolve(path.dirname(settingsHtmlPath), presenterTag[1]),
    path.join(root, "src/error-presenter.js"),
    "HTML loads the same presenter the tests exercise"
  );
  assert.ok(html.indexOf(presenterTag[0]) < html.indexOf('src="settings.js"'), "presenter loads before settings.js");
});

test("settings.js defines exactly one error presentation funnel and uses it broadly", () => {
  assert.equal(
    (settingsSource.match(/function presentResultError\(/g) || []).length,
    1,
    "one helper definition only — no second error system"
  );
  const uses = (settingsSource.match(/presentResultError\(/g) || []).length - 1;
  assert.ok(uses >= 20, `expected the funnel to cover the settings result surfaces, got ${uses} call sites`);
});

test("no settings.js failure path renders result.message, e.message or r.error directly", () => {
  // 仅允许三类既有例外；新增任何直接渲染都必须先改本测试并写明理由。
  const allowed = [
    /function presentResultError\(result\)/, // 兼容分支本体
    /e\.message（可能含路径\/堆栈）/, // 注释
    /^.*console\.log.*$/, // 日志（不在本阶段范围）
    /setResult\(resultEl, String\(e && e\.message/ // 日志诊断分区（log/debug，属 5-C/5-D）
  ];
  const leak = /String\(e\s*&&\s*e\.message|String\(e\.message|\br\.message\b|\(r\s*&&\s*r\.message|\(SCAN\s*&&\s*SCAN\.message|\br\.error\s*\|\|/;
  const offenders = settingsSource
    .split("\n")
    .map((line, i) => ({ line: line.replace(/\r$/, ""), n: i + 1 }))
    .filter(({ line }) => leak.test(line) && !allowed.some((rx) => rx.test(line)));

  // testChat 成功分支按 ok 守卫，仍允许展示成功文案；失败分支必须走 presenter。
  const successGuarded = offenders.filter(({ line }) => /r\.ok\s*\?\s*r\.message\s*:\s*presentResultError\(r\)/.test(line));
  const unexpected = offenders.filter((o) => !successGuarded.includes(o));

  assert.deepEqual(
    unexpected.map((o) => `${o.n}: ${o.line.trim()}`),
    [],
    "failure paths must route through presentResultError"
  );
  assert.equal(successGuarded.length, 1, "exactly one r.message site remains, guarded by r.ok");
});

/* 5) 技术详情不会进入用户展示 */
test("technical detail in message and meta never reaches settings output", async () => {
  const hostile = "stack at C:\\Users\\alice\\secret.js:8 /opt/private/key.json 203.0.113.42 sk-fake-token {\"error\":\"<html>private body</html>\"}";
  for (const lang of ["zh", "en", "ja"]) {
    const s = await createSettings(lang);
    for (const r of [
      { ok: false, code: "INTERNAL", message: hostile, meta: { path: hostile, token: hostile, body: hostile } },
      { ok: false, code: "HTTP_ERROR", message: hostile, meta: { status: 503, path: hostile, body: hostile } },
      { ok: false, code: "TIMEOUT", message: hostile, meta: { token: hostile } },
      { ok: false, code: "NOT_REAL", message: hostile, meta: { status: hostile } }
    ]) {
      const got = s.presentResultError(r);
      for (const fragment of ["stack", "secret.js", "key.json", "203.0.113.42", "sk-fake-token", "<html>", "{\"error\""]) {
        assert.ok(!got.includes(fragment), `${lang}: ${fragment} leaked into ${got}`);
      }
    }
  }
});

test("coded main-process results carry a code the helper can localize", () => {
  // 这些是 5-B 迁移过的设置面 handler：失败必须带 code，否则 renderer 会回落到 legacy message。
  const codedHandlers = [
    'ipcMain.handle("pet:reset-persona"',
    'ipcMain.handle("pet:clear-secret"',
    'ipcMain.handle("pet:clear-translate-cache"',
    'ipcMain.handle("pet:fixed-lines-clear"',
    'ipcMain.handle("pet:fixed-lines-clear-old"',
    'ipcMain.handle("pet:add-agent-client"',
    'ipcMain.handle("pet:add-memory-fact"',
    'ipcMain.handle("pet:update-memory-fact"',
    'ipcMain.handle("pet:emotion-audition"'
  ];
  for (const marker of codedHandlers) {
    const at = mainSource.indexOf(marker);
    assert.notEqual(at, -1, `handler present: ${marker}`);
    const region = mainSource.slice(at, at + 1400);
    const handlerEnd = region.indexOf("\n});");
    const body = handlerEnd === -1 ? region : region.slice(0, handlerEnd);
    assert.ok(/code:\s*"INTERNAL"/.test(body), `${marker} failure path emits code: "INTERNAL"`);
  }
  assert.ok(
    /function fail\(message, code\)/.test(credImportSource),
    "credential-import fail() accepts an explicit code"
  );
  assert.equal(
    (credImportSource.match(/fail\((?:[^()]|\([^()]*\))*,\s*"INTERNAL"\)/g) || []).length,
    2,
    "only credential-import exception paths are coded; validation copy keeps the legacy fallback"
  );
});
