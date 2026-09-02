"use strict";

/* focus-watch.js — 专注/离开模式状态机纯函数（v2.5.26 收敛②）
 * 把 main.js startFocusWatch 的「空闲判定/回归打招呼」抽成纯函数，可单测；
 * main.js 只保留副作用（读 powerMonitor、sendProactive、维护 awaySince）。
 */

/** 空闲状态转移。idleSec: 系统空闲秒数；awaySince: 离开起始时间戳(0=未离开)。
 *  返回 { awaySince, greet }：awaySince 为新状态；greet=true 表示"离开>minAway 后回归"应打招呼。 */
function focusTransition({ idleSec, awaySince = 0, now, idleThresholdSec = 300, minAwayMs = 60000 }) {
  if (idleSec > idleThresholdSec) return { awaySince: awaySince || now, greet: false };
  const greet = !!awaySince && (now - awaySince) > minAwayMs;
  return { awaySince: 0, greet };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { focusTransition };
}
