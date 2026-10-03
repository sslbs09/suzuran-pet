"use strict";

/**
 * Phase 3 — static renderer page binding 契约（2026-10-03）：
 * 目标页面全部接入统一 renderer/i18n.js bootstrap（preload 统一下发 effective dict），
 * 静态 user-visible 文案全部 data-i18n* 绑定且键三语存在；
 * terms 法律正文为 LEGAL_CONTENT，禁止混入 product catalog。
 * 注：页面路径全部为独立字面常量；正则全部为字面量（无动态构造）。
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");

const i18n = require("../src/i18n");

const SETTINGS_HTML = fs.readFileSync(require.resolve("../renderer/settings.html"), "utf8");
const HELP_HTML = fs.readFileSync(require.resolve("../renderer/help.html"), "utf8");
const QUICKSTART_HTML = fs.readFileSync(require.resolve("../renderer/quickstart.html"), "utf8");
const TERMS_HTML = fs.readFileSync(require.resolve("../renderer/terms.html"), "utf8");
const VOICE_HTML = fs.readFileSync(require.resolve("../renderer/voice.html"), "utf8");
const PSD_HTML = fs.readFileSync(require.resolve("../renderer/psd.html"), "utf8");
const MOODS_HTML = fs.readFileSync(require.resolve("../renderer/moods.html"), "utf8");
const ADDCHAR_HTML = fs.readFileSync(require.resolve("../renderer/addchar.html"), "utf8");
const SCHEDULE_HTML = fs.readFileSync(require.resolve("../renderer/schedule.html"), "utf8");
const DOCS_HTML = fs.readFileSync(require.resolve("../renderer/docs.html"), "utf8");
const BOOTSTRAP_JS = fs.readFileSync(require.resolve("../renderer/i18n.js"), "utf8");
const PRELOAD_JS = fs.readFileSync(require.resolve("../preload.js"), "utf8");

const HTML = {
  settings: SETTINGS_HTML,
  help: HELP_HTML,
  quickstart: QUICKSTART_HTML,
  terms: TERMS_HTML,
  voice: VOICE_HTML,
  psd: PSD_HTML,
  moods: MOODS_HTML,
  addchar: ADDCHAR_HTML,
  schedule: SCHEDULE_HTML,
  docs: DOCS_HTML
};

const TARGET_PAGES = Object.keys(HTML);

function refsOf(html) {
  return html.match(/data-i18n(?:-title|-placeholder|-alt|-aria-label)?="([^"]+)"/g) || [];
}

test("P3-BOOTSTRAP: 每个目标页面加载统一 renderer/i18n.js，且无自建 locale 源", () => {
  for (const page of TARGET_PAGES) {
    const html = HTML[page];
    assert.match(html, /<script src="i18n\.js"><\/script>/, `${page} 缺少统一 i18n bootstrap`);
    assert.doesNotMatch(html, /locales?[/\\].*\.json|pet-i18n-override|my-i18n/i, `${page} 不得自建 locale 数据源`);
  }
});

test("P3-KEYS: 所有 data-i18n* 引用键在 zh/en/ja 全部存在（零缺键）", () => {
  const missing = [];
  for (const page of TARGET_PAGES) {
    for (const ref of refsOf(HTML[page])) {
      const k = ref.slice(ref.indexOf('"') + 1, ref.lastIndexOf('"'));
      for (const lang of ["zh", "en", "ja"]) {
        if (i18n.DICT[lang][k] === undefined) missing.push(`${page} → ${lang}:${k}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

test("P3-NOEMPTY: 目标页面引用键的值全部非空字符串", () => {
  const bad = [];
  for (const page of TARGET_PAGES) {
    for (const ref of refsOf(HTML[page])) {
      const k = ref.slice(ref.indexOf('"') + 1, ref.lastIndexOf('"'));
      for (const lang of ["zh", "en", "ja"]) {
        const v = i18n.DICT[lang][k];
        if (typeof v !== "string" || v.trim().length === 0) bad.push(`${lang}:${k}`);
      }
    }
  }
  assert.deepEqual(bad, []);
});

test("P3-PARAMS: 静态绑定键不得含 {param} 插值占位符（{{x}} 双括号是 persona 模板字面量，允许）", () => {
  const offenders = [];
  for (const page of TARGET_PAGES) {
    for (const ref of refsOf(HTML[page])) {
      const k = ref.slice(ref.indexOf('"') + 1, ref.lastIndexOf('"'));
      // 仅检查单大括号插值占位符；{{userName}} 类双括号是 persona/模板字面量，本就该原样显示
      if (/(?<!\{)\{\w+\}(?!\})/.test(String(i18n.DICT.zh[k]))) offenders.push(`${page} → ${k}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("P3-BOOTSTRAP-SRC: renderer/i18n.js 依赖的 window API 由统一 preload 提供", () => {
  assert.match(PRELOAD_JS, /getI18n: \(\) => ipcRenderer\.invoke\("pet:get-i18n"\)/);
  assert.match(PRELOAD_JS, /onUiLangChanged/);
  assert.match(BOOTSTRAP_JS, /data-i18n-aria-label/, "Phase 3 aria 扩展存在");
});

test("P3-TERMS: 法律正文为 LEGAL_CONTENT——terms-body 内禁止任何 data-i18n 绑定；chrome 已绑定", () => {
  const body = TERMS_HTML.slice(TERMS_HTML.indexOf('class="terms-body"'), TERMS_HTML.indexOf('class="terms-foot"'));
  assert.doesNotMatch(body, /data-i18n/, "legal body 不得进入 product catalog");
  for (const k of ["page.terms.h1", "page.terms.refuse", "page.terms.agree", "page.terms.footHint"]) {
    for (const lang of ["zh", "en", "ja"]) assert.ok(i18n.DICT[lang][k], `terms chrome ${lang}:${k} 缺失`);
  }
  assert.ok(TERMS_HTML.includes("重要提示：使用本软件前，请仔细阅读并确认以下条款"), "legal body 原文保持");
});

test("P3-NOBREAK: 关键 DOM id / 事件锚点与既有 script 引用不被绑定改动破坏", () => {
  const anchors = {
    settings: ['id="set-nav"', 'id="render-mode"', 'id="preset"', 'id="persona"', 'id="ui-lang"', 'id="sec-security"', 'src="settings.js"'],
    schedule: ['id="title"', 'id="date"', 'id="time"', 'id="recurrence"', 'id="emotion"', 'id="add"', 'id="import"', 'id="template"', 'src="schedule.js"'],
    psd: ['id="drop"', 'id="file"', 'id="btn-flatten"', 'id="btn-rig"', 'src="psd.js"', 'src="rig/rigger.js"'],
    voice: ['id="btn-pick"', 'id="ref-text"', 'id="btn-apply"', 'src="voice.js"'],
    moods: ['id="mood-grid"', 'id="btn-add-mood"', 'src="moods.js"'],
    addchar: ['id="btn-import"', 'id="model-list"', 'src="addchar.js"'],
    docs: ['id="docs-nav"', 'id="docs-content"', 'src="docs.js"'],
    quickstart: ['href="help.html"'],
    terms: ['id="btn-agree"', 'id="btn-refuse"', 'src="terms.js"'],
    help: ['href="quickstart.html"']
  };
  for (const [page, ids] of Object.entries(anchors)) {
    for (const a of ids) assert.ok(HTML[page].includes(a), `${page} 缺少关键锚点: ${a}`);
  }
});

test("P3-LEAK: 目标页面静态 DOM 的裸中文（绑定后残余）仅剩已知豁免", () => {
  // 豁免白名单（逐项分类）：
  //  - settings.html 语言自名（中文/日本語）：i18n 惯例，语言名永远以原生书写
  //  - settings.html 字体名（宋体/黑体/楷体/仿宋/等线/微软雅黑）：系统字体标识 DATA
  //  - settings.html 示例 placeholder（苏苏洛/主人/上海/路径示例）：DATA 示例值
  //  - settings.html 纯 BRAND option（OpenAI/Anthropic Claude）：无本地化内容
  //  - HTML 注释与 <style>/<script> 块：非 user-visible DOM 文案
  //  - moods.html CSS content "无表情"：CSS ::after 静态（exception，Phase 4 随动态 UI 处理）
  //  - voice.html 示例台词（ref-text placeholder / preview-text value）：CHARACTER 示例数据
    //  - <code> 内路径/命令/URL：DATA
    //  - addchar.html #model-list 初始文本 "加载中…"：addchar.js 启动即覆盖的动态列表容器（DEFERRED_TO_PHASE4）
    //  - psd.html tip 段：<span data-i18n=...> 起始行之后、跨物理行的 span 延续文本（同键 ownership，绑定在起始行）
    // Phase 4-B1 dynamic-owner 节点：静态绑定已解除、唯一 owner=页面 JS render（初始文本仅为
    // 加载前 fallback；其文本本地化收口属 B2）。语言切换由 I18N.onChange 管线重绘，不再被 static apply 覆盖。
    const DYNAMIC_OWNER_IDS = [
      "rm-hint", "rig-skins-list", "live2d-skins-list", "mem-stats", "api-key", "agent-token",
      "fixed-lines-profile", "fixed-lines-state", "fixed-lines-summary", "btn-fixed-lines-toggle",
      "bubble-width-val", "version", "status-card", "file-path", "tree", "sel-info",
      "preview-wrap", "rig-wrap", "dir-hint", "sprite", "input", "mode-chip", "btn-tts"
    ];
    const DEFERRED = [/id="model-list">加载中…<\/div>/];
  const leaks = [];
  for (const page of TARGET_PAGES) {
    let scrubbed = HTML[page]
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<style[\s\S]*?<\/style>/g, "")
      .replace(/<script[\s\S]*?<\/script>/g, "");
    if (page === "terms") {
      // terms 法律正文 = LEGAL_CONTENT（P3-TERMS 专项锁定：不翻译、不进 catalog），从泄漏检查中整体剔除
      scrubbed = scrubbed.slice(0, scrubbed.indexOf('class="terms-body"')) + scrubbed.slice(scrubbed.indexOf('class="terms-foot"'));
    }
    scrubbed = scrubbed
      .replace(/<option value="zh">中文<\/option>/g, "")
      .replace(/<option value="ja">日本語<\/option>/g, "") // 语言自名：以原生书写（i18n 惯例）
      .replace(/<option value="(?:宋体|黑体|楷体|仿宋|等线)">[^<]*<\/option>/g, "")
      .replace(/placeholder="苏苏洛"/g, "")
      .replace(/placeholder="主人"/g, "")
      .replace(/placeholder="上海"/g, "")
      .replace(/<option value="openai">OpenAI<\/option>/g, "")
      .replace(/<option value="anthropic">Anthropic(?: Claude)?<\/option>/g, "")
      .replace(/content: "无表情"/g, "")
      .replace(/placeholder="[^"]*\\[^"]*"/g, "")
      .replace(/placeholder="例：你好呀[^"]*"/g, "")
      .replace(/value="你好呀[^"]*"/g, "")
      .replace(/<code>[^<]*<\/code>/g, "")
      .replace(/<span class="hint">[^<]*<\/span>/g, "") // terms foot hint：owner=terms.js（失败态优先）
      .replace(/<title>[^<]*<\/title>/g, ""); // docs <title>：owner=docs.js renderDocsTitle
    scrubbed.split("\n").forEach((line, idx) => {
      if (!/[\u4e00-\u9fff]/.test(line)) return;
      if (/data-i18n/.test(line)) return; // 已绑定行：初始文本=catalog zh 值的静态回显，en/ja 下由 apply() 替换（有 ownership）
      if (DEFERRED.some((re) => re.test(line))) return; // JS 启动即覆盖的容器初值（动态 owner 归 Phase 4）
      if (DYNAMIC_OWNER_IDS.some((id) => line.includes('id="' + id + '"'))) return; // Phase 4-B1：唯一 owner=页面 JS render（文本收口 B2）
      if (idx > 0 && /data-i18n/.test(scrubbed.split("\n")[idx - 1]) && !/<(h\d|p|div|section|button|label|li|td|a|span)/.test(line)) return; // 绑定元素跨行延续文本
      leaks.push(`${page}:${idx + 1}: ${line.trim().slice(0, 90)}`);
    });
  }
  assert.deepEqual(leaks, []);
});
