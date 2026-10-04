"use strict";

/**
 * error-facts.js — 错误事实层（Phase 5-C）
 *
 * 职责：让「错误来源」主动产出结构化事实，而不是让下游去解析 message 文本。
 *
 *   Error source
 *       ↓  throw new ErrorWithCode(code, { meta, message, detail })
 *   ErrorWithCode { code, meta, message, detail }
 *       ↓  toPayload()  —— 唯一的跨进程投影
 *   { code, meta, message }        ← detail 在此被丢弃，永不离开主进程
 *       ↓  src/error-presenter.js（Phase 5-A，既有，不改）
 *   { key, params } → I18N.t()
 *
 * 不变量：
 *  - code 只能取下面 11 个，与 src/error-presenter.js 的 ERROR_PRESENTATIONS 严格同集合。
 *    本文件不得新增 code；词表扩展属于 error-presenter 的范围。
 *  - meta 走白名单，且仅 HTTP_ERROR 允许携带 status（与 presenter 的 err.http / err.httpGeneric 规则对齐）。
 *  - message 保留兼容用途，但经过 redactMessage 脱敏：禁止携带 provider body、完整 URL、
 *    token、stack、敏感配置。原始全文只进 detail（仅诊断投影，日志专用）。
 *  - detail 不进入 IPC payload、不进入 renderer、不进入 Agent 响应。
 */

const ERROR_CODES = Object.freeze({
  NO_API_KEY: "NO_API_KEY",
  AUTH_INVALID: "AUTH_INVALID",
  QUOTA_EXCEEDED: "QUOTA_EXCEEDED",
  TIMEOUT: "TIMEOUT",
  NETWORK_ERROR: "NETWORK_ERROR",
  SSRF_BLOCKED: "SSRF_BLOCKED",
  BAD_URL: "BAD_URL",
  HTTP_ERROR: "HTTP_ERROR",
  CANCELLED: "CANCELLED",
  BUSY: "BUSY",
  INTERNAL: "INTERNAL"
});

/** meta 白名单：只允许 status，且必须与 presenter 的校验规则一致（整数 100..599）。 */
const META_WHITELIST = Object.freeze(["status"]);
const HTTP_STATUS_MIN = 100;
const HTTP_STATUS_MAX = 599;

/** Node/undici 系统 errno → 事实 code。这些是事实来源，不依赖 message 文本。 */
const SYSTEM_ERROR_CODES = Object.freeze({
  ECONNREFUSED: ERROR_CODES.NETWORK_ERROR,
  ECONNRESET: ERROR_CODES.NETWORK_ERROR,
  ENOTFOUND: ERROR_CODES.NETWORK_ERROR,
  EAI_AGAIN: ERROR_CODES.NETWORK_ERROR,
  EHOSTUNREACH: ERROR_CODES.NETWORK_ERROR,
  ENETUNREACH: ERROR_CODES.NETWORK_ERROR,
  EPIPE: ERROR_CODES.NETWORK_ERROR,
  UND_ERR_SOCKET: ERROR_CODES.NETWORK_ERROR,
  UND_ERR_CONNECT_TIMEOUT: ERROR_CODES.TIMEOUT,
  ETIMEDOUT: ERROR_CODES.TIMEOUT,
  ECONNABORTED: ERROR_CODES.TIMEOUT,
  ERR_CANCELED: ERROR_CODES.CANCELLED
});

/* ------------------------------------------------------------------ *
 * code / meta 归一
 * ------------------------------------------------------------------ */

/** code 归一：白名单外（含 __proto__/constructor 等继承属性）一律 INTERNAL。 */
function normalizeCode(code) {
  if (typeof code !== "string") return ERROR_CODES.INTERNAL;
  if (!Object.prototype.hasOwnProperty.call(ERROR_CODES, code)) return ERROR_CODES.INTERNAL;
  return ERROR_CODES[code];
}

