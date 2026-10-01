/**
 * posture-support.js — State Core 的 Posture / Support canonical state（纯模块，无 I/O）。
 *
 * 三个概念严格分离（不重新混入一个布尔）：
 * - posture：角色语义状态（standing / seated / airborne / transition / unknown）
 * - support：当前身体与外部支撑的关系（kind / valid / anchorStatus / generation）
 * - geometry/anchor：派生执行证据（由 main 的 geometry 证据刷新，本模块只记录有效性）
 *
 * 关键原则：posture=seated ≠ 「视觉一定正确坐在 taskbar 上」。
 * scale / resize / reload 之后：support.valid=false / anchorStatus=stale，
 * posture 保持 seated —— 状态模型诚实表达「坐姿语义仍在、支撑证据已过期」，
 * 而不是谎称一切正确。（真正修复 taskbar re-anchor 属后续 milestone。）
 *
 * 写入方向合同：legacy walk 字段（walk.seated 等）是 LEGACY POLICY STATE，
 * 只能经 adapter（main 的 observeWalk 调用）单向写入本模块；本模块永不回写 walk 字段。
 * airborne 语义上不可能同时持有 valid 的 seated/taskbar 支撑（模块内强制失效）。
 */
"use strict";

const POSTURES = ["standing", "seated", "airborne", "transition", "unknown"];
const SUPPORT_KINDS = ["taskbar", "icon", "window-top", "none", "unknown"];

function createPostureSupport() {
  const state = {
    posture: { state: "unknown", since: null, meta: null },
    support: { kind: "unknown", valid: false, anchorStatus: "unknown", generation: 0, staleReason: null },
    invalidations: 0,
    lastSupportInvalidation: null
  };

  function supportValidFor() {
    if (state.posture.state === "airborne") return false; // 离地语义下无有效支撑
    return !!state.support.valid;
  }

  function applyPosture(p, meta) {
    if (state.posture.state === p) return { changed: false };
    const prev = state.posture.state;
    state.posture = { state: p, since: meta && meta.now !== undefined ? meta.now : null, meta: (meta && meta.meta) || null };
    let supportInvalidated = false;
    if (p === "airborne" && state.support.kind !== "none" && state.support.kind !== "unknown") {
      state.support.valid = false;
      state.support.anchorStatus = "unknown";
      state.support.kind = "none";
      supportInvalidated = true;
    }
    return { changed: true, from: prev, to: p, supportInvalidated };
  }

  return {
    POSTURES,
    SUPPORT_KINDS,
    /** 设置语义 posture（canonical）。未知值 → "unknown"。 */
    setPosture(next, meta) {
      const p = POSTURES.includes(next) ? next : "unknown";
      const r = applyPosture(p, meta);
      return Object.assign({ ok: true }, r);
    },
    /**
     * adapter：从 legacy walk 字段单向派生语义 posture + support kind。
     * 不判定 validity（validity 由 evidence 事件管理）；不改 support.valid。
     */
    observeWalk(walk, meta) {
      if (!walk || typeof walk !== "object") return { ok: false };
      const posture = (walk.flight || walk.jump) ? "airborne"
        : (walk.seated || walk.perched) ? "seated"
        : (walk.gotoPerch || walk.returning || walk.iconTarget || walk.freeStand) ? "transition"
        : "standing";
      const kind = walk.perched ? "window-top"
        : (walk.iconRest || walk.iconTarget) ? "icon"
        : walk.seated ? "taskbar"
        : "none";
      const pr = applyPosture(posture, meta);
      let kindChanged = false;
      if (state.support.kind !== kind) { state.support.kind = kind; kindChanged = true; }
      return { ok: true, postureChanged: pr.changed, posture, kind, kindChanged, supportInvalidated: !!pr.supportInvalidated };
    },
    /** 支撑面声明（落座/贴地/落位等语义事件）。 */
    markSupport(kind, opts) {
      const o = opts || {};
      const k = SUPPORT_KINDS.includes(kind) ? kind : "unknown";
      state.support.kind = k;
      state.support.valid = !!o.valid && state.posture.state !== "airborne";
      state.support.anchorStatus = o.valid ? String(o.anchorStatus || "anchored") : "unknown";
      if (o.generation !== null && o.generation !== undefined) state.support.generation = o.generation;
      return { ok: true, kind: k, valid: state.support.valid };
    },
    /** 旧 geometry 证据失效（scale / resize / renderer reload）。语义 posture 保持不变。 */
    invalidateSupport(reason) {
      state.support.valid = false;
      state.support.anchorStatus = "stale";
      state.support.staleReason = String(reason || "unknown");
      state.invalidations += 1;
      state.lastSupportInvalidation = { reason: state.support.staleReason };
      return { ok: true, posture: state.posture.state, supportStale: true };
    },
    /** 新几何证据到达（ground-gap accepted 等）：evidence 世代推进（不谎称已正确落位）。 */
    refreshSupportEvidence(opts) {
      const o = opts || {};
      state.support.generation = Number.isFinite(Number(o.generation)) ? Number(o.generation) : state.support.generation + 1;
      return { ok: true, generation: state.support.generation };
    },
    isSupportValid() { return supportValidFor(); },
    posture() { return state.posture.state; },
    support() { return Object.assign({}, state.support, { validForCurrentPosture: supportValidFor() }); },
    snapshot() {
      return {
        posture: Object.assign({}, state.posture),
        support: Object.assign({}, state.support, { validForCurrentPosture: supportValidFor() }),
        invalidations: state.invalidations,
        lastSupportInvalidation: state.lastSupportInvalidation
      };
    }
  };
}

module.exports = { createPostureSupport, POSTURES, SUPPORT_KINDS };
