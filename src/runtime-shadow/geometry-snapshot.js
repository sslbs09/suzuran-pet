/**
 * geometry-snapshot.js — Shadow Slice v0.1 Geometry Snapshot（纯函数状态机，无 I/O）。
 *
 * FREEZE PHASE 7 + Blocker Closure 修订（SAMPLE-TIME PROVENANCE）：
 * measurement 的身份一律来自 renderer 采样时自带的 provenance（meta + shadowGeom）：
 *   { docEpoch, renderGeneration, scaleApplied, viewport, layoutBasis, seq, scaleEpoch, sampledAt }
 * main 接收时只能：验证 / 接受 / 拒绝 / 补充「receive-time host observation」（显式分字段，
 * 绝不伪装成 renderer provenance，也不给旧 measurement 贴当前身份让它变 fresh）。
 *
 * 铁律：
 * - 缺失 generation 保持 missing（null）→ insufficient；Number(null)===0 陷阱已封
 *   （所有身份解析先判 null/undefined，绝不让缺失转 0）；
 * - 迟到旧报告（同 epoch+generation 内 seq 倒退，或 scaleEpoch 落后）→ 拒绝替换 good measurement，
 *   记入 lastRejected；
 * - staleness 只由 identity 比较得出，与到达先后无关；晚收到本身不构成 stale；
 * - requested scale 换代（main setScale，receive 后）→ captured.receiveGeneration 失配 → stale；
 * - scaleApplied 与 scaleEpoch 关联 identity，不按数值相同认定同一次变化；
 * - derivedConsumedGap 只有真实 valid snapshot 可产生。
 */
"use strict";

function createGeometrySnapshotState(initial = {}) {
  return {
    // MEASUREMENT：最近一份 accepted 的 groundGap report（measurement-of-record）
    measurement: null,
    // 最近一次 rejected/late 报告（证据，绝不覆盖好测量）
    lastRejected: null,
    // CAPABILITY
    capability: null,                        // {skinHasSit, receivedAt}
    // CONFIGURATION / POLICY（receive-time host 观测，仅诊断）
    configuration: {
      scaleRequested: Number.isFinite(initial.scaleRequested) ? initial.scaleRequested : null,
      seatSink: null,
      standSinkOffset: null,
      sinkTier: null,
      geometryPolicyIdentity: initial.geometryPolicyIdentity || "sample-time-provenance@shadow-v0.1"
    },
    // HOST OBSERVATION（receive-time）
    host: {
      workArea: null,
      displayScaleFactor: null,
      workAreaGeneration: 0
    },
    // DEPENDENCY IDENTITY（当前依赖身份；只由真实 owner commit / main setScale 推进，绝不回卷）
    dependency: {
      docEpoch: null,
      renderGeneration: null,
      scaleGeneration: 0        // main setScale 换代计数
    },
    // renderer 采样身份单调性观测（来自 accepted 报告的 provenance）
    _maxScaleEpochSeen: null,   // 已见最大 renderer scale epoch
    _lastAcceptedSeq: null      // 同 epoch+generation 内最近 accepted 报告 seq（迟到检测）
  };
}

/* ---------- 身份解析：缺失永远保持 missing（null），绝不让 Number(null)===0 蒙混 ---------- */

