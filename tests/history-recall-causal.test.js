"use strict";

/**
 * Phase 7-E COMPLETED HISTORICAL EVENT CAUSAL EXPERIMENT
 *
 * 命题：一个被明确表示为「已完成历史经历」的持久记录（type = history:<stable-id>），
 *       能否因果性地改变之后的自主行为决策；只要该记录仍存在，这种影响是否
 *       跨持久化重载与真实进程重启继续存在。
 *
 * A  history:ev-001 存在   → 决策 X（history recall 分支）
 * B  history:ev-001 不存在 → 决策 Y（非 history）
 * C  reversal：B ↓ add → A ↓ delete 同一 fact id → 回到 B
 * D  模块重载 / 真实新进程  → 仍为 X（记录仍在）
 *
 * 语义边界（结论必须保留）：
 *  - 「事件已结束」由受控合成表示显式提供；系统自动识别 event completion
 *    仍是 NOT DEMONSTRATED（automatic Event Lifecycle 留未来阶段）。
 *  - 本轮不涉及任何 residual state（Model 2 禁入）。
 *
 * 存储纪律：SUZURAN_TEST_USERDIR + mkdtemp，全程零真实 memory.json 接触。
 * identity 纪律：type 固定为 history:ev-001 / history:ev-002，不依赖 Date.now()。
 * 相似度纪律：两条 historical text 措辞明显不同——similar() 跨 type 去重，
 * >60% 子串相似会被静默丢弃（Phase 7-D 已确认，见下方防回归用例）。
 * 子进程纪律：重启探针是静态脚本 tests/fixtures/p7e-restart-probe.cjs，
 * 以全字面量参数列表 spawn（继承 cwd=仓库根与临时 userdir 环境变量）。
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "suzuran-p7e-"));
process.env.SUZURAN_TEST_USERDIR = TMP; // 必须在 require config/memory 之前；子进程经环境继承

const memory = require("../src/memory");
const { chooseExperienceTopic, HISTORY_RECALL_CHANCE } = require("../src/character-runtime/experience-topic");

/** 固定 now：与真实时钟无关 */
const NOW = new Date(2026, 9, 5);

/** 合成的「已完成历史经历」：明确是过去发生且已结束的事，不是未来计划/持续状态 */
const HISTORY_TEXT_1 = "上周我们一起完成了年度体检";
const HISTORY_TEXT_2 = "十月一日我们一起去了海边"; // 与 1 措辞明显不同，避开 similar() 跨 type 去重
const HISTORY_TYPE_1 = "history:ev-001";
const HISTORY_TYPE_2 = "history:ev-002";

/** 对照基线：joy 类型不命中任何既有分支（7-C E 用例同款），保证 A/B 唯一变量是 history 记录 */
const BASELINE_FACT = { type: "joy", text: "TEST_ONLY_BASELINE" };

/** 确定性随机源：记录被消费次数；传数组时按序消费（末位兜底重复） */
function countedRandom(values = [0.0]) {
  const seq = Array.isArray(values) ? values : [values];
  let n = 0;
  const fn = () => { const v = seq[Math.min(n, seq.length - 1)]; n += 1; return v; };
  fn.consumed = () => n;
  return fn;
}
function decide(random, facts = memory.getFactsList(), now = NOW) {
  return chooseExperienceTopic({ facts, random, now });
}
function branchOf(choice) {
  return choice ? choice.branch : null;
}
function addHistory(type, text) {
  memory.addFacts([{ type, text, anchor: "EVENT" }]);
  const hit = memory.getFactsList().find((f) => f.type === type);
  assert.ok(hit && hit.id, "必须拿到真实 fact id（memory 无 source 字段，审计靠 id+type+text+ts）");
  return hit;
}

test("前置：隔离存储生效，绝不触碰真实 memory.json", () => {
  assert.equal(path.resolve(TMP).startsWith(path.resolve(os.tmpdir())), true, "测试存储必须在系统临时目录内");
  assert.notEqual(path.resolve(TMP), path.resolve("C:/Users/xsbil/AppData/Roaming/苏苏洛桌宠 2.5 正式版"));
});

/* ================= 历史事件表示与共存 ================= */

