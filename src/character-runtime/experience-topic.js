"use strict";

/**
 * experience-topic.js — 主动搭话「记忆由头」决策纯函数（Phase 7-C）
 *
 * 背景：src/features.js 的主动搭话早就在按持久化记忆事实分型选择台词
 * （生日必说 / 健康关切 / 近期安排助威 / 称谓）。这段决策原先埋在 setInterval 闭包里，
 * inline require + inline Math.random()，无法被单测。本模块把它**原样**抽出来：
 * 决策是 behavior-preserving extraction，**不改变任何产品语义与概率**。
 *
 * 纯度约束（测试强制）：不 require memory/config/fs/electron，不碰 DOM/IPC/timer，无可变单例。
 * 全部输入显式传入：facts（已由调用方从 memory 读出）、random（生产传 Math.random）、
 * now（生产传 new Date()）。
 *
 * 两条必须保持的行为细节（见 tests/experience-topic-characterization.test.js）：
 *  1. random() 的**调用次数与顺序**必须与旧实现逐位一致——
 *     `hasHealth && random() < p` / `ev && random() < p` / `name && random() < p`
 *     三处都依赖左项先求值；提前取值或复用共享随机数都会改变生产概率。
 *  2. 台词池数组必须**每次调用新建**——lines.pick 用 WeakMap 按数组实例记录最近选取，
 *     把它提升为模块常量会让 recentPicks 跨调用生效，从而改变生产选句行为。
 *
 * Phase 7-E 增量：在所有既有分支之后新增 history recall 分支（branch:"history"）。
 * 识别依据是 type 的 "history:" 命名空间前缀（如 history:ev-001，已完成历史经历的
 * 受控表示）；anchor 是展示分组概念，不作行为身份判定。纪律：只有 history:* 事实
 * 存在时才消费新增的一次 random——没有 history:* 事实时，既有四分支的 random
 * 次数与顺序逐位不变（characterization 与差分测试强制）。
 */

/** 生日命中：优先级最高，且该分支不消费 random（"今天一定开口"）。 */
function birthdayLines() {
  return [
    "（咦，今天好像是博士的生日？）生日快乐呀博士！要好好犒劳一下自己哦～",
    "（捧着小蛋糕）博士生日快乐！今天的愿望，我会帮你一起记着的～",
    "（认真脸）博士的生日我可没忘——今天不许加班太久，听到没？",
  ];
}

function healthLines() {
  return [
    "（想起你之前说不太舒服）……博士，身体还好吗？别忘了多喝热水，不舒服要跟我说。",
    "（小声）博士，今天身体怎么样？有没有比昨天好一点？",
    "（递热水）记得你说过不太舒服——今天好点了吗？别硬撑哦。",
  ];
}

function eventLines(what) {
  return [
    "（记得你最近有" + what + "的安排）博士加油呀～我会在旁边给你打气的！",
    what + " 准备得怎么样啦？别太累，慢慢来～",
    "（掰手指算日子）" + what + " 快到了吧？博士一定没问题的！",
  ];
}

function nameLines(name) {
  return [
    "（今天也记得要这样叫博士）" + name + "～有没有按时喝水呀？",
    name + "～忙归忙，眼睛要休息哦。",
    "（清了清嗓子）" + name + "！……没什么，就是想叫叫你～",
  ];
}

const HEALTH_CHANCE = 0.3;
const EVENT_CHANCE = 0.25;
const NAME_CHANCE = 0.2;
// EXPERIMENTAL COMPLETED-HISTORY CAUSAL PROBE — NOT PERSONALITY TUNING：
// Phase 7-E 因果实验用的回忆概率，该取值本身不是产品研究结论。
const HISTORY_RECALL_CHANCE = 0.2;

/** 与 memory.hasHealthFact() 等价：同一批事实，只看 type==="health"。 */
function hasHealthFact(facts) {
  return facts.some((f) => f && f.type === "health");
}

/** 生日事实：text 里的 M月D日 必须等于今天。取第一条匹配（find）。 */
function birthdayFactToday(facts, now) {
  const today = (now.getMonth() + 1) + "|" + now.getDate();
  return facts.find((f) => f && f.type === "birthday"
    && (String(f.text || "").match(/(\d{1,2})月(\d{1,2})日/) || []).slice(1).join("|") === today);
}

