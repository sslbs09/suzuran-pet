/**
 * motion-authority.js — Runtime v2 locomotion/drag 的 Motion Ownership 权威（纯模块，无 I/O）。
 *
 * 同一时刻唯一回答：主窗口 locomotion position 权限归谁。
 *   LEGACY          — 现有 V1 walking writer（默认）
 *   V2_LOCOMOTION   — V2 episode 持有（token 绑定 episodeId/attemptId）
 *   EXTERNAL_DRAG   — 拖拽/外部占用（token 绑定 external 会话，kind=drag）
 *   NONE            — 引擎未运行
 *
 * 交接不变量（DRAG↔LOCOMOTION HANDOFF 核心）：
 * - 任一时刻只有一种 owner；V2→EXTERNAL_DRAG 交接是「先 release 再 acquire」，绝不并存；
 * - 每个 owner 变更加密新 token；旧 token（旧 episode/旧 drag 会话）在 release/re-acquire 后失效；
 * - externalAcquire 从 V2 直接抢占会被拒（调用方必须先 interrupt V2 并 release locomotion token），
 *   以「不能出现两者同时 current」为硬约束；
 * - legacy writer（walkSetPosition/applySeatPosition/seatExitStep）仅在 V2 持有时被真实拒绝，
 *   拒绝计数可观测（不是“碰巧没调用”）。
 */
"use strict";

const OWNERS = { LEGACY: "legacy", V2: "v2-locomotion", EXTERNAL: "external-drag", NONE: "none" };