test("表示：history:<id> + anchor:EVENT 可经 addFacts 入库并完整读回（schema 形状不变）", () => {
  memory.clear();
  const f = addHistory(HISTORY_TYPE_1, HISTORY_TEXT_1);
  const facts = memory.getFactsList();
  assert.equal(facts.length, 1);
  assert.equal(facts[0].id, f.id);
  assert.equal(facts[0].type, HISTORY_TYPE_1);
  assert.equal(facts[0].text, HISTORY_TEXT_1);
  assert.equal(facts[0].anchor, "EVENT");
  // getFactsList 只暴露 {id,type,text,anchor}；ts 在持久化记录里——直接读盘验证
  // schema 形状仍为 {id,type,text,ts,anchor}（测试环境无加密注入，明文 JSON 可读）
  const persisted = JSON.parse(fs.readFileSync(path.join(TMP, "memory.json"), "utf8"));
  assert.equal(persisted.facts.length, 1);
  assert.equal(persisted.facts[0].type, HISTORY_TYPE_1);
  assert.ok(persisted.facts[0].ts > 0, "持久化记录含 ts");
  assert.deepEqual(Object.keys(persisted.facts[0]).sort(), ["anchor", "id", "text", "ts", "type"],
    "schema 形状不变：id/type/text/ts/anchor，无新增字段");
});

test("多事件：history:ev-001 与 history:ev-002 共存（identity 不是单槽位）", () => {
  memory.clear();
  addHistory(HISTORY_TYPE_1, HISTORY_TEXT_1);
  addHistory(HISTORY_TYPE_2, HISTORY_TEXT_2);
  const types = memory.getFactsList().map((f) => f.type);
  assert.ok(types.includes(HISTORY_TYPE_1), "ev-001 仍在");
  assert.ok(types.includes(HISTORY_TYPE_2), "ev-002 也在");
});

test("相似度纪律：>60% 子串相似的 historical text 会被 similar() 静默去重（fixture 必须明显不同）", () => {
  memory.clear();
  addHistory(HISTORY_TYPE_1, HISTORY_TEXT_1);
  memory.addFacts([{ type: "history:ev-003", text: HISTORY_TEXT_1 + "项目", anchor: "EVENT" }]);
  const list = memory.getFactsList();
  assert.equal(list.some((f) => f.type === "history:ev-003"), false,
    "跨 type 相似去重会静默丢弃第二条——causal fixture 文本必须明显不同");
});

/* ================= random 消费纪律 ================= */

test("阈值常量：HISTORY_RECALL_CHANCE 导出且为实验探针值 0.2", () => {
  assert.equal(HISTORY_RECALL_CHANCE, 0.2);
});

test("random 纪律：无 history 事实时不消费任何 random（既有序列逐位不变）", () => {
  memory.clear();
  memory.addFacts([BASELINE_FACT]);
  const random = countedRandom(0.0);
  assert.equal(branchOf(decide(random)), null);
  assert.equal(random.consumed(), 0, "没有 history:* 事实，新增分支不得触碰 random");
});

test("random 纪律：history 事实存在才消费新增的一次 random", () => {
  memory.clear();
  memory.addFacts([BASELINE_FACT]);
  addHistory(HISTORY_TYPE_1, HISTORY_TEXT_1);
  const random = countedRandom(0.0);
  const choice = decide(random);
  assert.equal(branchOf(choice), "history");
  assert.equal(random.consumed(), 1, "前四分支均不命中，history 恰好消费第 1 次 random");
});

test("threshold 严格 <：random === 0.2 不命中（不含等号，与既有分支风格一致）", () => {
  memory.clear();
  memory.addFacts([BASELINE_FACT]);
  addHistory(HISTORY_TYPE_1, HISTORY_TEXT_1);
  const atThreshold = decide(countedRandom(HISTORY_RECALL_CHANCE));
  assert.equal(branchOf(atThreshold), null, "0.2 必须不命中");
  const below = decide(countedRandom(0.19));
  assert.equal(branchOf(below), "history", "0.19 必须命中");
});

