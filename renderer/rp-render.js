"use strict";

/* rp-render.js — RP 输出富渲染（v2.5.1，酒馆学习）
 * 纯函数模块：浏览器 <script> 与 node 单测共用（docs.js 同款条件导出模式）。
 * parseRpSegments/renderRpSlice：*动作* 与（动作）识别为斜体段；其余按需 HTML 转义。
 */

function escHtml(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

/** 解析 RP 文本为分段 [{text, rp}]：*动作* 与（动作）为 rp 段 */
function parseRpSegments(text) {
  const src = String(text || "");
  const segs = [];
  const re = /\*([^*\n]{1,80})\*|（([^（)\n]{1,80})）/g;
  let last = 0, m;
  while ((m = re.exec(src))) {
    if (m.index > last) segs.push({ text: src.slice(last, m.index), rp: false });
    segs.push({ text: m[1] !== undefined ? "*" + m[1] + "*" : "（" + m[2] + "）", rp: true });
    last = m.index + m[0].length;
  }
  if (last < src.length) segs.push({ text: src.slice(last), rp: false });
  return segs;
}

/** 前 n 个字符的富渲染 HTML（打字机增量）：rp 段包斜体 span，普通段转义 */
function renderRpSlice(full, n) {
  let html = "", left = Math.max(0, n);
  for (const s of parseRpSegments(full)) {
    if (left <= 0) break;
    const part = s.text.slice(0, left);
    left -= s.text.length;
    html += s.rp ? '<span class="rp-action">' + escHtml(part) + "</span>" : escHtml(part);
  }
  return html;
}

/** 朗读剥离：*动作* 不读（（动作）由调用方既有规则处理） */
function stripRpActions(text) {
  return String(text || "").replace(/\*[^*\n]{1,80}\*/g, "");
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { parseRpSegments, renderRpSlice, escHtml, stripRpActions };
}
