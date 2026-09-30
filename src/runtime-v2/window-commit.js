/**
 * window-commit.js — 主窗口 position 的唯一 production commit point（纯模块，注入写入口）。
 *
 * §8：谁提交 / 属于哪个 episode-or-drag-session / commit kind / x,y / 使用哪份 geometry dependency /
 * ownership 是否仍有效 / 成功失败 / 写后 host rect（必要时才读）。
 *
 * 两类 admission（共享同一 coordinate guard + 写入 + notify，只是 ownership 校验不同）：
 * - commitPosition：V2 locomotion（authority.isCurrent(token, episodeId)）——STAND_UP/MOVE/ENTER_SIT；
 * - commitExternal：EXTERNAL_DRAG（authority.isExternalCurrent(externalToken)）——拖拽位移。
 * 二者绝不同时通过：owner 唯一由 MotionAuthority 保证（V2 持有时 external 未占用，反之亦然）。
 *
 * 铁律：
 * - ownership admission 先于写入：token 不符 → 拒写（stale episode / 迟到 pointer / reload 后旧会话）；
 * - 只写 position（x,y），不触碰 width/height/layers——本 slice 不重构窗口系统；
 * - 与 legacy walkSetPosition 相同坐标守卫（safe integer、|v|≤1e6、NaN 归一）；
 * - 写失败不抛：返回 outcome="failed"；调用方按策略决定 hold/interrupt；
 * - notifyWrite 注入效果通知（shadow 最小兼容 + 低频日志），自身故障绝不外抛。
 */
"use strict";

function createWindowCommit({ authority, writePosition, readRect, notifyWrite } = {}) {
  const stats = { committed: 0, denied: 0, failed: 0, byKind: {} };

  function readRectSafe() {
    try { const r = typeof readRect === "function" ? readRect() : null; return r && Number.isFinite(r.x) ? { x: r.x, y: r.y, width: r.width, height: r.height } : null; } catch { return null; }
  }
  function notify(result) {
    try { if (typeof notifyWrite === "function") notifyWrite(result); } catch { /* 效果通知故障绝不影响写入 */ }
  }

  /**
   * 共享写入核：ownership 已通过后执行坐标守卫 + 写入 + 计数 + notify。
   * ctx {kind, x, y, geometry?, needHostRect?, episodeId, attemptId}
   */
  function guardedWrite(ctx) {
    const kind = String(ctx.kind || "unknown");
    const px = Math.round(Number(ctx.x)) || 0, py = Math.round(Number(ctx.y)) || 0;
    if (!Number.isSafeInteger(px) || !Number.isSafeInteger(py) || Math.abs(px) > 1000000 || Math.abs(py) > 1000000) {
      stats.denied += 1;
      return { ok: false, reason: "illegal-coords", outcome: "rejected", x: px, y: py, kind, episodeId: ctx.episodeId || null };
    }
    try {
      writePosition(px, py);
      stats.committed += 1;
      stats.byKind[kind] = (stats.byKind[kind] || 0) + 1;
      const hostRectAfter = ctx.needHostRect ? readRectSafe() : null;
      const result = { ok: true, outcome: "succeeded", x: px, y: py, kind, episodeId: ctx.episodeId || null, attemptId: ctx.attemptId || null, geometry: ctx.geometry || null, hostRectAfter };
      notify(result);
      return result;
    } catch (e) {
      stats.failed += 1;
      const result = { ok: false, reason: "write-throw:" + String((e && e.message) || e).slice(0, 80), outcome: "failed", x: px, y: py, kind, episodeId: ctx.episodeId || null };
      notify(result);
      return result;
    }
  }

  /** V2 locomotion commit（STAND_UP/MOVE/ENTER_SIT）。 */
  function commitPosition(ctx) {
    const kind = String((ctx && ctx.kind) || "unknown");
    if (!ctx || !authority.isCurrent(ctx.token, ctx.episodeId)) {
      stats.denied += 1;
      return { ok: false, reason: "stale-or-not-owner", outcome: "denied", kind, episodeId: (ctx && ctx.episodeId) || null };
    }
    return guardedWrite(ctx);
  }

  /** EXTERNAL_DRAG commit（拖拽位移）。token 失效（已 release / reload / 新会话）→ 拒写。 */
  function commitExternal(ctx) {
    const kind = String((ctx && ctx.kind) || "drag-move");
    if (!ctx || !authority.isExternalCurrent(ctx.externalToken)) {
      stats.denied += 1;
      return { ok: false, reason: "not-external-owner", outcome: "denied", kind, sessionId: (ctx && ctx.sessionId) || null };
    }
    const result = guardedWrite(ctx);
    return result.sessionId ? result : Object.assign(result, { sessionId: ctx.sessionId || null });
  }

  return { commitPosition, commitExternal, stats };
}

module.exports = { createWindowCommit };
