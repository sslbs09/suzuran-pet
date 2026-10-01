/**
 * window-commit.js — 主窗口 position 的唯一 production commit point（纯模块，注入写入口）。
 *
 * §8：谁提交 / 属于哪个 episode-or-drag-session / commit kind / x,y / 使用哪份 geometry dependency /
 * ownership 是否仍有效 / 成功失败 / 写后 host rect（必要时才读）。
 *
 * 两类 admission（共享同一 coordinate guard + 写入 + notify，只是 ownership 校验与 writer 不同）：
 * - commitPosition：V2 locomotion（authority.isCurrent(token, episodeId)）——STAND_UP/MOVE/ENTER_SIT。
 *   writer=writePosition（含 applyLayerThrottled，与 V1 walkSetPosition 语义对齐）；
 * - commitExternal：EXTERNAL_DRAG（authority.isExternalCurrent(externalToken)）——拖拽位移。
 *   writer=writePositionExternal（裸 setPosition）——legacy pet:move 从不做 layer 断言，
 *   拖拽热路径必须与其逐字同价（性能回归修复：setAlwaysOnTop 在拖拽中是可感知 hitch）。
 *
 * 热路径纪律（性能合同）：成功路径只做 cheap token 比较 + 坐标守卫 + setPosition + 最小 result；
 * host rect 只在 needHostRect 显式要求时读（drag move 永不读）；notify 由注入方决定（drag-move 不通知）。
 */
"use strict";

function createWindowCommit({ authority, writePosition, writePositionExternal, readRect, notifyWrite } = {}) {
  const stats = { committed: 0, denied: 0, failed: 0, byKind: {} };

  function readRectSafe() {
    try { const r = typeof readRect === "function" ? readRect() : null; return r && Number.isFinite(r.x) ? { x: r.x, y: r.y, width: r.width, height: r.height } : null; } catch { return null; }
  }
  function notify(result) {
    try { if (typeof notifyWrite === "function") notifyWrite(result); } catch { /* 效果通知故障绝不影响写入 */ }
  }

  /**
   * 共享写入核：ownership 已通过后执行坐标守卫 + 写入 + 计数 + notify。
   * ctx {kind, x, y, geometry?, needHostRect?, episodeId, attemptId, sessionId, external}
   */
  function guardedWrite(ctx) {
    const kind = String(ctx.kind || "unknown");
    const px = Math.round(Number(ctx.x)) || 0, py = Math.round(Number(ctx.y)) || 0;
    if (!Number.isSafeInteger(px) || !Number.isSafeInteger(py) || Math.abs(px) > 1000000 || Math.abs(py) > 1000000) {
      stats.denied += 1;
      return { ok: false, reason: "illegal-coords", outcome: "rejected", x: px, y: py, kind, episodeId: ctx.episodeId || null, sessionId: ctx.sessionId || null };
    }
    const writer = ctx.external && typeof writePositionExternal === "function" ? writePositionExternal : writePosition;
    try {
      if (typeof writer !== "function") {
        stats.denied += 1;
        return { ok: false, reason: "no-writer", outcome: "denied", kind, episodeId: ctx.episodeId || null, sessionId: ctx.sessionId || null };
      }
      writer(px, py);
      stats.committed += 1;
      stats.byKind[kind] = (stats.byKind[kind] || 0) + 1;
      const hostRectAfter = ctx.needHostRect ? readRectSafe() : null;
      const result = { ok: true, outcome: "succeeded", x: px, y: py, kind, episodeId: ctx.episodeId || null, attemptId: ctx.attemptId || null, geometry: ctx.geometry || null, hostRectAfter, sessionId: ctx.sessionId || null };
      notify(result);
      return result;
    } catch (e) {
      stats.failed += 1;
      const result = { ok: false, reason: "write-throw:" + String((e && e.message) || e).slice(0, 80), outcome: "failed", x: px, y: py, kind, episodeId: ctx.episodeId || null, sessionId: ctx.sessionId || null };
      notify(result);
      return result;
    }
  }

  /** V2 locomotion commit（STAND_UP/MOVE/ENTER_SIT；writer 含 layer 节流，与 V1 walk writer 对齐）。 */
  function commitPosition(ctx) {
    const kind = String((ctx && ctx.kind) || "unknown");
    const adm = authority.positionAdmit("v2-locomotion", ctx);
    if (!ctx || !adm.ok) {
      stats.denied += 1;
      return { ok: false, reason: adm.reason || "stale-or-not-owner", outcome: "denied", kind, episodeId: (ctx && ctx.episodeId) || null };
    }
    return guardedWrite(ctx);
  }

  /** EXTERNAL_DRAG commit（拖拽位移；裸 setPosition——与 legacy pet:move 热路径同价）。token 失效 → 拒写。 */
  function commitExternal(ctx) {
    const kind = String((ctx && ctx.kind) || "drag-move");
    const adm = authority.positionAdmit("external-drag", ctx);
    if (!ctx || !adm.ok) {
      stats.denied += 1;
      return { ok: false, reason: adm.reason || "not-external-owner", outcome: "denied", kind, sessionId: (ctx && ctx.sessionId) || null };
    }
    return guardedWrite(Object.assign({ external: true }, ctx));
  }

  return { commitPosition, commitExternal, stats };
}

module.exports = { createWindowCommit };