/** meta 归一：白名单 + 类型校验；非 HTTP_ERROR 不携带 status（presenter 也不会插值它）。 */
function normalizeMeta(code, meta) {
  const normalizedCode = normalizeCode(code);
  if (normalizedCode !== ERROR_CODES.HTTP_ERROR) return Object.freeze({});
  const out = {};
  for (const key of META_WHITELIST) {
    if (key !== "status" || !meta || typeof meta !== "object") continue;
    if (!Object.prototype.hasOwnProperty.call(meta, "status")) continue;
    const status = meta.status;
    if (typeof status === "number" && Number.isInteger(status) && status >= HTTP_STATUS_MIN && status <= HTTP_STATUS_MAX) {
      out.status = status;
    }
  }
  return Object.freeze(out);
}

/** HTTP 状态 → code。不得引入 PROVIDER_UNAVAILABLE / RATE_LIMIT 等新码。 */
function httpStatusToCode(status) {
  if (typeof status !== "number" || !Number.isInteger(status)) return ERROR_CODES.INTERNAL;
  if (status === 401 || status === 403) return ERROR_CODES.AUTH_INVALID;
  if (status === 402 || status === 429) return ERROR_CODES.QUOTA_EXCEEDED;
  if (status >= HTTP_STATUS_MIN && status <= HTTP_STATUS_MAX) return ERROR_CODES.HTTP_ERROR;
  return ERROR_CODES.INTERNAL;
}

/** HTTP 响应 → 带 meta 的事实 code（HTTP_ERROR 之外的状态不外泄 status，避免死数据）。 */
function codeForHttpStatus(status) {
  const code = httpStatusToCode(status);
  return code === ERROR_CODES.HTTP_ERROR ? { code, meta: { status } } : { code, meta: {} };
}

/* ------------------------------------------------------------------ *
 * message 脱敏
 * ------------------------------------------------------------------ */

/**
 * 把任意 message 收敛为「可安全随 payload 外发」的形态。
 * 顺序有意义：先砍 provider body，再脱 URL，最后脱 token。
 */
function redactMessage(text) {
  if (text === null || text === undefined) return "";
  let s = String(text);

  // 1) stack 帧（\n    at fn (file:line)）— 只留首行
  s = s.split(/\n\s*at\s/)[0];

  // 2) provider body：`API 502: {...}` / `HTTP 404: <html>...` 一律截到状态码为止
  s = s.replace(/((?:API|HTTP|status)\s*\d{3})\s*[:：][\s\S]*$/i, "$1");

  // 3) 完整 URL（含 userinfo / query / hash）
  s = s.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>）)]+/gi, "[url]");

  // 4) 常见凭据形态
  s = s.replace(/\b(?:sk|pk|rk|ak|key)-[A-Za-z0-9_-]{8,}/gi, "[redacted]");
  s = s.replace(/\bBearer\s+\S+/gi, "Bearer [redacted]");
  s = s.replace(/\b(?:Basic|Token)\s+\S+/gi, "[redacted]");

  // 5) 长不透明串（≥32 位 base64/hex）— 兜底，防止前四条漏网
  s = s.replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted]");

  return s.trim();
}

/* ------------------------------------------------------------------ *
 * ErrorWithCode
 * ------------------------------------------------------------------ */

class ErrorWithCode extends Error {
  /**
   * @param {string} code 11 个白名单 code 之一；非法值归一为 INTERNAL
   * @param {{meta?:object, message?:string, detail?:string}} [opts]
   *   meta    仅 status（100..599 整数）可用，其余字段被白名单丢弃
   *   message 用户/日志可读文案，自动脱敏
   *   detail  原始诊断全文（provider body / 原始 message）—— 仅 toDiagnostic() 输出，
   *           绝不进入 toPayload()，因此不会到达 renderer / IPC / Agent 响应
   */
  constructor(code, opts = {}) {
    const normalized = normalizeCode(code);
    const rawMessage = typeof opts.message === "string" && opts.message.trim()
      ? opts.message
      : normalized; // 无文案时退回 code 本身：日志可读，且零泄漏面
    super(redactMessage(rawMessage));
    this.name = "ErrorWithCode";
    this.code = normalized;
    this.meta = normalizeMeta(normalized, opts.meta);
    this.detail = typeof opts.detail === "string" ? opts.detail : "";
  }
}

