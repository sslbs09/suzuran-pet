"use strict";

/**
 * plan-completion.js — 「未来计划 → 已完成历史经历」生命周期判定纯函数（Phase 7-F1）
 *
 * 命题：一条持久化的 PLANNED 事实（type:"event" / anchor:"PLAN"），能否由**用户一句
 * 显式完成确认**确定性地转换成 COMPLETED 历史经历（type:"history:<planFact.id>" /
 * anchor:"EVENT"），使之后的自主行为从「future plan 助威」切换为「completed history 回忆」。
 *
 * 权限边界（本轮唯一 completion authority）：
 *  - authority = Explicit User Confirmation + Deterministic Rule；
 *  - **不是** LLM、不是 embedding/vector、不是时间到期推断、不是 runtime 观察。
 *  理由：已发生事件的 lifecycle truth 不得随模型更换而改变（model-independent）。
 *  LLM 未来最多只能做 suggestion，不能做 lifecycle truth 的唯一 writer。
 *
 * 纯度约束（测试强制）：不 require memory/config/fs/electron，不碰 DOM/IPC/timer，
 * 不读 Date、不用 Math.random、无任何 mutation。全部输入显式传入（facts / userText），
 * 产物只是一段「判定结果 + 待写入事实的描述」，真正的持久化由调用方用 memory 既有
 * API（deleteFact / addFacts）完成——本模块不持有 lifecycle truth 的写权限。
 *
 * 语义边界（结论必须保留）：
 *  - 本轮**只**实现 PLANNED → COMPLETED 两态；不实现 ACTIVE/PAUSED/FAILED/CANCELLED/
 *    EXPIRED/ARCHIVED。「考试取消了」= NOT SUPPORTED，且**不得**被误判为 completed。
 *  - PLAN 是单槽位（type 即身份），本轮接受「同一时刻只有一个未来计划」这一既有限制；
 *    multi-plan 并发不在本轮范围。
 *  - subject 抽取只认 extractFacts 的稳定格式 `博士近期有「{subject}」的安排`；
 *    不含「」的 PLAN（设置页手写、用户编辑过）一律 NOT SUPPORTED，**不做 fuzzy fallback**。
 */

/* ---- 显式完成信号：极窄词表，宁可漏判不可误判 ---- */
/* 可接受：考试结束了 / 考试已经结束 / 已经完成考试 / 考试考完了 / 考试做完了 / 考试搞定了 */
const COMPLETION_VERB = /(?:已经|已|刚刚|总算|终于)?\s*(?:结束|完成|做完|考完|办完|搞定|通过)(?:了|啦|咯|吧)?/;

/* ---- 否定 / 取消 / 失败守卫：优先于正向动词 ---- */
/* 覆盖：还没结束、尚未完成、没做完、不能结束、不会完成、未结束、考试取消了、考试延期了、
 *   推迟了、暂停了、失败了、放弃了。纯漏判风险条目一律进守卫，宁可少转不可错转。 */
const NEGATION_GUARD = /还没|没有|没|未|不|取消|延期|推迟|暂停|失败|放弃|改期|泡汤/;

/** HISTORY 事实的 type：identity 沿用 PLAN fact 的持久 id（见文件头 F1-9 裁决）。 */
const HISTORY_TYPE_PREFIX = "history:";

/** PLAN 文本 → subject：只认 extractFacts 的「」格式；解析不出返回 null（NOT SUPPORTED）。 */
function planSubject(planText) {
  const m = String(planText || "").match(/「(.+?)」/);
  return m ? m[1] : null;
}

/** PLAN fact id → HISTORY type。不引入 Date.now / random UUID / 文本 hash。 */
function historyTypeForPlan(planId) {
  return HISTORY_TYPE_PREFIX + String(planId || "");
}

/** subject → 已完成历史经历的过去式文本。不得复制原 PLAN 文本（future tense 是错误语义）。 */
function completedHistoryText(subject) {
  return "博士已经完成" + String(subject || "");
}

/** 当前 facts 中处于 PLANNED 的计划事实（type:"event" 是单槽位，取最后一条，与 chooser 同款）。 */
function lastPlannedFact(facts) {
  const list = Array.isArray(facts) ? facts : [];
  return list.filter((f) => f && f.type === "event").pop() || null;
}

/**
 * 判定：本条用户话语是否**明确完成了**当前计划。
 *
 * @param {Object} input
 *   - facts: memory.getFactsList() 的形状 [{id,type,text,anchor}]
 *   - userText: 本条用户消息原文
 * @returns {{matchedPlan: Object, subject: string,
 *            history: {type: string, text: string, anchor: string}}|null}
 *   null = 本条话语没有完成当前计划（调用方不做任何 mutation）。
 *   history 是**待写入事实的纯描述**（identity/text/anchor 全部在此收口），
 *   调用方只需 deleteFact(matchedPlan.id) + addFacts([history])。
 */
function resolvePlanCompletion({ facts, userText } = {}) {
  const plan = lastPlannedFact(facts);
  if (!plan) return null; // 无计划：没有任何东西可以被完成

  const t = String(userText || "");
  if (!t) return null;

  // 守卫优先：否定/取消/失败一律不转换（绝不误判成 completed）
  if (NEGATION_GUARD.test(t)) return null;
  if (!COMPLETION_VERB.test(t)) return null;

  const subject = planSubject(plan.text);
  if (!subject) return null; // 不含「」的 PLAN → NOT SUPPORTED，无 fuzzy fallback

  // 必须命中同一个 subject：「作业做完了」绝不能完成「考试」计划
  if (!t.includes(subject)) return null;

  return {
    matchedPlan: plan,
    subject,
    history: {
      type: historyTypeForPlan(plan.id),
      text: completedHistoryText(subject),
      anchor: "EVENT", // 必须显式：未知 dynamic type 经 anchorOf() 会落入 PREFERENCE
    },
  };
}

module.exports = {
  resolvePlanCompletion,
  // 以下为纯构造/判定辅助，导出供测试锁定契约；生产只用 resolvePlanCompletion
  planSubject,
  historyTypeForPlan,
  completedHistoryText,
  lastPlannedFact,
  HISTORY_TYPE_PREFIX,
  COMPLETION_VERB,
  NEGATION_GUARD,
};
