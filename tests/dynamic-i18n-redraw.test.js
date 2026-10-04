"use strict";

/**
 * Phase 4-B1 — dynamic redraw ownership closure 契约（2026-10-03）：
 * A 单一 locale 订阅；B i18n onChange 管线顺序；C 语言切换零业务副作用；
 * D 动态节点双 owner 已解除；E state 保持（render 从既有 state 重绘）；F 新键 catalog。
 * Phase 1–3 既有契约（substrate/parity/main-native/static）由各自测试继续守护。
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");

const i18n = require("../src/i18n");

const SRC = {
  i18n: fs.readFileSync(require.resolve("../renderer/i18n.js"), "utf8"),
  settings: fs.readFileSync(require.resolve("../renderer/settings.js"), "utf8"),
  pet: fs.readFileSync(require.resolve("../renderer/pet.js"), "utf8"),
  terms: fs.readFileSync(require.resolve("../renderer/terms.js"), "utf8"),
  docs: fs.readFileSync(require.resolve("../renderer/docs.js"), "utf8"),
  settingsHtml: fs.readFileSync(require.resolve("../renderer/settings.html"), "utf8"),
  voiceHtml: fs.readFileSync(require.resolve("../renderer/voice.html"), "utf8"),
  psdHtml: fs.readFileSync(require.resolve("../renderer/psd.html"), "utf8"),
  moodsHtml: fs.readFileSync(require.resolve("../renderer/moods.html"), "utf8"),
  termsHtml: fs.readFileSync(require.resolve("../renderer/terms.html"), "utf8"),
  docsHtml: fs.readFileSync(require.resolve("../renderer/docs.html"), "utf8"),
  indexHtml: fs.readFileSync(require.resolve("../renderer/index.html"), "utf8"),
  voiceJs: fs.readFileSync(require.resolve("../renderer/voice.js"), "utf8"),
  psdJs: fs.readFileSync(require.resolve("../renderer/psd.js"), "utf8"),
  moodsJs: fs.readFileSync(require.resolve("../renderer/moods.js"), "utf8")
};

/* ---------- A. 单一 locale 订阅 ---------- */

