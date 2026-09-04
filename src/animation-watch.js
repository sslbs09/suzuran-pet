"use strict";

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
} = {}) {
  if (busy || sleeping || demo || mood) return "defer";
  if (!currentName) return "restart";
  if (currentLoop === false) return "defer";
  if (targetName && currentName !== targetName) return "restart";
  const sameTrack = previousName === currentName && !!currentName;
  const noProgress = !Number.isFinite(previousTime) || !Number.isFinite(currentTime)
    ? sameTrack
    : Math.abs(currentTime - previousTime) < 0.01;
  if (noProgress && sameTrack) return stallCount >= 2 ? "restart" : "ok";
  return "ok";
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

if (typeof module !== "undefined" && module.exports) module.exports = { trackDecision, trackHasProgress, movementDecision };
if (typeof window !== "undefined") window.AnimationWatch = { trackDecision, trackHasProgress, movementDecision };
