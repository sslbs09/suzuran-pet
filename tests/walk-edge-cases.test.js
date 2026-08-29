"use strict";
/* walk-geo 边界场景单测：全域行走 + 左缘翻边组合（排查"往左走卡住"） */
const walkGeo = require("../src/walk-geo.js");

let pass = 0, total = 0;
function ok(name, cond, detail) { total++; if (cond) { pass++; console.log("✓", name); } else { console.log("✗", name, detail || ""); } }

// 场景参数：朋友类设备（单屏 1536x864 逻辑，DPI 1.25）+ 全域开
const span = { x: 0, right: 1536 };
const width317 = 317; // 朋友日志的窗口宽（气泡加宽态）

// 场景 A：非翻边（edgeLeft=false，charInset=195=width-122）
const A1 = walkGeo.clampWalkSpan(500, span, width317, false, 195);
ok("A1 非翻边 minX=-195", A1.minX === -195, "minX=" + A1.minX);
ok("A1 maxX=1219", A1.maxX === span.right - width317, "maxX=" + A1.maxX);

// 场景 B：翻边后（edgeLeft=true，charInset=2；窗口已平移到 x=0）
const B1 = walkGeo.clampWalkSpan(0, span, width317, true, 2);
ok("B1 翻边 minX=-2", B1.minX === -2, "minX=" + B1.minX);
ok("B1 翻边后窗口 0 合法（≥minX）", B1.x === 0);

// 场景 C：翻边→翻回的窗口平移一致性
// 翻边时 setEdgeLeft(true)：窗口平移 +(width-124)=+193 → x=-195+193=-2 → charLeft=-2+2=0 贴缘 ✓
const flipX = -195 + (width317 - 124);
ok("C1 翻边平移后 charLeft=0 贴缘", flipX + 2 === 0, "charLeft=" + (flipX + 2));
// 翻回时 setEdgeLeft(false)：平移 -(width-124) → x=0-193=-193 → charLeft=-193+195=2 → 2>80? 否 → 不再翻回 ✓
const backX = 0 - (width317 - 124);
ok("C2 翻回后 charLeft=2（<80 不抖动）", backX + 195 === 2 && !(backX + 195 > 0 + 80));

// 场景 D：全域 minX 与折返的交互——窗口贴左缘（x=minX=-2）时继续往左：折返钳到 minX=-2 ✓ 不越界
const D1 = walkGeo.clampWalkSpan(-50, span, width317, true, 2);
ok("D1 越界钳回 minX", D1.x === -2);

// 场景 E：标准 260 窗（非加宽）
const E1 = walkGeo.clampWalkSpan(0, span, 260, false, 138);
ok("E1 标准窗 minX=-138", E1.minX === -138);

// 场景 F：span.x 为负（副屏在左侧的虚拟桌面）
const spanNeg = { x: -1920, right: 1536 };
const F1 = walkGeo.clampWalkSpan(-1000, spanNeg, 317, false, 195);
ok("F1 负坐标 span minX=-2115", F1.minX === -2115, "minX=" + F1.minX);

// 场景 G：span 坍缩防御（span.right-width < minX）
const spanTiny = { x: 0, right: 200 };
const G1 = walkGeo.clampWalkSpan(0, spanTiny, 317, false, 195);
ok("G1 坍缩时 x 钳到区间 [-195,-117]", G1.x === -117 && G1.x >= G1.minX && G1.x <= G1.maxX, "x=" + G1.x);

console.log(`\n${pass}/${total} 项通过`);
process.exit(pass === total ? 0 : 1);
