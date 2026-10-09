"use strict";

// 双端文件：Node 下单测 require，渲染层 <script> 引入时挂 window.SpineArbitration。
// src 按 Node 环境 lint，故显式声明 window 全局（实际使用有 typeof 守卫）。
/* global window */

/**
 * Spine 动画所有权仲裁的纯决策（Phase 3C 行为收口）。
 * 不依赖 DOM/PIXI/Electron；渲染层把观察值传进来，拿回决策。
 *
 * 背景（2026-10-09 实机基线 §14-2）：playSpineInteract 此前在 spinePhaseAnim() 返回
 * null（walk 引擎非 active / 站立静止）时直接 return，导致合法 pat 丢失 Interact 动画。
 * 与 reconcileSpineAnimation 的 `spinePhaseAnim() || spineAnimForMood("idle")` 先例对齐：
 * 恢复目标优先取当前 locomotion 相位动画，无相位时回落 idle 映射。
 */

// 情绪 → 候选 Spine 动画名（首位=专属动画，其后=降级动画）。
// 单一事实源：spineAnimForMood 与 spineMoodCapability 都读这张表。
const MOOD_ANIM_MAP = {
  idle: ["Relax", "Idle", "idle", "animation", "stand"],
  happy: ["happy", "Happy", "Relax"],
  think: ["think", "Think", "Sit", "Relax"],
  sleep: ["Sleep", "Sleepd", "sleep", "Sit", "Relax"], // Sleepd：明日方舟 d 后缀循环惯例
  wave: ["wave", "Wave", "Interact"],
  angry: ["angry", "Angry", "Relax"],
  surprised: ["surprise", "Surprised", "Interact"]
};

/**
 * pat/interact 结束后排队恢复的动画名。
 * phaseAnim 非空（locomotion 有当前相位）→ 用它；否则用 idleAnim；两者皆空 → null（无动画可恢复）。
 */
function decideInteractRecovery({ phaseAnim = null, idleAnim = null } = {}) {
  return phaseAnim || idleAnim || null;
}

/**
 * 某 mood 对当前皮肤动画集的真实能力级别：
 *  - exact：mood 同名动画存在，或映射表首位候选存在（专属动画）
 *  - fallback：仅映射表非首位候选命中（借来的降级动画，如 happy→Relax）
 *  - unsupported：mood 无同名、无映射候选命中（将走「回退到第一个可用动画」兜底）
 * hasAnim(name) 由渲染层注入（查 spineData），纯逻辑不碰模型对象。
 */
function classifyMoodCapability({ mood, hasAnim, map = MOOD_ANIM_MAP } = {}) {
  if (typeof hasAnim !== "function") return "unsupported";
  if (mood && hasAnim(mood)) return "exact";
  const cands = map[mood] || [mood];
  if (cands.length && hasAnim(cands[0])) return "exact";
  for (let i = 1; i < cands.length; i++) {
    if (cands[i] && hasAnim(cands[i])) return "fallback";
  }
  return "unsupported";
}

if (typeof module !== "undefined" && module.exports) module.exports = { MOOD_ANIM_MAP, decideInteractRecovery, classifyMoodCapability };
if (typeof window !== "undefined") window.SpineArbitration = { MOOD_ANIM_MAP, decideInteractRecovery, classifyMoodCapability };
