"use strict";

/* walk-state.js — 行走几何决策纯函数（v2.5.26 收敛，①）
 * 把原先散落在 main.js walkTick 里的「翻边滞回」「垂直钳位」判定抽成纯函数，
 * 浏览器/Node 共用、可单测；main.js 只保留副作用（setPosition/setEdgeLeft/日志）。
 * 行为与收敛前逐条等价（阈值默认值与旧硬编码一致）。
 */

/** 左缘翻边滞回决策。返回 {flip, at} 或 null（不翻）。
 *  edgeLeft: 当前是否左缘模式；charLeft: 角色条带左缘屏幕 x；edgeL: 边界左缘 x；
 *  now/lastFlipAt: 防抖时钟；backThreshold/toThreshold/debounceMs: 滞回参数。 */
function edgeFlipDecision({ edgeLeft, charLeft, edgeL, now, lastFlipAt = 0, backThreshold = 140, toThreshold = 2, debounceMs = 800 }) {
  if (now - lastFlipAt < debounceMs) return null;
  if (edgeLeft) {
    if (charLeft > edgeL + backThreshold) return { flip: false, at: now };
    return null;
  }
  if (charLeft <= edgeL + toThreshold) return { flip: true, at: now };
  return null;
}

/** 垂直钳位决策。返回 {type:'down'|'up'} 或 null。
 *  down: 掉太低（拖出/掉出屏幕）→ 钳回地面；up: 非瞬态悬太高 → 拉回地面。 */
function verticalClampDecision({ y, groundY, seated, resting, transient, downTol = 120, upTol = 140 }) {
  if (y > groundY + downTol) return { type: "down" };
  if (!transient && (resting || seated) && y < groundY - upTol) return { type: "up" };
  return null;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { edgeFlipDecision, verticalClampDecision };
}