function parseId(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/**
 * renderer 文档/模型代推进（body-generation = 真实 owner commit；单调，禁止回卷）。
 * 返回 {changed, rolledBackAttempt}：旧代晚到 → 不更新身份，rolledBackAttempt=true。
 */
function noteDocGeneration(state, { docEpoch, renderGeneration } = {}) {
  const de = parseId(docEpoch);
  const rg = parseId(renderGeneration);
  if (de === null && rg === null) return { changed: false, rolledBackAttempt: false };
  const cur = state.dependency;
  // 旧代晚到：docEpoch 更小，或同 epoch 内 renderGeneration 更小 → 拒绝（identity 不回滚）
  if (de !== null && cur.docEpoch !== null && de < cur.docEpoch) return { changed: false, rolledBackAttempt: true };
  if (de !== null && cur.docEpoch !== null && de === cur.docEpoch &&
      rg !== null && cur.renderGeneration !== null && rg < cur.renderGeneration) {
    return { changed: false, rolledBackAttempt: true };
  }
  let changed = false;
  if (de !== null && cur.docEpoch !== de) { cur.docEpoch = de; changed = true; }
  if (rg !== null && cur.renderGeneration !== rg) { cur.renderGeneration = rg; changed = true; }
  return { changed, rolledBackAttempt: false };
}

/** requested scale 变化（main setScale，main 权威）：依赖换代。 */
function noteScaleRequested(state, scale) {
  const s = Number(scale);
  if (!Number.isFinite(s)) return false;
  if (state.configuration.scaleRequested === s) return false;
  state.configuration.scaleRequested = s;
  state.dependency.scaleGeneration += 1;
  return true;
}

/** HOST OBSERVATION（receive-time）：workArea / displayScaleFactor。workArea 变化换代。 */
function noteHost(state, { workArea, displayScaleFactor } = {}) {
  let changed = false;
  if (workArea && typeof workArea === "object" && Number.isFinite(workArea.y)) {
    const prev = state.host.workArea;
    if (!prev || prev.x !== workArea.x || prev.y !== workArea.y ||
        prev.width !== workArea.width || prev.height !== workArea.height) {
      state.host.workArea = { x: workArea.x, y: workArea.y, width: workArea.width, height: workArea.height };
      state.host.workAreaGeneration += 1;
      changed = true;
    }
  }
  if (Number.isFinite(Number(displayScaleFactor)) && displayScaleFactor !== null) {
    const d = Number(displayScaleFactor);
    if (state.host.displayScaleFactor !== d) { state.host.displayScaleFactor = d; changed = true; }
  }
  return changed;
}

/** CONFIGURATION：坐姿下沉配置（receive-time host 观测，诊断用）。 */
function noteSeatConfiguration(state, { seatSink, standSinkOffset, sinkTier } = {}) {
  const c = state.configuration;
  let changed = false;
  if (Number.isFinite(Number(seatSink)) && seatSink !== null && c.seatSink !== Number(seatSink)) { c.seatSink = Number(seatSink); changed = true; }
  if (Number.isFinite(Number(standSinkOffset)) && standSinkOffset !== null && c.standSinkOffset !== Number(standSinkOffset)) { c.standSinkOffset = Number(standSinkOffset); changed = true; }
  if (sinkTier && c.sinkTier !== sinkTier) { c.sinkTier = sinkTier; changed = true; }
  return changed;
}

/** CAPABILITY：skinHasSit。 */
function noteCapability(state, skinHasSit, receivedAt = null) {
  if (typeof skinHasSit !== "boolean") return false;
  state.capability = { skinHasSit, receivedAt };
  return true;
}

/**
 * MEASUREMENT 采样入库。
 * @param args.px        renderer 原始上报值
 * @param args.meta      renderer reportMeta（sourceMode/renderGeneration/docEpoch）——采样时身份
 * @param args.decision  main groundGapReportDecision 结果
 * @param args.shadowGeom  renderer 采样时补充 {scaleApplied, viewport, layoutBasis, seq, scaleEpoch, sampledAt}
 * @param args.hostAtReceive main 接收时独立 host 观测 {scaleRequested, workArea, displayScaleFactor,
 *                            seatSink, standSinkOffset, sinkTier}——显式 receive-time，绝不混入 provenance
 *
 * intake 顺序：先做迟到/旧代拒绝检查（对当前 record），再替换 + 更新单调观测。
 */
function noteMeasurement(state, { px, meta, decision, shadowGeom, hostAtReceive } = {}, receivedAt = null) {
  const m = Number(px);
  const metaObj = meta && typeof meta === "object" ? meta : {};
  const geom = shadowGeom && typeof shadowGeom === "object" ? shadowGeom : {};
  const host = hostAtReceive && typeof hostAtReceive === "object" ? hostAtReceive : {};
  const accepted = !!(decision && decision.accepted);
  const prov = {
    // 采样时身份（renderer 自带；缺失保持 null——绝不补贴）
    renderGeneration: parseId(metaObj.renderGeneration),
    docEpoch: parseId(metaObj.docEpoch),
    geometryRevision: parseId(metaObj.geometryRevision),
    scaleApplied: geom.scaleApplied !== null && geom.scaleApplied !== undefined && typeof geom.scaleApplied === "number" && Number.isFinite(geom.scaleApplied) ? geom.scaleApplied : null,
    viewport: geom.viewport && Number.isFinite(geom.viewport.width) && Number.isFinite(geom.viewport.height)
      ? { width: geom.viewport.width, height: geom.viewport.height } : null,
    layoutBasis: typeof geom.layoutBasis === "string" ? geom.layoutBasis : null,
    seq: parseId(geom.seq),
    scaleEpoch: parseId(geom.scaleEpoch),
    sampledAt: geom.sampledAt && typeof geom.sampledAt === "object" ? geom.sampledAt : null
  };
  if (!accepted) {
    state.lastRejected = {
      rawPx: Number.isFinite(m) ? m : null,
      reason: decision && (decision.reason || decision.staleReason) ? String(decision.reason || decision.staleReason) : "rejected",
      stale: !!(decision && (decision.stale || decision.staleDoc)),
      provenance: { renderGeneration: prov.renderGeneration, docEpoch: prov.docEpoch },
      receivedAt
    };
    return null;
  }
  // —— 迟到 / 旧代拒绝（对当前依赖身份 + 当前 good record 比较；绝不回滚）——
  const dep = state.dependency;
  if (prov.docEpoch !== null && dep.docEpoch !== null && prov.docEpoch < dep.docEpoch) {
    state.lastRejected = { rawPx: Number.isFinite(m) ? m : null, reason: "stale-doc-epoch", stale: true, provenance: { renderGeneration: prov.renderGeneration, docEpoch: prov.docEpoch }, receivedAt };
    return null;
  }
  if (prov.docEpoch !== null && dep.docEpoch !== null && prov.docEpoch === dep.docEpoch &&
      prov.renderGeneration !== null && dep.renderGeneration !== null && prov.renderGeneration < dep.renderGeneration) {
    state.lastRejected = { rawPx: Number.isFinite(m) ? m : null, reason: "stale-render-generation", stale: true, provenance: { renderGeneration: prov.renderGeneration, docEpoch: prov.docEpoch }, receivedAt };
    return null;
  }
  const cur = state.measurement;
  if (cur) {
    const cp = cur.provenance;
    if (prov.docEpoch !== null && cp.docEpoch !== null && prov.docEpoch < cp.docEpoch) {
      state.lastRejected = { rawPx: Number.isFinite(m) ? m : null, reason: "stale-doc-epoch", stale: true, provenance: { renderGeneration: prov.renderGeneration, docEpoch: prov.docEpoch }, receivedAt };
      return null;
    }
    if (prov.docEpoch !== null && cp.docEpoch !== null && prov.docEpoch === cp.docEpoch &&
        prov.renderGeneration !== null && cp.renderGeneration !== null && prov.renderGeneration < cp.renderGeneration) {
      state.lastRejected = { rawPx: Number.isFinite(m) ? m : null, reason: "stale-render-generation", stale: true, provenance: { renderGeneration: prov.renderGeneration, docEpoch: prov.docEpoch }, receivedAt };
      return null;
    }
    if (prov.docEpoch !== null && cp.docEpoch !== null && prov.docEpoch === cp.docEpoch &&
        prov.renderGeneration !== null && cp.renderGeneration !== null && prov.renderGeneration === cp.renderGeneration &&
        prov.seq !== null && state._lastAcceptedSeq !== null && prov.seq < state._lastAcceptedSeq) {
      // 同代内 seq 倒退 = 采样更早的旧报告晚到 → 拒绝替换（反例 A）
      state.lastRejected = { rawPx: Number.isFinite(m) ? m : null, reason: "late-report-seq", stale: true, provenance: { renderGeneration: prov.renderGeneration, docEpoch: prov.docEpoch }, receivedAt };
      return null;
    }
  }
  // 先落 receive-time host 观测（显式独立字段），再快照 receiveGeneration（staleness 基准）
  // 注意：scaleRequested 不从此处回写 configuration——requested scale 的唯一权威是 main setScale
  // （noteScaleRequested）；报告可能采样于 scale 变化之前，用它回写会造成状态回卷。
  noteHost(state, { workArea: host.workArea, displayScaleFactor: host.displayScaleFactor });
  noteSeatConfiguration(state, { seatSink: host.seatSink, standSinkOffset: host.standSinkOffset, sinkTier: host.sinkTier });
  state.measurement = {
    rawPx: Number.isFinite(m) ? m : null,
    accepted: true,
    value: Number.isFinite(Number(decision.value)) ? Number(decision.value) : null,
    provenance: prov, // 采样时身份（renderer 自带）
    // receive-time host observation 快照（显式不是 provenance；staleness 用）
    hostAtReceive: {
      scaleRequested: Number.isFinite(Number(host.scaleRequested)) && host.scaleRequested !== null ? Number(host.scaleRequested) : null,
      workArea: host.workArea && Number.isFinite(host.workArea.y) ? { x: host.workArea.x, y: host.workArea.y, width: host.workArea.width, height: host.workArea.height } : null,
      displayScaleFactor: Number.isFinite(Number(host.displayScaleFactor)) && host.displayScaleFactor !== null ? Number(host.displayScaleFactor) : null,
      seatSink: Number.isFinite(Number(host.seatSink)) && host.seatSink !== null ? Number(host.seatSink) : null,
      standSinkOffset: Number.isFinite(Number(host.standSinkOffset)) && host.standSinkOffset !== null ? Number(host.standSinkOffset) : null,
      sinkTier: host.sinkTier || null
    },
    capturedReceiveGeneration: {
      scaleGeneration: state.dependency.scaleGeneration,   // main setScale 计数（receive 时）
      workAreaGeneration: state.host.workAreaGeneration
    },
    receivedAt
  };
  // 单调观测更新（在 accepted 入库后）
  if (prov.scaleEpoch !== null) {
    state._maxScaleEpochSeen = state._maxScaleEpochSeen === null ? prov.scaleEpoch : Math.max(state._maxScaleEpochSeen, prov.scaleEpoch);
  }
  if (prov.seq !== null) state._lastAcceptedSeq = prov.seq;
  return state.measurement;
}

/**
 * validity：valid / stale / insufficient + reason。只做 identity 比较，不看时间先后。
 */
function geometryValidity(state) {
  const m = state.measurement;
  if (!m) return { validity: "insufficient", reason: "no-measurement" };
  if (m.provenance.renderGeneration === null) return { validity: "insufficient", reason: "provenance-missing-renderGeneration" };
  const g = state.dependency, c = m.capturedReceiveGeneration, p = m.provenance;
  // renderer 采样身份落后于当前依赖身份 → stale（旧代证据）
  if (p.docEpoch !== null && g.docEpoch !== null && p.docEpoch < g.docEpoch) return { validity: "stale", reason: "doc-epoch-older-than-current" };
  if (p.renderGeneration !== null && g.renderGeneration !== null && p.renderGeneration < g.renderGeneration) return { validity: "stale", reason: "render-generation-older-than-current" };
  // renderer scale identity：采样 epoch 落后于已见最大 → stale（不按数值认同一）
  if (p.scaleEpoch !== null && state._maxScaleEpochSeen !== null && p.scaleEpoch < state._maxScaleEpochSeen) return { validity: "stale", reason: "scale-epoch-older-than-observed" };
  // main receive 后依赖换代（setScale / workArea 变化）→ stale
  if (c.scaleGeneration !== g.scaleGeneration) return { validity: "stale", reason: "scale-generation-advanced-after-receive" };
  if (c.workAreaGeneration !== state.host.workAreaGeneration) return { validity: "stale", reason: "work-area-changed-after-receive" };
  return { validity: "valid", reason: "identity-match" };
}

/** DERIVED VALUE：消费进定位的 gap。仅 valid snapshot 可派生（stale/insufficient 不可消费）。 */
function derivedConsumedGap(state) {
  if (geometryValidity(state).validity !== "valid") return null;
  const m = state.measurement;
  return m && m.accepted && Number.isFinite(m.value) ? m.value : null;
}

/** 只读视图（诊断输出用，bounded 字段表） */
function geometrySnapshotView(state) {
  const v = geometryValidity(state);
  return {
    validity: v.validity,
    reason: v.reason,
    consumedGap: derivedConsumedGap(state),
    measurement: state.measurement ? {
      rawPx: state.measurement.rawPx, value: state.measurement.value,
      provenance: state.measurement.provenance, hostAtReceive: state.measurement.hostAtReceive
    } : null,
    lastRejected: state.lastRejected,
    capability: state.capability,
    configuration: state.configuration,
    host: state.host,
    dependency: state.dependency
  };
}

module.exports = {
  createGeometrySnapshotState,
  noteScaleRequested,
  noteDocGeneration,
  noteHost,
  noteSeatConfiguration,
  noteCapability,
  noteMeasurement,
  geometryValidity,
  derivedConsumedGap,
  geometrySnapshotView
};
