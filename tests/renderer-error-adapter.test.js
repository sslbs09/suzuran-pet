"use strict";

/**
 * Phase 5-G2 契约：renderer 错误呈现适配器收敛。
 *  - 所有含错误面的页面使用同一个 adapter
 *  - adapter 输出与迁移前逐字一致（5 种历史形状逐一回放）
 *  - legacy fallback 不回归；unknown code fallback 不变
 *  - GSV 分流行为不变
 *  - 页面不得重新实现 ErrorPresenter 调用
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const R = (f) => fs.readFileSync(path.join(root, "renderer", f), "utf8");
const SRC = (f) => fs.readFileSync(path.join(root, f), "utf8"); // 仓库根相对
const code = (f) => R(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const presenter = require(path.join(root, "src/error-presenter.js"));
const i18n = require(path.join(root, "src/i18n.js"));

const ERROR_PAGES = ["addchar", "docs", "moods", "psd", "schedule", "settings", "terms", "voice"];
const LEGACY_MESSAGE = "日程标题不能为空且最多 160 字"; // 迁移前 settings/schedule 形状 B 的真实文案

/** 在 vm 里装载与生产同一份 adapter + presenter + i18n，返回可调用的适配器。 */
async function loadAdapter(lang) {
  const s = { console, document: { documentElement: {}, querySelectorAll: () => [] }, window: null,
    petAPI: { getI18n: async () => ({ lang, dict: i18n.getEffectiveDict(lang) }), onUiLangChanged() {} } };
  s.window = s;
  vm.createContext(s);
  vm.runInContext(SRC("src/error-presenter.js"), s);
  vm.runInContext(R("error-present.js"), s);
  vm.runInContext(R("i18n.js"), s);
  await new Promise((r) => setImmediate(r));
  return s;
}

