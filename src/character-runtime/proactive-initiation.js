"use strict";

/**
 * proactive-initiation.js — 「有没有未完成的计划 → 要不要主动开口」决策纯函数（Phase 8-D）
 *
 * 命题（Level-3 因果输入的第一个）：
 *   持久化经历不只是改变「说什么」（Phase 7-C/7-E 的 content 级联），
 *   还可以改变「这一次到底说不说」——即是否自主发起一次 proactive interaction。
 *
 * 现状结构（Phase 8-C 冻结）：src/features.js 的 startProactive setInterval 闭包里，
 * `Math.random() > proactiveCfg.chance` 是唯一的 ACT / NO_ACT 判定点（外层门，chance=0.18）。
 * 一旦放行，后面的内容级联最终必然产出一条 prompt 并调用 sendFn。因此
 *     P(send | eligible tick) === 外层门的放行概率
 * 本模块替换的**只有**这个概率的取值，不触碰内联级联、也不触碰投递安全闸门。
 *
 * 纯度约束（测试强制，与 experience-topic.js / plan-completion.js / sleep-intent.js 同款）：
 *   不 require 任何模块（memory/config/fs/electron 一律不得引入）、不读 Date、
 *   不用 Math.random、不开 timer、不碰 DOM/IPC、无任何 mutation、无可变单例。
 *   输入全部显式传入（facts / baseChance / enabled）。
 *
 * 纪律边界（结论必须保留）：
 *   - 这**不是** general autonomous action choice：当前 primitive 仍然只有
 *     ACT（一次主动交互）与 NO_ACT（return）。没有 Action enum / action bus /
 *     behavior planner / multi-action chooser，本轮也不需要。
 *   - PLAN 直接进入 action policy，中间**不经过任何人格标量**
 *     （没有 initiative / sociability / trust / engagement / urgency / concern meter）。
 *   - 只认 type:"event" 这一个当前单槽 PLAN 身份（Phase 7-F 已冻结）。
 *     不 parse 文本、不读 anchor、不读 history/health/outcome。
 *   - 角色意图 ≠ 投递许可：本模块只决定「是否尝试发起」；
 *     窗口可见 / 离开模式 / 台词冷却去重仍然全部由 main.js 的 sendProactive 独占。
 */

/**
 * EXPERIMENTAL CAUSAL PROBE — NOT PERSONALITY TUNING
 *
 * 存在未完成计划时给外层门加的固定增量。取值只为本轮单 tick A/B 提供一条
 * 便于确定性取样的分离带（baseChance < r <= baseChance + PLAN_BOOST）；
 * 它**不是**「正确的人格参数」，也不代表苏苏洛应该这么主动。
 * 任何把它固化进产品行为的改动都超出本轮实验范围。
 */
const PLAN_BOOST = 0.12;

/** Feature gate：默认 OFF（config DEFAULTS 里就是 false）。只读配置，不写配置。 */
function characterRuntimePlanInitiationV0Enabled(cfg) {
  return !!(cfg && cfg.characterRuntimePlanInitiationV0Enabled === true);
}

/**
 * PLAN 检测：只认 type:"event"（Phase 7-F 冻结的当前单槽计划身份）。
 * 与 chooseExperienceTopic / resolvePlanCompletion 同款取用方式，
 * 不读文本、不读 anchor、不看 history:* / health / joy。
 */
function hasPlannedFact(facts) {
  const list = Array.isArray(facts) ? facts : [];
  return list.some((f) => f && f.type === "event");
}

/**
 * 有效主动发起概率。
 *
 * 优先级纪律（OFF 逐位等同 baseline 是硬约束）：
 *   1. gate 不是 true            → 原样返回 baseChance（不 clamp、不加 boost、不读 facts）；
 *   2. 没有 PLAN                 → 原样返回 baseChance（同上）；
 *   3. baseChance 非有限数       → 原样返回（维持既有比较语义，见下）；
 *   4. 其余                       → min(1, max(0, baseChance + PLAN_BOOST))。
 *
 * 第 3 条为什么必须原样返回：生产里 main.js 的 `pet:set-proactive-chat` 处理器把
 * proactiveStateFn 传在了 chance 的位置（既有参数错位，未在本轮修），此时
 * `Math.random() > chance` 是与 NaN 比较、恒为 false。若此时把非法值夹成 0，
 * 就会把「总会开口」翻成「永不开口」——那是对既有生产路径的语义改动。
 * 因此：凡是非有限数，一律 pass-through，OFF/ON 都不干预。
 *
 * @param {Object} input
 *   - facts: memory.getFactsList() 的形状 [{id,type,text,anchor}]
 *   - baseChance: 生产外层门的既有概率（features.js 传 proactiveCfg.chance）
 *   - enabled: 调用方已解析好的布尔 gate（config 只在调用侧读一次）
 * @returns {number} 0 <= chance <= 1（baseChance 本身非法时按上文 pass-through）
 */
function effectiveInitiateChance({ facts, baseChance, enabled } = {}) {
  if (enabled !== true) return baseChance;                 // OFF：逐位等同 baseline
  if (!hasPlannedFact(facts)) return baseChance;            // ON + 无 PLAN：同上
  if (typeof baseChance !== "number" || !Number.isFinite(baseChance)) return baseChance;
  return Math.min(1, Math.max(0, baseChance + PLAN_BOOST));
}

module.exports = {
  effectiveInitiateChance,
  hasPlannedFact,
  characterRuntimePlanInitiationV0Enabled,
  // 导出实验常量供测试锁定契约
  PLAN_BOOST,
};
