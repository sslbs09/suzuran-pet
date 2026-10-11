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

function uiEdgeCompactFromBounds({ windowX, workAreaLeft = 0, compact = false, margin = 2 } = {}) {
  const x = Number(windowX), left = Number(workAreaLeft), m = Math.max(0, Number(margin) || 0);
  if (!Number.isFinite(x) || !Number.isFinite(left)) return !!compact;
  return compact ? x < left + m : x < left - m;
}

/** 垂直钳位决策。返回 {type:'down'|'up'} 或 null。
 *  down: 掉太低（拖出/掉出屏幕）→ 钳回地面；up: 非瞬态悬太高 → 拉回地面。 */
function verticalClampDecision({ y, groundY, seated, resting, transient, downTol = 120, upTol = 140 }) {
  if (y > groundY + downTol) return { type: "down" };
  if (!transient && (resting || seated) && y < groundY - upTol) return { type: "up" };
  return null;
}

/** 坐姿窗口尺寸变化重锚决策（TD-1 悬空坐）。返回 true = 应立即 applySeatPosition 重锚窗口底。
 *  气泡开/关（pet:set-size）改变窗口高度时窗口顶不动、底边随动，坐姿脚底随之偏离任务栏沿口，
 *  且放大暂停（zoomPaused）期间 5s 自愈不跑——必须随尺寸变化即时重锚。
 *  仅坐姿生效：站姿/自由放置归相位机管，拖拽/飞行/跳跃/跳窗顶不能拽，避免把窗口拉离用户摆放位置。 */
function seatReanchorOnResizeDecision({ seated, perched, dragPaused, flight, jump }) {
  return !!seated && !perched && !dragPaused && !flight && !jump;
}

/** BUG-06：chat panel（气泡/输入栏）侧别决策（纯函数）。
 *  panel 附着在角色条带旁：屏幕左/右缘必须换边，否则被屏缘裁切（“chat panel 出现在错误一侧”）。
 *  charLeft/charRight: 角色条带屏幕左右缘；workArea: 窗口所在显示器的 workArea（multi-monitor
 *  由调用方用 getDisplayMatching 解析）；panelWidth: 面板真实宽度（渲染层上报）。
 *  规则（冻结）：常规侧（panel 在角色左侧=产品默认布局）放得下 → left；否则右牵挂得下 → right；
 *  两侧都放不下 → 取空间更大的一侧（调用方按 roomPx clamp 面板宽，compact CSS 即收窄布局）。
 *  返回 { side, roomPx, clamped }。 */
function chatPanelSideDecision({ charLeft, charRight, workArea, panelWidth, gap = 6 }) {
  const wa = workArea && Number.isFinite(workArea.x) ? workArea : { x: 0, width: 0 };
  const pw = Math.max(0, Number(panelWidth) || 0);
  const g = Math.max(0, Number(gap) || 0);
  const left = Number.isFinite(charLeft) ? charLeft : wa.x;
  const right = Number.isFinite(charRight) ? charRight : left;
  const leftRoom = left - g - wa.x;
  const rightRoom = (wa.x + (Number.isFinite(wa.width) ? wa.width : 0)) - (right + g);
  if (leftRoom >= pw) return { side: "left", roomPx: leftRoom, clamped: false };
  if (rightRoom >= pw) return { side: "right", roomPx: rightRoom, clamped: false };
  const side = rightRoom >= leftRoom ? "right" : "left";
  return { side, roomPx: Math.max(0, side === "right" ? rightRoom : leftRoom), clamped: true };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { edgeFlipDecision, uiEdgeCompactFromBounds, verticalClampDecision, seatReanchorOnResizeDecision, chatPanelSideDecision };
}
