"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const i18n = require(path.join(root, "src/i18n.js"));
const presenterPath = path.join(root, "src/error-presenter.js");
const priorGlobalPresenter = globalThis.ErrorPresenter;
const presenter = require(presenterPath);

const CODE_KEYS = {
  AUTH_INVALID: "err.authInvalid",
  NO_API_KEY: "err.noApiKey",
  QUOTA_EXCEEDED: "err.quotaExceeded",
  TIMEOUT: "err.timeout",
  NETWORK_ERROR: "err.networkError",
  SSRF_BLOCKED: "err.ssrfBlocked",
  BAD_URL: "err.badUrl",
  HTTP_ERROR: "err.http",
  CANCELLED: "err.cancelled",
  BUSY: "err.busy",
  INTERNAL: "err.internal"
};

/* 5-G1：GSV 引擎专属码，独立命名空间，不参与通用词表 */
const GSV_CODE_KEYS = {
  timeout: "err.gsvTimeout",
  synth: "err.gsvSynthFail",
  disabled: "err.gsvDisabled",
  nopath: "err.gsvNoPath"
};

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

async function createRenderer(lang) {
  const petSource = fs.readFileSync(path.join(root, "renderer/pet.js"), "utf8");
  const i18nSource = fs.readFileSync(path.join(root, "renderer/i18n.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "renderer/index.html"), "utf8");
  const presenterScript = html.match(/<script\s+src="([^"]*error-presenter\.js)"\s*><\/script>/);
  const petScript = html.indexOf('src="pet.js"');
  assert.ok(presenterScript && html.indexOf(presenterScript[0]) >= 0 && html.indexOf(presenterScript[0]) < petScript,
    "presenter loads before pet.js");
  const loadedPresenter = path.resolve(path.dirname(path.join(root, "renderer/index.html")), presenterScript[1]);
  assert.equal(loadedPresenter, presenterPath, "HTML loads the same presenter tested below");
  const presenterSource = fs.readFileSync(loadedPresenter, "utf8");

  const callbacks = {};
  const bubbleText = { textContent: "" };
  const classes = new Set();
  const effects = [];
  const sandbox = {
    console,
    document: { documentElement: {}, querySelectorAll: () => [] },
    window: null,
    petAPI: {
      getI18n: async () => ({ lang, dict: i18n.getEffectiveDict(lang) }),
      onUiLangChanged() {},
      onError: (cb) => { callbacks.error = cb; }
    },
    bubbleText,
    bubbleEl: { classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) } },
    busy: true,
    hideThinking: () => effects.push("hideThinking"),
    setMood: (mood) => effects.push(`mood:${mood}`),
    showBubble: () => effects.push("showBubble"),
    updateControls: () => effects.push("updateControls"),
    scheduleBubbleHide: () => effects.push("scheduleBubbleHide"),
    setTimeout: () => 0,
    clearTimeout() {},
    maybeFlushPendingSend: () => effects.push("flushPendingSend"),
    speak: (text) => effects.push(`speak:${text}`),
    flushPendingAmbient() {},
    SPEECH_DIAG: false,
    diagThinkingId: 0
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(presenterSource, sandbox, { filename: "src/error-presenter.js" });
  vm.runInContext(i18nSource, sandbox, { filename: "renderer/i18n.js" });
  await new Promise((resolve) => setImmediate(resolve));
  vm.runInContext(extractFunction(petSource, "function showError(msg)"), sandbox, { filename: "renderer/pet.js" });
  const handlerStart = petSource.indexOf("window.petAPI.onError(");
  const handlerEnd = petSource.indexOf("// v2.6 主动停止", handlerStart);
  assert.ok(handlerStart !== -1 && handlerEnd > handlerStart, "production pet:error handler region found");
  vm.runInContext(petSource.slice(handlerStart, handlerEnd), sandbox, { filename: "renderer/pet.js" });
  assert.equal(typeof callbacks.error, "function", "production onError callback registered");
  return { callbacks, bubbleText, effects, sandbox, classes };
}

