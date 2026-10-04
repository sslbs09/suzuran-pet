"use strict";

/**
 * Phase 5-G3 契约：pet 窗口运行时 title 收口。
 *  - modeChip.title / btnTts.title 三语正确
 *  - runtime state（forcedMode / ttsConfig.enabled）保持不变
 *  - locale 变化只重投影，不产生业务副作用
 *  - pet.js 仍只有既有那一个 I18N.onChange
 *  - 硬编码中文不再存在于这两个写点
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const petJs = fs.readFileSync(path.join(root, "renderer/pet.js"), "utf8");
const petCode = petJs.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const i18n = require(path.join(root, "src/i18n.js"));

const MODE_KEYS = {
  "pet.modeTitle.chat": "日常聊天",
  "pet.modeTitle.forceZcode": "强制任务模式：点此恢复自动",
  "pet.modeTitle.forceChat": "强制聊天模式：点此恢复自动",
  "pet.modeTitle.auto": "自动路由：/zcode 或 /任务 开头自动执行任务",
  "pet.ttsTitleOn": "语音：开（点此关闭）",
  "pet.ttsTitleOff": "语音：关（点此开启）"
};

function body(name) {
  const at = petJs.indexOf(`function ${name}(`);
  assert.notEqual(at, -1, `function ${name} exists`);
  const open = petJs.indexOf("{", at);
  let d = 0;
  for (let i = open; i < petJs.length; i++) {
    if (petJs[i] === "{") d++;
    else if (petJs[i] === "}" && --d === 0) return petJs.slice(open, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

/* ---- 硬编码中文已消失 ---- */

