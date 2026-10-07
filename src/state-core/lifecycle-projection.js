/**
 * lifecycle-projection.js — State Core 的 Lifecycle Projection（纯模块，无 I/O）。
 *
 * 统一定义 renderer reload / document replacement / body generation replacement
 * 对 State Core 各 domain 的影响：
 *
 *   保留：semantic posture（main canonical，策略允许时跨 reload 保持）
 *         valid support intent（但 evidence 失效，需重新验证）
 *   失效：pointer candidate / drag session / interaction-local token /
 *         renderer object / TrackEntry / 旧 measurement /
 *         renderer-owned stale pause lease
 *
 * 本模块只持有「当前有效代际 + 失效台账（有界）」并回答 isCurrent(epoch)；
 * 实际失效动作（pause revoke / interaction invalidate / support invalidate）
 * 由 main 组合层调用各 domain 模块执行。不做 full process restart persistence。
 */
"use strict";

const INVALIDATION_LEDGER_MAX = 16;

function createLifecycleProjection() {
  let generation = { docEpoch: null, bodyGeneration: null, revision: 0 };
  let readiness = { ready: false, identity: null };
  const ledger = []; // 有界失效台账 {kind, reason, revision}

  function revision() { return generation.revision; }

  return {
    /**
     * 代际推进：docEpoch 或 bodyGeneration 变化（renderer reload / body replacement）。
     * 只前进不回卷。返回 {changed, revision}。
     */
    begin({ docEpoch, bodyGeneration } = {}) {
      const de = docEpoch !== null && docEpoch !== undefined ? Number(docEpoch) : null;
      const bg = bodyGeneration !== null && bodyGeneration !== undefined ? Number(bodyGeneration) : null;
      let changed = false;
      if (de !== null && Number.isFinite(de) && generation.docEpoch !== null && de < generation.docEpoch) {
        return { changed: false, revision: generation.revision, stale: true }; // 旧纪元不得回卷
      }
      if (de !== null && generation.docEpoch !== de) { generation.docEpoch = de; changed = true; }
      if (bg !== null && Number.isFinite(bg) && generation.bodyGeneration !== bg) { generation.bodyGeneration = bg; changed = true; }
      if (changed) {
        generation.revision += 1;
        readiness = { ready: false, identity: null };
      }
      return { changed, revision: generation.revision };
    },
    revision,
    current() { return Object.assign({}, generation); },
    /** 旧文档纪元的事件不再被接受（isCurrent 合同；不因「晚收到」本身拒绝，只按纪元比较）。 */
    isCurrent(docEpoch) {
      if (docEpoch && typeof docEpoch === "object") {
        const de = Number(docEpoch.docEpoch), bg = Number(docEpoch.bodyGeneration);
        if (!Number.isSafeInteger(de) || !Number.isSafeInteger(bg)) return false;
        return generation.docEpoch === de && generation.bodyGeneration === bg;
      }
      if (docEpoch === null || docEpoch === undefined) return true; // 无纪元事件不参与纪元判定
      const de = Number(docEpoch);
      if (!Number.isFinite(de)) return true;
      if (generation.docEpoch === null) return true; // 代际未知：不妄拒（身份由各 domain 自证）
      return de >= generation.docEpoch;
    },
    /** Mark the actual visual owner usable for the current exact identity. */
    markReady(identity) {
      if (!identity || typeof identity !== "object"
        || !Number.isSafeInteger(Number(identity.docEpoch))
        || !Number.isSafeInteger(Number(identity.bodyGeneration))
        || !this.isCurrent(identity)) return { ok: false, reason: "stale-or-missing-identity" };
      readiness = { ready: true, identity: { docEpoch: Number(identity.docEpoch), bodyGeneration: Number(identity.bodyGeneration) } };
      return { ok: true, identity: Object.assign({}, readiness.identity) };
    },
    ready() { return readiness.ready; },
    usable(identity) { return readiness.ready && this.isCurrent(identity || readiness.identity); },
    resetReady(reason) {
      readiness = { ready: false, identity: readiness.identity };
      return { ok: true, reason: String(reason || "reset") };
    },
    /** 记录一次失效（有界台账；actual 动作由组合层执行）。 */
    invalidate(kind, reason) {
      const entry = { kind: String(kind || "unknown"), reason: String(reason || ""), revision: generation.revision };
      ledger.push(entry);
      if (ledger.length > INVALIDATION_LEDGER_MAX) ledger.shift();
      return entry;
    },
    ledger() { return ledger.slice(); }
  };
}

module.exports = { createLifecycleProjection, INVALIDATION_LEDGER_MAX };
