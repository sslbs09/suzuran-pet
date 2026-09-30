/**
 * index.js — Runtime V2 Locomotion Cutover v0.1 统一入口。
 *
 * Production slice：真实接管 Stable Sit → StandUp → Move → EnterSit → Stable Sit。
 * gate：env SUSSURRO_RUNTIME_V2_LOCOMOTION=1（默认 OFF=完全走 V1，零 V2 运行时对象）。
 */
"use strict";

const { createMotionAuthority, OWNERS } = require("./motion-authority");
const { createWindowCommit } = require("./window-commit");
const { createLocomotionController, PHASES } = require("./locomotion-controller");
const { createDragSession } = require("./drag-session");

function locomotionGateEnabled(env) {
  const e = env || (typeof process !== "undefined" ? process.env : {});
  return e.SUSSURRO_RUNTIME_V2_LOCOMOTION === "1";
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