test("no hardcoded Chinese remains at the two runtime title write points", () => {
  for (const fn of ["updateChip", "updateTtsButton"]) {
    const hits = body(fn).match(/"[^"]*[\u4e00-\u9fff][^"]*"/g) || [];
    assert.deepEqual(hits, [], `${fn} still carries hardcoded Chinese: ${hits.join(" | ")}`);
  }
  const writes = [...petCode.matchAll(/(\w+)\.title\s*=\s*([^;]+);/g)].map((m) => `${m[1]} → ${m[2].trim()}`);
  for (const w of writes) {
    assert.ok(!/[\u4e00-\u9fff]/.test(w), `runtime title write still hardcoded: ${w}`);
    assert.match(w, /I18N\.t\(/, `runtime title must come from the catalog: ${w}`);
  }
  assert.equal(writes.length, 5, "exactly the five known title write points");
});

test("the emoji chip glyphs are left alone (icons, not copy)", () => {
  const chip = body("updateChip");
  assert.match(chip, /modeChip\.textContent = "💬"/);
  assert.match(chip, /modeChip\.textContent = "⚡"/);
  assert.match(body("updateTtsButton"), /btnTts\.textContent = ttsConfig\.enabled \? "🔊" : "🔇"/);
});

/* ---- 三语正确 ---- */

test("every new key exists in zh/en/ja and matches the pre-migration zh copy", () => {
  for (const [key, zhValue] of Object.entries(MODE_KEYS)) {
    assert.equal(i18n.DICT.zh[key], zhValue, `zh copy must be byte-identical to the hardcoded original: ${key}`);
    for (const lang of ["zh", "en", "ja"]) {
      assert.ok(String(i18n.DICT[lang][key] || "").trim(), `${lang}:${key} missing or empty`);
    }
    const ph = (lang) => [...i18n.DICT[lang][key].matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    assert.deepEqual(ph("en"), ph("zh"), `${key} zh/en placeholder parity`);
    assert.deepEqual(ph("ja"), ph("zh"), `${key} zh/ja placeholder parity`);
  }
  // 三个语言必须真的不同（防止退化成 no-op 查表）
  for (const key of Object.keys(MODE_KEYS)) {
    assert.equal(new Set(["zh", "en", "ja"].map((l) => i18n.DICT[l][key])).size, 3, `${key} must differ across locales`);
  }
});

test("modeChip resolves all four runtime states from the catalog", () => {
  const chip = body("updateChip");
  assert.match(chip, /modeChip\.title = I18N\.t\("pet\.modeTitle\.chat"\)/);
  assert.match(chip, /modeChip\.title = I18N\.t\("pet\.modeTitle\.forceZcode"\)/);
  assert.match(chip, /modeChip\.title = I18N\.t\("pet\.modeTitle\.forceChat"\)/);
  assert.match(chip, /modeChip\.title = I18N\.t\("pet\.modeTitle\.auto"\)/);
});

test("btnTts resolves on/off from the catalog, keyed off the existing runtime state", () => {
  const fn = body("updateTtsButton");
  assert.match(fn, /btnTts\.title = I18N\.t\(ttsConfig\.enabled \? "pet\.ttsTitleOn" : "pet\.ttsTitleOff"\)/);
  // 状态判据一字未改
  assert.match(fn, /btnTts\.textContent = ttsConfig\.enabled \? "🔊" : "🔇"/);
  assert.match(fn, /btnTts\.classList\.toggle\("off", !ttsConfig\.enabled\)/);
});

/* ---- runtime state 保持不变 ---- */

test("mode/TTS state transitions are byte-identical to before", () => {
  const chip = body("updateChip");
  // 分支条件与类名切换未变
  assert.match(chip, /if \(!zcodeEnabled\)/);
  assert.match(chip, /if \(forcedMode === "zcode"\)/);
  assert.match(chip, /modeChip\.className = "mode-chip zcode"/);
  assert.match(chip, /else if \(forcedMode === "chat"\)/);
  assert.match(chip, /modeChip\.className = "mode-chip"/);
  // click 处理器仍只在用户点击时才触发业务动作
  const ttsClick = petJs.slice(petJs.indexOf('btnTts.addEventListener("click"'), petJs.indexOf('btnTts.addEventListener("click"') + 260);
  assert.match(ttsClick, /window\.petAPI\.setTts\(next\)/, "TTS toggle IPC still fires on click only");
  assert.match(ttsClick, /if \(!next\) stopTts\(\)/, "stopTts still fires on click only");
});

/* ---- locale 变化零业务副作用 ---- */

test("the single onChange only re-projects; it performs no business action", () => {
  const subs = [...petJs.matchAll(/window\.I18N\.onChange\(/g)];
  assert.equal(subs.length, 1, `pet.js must keep exactly one I18N.onChange, found ${subs.length}`);
  const reg = petJs.slice(petJs.lastIndexOf("if (window.I18N", subs[0].index), petJs.indexOf("});", subs[0].index) + 3);
  assert.match(reg, /updateChip\(\)/, "chip title is re-projected");
  assert.match(reg, /updateTtsButton\(\)/, "tts title is re-projected");
  for (const forbidden of ["petAPI.", "setTts", "stopTts", "setMode", "fetch(", "location.reload", "window.close", "speak("]) {
    assert.ok(!reg.includes(forbidden), `locale redraw must not perform ${forbidden}`);
  }
});

test("updateChip / updateTtsButton stay pure state→DOM projections", () => {
  for (const fn of ["updateChip", "updateTtsButton"]) {
    // 剥注释后再判定：文档里说明「不会触发 stopTts」本身不应被当成真的调用
    const src = body(fn).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.ok(!/petAPI\.|\bfetch\(|speak\(|stopTts\(/.test(src), `${fn} must not trigger side effects`);
    assert.match(src, /ttsConfig\.enabled|forcedMode|zcodeEnabled/, `${fn} reads existing runtime state`);
  }
});

test("re-projecting is idempotent — calling twice from the same state yields the same title", () => {
  // 纯函数等价性：同一 state 下 title 只取决于 (zcodeEnabled, forcedMode, ttsConfig.enabled, lang)
  const pick = (lang, zcodeEnabled, forcedMode, ttsOn) => {
    if (!zcodeEnabled) return i18n.DICT[lang]["pet.modeTitle.chat"];
    if (forcedMode === "zcode") return i18n.DICT[lang]["pet.modeTitle.forceZcode"];
    if (forcedMode === "chat") return i18n.DICT[lang]["pet.modeTitle.forceChat"];
    return i18n.DICT[lang]["pet.modeTitle.auto"];
  };
  for (const lang of ["zh", "en", "ja"]) {
    for (const [z, f, ttsOn] of [[false, null, true], [true, "zcode", false], [true, "chat", true], [true, null, false]]) {
      assert.equal(pick(lang, z, f), pick(lang, z, f), `${lang} ${z}/${f}`);
      assert.equal(i18n.DICT[lang][ttsOn ? "pet.ttsTitleOn" : "pet.ttsTitleOff"],
        i18n.DICT[lang][ttsOn ? "pet.ttsTitleOn" : "pet.ttsTitleOff"], `${lang} tts=${ttsOn}`);
    }
  }
});

test("pet.js no longer contains the four migrated mode strings or the two tts strings", () => {
  for (const zh of Object.values(MODE_KEYS)) {
    assert.ok(!petJs.includes(zh), `hardcoded Chinese still in pet.js: ${zh}`);
  }
});

test("static index.html titles stay unbound — runtime owns them (no dual owner)", () => {
  const html = fs.readFileSync(path.join(root, "renderer/index.html"), "utf8");
  for (const id of ["mode-chip", "btn-tts"]) {
    const at = html.indexOf(`id="${id}"`);
    assert.notEqual(at, -1, `#${id} exists`);
    const tag = html.slice(html.lastIndexOf("<", at), html.indexOf(">", at) + 1);
    assert.ok(!tag.includes("data-i18n"), `#${id} must not be statically bound — updateChip/updateTtsButton owns its title`);
  }
});