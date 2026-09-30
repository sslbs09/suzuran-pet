/**
 * body-evidence.js — Shadow Slice v0.1 Body 证据与 readiness 观察（纯函数状态机，无 I/O）。
 *
 * FREEZE PHASE 8 + Blocker Closure 修订：
 * - 事件语义：renderer 的 state.setAnimation 只是「请求 + track entry 被接受」（anim-entry），
 *   不是姿态已应用——v0.1 无法证明 pose/fit 完成，就不造 applied；
 * - readiness 是 OBSERVATION ONLY：只输出 not-ready（显式矛盾）与 unknown（证据不足）；
 *   v0.1 没有任何可证明「pose ready」的证据级别，因此绝不输出 ready
 *   （同类动画名不足、generation match 不足、记录了 mixDuration 不等于 mix 已完成、
 *   no active token 不等于 ready、V1 已 Move 不能反推 ready）；
 * - readiness 不参与 V1 admission / Shadow action admission / Shadow closure 的控制判断
 *   （见 evaluator.decideForPhase——只允许冻结重启合同要求的 capability 已知性参与）；
 * - 身份单调：旧 body-generation 晚到不得回滚当前 identity（A→B→late A 反例）；
 *   身份按 generation/epoch，不按资源名（skinId 仅诊断信息）；
 * - replacement：真正使 capability / applied 证据 / fit 证据失效。
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
    // 当前 body 身份（body-generation 事件 = 真实 owner commit；身份推进唯一来源，单调）
    generation: null,              // {docEpoch, renderGeneration, skinId, receivedAt}
    // CAPABILITY
    capability: null,              // {skinHasSit, receivedAt}
    // 最近一次 anim entry 证据（anim-entry：请求 + track entry 被接受；非 pose applied）
    lastAnimEntry: null,           // {requested, requestedClass, loop, reason, track, mixDuration, gen, observedAt}
    // local Y / fit handoff 观察
    fitHandoff: null,              // {kind, receivedAt}
    // body 替换观察（PHASE 13 输入）
    replacedAt: null               // {from, to, receivedAt}
  };
}

/**
 * body 身份推进（renderer body-generation，真实 owner commit 边界）。
 * 返回 {replaced, stale, previous}：
 * - replaced：身份真正前进（旧 body 生命周期失效 → capability/entry/fit 全失效）；
 * - stale：旧代晚到（A→B→late A）→ 不更新身份、不清任何东西（禁止回滚）。
 */
function noteBodyGeneration(state, { docEpoch, renderGeneration, skinId } = {}, receivedAt = null) {
  const de = docEpoch === null || docEpoch === undefined ? null : (Number.isSafeInteger(Number(docEpoch)) ? Number(docEpoch) : null);
  const rg = renderGeneration === null || renderGeneration === undefined ? null : (Number.isSafeInteger(Number(renderGeneration)) ? Number(renderGeneration) : null);
  if (de === null && rg === null) return { replaced: false, stale: false, previous: null };
  const prev = state.generation;
  // 单调性：旧代晚到 → 拒绝（不得回滚当前 identity）
  if (prev) {
    if (de !== null && prev.docEpoch !== null && de < prev.docEpoch) return { replaced: false, stale: true, previous: prev };
    if (de !== null && prev.docEpoch !== null && de === prev.docEpoch &&
        rg !== null && prev.renderGeneration !== null && rg < prev.renderGeneration) {
      return { replaced: false, stale: true, previous: prev };
    }
  }
  let replaced = false;
  if (prev) {
    if (de !== null && prev.docEpoch !== null && de !== prev.docEpoch) replaced = true;
    else if (rg !== null && prev.renderGeneration !== null && rg !== prev.renderGeneration) replaced = true;
  }
  state.generation = { docEpoch: de, renderGeneration: rg, skinId: typeof skinId === "string" ? skinId : ((prev && prev.skinId) || null), receivedAt };
  if (replaced) {
    state.replacedAt = { from: prev, to: state.generation, receivedAt };
    // 替换真正失效：旧 applied entry / capability / fit 证据全部作废
    // （capability 必须等新 body 的 set-has-sit 重报；接线保证 body-generation 先于 capability 上行）
    state.lastAnimEntry = null;
    state.capability = null;
    state.fitHandoff = null;
  }
  return { replaced, stale: false, previous: prev };
}