/** 取最后一条 event 事实（filter().pop()）；没有则 null —— null 时不消费 random。 */
function lastEventFact(facts) {
  return facts.filter((f) => f && f.type === "event").pop() || null;
}

/** 取第一条 name 事实并解析出「」中的称呼；解析不出返回 null —— null 时不消费 random。 */
function nameFactCallname(facts) {
  const nm = facts.find((f) => f && f.type === "name");
  return (nm && (String(nm.text || "").match(/「(.+?)」/) || [])[1]) || null;
}

/** Phase 7-E：历史经历事实识别——只认 type 的 "history:" 命名空间前缀（如 history:ev-001）。
 *  不用 anchor==="EVENT" 判定：那是展示分组概念，且与生日共用。多条时与 event 分支
 *  同款 filter().pop() 取最后一条，不引入排序框架。 */
function lastHistoryFact(facts) {
  return facts.filter((f) => f && typeof f.type === "string" && f.type.startsWith("history:")).pop() || null;
}

/** 已完成历史经历的回忆台词。语义必须是「回忆已经发生过、已结束的事」，
 *  禁止未来计划语义（快到了/准备得怎么样）。与其它分支相同：每次调用新建数组
 *  （lines.pick 按 WeakMap 数组实例记录最近选取，共享常量池会改变 cross-call 选句行为）。 */
function historyLines(text) {
  return [
    "（想起之前那件事）「" + text + "」——已经结束啦，现在想起来还很清楚呢。",
    "博士，上次「" + text + "」……我一直记得哦。",
    "（翻着记忆的小本子）「" + text + "」，虽然那件事已经结束了，想起来还是觉得很踏实。",
  ];
}

/**
 * 记忆由头决策。
 *
 * @param {Object} input
 *   - facts: memory.getFactsList() 的形状 [{id,type,text,anchor}]（旧实现同样只在 facts 非空时决策）
 *   - random: () => [0,1)，生产传 Math.random；测试传确定性序列
 *   - now: Date，仅生日分支使用
 * @returns {{branch: "birthday"|"health"|"event"|"name"|"history", lines: string[]}|null}
 *   null = 本次没有记忆由头，调用方走原有 fallback（第二信号源 / 常规台词）路径。
 */
function chooseExperienceTopic({ facts, random, now } = {}) {
  const list = Array.isArray(facts) ? facts : [];
  if (!list.length) return null; // 旧实现：facts 为空时整块跳过，不消费 random

  if (birthdayFactToday(list, now)) return { branch: "birthday", lines: birthdayLines() };

  if (hasHealthFact(list) && random() < HEALTH_CHANCE) return { branch: "health", lines: healthLines() };

  const ev = lastEventFact(list);
  if (ev && random() < EVENT_CHANCE) {
    const what = (String(ev.text || "").match(/「(.+?)」/) || [])[1] || "那件重要的事";
    return { branch: "event", lines: eventLines(what) };
  }

  const name = nameFactCallname(list);
  if (name && random() < NAME_CHANCE) return { branch: "name", lines: nameLines(name) };

  // EXPERIMENTAL COMPLETED-HISTORY CAUSAL PROBE — NOT PERSONALITY TUNING：
  // 已完成历史经历在原本即将 fallback 时提供一次回忆由头（Phase 7-E）。
  // 纪律：history 事实不存在时 && 短路，random 不被消费——既有用户的
  // random 序列逐位不变（tests/experience-topic-characterization.test.js 强制）。
  const hist = lastHistoryFact(list);
  if (hist && random() < HISTORY_RECALL_CHANCE) {
    const text = String(hist.text || "").trim() || "那件已经结束的事";
    return { branch: "history", lines: historyLines(text) };
  }

  return null;
}

module.exports = {
  chooseExperienceTopic,
  // 导出阈值供测试锁定；生产不需要
  HEALTH_CHANCE,
  EVENT_CHANCE,
  NAME_CHANCE,
  HISTORY_RECALL_CHANCE
};