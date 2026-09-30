/**
 * index.js — Runtime V2 Shadow Slice v0.1 统一入口。
 *
 * 只读 Shadow：V1 继续真实执行，Shadow 只观察/只计算/只输出诊断。
 * gate：env SUSSURRO_RUNTIME_V2_SHADOW === "1" 才启用（默认 OFF = 零 session/log/行为差）。
 */
"use strict";

const { createShadowSession } = require("./session");
const { createShadowBridge } = require("./bridge");

/** Feature gate（PHASE 2）：默认 OFF；"1" 显式开启。 */
function shadowGateEnabled(env) {
  const e = env || (typeof process !== "undefined" ? process.env : {});
  return e.SUSSURRO_RUNTIME_V2_SHADOW === "1";
}

module.exports = {
  shadowGateEnabled,
  createShadowSession,
  createShadowBridge,
  contract: require("./contract"),
  geometrySnapshot: require("./geometry-snapshot"),
  bodyEvidence: require("./body-evidence"),
  motionOwnership: require("./motion-ownership"),
  evaluator: require("./evaluator"),
  rendererObserver: require("./renderer-observer")
};
