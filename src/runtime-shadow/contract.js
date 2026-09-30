/**
 * contract.js — Runtime V2 Shadow Slice v0.1 事件信封、run context、renderer 证据信任边界。
 *
 * FREEZE PHASE 3 + Blocker Closure 修订：
 * - sourceSeq 由产生事件的 source 分配（renderer 上行原样保留；main 侧单来源单调），
 *   绝不用 main 接收顺序冒充 sourceSeq（接收顺序单独记 receiveOrder）；
 * - sourceEpoch = renderer 文档纪元（docEpoch）；跨 epoch 不做 seq 比较；
 * - sampledAt：产生方采样时刻 + 明确 clock domain；receivedAt：main 接收时刻。
 *   不同 clock domain 禁止直接做 duration subtraction；
 * - causeRef 只有能证明具体因果关系时才设置；v0.1 无可证明因果链 → 恒 null（宁缺毋假）；
 * - renderer 证据上行有信任边界：sender 校验在 main IPC handler，payload 校验在此处
 *   （白名单 kind + 每 kind 最小 shape + 有界 size + 原型检查 + 不因诊断 payload throw）。
 */
"use strict";

const SHADOW_CONTRACT_VERSION = "shadow-v0.1";

/** 事件来源白名单：main=主进程生产路径旁路；renderer=渲染层 body 证据上行 */
const SHADOW_SOURCES = ["main", "renderer"];

/**
 * 事件 kind 白名单（v0.1 slice 只覆盖 Sit→StandUp→Move→EnterSit 所需输入）。
 * main 来源：V1 control facts / 实际效果（区分 request 与 effect）/ 几何接受点 / host 观测 / 边界。
 * renderer 来源：body 证据 / fit handoff / 边界。
 */
const SHADOW_KINDS = [
  // V1 control facts（main；INTENT/REQUEST 级）
  "phase-end",            // walkOnPhaseEnd 入口快照（只读字段表，不复制 walk 对象）
  "behavior-selected",    // chooseWalkBehavior 结果（Shadow 绝不重抽随机数）
  "stand-up-arm",         // stand-beat 入口（armSeatExit("move","phase") + standingUpUntil）——INTENT
  "beat-end",             // walkTick 消费 stand-beat 拍（standingUpUntil=0, resting=false）
  "enter-rest-pose",      // enterRestPose()：ENTER_SIT 触发
  "broadcast",            // walkBroadcast payload 快照
  // 实际效果（main；ATTEMPT/WRITE_SUCCEEDED/WRITE_FAILED/HOST_OBSERVED 由 outcome 字段区分）
  "rect-write",           // walkSetPosition（统一收敛写入口；outcome + hostRectAfter）
  "seat-position",        // applySeatPosition（坐姿锚定；outcome 区分 skipped/succeeded/failed）
  "seat-exit",            // arm/cancel=INTENT；step=写尝试（outcome 区分）
  // 几何（main）
  "geom-report",          // pet:set-ground-gap 决策结果 + 采样时 provenance + 接收时 host 观测
  "geom-scale-changed",   // setScale：requested scale 变化（依赖换代）
  "geom-host-changed",    // display metrics / workArea 变化（receive-time host observation）
  // body 能力（main）
  "body-capability",      // pet:set-has-sit
  // 引擎边界（main）
  "engine",               // startWalkingEngine / stopWalkingEngine
  "takeover",             // drag/chat/zoom/sleep 接管意图
  // 渲染层 body 证据（renderer）
  "anim-entry",           // spine state.setAnimation 已建立 track entry——是"请求且轨道入口被接受"，
                          // 不是姿态已应用（pose/fit 证据 v0.1 无法证明，不造 applied）
  "body-generation",      // spine 模型 commit：文档/代际身份 + applied scale + viewport（真实 owner 提交边界）
  "fit-handoff",          // hold-seat / release-refit / autoscale（local Y / fit 交接观察）
  "boundary-takeover",    // headpat 等渲染层动画接管
  "boundary-replacement"  // spine rebuild / render-mode 切换
];

