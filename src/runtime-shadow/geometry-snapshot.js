/**
 * geometry-snapshot.js — Shadow Slice v0.1 Geometry Snapshot（纯函数状态机，无 I/O）。
 *
 * FREEZE PHASE 7：字段按六类区分——MEASUREMENT / CAPABILITY / CONFIGURATION·POLICY /
 * HOST OBSERVATION / DERIVED VALUE / DEPENDENCY IDENTITY。只保留 slice 真正消费的字段。
 *
 * 依赖缺口（FREEZE「Geometry dependency gap」）：V1 Spine groundGap 没有完整 geometry revision，
 * 因此观测桥必须在采样时补充只读依赖元数据（renderer shadowGeom + main 侧 host/config 补充）。
 * 铁律：
 * - 来源证明不了（meta 缺 renderGeneration/docEpoch）→ insufficient，**绝不**用「当前版本」补贴；
 * - 新 scale / viewport 已应用但相应新测量未确认 → 旧 snapshot stale，不得用于新定位判断；
 * - staleness 只由 identity 比较（docEpoch/renderGeneration/scaleGeneration/viewportGeneration/
 *   workAreaGeneration）得出，与事件到达先后无关。
 *
 * validity 输出三态：valid / stale / insufficient。
 */
"use strict";

const GEOMETRY_SNAPSHOT_FIELDS = {
  MEASUREMENT: "measurement",                 // groundGap report（含 provenance identity）
  CAPABILITY: "capability",                   // skinHasSit
  CONFIGURATION: "configuration",             // scaleRequested / seatSink / standSinkOffset / sinkTier
  HOST_OBSERVATION: "host",                   // workArea / displayScaleFactor
  DERIVED_VALUE: "derived",                   // consumedGap / expectedSeatBottomLine
  DEPENDENCY_IDENTITY: "dependency-identity"  // docEpoch/renderGeneration/scaleGeneration/viewportGeneration
};

function createGeometrySnapshotState(initial = {}) {
  return {
    // MEASUREMENT：最近一次 accepted 的 groundGap report（measurement-of-record）
    measurement: null,
    // 最近一次 rejected 报告（stale 证据观察，不覆盖好测量）
    lastRejected: null,
    // CAPABILITY
    capability: null,                        // {skinHasSit, observedAt}
    // CONFIGURATION / POLICY
    configuration: {
      scaleRequested: Number.isFinite(initial.scaleRequested) ? initial.scaleRequested : null,
      seatSink: null,
      standSinkOffset: null,
      sinkTier: null,
      geometryPolicyIdentity: initial.geometryPolicyIdentity || "groundgap-report+standSinkOffset@shadow-v0.1"
    },
    // HOST OBSERVATION
    host: {
      workArea: null,
      displayScaleFactor: null,
      workAreaGeneration: 0
    },
    // DEPENDENCY IDENTITY
    dependency: {
      docEpoch: null,                        // renderer 文档纪元（renderModeSeq at doc start）
      renderGeneration: null,                // spine 模型加载代（文档内）
      scaleGeneration: 0,                    // requested scale 换代计数（setScale 触发）
      viewportGeneration: 0                  // viewport 换代计数（renderer 上报 viewport 变化）
    }
    // DERIVED VALUE 按需计算（derivedGapFor/derivedSeatBottom），不落存储
  };
}

/** requested scale 变化（setScale）：依赖换代。旧 measurement 立即失去效力。 */
function noteScaleRequested(state, scale) {
  const s = Number(scale);
  if (!Number.isFinite(s)) return false;
  if (state.configuration.scaleRequested === s) return false; // 同值不换代
  state.configuration.scaleRequested = s;
  state.dependency.scaleGeneration += 1;
  return true;
}

/** renderer 上报 viewport 变化：依赖换代。 */
function noteViewport(state, viewport) {
  if (!viewport || !Number.isFinite(viewport.width) || !Number.isFinite(viewport.height)) return false;
  const prev = state._viewportSeen;
  const changed = !prev || prev.width !== viewport.width || prev.height !== viewport.height;
  state._viewportSeen = { width: viewport.width, height: viewport.height };
  if (!changed) return false;
  state.dependency.viewportGeneration += 1;
  return true;
}

/** renderer 文档/模型代换代（body-generation / geom-report meta）。 */
function noteDocGeneration(state, { docEpoch, renderGeneration } = {}) {
  const de = Number.isFinite(Number(docEpoch)) ? Number(docEpoch) : null;
  const rg = Number.isFinite(Number(renderGeneration)) ? Number(renderGeneration) : null;
  let changed = false;
  if (de !== null && state.dependency.docEpoch !== de) { state.dependency.docEpoch = de; changed = true; }
  if (rg !== null && state.dependency.renderGeneration !== rg) { state.dependency.renderGeneration = rg; changed = true; }
  return changed;
}

