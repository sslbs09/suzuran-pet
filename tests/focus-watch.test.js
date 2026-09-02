/** focus-watch 纯函数单测（node）——专注/离开状态转移（v2.5.26 收敛②） */
"use strict";
const { focusTransition } = require("../src/focus-watch");
let failed = 0;
function assert(name, cond, extra) {
  if (!cond) { failed++; console.log("FAIL", name, extra || ""); }
  else console.log("PASS", name);
}

// 空闲超阈值 → 进入离开
const a = focusTransition({ idleSec: 400, awaySince: 0, now: 100000 });
assert("空闲>300→进入离开", a.awaySince === 100000 && a.greet === false);
// 已离开且仍空闲 → 保持（不重置起始）
const b = focusTransition({ idleSec: 400, awaySince: 100000, now: 200000 });
assert("仍空闲→保持起始", b.awaySince === 100000 && b.greet === false);
// 回归且离开>60s → greet
const c = focusTransition({ idleSec: 5, awaySince: 100000, now: 200000 });
assert("回归+离开>60s→greet", c.awaySince === 0 && c.greet === true);
// 回归但离开<60s → 不 greet
const d = focusTransition({ idleSec: 5, awaySince: 150000, now: 200000 });
assert("回归+离开<60s→不greet", d.awaySince === 0 && d.greet === false);
// 未离开且活跃 → 保持 0
const e = focusTransition({ idleSec: 5, awaySince: 0, now: 200000 });
assert("活跃→awaySince=0", e.awaySince === 0 && e.greet === false);

process.exit(failed ? 1 : 0);
