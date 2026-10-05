"use strict";

/**
 * Phase 7-F1 — EXPLICIT PLAN COMPLETION LIFECYCLE CAUSAL EXPERIMENT
 *
 * 链条：真实聊天输入 → extractFacts 产出 PLAN → 用户显式完成确认 → 确定性生命周期
 *       转换（PLAN 退场 / history:<planFactId> 进场）→ 持久化 → 模块重载 / 真实新进程
 *       → 之后的自主决策从「future plan 助威」切换为「completed history 回忆」。
 *
 * 这是第一次由**现实聊天输入**接到 history:<id>，而不是测试直接塞 history 记录
 * （Phase 7-E 由受控合成表示提供）。
 *
 * 语义边界（结论必须保留）：
 *  - completion authority = 显式用户确认 + 确定性规则；不是 LLM / embedding / 时间到期。
 *  - 本轮只实现 PLANNED → COMPLETED 两态；「考试取消了」NOT SUPPORTED 且绝不误判。
 *  - PLAN 是单槽位；multi-plan 并发不在本轮范围。
 *  - general semantic event-completion detection 仍是 NOT DEMONSTRATED。
 *
 * 存储纪律：SUZURAN_TEST_USERDIR + mkdtemp，全程零真实 memory.json 接触。
 * 子进程纪律：重启探针是静态脚本 tests/fixtures/p7f1-restart-probe.cjs，全字面量参数。
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "suzuran-p7f1-"));
process.env.SUZURAN_TEST_USERDIR = TMP; // 必须在 require config/memory 之前；子进程经环境继承

const memory = require("../src/memory");
const { chooseExperienceTopic } = require("../src/character-runtime/experience-topic");
const {
  resolvePlanCompletion,
  planSubject,
  historyTypeForPlan,
  completedHistoryText,
  lastPlannedFact,
  HISTORY_TYPE_PREFIX,
} = require("../src/character-runtime/plan-completion");

const NOW = new Date(2026, 9, 5);

/** 走真实生产提取路径：用户原话 → extractFacts → PLAN 事实（不是手写 PLAN） */
const PLAN_UTTERANCE = "下周要准备考试";
const PLAN_TEXT = "博士近期有「考试」的安排";
const SUBJECT = "考试";
const COMPLETION_UTTERANCE = "考试已经结束了";

/** 对照基线：type "joy" 不命中任何 chooser 分支，保证 A/B 唯一变量是生命周期状态 */
const BASELINE_FACT = { type: "joy", text: "TEST_ONLY_BASELINE" };

function reset() { memory.clear(); }
function facts() { return memory.getFactsList(); }
function types() { return facts().map((f) => f.type); }
function planned() { return facts().find((f) => f.type === "event") || null; }
function histories() { return facts().filter((f) => String(f.type).startsWith(HISTORY_TYPE_PREFIX)); }
function historyOf(planId) { return facts().find((f) => f.type === historyTypeForPlan(planId)) || null; }

/** 确定性随机源：记录消费次数 */
function countedRandom(values = [0.0]) {
  const seq = Array.isArray(values) ? values : [values];
  let n = 0;
  const fn = () => { const v = seq[Math.min(n, seq.length - 1)]; n += 1; return v; };
  fn.consumed = () => n;
  return fn;
}
function branchOf(choice) { return choice ? choice.branch : null; }
function decide(random, list = facts(), now = NOW) {
  return chooseExperienceTopic({ facts: list, random, now });
}

/** 通过真实聊天入口建立 PLAN：extractFacts(utterance) → addFacts（与 main.js 同一路径） */
function establishPlan(utterance = PLAN_UTTERANCE, subject = SUBJECT) {
  memory.addFacts(memory.extractFacts(utterance));
  const plan = planned();
  assert.ok(plan, "PLAN 必须由真实 extractFacts 路径产出：" + utterance);
  assert.equal(plan.text, "博士近期有「" + subject + "」的安排");
  assert.equal(plan.anchor, "PLAN");
  return plan;
}

/** 调用方侧 mutation：与 main.js 接线完全一致的两步（delete PLAN + add HISTORY） */
function applyCompletion(userText) {
  const completion = resolvePlanCompletion({ facts: memory.getFactsList(), userText });
  if (!completion) return { applied: false };
  memory.deleteFact(completion.matchedPlan.id);
  memory.addFacts([completion.history]);
  return { applied: true, completion };
}

