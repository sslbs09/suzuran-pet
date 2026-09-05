/**
 * 行走几何（纯函数，可单测）——2026-08-27 从 main.js 收敛而来：
 * 显示器工作区/联合范围、左缘补偿钳位、地面线、坐姿下沉分档、相位时长。
 * 不依赖 Electron 全局；禁全域行走（walkGlobal=false）时 spanOf 返回 null（走单显示器逻辑）。
 */
"use strict";

/** 左缘补偿：翻边贴边 inset=2，否则用渲染层上报的 charInset（角色条带在窗口右侧，左侧是气泡区） */
function insetOf(edgeLeft, charInset, width) {
  const useInset = edgeLeft ? 2 : (Number(charInset) || 0);
  return Math.max(0, Math.min(useInset, Math.max(0, width - 1)));
}

/**
 * 出屏钳回死区判断（§14 追加 89 遗留项）：角色条带左缘越出边界 ≤ deadZone 时
 * 视为行走推进/贴边翻边的瞬时像素噪声，不 setPosition——高频钳位与行走推进
 * 成「推出→拽回」拉锯即左缘微闪；仅越出死区才需要钳回。
 * 返回 { overdue, deficit, deadZone }：overdue=true 需钳回，deficit 为越界量（≤0 表示在界内）。
 */
function clampNeeded(edgeL, charLeft, deadZone) {
  const dz = Number.isFinite(deadZone) && deadZone >= 0 ? deadZone : 8;
  const deficit = edgeL - charLeft;
  return { overdue: deficit > dz, deficit, deadZone: dz };
}

/** 桌面全域行走（实验）：虚拟桌面联合范围 {x, right}；未开启返回 null */
function spanOf(getAllDisplays, walkGlobal) {
  if (!walkGlobal) return null;
  try {
    const ds = getAllDisplays();
    if (!ds || !ds.length) return null;
    let x = Infinity, right = -Infinity;
    for (const d of ds) {
      x = Math.min(x, d.bounds.x);
      right = Math.max(right, d.bounds.x + d.bounds.width);
    }
    return { x, right };
  } catch { return null; }
}

/** 窗口所在显示器的工作区（统一 getDisplayMatching 取用，消除散落重复） */
function workAreaOf(screen, bounds) {
  try { return screen.getDisplayMatching(bounds).workArea; } catch { return { x: 0, y: 0, width: 800, height: 600 }; }
}

/**
 * 单显示器水平钳位。必须与 walkTick 顶部"出屏钳回"同源，否则翻边瞬间几何上报迟到
 * 会把 minX 拉回 -138，导致贴左缘折返永不触发（2026-08-26 实测修复）。
 */
function clampWalkX(x, wa, width, edgeLeft, charInset) {
  const rawMax = wa.x + wa.width - width;
  const inset = insetOf(edgeLeft, charInset, width);
  const minX = wa.x - inset;
  const maxX = Math.max(minX, rawMax);
  const value = Math.min(Math.max(Number(x), minX), maxX);
  return { x: value, minX, maxX, rawMax, inset, collapsed: rawMax < minX };
}

/** 全域虚拟桌面钳位（返回与 clampWalkX 同构） */
function clampWalkSpan(x, span, width, edgeLeft, charInset) {
  const inset = insetOf(edgeLeft, charInset, width);
  const minX = span.x - inset;
  const maxX = Math.max(minX, span.right - width);
  const value = Math.min(Math.max(Number(x), minX), maxX);
  return { x: value, minX, maxX, rawMax: span.right - width, inset, collapsed: maxX < minX };
}

/** 左边界（含 inset，上限 399 防越界） */
function walkMinX(wa, edgeLeft, charInset) {
  const useInset = edgeLeft ? 2 : (Number(charInset) || 0);
  return wa.x - Math.max(0, Math.min(useInset, 399));
}

/** 地面线：窗口底部应停的位置（工作区底 + 贴地间隙） */
function groundLine(wa, winH, gap) {
  return Math.max(wa.y, wa.y + wa.height - winH) + (gap || 0);
}

/** 坐姿下沉量分档：小尺寸（≤80%）腿短、冬季大尺寸单独档，其余标准；设置页滑杆可按档位覆盖。
 *  默认 0（脚底贴任务栏/图标上沿，不压图标）：旧默认 22/30 会把鞋画进任务栏图标行——
 *  大图标/高 DPI 任务栏图标顶几乎贴上沿，必踩（2026-09-05 用户实测截图定案）。
 *  想要"腿垂进任务栏"观感的用户可在设置页按档位调高。 */
const SEAT_SINK_DEFAULTS = { small: 0, standard: 0, winterLarge: 0 };
function seatSinkTierOf(scale, spineSkinId) {
  if (/winter/i.test(String(spineSkinId || "")) && scale >= 1.2 && scale < 1.6) return "winterLarge";
  if (scale <= 0.8) return "small";
  return "standard";
}
function seatSinkOf(scale, spineSkinId, walkSeatSink) {
  const t = seatSinkTierOf(scale, spineSkinId);
  const v = Number((walkSeatSink || {})[t]);
  return Number.isFinite(v) && v >= 0 ? Math.round(v) : SEAT_SINK_DEFAULTS[t];
}

/** 相位时长（秒→毫秒）：读 config.walkTiming[key]，钳到 [clampMinSec, clampMaxSec]，缺省 defMaxSec；保底随机 [minMs, max(minMs, cap)] */
function phaseMs(randInt, cfg, key, minMs, defMaxSec, clampMinSec, clampMaxSec) {
  const n = Number((cfg.walkTiming || {})[key]);
  const sec = Number.isFinite(n) && n > 0
    ? Math.max(clampMinSec, Math.min(n, clampMaxSec))
    : defMaxSec;
  return randInt(minMs, Math.max(minMs, Math.round(sec * 1000)));
}

module.exports = {
  insetOf, spanOf, workAreaOf,
  clampWalkX, clampWalkSpan, walkMinX, groundLine,
  seatSinkTierOf, seatSinkOf, SEAT_SINK_DEFAULTS,
  clampNeeded, phaseMs,
};