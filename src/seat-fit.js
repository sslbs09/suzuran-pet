"use strict";
// A-v2 双端纯函数（与 animation-watch/clickability/crash-recovery 同先例）：
// 坐姿 seat-hold 与 fit 采样的两个生命周期决策。Node 单测直接 require；渲染层 <script> 挂 window.SeatFit。
/* global window */

/**
 * 坐姿结束（切出 sit 动画）时是否需要重新锚定 fit 窗口。
 * 真机 FITDIAG 证据：boot 后 init/commit/seat-guard 重锚使 6 个 pass 全部进入 seat-hold
 * 分支——只标 pendingFit 就返回，autoScale 一次采样都没拿到；pendingFit 无人消费，
 * fit 校准永久丢失，直到第一次走路相位事件才被动重来。
 * 释放坐姿时必须兑现这个欠账：有未消费的 pendingFit ⇒ 重新布置一个完整窗口。
 */
function seatReleaseShouldRefit(ep) {
  return !!(ep && ep.pendingFit);
}

/**
 * autoScale 确立新的权威 baseline 后，同步坐姿棘轮快照（entryScale/previousScale）。
 * seatContainmentCommit 是“只降不升”的棘轮（上限 min(previousScale, entryScale)）；
 * 快照若在 autoScale 之前捕获（旧 baseline），进入 Sit 后会把已放大到位的 scale
 * 拉回旧小值，而站起后 keepScale pass 又写回新值——即“坐下变小、走两步恢复”。
 * ep 必须是调用方已确认 active 且 owner 匹配的 seatEpisode；返回是否发生了同步（幂等）。
 */
function seatRatchetSync(ep, newBase) {
  if (!ep || !ep.active) return false;
  const anchor = Math.abs(Number(newBase));
  if (!Number.isFinite(anchor) || anchor === 0) return false;
  if (Math.abs(Number(ep.entryScale) - anchor) < 1e-12 && Math.abs(Number(ep.previousScale) - anchor) < 1e-12) return false;
  ep.entryScale = anchor;
  ep.previousScale = anchor;
  return true;
}

/**
 * A-v2.1：bootstrap（pre-visible fit 收敛门）期间是否延后行走/坐姿相位切换。
 * boot-Sit 若立即接管动画轨道，会让采样窗口不稳定（坐姿轮廓偏矮→autoScale 倍率失真），
 * 因此 bootstrap pending 时相位切换延后，释放 gate 后统一 replay 真实状态（含 Sit）。
 */
function bootstrapShouldDeferWalk(pending) {
  return !!pending;
}

if (typeof module !== "undefined" && module.exports) module.exports = { seatReleaseShouldRefit, seatRatchetSync, bootstrapShouldDeferWalk };
if (typeof window !== "undefined") window.SeatFit = { seatReleaseShouldRefit, seatRatchetSync, bootstrapShouldDeferWalk };
