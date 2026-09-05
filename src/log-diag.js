"use strict";

/**
 * 日志诊断（v2.5.28 设置页「日志诊断」分区后端）：
 * 读取 tts.log(+.1) 尾部、按行分级（error/warn/info）、脱敏。
 * 脱敏规则源自 2026-09-03 诊断窗口搁置备案：密钥/URL query/绝对路径中的用户名/
 * 窗口标题/精确坐标（10px 模糊）/PID/hwnd/用户称呼/邮箱。导出仅含 tts.log(+.1)，
 * 不含 history/persona/config.json/secrets/audio。
 * 纯函数 + fs 薄封装：sanitize/classifyLine/buildExport 可直接单测。
 */

const fs = require("fs");
const path = require("path");

const TAIL_FILE_BYTES = 512 * 1024; // 单文件最多读尾部 512KB（tts.log 上限 2MiB，足够覆盖）
const ERROR_PATTERNS = [
  "error", "Error", "ERROR", "异常", "崩溃", "失败", "fail", "Fail",
  "回退系统语音", "拦截非法", "守卫", "render-process-gone", "未捕获",
  "EISDIR", "ENOENT", "EPERM", "Cannot ", "gone"
];
const WARN_PATTERNS = [
  "超时", "timeout", "Timeout", "429", "重试", "跳过", "坍缩", "告警", "警告",
  "停帧", "自愈", "回滚", "stale"
];

/** 按行分级：error（需人工看的异常）/ warn（可自愈或偶发）/ info */
function classifyLine(line) {
  const s = String(line || "");
  if (ERROR_PATTERNS.some((p) => s.includes(p))) return "error";
  if (WARN_PATTERNS.some((p) => s.includes(p))) return "warn";
  return "info";
}

/** 读 tts.log.1 + tts.log，合并取尾部 maxLines 行（时间序：旧 .1 在前） */
function readLogTail(logsDir, maxLines = 500) {
  const want = Math.max(10, Math.min(Number(maxLines) || 500, 5000));
  const files = ["tts.log.1", "tts.log"].map((name) => path.join(logsDir, name));
  const chunks = [];
  const missing = [];
  for (const file of files) {
    try {
      if (!fs.existsSync(file)) { missing.push(path.basename(file)); continue; }
      const size = fs.statSync(file).size;
      let text;
      if (size > TAIL_FILE_BYTES) {
        const fd = fs.openSync(file, "r");
        try {
          const buf = Buffer.alloc(TAIL_FILE_BYTES);
          fs.readSync(fd, buf, 0, TAIL_FILE_BYTES, size - TAIL_FILE_BYTES);
          text = buf.toString("utf8");
        } finally { fs.closeSync(fd); }
        const nl = text.indexOf("\n"); // 截断的首行可能是半行，丢弃
        if (nl >= 0) text = text.slice(nl + 1);
      } else {
        text = fs.readFileSync(file, "utf8");
      }
      chunks.push(...text.split("\n").filter((l) => l.trim()));
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e), lines: [], missing };
    }
  }
  if (!chunks.length) return { ok: false, error: "no-log", lines: [], missing };
  return { ok: true, lines: chunks.slice(-want), missing, total: chunks.length };
}

/**
 * 单行脱敏（对已知日志形态做定向打码，保留诊断结构）：
 * - 密钥类：key/token/secret/bearer/authorization 的值
 * - URL query
 * - 路径中的用户名：C:\Users\<name> → C:\Users\<user>（保留路径结构供诊断）
 * - 窗口标题：title:"..." / title":"..."
 * - 精确坐标：x/y 的 JSON 冒号形与 k=v 形，个位归零（10px 模糊，走路诊断仍可用）
 * - PID/hwnd
 * - 用户称呼（opts.userNames）与邮箱
 */
function sanitizeLine(line, opts = {}) {
  let s = String(line || "");
  const names = Array.isArray(opts.userNames) ? opts.userNames.filter((n) => typeof n === "string" && n.trim().length >= 1 && n.length <= 24) : [];
  for (const n of names) {
    try { s = s.split(n).join("<name>"); } catch { /* 忽略 */ }
  }
  s = s
    .replace(/\b(api[_-]?key|apikey|key|token|secret|bearer|authorization|password)\b(["'=:\s]+)([^\s"',;}\\]{4,})/gi, "$1$2<masked>")
    .replace(/\b(sk|pk)-[A-Za-z0-9_-]{8,}/g, "<masked-key>")
    .replace(/(https?:\/\/[^?"\s)]+)\?[^"\s)]*/g, "$1?<q>")
    .replace(/([A-Z]:(?:\\|\/)(?:Users|用户)(?:\\|\/))([^\\/"':;,)\s]+)/g, "$1<user>")
    .replace(/(title"?\s*[:=]\s*")([^"]*)(")/g, '$1<masked>$3')
    .replace(/([{,]\s*"?)([xy])("?\s*:\s*)(\d+)/g, (m, a, k, q, num) => a + k + q + (Math.round(Number(num) / 10) * 10))
    .replace(/\b([xy])=(\d+)/g, (m, k, num) => k + "=" + (Math.round(Number(num) / 10) * 10))
    .replace(/\b(pid|hwnd|handle)\b(\s*[:=]\s*)("?)(\d+)\2?/gi, (m, k, sep, q) => k + sep + q + "<masked>")
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "<email>");
  return s;
}

/** 全量脱敏（逐行，保持行结构） */
function sanitizeLines(lines, opts = {}) {
  return (Array.isArray(lines) ? lines : []).map((l) => sanitizeLine(l, opts));
}

/** 导出文本：头部元信息 + 脱敏正文 + 关键字统计 */
function buildExport(readResult, opts = {}) {
  const lines = sanitizeLines(readResult && readResult.lines, opts);
  const stats = { error: 0, warn: 0, info: 0 };
  for (const l of lines) stats[classifyLine(l)] += 1;
  const head = [
    "SuzuranPet 日志导出（已脱敏）",
    "导出时间: " + new Date().toISOString(),
    "应用版本: " + String(opts.appVersion || "?"),
    "日志行数: " + lines.length + "（错误 " + stats.error + " / 警告 " + stats.warn + " / 常规 " + stats.info + "）",
    "脱敏说明: 密钥、URL 参数、路径中的用户名、窗口标题、精确坐标（10px 模糊）、PID/hwnd、称呼、邮箱已打码；本文件仅含运行日志 tts.log(+.1) 尾部。",
    "报错定位提示: 优先看 [error] 标记行与「回退系统语音/render-process-gone/守卫/拦截非法」等关键字。",
    "".padEnd(60, "-")
  ];
  return { text: head.join("\n") + "\n" + lines.join("\n") + "\n", stats };
}

/** 托盘/设置页要打码的称呼来源：从配置里挑候选字段（main.js 调用） */
function collectUserNames(cfg) {
  const c = cfg || {};
  const out = [];
  for (const v of [c.name, c.nickname, c.userName, c && c.user && c.user.name]) {
    if (typeof v === "string" && v.trim() && v.length <= 24) out.push(v.trim());
  }
  return [...new Set(out)];
}

module.exports = { classifyLine, readLogTail, sanitizeLine, sanitizeLines, buildExport, collectUserNames, ERROR_PATTERNS, WARN_PATTERNS };
