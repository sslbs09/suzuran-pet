"use strict";

/**
 * Phase 6-A.5 契约：settings 窗口 DOM id 协议护栏。
 *
 * 背景：Phase 6-A 的 refresh 重命名中，`$id("logdiag-refresh")` 被符号替换误改成
 * `$id("logdiag-fetchAndRenderLogs")`——HTML id 是**字符串协议**，普通符号改名对它是不可见的，
 * 当时没有任何测试能发现（日志诊断的刷新按钮会静默失效）。
 *
 * 本测试锁定 settings.js 引用的每一个**字面量 id** 与 settings.html 的 `id="…"` 的一致性。
 * 范围严格限定 settings.js ↔ settings.html；不改生产逻辑，不建通用 DOM framework。
 *
 * 覆盖项目实际存在的三种形式（settings.js 中不存在 `document.querySelector("#…")` 字面量形式）：
 *   $id("…")  ·  $("…")  ·  document.getElementById("…") / getElementById("…")
 * 动态参数（如 $(prefix + n)）不在协议内，不参与。
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const JS_REL = "renderer/settings.js";
const HTML_REL = "renderer/settings.html";
const jsSource = fs.readFileSync(path.join(root, JS_REL), "utf8");
const htmlSource = fs.readFileSync(path.join(root, HTML_REL), "utf8");

const htmlIds = new Set([...htmlSource.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));

/** 项目实际使用的字面量 selector 形式 */
const SELECTOR_FORMS = [
  { name: '$id("…")', rx: /\$id\(\s*"([^"]+)"\s*\)/g },
  { name: '$("…")', rx: /\$\(\s*"([^"]+)"\s*\)/g },
  { name: 'document.getElementById("…")', rx: /(?:document\.)?getElementById\(\s*"([^"]+)"\s*\)/g }
];

/** 收集 { id, form, line } —— 同一 id 被多种形式引用时全部保留，便于报错定位 */
function collectSelectors() {
  const found = [];
  for (const { name, rx } of SELECTOR_FORMS) {
    for (const m of jsSource.matchAll(rx)) {
      found.push({ id: m[1], form: name, line: jsSource.slice(0, m.index).split("\n").length });
    }
  }
  return found;
}

function formatMissing(missing) {
  return `\n\nMissing DOM contract:\n\n${JS_REL}:\n${missing.map((x) => `${x.line}:  ${x.form.replace("…", x.id)}`).join("\n")}\n\nbut ${HTML_REL} has no:\n${[...new Set(missing.map((x) => `id="${x.id}"`))].join("\n")}\n`;
}

test("settings.js 的每个字面量 DOM selector 都能在 settings.html 找到对应 id", () => {
  const selectors = collectSelectors();
  const missing = selectors.filter((x) => !htmlIds.has(x.id));
  assert.deepEqual(missing, [], formatMissing(missing));
});

test("护栏本身是有效的（覆盖率自检，避免正则失效后静默放行）", () => {
  const selectors = collectSelectors();
  const perForm = new Map(SELECTOR_FORMS.map((f) => [f.name, 0]));
  for (const s of selectors) perForm.set(s.form, perForm.get(s.form) + 1);

  // 三种形式都必须真的被扫到，否则说明 settings.js 的写法变了、本护栏已失效
  assert.ok(perForm.get('$id("…")') >= 6, `$id 形式仍被覆盖（当前 ${perForm.get('$id("…")')}）`);
  assert.ok(perForm.get('$("…")') >= 150, `$(…) 形式仍被覆盖（当前 ${perForm.get('$("…")')}）`);
  assert.ok(perForm.get('document.getElementById("…")') >= 13,
    `getElementById 形式仍被覆盖（当前 ${perForm.get('document.getElementById("…")')}）`);

  // 合计规模下限：settings.js 目前引用约 185 处，跌破即说明扫描退化
  assert.ok(selectors.length >= 180, `selector 总数未退化（当前 ${selectors.length}）`);
  assert.ok(htmlIds.size >= 200, `settings.html id 规模合理（当前 ${htmlIds.size}）`);
});

test("回归锚点：logdiag-refresh 协议必须保持", () => {
  // 这正是 6-A 误改的那一处。单独钉死，日志诊断刷新按钮不会再次静默失效。
  // 用布尔断言而非 assert.match(html)：失败时不要把整份 30KB HTML 打进日志。
  const htmlOk = /\sid="logdiag-refresh"/.test(htmlSource);
  const jsOk = /\$id\(\s*"logdiag-refresh"\s*\)/.test(jsSource);
  const report = `\n\nMissing DOM contract (regression anchor):\n\n${JS_REL}:\n125:  $id("logdiag-refresh")  ${jsOk ? "present" : "ABSENT"}\n\n${HTML_REL}:\nid="logdiag-refresh"  ${htmlOk ? "present" : "ABSENT"}\n`;
  assert.ok(htmlOk, report);
  assert.ok(jsOk, report);
});

test("guard 只覆盖静态字面量，不误伤动态 selector", () => {
  // 动态拼接（如 $(prefix + n)）不在协议内；护栏不得把它们当成缺失 id 误报
  const dynamic = [...jsSource.matchAll(/\$\(\s*"[^"]*"\s*\+/g)];
  const selectors = collectSelectors();
  for (const d of dynamic) {
    const id = /\$\(\s*"([^"]*)"/.exec(d[0])[1];
    assert.ok(!selectors.some((s) => s.id === id),
      `动态前缀 "${id}" 不应被当作完整 id 校验`);
  }
});