test("B1-SINGLE-SUBSCRIPTION: 业务脚本不再自行监听 petAPI.onUiLangChanged；i18n.js 是唯一入口", () => {
  assert.equal((SRC.i18n.match(/petAPI\.onUiLangChanged\(/g) || []).length, 1, "唯一订阅调用点（存在性检查无左括号调用）");
  assert.match(SRC.i18n, /if \(window\.petAPI && window\.petAPI\.onUiLangChanged\) \{\s*window\.petAPI\.onUiLangChanged\(\(\) => \{ refresh\(\)/, "唯一订阅且走 refresh 管线");
  for (const [name, src] of Object.entries({ settings: SRC.settings, pet: SRC.pet, terms: SRC.terms, docs: SRC.docs, voice: SRC.voiceJs, psd: SRC.psdJs, moods: SRC.moodsJs })) {
    assert.ok(!src.includes("onUiLangChanged"), `${name}.js 不得重复订阅 ui-lang-changed`);
  }
});

/* ---------- B. onChange 管线顺序 ---------- */

test("B1-HOOK-PIPELINE: refresh = getI18n → apply(静态) → ready → notify(动态)；init 与语言变更共用同一管线；注册时 ready 立即执行一次", () => {
  const refresh = SRC.i18n.slice(SRC.i18n.indexOf("async function refresh()"));
  const order = [refresh.indexOf("await window.petAPI.getI18n()"), refresh.indexOf("apply(r.lang, r.dict)"), refresh.indexOf("_ready = true"), refresh.indexOf("notifyRender()")];
  assert.ok(order.every((i) => i >= 0) && order[0] < order[1] && order[1] < order[2] && order[2] < order[3], "dict→apply→ready→callbacks 顺序");
  assert.match(SRC.i18n, /window\.petAPI\.onUiLangChanged\(\(\) => \{ refresh\(\)/, "语言变更走同一 refresh 管线（单一实现）");
  assert.match(SRC.i18n, /function onChange\(cb\)[\s\S]{0,320}if \(_ready\) \{ try \{ cb\(_lang\); \} catch/, "注册时已 ready 立即执行一次");
  assert.match(SRC.i18n, /window\.I18N = \{ apply, t, lang: \(\) => _lang, ready: \(\) => _ready, onChange \}/, "对外 API：ready + onChange");
});

/* ---------- C. 语言切换零业务副作用 ---------- */

test("B1-NO-SIDE-EFFECTS: 各页 onChange 回调仅重绘 presentation，不含任何业务动作", () => {
  const FORBIDDEN = ["doSave", "saveSettings", "testChat", "setUiLang", "emotionAudition", "applyRig", "deleteMemory", "clearMemory", "addMemoryFact", "updateMemoryFact", "restartGsv", "scanCreds", "importCred", "checkUpdate", "agreeTerms", "refuseTerms", "setSpineSkin", "setRigSkin", "setWorkspaceWatch", "setEmotionVoice", "set-sleeping", "walk", "throwPet", "pat(", "reload"];
  const settingsCb = SRC.settings.slice(SRC.settings.indexOf("window.I18N.onChange(() => {"));
  const settingsCbBody = settingsCb.slice(0, settingsCb.indexOf("});"));
  assert.ok(settingsCbBody.length > 40 && settingsCbBody.length < 2000, "settings onChange 回调存在且极小");
  for (const f of FORBIDDEN) assert.ok(!settingsCbBody.includes(f), "settings onChange 不得含业务动作: " + f);
  assert.match(settingsCbBody, /renderVersion\(\);[\s\S]*renderKeySource\(\);[\s\S]*renderOnboard\(S\)[\s\S]*applyRenderModeUI\(rm\.value\)[\s\S]*renderFixedLinePool\(\);/, "重绘链 = 既有 state 的纯 render");
  const petCb = SRC.pet.slice(SRC.pet.lastIndexOf("window.I18N.onChange("));
  // 5-G3：pet.js 回调重放三项纯投影（placeholder + modeChip.title + btnTts.title），仍是唯一订阅
  assert.equal((SRC.pet.match(/window\.I18N\.onChange\(/g) || []).length, 1, "pet.js 仍只有既有那一个 onChange 订阅");
  const petCbBody = petCb.slice(0, petCb.indexOf("});") + 3);
  assert.equal(petCbBody.split("\n").filter((l) => l.trim() && !l.trim().startsWith("/") && !l.trim().startsWith("*")).length, 5,
    "pet.js 回调 = 3 行重投影 + onChange 头尾（placeholder / modeChip.title / btnTts.title）");
  for (const f of FORBIDDEN) assert.ok(!petCbBody.includes(f), "pet onChange 不得含业务动作: " + f);
  assert.match(petCb, /inputEl\.placeholder = isRecording \? I18N\.t\("ui\.micRecording"\) : I18N\.t\("ui\.placeholder"\);/);
  assert.match(petCbBody, /updateChip\(\);[\s\S]*updateTtsButton\(\);/, "chip/tts title 由既有纯投影重放");
  assert.ok(petCbBody.length < 600, "pet onChange 回调仍极小（纯重投影）");
  // 5-E1 起失败文本改为「存来源、重投影」：locale 切换不会抹掉失败态，但会把它重新本地化
  assert.match(SRC.terms, /let hintFailure = null;/, "terms：失败文本是 state（不因 locale 切换被抹掉）");
  assert.match(SRC.terms, /hintFailure\.key !== undefined \? t\(hintFailure\.key\) : presentError\(hintFailure\.result\)/,
    "terms：失败态随 locale 重本地化，而不是冻结成旧语言文本");
  assert.match(SRC.terms, /if \(window\.I18N && window\.I18N\.onChange\) window\.I18N\.onChange\(renderTermsHint\);/, "terms hint 单一 owner + locale 重绘");
  assert.match(SRC.docs, /if \(window\.I18N && window\.I18N\.onChange\) window\.I18N\.onChange\(renderDocsTitle\);/, "docs title 单一 owner");
});

/* ---------- D. 动态节点双 owner 已解除 ---------- */

function assertNoI18nBinding(html, id, label) {
  const at = html.indexOf('id="' + id + '"');
  assert.ok(at >= 0, label + " 节点存在: " + id);
  const tagEnd = html.indexOf(">", at); // 只检查该元素自己的 open tag 属性区（不含相邻节点）
  const seg = html.slice(at, tagEnd);
  assert.ok(!seg.includes("data-i18n"), label + " 动态节点 id=" + id + " 不得再携带 data-i18n*（双 owner）");
}

test("B1-NO-DOUBLE-OWNER: settings/voice/psd/moods/terms/docs/index 的动态 JS owner 节点全部解除静态绑定", () => {
  for (const id of ["rm-hint", "rig-skins-list", "live2d-skins-list", "mem-stats", "fixed-lines-profile", "fixed-lines-state", "fixed-lines-summary", "btn-fixed-lines-toggle", "bubble-width-val", "version", "api-key", "agent-token"]) {
    assertNoI18nBinding(SRC.settingsHtml, id, "settings");
  }
  for (const id of ["status-card", "file-path"]) assertNoI18nBinding(SRC.voiceHtml, id, "voice");
  for (const id of ["tree", "sel-info", "preview-wrap", "rig-wrap"]) assertNoI18nBinding(SRC.psdHtml, id, "psd");
  assertNoI18nBinding(SRC.moodsHtml, "dir-hint", "moods");
  assert.ok(!SRC.termsHtml.includes('data-i18n="page.terms.footHint"'), "terms foot hint owner=terms.js");
  assert.ok(!/<title[^>]*data-i18n/.test(SRC.docsHtml), "docs <title> owner=docs.js");
  for (const id of ["sprite", "input", "mode-chip", "btn-tts"]) assertNoI18nBinding(SRC.indexHtml, id, "index");
});

/* ---------- E. state 保持（重绘从既有 state，数据不被翻译/不被抹掉） ---------- */

test("B1-STATE-PRESERVATION: version/path/pet name/列表 的 owner 与 DATA 边界", () => {
  // 版本号：单一来源 app.getVersion 作参数；不再硬编码中文品牌拼接
  assert.match(SRC.settings, /L\("set\.versionBrand", \{ version: window\.petAPI\.appVersion \}\)/);
  assert.equal((SRC.settings.match(/document\.title|verEl\.textContent = "苏苏洛/g) || []).length, 0, "旧硬编码版本行已移除");
  // docs 标题：doc.name 只作 {name} 参数（DATA 不翻译），旧直拼已清除
  assert.equal((SRC.docs.match(/"苏苏洛 · " \+ doc\.name/g) || []).length, 0, "旧 title 拼接已移除");
  assert.match(SRC.docs, /I18N\.t\("page\.docs\.titleWith", \{ name: _docsCurrentName \}\)/);
  // voice file path：DATA（选中路径原样展示，无静态绑定）；B2.1 后 owner=renderFilePath 投影
  assert.match(SRC.voiceJs, /selectedPath = p;[\s\S]{0,80}renderFilePath\(\)/, "pick 结果经 renderFilePath 投影");
  assert.match(SRC.voiceJs, /\$\("file-path"\)\.textContent = selectedPath \|\| L\("page\.voice\.noFile", \{ path: SAMPLE_REF_PATH \}\);/, "路径原样 / 空态=本地化包装+路径参数");
  // pet name：sprite alt 由 applyPetName 写（DATA 名），无静态绑定
  assert.ok(!SRC.indexHtml.includes('data-i18n-alt="ui.petAlt"'), "alt owner=applyPetName");
  // skins/mem 列表：静态绑定解除后 locale apply 不清空（JS owner 保持）
  assert.ok(!SRC.settingsHtml.includes('data-i18n="set.loading"'), "列表初值 loading 绑定已下沉为 JS owner");
});

/* ---------- F. 新键 catalog ---------- */

test("B1-CATALOG: set.versionBrand / page.docs.titleWith 三语存在且 {param} parity", () => {
  const paramsOf = (s) => (String(s).match(/\{(\w+)\}/g) || []).sort().join(",");
  for (const [k, want] of [["set.versionBrand", "{version}"], ["page.docs.titleWith", "{name}"]]) {
    for (const lang of ["zh", "en", "ja"]) {
      assert.ok(typeof i18n.DICT[lang][k] === "string" && i18n.DICT[lang][k].length > 0, `${lang}:${k}`);
      assert.equal(paramsOf(i18n.DICT[lang][k]), want, `${lang}:${k} 参数集`);
    }
  }
  assert.equal(i18n.t("zh", "set.versionBrand", { version: "2.5.30" }), "苏苏洛桌宠 · v2.5.30");
  assert.equal(i18n.t("en", "page.docs.titleWith", { name: "DeepSeek Tutorial" }), "Sussurro · DeepSeek Tutorial");
});
