"use strict";

/**
 * host/document-generation.js — DocumentGenerationAuthority v0.1 基础件（ADR-010 / D-010）。
 *
 * Electron renderer **document** 代次的唯一权威。**纯逻辑，无 I/O、不 import Electron、
 * 不接 main.js 生产路径**（迁移第 0 步只交付模块 + 单测）。
 *
 * owns ONLY
 *   · Electron renderer document epoch / generation
 *   · reload / recovery / new-document 的代次边界
 *
 * does NOT own（ADR-010 明确）
 *   · body instance generation —— 独立未决域；本模块不推进、不裁决
 *   · drag session token / locomotion attemptId / animation request generation
 *   · runtime-shadow sourceSeq / receiveOrder / causeRef
 *   · 任何角色语义：Character / WhiteMoon 语义内核不得查询 document epoch
 *
 * 承接 lifecycle-projection.js 的优良语义：
 *   ① 代际只前进不回卷（更小的 epoch 提交被标 stale，不改状态）
 *   ② **代际未知时不妄拒**：epoch 为 null/undefined/非法一律视为 current
 *      ——"没带纪元"不等于"纪元过期"，这是原实现最容易被误删的正确行为
 *   ③ 失效台账有界（FIFO），供诊断而非持久
 *
 * lifecycle-projection.js 的最终归宿（ADR-010 已记录，尚未执行）：
 *   docEpoch 部分 → 本模块；bodyGeneration 部分 → 保持独立未决域。
 */

/** 失效台账上限，对齐 runtime-shadow 的 INVALIDATION_LEDGER_MAX 惯例。 */
const INVALIDATION_LEDGER_MAX = 16;

function isEpoch(v) {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * 候选纪元是否**真的报告了一个数值**。
 * 只接受有限数值与非空数值字符串——刻意不接受其他类型的隐式强制转换：
 * `Number([])===0`、`Number(true)===1`、`Number({})===NaN`，盲转换会把"没报告纪元"
 * 伪装成"报告了一个旧纪元"，从而**制造假拒绝**，与本模块的宽容意图相悖。
 */
function isReportedEpoch(v) {
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v === "string") return v.trim() !== "" && Number.isFinite(Number(v));
  return false;
}

function createDocumentGenerationAuthority({ ledgerMax = INVALIDATION_LEDGER_MAX, now = Date.now } = {}) {
  if (typeof ledgerMax !== "number" || ledgerMax < 1) {
    throw new TypeError("document-generation: ledgerMax 必须是 >=1 的数字");
  }

  let epoch = null;       // 当前 document epoch；null = 尚未知
  let revision = 0;       // 单调修订号，每次实际换代 +1
  const ledger = [];      // 有界失效台账 {kind, reason, epoch, revision}

  /**
   * 代际推进（reload / recovery / 新文档）。
   * 只前进不回卷：更小的 epoch 视为陈旧提交，不改变任何状态。
   * @returns {{changed: boolean, revision: number, epoch: number|null, stale?: boolean}}
   */
  function begin(nextEpoch) {
    if (!isEpoch(nextEpoch)) {
      // 不伪造代次：非法输入既不推进也不回卷
      return { changed: false, revision: revision, epoch: epoch, ignored: "bad-epoch" };
    }
    if (epoch !== null && nextEpoch < epoch) {
      return { changed: false, revision: revision, epoch: epoch, stale: true };
    }
    if (nextEpoch === epoch) {
      return { changed: false, revision: revision, epoch: epoch };
    }
    epoch = nextEpoch;
    revision += 1;
    return { changed: true, revision: revision, epoch: epoch };
  }

  function current() {
    return { epoch: epoch, revision: revision };
  }

  function currentEpoch() { return epoch; }
  function currentRevision() { return revision; }

  /**
   * 陈旧判定。**宽容语义是本模块的核心契约**：
   * 未带纪元（null / undefined / 非有限数）一律 current——身份由各域自证，
   * 不得因"没报告纪元"而误杀合法工作流。
   */
  function isCurrent(candidateEpoch) {
    if (!isReportedEpoch(candidateEpoch)) return true; // 未报告纪元 / 非法类型 → 不妄拒
    const e = Number(candidateEpoch);
    if (epoch === null) return true; // 代际未知：不妄拒
    return e >= epoch;
  }

  /**
   * 记录一次失效（reload / crash / 新文档 / teardown）。
   * 实际失效动作由组合层执行；本模块只记账。
   */
  function invalidate(kind, reason) {
    const entry = {
      kind: String(kind || "unknown"),
      reason: String(reason || ""),
      epoch: epoch,
      revision: revision,
      at: now()
    };
    ledger.push(entry);
    if (ledger.length > ledgerMax) ledger.shift();
    return entry;
  }

  /** 返回**条目副本**——浅拷贝会让外部改到台账内部对象（诊断数据不得被外部污染）。 */
  function ledgerEntries() { return ledger.map((e) => Object.assign({}, e)); }
  function isKnown() { return epoch !== null; }

  function snapshot() {
    return {
      epoch: epoch,
      revision: revision,
      known: epoch !== null,
      ledger: ledgerEntries(),
      ledgerMax: ledgerMax
    };
  }

  function reset() {
    epoch = null;
    revision = 0;
    ledger.length = 0;
  }

  return {
    begin,
    current,
    currentEpoch,
    currentRevision,
    isCurrent,
    invalidate,
    ledger: ledgerEntries,
    isKnown,
    snapshot,
    reset,
    INVALIDATION_LEDGER_MAX: ledgerMax
  };
}

module.exports = { createDocumentGenerationAuthority, INVALIDATION_LEDGER_MAX };