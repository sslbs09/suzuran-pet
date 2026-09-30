/**
 * motion-authority.js — Runtime v2 locomotion 的 Motion Ownership 权威（纯模块，无 I/O）。
 *
 * 同一时刻唯一回答：主窗口 locomotion position 权限归谁。
 *   LEGACY          — 现有 V1 walking writer（默认）
 *   V2_LOCOMOTION   — V2 episode 持有（token 绑定 episodeId/attemptId）
 *   EXTERNAL        — 外部占用（drag/chat/zoom/sleep/manual-command 等）
 *   NONE            — 引擎未运行
 *
 * 规则（§7 真实 admission，不是散落布尔自觉）：
 * - acquire 只从 LEGACY/NONE 进入 V2_LOCOMOTION；已占用（V2/EXTERNAL）时拒绝（防双所有权）。
 * - 每次 acquire 递增 token；commit/legacy-writer 查询必须带 token+episodeId，
 *   token/episode 不匹配即 stale（旧 callback 不能夺回 ownership，§11/§12）。
 * - release 回到 LEGACY（token 单调不回卷）；externalOccupy/releaseExternal 供外部接管记录。
 * - legacyWriterDenied()：V2 持有时，V1 walking writer 一律被拒（不是碰巧没调用，是真实拒绝）。
 */
"use strict";

const OWNERS = { LEGACY: "legacy", V2: "v2-locomotion", EXTERNAL: "external", NONE: "none" };

function createMotionAuthority() {
  const state = { owner: OWNERS.LEGACY, token: 0, episodeId: null, attemptId: 0, externalKind: null };
  const denyCounts = {};

  return {
    OWNERS,
    owner() { return state.owner; },
    snapshot() {
      return { owner: state.owner, token: state.token, episodeId: state.episodeId, attemptId: state.attemptId, externalKind: state.externalKind, denyCounts: Object.assign({}, denyCounts) };
    },
    /**
     * V2 获取 locomotion 所有权。只允许从 LEGACY 进入；返回 {ok, token}。
     * 已持有（同 episode 重复 acquire）幂等返回当前 token。
     */
    acquire(episodeId) {
      if (state.owner === OWNERS.V2) {
        if (state.episodeId === episodeId) return { ok: true, token: state.token, idempotent: true };
        return { ok: false, reason: "v2-busy:other-episode" };
      }
      if (state.owner === OWNERS.EXTERNAL) return { ok: false, reason: "external-occupied" };
      if (state.owner === OWNERS.NONE) return { ok: false, reason: "engine-off" };
      state.token += 1;
      state.owner = OWNERS.V2;
      state.episodeId = String(episodeId);
      state.attemptId += 1;
      return { ok: true, token: state.token, attemptId: state.attemptId };
    },
    /** 释放：回到 LEGACY。token 不重置（stale callback 永远对不上旧 token）。 */
    release(reason) {
      state.owner = OWNERS.LEGACY;
      state.episodeId = null;
      return { token: state.token, reason: reason || null };
    },
    /** 当前 ownership 是否仍属于该 token+episode（commit/legacy-writer 的准入查询）。 */
    isCurrent(token, episodeId) {
      return state.owner === OWNERS.V2 && state.token === token && state.episodeId === episodeId;
    },
    ownsV2() { return state.owner === OWNERS.V2; },
    /** V2 持有时，旧 V1 walking writer 的真实拒绝（带计数供诊断/测试证明不是“碰巧没调用”）。 */
    denyLegacyWriter(caller) {
      if (state.owner !== OWNERS.V2) return false;
      const k = String(caller || "unknown");
      denyCounts[k] = (denyCounts[k] || 0) + 1;
      return true;
    },
    /** 外部占用标记（drag/chat/zoom/sleep/manual）。已在 V2 时由调用方先 interrupt-release 再 occupy。 */
    externalOccupy(kind) {
      state.externalKind = String(kind || "unknown");
      state.owner = OWNERS.EXTERNAL;
    },
    externalRelease() {
      if (state.owner === OWNERS.EXTERNAL) { state.owner = OWNERS.LEGACY; state.externalKind = null; }
    },
    engineOff() { if (state.owner !== OWNERS.V2) { state.owner = OWNERS.NONE; state.externalKind = null; } },
    engineOn() { if (state.owner === OWNERS.NONE) state.owner = OWNERS.LEGACY; }
  };
}

module.exports = { createMotionAuthority, OWNERS };