/** HOST OBSERVATION：workArea / displayScaleFactor。workArea 变化换代。 */
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
  if (Number.isFinite(Number(displayScaleFactor))) {
    const d = Number(displayScaleFactor);
    if (state.host.displayScaleFactor !== d) { state.host.displayScaleFactor = d; changed = true; }
  }
  return changed;
}

/** CONFIGURATION：坐姿下沉配置（main 侧 effectiveSeatSink/standSinkOffset/sinkTier 观测值）。 */
function noteSeatConfiguration(state, { seatSink, standSinkOffset, sinkTier } = {}) {
  const c = state.configuration;
  let changed = false;
  if (Number.isFinite(Number(seatSink)) && c.seatSink !== Number(seatSink)) { c.seatSink = Number(seatSink); changed = true; }
  if (Number.isFinite(Number(standSinkOffset)) && c.standSinkOffset !== Number(standSinkOffset)) { c.standSinkOffset = Number(standSinkOffset); changed = true; }
  if (sinkTier && c.sinkTier !== sinkTier) { c.sinkTier = sinkTier; changed = true; }
  return changed;
}

/** CAPABILITY：skinHasSit。 */
function noteCapability(state, skinHasSit, observedAt = null) {
  if (typeof skinHasSit !== "boolean") return false;
  state.capability = { skinHasSit, observedAt };
  return true;
}

/**
 * MEASUREMENT：groundGap report 采样。
 * @param {Object} args
 *  - px: renderer 原始上报值
 *  - meta: renderer reportMeta（sourceMode/renderGeneration/docEpoch[/geometryRevision]）
 *  - decision: main groundGapReportDecision 结果（accepted/value/target/reason…）
 *  - supplement: 采样时补充的只读依赖元数据（renderer shadowGeom + main host/config 补充）
 *      {scaleApplied, viewport, layoutBasis, scaleRequested, workArea, displayScaleFactor, seatSink, standSinkOffset, sinkTier}
 *
 * 规则：
 * - accepted 报告才替换 measurement-of-record；rejected 记入 lastRejected（证据），绝不覆盖好测量；
 * - 报告身份只存 provenance，**绝不**回写/回卷当前 dependency identity（身份只由 body-generation 推进，
 *   晚到旧包不得把当前纪元拖回过去——test 14 合同）；
 * - provenance 缺 renderGeneration → insufficientProvenance=true，接受也不得被「当前版本」补贴。
 */
function noteMeasurement(state, { px, meta, decision, supplement } = {}, observedAt = null) {
  const m = Number(px);
  const metaObj = meta && typeof meta === "object" ? meta : {};
  const rg = Number.isFinite(Number(metaObj.renderGeneration)) ? Number(metaObj.renderGeneration) : null;
  const de = Number.isFinite(Number(metaObj.docEpoch)) ? Number(metaObj.docEpoch) : null;
  const supp = supplement && typeof supplement === "object" ? supplement : {};
  const accepted = !!(decision && decision.accepted);
  if (!accepted) {
    state.lastRejected = {
      rawPx: Number.isFinite(m) ? m : null,
      reason: decision && (decision.reason || decision.staleReason) ? String(decision.reason || decision.staleReason) : "rejected",
      stale: !!(decision && (decision.stale || decision.staleDoc)),
      provenance: { renderGeneration: rg, docEpoch: de },
      observedAt
    };
    return null;
  }
  // 先应用同拍补充（supplement 是本次测量采样环境的一部分，不是「采样后的变化」），
  // 再快照 capturedGeneration——否则首个 workArea/viewport 会被误判为 stale。
  noteHost(state, { workArea: supp.workArea, displayScaleFactor: supp.displayScaleFactor });
  noteSeatConfiguration(state, { seatSink: supp.seatSink, standSinkOffset: supp.standSinkOffset, sinkTier: supp.sinkTier });
  state.measurement = {
    category: GEOMETRY_SNAPSHOT_FIELDS.MEASUREMENT,
    rawPx: Number.isFinite(m) ? m : null,
    accepted: true,
    value: Number.isFinite(Number(decision.value)) ? Number(decision.value) : null,
    // provenance：报告自带的身份证据；缺项保留 null，永不补齐
    provenance: { renderGeneration: rg, docEpoch: de, geometryRevision: Number.isFinite(Number(metaObj.geometryRevision)) ? Number(metaObj.geometryRevision) : null },
    insufficientProvenance: rg === null,       // renderGeneration 必须在场；docEpoch 允许缺省（0 纪元旧包）
    // 采样时补充的依赖快照（与报告同拍采集，证明依赖关系）
    supplement: {
      scaleApplied: Number.isFinite(Number(supp.scaleApplied)) ? Number(supp.scaleApplied) : null,
      viewport: supp.viewport && Number.isFinite(supp.viewport.width) ? { width: supp.viewport.width, height: supp.viewport.height } : null,
      layoutBasis: supp.layoutBasis || null,
      scaleRequested: Number.isFinite(Number(supp.scaleRequested)) ? Number(supp.scaleRequested) : null,
      workArea: supp.workArea && Number.isFinite(supp.workArea.y) ? { x: supp.workArea.x, y: supp.workArea.y, width: supp.workArea.width, height: supp.workArea.height } : null,
      displayScaleFactor: Number.isFinite(Number(supp.displayScaleFactor)) ? Number(supp.displayScaleFactor) : null,
      seatSink: Number.isFinite(Number(supp.seatSink)) ? Number(supp.seatSink) : null,
      standSinkOffset: Number.isFinite(Number(supp.standSinkOffset)) ? Number(supp.standSinkOffset) : null,
      sinkTier: supp.sinkTier || null
    },
    // 采样瞬间的依赖 generation 快照（identity 比较基准；观测记录，不是「补贴」）
    capturedGeneration: {
      scaleGeneration: state.dependency.scaleGeneration,
      viewportGeneration: state.dependency.viewportGeneration,
      workAreaGeneration: state.host.workAreaGeneration
    },
    observedAt
  };
  return state.measurement;
}

