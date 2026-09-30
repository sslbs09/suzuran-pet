/**
 * body-evidence.js — Shadow Slice v0.1 Body 证据与 readiness 观察（纯函数状态机，无 I/O）。
 *
 * FREEZE PHASE 8：OBSERVATION ONLY——
 * - readiness 只输出 ready / not-ready / unknown；
 * - 绝不因 not-ready 阻止 V1 Move，绝不因 ready 宣布 StandUp 成功；
 * - 判据只能来自：当前有效 generation、当前 attempt/transition 关联、actual applied target、
 *   mix/transition 证据、local Y / fit handoff 证据；
 * - 仅动画名字相同不够（必须携带 generation 身份 + track + 实际 applied 事件）；
 * - 「当前没有 token」也不够（无事件 ≠ 不 ready，只能 unknown）。
 */
"use strict";

/** v0.1 动画类别保守分类器（与 renderer sitAnimName/spinePhaseAnim 语义对齐，不复制实现） */
function classifyAnimName(name) {
  const n = String(name || "");
  if (!n) return null;
  if (/^(sitd|sit)$/i.test(n)) return "sit";
  if (/^move$/i.test(n)) return "move";
  if (/^(relax|idle)/i.test(n)) return "idle";
  if (/^sleep/i.test(n)) return "sleep";
  return "other";
}

function createBodyEvidenceState() {
  return {
    // 当前 body 身份（body-generation 事件；身份推进唯一来源）
    generation: null,              // {docEpoch, renderGeneration, skinId, observedAt}
    // CAPABILITY
    capability: null,              // {skinHasSit, observedAt}
    // 最近一次实际 applied 动画证据（anim-applied 事件）
    lastApplied: null,             // {requested, requestedClass, loop, reason, track, mixDuration, gen, causeRef, observedAt}
    // local Y / fit handoff 证据
    fitHandoff: null,              // {kind, detail, observedAt}
    // body 替换观察（PHASE 13 输入）
    replacedAt: null               // {from, to, observedAt}
  };
}

/**
 * body 身份推进（renderer body-generation）。
 * 返回 {replaced, previous}：docEpoch 变化或 renderGeneration 前进 → 旧 body 生命周期失效。
 */
function noteBodyGeneration(state, { docEpoch, renderGeneration, skinId } = {}, observedAt = null) {
  const de = Number.isFinite(Number(docEpoch)) ? Number(docEpoch) : null;
  const rg = Number.isFinite(Number(renderGeneration)) ? Number(renderGeneration) : null;
  if (de === null && rg === null) return { replaced: false, previous: null };
  const prev = state.generation;
  let replaced = false;
  if (prev) {
    if (de !== null && prev.docEpoch !== null && de !== prev.docEpoch) replaced = true;
    else if (rg !== null && prev.renderGeneration !== null && rg !== prev.renderGeneration) replaced = true;
  }
  state.generation = { docEpoch: de, renderGeneration: rg, skinId: skinId || (prev && prev.skinId) || null, observedAt };
  if (replaced) state.replacedAt = { from: prev, to: state.generation, observedAt };
  // 身份换代后，旧 applied 证据与旧 capability 都不能再支撑 readiness（仅名字相同不够；
  // capability 必须等新 body 的 set-has-sit 重报）
  if (replaced) {
    state.lastApplied = null;
    state.capability = null;
    state.fitHandoff = null;
  }
  return { replaced, previous: prev };
}

/** CAPABILITY：skinHasSit（pet:set-has-sit）。 */
function noteCapability(state, skinHasSit, observedAt = null) {
  if (typeof skinHasSit !== "boolean") return false;
  state.capability = { skinHasSit, observedAt };
  return true;
}

/**
 * 实际 applied 动画证据。ev: {requested, loop, reason, track, mixDuration, docEpoch, renderGeneration, causeRef}
 * 证据必须携带 generation 身份；缺失身份时仍记录但 readiness 不可用它。
 */
