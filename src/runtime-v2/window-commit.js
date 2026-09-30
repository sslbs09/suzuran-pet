/**
 * window-commit.js — 本 slice 唯一 native position commit point（纯模块，注入写入口）。
 *
 * §8：谁提交 / 属于哪个 episode-attempt / commit kind / x,y / 使用哪份 geometry dependency /
 * ownership 是否仍有效 / 成功失败 / 写后 host rect（必要时才读）。
 *
 * 铁律：
 * - ownership admission 先于写入：token/episode 与 authority 当前不符 → 拒写（stale callback 不得重提交）；
 * - 只写 position（x,y），不触碰 width/height/layers——本 slice 不重构窗口系统；
 * - 与 legacy walkSetPosition 相同的坐标守卫（safe integer、|v|≤1e6、NaN 归一）；
 * - 写失败不抛：返回 outcome="failed"；调用方按策略决定 hold/interrupt；
 * - deps.notifyWrite 是注入的效果通知钩子（main 用于 shadow bridge 最小兼容 + 低频日志），
 *   钩子自身故障绝不影响写入结果（故障隔离先例）。
 */
"use strict";

function createWindowCommit({ authority, writePosition, readRect, notifyWrite } = {}) {
  const stats = { committed: 0, denied: 0, failed: 0, byKind: {} };

  /**
   * @param ctx {token, episodeId, attemptId, kind, x, y, geometry?, needHostRect?}
   *  kind: "standup-y" | "move" | "enter-sit" | "reanchor"
   *  geometry: {value, identity}（该 commit 所依赖的 groundGap 证据；仅透传记录，不做二次判定）
   * @returns {ok, reason?, outcome, x, y, hostRectAfter?, episodeId, kind}
   */
  function commitPosition(ctx) {
    const kind = String((ctx && ctx.kind) || "unknown");
    if (!ctx || !authority.isCurrent(ctx.token, ctx.episodeId)) {
      stats.denied += 1;
      return { ok: false, reason: "stale-or-not-owner", outcome: "denied", kind, episodeId: ctx && ctx.episodeId || null };
    }
    const px = Math.round(Number(ctx.x)) || 0, py = Math.round(Number(ctx.y)) || 0;
    if (!Number.isSafeInteger(px) || !Number.isSafeInteger(py) || Math.abs(px) > 1000000 || Math.abs(py) > 1000000) {
      stats.denied += 1;
      return { ok: false, reason: "illegal-coords", outcome: "rejected", x: px, y: py, kind, episodeId: ctx.episodeId };
    }
    try {
      writePosition(px, py);
      stats.committed += 1;
      stats.byKind[kind] = (stats.byKind[kind] || 0) + 1;
      const hostRectAfter = ctx.needHostRect ? readRectSafe() : null;
      const result = { ok: true, outcome: "succeeded", x: px, y: py, kind, episodeId: ctx.episodeId, attemptId: ctx.attemptId, geometry: ctx.geometry || null, hostRectAfter };
      notify(result);
      return result;
    } catch (e) {
      stats.failed += 1;
      const result = { ok: false, reason: "write-throw:" + String((e && e.message) || e).slice(0, 80), outcome: "failed", x: px, y: py, kind, episodeId: ctx.episodeId };
      notify(result);
      return result;
    }
  }

  function readRectSafe() {
    try { const r = typeof readRect === "function" ? readRect() : null; return r && Number.isFinite(r.x) ? { x: r.x, y: r.y, width: r.width, height: r.height } : null; } catch { return null; }
  }

  function notify(result) {
    try { if (typeof notifyWrite === "function") notifyWrite(result); } catch { /* 效果通知故障绝不影响写入 */ }
  }

  return { commitPosition, stats };
}

module.exports = { createWindowCommit };