test("threshold 边界：miss 后回落 fallback（null），且该次 random 已消费", () => {
  memory.clear();
  memory.addFacts([BASELINE_FACT]);
  addHistory(HISTORY_TYPE_1, HISTORY_TEXT_1);
  const random = countedRandom(0.9);
  assert.equal(branchOf(decide(random)), null);
  assert.equal(random.consumed(), 1);
});

/* ================= 分支优先级 ================= */

test("优先级：birthday > history，且生日短路不消费 random", () => {
  memory.clear();
  memory.addFacts([{ type: "birthday", text: "博士的生日是10月5日" }]);
  addHistory(HISTORY_TYPE_1, HISTORY_TEXT_1);
  const random = countedRandom(0.0);
  const choice = decide(random);
  assert.equal(branchOf(choice), "birthday");
  assert.equal(random.consumed(), 0, "生日短路后不得消费 random");
});

test("优先级：health > history（health 命中时 history 的 random 不被消费）", () => {
  memory.clear();
  memory.addFacts([{ type: "health", text: "TEST_ONLY_EXPERIENCE" }]);
  addHistory(HISTORY_TYPE_1, HISTORY_TEXT_1);
  const random = countedRandom(0.0);
  const choice = decide(random);
  assert.equal(branchOf(choice), "health");
  assert.equal(random.consumed(), 1, "只消费 health 那一次");
});

test("优先级：event > history", () => {
  memory.clear();
  memory.addFacts([{ type: "event", text: "博士近期有「考试」的安排" }]);
  addHistory(HISTORY_TYPE_1, HISTORY_TEXT_1);
  const random = countedRandom(0.0);
  assert.equal(branchOf(decide(random)), "event");
  assert.equal(random.consumed(), 1);
});

test("优先级：name > history", () => {
  memory.clear();
  memory.addFacts([{ type: "name", text: "博士希望我称呼他为「阿米娅」" }]);
  addHistory(HISTORY_TYPE_1, HISTORY_TEXT_1);
  const random = countedRandom(0.0);
  assert.equal(branchOf(decide(random)), "name");
  assert.equal(random.consumed(), 1);
});

test("优先级：前四分支全部 miss 后 history 消费第 4 次 random（接续既有顺序）", () => {
  memory.clear();
  memory.addFacts([
    { type: "health", text: "TEST_ONLY_EXPERIENCE" },
    { type: "event", text: "博士近期有「考试」的安排" },
    { type: "name", text: "博士希望我称呼他为「阿米娅」" },
    BASELINE_FACT,
  ]);
  addHistory(HISTORY_TYPE_1, HISTORY_TEXT_1);
  // 序列随机：health/event/name 三次各 0.9 全 miss，第 4 次 0.0 由 history 消费
  const random = countedRandom([0.9, 0.9, 0.9, 0.0]);
  const choice = decide(random);
  assert.equal(branchOf(choice), "history");
  assert.equal(random.consumed(), 4, "3 次既有 + 1 次新增");
});

/* ================= history 分支行为 ================= */

test("history 命中：台词引用事实文本，语义为已完成回忆", () => {
  memory.clear();
  addHistory(HISTORY_TYPE_1, HISTORY_TEXT_1);
  const choice = decide(countedRandom(0.0));
  assert.equal(choice.branch, "history");
  assert.ok(Array.isArray(choice.lines) && choice.lines.length > 0);
  for (const line of choice.lines) {
    assert.ok(line.includes(HISTORY_TEXT_1), "台词必须引用 historyFact.text：" + line);
    assert.doesNotMatch(line, /快到了|准备得怎么样|马上就要/, "禁止未来计划语义：" + line);
  }
});

test("history 台词池：每次调用新建数组实例（lines.pick WeakMap 纪律）", () => {
  memory.clear();
  addHistory(HISTORY_TYPE_1, HISTORY_TEXT_1);
  const r1 = decide(countedRandom(0.0));
  const r2 = decide(countedRandom(0.0));
  assert.notEqual(r1.lines, r2.lines, "两次调用必须返回不同数组实例");
  assert.deepEqual(r1.lines, r2.lines, "但内容完全一致");
});