/* ---- 1. 所有页面使用同一个 adapter ---- */
test("every error-bearing page routes through the shared adapter", () => {
  for (const p of ERROR_PAGES) {
    const src = code(`${p}.js`);
    assert.match(src, /ErrorPresent\.present(Error|RestartGsv)\(/,
      `renderer/${p}.js must call the shared adapter`);
    assert.doesNotMatch(src, /ErrorPresenter\.(toPresentation|toGsvPresentation)/,
      `renderer/${p}.js must not call the presenter directly`);
  }
});

test("pet.js also uses the shared adapter for both of its call sites", () => {
  const src = code("pet.js");
  assert.doesNotMatch(src, /ErrorPresenter\.(toPresentation|toGsvPresentation)/);
  assert.match(src, /window\.ErrorPresent\.presentError\(/);
});

test("every error page loads the adapter, after the presenter and before its own script", () => {
  // index.html 的页面脚本是 pet.js（无 index.js）
  const PAGES = [...ERROR_PAGES.map((p) => [p, `${p}.js`]), ["index", "pet.js"]];
  for (const [p, script] of PAGES) {
    const html = R(`${p}.html`);
    const presenterTag = 'src="../src/error-presenter.js"';
    const adapterTag = 'src="error-present.js"';
    assert.ok(html.includes(adapterTag), `${p}.html must load error-present.js`);
    assert.ok(html.indexOf(presenterTag) < html.indexOf(adapterTag), `${p}: presenter before adapter`);
    assert.ok(html.indexOf(adapterTag) < html.indexOf(`src="${script}"`), `${p}: adapter before ${script}`);
  }
});

test("pages without an error surface are not given the adapter", () => {
  for (const p of ["help", "quickstart"]) {
    assert.ok(!R(`${p}.html`).includes("error-present.js"), `${p}.html has no error surface`);
  }
  // 这两页是纯静态内容页，没有配套脚本，因此也不存在页面级调用点
  for (const p of ["help.js", "quickstart.js"]) {
    if (fs.existsSync(path.join(root, "renderer", p))) {
      assert.ok(!R(p).includes("ErrorPresent."), `${p} has no error surface`);
    }
  }
});

/* ---- 2. adapter 输出与迁移前逐字一致 ---- */
test("adapter reproduces all five pre-migration page shapes verbatim", async () => {
  const hostile = "C:\\Users\\alice\\secret.json sk-live-abcdef token=1";
  for (const lang of ["zh", "en", "ja"]) {
    const s = await loadAdapter(lang);
    const p = s.ErrorPresent.presentError;
    // 形状 A：legacy 走 .error（addchar / docs / schedule 迁移前）
    assert.equal(p({ ok: false, error: "已取消" }), "已取消", `${lang} A.error`);
    // 形状 B：legacy 走 .message（moods / psd / voice / settings 迁移前）
    assert.equal(p({ ok: false, message: LEGACY_MESSAGE }), LEGACY_MESSAGE, `${lang} B.message`);
    // 形状 C：无 legacy 回显（terms 迁移前）——用 legacy:false 复现
    assert.equal(p({ ok: false, error: "x", message: "y" }, { legacy: false }), i18n.t(lang, "err.unknown"), `${lang} C.strict`);
    // 形状 D：pet:error 链
    assert.equal(p({ id: "x", code: "TIMEOUT" }), i18n.t(lang, "err.timeout"), `${lang} D.code`);
    assert.equal(p({ id: "x", message: "legacy pet failure" }), "legacy pet failure", `${lang} D.legacy`);
    assert.equal(p({ id: "x" }), i18n.t(lang, "err.unknown"), `${lang} D.bare`);
    // 形状 E：GSV 分流
    assert.equal(s.ErrorPresent.isGsvCode({ code: "timeout" }), true);
    assert.equal(s.ErrorPresent.isGsvCode({ code: "TIMEOUT" }), false);
    assert.equal(s.ErrorPresent.presentRestartGsv({ ok: false, code: "timeout" }, "OK"), i18n.t(lang, "err.gsvTimeout"));
    assert.equal(s.ErrorPresent.presentRestartGsv({ ok: false, code: "AUTH_INVALID" }, "OK"), i18n.t(lang, "err.authInvalid"));
    assert.equal(s.ErrorPresent.presentRestartGsv({ ok: true, code: "success" }, "OK"), "OK");
    // coded 路径必须忽略 message/meta 中的技术详情
    for (const r of [
      { ok: false, code: "INTERNAL", message: hostile, meta: { path: hostile, status: hostile } },
      { ok: false, code: "HTTP_ERROR", message: hostile, meta: { status: 503, body: hostile } },
      { ok: false, code: "HTTP_ERROR", message: hostile },
      { ok: false, code: "NOT_REAL", message: hostile }
    ]) {
      const out = p(r);
      for (const frag of ["secret.json", "sk-live", "token=1", "{status}", "stack"]) {
        assert.ok(!out.includes(frag), `${lang}: ${frag} leaked into ${out}`);
      }
    }
    assert.equal(p({ ok: false, code: "HTTP_ERROR", meta: { status: 404 } }), i18n.t(lang, "err.http", { status: 404 }));
  }
});

test("adapter is frozen and never reads beyond message/meta/code", async () => {
  const s = await loadAdapter("en");
  assert.ok(Object.isFrozen(s.ErrorPresent), "adapter surface is immutable");
  const src = code("error-present.js");
  assert.doesNotMatch(src, /result\.(detail|stack|code_|_)/, "adapter must not read detail/stack");
  assert.match(src, /hasOwnProperty\.call\(result,\s*"code"\)/, "coded detection unchanged");
});

/* ---- 3. legacy fallback 不回归 ---- */
test("legacy fallback precedence is message → error, and both still work", async () => {
  const s = await loadAdapter("en");
  assert.equal(s.ErrorPresent.legacyText({ message: "M" }), "M");
  assert.equal(s.ErrorPresent.legacyText({ error: "E" }), "E");
  assert.equal(s.ErrorPresent.legacyText({ message: "M", error: "E" }), "M", "documented precedence");
  assert.equal(s.ErrorPresent.legacyText({}), "");
  assert.equal(s.ErrorPresent.legacyText(null), "");
  assert.equal(s.ErrorPresent.legacyText({ message: "" , error: "E" }), "E", "empty message does not shadow error");
});

test("no-code payloads in the repo never carry both fields, so precedence cannot change output", () => {
  const main = SRC("main.js");
  assert.match(main, /function projectedFailure\(error, field = "message"\)/);
  assert.match(main, /\{ ok: false, \[field\]: error\.message \}/, "single computed field only");
  const offenders = [];
  for (const f of ["main.js", "src/credential-import.js", "src/chat-client.js", "src/i18n.js", "src/schedules.js"]) {
    for (const m of SRC(f).matchAll(/\{[^{}]*\}/g)) {
      if (!/\bcode\s*:/.test(m[0]) && /\bmessage\s*:/.test(m[0]) && /\berror\s*:/.test(m[0])) offenders.push(`${f}: ${m[0].slice(0, 80)}`);
    }
  }
  assert.deepEqual(offenders, [], "no no-code payload carries both fields");
});

/* ---- 4. unknown code fallback 不变 ---- */
test("unknown and hostile codes still fall back to err.unknown, never to legacy text", async () => {
  for (const lang of ["zh", "en", "ja"]) {
    const s = await loadAdapter(lang);
    for (const code of ["__proto__", "constructor", "toString", "unknown", "", null, undefined, 42, {}, []]) {
      assert.equal(s.ErrorPresent.presentError({ code, message: "legacy" }), i18n.t(lang, "err.unknown"),
        `${lang}: code ${String(code)}`);
    }
  }
});

/* ---- 5. GSV 分流行为不变 ---- */
test("restartGsv routing is unchanged for every production outcome", async () => {
  const s = await loadAdapter("zh");
  for (const [code, key] of [["timeout", "err.gsvTimeout"], ["synth", "err.gsvSynthFail"],
    ["disabled", "err.gsvDisabled"], ["nopath", "err.gsvNoPath"]]) {
    assert.equal(s.ErrorPresent.presentRestartGsv({ ok: false, code, message: "hostile detail" }, "OK"),
      i18n.t("zh", key), `${code} must keep its original copy`);
  }
  // 非 GSV / 非法码走通用漏斗
  assert.equal(s.ErrorPresent.presentRestartGsv({ ok: false, code: "bad", message: "private" }, "OK"),
    i18n.t("zh", "err.unknown"));
  assert.equal(s.ErrorPresent.presentRestartGsv({ ok: false, message: "legacy" }, "OK"), "legacy");
  assert.equal(s.ErrorPresent.presentRestartGsv(null, "OK"), i18n.t("zh", "err.unknown"));
  // main 仍发小写 GSV 码
  const main = SRC("main.js");
  for (const code of ["timeout", "synth", "disabled", "nopath"]) {
    assert.ok(main.includes(`return { ok: false, code: "${code}" }`), `main still emits ${code}`);
  }
});

/* ---- character content 不得进入 error catalog ---- */
test("the adapter never introduces catalog keys and holds no copy of its own", () => {
  const src = code("error-present.js");
  assert.doesNotMatch(src, /[\u4e00-\u9fff]/, "adapter carries no literal UI copy");
  assert.doesNotMatch(src, /err\.[a-zA-Z]+\s*[:=]/, "adapter defines no code→key mapping of its own");
  const keys = new Set(Object.keys(i18n.DICT.zh).filter((k) => k.startsWith("err.")));
  const before = Object.keys(presenter.ERROR_PRESENTATIONS).length + Object.keys(presenter.GSV_PRESENTATIONS).length;
  assert.equal(before, 15, "presenter vocabulary unchanged by 5-G2");
  assert.ok(keys.size >= 15, "catalog still carries every err.* key");
});