test("presenter maps every approved code and rejects inherited property names", () => {
  const api = presenter;
  for (const [code, key] of Object.entries(CODE_KEYS)) {
    const meta = code === "HTTP_ERROR" ? { status: 500 } : {};
    assert.deepEqual(api.toPresentation({ code, meta }), code === "HTTP_ERROR" ? { key, params: { status: 500 } } : { key, params: {} }, code);
  }
  // 5-G1：GSV 小写码不再属于通用命名空间，通用入口一律不认
  for (const [code, key] of Object.entries(GSV_CODE_KEYS)) {
    assert.equal(api.ERROR_PRESENTATIONS[code], undefined, `${code} must not sit in the general table`);
    assert.equal(api.GSV_PRESENTATIONS[code], key, `${code} must sit in the GSV table`);
    assert.deepEqual(api.toPresentation({ code }), { key: "err.unknown", params: {} }, `general ${code}`);
    assert.deepEqual(api.toGsvPresentation({ code }), { key, params: {} }, `gsv ${code}`);
  }
  for (const code of ["unknown", "", null, undefined, "__proto__", "constructor", "toString"]) {
    assert.deepEqual(api.toPresentation({ code }), { key: "err.unknown", params: {} }, String(code));
    assert.deepEqual(api.toGsvPresentation({ code }), { key: "err.unknown", params: {} }, `gsv ${String(code)}`);
  }
  assert.ok(Object.isFrozen(api.ERROR_PRESENTATIONS), "presentation mapping is immutable");
  assert.ok(Object.isFrozen(api.GSV_PRESENTATIONS), "GSV mapping is immutable");
  for (const input of [null, undefined, 7, "INTERNAL", true]) {
    assert.deepEqual(api.toPresentation(input), { key: "err.unknown", params: {} });
    assert.deepEqual(api.toGsvPresentation(input), { key: "err.unknown", params: {} });
  }
  assert.equal(globalThis.ErrorPresenter, priorGlobalPresenter, "CommonJS require does not install a global presenter");
});

test("presenter accepts only integer HTTP status and never echoes message or arbitrary metadata", () => {
  const api = presenter;
  const meta = Object.freeze({ status: 503, message: "secret", path: "C:\\private\\token.txt", token: "sk-fake" });
  const payload = { code: "HTTP_ERROR", meta, message: "raw upstream body <html>token=sk-fake</html>" };
  assert.deepEqual(api.toPresentation(payload), { key: "err.http", params: { status: 503 } });
  assert.deepEqual(payload.meta, { status: 503, message: "secret", path: "C:\\private\\token.txt", token: "sk-fake" }, "input is not mutated");
  for (const status of [undefined, null, "503", 99, 600, 503.5, NaN, {}, { valueOf: () => 503 }]) {
    const got = api.toPresentation({ code: "HTTP_ERROR", meta: { status } });
    assert.deepEqual(got, { key: "err.httpGeneric", params: {} });
    assert.ok(!i18n.t("en", got.key, got.params).includes("{status}"), "invalid status leaves no placeholder");
  }
  assert.deepEqual(api.toPresentation({ code: "HTTP_ERROR" }), { key: "err.httpGeneric", params: {} }, "missing meta uses generic HTTP text");
  for (const status of [100, 599]) {
    assert.deepEqual(api.toPresentation({ code: "HTTP_ERROR", meta: { status } }), { key: "err.http", params: { status } });
  }
  assert.deepEqual(api.toPresentation({ code: "INTERNAL", meta, message: payload.message }), { key: "err.internal", params: {} });
});