test("多条历史：取最后一条（filter().pop()，与 event 分支同款取用）", () => {
  memory.clear();
  addHistory(HISTORY_TYPE_1, HISTORY_TEXT_1);
  addHistory(HISTORY_TYPE_2, HISTORY_TEXT_2);
  const choice = decide(countedRandom(0.0));
  assert.equal(choice.branch, "history");
  assert.ok(choice.lines.every((l) => l.includes(HISTORY_TEXT_2)), "必须选中最后一条 ev-002");
  assert.ok(choice.lines.every((l) => !l.includes(HISTORY_TEXT_1)), "不得混入 ev-001 文本");
});

test("删除最新历史 → 上一条成为被选中的历史（identity 非单槽位的决策侧证明）", () => {
  memory.clear();
  const f1 = addHistory(HISTORY_TYPE_1, HISTORY_TEXT_1);
  const f2 = addHistory(HISTORY_TYPE_2, HISTORY_TEXT_2);
  const chosenBefore = decide(countedRandom(0.0));
  assert.ok(chosenBefore.branch === "history" && chosenBefore.lines.every((l) => l.includes(HISTORY_TEXT_2)));
  memory.deleteFact(f2.id);
  assert.equal(memory.getFactsList().some((f) => f.type === HISTORY_TYPE_2), false, "ev-002 确实被删");
  const chosenAfter = decide(countedRandom(0.0));
  assert.ok(chosenAfter.branch === "history" && chosenAfter.lines.every((l) => l.includes(HISTORY_TEXT_1)),
    "ev-001 成为 chosen history");
  assert.ok(memory.getFactsList().some((f) => f.id === f1.id && f.type === HISTORY_TYPE_1), "ev-001 记录未受影响");
});

/* ================= Condition A / B / Reversal ================= */

test("Condition A：history 记录存在 → 决策 X（history 分支）", () => {
  memory.clear();
  memory.addFacts([BASELINE_FACT]);
  addHistory(HISTORY_TYPE_1, HISTORY_TEXT_1);
  const choice = decide(countedRandom(0.0));
  assert.equal(branchOf(choice), "history");
});

test("Condition B：其余条件全同，仅 history 记录不存在 → 决策 Y（非 history）", () => {
  memory.clear();
  memory.addFacts([BASELINE_FACT]); // 与 A 唯一差别：没有 history:ev-001
  const random = countedRandom(0.0);
  const choice = decide(random);
  assert.notEqual(branchOf(choice), "history");
  assert.equal(branchOf(choice), null, "joy 基线不命中任何分支 → 原有 fallback");
  assert.equal(random.consumed(), 0);
});

test("reversal：B ↓ add history:ev-001 → A ↓ delete 同一 fact id → 回到 B（同 now 同 random）", () => {
  memory.clear();
  memory.addFacts([BASELINE_FACT]);

  // B：无历史经历
  const decisionB = branchOf(decide(countedRandom(0.0)));
  assert.equal(decisionB, null);

  // A：加入已完成历史经历（真实 addFacts，取真实 id）
  const fact = addHistory(HISTORY_TYPE_1, HISTORY_TEXT_1);
  const decisionA = branchOf(decide(countedRandom(0.0)));
  assert.equal(decisionA, "history");

  // 精确移除**同一条**历史经历（禁止 clear() 充当 reversal）
  memory.deleteFact(fact.id);
  assert.equal(memory.getFactsList().some((f) => f.type === HISTORY_TYPE_1), false, "该历史记录确实被移除");
  const decisionBack = branchOf(decide(countedRandom(0.0)));
  assert.equal(decisionBack, decisionB, "移除后必须回到 B 的决策");
  assert.notEqual(decisionBack, decisionA);
});

/* ================= Persistence / restart ================= */