/* ================= 前置 / 纯度 ================= */

test("前置：隔离存储生效，绝不触碰真实 memory.json", () => {
  assert.equal(path.resolve(TMP).startsWith(path.resolve(os.tmpdir())), true);
});

test("纯度契约：模块无 require / 无 Date / 无 Math.random / 无 fs（静态）", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "character-runtime", "plan-completion.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")   // 去掉块注释
    .replace(/^\s*\/\/.*$/gm, "");       // 去掉行注释
  assert.doesNotMatch(src, /\brequire\s*\(/, "禁止 require（memory/config/fs/electron 一律不得引入）");
  assert.doesNotMatch(src, /\bDate\b/, "禁止读取当前时间");
  assert.doesNotMatch(src, /Math\s*\.\s*random/, "禁止随机源");
  assert.doesNotMatch(src, /\bfs\b/, "禁止文件系统");
});

test("纯度契约：resolver 对空/畸形输入返回 null，不抛异常", () => {
  assert.equal(resolvePlanCompletion(), null);
  assert.equal(resolvePlanCompletion({}), null);
  assert.equal(resolvePlanCompletion({ facts: null, userText: "考试结束了" }), null);
  assert.equal(resolvePlanCompletion({ facts: "not-an-array", userText: "考试结束了" }), null);
  reset();
  memory.addFacts([BASELINE_FACT]);
  assert.equal(resolvePlanCompletion({ facts: facts(), userText: "" }), null);
  assert.equal(resolvePlanCompletion({ facts: facts(), userText: null }), null);
});

/* ================= subject 抽取 / identity ================= */

test("subject 抽取：只认 extractFacts 的「」格式", () => {
  assert.equal(planSubject(PLAN_TEXT), SUBJECT);
  assert.equal(planSubject("博士近期有「面试」的安排"), "面试");
  assert.equal(planSubject("博士喜欢「奶茶」"), "奶茶");
});

test("subject 抽取：不含「」的 PLAN 一律 null（NOT SUPPORTED，无 fuzzy fallback）", () => {
  assert.equal(planSubject("下周有安排"), null);
  assert.equal(planSubject(""), null);
  assert.equal(planSubject(undefined), null);
});

test("PLAN 不含「」时即使出现完成动词也不转换", () => {
  reset();
  memory.addFacts([{ type: "event", text: "下周有安排", anchor: "PLAN" }]);
  assert.equal(resolvePlanCompletion({ facts: facts(), userText: "下周有安排结束了" }), null);
  assert.ok(planned(), "PLAN 必须原样保留");
});

test("identity：history type 沿用 PLAN fact id，不引入时间/随机/文本 hash", () => {
  reset();
  const plan = establishPlan();
  const hit = resolvePlanCompletion({ facts: facts(), userText: COMPLETION_UTTERANCE });
  assert.equal(hit.history.type, "history:" + plan.id);
  assert.equal(hit.history.type, historyTypeForPlan(plan.id));
  assert.doesNotMatch(hit.history.type, /Date|\d{10,}/, "identity 不得来自时间戳");
});

test("past-tense：HISTORY 文本是过去式，不得复制 PLAN 的 future tense 文本", () => {
  reset();
  const plan = establishPlan();
  const hit = resolvePlanCompletion({ facts: facts(), userText: COMPLETION_UTTERANCE });
  assert.equal(hit.history.text, "博士已经完成" + SUBJECT);
  assert.equal(hit.history.text, completedHistoryText(SUBJECT));
  assert.notEqual(hit.history.text, plan.text);
  assert.doesNotMatch(hit.history.text, /近期|安排|将要/, "禁止 future tense 语义：" + hit.history.text);
});

test("anchor：HISTORY 必须显式 EVENT（否则未知 dynamic type 会落入 PREFERENCE）", () => {
  reset();
  establishPlan();
  const hit = resolvePlanCompletion({ facts: facts(), userText: COMPLETION_UTTERANCE });
  assert.equal(hit.history.anchor, "EVENT");
  assert.equal(memory.anchorOf(HISTORY_TYPE_PREFIX + "x"), "PREFERENCE", "前提：未显式指定会落 PREFERENCE");
});