function isCodedError(err) {
  return !!err && typeof err === "object" && typeof err.code === "string" &&
    Object.prototype.hasOwnProperty.call(ERROR_CODES, err.code);
}

/* ------------------------------------------------------------------ *
 * 兼容分类（仅供「旧 Error 没有 code」时兜底）
 * ------------------------------------------------------------------ */

const LEGACY_STATUS_RE = /(?:^|[^\w])((?:API|HTTP|status)\s*)(\d{3})/i;

/**
 * 把任意异常归类为统一 code。
 * 优先级（事实优先，regex 仅最后兜底）：
 *   1. AbortError → CANCELLED
 *   2. 已有 11 码之一 → 采用
 *   3. Node/undici errno → 映射（ENOTFOUND/ECONNREFUSED → NETWORK_ERROR 等）
 *   4. 整数 status 字段 → httpStatusToCode
 *   5. 旧 message 文本 → 仅作为历史兼容，产出 11 码之一
 */
function classifyError(err) {
  if (!err) return ERROR_CODES.INTERNAL;
  if (err.name === "AbortError") return ERROR_CODES.CANCELLED;
  if (isCodedError(err)) return err.code;
  if (typeof err.code === "string" && Object.prototype.hasOwnProperty.call(SYSTEM_ERROR_CODES, err.code)) {
    return SYSTEM_ERROR_CODES[err.code];
  }
  const status = Number.isInteger(err.status) ? err.status : Number.isInteger(err.statusCode) ? err.statusCode : null;
  if (status !== null && status >= HTTP_STATUS_MIN && status <= HTTP_STATUS_MAX) return httpStatusToCode(status);

  // ↓↓↓ 历史兼容分支：旧抛点仍在产出纯文本 message，这里继续兜住，但不再新增依赖。
  const msg = String(err.message || err);
  const m = msg.match(LEGACY_STATUS_RE);
  if (m) return httpStatusToCode(Number(m[2]));
  if (/timeout|timed out|aborted/i.test(msg)) return ERROR_CODES.TIMEOUT;
  return ERROR_CODES.INTERNAL;
}

/* ------------------------------------------------------------------ *
 * 投影
 * ------------------------------------------------------------------ */

/**
 * 跨进程投影：唯一的 IPC / renderer / Agent 出口形态。
 * 键集合被严格限制为 { code, meta, message }——detail 在此丢弃。
 */
function toPayload(err) {
  const code = classifyError(err);
  const meta = normalizeMeta(code, err && typeof err === "object" ? err.meta : null);
  const message = redactMessage(err && typeof err === "object" ? err.message : err);
  return { code, meta, message };
}

/** 诊断投影（日志专用）。含 detail 与 stack，绝不外发。 */
function toDiagnostic(err) {
  const payload = toPayload(err);
  const detail = err && typeof err === "object" && typeof err.detail === "string"
    ? err.detail
    : (err && typeof err === "object" && err.stack ? String(err.stack) : "");
  return {
    code: payload.code,
    meta: payload.meta,
    message: payload.message,
    detail,
    name: err && typeof err === "object" && err.name ? String(err.name) : ""
  };
}

module.exports = {
  ERROR_CODES,
  META_WHITELIST,
  ErrorWithCode,
  isCodedError,
  normalizeCode,
  normalizeMeta,
  httpStatusToCode,
  codeForHttpStatus,
  redactMessage,
  classifyError,
  toPayload,
  toDiagnostic
};