function createMotionAuthority() {
  const state = {
    owner: OWNERS.LEGACY,
    token: 0,               // 最近一次 acquire（V2 或 EXTERNAL）的令牌；单调递增，release 不回收
    episodeId: null,        // V2 持有时的 episodeId
    attemptId: 0,
    externalKind: null,     // EXTERNAL 持有时的占用类型（"drag"）
    lastTransition: null    // {from,to,token,reason}（诊断交接顺序）
  };
  const denyCounts = {};

  function transition(to, token, reason) {
    state.lastTransition = { from: state.owner, to, token, reason: reason || null, at: token };
    state.owner = to;
    if (token !== undefined) state.token = token;
  }

  return {
    OWNERS,
    owner() { return state.owner; },
    token() { return state.token; },
    snapshot() {
      return {
        owner: state.owner, token: state.token, episodeId: state.episodeId, attemptId: state.attemptId,
        externalKind: state.externalKind, lastTransition: state.lastTransition, denyCounts: Object.assign({}, denyCounts)
      };
    },
    /**
     * V2 获取 locomotion 所有权。只允许从 LEGACY/NONE(→LEGACY) 进入；已 EXTERNAL 时拒绝（拖拽占用优先）。
     * 返回 {ok, token, attemptId}。
     */
    acquire(episodeId) {
      if (state.owner === OWNERS.V2) {
        if (state.episodeId === episodeId) return { ok: true, token: state.token, attemptId: state.attemptId, idempotent: true };
        return { ok: false, reason: "v2-busy:other-episode" };
      }
      if (state.owner === OWNERS.EXTERNAL) return { ok: false, reason: "external-occupied" };
      if (state.owner === OWNERS.NONE) return { ok: false, reason: "engine-off" };
      const from = state.owner;
      const token = state.token + 1;
      transition(OWNERS.V2, token, "acquire:" + episodeId);
      state.episodeId = String(episodeId);
      state.attemptId += 1;
      state.externalKind = null;
      return { ok: true, token, attemptId: state.attemptId, from };
    },
    /** V2 释放：回到 LEGACY。token 不重置（stale callback 永远对不上旧 token）。 */
    release(reason) {
      if (state.owner !== OWNERS.V2) return { token: state.token, reason: reason || null, noop: true };
      transition(OWNERS.LEGACY, undefined, "release:" + (reason || ""));
      const t = state.token;
      state.episodeId = null;
      return { token: t, reason: reason || null };
    },
    /**
     * 外部占用（拖拽）获取。只允许从 LEGACY 进入（V2 必须先被 interrupt+release，杜绝并存）。
     * 同 kind 重复 acquire 幂等返回当前 token。返回 {ok, token}。
     */
    externalAcquire(kind) {
      const k = String(kind || "drag");
      if (state.owner === OWNERS.EXTERNAL) {
        if (state.externalKind === k) return { ok: true, token: state.token, idempotent: true };
        return { ok: false, reason: "external-busy:" + state.externalKind };
      }
      if (state.owner === OWNERS.V2) return { ok: false, reason: "must-interrupt-v2-first" }; // 强制交接顺序
      if (state.owner === OWNERS.NONE) return { ok: false, reason: "engine-off" };
      const from = state.owner;
      const token = state.token + 1;
      transition(OWNERS.EXTERNAL, token, "external-acquire:" + k);
      state.externalKind = k;
      state.episodeId = null;
      return { ok: true, token, from };
    },
    /** 外部占用释放：回到 LEGACY（供下一次行为选择重新评估 canEnterSlice）。 */
    externalRelease(reason) {
      if (state.owner !== OWNERS.EXTERNAL) return { token: state.token, noop: true };
      transition(OWNERS.LEGACY, undefined, "external-release:" + (reason || ""));
      const t = state.token;
      state.externalKind = null;
      return { token: t, reason: reason || null };
    },
    /** 当前 V2 ownership 是否仍属于该 token+episode（commit/legacy-writer 的准入查询）。 */
    isCurrent(token, episodeId) {
      return state.owner === OWNERS.V2 && state.token === token && state.episodeId === episodeId;
    },
    /** 当前 EXTERNAL ownership 是否仍属于该 token（drag 会话迟到的 commit 拒绝）。 */
    isExternalCurrent(token) {
      return state.owner === OWNERS.EXTERNAL && Number.isSafeInteger(token) && state.token === token;
    },
    ownsV2() { return state.owner === OWNERS.V2; },
    ownsExternal() { return state.owner === OWNERS.EXTERNAL; },
    /**
     * 统一 position admission（本轮 Closure 的核心：owner 是窗口写权限的唯一事实来源）。
     * writerClass：
     *   "legacy"          — 仅 owner∈{LEGACY,NONE} 允许（V2/EXTERNAL 持有时一律拒）
     *   "v2-locomotion"   — 仅当前有效 V2 token+episode 允许
     *   "external-drag"   — 仅当前有效 external token 允许
     * NONE 对普通 locomotion 写开放无意义（walkTick 停），但放置/几何写（clamp/reposition）
     * 在 NONE（引擎停）仍允许，避免引擎停止时显示器变化把角色留在屏外。
     * 返回 {ok, reason}；不产生副作用（判定纯查询）。
     */
    positionAdmit(writerClass, ctx = {}) {
      if (writerClass === "v2-locomotion") {
        return this.isCurrent(ctx.token, ctx.episodeId)
          ? { ok: true } : { ok: false, reason: "stale-or-not-owner" };
      }
      if (writerClass === "external-drag") {
        return this.isExternalCurrent(ctx.externalToken)
          ? { ok: true } : { ok: false, reason: "not-external-owner" };
      }
      // legacy（含放置/几何/guard 写）：EXTERNAL_DRAG 与 V2_LOCOMOTION 持有时被拒（对称闭合）
      if (state.owner === OWNERS.V2) return { ok: false, reason: "owner-v2" };
      if (state.owner === OWNERS.EXTERNAL) return { ok: false, reason: "owner-external-drag" };
      return { ok: true };
    },
    /** 供 guard/clamp 等「非 commit 的 legacy 放置写」在回调执行时快速判定是否被占用。 */
    isLegacyBlocked() {
      return state.owner === OWNERS.V2 || state.owner === OWNERS.EXTERNAL;
    },
    /** V2/EXTERNAL 持有时，旧 V1 legacy writer 的真实拒绝（计数供诊断/测试证明不是“碰巧没调用”）。 */
    denyLegacyWriter(caller) {
      if (!this.isLegacyBlocked()) return false;
      const k = String(caller || "unknown");
      denyCounts[k] = (denyCounts[k] || 0) + 1;
      return true;
    },
    engineOff() { if (state.owner === OWNERS.V2 || state.owner === OWNERS.EXTERNAL) { /* 上层先 release */ } transition(OWNERS.NONE, undefined, "engine-off"); state.episodeId = null; state.externalKind = null; },
    engineOn() { if (state.owner === OWNERS.NONE) state.owner = OWNERS.LEGACY; }
  };
}

module.exports = { createMotionAuthority, OWNERS };