/* ================= 支持范围（窄词表，测试即定义） ================= */

const SUPPORTED_COMPLETIONS = [
  "考试已经结束了",
  "考试结束了",
  "已经完成考试",
  "考试完成了",
  "考试考完了",
  "考完考试了",
  "考试做完了",
  "考试搞定了",
  "考试办完了",
  "考试通过了",
];

test("支持范围：显式完成措辞必须命中当前 PLAN subject", () => {
  for (const utterance of SUPPORTED_COMPLETIONS) {
    reset();
    establishPlan();
    const hit = resolvePlanCompletion({ facts: facts(), userText: utterance });
    assert.ok(hit, "应当转换：" + utterance);
    assert.equal(hit.subject, SUBJECT, utterance);
  }
});

test("不支持范围：普通/寒暄/无完成语义不得转换", () => {
  for (const utterance of ["今天天气不错啊", "考试还有多久", "我有点紧张", "", "博士呢"]) {
    reset();
    establishPlan();
    assert.equal(resolvePlanCompletion({ facts: facts(), userText: utterance }), null, utterance);
  }
});

/* ================= negative guards（F1-7 / F1-14 误转移风险） ================= */

const NEGATED_OR_CANCELLED = [
  "考试还没结束",
  "考试没有结束",
  "考试没完成",
  "考试尚未完成",
  "考试没做完",
  "考试不能结束",
  "考试不会完成",
  "考试取消了",
  "考试延期了",
  "考试推迟了",
  "考试暂停了",
  "考试失败了",
  "考试放弃了",
];

test("negative guard：否定/取消/失败一律不得被判为 completed", () => {
  for (const utterance of NEGATED_OR_CANCELLED) {
    reset();
    const plan = establishPlan();
    assert.equal(resolvePlanCompletion({ facts: facts(), userText: utterance }), null, utterance);
    assert.ok(planned(), "PLAN 必须原样保留：" + utterance);
    assert.equal(histories().length, 0, utterance);
    applyCompletion(utterance);
    assert.ok(planned(), "apply 后 PLAN 仍在：" + utterance);
    assert.equal(histories().length, 0, utterance);
  }
});

test("negative guard 优先于正向动词：'还没结束'含'结束'但不得转换", () => {
  reset();
  establishPlan();
  assert.ok("考试还没结束".includes("结束"), "前提：正向动词确实出现在文本里");
  assert.equal(resolvePlanCompletion({ facts: facts(), userText: "考试还没结束" }), null);
});

/* ================= A/B/C/D/E counterfactual ================= */

test("A：PLAN=考试 + 「考试已经结束了」→ 转换", () => {
  reset();
  const plan = establishPlan();
  const hit = resolvePlanCompletion({ facts: facts(), userText: COMPLETION_UTTERANCE });
  assert.ok(hit);
  assert.equal(hit.matchedPlan.id, plan.id);
  assert.equal(hit.subject, SUBJECT);
});

test("B：PLAN=考试 + 「作业做完了」→ 不转换（subject 不匹配）", () => {
  reset();
  establishPlan();
  assert.ok("作业做完了".includes("做完"), "前提：正向动词存在");
  assert.equal(resolvePlanCompletion({ facts: facts(), userText: "作业做完了" }), null);
  assert.ok(planned(), "PLAN 必须原样保留");
});

test("C：PLAN=考试 + 「考试还没结束」→ 不转换（否定守卫）", () => {
  reset();
  establishPlan();
  assert.equal(resolvePlanCompletion({ facts: facts(), userText: "考试还没结束" }), null);
  assert.ok(planned());
});

test("D：PLAN=考试 + 「考试取消了」→ 不转换（NOT SUPPORTED，绝不误判）", () => {
  reset();
  establishPlan();
  assert.equal(resolvePlanCompletion({ facts: facts(), userText: "考试取消了" }), null);
  assert.ok(planned());
  assert.equal(histories().length, 0);
});

test("E：无 PLAN + 「考试已经结束了」→ 不转换", () => {
  reset();
  memory.addFacts([BASELINE_FACT]);
  assert.equal(resolvePlanCompletion({ facts: facts(), userText: COMPLETION_UTTERANCE }), null);
  assert.equal(histories().length, 0);
});

