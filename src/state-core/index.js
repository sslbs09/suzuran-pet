/**
 * index.js — WhiteMoon State Core v0.1 统一入口。
 *
 * 四个 domain，各自只拥有自己的 canonical state：
 *   pause-authority        Attention/Pause leases（drag/chat/zoom/interaction）
 *   interaction-state      输入候选 → admitted interaction（双端：renderer 分类器）
 *   posture-support        Posture 语义 / Support 证据（严格分离）
 *   lifecycle-projection   代际 + reload/body-replacement 失效台账
 *
 * 冻结约束：MotionAuthority / WindowCommit 已冻结，State Core 只消费不重设计；
 * 不做 mega state machine / Actor / Event Sourcing / CharacterRuntime mega class。
 */
"use strict";

const { createPauseAuthority, PAUSE_SOURCES } = require("./pause-authority");
const { createInteractionState } = require("./interaction-state");
const { createPostureSupport, POSTURES, SUPPORT_KINDS } = require("./posture-support");
const { createLifecycleProjection } = require("./lifecycle-projection");

function stateCoreGateEnabled(env) {
  const e = env || (typeof process !== "undefined" ? process.env : {});
  return e.SUSSURRO_RUNTIME_V2_LOCOMOTION === "1"; // 与 Motion cutover 同 gate：OFF 时 State Core 不存在，V1 字段即 canonical
}

module.exports = {
  stateCoreGateEnabled,
  createPauseAuthority,
  createInteractionState,
  createPostureSupport,
  createLifecycleProjection,
  PAUSE_SOURCES,
  POSTURES,
  SUPPORT_KINDS
};