test("模块重载（模拟重启）后，历史记录仍在且仍决定相同决策", () => {
  memory.clear();
  memory.addFacts([BASELINE_FACT]);
  addHistory(HISTORY_TYPE_1, HISTORY_TEXT_1);
  const before = decide(countedRandom(0.0));
  assert.equal(before.branch, "history");

  const memPath = require.resolve("../src/memory");
  delete require.cache[memPath];
  const reloaded = require("../src/memory"); // 新实例：从磁盘 load（重载源）
  const factsAfter = reloaded.getFactsList();
  assert.equal(factsAfter.some((f) => f.type === HISTORY_TYPE_1 && f.text === HISTORY_TEXT_1), true,
    "重载后历史记录仍在（来自磁盘，不是内存残留）");

  const after = chooseExperienceTopic({ facts: factsAfter, random: countedRandom(0.0), now: NOW });
  assert.equal(after.branch, "history");
  assert.equal(after.branch, before.branch);

  // 还原模块缓存，避免影响同文件后续用例
  require.cache[memPath] = { exports: memory, loaded: true, id: memPath };
});

test("真实独立进程重启后，历史记录仍决定相同决策", () => {
  memory.clear();
  memory.addFacts([BASELINE_FACT]);
  addHistory(HISTORY_TYPE_1, HISTORY_TEXT_1);
  assert.equal(decide(countedRandom(0.0)).branch, "history");

  // 另起一个真正的 node 进程执行静态探针脚本（全新模块注册表，从磁盘 load memory）。
  // 参数列表全字面量（cwd 继承=仓库根）；临时 userdir 经进程环境继承，零参数拼接。
  const out = execFileSync("node", ["tests/fixtures/p7e-restart-probe.cjs"], { encoding: "utf8" });
  const result = JSON.parse(out);
  assert.equal(result.has, true, "新进程从磁盘读到了那条历史记录");
  assert.equal(result.branch, "history", "新进程仍然做出相同决策");
});

/* ================= 生产接线（动态） ================= */

test("生产接线：真实主动搭话发送路径消费 history 分支（A/B 动态，features.js 零改动）", () => {
  const features = require("../src/features");

  // 在不改生产代码的前提下接管两个全局：features.js 内部是裸调用 global setInterval / Math.random
  const realSetInterval = global.setInterval;
  const realRandom = Math.random;
  let tick = null;
  const sent = [];

  try {
    global.setInterval = (fn) => { tick = fn; return 1; };
    Math.random = () => 0.0; // 外层 0.18 门必然放行；history 0.0 < 0.2 必命中

    // ---- Condition A：已完成历史经历存在 → 生产路径发出 history 回忆台词 ----
    memory.clear();
    memory.addFacts([BASELINE_FACT]);
    addHistory(HISTORY_TYPE_1, HISTORY_TEXT_1);
    features.startProactive((prompt, mood) => sent.push({ prompt, mood }), 0, 1);
    assert.ok(tick, "startProactive 应当注册了 interval 回调");
    tick();
    const aPrompt = sent.at(-1).prompt;
    assert.ok(aPrompt.includes(HISTORY_TEXT_1), "A：生产路径发出 history 回忆台词，实际得到：" + aPrompt);

    // ---- Condition B：历史记录不存在 → 生产路径改发别的台词 ----
    memory.clear();
    memory.addFacts([{ type: "name", text: "博士希望我称呼他为「阿米娅」" }]);
    tick();
    const bPrompt = sent.at(-1).prompt;
    assert.ok(/阿米娅/.test(bPrompt), "B：生产路径改走 name 由头台词，实际得到：" + bPrompt);
    assert.notEqual(aPrompt, bPrompt, "生产可观察输出确实因那条历史记录而不同");
  } finally {
    global.setInterval = realSetInterval;
    Math.random = realRandom;
    features.stopProactive();
  }
});

/* ================= clearDerived 现状刻画（不改生产语义） ================= */

test("clearDerived 现状：history:* 会被清除，仅 type==='manual' 保留（当前遗忘语义刻画）", () => {
  memory.clear();
  addHistory(HISTORY_TYPE_1, HISTORY_TEXT_1);
  memory.addFacts([{ type: "manual", text: "博士特意让我记住：「周五交周报」" }]);
  assert.equal(memory.clearDerived(), true);
  const kept = memory.getFactsList();
  assert.equal(kept.some((f) => f.type === HISTORY_TYPE_1), false,
    "CURRENT SEMANTICS：clearDerived removes history:*（provenance 未定义前不改）");
  assert.equal(kept.length, 1);
  assert.equal(kept[0].type, "manual");
});
