/** 渲染模式归一化 + 切换贴地坐标单测（node，纯函数） */
"use strict";
const RM = require("../src/render-mode");
const G = require("../src/walk-geo");
let failed = 0;
function assertEq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failed++; console.log("FAIL", name, "got", JSON.stringify(got), "want", JSON.stringify(want)); }
  else console.log("PASS", name);
}

// 1) 渲染模式归一化
assertEq("renderModeOf spine", RM.renderModeOf("spine"), "spine");
assertEq("renderModeOf rig", RM.renderModeOf("rig"), "rig");
assertEq("renderModeOf gif", RM.renderModeOf("gif"), "gif");
assertEq("renderModeOf 未配置(undefined) 回落 gif", RM.renderModeOf(undefined), "gif");
assertEq("renderModeOf 空串回落 gif", RM.renderModeOf(""), "gif");
assertEq("renderModeOf 未知值回落 gif", RM.renderModeOf("psd"), "gif");
assertEq("renderModeOf 大写不匹配回落 gif", RM.renderModeOf("SPINE"), "gif");
assertEq("RENDER_MODES 四态", JSON.stringify(RM.RENDER_MODES), JSON.stringify(["gif", "spine", "rig", "live2d"]));

// 2) 切换贴地坐标
const wa = { x: 0, y: 0, width: 1536, height: 800 };
assertEq("贴地 居中窗口", RM.groundAlign({ x: 500, y: 300, width: 260, height: 200 }, wa, 0), { x: 500, y: 600 });
assertEq("贴地 带 groundGap", RM.groundAlign({ x: 500, y: 300, width: 260, height: 200 }, wa, 26), { x: 500, y: 626 });
assertEq("贴地 越左界钳回", RM.groundAlign({ x: -120, y: 300, width: 260, height: 200 }, wa, 0), { x: 0, y: 600 });
assertEq("贴地 越右界钳回", RM.groundAlign({ x: 2000, y: 300, width: 260, height: 200 }, wa, 0), { x: 1276, y: 600 });
assertEq("贴地 负坐标工作区(副屏)", RM.groundAlign({ x: -300, y: 100, width: 260, height: 200 }, { x: -1920, y: 0, width: 1920, height: 1080 }, 10), { x: -300, y: 890 });
assertEq("贴地 工作区比窗口窄(坍缩)仍钳回左界", RM.groundAlign({ x: 50, y: 0, width: 300, height: 200 }, { x: 10, y: 0, width: 200, height: 600 }, 0), { x: 10, y: 400 });
// 与 walkGeo.groundLine 一致性（正常窗口：贴地 y == groundLine）
assertEq("贴地 y 与 walkGeo.groundLine 一致", RM.groundAlign({ x: 0, y: 0, width: 260, height: 200 }, wa, 26).y, G.groundLine(wa, 200, 26));

console.log(failed ? `\n${failed} 项失败` : "\nrender-mode 全部通过 ✅");
process.exit(failed ? 1 : 0);