function noteAnimApplied(state, ev = {}, observedAt = null) {
  const requested = String(ev.requested || "");
  state.lastApplied = {
    requested,
    requestedClass: classifyAnimName(requested),
    loop: !!ev.loop,
    reason: ev.reason || "",
    track: Number.isFinite(Number(ev.track)) ? Number(ev.track) : 0,
    mixDuration: Number.isFinite(Number(ev.mixDuration)) ? Number(ev.mixDuration) : null,
    gen: {
      docEpoch: Number.isFinite(Number(ev.docEpoch)) ? Number(ev.docEpoch) : null,
      renderGeneration: Number.isFinite(Number(ev.renderGeneration)) ? Number(ev.renderGeneration) : null
    },
    causeRef: ev.causeRef || null,   // 证明不了 → null
    observedAt
  };
  return state.lastApplied;
}

/** fit handoff 证据（hold-seat / release-refit / autoscale）。 */
function noteFitHandoff(state, { kind, detail } = {}, observedAt = null) {
  if (!kind) return false;
  state.fitHandoff = { kind, detail: detail || null, observedAt };
  return true;
}

/** 当前生效 generation 与证据 gen 是否一致（同代才可用） */
function sameGeneration(state, gen) {
  const g = state.generation;
  if (!g || !gen) return false;
  if (g.docEpoch !== null && gen.docEpoch !== null && g.docEpoch !== gen.docEpoch) return false;
  if (g.renderGeneration !== null && gen.renderGeneration !== null && g.renderGeneration !== gen.renderGeneration) return false;
  return true;
}

/**
 * readiness 观察（PHASE 8）。
 * @param expectedClass "sit"|"move"|"idle"|"sleep"|null —— 当前 shadow 相位期望的 body 动作类别
 * @returns {readiness:"ready"|"not-ready"|"unknown", reason, evidence}
 */
function bodyReadiness(state, expectedClass) {
  if (!state.capability) {
    return { readiness: "unknown", reason: "capability-unknown" };
  }
  if (expectedClass === "sit" && state.capability.skinHasSit === false) {
    return { readiness: "not-ready", reason: "sit-capability-absent" };
  }
  const la = state.lastApplied;
  if (!la) return { readiness: "unknown", reason: "no-applied-evidence" };
  if (!sameGeneration(state, la.gen)) return { readiness: "unknown", reason: "applied-evidence-stale-generation" };
  if (!expectedClass) return { readiness: "unknown", reason: "no-expected-class" };
  if (la.requestedClass === expectedClass) {
    return { readiness: "ready", reason: "applied-matches", evidence: { requested: la.requested, mixDuration: la.mixDuration, causeRef: la.causeRef } };
  }
  return { readiness: "not-ready", reason: "applied-contradicts", evidence: { requested: la.requested, expectedClass } };
}

/** 只读视图（诊断输出用） */
function bodyEvidenceView(state, expectedClass) {
  const r = bodyReadiness(state, expectedClass || null);
  return {
    readiness: r.readiness,
    reason: r.reason,
    generation: state.generation,
    capability: state.capability,
    lastApplied: state.lastApplied ? {
      requested: state.lastApplied.requested, requestedClass: state.lastApplied.requestedClass,
      reason: state.lastApplied.reason, track: state.lastApplied.track, mixDuration: state.lastApplied.mixDuration,
      causeRef: state.lastApplied.causeRef
    } : null,
    fitHandoff: state.fitHandoff,
    replacedAt: state.replacedAt ? { from: state.replacedAt.from, to: state.replacedAt.to } : null
  };
}

module.exports = {
  classifyAnimName,
  createBodyEvidenceState,
  noteBodyGeneration,
  noteCapability,
  noteAnimApplied,
  noteFitHandoff,
  sameGeneration,
  bodyReadiness,
  bodyEvidenceView
};
