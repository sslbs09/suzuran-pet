"use strict";

/* 苏苏洛桌宠 · 文档中心（v2.5.1）
 * 轻量 md 渲染器 + 文档加载。文档清单由主进程 docs:list 提供（新手教程在 exe 旁，其余在应用内）。
 * 设计原则：离线可用、无第三方依赖；md 先转义再渲染，避免注入。 */

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** 极简 Markdown → HTML（覆盖新手教程用到的语法：标题/列表/代码块/粗体/行内码/链接/引用/表格） */
function mdToHtml(src) {
  const lines = String(src || "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let inCode = false, codeBuf = [], inTable = false, tableBuf = [], listStack = [];

  const inline = (t) => t
    .replace(/`([^`]+)`/g, (m, c) => "<code>" + esc(c) + "</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, label, url) => {
      // v2.5.22 安全（P2-5）：只允许 http/https/mailto 链接，javascript:/data: 等危险协议转纯文本
      const u = String(url || "").trim();
      if (/^(https?:\/\/|mailto:)/i.test(u)) return '<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">' + label + "</a>";
      return label + "（" + esc(u) + "）"; // 危险协议不生成链接
    })
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");

  const closeList = () => {
    while (listStack.length) {
      out.push("</" + listStack.pop() + ">");
    }
  };
  const closeTable = () => {
    if (inTable) { out.push("</table>"); inTable = false; tableBuf = []; }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    // 代码块
    if (/^```/.test(line.trim())) {
      if (inCode) { out.push("<pre><code>" + esc(codeBuf.join("\n")) + "</code></pre>"); inCode = false; codeBuf = []; }
      else { closeList(); closeTable(); inCode = true; codeBuf = []; }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }

    // 表格（简化：| 开头且含 |）
    if (/^\s*\|/.test(line) && (line.match(/\|/g) || []).length >= 2) {
      if (!inTable) { closeList(); out.push("<table>"); inTable = true; tableBuf = []; }
      tableBuf.push(line);
      continue;
    }
    if (inTable && !/^\s*\|/.test(line)) { flushTable(); }

    // 空行
    if (!line.trim()) { closeList(); out.push(""); continue; }

    // 标题
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { closeList(); closeTable(); out.push("<h" + h[1].length + ">" + inline(esc(h[2])) + "</h" + h[1].length + ">"); continue; }

    // 引用
    if (/^>\s?/.test(line)) { closeList(); out.push("<blockquote>" + inline(esc(line.replace(/^>\s?/, ""))) + "</blockquote>"); continue; }

    // 无序/有序列表
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.、]\s+(.*)$/);
    if (ul || ol) {
      const tag = ul ? "ul" : "ol";
      if (!listStack.length || listStack[listStack.length - 1] !== tag) { closeList(); out.push("<" + tag + ">"); listStack.push(tag); }
      out.push("<li>" + inline(esc((ul || ol)[1])) + "</li>");
      continue;
    }
    closeList();

    // 分隔线
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) { out.push("<hr>"); continue; }

    // 普通段落
    out.push("<p>" + inline(esc(line)) + "</p>");
  }
  function flushTable() {
    if (!inTable) return;
    const rows = tableBuf.map((r) => r.replace(/^\s*\||\|\s*$/g, "").split("|").map((c) => c.trim()));
    const isSep = (r) => /^:?-{2,}:?$/.test(r[0] || "");
    let headerDone = false;
    for (const r of rows) {
      if (!headerDone && isSep(r)) { headerDone = true; continue; }
      const tds = r.map((c) => "<" + (headerDone ? "td" : "th") + ">" + inline(esc(c)) + "</" + (headerDone ? "td" : "th") + ">").join("");
      out.push("<tr>" + tds + "</tr>");
      if (!headerDone) headerDone = true;
    }
    out.push("</table>");
    inTable = false; tableBuf = [];
  }
  if (inCode) out.push("<pre><code>" + esc(codeBuf.join("\n")) + "</code></pre>");
  flushTable();
  closeList();
  return out.join("\n");
}

/* ---------- 文档加载 ---------- */
const $ = (id) => document.getElementById(id);

async function applyTheme(theme) { // 规则唯一来源 renderer/theme.js（v2.5.26 收敛）
  window.petTheme.apply(theme);
  syncIframeTheme();
}

/* iframe 文档主题同步（v2.5.26）：srcdoc 同源可写，把 theme-dark 传进文档 body */
function syncIframeTheme() {
  try {
    const d = $("docs-iframe").contentDocument;
    if (d && d.body) d.body.classList.toggle("theme-dark", document.body.classList.contains("theme-dark"));
  } catch { /* 忽略 */ }
}

async function init() {
  try { const st = await window.petAPI.getState(); applyTheme(st && st.theme); } catch { /* 忽略 */ }
  const list = await window.petAPI.docsList().catch(() => []);
  const nav = $("docs-nav");
  const byGroup = {};
  for (const d of list) { (byGroup[d.group] = byGroup[d.group] || []).push(d); }

  for (const g of Object.keys(byGroup)) {
    const box = document.createElement("div");
    box.className = "doc-group";
    const title = document.createElement("div");
    title.className = "doc-group-title";
    title.textContent = g;
    box.appendChild(title);
    for (const d of byGroup[g]) {
      const btn = document.createElement("button");
      btn.className = "doc-item";
      btn.textContent = d.name;
      btn.addEventListener("click", () => openDoc(d, btn));
      box.appendChild(btn);
    }
    nav.appendChild(box);
  }
}

async function openDoc(doc, btn) {
  document.querySelectorAll(".doc-item").forEach((b) => b.classList.remove("active"));
  if (btn) btn.classList.add("active");
  $("docs-welcome").hidden = true;
  $("docs-iframe").hidden = true;
  $("docs-content").hidden = true;
  $("docs-loading").hidden = false;

  const r = await window.petAPI.docsRead(doc.key).catch(() => null);
  $("docs-loading").hidden = true;
  if (!r || !r.ok) {
    $("docs-content").hidden = false;
    $("docs-content").innerHTML = '<p style="color:#c0392b">文档读取失败：' + (r && r.error ? esc(r.error) : "未知错误") + "</p>";
    return;
  }
  if (r.html) {
    const iframe = $("docs-iframe");
    iframe.srcdoc = r.srcdoc || "";
    iframe.hidden = false;
    iframe.addEventListener("load", syncIframeTheme, { once: true }); // srcdoc 异步加载，载入后补主题
    document.title = "苏苏洛 · " + doc.name;
    return;
  }
  const c = $("docs-content");
  c.hidden = false;
  c.className = "docs-pane docs-md";
  c.innerHTML = mdToHtml(r.text);
  document.title = "苏苏洛 · " + doc.name;
  c.scrollTop = 0;
}

if (typeof window !== "undefined") {
  init();
}
/* node 单测用：浏览器环境 module 不存在，自动跳过 */
if (typeof module !== "undefined" && module.exports) {
  module.exports = { mdToHtml, esc };
}
