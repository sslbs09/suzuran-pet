/** 行走几何纯函数单测（node，不依赖 Electron） */
"use strict";
const G = require("../src/walk-geo");
let failed = 0;
function assertEq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failed++; console.log("FAIL", name, "got", JSON.stringify(got), "want", JSON.stringify(want)); }
  else console.log("PASS", name);
}
function randInt(a, b) { return a; } // 固定返回下界，便于断言

// 1) 单显示器钳位（左缘 inset）
const wa = { x: 0, y: 0, width: 1536, height: 912 };
assertEq("clampWalkX 正常", G.clampWalkX(500, wa, 260, false, 0), { x: 500, minX: 0, maxX: 1276, rawMax: 1276, inset: 0, collapsed: false });
assertEq("clampWalkX 出右界", G.clampWalkX(2000, wa, 260, false, 0), { x: 1276, minX: 0, maxX: 1276, rawMax: 1276, inset: 0, collapsed: false });
assertEq("clampWalkX 贴左缘翻边 inset=2", G.clampWalkX(-10, wa, 260, true, 0), { x: -2, minX: -2, maxX: 1276, rawMax: 1276, inset: 2, collapsed: false });
assertEq("clampWalkX 气泡区 inset=charInset", G.clampWalkX(-50, wa, 260, false, 40), { x: -40, minX: -40, maxX: 1276, rawMax: 1276, inset: 40, collapsed: false });
// 2) 全域虚拟桌面（双显示器）
const span = G.spanOf(() => [{ bounds: { x: 0, width: 1920 } }, { bounds: { x: 1920, width: 1920 } }], true);
assertEq("spanOf 双屏联合", span, { x: 0, right: 3840 });
assertEq("spanOf 关闭=null", G.spanOf(() => [{ bounds: { x: 0, width: 1920 } }], false), null);
assertEq("spanOf 负坐标左屏", G.spanOf(() => [{ bounds: { x: -1920, width: 1920 } }, { bounds: { x: 0, width: 1920 } }], true), { x: -1920, right: 1920 });
assertEq("clampWalkSpan 可跨入副屏", G.clampWalkSpan(1900, span, 260, false, 0), { x: 1900, minX: 0, maxX: 3580, rawMax: 3580, inset: 0, collapsed: false });
assertEq("clampWalkSpan 最远边", G.clampWalkSpan(4000, span, 260, false, 0), { x: 3580, minX: 0, maxX: 3580, rawMax: 3580, inset: 0, collapsed: false });
// 3) walkMinX / groundLine
assertEq("walkMinX inset", G.walkMinX(wa, false, 30), -30);
assertEq("walkMinX 翻边", G.walkMinX(wa, true, 30), -2);
assertEq("groundLine", G.groundLine(wa, 200, 26), 738);
// 4) 坐姿下沉分档
assertEq("seatSinkTier small", G.seatSinkTierOf(0.7, ""), "small");
assertEq("seatSinkTier winterLarge", G.seatSinkTierOf(1.3, "winter/x"), "winterLarge");
assertEq("seatSinkTier standard", G.seatSinkTierOf(1.0, ""), "standard");
assertEq("seatSink 默认值", G.seatSinkOf(1.0, "", {}), 30);
assertEq("seatSink 滑杆覆盖", G.seatSinkOf(0.7, "", { small: 12 }), 12);
// 5) 相位时长
assertEq("sitPhaseMs 默认下限", G.phaseMs(randInt, { walkTiming: {} }, "sitMaxSec", 10000, 30, 15, 180), 10000);
assertEq("sitPhaseMs 配置 20s", G.phaseMs((a, b) => b, { walkTiming: { sitMaxSec: 20 } }, "sitMaxSec", 10000, 30, 15, 180), 20000);
assertEq("walkPhaseMs 超上限钳制", G.phaseMs((a, b) => b, { walkTiming: { walkMaxSec: 999 } }, "walkMaxSec", 8000, 20, 8, 120), 120000);
// 6) workAreaOf 兜底
assertEq("workAreaOf 兜底", G.workAreaOf({ getDisplayMatching: () => { throw new Error("x"); } }, {}), { x: 0, y: 0, width: 800, height: 600 });
// 7) 出屏钳回死区（§14 追加 89 遗留项：死区内不 setPosition）
assertEq("clampNeeded 在界内", G.clampNeeded(100, 105, 8), { overdue: false, deficit: -5, deadZone: 8 });
assertEq("clampNeeded 死区内越界", G.clampNeeded(100, 95, 8), { overdue: false, deficit: 5, deadZone: 8 });
assertEq("clampNeeded 恰在死区边界", G.clampNeeded(100, 92, 8), { overdue: false, deficit: 8, deadZone: 8 });
assertEq("clampNeeded 逾越死区", G.clampNeeded(100, 91, 8), { overdue: true, deficit: 9, deadZone: 8 });
assertEq("clampNeeded 默认死区", G.clampNeeded(100, 95), { overdue: false, deficit: 5, deadZone: 8 });
assertEq("clampNeeded 死区=0 严格钳位", G.clampNeeded(100, 99, 0), { overdue: true, deficit: 1, deadZone: 0 });
assertEq("clampNeeded 非法死区回落默认", G.clampNeeded(100, 95, -3), { overdue: false, deficit: 5, deadZone: 8 });

console.log(failed ? `\n${failed} 项失败` : "\n全部通过 ✅");
process.exit(failed ? 1 : 0);
