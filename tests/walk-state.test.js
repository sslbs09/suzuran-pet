/** walk-state 纯函数单测（node）——翻边滞回/垂直钳位/坐姿尺寸重锚决策（v2.5.26 收敛①，行为等价校验） */
"use strict";
const { edgeFlipDecision, uiEdgeCompactFromBounds, verticalClampDecision, seatReanchorOnResizeDecision, chatPanelSideDecision } = require("../src/walk-state");
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
assert("UI：仍在屏外保持紧凑", uiEdgeCompactFromBounds({ windowX: -50, workAreaLeft: 0, compact: true }) === true);
assert("UI：回到屏内立即恢复，即使 walking edge 仍在", uiEdgeCompactFromBounds({ windowX: 3, workAreaLeft: 0, compact: true }) === false);
assert("UI：进入阈值使用小空间滞回", uiEdgeCompactFromBounds({ windowX: -3, workAreaLeft: 0, compact: false }) === true);

// 垂直钳位
assert("掉太低→down", verticalClampDecision({ y: 1000, groundY: 800, seated: false, resting: true, transient: false }).type === "down");
assert("悬太高+resting+非瞬态→up", verticalClampDecision({ y: 500, groundY: 800, seated: false, resting: true, transient: false }).type === "up");
assert("悬太高+瞬态→不钳", verticalClampDecision({ y: 500, groundY: 800, seated: false, resting: true, transient: true }) === null);
assert("悬太高+非resting/seated→不钳", verticalClampDecision({ y: 500, groundY: 800, seated: false, resting: false, transient: false }) === null);
assert("正常范围→null", verticalClampDecision({ y: 790, groundY: 800, seated: true, resting: true, transient: false }) === null);

// 坐姿窗口尺寸变化重锚（TD-1 悬空坐）
assert("坐姿+无瞬态→重锚", seatReanchorOnResizeDecision({ seated: true, perched: false, dragPaused: false, flight: false, jump: false }) === true);
assert("放大/聊天暂停不在判定内——坐姿仍重锚（正是悬空发生场景）", seatReanchorOnResizeDecision({ seated: true, perched: false, dragPaused: false, flight: false, jump: false }) === true);
assert("站姿→不重锚（归相位机管）", seatReanchorOnResizeDecision({ seated: false, perched: false, dragPaused: false, flight: false, jump: false }) === false);
assert("拖拽中→不重锚（防拽离手）", seatReanchorOnResizeDecision({ seated: true, perched: false, dragPaused: true, flight: false, jump: false }) === false);
assert("飞行中→不重锚", seatReanchorOnResizeDecision({ seated: true, perched: false, dragPaused: false, flight: true, jump: false }) === false);
assert("跳跃中→不重锚", seatReanchorOnResizeDecision({ seated: true, perched: false, dragPaused: false, flight: false, jump: true }) === false);
assert("跳窗顶（perched）→不重锚", seatReanchorOnResizeDecision({ seated: true, perched: true, dragPaused: false, flight: false, jump: false }) === false);

// BUG-06：chat panel 侧别决策（冻结规则：常规侧放下→left；否则右牵挂得下→right；两侧都紧→更大侧+clamp）
{
  const wa = { x: 0, width: 1920 };
  // 中屏：常规侧（角色左侧）放得下 → left（产品默认布局不变）
  assert("侧别：中屏常规侧放下→left", chatPanelSideDecision({ charLeft: 800, charRight: 920, workArea: wa, panelWidth: 200 }).side === "left");
  // 左缘：常规侧放不下、右牵挂得下 → right
  assert("侧别：左缘换边→right", chatPanelSideDecision({ charLeft: 0, charRight: 120, workArea: wa, panelWidth: 200 }).side === "right");
  assert("侧别：左缘换边不 clamp", chatPanelSideDecision({ charLeft: 0, charRight: 120, workArea: wa, panelWidth: 200 }).clamped === false);
  // 右缘：左侧仍放得下 → left（保持默认）
  assert("侧别：右缘保持 left", chatPanelSideDecision({ charLeft: 1800, charRight: 1920, workArea: wa, panelWidth: 200 }).side === "left");
  // 面板真实宽度变大后：中屏两侧都放不下 → 更大侧 + clamped
  const wide = chatPanelSideDecision({ charLeft: 10, charRight: 130, workArea: { x: 0, width: 260 }, panelWidth: 300 });
  assert("侧别：两侧都紧→更大侧", wide.side === "right" && wide.clamped === true, JSON.stringify(wide));
  // 非当前显示器 workArea（负 x 多屏）：跟随传入 display，不硬编码单屏
  const multi = chatPanelSideDecision({ charLeft: -1920, charRight: -1800, workArea: { x: -1920, width: 1920 }, panelWidth: 200 });
  assert("侧别：多屏负坐标 display 跟随→right", multi.side === "right", JSON.stringify(multi));
}

process.exit(failed ? 1 : 0);
