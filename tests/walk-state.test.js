/** walk-state 纯函数单测（node）——翻边滞回/垂直钳位决策（v2.5.26 收敛①，行为等价校验） */
"use strict";
const { edgeFlipDecision, verticalClampDecision } = require("../src/walk-state");
let failed = 0;
function assert(name, cond, extra) {
  if (!cond) { failed++; console.log("FAIL", name, extra || ""); }
  else console.log("PASS", name);
}

// 翻边滞回
assert("非左缘+贴左缘→翻左", edgeFlipDecision({ edgeLeft: false, charLeft: 0, edgeL: 0, now: 1000, lastFlipAt: 0 }).flip === true);
assert("非左缘+离边界远→不翻", edgeFlipDecision({ edgeLeft: false, charLeft: 300, edgeL: 0, now: 1000, lastFlipAt: 0 }) === null);
assert("左缘+未超回翻阈值→不翻", edgeFlipDecision({ edgeLeft: true, charLeft: 100, edgeL: 0, now: 1000, lastFlipAt: 0 }) === null);
assert("左缘+超140→回翻", edgeFlipDecision({ edgeLeft: true, charLeft: 150, edgeL: 0, now: 1000, lastFlipAt: 0 }).flip === false);
assert("防抖内→不翻", edgeFlipDecision({ edgeLeft: true, charLeft: 150, edgeL: 0, now: 1000, lastFlipAt: 500 }) === null);

// 垂直钳位
assert("掉太低→down", verticalClampDecision({ y: 1000, groundY: 800, seated: false, resting: true, transient: false }).type === "down");
assert("悬太高+resting+非瞬态→up", verticalClampDecision({ y: 500, groundY: 800, seated: false, resting: true, transient: false }).type === "up");
assert("悬太高+瞬态→不钳", verticalClampDecision({ y: 500, groundY: 800, seated: false, resting: true, transient: true }) === null);
assert("悬太高+非resting/seated→不钳", verticalClampDecision({ y: 500, groundY: 800, seated: false, resting: false, transient: false }) === null);
assert("正常范围→null", verticalClampDecision({ y: 790, groundY: 800, seated: true, resting: true, transient: false }) === null);

process.exit(failed ? 1 : 0);
