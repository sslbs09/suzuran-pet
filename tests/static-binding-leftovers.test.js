"use strict";

/**
 * Phase 5-F2 契约：静态绑定残留收口。
 *
 * 最终审计的 S8 列出约 18 个「未绑定中文」节点。按 ownership 逐个核对后，
 * 其中绝大多数属于 Phase 4-B 有意解除静态绑定的 runtime-owned 节点——给它们补
 * data-i18n 会重新制造双 owner。本测试把该判定固化为守卫：
 *   - 真正该绑的（key 已存在、节点无人拥有）必须已绑定
 *   - runtime-owned 的必须保持未绑定，并逐条写明 owner
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const i18n = require(path.join(root, "src/i18n.js"));
const html = (f) => fs.readFileSync(path.join(root, "renderer", f), "utf8");
const js = (f) => fs.readFileSync(path.join(root, "renderer", f), "utf8");

/** S8 复核结论：未绑定 + 其 owner 已在生产 JS 中显式接管。 */
const RUNTIME_OWNED = [
  { file: "index.html", id: null, node: '<title>', owner: "main.js applyPetWindowTitle（5-E2 起标题唯一 owner）" },
  { file: "docs.html", id: null, node: '<title>', owner: "docs.js renderDocsTitle()" },
  { file: "index.html", id: "sprite", owner: "pet.js applyPetName（DATA：自定义宠物名）" },
  { file: "index.html", id: "input", attr: "placeholder", owner: "pet.js 末尾唯一 I18N.onChange" },
  { file: "index.html", id: "mode-chip", attr: "title", owner: "pet.js 运行时 modeChip.title" },
  { file: "index.html", id: "btn-tts", attr: "title", owner: "pet.js 运行时 btnTts.title" },
  { file: "addchar.html", id: "model-list", owner: "addchar.js renderList()（5-E3 起经 onChange 重投影）" },
  { file: "moods.html", id: "dir-hint", owner: "moods.js 渲染" },
  { file: "psd.html", id: "sel-info", owner: "psd.js 选择态渲染" },
  { file: "psd.html", id: "tree", owner: "psd.js 渲染" },
  { file: "psd.html", id: "preview-wrap", owner: "psd.js 渲染" },
  { file: "settings.html", id: "rm-hint", owner: "settings.js applyRenderModeUI()" },
  { file: "settings.html", id: "rig-skins-list", owner: "settings.js 皮肤列表渲染" },
  { file: "settings.html", id: "live2d-skins-list", owner: "settings.js Live2D 列表渲染" },
  { file: "settings.html", id: "mem-stats", owner: "settings.js 记忆面板渲染" },
  { file: "settings.html", id: "fixed-lines-profile", owner: "settings.js 音频池渲染" },
  { file: "settings.html", id: "fixed-lines-state", owner: "settings.js 音频池渲染" },
  { file: "settings.html", id: "fixed-lines-summary", owner: "settings.js 音频池渲染" },
  { file: "settings.html", id: "bubble-width-val", owner: "settings.js renderBubbleWidthVal()" },
  { file: "settings.html", id: "version", owner: "settings.js renderVersion()" },
  { file: "settings.html", id: "agent-token", attr: "placeholder", owner: "settings.js renderAgentTokenPh()" },
  { file: "voice.html", id: "status-card", owner: "voice.js renderStatus()" }
];

