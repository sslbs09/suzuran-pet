/**
 * contract.js — Runtime V2 Shadow Slice v0.1 事件信封与 run context（纯函数，无 I/O）。
 *
 * 只读观察合同（RUNTIME V2 SHADOW SLICE v0.1 FREEZE PHASE 3）：
 * - sourceSeq 只保证单来源顺序（main / renderer 各自单调递增），不伪造跨进程全局顺序；
 * - observedAt 明确时钟域 {monoMs, dateNow}：monoMs 用于同进程差值，dateNow 用于人读/跨进程对表；
 * - causeRef 无法证明时必须保持 null，绝不猜；
 * - 不因事件「晚收到」判定 stale——stale 只由 generation/dependency identity 比较得出
 *   （见 geometry-snapshot.js / body-evidence.js）。
 */
"use strict";

const SHADOW_CONTRACT_VERSION = "shadow-v0.1";

/** 事件来源白名单：main=主进程生产路径旁路；renderer=渲染层 body 证据上行 */
const SHADOW_SOURCES = ["main", "renderer"];

/**
 * 事件 kind 白名单（v0.1 slice 只覆盖 Sit→StandUp→Move→EnterSit 所需输入）。
 * main 来源：V1 control facts / 实际效果 / 几何接受点 / host 观测 / 边界。
 * renderer 来源：body 证据 / fit handoff / 边界。
 */
const SHADOW_KINDS = [
  // V1 control facts（main）
  "phase-end",            // walkOnPhaseEnd 入口快照（只读字段表，不复制 walk 对象）
  "behavior-selected",    // chooseWalkBehavior 结果（Shadow 绝不重抽随机数）
  "stand-up-arm",         // stand-beat 入口（armSeatExit("move","phase") + standingUpUntil）
  "beat-end",             // walkTick 消费 stand-beat 拍（standingUpUntil=0, resting=false）
  "enter-rest-pose",      // enterRestPose()：ENTER_SIT 触发
  "broadcast",            // walkBroadcast payload 快照
  // 实际效果（main）
  "rect-write",           // walkSetPosition（统一收敛写入口）
  "seat-position",        // applySeatPosition（坐姿锚定写入点）
  "seat-exit",            // armSeatExit/cancelSeatExit/seatExitStep（Y 过渡机）
  // 几何（main）
  "geom-report",          // pet:set-ground-gap 决策结果 + 依赖元数据补充
  "geom-scale-changed",   // setScale：requested scale 变化（依赖换代）
  "geom-host-changed",    // display metrics / workArea 变化
  // body 能力（main）
  "body-capability",      // pet:set-has-sit
  // 引擎边界（main）
  "engine",               // startWalkingEngine / stopWalkingEngine
  "takeover",             // drag/chat/zoom/sleep 接管意图
  // 渲染层 body 证据（renderer）
  "body-generation",      // spine 模型 commit：文档/代际身份 + applied scale + viewport
  "anim-applied",         // setSpineAnim 实际 applied 的动画（track/mix/generation）
  "fit-handoff",          // hold-seat / release-refit / autoscale（local Y / fit 交接证据）
  "boundary-takeover",    // headpat 等渲染层动画接管
  "boundary-replacement"  // spine rebuild / render-mode 切换
];

/**
 * 归一化一条事件为信封。返回 null 表示拒绝（来源/kind 不在白名单）——
 * 拒绝是保守行为：未知 kind 记为 input 覆盖缺口，不进入评估器。
 * seq 由 session 分配（调用方不传 sourceSeq）；observedAt 由 session 注入时钟。
 */
function normalizeShadowEvent({ source, kind, payload, causeRef = null, sourceEpoch = null }) {
  if (!SHADOW_SOURCES.includes(source)) return null;
  if (!SHADOW_KINDS.includes(kind)) return null;
  return {
    source,
    sourceEpoch: sourceEpoch === undefined ? null : sourceEpoch, // renderer=docEpoch；main=null（单进程无文档纪元）
    sourceSeq: null,                                             // session 按来源分配单调序
    observedAt: null,                                            // session 注入 {monoMs, dateNow}（时钟域显式）
    kind,
    payload: payload && typeof payload === "object" ? payload : {},
    causeRef: causeRef && typeof causeRef === "object"
      && Number.isSafeInteger(causeRef.sourceSeq)
      && SHADOW_SOURCES.includes(causeRef.source)
      ? { source: causeRef.source, sourceSeq: causeRef.sourceSeq }
      : null                                                     // 证明不了 → null，绝不猜
  };
}

/**
 * 一次 run 的固定 context（PHASE 3）。全部字段是身份/策略声明，不是运行态。
 * bodySkinIdentity 在运行中观测（body-capability/body-generation 事件），不在这里固化。
 */
function createShadowRunContext({
  runId,
  gitBaseline = "unknown",
  timePolicy = "dateNow+hrtime-monoMs",
  geometryPolicy = "groundgap-report+standSinkOffset@shadow-v0.1",
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
  normalizeShadowEvent,
  createShadowRunContext
};
