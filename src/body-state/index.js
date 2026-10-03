"use strict";

/**
 * body-state/index.js — BodyStateAuthority v0.1 基础件（ADR-009 / D-009）。
 *
 * posture 与 support 的唯一权威。**纯逻辑，无 I/O、无 Electron、不接 main.js 生产路径。**
 *
 * 拥有（OWNS）
 *   · 物理姿态 physical posture
 *   · 支撑关系 support relation
 *   · 支撑证据有效性 support evidence validity
 *
 * 不拥有（does NOT own）
 *   · resting / idle 策略        —— 相位机产出，是动画选择轴（ADR-009 明确排除）
 *   · locomotion phase / episode —— LocomotionController
 *   · x/y 位置写入权              —— MotionAuthority（已冻结）
 *   · animation choice            —— renderer
 *   · body instance generation    —— 独立未决域；本模块只把它当**输入**消费（ADR-010）
 *
 * 建模纪律（承接 posture-support.js 的优良部分）：
 *   posture 与 support 严格分离——姿态语义仍在、支撑证据已过期，是合法且诚实的状态，
 *   不是错误。因此支撑证据失效**不得**改变姿态语义。
 */

const BODY_POSTURES = ["standing", "seated", "perched", "unknown"];
const SUPPORT_KINDS = ["taskbar", "icon", "window-top", "none", "unknown"];

/** 无支撑声明时的缺省支撑面。 */
const SUPPORT_NONE = "none";

function isPosture(v) { return BODY_POSTURES.indexOf(v) !== -1; }
function isSupportKind(v) { return SUPPORT_KINDS.indexOf(v) !== -1; }

/**
 * @param {Object} deps
 *  - capabilities  只读能力声明，如 `{ canSit: boolean }`。**能力的所有者不在本模块范围**
 *                   （ADR-009 明确未定）。缺省视为无能力。
 *  - now           注入时钟（可测）
 */
function createBodyStateAuthority({ capabilities = {}, now = Date.now } = {}) {
  if (capabilities === null || typeof capabilities !== "object") {
    throw new TypeError("body-state: capabilities 必须是对象");
  }

  const state = {
    posture: { value: "unknown", since: null },
    support: {
      kind: "unknown",
      valid: false,
      anchorStatus: "unknown",
      evidenceGeneration: null,
      staleReason: null
    },
    // 外部代次：只记录、只比较，**本权威永不推进它**（body generation 的 owner 未决）。
    observedGeneration: null,
    invalidations: 0,
    lastInvalidation: null
  };

  function canSit() { return capabilities.canSit === true; }

  /** 写入姿态语义。未知值归 unknown，不静默丢弃。 */
  function setPosture(value, meta) {
    const next = isPosture(value) ? value : "unknown";
    const changed = state.posture.value !== next;
    if (changed) state.posture.value = next;
    state.posture.since = meta && meta.now !== undefined ? meta.now : now();
    return { changed, posture: next, from: changed ? state.posture.value : null };
  }

  /** 声明支撑面及其证据有效性。不改变姿态语义。 */
  function declareSupport(kind, opts) {
    const o = opts || {};
    const k = isSupportKind(kind) ? kind : "unknown";
    state.support.kind = k;
    state.support.valid = o.valid === true;
    state.support.anchorStatus = state.support.valid ? String(o.anchorStatus || "anchored") : "unknown";
    if (o.evidenceGeneration !== undefined && o.evidenceGeneration !== null) {
      state.support.evidenceGeneration = o.evidenceGeneration;
    }
    state.support.staleReason = null;
    return { ok: true, kind: k, valid: state.support.valid, posture: state.posture.value };
  }

  /**
   * 进入休息姿态。**最终落在 seated 还是 standing 由身体能力决定**——
   * 无坐下动画的身体不得进入坐姿（这是 ADR-009 认定的物理能力门，不是策略）。
   * 本方法不声明支撑：支撑由 declareSupport / enterPerched 单独声明。
   */
  function enterRest(meta) {
    const next = canSit() ? "seated" : "standing";
    const from = state.posture.value;
    const r = setPosture(next, meta);
    return { posture: next, from: from, changed: r.changed, capability: canSit() ? "can-sit" : "cannot-sit" };
  }

  /** 进入 perched。姿态与支撑同刻一致：perched 必须有支撑面。 */
  function enterPerched(kind, opts) {
    const k = isSupportKind(kind) && kind !== "unknown" ? kind : "window-top";
    setPosture("perched", opts);
    const s = declareSupport(k, Object.assign({ valid: opts && opts.valid === true }, opts));
    return { posture: state.posture.value, support: s.kind, supportValid: s.valid };
  }

  /** 离开支撑：支撑清理 + 姿态回到站立。 */
  function leaveSupport(meta) {
    const from = state.posture.value;
    state.support.kind = SUPPORT_NONE;
    state.support.valid = false;
    state.support.anchorStatus = "unknown";
    state.support.evidenceGeneration = null;
    state.support.staleReason = null;
    setPosture("standing", meta);
    return { posture: state.posture.value, from: from, support: state.support.kind, supportCleared: true };
  }

  /**
   * 消费外部提供的支撑证据。支撑证据失效**只影响 support**，
   * 姿态语义保持不变——「坐姿语义仍在、支撑证据已过期」是合法状态。
   *
   * @param {Object} evidence
   *  - generation   外部代次（body instance generation 等）。**仅记录，永不推进**
   *  - valid        本次证据是否有效
   *  - reason       失效原因
   */
  function observeEvidence(evidence) {
    const e = evidence || {};
    if (e.generation !== undefined && e.generation !== null) state.observedGeneration = e.generation;
    if (e.valid === true) {
      state.support.anchorStatus = "anchored";
      state.support.staleReason = null;
      if (e.valid !== undefined) state.support.valid = true;
      return { ok: true, posture: state.posture.value, support: state.support.kind, stale: false };
    }
    // 证据失效：只降 support，绝不动 posture。
    state.support.valid = false;
    state.support.anchorStatus = "stale";
    state.support.staleReason = String(e.reason || "evidence-stale");
    state.invalidations += 1;
    state.lastInvalidation = { reason: state.support.staleReason, generation: state.observedGeneration };
    return { ok: true, posture: state.posture.value, support: state.support.kind, stale: true };
  }

  function posture() { return state.posture.value; }
  function support() {
    return Object.assign({}, state.support);
  }
  function canSitNow() { return canSit(); }

  function snapshot() {
    return {
      posture: { value: state.posture.value, since: state.posture.since },
      support: Object.assign({}, state.support),
      observedGeneration: state.observedGeneration,
      invalidations: state.invalidations,
      lastInvalidation: state.lastInvalidation,
      capabilities: { canSit: canSit() }
    };
  }

  return {
    BODY_POSTURES,
    SUPPORT_KINDS,
    setPosture,
    declareSupport,
    enterRest,
    enterPerched,
    leaveSupport,
    observeEvidence,
    posture,
    support,
    canSitNow,
    snapshot
  };
}

module.exports = { createBodyStateAuthority, BODY_POSTURES, SUPPORT_KINDS };