/** CAPABILITY：skinHasSit（pet:set-has-sit）。 */
function noteCapability(state, skinHasSit, receivedAt = null) {
  if (typeof skinHasSit !== "boolean") return false;
  state.capability = { skinHasSit, receivedAt };
  return true;
}

/**
 * anim entry 证据（anim-entry：请求且 track entry 被接受）。
 * ev: {requested, loop, reason, track, mixDuration, renderGeneration, appliedScale}
 * 这不是姿态应用证据——只记录「请求了什么、entry 是否被运行时接受」。
 */
function noteAnimEntry(state, ev = {}, receivedAt = null) {
  const requested = typeof ev.requested === "string" ? ev.requested : "";
  state.lastAnimEntry = {
    requested,
    requestedClass: classifyAnimName(requested),
    loop: ev.loop === true,
    reason: typeof ev.reason === "string" ? ev.reason.slice(0, 60) : "",
    track: Number.isSafeInteger(ev.track) ? ev.track : 0,
    mixDuration: typeof ev.mixDuration === "number" && Number.isFinite(ev.mixDuration) ? ev.mixDuration : null,
    gen: {
      docEpoch: state.generation ? state.generation.docEpoch : null,
      renderGeneration: Number.isSafeInteger(ev.renderGeneration) ? ev.renderGeneration : (state.generation ? state.generation.renderGeneration : null)
    },
    observedAt: receivedAt
  };
  return state.lastAnimEntry;
}

/** fit handoff 观察（hold-seat / release-refit / autoscale）——证据记录，非 readiness 充分条件。 */
function noteFitHandoff(state, { kind } = {}, receivedAt = null) {
  if (typeof kind !== "string" || !kind) return false;
  state.fitHandoff = { kind: kind.slice(0, 40), receivedAt };
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
 * readiness 观察（PHASE 8，OBSERVATION ONLY）。
 * @param expectedClass "sit"|"move"|null —— 当前 shadow 相位期望的 body 动作类别
 * @returns {readiness:"not-ready"|"unknown", reason, evidence?}
 *   v0.1 绝不输出 "ready"：没有可证明 pose 应用/完成的证据级别。
 */
function bodyReadiness(state, expectedClass) {
  if (!state.capability) {
    return { readiness: "unknown", reason: "capability-unknown" };
  }
  if (expectedClass === "sit" && state.capability.skinHasSit === false) {
    return { readiness: "not-ready", reason: "sit-capability-absent" };
  }
  const e = state.lastAnimEntry;
  if (!e) return { readiness: "unknown", reason: "no-entry-evidence" };
  if (!sameGeneration(state, e.gen)) return { readiness: "unknown", reason: "entry-evidence-stale-generation" };
  if (!expectedClass) return { readiness: "unknown", reason: "no-expected-class" };
  if (e.requestedClass !== expectedClass) {
    return { readiness: "not-ready", reason: "entry-contradicts", evidence: { requested: e.requested, expectedClass } };
  }
  // 同类 entry + 同代也不足以 ready（mix 未完成 / pose 未验证）→ unknown
  return { readiness: "unknown", reason: "no-pose-proof-in-v0.1", evidence: { requested: e.requested } };
}

/** 只读视图（诊断输出用） */
function bodyEvidenceView(state, expectedClass) {
  const r = bodyReadiness(state, expectedClass || null);
  return {
    readiness: r.readiness,
    reason: r.reason,
    generation: state.generation,
    capability: state.capability,
    lastAnimEntry: state.lastAnimEntry ? {
      requested: state.lastAnimEntry.requested, requestedClass: state.lastAnimEntry.requestedClass,
      reason: state.lastAnimEntry.reason, track: state.lastAnimEntry.track, mixDuration: state.lastAnimEntry.mixDuration
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
  noteAnimEntry,
  noteFitHandoff,
  sameGeneration,
  bodyReadiness,
  bodyEvidenceView
};
