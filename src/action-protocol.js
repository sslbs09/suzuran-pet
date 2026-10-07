"use strict";

/**
 * action-protocol.js — M2 通用 Body 动作请求协议（protocolVersion 1）的纯校验与指纹。
 *
 * 契约边界（Foundation M2）：
 *   - Action Request = { protocolVersion, intentId, actionType, payload }。
 *     intentId 是 Character 动作执行标识（WhiteMoon Core 铸造），Body 原样接收、
 *     原样回显，绝不重新铸造、绝不与 M1 的 docEpoch / bodyGeneration（Body 文档/
 *     renderer 代次标识）混用——那是两套完全不同的身份。
 *   - protocolVersion 只接受 1：不做版本协商、不做多版本 runtime；不认识的版本
 *     明确拒绝（§35）。
 *   - payload 对协议层不透明：Body 只在自己的 actionType 处理分支解释它
 *     （speak → text/emotion/force），协议校验只保证「是个 JSON 对象」。
 *   - 纯函数：无 I/O、无时钟、无随机数；同一输入永远同一判定与指纹。
 *   - 普通畸形输入返回结构化 { ok:false, reason }，绝不 throw——HTTP 层按
 *     reason 映射诚实响应。
 */

const crypto = require("crypto");

const PROTOCOL_VERSION = 1;
// 长度上限是请求体卫生限制，不是角色语义：intentId 对 Body 永远是不透明标识。
const INTENT_ID_MAX_LENGTH = 128;
const ACTION_TYPE_MAX_LENGTH = 64;

/** 递归稳定序列化（key 排序），保证同一语义内容永远得到同一指纹。 */
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(value[k])).join(",") + "}";
}

/** payload 的语义指纹：同 intentId + 同指纹 = 同一动作的重放；同 intentId + 异指纹 = 冲突。 */
function payloadFingerprint(payload) {
  return crypto.createHash("sha256").update(stableStringify(payload ?? {}), "utf8").digest("hex");
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * 校验一个 Action Request 信封。
 * @returns {{ok:true, intentId:string, actionType:string, payload:object}
 *          | {ok:false, reason:string, error:string}}
 */
function validateActionRequest(body) {
  if (!isPlainObject(body)) {
    return { ok: false, reason: "invalid-payload", error: "action request must be a JSON object" };
  }
  if (body.protocolVersion === undefined || body.protocolVersion === null) {
    return { ok: false, reason: "missing-protocol-version", error: "protocolVersion is required (number 1)" };
  }
  if (body.protocolVersion !== PROTOCOL_VERSION) {
    return {
      ok: false,
      reason: "unsupported-protocol-version",
      error: `protocolVersion ${JSON.stringify(body.protocolVersion)} is not supported; this body speaks version ${PROTOCOL_VERSION} only`
    };
  }
  const intentId = typeof body.intentId === "string" ? body.intentId.trim() : "";
  if (!intentId || intentId.length > INTENT_ID_MAX_LENGTH) {
    return {
      ok: false,
      reason: "missing-intent-id",
      error: `intentId must be a non-empty string (<=${INTENT_ID_MAX_LENGTH}) — an execution fact with no identity is not admissible`
    };
  }
  const actionType = typeof body.actionType === "string" ? body.actionType.trim() : "";
  if (!actionType || actionType.length > ACTION_TYPE_MAX_LENGTH) {
    return {
      ok: false,
      reason: "missing-action-type",
      error: `actionType must be a non-empty string (<=${ACTION_TYPE_MAX_LENGTH})`
    };
  }
  const payload = body.payload === undefined ? {} : body.payload;
  if (!isPlainObject(payload)) {
    return { ok: false, reason: "invalid-payload", error: "payload must be a JSON object" };
  }
  return { ok: true, intentId, actionType, payload };
}

/** interrupt 请求只携带 protocolVersion；intentId 来自路径本身（§21：必须指定具体 intentId）。 */
function validateInterruptRequest(body) {
  if (!isPlainObject(body)) {
    return { ok: false, reason: "invalid-payload", error: "interrupt request must be a JSON object" };
  }
  if (body.protocolVersion !== PROTOCOL_VERSION) {
    return {
      ok: false,
      reason: body.protocolVersion === undefined ? "missing-protocol-version" : "unsupported-protocol-version",
      error: `interrupt requires protocolVersion ${PROTOCOL_VERSION}`
    };
  }
  return { ok: true };
}

module.exports = {
  PROTOCOL_VERSION,
  INTENT_ID_MAX_LENGTH,
  ACTION_TYPE_MAX_LENGTH,
  stableStringify,
  payloadFingerprint,
  validateActionRequest,
  validateInterruptRequest
};