/** renderer 证据允许的 kind 子集 */
const RENDERER_EVIDENCE_KINDS = ["anim-entry", "body-generation", "fit-handoff", "boundary-takeover", "boundary-replacement"];

/** renderer 证据 payload 每 kind 白名单键 + 类型（最小 shape validation；未知键丢弃） */
const RENDERER_PAYLOAD_KEYS = {
  "anim-entry": { requested: "string", loop: "bool", reason: "string", track: "int", mixDuration: "num|null", renderGeneration: "int|null", appliedScale: "num|null" },
  "body-generation": { renderGeneration: "int|null", skinId: "string", baseScale: "num|null" },
  "fit-handoff": { kind: "string" },
  "boundary-takeover": { kind: "string" },
  "boundary-replacement": { kind: "string" }
};

const RENDERER_EVIDENCE_MAX_PAYLOAD_CHARS = 4096;

const FIELD_INVALID = Symbol("invalid");

function isPlainObject(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function coerceField(type, v) {
  switch (type) {
    case "string": return typeof v === "string" ? v.slice(0, 200) : FIELD_INVALID;
    case "bool": return typeof v === "boolean" ? v : FIELD_INVALID;
    case "int": return Number.isSafeInteger(v) ? v : FIELD_INVALID;
    case "int|null": return v === null || v === undefined ? null : (Number.isSafeInteger(v) ? v : FIELD_INVALID);
    case "num|null": return v === null || v === undefined ? null : (typeof v === "number" && Number.isFinite(v) ? v : FIELD_INVALID);
    default: return FIELD_INVALID;
  }
}

/**
 * renderer 证据上行信任边界（main 收到 pet:shadow-evidence 后、进任何处理链之前调用）。
 * 绝不 throw；拒绝时返回 {ok:false, reason}。
 * 防御：非对象 / 异型原型（class 实例、Proxy 等按原型拒绝）/ 非白名单 kind / 非法 seq / epoch /
 * 恶意字段（如 { toString: null } 这类对象——键白名单直接丢弃非原始值）/ 超大 payload。
 */
function sanitizeRendererEvidence(raw, { maxPayloadChars = RENDERER_EVIDENCE_MAX_PAYLOAD_CHARS } = {}) {
  try {
    if (!isPlainObject(raw)) return { ok: false, reason: "not-plain-object" };
    if (!RENDERER_EVIDENCE_KINDS.includes(raw.kind)) return { ok: false, reason: "kind-not-allowed" };
    if (!Number.isSafeInteger(raw.seq) || raw.seq < 1) return { ok: false, reason: "bad-source-seq" };
    let docEpoch = null;
    if (raw.docEpoch !== null && raw.docEpoch !== undefined) {
      if (!Number.isSafeInteger(raw.docEpoch) || raw.docEpoch < 0) return { ok: false, reason: "bad-source-epoch" };
      docEpoch = raw.docEpoch;
    }
    // causeRef：v0.1 无可证明因果 → 恒 null（即便 raw 里带了也不采信——宁缺毋假）
    // sampledAt：renderer 采样时刻（clock domain 显式）；缺失保持 null，不伪造
    let sampledAt = null;
    if (raw.sampledAt !== null && raw.sampledAt !== undefined) {
      if (!isPlainObject(raw.sampledAt)) return { ok: false, reason: "bad-sampled-at" };
      const v = raw.sampledAt.value;
      if (v !== null && v !== undefined && (typeof v !== "number" || !Number.isFinite(v))) {
        return { ok: false, reason: "bad-sampled-at-value" };
      }
      if (typeof raw.sampledAt.clock !== "string" || !raw.sampledAt.clock) return { ok: false, reason: "bad-sampled-at-clock" };
      sampledAt = { clock: raw.sampledAt.clock.slice(0, 40), value: v === undefined ? null : v };
    }
    let payload = {};
    if (raw.payload !== null && raw.payload !== undefined) {
      if (!isPlainObject(raw.payload)) return { ok: false, reason: "payload-not-plain-object" };
      const serialized = JSON.stringify(raw.payload); // toJSON/getter 抛错 → 拒收（不进处理链）
      if (typeof serialized !== "string") return { ok: false, reason: "payload-not-serializable" };
      if (serialized.length > maxPayloadChars) return { ok: false, reason: "payload-too-large" };
      const keys = RENDERER_PAYLOAD_KEYS[raw.kind] || {};
      for (const [k, type] of Object.entries(keys)) {
        if (Object.prototype.hasOwnProperty.call(raw.payload, k)) {
          const c = coerceField(type, raw.payload[k]);
          if (c === FIELD_INVALID) return { ok: false, reason: "bad-field:" + k }; // 类型不符（含奇异对象）→ 整条拒收
          payload[k] = c;
        }
      }
    }
    return { ok: true, ev: { seq: raw.seq, kind: raw.kind, payload, docEpoch, sampledAt } };
  } catch {
    return { ok: false, reason: "sanitize-failed" }; // 任何意外（getter 抛错等）→ 拒收，绝不影响 main
  }
}

/**
 * 归一化一条事件为信封。返回 null 表示拒绝（来源/kind 不在白名单）。
 * seq 由 session 落（renderer 事件透传生产者 seq；main 事件单来源单调）；
 * sampledAt 由调用方给（main 事件=接收时刻同钟）；receivedAt 由 session 注入。
 */
function normalizeShadowEvent({ source, kind, payload, causeRef = null, sourceEpoch = null, sampledAt = null }) {
  if (!SHADOW_SOURCES.includes(source)) return null;
  if (!SHADOW_KINDS.includes(kind)) return null;
  return {
    source,
    sourceEpoch: sourceEpoch === undefined ? null : sourceEpoch,
    sourceSeq: null,      // session 按来源落：renderer=生产者 seq 原样；main=单来源单调
    sampledAt: sampledAt && typeof sampledAt === "object" ? sampledAt : null, // {clock, value}
    receivedAt: null,     // session 注入 {monoMs|null, dateNow}
    receiveOrder: null,   // main 接收顺序（单独记录，绝不冒充 sourceSeq）
    kind,
    payload: payload && typeof payload === "object" ? payload : {},
    // v0.1：无可证明「具体 command → 事件」因果链 → 恒 null（即使调用方带了也不采信——宁缺毋假）
    causeRef: null
  };
}

/**
 * 一次 run 的固定 context（PHASE 3）。全部字段是身份/策略声明，不是运行态。
 */
function createShadowRunContext({
  runId,
  gitBaseline = "unknown",
  timePolicy = "sampledAt(producer)+receivedAt(main:hrtime-monoMs|null+dateNow); cross-clock subtraction forbidden",
  geometryPolicy = "sample-time-provenance@shadow-v0.1",
  coordinateConvention = "electron-bounds-dip, screen-workarea-dip",
  taskbarSupportScope = "workArea-bottom-edge seat sink; perch/icon-grid out-of-scope"
} = {}) {
  return {
    contractVersion: SHADOW_CONTRACT_VERSION,
    runId: String(runId || ("run-" + Date.now().toString(36))),
    gitBaseline: String(gitBaseline || "unknown"),
    timePolicy,
    geometryPolicy,
    coordinateConvention,
    taskbarSupportScope
  };
}

/** 相位语义常量（PHASE 6；不引入 enum，仅固定字符串语义） */
const SHADOW_PHASES = {
  STABLE_SIT: "stable-sit",
  STAND_UP: "stand-up",
  MOVE: "move",
  ENTER_SIT: "enter-sit"
};

module.exports = {
  SHADOW_CONTRACT_VERSION,
  SHADOW_SOURCES,
  SHADOW_KINDS,
  SHADOW_PHASES,
  RENDERER_EVIDENCE_KINDS,
  RENDERER_PAYLOAD_KEYS,
  RENDERER_EVIDENCE_MAX_PAYLOAD_CHARS,
  normalizeShadowEvent,
  createShadowRunContext,
  sanitizeRendererEvidence,
  isPlainObject
};