/**
 * validity（PHASE 7 输出）：valid / stale / insufficient + reason。
 * 只做 identity 比较，不看时间先后（「晚收到」本身不构成 stale）。
 * 方向性：只有「测量身份旧于当前身份」→ stale；测量身份新于当前身份（body-generation
 * 事件缺失但报告可信携带身份）不构成 stale——几何证据自证身份。
 */
function geometryValidity(state) {
  const m = state.measurement;
  if (!m) return { validity: "insufficient", reason: "no-measurement" };
  if (m.insufficientProvenance) return { validity: "insufficient", reason: "provenance-missing-renderGeneration" };
  const g = state.dependency, c = m.capturedGeneration;
  // 请求尺度换代后无新测量 → stale（test 4/5）
  if (c.scaleGeneration !== g.scaleGeneration) return { validity: "stale", reason: "scale-generation-advanced" };
  if (c.viewportGeneration !== g.viewportGeneration) return { validity: "stale", reason: "viewport-generation-advanced" };
  if (c.workAreaGeneration !== state.host.workAreaGeneration) return { validity: "stale", reason: "work-area-changed" };
  // 测量身份旧于当前依赖身份 → stale（test 6：旧 renderer generation 晚到）
  if (m.provenance.docEpoch !== null && g.docEpoch !== null && m.provenance.docEpoch < g.docEpoch) {
    return { validity: "stale", reason: "doc-epoch-older-than-current" };
  }
  if (m.provenance.renderGeneration !== null && g.renderGeneration !== null && m.provenance.renderGeneration < g.renderGeneration) {
    return { validity: "stale", reason: "render-generation-older-than-current" };
  }
  return { validity: "valid", reason: "identity-match" };
}

/**
 * DERIVED VALUE：消费进定位的 gap。**仅 valid snapshot 可派生**——
 * stale/insufficient 的旧 gap 不得用于新定位判断（FREEZE 依赖缺口铁律）。
 */
function derivedConsumedGap(state) {
  if (geometryValidity(state).validity !== "valid") return null;
  const m = state.measurement;
  return m && m.accepted && Number.isFinite(m.value) ? m.value : null;
}

/** DERIVED VALUE：坐姿预期窗口底线（walkGeo.groundLine + seatSink 同族公式，只读推演用） */
function derivedSeatBottom(state, windowHeight, seated) {
  const wa = state.host.workArea;
  const gap = derivedConsumedGap(state);
  if (!wa || !Number.isFinite(windowHeight) || gap === null) return null;
  const sink = seated && state.capability && state.capability.skinHasSit && Number.isFinite(state.configuration.seatSink)
    ? state.configuration.seatSink : 0;
  return Math.max(wa.y, wa.y + wa.height - windowHeight) + gap + (seated ? sink : 0);
}

/** 只读快照（诊断输出用，bounded 字段表） */
function geometrySnapshotView(state) {
  const v = geometryValidity(state);
  return {
    validity: v.validity,
    reason: v.reason,
    consumedGap: derivedConsumedGap(state),
    measurement: state.measurement ? {
      rawPx: state.measurement.rawPx, accepted: state.measurement.accepted,
      provenance: state.measurement.provenance, supplement: state.measurement.supplement
    } : null,
    lastRejected: state.lastRejected,
    capability: state.capability,
    configuration: state.configuration,
    host: state.host,
    dependency: state.dependency
  };
}

module.exports = {
  GEOMETRY_SNAPSHOT_FIELDS,
  createGeometrySnapshotState,
  noteScaleRequested,
  noteViewport,
  noteDocGeneration,
  noteHost,
  noteSeatConfiguration,
  noteCapability,
  noteMeasurement,
  geometryValidity,
  derivedConsumedGap,
  derivedSeatBottom,
  geometrySnapshotView
};
