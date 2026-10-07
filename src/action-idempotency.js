"use strict";

/**
 * action-idempotency.js — M2 intentId 级动作幂等存储（运行期内存，有界，不持久化）。
 *
 * 规则（冻结，与 Core 的 lastExecution duplicate/progression/conflict 纪律同构）：
 *   - 同 intentId + 同 payload 指纹 → 'duplicate'：第二次送达不得再产生实际副作用，
 *     调用方回显首次的诚实结果。
 *   - 同 intentId + 不同 payload 指纹 → 'conflict'：显式拒绝，绝不把它当成新动作执行。
 *   - 未见过 → 'new'。
 *
 * 边界（§10/§11）：
 *   - 这是「动作执行标识」级的幂等，不是文本去重：两个不同 intentId 即使文本完全相同
 *     也是不同 Intent（文本去重/闸门仍是 line-gate 的既有职责，互不替代）。
 *   - 纯运行期：Map 有界（FIFO 淘汰，maxEntries 条），Body 绝不持久化任何 Character
 *     历史；重启后窗口清空是如实的已知限制（v0.1 无持久幂等需求证据，不提前设计）。
 *   - 只存不透明标识 + 内容指纹 + 本 Body 自己的诚实结果，不存角色语义、不存 payload
 *     原文。
 */

const DEFAULT_MAX_ENTRIES = 128;

function createIntentIdempotencyStore({ maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
  const limit = Math.max(1, Number(maxEntries) || DEFAULT_MAX_ENTRIES);
  // Map 保持插入序：最早进入的键在头部，FIFO 淘汰只动头部。
  const entries = new Map();

  /** 判定一个 (intentId, fingerprint) 组合：new | duplicate | conflict。 */
  function classify(intentId, fingerprint) {
    const entry = entries.get(intentId);
    if (!entry) return "new";
    return entry.fingerprint === fingerprint ? "duplicate" : "conflict";
  }

  /** 记录一次已受理（admitted）的执行尝试；outcome = { result, actionType, ... } 平铺存储，
   *  重复记录同 intentId 覆盖为最新结果。 */
  function record(intentId, fingerprint, outcome) {
    if (entries.has(intentId)) entries.delete(intentId);
    entries.set(intentId, { fingerprint, ...(outcome || {}) });
    while (entries.size > limit) entries.delete(entries.keys().next().value);
  }

  /** 该 intentId 是否被本 Body 受理过（interrupt 的 found/not-found 依据）。 */
  function lookup(intentId) {
    return entries.get(intentId);
  }

  function size() {
    return entries.size;
  }

  function reset() {
    entries.clear();
  }

  return { classify, record, lookup, size, reset };
}

module.exports = { createIntentIdempotencyStore, DEFAULT_MAX_ENTRIES };