test("E2：不同 subject 的计划互不误转", () => {
  reset();
  establishPlan("下周要准备面试", "面试");
  assert.equal(planned().text, "博士近期有「面试」的安排");
  assert.equal(resolvePlanCompletion({ facts: facts(), userText: "考试已经结束了" }), null,
    "面试计划不得被「考试结束了」完成");
  assert.ok(planned());
});

/* ================= PLAN → HISTORY mutation + identity ================= */

test("mutation：PLAN 退场，history:<planFactId> 进场（replace，非并存、非 in-place）", () => {
  reset();
  const plan = establishPlan();
  const r = applyCompletion(COMPLETION_UTTERANCE);
  assert.equal(r.applied, true);
  assert.equal(planned(), null, "PLAN 必须被删除（不得 PLAN+HISTORY 并存）");
  const hist = historyOf(plan.id);
  assert.ok(hist, "HISTORY 必须存在");
  assert.equal(hist.type, "history:" + plan.id);
  assert.equal(hist.text, "博士已经完成" + SUBJECT);
  assert.equal(hist.anchor, "EVENT");
  assert.notEqual(hist.id, plan.id, "addFacts 不接受 caller id：HISTORY 自有 fact.id，linkage 走 type namespace");
});

test("mutation 纪律：不得原地改写 PLAN 文本为过去式", () => {
  reset();
  const plan = establishPlan();
  applyCompletion(COMPLETION_UTTERANCE);
  assert.equal(facts().some((f) => f.type === "event"), false);
  assert.equal(facts().some((f) => f.text === plan.text), false, "PLAN 原文不得以任何形式留存");
});

test("mutation 纪律：历史事实在注入文本里离开「计划」分组", () => {
  reset();
  establishPlan();
  applyCompletion(COMPLETION_UTTERANCE);
  const injected = memory.getText();
  assert.ok(injected.includes("【重要日子】"), "HISTORY 应落在 EVENT 分组：" + injected);
  assert.equal(/【计划】/.test(injected), false, "PLAN 分组必须为空：" + injected);
});

/* ================= idempotence（F1-16） ================= */

test("幂等：同一句完成确认重复发送，history 始终只有 1 条", () => {
  reset();
  establishPlan();
  assert.equal(applyCompletion(COMPLETION_UTTERANCE).applied, true);
  assert.equal(histories().length, 1);
  for (let i = 0; i < 3; i++) {
    assert.equal(applyCompletion(COMPLETION_UTTERANCE).applied, false, "重复输入不得再转换");
  }
  assert.equal(histories().length, 1);
  assert.equal(planned(), null);
});

test("幂等第二层：即便 PLAN 与其 history 并存（同 type 覆盖语义），也不产生第二条", () => {
  reset();
  const plan = establishPlan();
  const hit = resolvePlanCompletion({ facts: facts(), userText: COMPLETION_UTTERANCE });
  memory.addFacts([hit.history]);
  memory.addFacts([hit.history]);
  memory.addFacts([hit.history]);
  assert.equal(histories().length, 1, "addFacts 同 type 覆盖保证不重复入库");
  memory.deleteFact(plan.id);
  assert.equal(histories().length, 1);
});

/* ================= 端到端因果：before → after（F1-18） ================= */

test("因果链：completion 前走 event 分支，completion 后走 history 分支", () => {
  reset();
  memory.addFacts([BASELINE_FACT]);
  const plan = establishPlan();

  // ---- Before：PLAN 存在 → 自主行为是「未来计划助威」 ----
  const before = decide(countedRandom(0.0));
  assert.equal(branchOf(before), "event");
  assert.ok(before.lines.every((l) => l.includes(SUBJECT)), "before 必须引用未来计划 subject");
  assert.equal(histories().length, 0);

  // ---- 用户显式完成确认 → 生命周期转换 ----
  assert.equal(applyCompletion(COMPLETION_UTTERANCE).applied, true);
  assert.equal(planned(), null);
  assert.ok(historyOf(plan.id));

  // ---- After：自主行为切换为「已完成历史回忆」 ----
  const after = decide(countedRandom(0.0));
  assert.equal(branchOf(after), "history");
  assert.ok(after.lines.every((l) => l.includes("博士已经完成" + SUBJECT)));
  assert.doesNotMatch(after.lines.join(""), /快到了|准备得怎么样/, "禁止未来计划语义");
  assert.notEqual(branchOf(before), branchOf(after), "生产可观察行为必须因生命周期转换而不同");
});

