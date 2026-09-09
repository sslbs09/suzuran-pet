"use strict";

// 双端文件：Node 下单测 require，渲染层 <script> 引入时挂 window.AnimationWatch。
// src 按 Node 环境 lint，故显式声明 window 全局（实际使用有 typeof 守卫）。
/* global window */

/**
 * Spine 动画轨道看门狗的纯决策：不依赖 DOM、PIXI 或 Electron。
 * 返回 restart=需要按相位目标重启，defer=当前状态不应抢占，ok=无需处理。
 */
function trackDecision({
  currentName,
  targetName,
  currentLoop,
  previousName,
  previousTime,
  currentTime,
  stallCount = 0,
  busy = false,
  sleeping = false,
  demo = false,
  mood = false,
  active = false,
  resting = false,
  seated = false,
  perched = false,
  paused = false,
  currentAnimationEnd = NaN,
  currentTrackTime = NaN,
  queuedSuccessor = false,
} = {}) {
  if (resting || seated || perched || paused || sleeping || demo || queuedSuccessor) return "defer";
  if (!currentName) return "restart";
  if (currentLoop === false) {
    const finished = Number.isFinite(currentAnimationEnd) && Number.isFinite(currentTrackTime) && currentTrackTime >= currentAnimationEnd;
    return finished && active && !mood ? "restart" : "defer";
  }
  if ((busy || mood) && !active) return "defer";
  if (targetName && currentName !== targetName) return "restart";
  const sameTrack = previousName === currentName && !!currentName;
  const noProgress = !Number.isFinite(previousTime) || !Number.isFinite(currentTime)
    ? sameTrack
    : Math.abs(currentTime - previousTime) < 0.01;
  if (noProgress && sameTrack) return stallCount >= 2 ? "restart" : "ok";
  return "ok";
}

function hwndIdentity(value, pointerBytes = 8) {
  if (value === null || value === undefined) return null;
  try {
    if (typeof value === "bigint") return value > 0n ? value : null;
    if (!Buffer.isBuffer(value)) return null;
    const width = pointerBytes === 4 ? 4 : 8;
    if (value.length < width) return null;
    let n = 0n;
    for (let i = 0; i < width; i++) n |= BigInt(value[i]) << BigInt(i * 8);
    return n > 0n ? n : null;
  } catch { return null; }
}

function trackHasProgress(previousName, previousTime, currentName, currentTime) {
  if (!currentName || currentName !== previousName) return true;
  if (!Number.isFinite(previousTime) || !Number.isFinite(currentTime)) return false;
  return currentTime - previousTime > 0.005 || currentTime < previousTime - 0.05;
}

function movementDecision({ active, resting, seated, paused, sleeping, positionChanged, stallCount = 0 } = {}) {
  if (!active || resting || seated || paused || sleeping) return "expected-stop";
  if (positionChanged) return "moving";
  return stallCount >= 3 ? "restart" : "observe";
}

if (typeof module !== "undefined" && module.exports) module.exports = { trackDecision, trackHasProgress, movementDecision, hwndIdentity };
if (typeof window !== "undefined") window.AnimationWatch = { trackDecision, trackHasProgress, movementDecision };
