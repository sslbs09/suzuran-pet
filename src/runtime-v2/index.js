/**
 * index.js — Runtime V2 Locomotion Cutover v0.1 统一入口。
 *
 * Production slice：真实接管 Stable Sit → StandUp → Move → EnterSit → Stable Sit。
 * gate：默认 ON；仅显式 env SUSSURRO_RUNTIME_V2_LOCOMOTION=0 保留兼容降级。
 */
"use strict";

const { createMotionAuthority, OWNERS } = require("./motion-authority");
const { createWindowCommit } = require("./window-commit");
const { createLocomotionController, PHASES } = require("./locomotion-controller");
const { createDragSession } = require("./drag-session");

function locomotionGateEnabled(env) {
  const e = env || (typeof process !== "undefined" ? process.env : {});
  return e.SUSSURRO_RUNTIME_V2_LOCOMOTION !== "0";
}

module.exports = {
  locomotionGateEnabled,
  createMotionAuthority,
  createWindowCommit,
  createLocomotionController,
  createDragSession,
  OWNERS,
  PHASES
};