test("因果链：对照组（未完成）保持 event 分支 —— A/B 唯一变量是生命周期状态", () => {
  reset();
  memory.addFacts([BASELINE_FACT]);
  establishPlan();
  applyCompletion("作业做完了"); // 不匹配
  assert.equal(branchOf(decide(countedRandom(0.0))), "event", "未转换 ⇒ 行为不变");
  assert.equal(histories().length, 0);
});

/* ================= reload / 真实新进程（F1-19） ================= */

test("模块重载：转换后 PLAN 不再存在、HISTORY 仍在、并仍决定相同决策", () => {
  reset();
  memory.addFacts([BASELINE_FACT]);
  const plan = establishPlan();
  applyCompletion(COMPLETION_UTTERANCE);
  assert.equal(branchOf(decide(countedRandom(0.0))), "history");

  const memPath = require.resolve("../src/memory");
  const original = require.cache[memPath];
  delete require.cache[memPath];
  const reloaded = require("../src/memory"); // 新实例：从磁盘 load
  const after = reloaded.getFactsList();
  assert.equal(after.some((f) => f.type === "event"), false, "重载后 PLAN 不得复活");
  assert.ok(after.some((f) => f.type === historyTypeForPlan(plan.id)), "重载后 HISTORY 仍在");
  assert.equal(branchOf(chooseExperienceTopic({ facts: after, random: countedRandom(0.0), now: NOW })), "history");

  require.cache[memPath] = original; // 还原模块缓存，避免影响同文件后续用例
});

test("真实独立进程：PLAN 退场 / HISTORY 存续 / chooser 走 history 分支", () => {
  reset();
  memory.addFacts([BASELINE_FACT]);
  establishPlan();
  applyCompletion(COMPLETION_UTTERANCE);

  const out = execFileSync("node", ["tests/fixtures/p7f1-restart-probe.cjs"], { encoding: "utf8" });
  const result = JSON.parse(out);
  assert.equal(result.hasPlan, false, "新进程从磁盘读到的 PLAN 已退场：" + JSON.stringify(result));
  assert.equal(result.hasHistory, true, "新进程从磁盘读到了那条已完成历史经历");
  assert.equal(result.branch, "history", "新进程仍做出已完成回忆决策");
});

/* ================= 生产 proactive 接线（F1-21，复用 7-E harness） ================= */

test("生产接线：PLAN completion → history → 主动搭话真实发送路径改发回忆台词（features.js 零改动）", () => {
  const features = require("../src/features");

  const realSetInterval = global.setInterval;
  const realRandom = Math.random;
  let tick = null;
  const sent = [];

  try {
    global.setInterval = (fn) => { tick = fn; return 1; };
    Math.random = () => 0.0; // 外层门放行；history 0.0 < 0.2 必命中

    // ---- Condition A：PLAN 存在 → 生产路径发「未来计划助威」 ----
    reset();
    memory.addFacts([BASELINE_FACT]);
    establishPlan();
    features.startProactive((prompt, mood) => sent.push({ prompt, mood }), 0, 1);
    assert.ok(tick, "startProactive 应当注册了 interval 回调");
    tick();
    const aPrompt = sent.at(-1).prompt;
    assert.ok(aPrompt.includes("记得你最近有" + SUBJECT), "A：completion 前应是未来计划台词，实际得到：" + aPrompt);

    // ---- Condition B：用户显式完成确认 → 生产路径改发「已完成回忆」 ----
    assert.equal(applyCompletion(COMPLETION_UTTERANCE).applied, true);
    tick();
    const bPrompt = sent.at(-1).prompt;
    assert.ok(bPrompt.includes("博士已经完成" + SUBJECT), "B：completion 后应是回忆台词，实际得到：" + bPrompt);
    assert.notEqual(aPrompt, bPrompt, "生产可观察输出确实因生命周期转换而不同");
  } finally {
    global.setInterval = realSetInterval;
    Math.random = realRandom;
    features.stopProactive();
  }
});