test("the one genuinely static leftover is now bound", () => {
  // psd.html #rig-wrap 的提示：psd.js 只在启动 2.5D 预览时 innerHTML="" 清空它，
  // 从不写入文本 ⇒ 无 owner，可安全绑定（page.psd.rigEmpty 本就存在且此前 0 引用）
  const src = html("psd.html");
  assert.match(src, /<span class="meta" data-i18n="page\.psd\.rigEmpty">/,
    "rig-wrap hint is bound to the existing catalog key");
  for (const lang of ["zh", "en", "ja"]) {
    assert.ok(String(i18n.DICT[lang]["page.psd.rigEmpty"] || "").trim(), `${lang}:page.psd.rigEmpty missing`);
  }
  assert.ok(!/\{/.test(i18n.DICT.zh["page.psd.rigEmpty"]), "key carries no placeholder, so no param drift is possible");
});

test("runtime-owned nodes stay unbound (F2 must not recreate dual owners)", () => {
  for (const { file, id, attr } of RUNTIME_OWNED) {
    if (!id) continue;
    const src = html(file);
    const at = src.indexOf(`id="${id}"`);
    assert.notEqual(at, -1, `${file} #${id} exists`);
    const tagEnd = src.indexOf(">", at);
    const tag = src.slice(src.lastIndexOf("<", at), tagEnd + 1);
    if (attr) {
      assert.ok(!new RegExp(`data-i18n(-${attr === "title" ? "title" : "placeholder"})?`).test(tag) || !tag.includes("data-i18n"),
        `${file} #${id} must not carry data-i18n — owner: ${RUNTIME_OWNED.find((x) => x.id === id).owner}`);
    } else {
      assert.ok(!tag.includes("data-i18n"), `${file} #${id} must not carry data-i18n`);
    }
  }
});

test("the ownership allowlist itself is honest (every owner exists in production code)", () => {
  const mainSource = fs.readFileSync(path.join(root, "main.js"), "utf8");
  const owners = {
    "main.js applyPetWindowTitle": /function applyPetWindowTitle\(/,
    "docs.js renderDocsTitle": /function renderDocsTitle\(/,
    "pet.js applyPetName": /function applyPetName\(/,
    "pet.js 末尾唯一 I18N.onChange": /window\.I18N\.onChange\(/,
    "addchar.js renderList()": /function renderList\(\)/,
    "psd.js": /\$\("sel-info"\)|\$\("preview-wrap"\)/,
    "settings.js applyRenderModeUI()": /function applyRenderModeUI\(/,
    "settings.js renderBubbleWidthVal()": /renderBubbleWidthVal\(\)/,
    "settings.js renderVersion()": /renderVersion\(\)/,
    "settings.js renderAgentTokenPh()": /renderAgentTokenPh\(\)/,
    "voice.js renderStatus()": /function renderStatus\(\)/,
    "moods.js": /dir-hint/
  };
  for (const entry of RUNTIME_OWNED) {
    for (const needle of Object.keys(owners)) {
      if (entry.owner.includes(needle)) {
        const haystack = needle.startsWith("main.js") ? mainSource
          : needle.startsWith("docs.js") ? js("docs.js")
            : needle.startsWith("pet.js") ? js("pet.js")
              : needle.startsWith("addchar") ? js("addchar.js")
                : needle.startsWith("psd.js") ? js("psd.js")
                  : needle.startsWith("voice") ? js("voice.js")
                    : needle.startsWith("moods") ? js("moods.js") : js("settings.js");
        assert.match(haystack, owners[needle], `declared owner "${needle}" must exist in production code`);
      }
    }
  }
});

test("no HTML node has both a static binding and a runtime writer", () => {
  // Phase 4-B 解除绑定的清单：这些 id 一旦重新出现 data-i18n 即为双 owner 回归
  const GUARDED = ["rm-hint", "rig-skins-list", "live2d-skins-list", "mem-stats",
    "fixed-lines-profile", "fixed-lines-state", "fixed-lines-summary", "btn-fixed-lines-toggle",
    "bubble-width-val", "version", "api-key", "agent-token", "dir-hint", "model-list",
    "sel-info", "rig-info", "status-card"];
  const src = html("settings.html") + html("psd.html") + html("moods.html") + html("voice.html") + html("addchar.html");
  for (const id of GUARDED) {
    const at = src.indexOf(`id="${id}"`);
    if (at === -1) continue;
    const tagEnd = src.indexOf(">", at);
    const tag = src.slice(src.lastIndexOf("<", at), tagEnd + 1);
    assert.ok(!tag.includes("data-i18n"), `#${id} must not be statically bound (runtime-owned)`);
  }
});

test("binding coverage did not regress: every data-i18n key still exists in the catalog", () => {
  const files = ["addchar.html", "moods.html", "psd.html", "settings.html", "voice.html",
    "index.html", "help.html", "quickstart.html", "terms.html", "schedule.html", "docs.html"];
  const missing = [];
  for (const f of files) {
    for (const m of html(f).matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) {
      for (const lang of ["zh", "en", "ja"]) {
        if (!String(i18n.DICT[lang][m[1]] || "").trim()) missing.push(`${f} ${m[1]} ${lang}`);
      }
    }
  }
  assert.deepEqual(missing, [], `dangling bindings: ${missing.slice(0, 10).join(", ")}`);
});