test("error catalog has the same keys and placeholder names in zh/en/ja", () => {
  const expected = [...Object.values(CODE_KEYS), ...Object.values(GSV_CODE_KEYS), "err.unknown", "err.httpGeneric"].sort();
  for (const lang of ["zh", "en", "ja"]) {
    const actual = Object.keys(i18n.DICT[lang]).filter((key) => key.startsWith("err.")).sort();
    assert.deepEqual(actual, expected, `${lang} err.* key set`);
    for (const key of expected) assert.ok(i18n.DICT[lang][key].trim(), `${lang}:${key} nonempty`);
  }
  for (const key of expected) {
    const params = (lang) => [...i18n.DICT[lang][key].matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    assert.deepEqual(params("en"), params("zh"), `${key} zh/en params`);
    assert.deepEqual(params("ja"), params("zh"), `${key} zh/ja params`);
  }
  assert.deepEqual([...i18n.DICT.en["err.http"].matchAll(/\{(\w+)\}/g)].map((m) => m[1]), ["status"]);
  assert.deepEqual([...i18n.DICT.en["err.httpGeneric"].matchAll(/\{(\w+)\}/g)], []);
});

test("real renderer onError localizes code and excludes untrusted message/meta in all locales", async () => {
  const hostile = "stack at C:\\Users\\alice\\secret.js:8 /opt/private/key.json 203.0.113.42 sk-fake-token {\"error\":\"<html>private body</html>\"}";
  for (const lang of ["zh", "en", "ja"]) {
    for (const { payload, key, params } of [
      { payload: { id: "x", code: "AUTH_INVALID", message: hostile, meta: { token: hostile, path: hostile, body: hostile } }, key: "err.authInvalid", params: {} },
      { payload: { id: "x", code: "__proto__", message: hostile, meta: { status: hostile } }, key: "err.unknown", params: {} },
      { payload: { id: "x", code: "HTTP_ERROR", message: hostile, meta: { status: 503, path: hostile } }, key: "err.http", params: { status: 503 } },
      { payload: { id: "x", code: "HTTP_ERROR", meta: { status: hostile } }, key: "err.httpGeneric", params: {} },
      { payload: { id: "x", code: "HTTP_ERROR", message: hostile }, key: "err.httpGeneric", params: {} },
      { payload: { id: "x" }, key: "err.unknown", params: {} }
    ]) {
      const h = await createRenderer(lang);
      h.callbacks.error(payload);
      assert.equal(h.bubbleText.textContent, `苏苏洛委屈地撇撇嘴：${i18n.t(lang, key, params)}`);
      assert.ok(!h.bubbleText.textContent.includes("stack"));
      assert.ok(!h.bubbleText.textContent.includes("C:\\Users\\alice\\secret.js"));
      assert.ok(!h.bubbleText.textContent.includes("/opt/private/key.json"));
      assert.ok(!h.bubbleText.textContent.includes("sk-fake-token"));
      assert.ok(!h.bubbleText.textContent.includes("203.0.113.42"));
      assert.ok(!h.bubbleText.textContent.includes("private"));
      assert.ok(!h.bubbleText.textContent.includes("<html>"));
      assert.ok(!h.bubbleText.textContent.includes("{\"error\""));
      assert.equal(h.effects.includes("speak:唔……出错了。"), true, "existing speech side effect remains");
    }
  }
});

test("real renderer treats every present but invalid code as coded and never falls back to message", async () => {
  const hostile = "private C:\\secret\\token.json sk-fake 203.0.113.8";
  for (const code of ["", null, undefined, false, 0, {}]) {
    const h = await createRenderer("en");
    h.callbacks.error({ id: "x", code, message: hostile });
    assert.equal(h.bubbleText.textContent, `苏苏洛委屈地撇撇嘴：${i18n.t("en", "err.unknown")}`);
    assert.ok(!h.bubbleText.textContent.includes("private"));
    assert.ok(!h.bubbleText.textContent.includes("sk-fake"));
    assert.ok(!h.bubbleText.textContent.includes("203.0.113.8"));
  }
});

test("real renderer preserves exact legacy message when pet:error has no code", async () => {
  const legacy = "legacy provider failure: C:\\old\\path.js";
  const h = await createRenderer("en");
  h.callbacks.error({ id: "x", message: legacy });
  assert.equal(h.bubbleText.textContent, `苏苏洛委屈地撇撇嘴：${legacy}`);
  const malformed = await createRenderer("en");
  malformed.callbacks.error({ id: "x" });
  assert.equal(malformed.bubbleText.textContent, `苏苏洛委屈地撇撇嘴：${i18n.t("en", "err.unknown")}`);
});

test("real renderer translates presentation text through active locale", async () => {
  for (const lang of ["zh", "en", "ja"]) {
    const h = await createRenderer(lang);
    h.callbacks.error({ code: "TIMEOUT" });
    assert.equal(h.bubbleText.textContent, `苏苏洛委屈地撇撇嘴：${i18n.t(lang, "err.timeout")}`);
  }
});