/* ================= clearDerived / deletion semantics（F1-22 / F1-23） ================= */

test("clearDerived 保持现状：PLAN 与 HISTORY 同为对话派生记忆，一起被清除", () => {
  reset();
  establishPlan();
  applyCompletion(COMPLETION_UTTERANCE);
  memory.addFacts([{ type: "manual", text: "博士特意让我记住：「周五交周报」" }]);
  assert.equal(memory.clearDerived(), true);
  assert.equal(facts().some((f) => f.type === "event"), false, "PLAN 被清除（既有语义，不改）");
  assert.equal(histories().length, 0, "HISTORY 被清除（Phase 7-E 已冻结，不改）");
  assert.equal(facts().length, 1);
  assert.equal(facts()[0].type, "manual");
});

test("deletion semantics：删除已完成 HISTORY 不得复活 PLAN（忘记记录 ≠ 事情重新变成没完成）", () => {
  reset();
  memory.addFacts([BASELINE_FACT]);
  const plan = establishPlan();
  applyCompletion(COMPLETION_UTTERANCE);

  const hist = historyOf(plan.id);
  assert.equal(branchOf(decide(countedRandom(0.0))), "history");

  memory.deleteFact(hist.id);
  assert.equal(histories().length, 0);
  assert.equal(planned(), null, "PLAN 绝不能被恢复");
  assert.equal(branchOf(decide(countedRandom(0.0))), null, "history 分支消失且不回到 event 分支");
});

/* ================= production wiring 契约（F1-20 静态 seam） ================= */

test("main.js 接线契约：require 存在、且 completion 先于 extractFacts（ordering 已冻结）", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  assert.match(mainSrc, /require\("\.\/src\/character-runtime\/plan-completion"\)/, "main.js 必须 require 纯 resolver");

  const resolveAt = mainSrc.indexOf("resolvePlanCompletion({ facts: memory.getFactsList(), userText: clean })");
  const extractAt = mainSrc.indexOf("memory.addFacts(memory.extractFacts(clean))");
  assert.ok(resolveAt > 0 && extractAt > 0, "两个调用点都必须存在");
  assert.ok(resolveAt < extractAt,
    "F1-15 ordering：completion resolution 必须先于 extractFacts（否则 PLAN 单槽位会被覆盖，转换作用在错对象上）");
});

test("main.js 接线契约：mutation 只用既有 memory API（deleteFact + addFacts），无新 memory 接口", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  const start = mainSrc.indexOf("resolvePlanCompletion({ facts: memory.getFactsList(), userText: clean })");
  const block = mainSrc.slice(start, start + 600);
  assert.match(block, /memory\.deleteFact\(completion\.matchedPlan\.id\)/);
  assert.match(block, /memory\.addFacts\(\[completion\.history\]\)/);
});

test("scope 纪律：生命周期判定不得进入 chooser / schedules / bond / renderer", () => {
  const chooser = fs.readFileSync(path.join(__dirname, "..", "src", "character-runtime", "experience-topic.js"), "utf8");
  assert.equal(/plan-completion/.test(chooser), false, "chooser 必须零改动");
  assert.equal(/plan-completion/.test(fs.readFileSync(path.join(__dirname, "..", "src", "schedules.js"), "utf8")), false);
  assert.equal(/plan-completion/.test(fs.readFileSync(path.join(__dirname, "..", "src", "bond.js"), "utf8")), false);
});

/* ================= 单槽位限制（已知并接受） ================= */

test("已知限制：type:'event' 单槽位——后一条计划覆盖前一条且保留 id（multi-plan 不在本轮范围）", () => {
  reset();
  const first = establishPlan();
  const second = establishPlan("下周要准备面试", "面试");
  const list = facts().filter((f) => f.type === "event");
  assert.equal(list.length, 1, "同一时刻只可能有一个 PLAN");
  assert.equal(list[0].text, "博士近期有「面试」的安排");
  assert.equal(list[0].id, first.id, "同 type 覆盖保留原 id");
  assert.equal(list[0].id, second.id);
  assert.notEqual(planSubject(list[0].text), SUBJECT);
  assert.equal(resolvePlanCompletion({ facts: facts(), userText: "考试已经结束了" }), null);
});
