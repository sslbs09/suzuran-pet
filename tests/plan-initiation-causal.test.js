"use strict";

/**
 * Phase 8-D — PLAN-CONDITIONED PROACTIVE INITIATION CAUSAL EXPERIMENT
 *
 * 核心命题：持久化 PLAN（type:"event"，Phase 7-F 单槽）的存在
 *   → Character initiation policy（外层 ACT / NO_ACT 概率）
 *   → 真实 sendFn 调用差异。
 * 第一次证明：经历不只改变「说什么」（Phase 7-C/7-E/7-F 的内容级联），
 * 还可以改变「这一次到底说不说」。
 *
 * 语义边界（结论必须保留）：
 *  - 只有 ACT（发起一次主动交互）与 NO_ACT（保持沉默）两个 primitive；
 *    没有 Action enum / action bus / behavior planner / multi-action chooser。
 *  - PLAN 直接进入 action policy，不经过任何人格标量（无 initiative/sociability/trust）。
 *  - 角色意图 ≠ 投递许可：main.js sendProactive 的窗口可见 / 离开 / lineGate 闸门零改动、
 *    也绝不可被 PLAN 绕过（tests/proactive-initiation-characterization.test.js 锁归属）。
 *  - PLAN_BOOST 是 EXPERIMENTAL CAUSAL PROBE — NOT PERSONALITY TUNING 的固定实验增量。
 *
 * ON 臂断言全部集中在本文件；OFF 臂对未修改生产代码的逐位冻结在
 * tests/proactive-initiation-characterization.test.js（接线前后都必须成立）。
 *
 * 存储纪律：SUZURAN_TEST_USERDIR + mkdtemp，全程零真实 memory.json 接触。
 * 子进程纪律：重启探针是静态脚本 tests/fixtures/p8d-restart-probe.cjs，全字面量参数。
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "suzuran-p8d-causal-"));
process.env.SUZURAN_TEST_USERDIR = TMP; // 必须在 require config/memory 之前；子进程经环境继承

const memory = require("../src/memory");
const config = require("../src/config");
const features = require("../src/features");
const {
  effectiveInitiateChance,
  hasPlannedFact,
  characterRuntimePlanInitiationV0Enabled,
  PLAN_BOOST,
} = require("../src/character-runtime/proactive-initiation");
const {
  resolvePlanCompletion,
  HISTORY_TYPE_PREFIX,
} = require("../src/character-runtime/plan-completion");

/* ---------- 概率常量（与生产逐位一致的表达式） ---------- */

const BASE = 0.18; // features.PROACTIVE_DEFAULTS.chance，Phase 8-D 禁改
const BOOSTED = Math.min(1, Math.max(0, BASE + PLAN_BOOST)); // 与生产 proactiveOuterChance 的 policy 输出同式
const BAND = 0.24; // 分离带 (0.18, 0.30]：baseline 拒绝、PLAN 臂放行的 scripted random

const PLAN_UTTERANCE = "下周要准备考试";
const SUBJECT = "考试";
/** 对照基线：type "joy" 不命中任何 chooser 分支（Phase 7-F1 同款），保证 A/B 唯一变量是 PLAN 存在性 */
const BASELINE_FACT = { type: "joy", text: "TEST_ONLY_P8D_BASELINE" };
const PLAN_FACT_SYNTHETIC = { type: "event", text: "博士近期有「考试」的安排", anchor: "PLAN" };

/* ---------- 存储与 gate 操作 ---------- */

function reset() { memory.clear(); }
function facts() { return memory.getFactsList(); }
function planned() { return facts().find((f) => f.type === "event") || null; }

/** 走真实生产提取路径建立 PLAN（与 main.js extractFacts 同一路径），事实同步落盘 */
function establishPlan(utterance = PLAN_UTTERANCE, subject = SUBJECT) {
  memory.addFacts(memory.extractFacts(utterance));
  const plan = planned();
  assert.ok(plan, "PLAN 必须由真实 extractFacts 路径产出：" + utterance);
  assert.equal(plan.text, "博士近期有「" + subject + "」的安排");
  assert.equal(plan.anchor, "PLAN");
  return plan;
}

/** 与 main.js 接线完全一致的两步 completion（delete PLAN + add HISTORY），不重新实现 lifecycle */
function applyCompletion(userText = "考试已经结束了") {
  const completion = resolvePlanCompletion({ facts: facts(), userText });
  if (!completion) return { applied: false };
  memory.deleteFact(completion.matchedPlan.id);
  memory.addFacts([completion.history]);
  return { applied: true, completion };
}

/** 实验开关只写 config 缓存对象（同进程 getConfig() 返回同一引用）；不落盘、不做 schema migration */
function setGate(on) {
  config.getConfig().characterRuntimePlanInitiationV0Enabled = !!on;
}

/* ---------- 生产 harness：接管 setInterval / Math.random，不改生产代码 ---------- */

/**
 * 真实 features.startProactive 路径的单 tick 控制器。
 * random 脚本：每个 tick 的第 1 次 draw 归外层门（cfg.outer）；
 * 其余 draw 读 cfg.inner（按序循环，取尽后重复末值）——与
 * tests/proactive-initiation-characterization.test.js 的 runProactive 同一款分账规则。
 */
function startHarness() {
  const realSetInterval = global.setInterval;
  const realRandom = Math.random;
  const sent = [];
  const drained = [];
  let tick = null;
  let innerIdx = 0;
  const cfg = { outer: 0.0, inner: [0.0] };
  try {
    global.setInterval = (fn) => { tick = fn; return 1; };
    Math.random = () => {
      let v;
      if (innerIdx === 0) {
        innerIdx = 1;
        v = cfg.outer; // 本 tick 第 1 次 draw：外层门
      } else {
        v = cfg.inner[Math.min(innerIdx - 1, cfg.inner.length - 1)]; // 第 2 次起：inner cascade
        innerIdx += 1;
      }
      drained.push(v);
      return v;
    };
    features.startProactive((prompt, mood) => sent.push({ prompt, mood }), 0, BASE);
    assert.ok(tick, "startProactive 应当注册了 interval 回调");
  } catch (e) {
    global.setInterval = realSetInterval;
    Math.random = realRandom;
    throw e;
  }
  return {
    sent,
    drained,
    cfg,
    /** outer 传 undefined 时沿用上一次的值 */
    tick(outer) {
      if (outer !== undefined) cfg.outer = outer;
      innerIdx = 0;
      tick();
    },
    stop() {
      global.setInterval = realSetInterval;
      Math.random = realRandom;
      features.stopProactive();
      setGate(false); // 无论如何恢复默认 OFF，不污染同文件后续用例
    },
  };
}

/** 便捷封装：清空记忆 → 播种 → 设 gate → 跑 ticks 个 tick（每个 tick 用 outerVals[i]） */
function runProactive({ gate = false, seedFacts = null, outerVals = [0.0], inner = [0.0] }) {
  reset();
  if (seedFacts) memory.addFacts(seedFacts);
  setGate(gate);
  const h = startHarness();
  h.cfg.inner = inner;
  try {
    for (let i = 0; i < outerVals.length; i++) h.tick(outerVals[i]);
  } finally {
    h.stop();
  }
  return { sent: h.sent, drained: h.drained };
}

/** 确定性 LCG 随机流（两个臂喂同一条流，流本身与被测分支无关） */
function lcgValues(seed, count) {
  let s = seed >>> 0;
  const out = [];
  for (let i = 0; i < count; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out.push(s / 4294967296);
  }
  return out;
}

/**
 * 多 tick 确定性模拟（专用脚本，与 startHarness 的分账规则一致但按 tick 推进）：
 * tick i 的第 1 次 draw = outerVals[i]（外层门）；其余 draw = innerVals[i]（该 tick 的内联抽签值）。
 * 附带性质：event 分支与清晨门同为 0.25 阈值——event 落空（>=0.25）时清晨门必也落空，
 * 因此模拟结果与运行时刻（5-8 点与否）无关，分支计数完全确定。
 */
function simulate({ gate, seedFacts, outerVals, innerVals }) {
  const realSetInterval = global.setInterval;
  const realRandom = Math.random;
  const sent = [];
  let tick = null;
  try {
    global.setInterval = (fn) => { tick = fn; return 1; };
    let tickIdx = -1;
    let innerIdx = 0;
    let outside = 0;
    Math.random = () => {
      if (tickIdx < 0) { // tick 循环外的偶发 draw（如 memory.newFactId 的 fact id）：给安全的递增值
        outside += 1;
        return (outside % 997) / 997;
      }
      if (innerIdx === 0) { innerIdx = 1; return outerVals[tickIdx]; } // 本 tick 第 1 次 draw：外层门
      return innerVals[tickIdx]; // 本 tick 的后续 draw 全部复用该 tick 的内联抽签值
    };
    reset();
    if (seedFacts) memory.addFacts(seedFacts);
    setGate(gate);
    features.startProactive((prompt, mood) => sent.push({ prompt, mood }), 0, BASE);
    for (let i = 0; i < outerVals.length; i++) { tickIdx = i; innerIdx = 0; tick(); }
  } finally {
    global.setInterval = realSetInterval;
    Math.random = realRandom;
    features.stopProactive();
    setGate(false);
  }
  return sent;
}

/* ================= 前置 / 纯度 ================= */

test("前置：隔离存储生效，绝不触碰真实 memory.json", () => {
  assert.equal(path.resolve(TMP).startsWith(path.resolve(os.tmpdir())), true);
});

test("纯度契约：policy 模块无 require / 无 Date / 无 Math.random / 无 fs（静态）", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "character-runtime", "proactive-initiation.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")   // 去掉块注释
    .replace(/^\s*\/\/.*$/gm, "");       // 去掉行注释
  assert.doesNotMatch(src, /\brequire\s*\(/, "禁止 require（memory/config/fs/electron 一律不得引入）");
  assert.doesNotMatch(src, /\bDate\b/, "禁止读取当前时间");
  assert.doesNotMatch(src, /Math\s*\.\s*random/, "禁止随机源（随机消费权在生产 tick 手里）");
  assert.doesNotMatch(src, /\bfs\b/, "禁止文件系统");
});

/* ================= 纯 policy 单元 ================= */

test("gate 解析：undefined / 空对象 / 非严格 true 一律 false，只有 === true 放行", () => {
  assert.equal(characterRuntimePlanInitiationV0Enabled(undefined), false);
  assert.equal(characterRuntimePlanInitiationV0Enabled(null), false);
  assert.equal(characterRuntimePlanInitiationV0Enabled({}), false);
  assert.equal(characterRuntimePlanInitiationV0Enabled({ characterRuntimePlanInitiationV0Enabled: false }), false);
  assert.equal(characterRuntimePlanInitiationV0Enabled({ characterRuntimePlanInitiationV0Enabled: "yes" }), false);
  assert.equal(characterRuntimePlanInitiationV0Enabled({ characterRuntimePlanInitiationV0Enabled: 1 }), false);
  assert.equal(characterRuntimePlanInitiationV0Enabled({ characterRuntimePlanInitiationV0Enabled: true }), true);
});

test("PLAN 检测：只认 type:'event'；history:* 不是 PLAN（lifecycle 回落的前提）", () => {
  assert.equal(hasPlannedFact([PLAN_FACT_SYNTHETIC]), true);
  assert.equal(hasPlannedFact([{ type: "history:ev-001", text: "博士已经完成考试" }]), false,
    "history:* 不得继续抬高外层门——事情完成后行动压力必须消失");
  assert.equal(hasPlannedFact([{ type: "health", text: "TEST_ONLY" }]), false);
  assert.equal(hasPlannedFact([{ type: "name", text: "「测试昵称」" }]), false);
  assert.equal(hasPlannedFact([]), false);
  assert.equal(hasPlannedFact(null), false);
  assert.equal(hasPlannedFact(undefined), false);
  assert.equal(hasPlannedFact("not-an-array"), false);
  assert.equal(hasPlannedFact([null, undefined, {}]), false);
});

test("OFF：原样返回 baseChance——有 PLAN 也一样、非法 baseChance 也原样", () => {
  assert.equal(effectiveInitiateChance({ facts: [PLAN_FACT_SYNTHETIC], baseChance: BASE, enabled: false }), BASE);
  assert.equal(effectiveInitiateChance({ facts: [PLAN_FACT_SYNTHETIC], baseChance: BASE, enabled: undefined }), BASE);
  assert.equal(effectiveInitiateChance({ facts: [PLAN_FACT_SYNTHETIC], baseChance: BASE }), BASE);
  assert.equal(effectiveInitiateChance({ facts: [PLAN_FACT_SYNTHETIC], baseChance: 0.5 }), 0.5,
    "enabled 缺省时即使有 PLAN 也不得加 boost（调用侧必须显式解析 gate）");
  assert.equal(effectiveInitiateChance({ facts: [PLAN_FACT_SYNTHETIC], baseChance: NaN, enabled: false }), NaN);
  assert.equal(effectiveInitiateChance(), undefined);
});

test("ON + 无 PLAN：baseChance 原样返回（逐位，无 clamp 无 boost）", () => {
  assert.equal(effectiveInitiateChance({ facts: [BASELINE_FACT], baseChance: BASE, enabled: true }), BASE);
  assert.equal(effectiveInitiateChance({ facts: [], baseChance: BASE, enabled: true }), BASE);
  assert.equal(effectiveInitiateChance({ facts: null, baseChance: BASE, enabled: true }), BASE);
  assert.equal(effectiveInitiateChance({ facts: [BASELINE_FACT], baseChance: 0.95, enabled: true }), 0.95,
    "无 PLAN 时即便 baseChance+boost 会越界也不得干预");
});

test("ON + PLAN：min(1, max(0, base + PLAN_BOOST))，clamp 与实验增量逐位锁定", () => {
  assert.equal(effectiveInitiateChance({ facts: [PLAN_FACT_SYNTHETIC], baseChance: BASE, enabled: true }), BASE + PLAN_BOOST);
  assert.equal(BOOSTED > BASE, true, "前提：实验增量确实把概率抬高于 baseline");
  assert.equal(BOOSTED <= 1, true);
  // clamp 上界：base + boost > 1 时收敛到 1
  assert.equal(effectiveInitiateChance({ facts: [PLAN_FACT_SYNTHETIC], baseChance: 0.95, enabled: true }), 1);
  assert.equal(effectiveInitiateChance({ facts: [PLAN_FACT_SYNTHETIC], baseChance: 1, enabled: true }), 1);
  // clamp 下界：负 baseChance（防御式输入）加 boost 后仍收敛到 [0,1]
  assert.equal(effectiveInitiateChance({ facts: [PLAN_FACT_SYNTHETIC], baseChance: 0, enabled: true }), PLAN_BOOST);
  assert.equal(effectiveInitiateChance({ facts: [PLAN_FACT_SYNTHETIC], baseChance: -0.5, enabled: true }), 0);
});

test("非有限 baseChance pass-through：NaN / Infinity / 函数原样返回（保持既有比较语义）", () => {
  // 生产事实：main.js pet:set-proactive-chat 把 proactiveStateFn 传在 chance 位（既有参数错位），
  // `Math.random() > fn` 恒为 false → 恒 ACT。policy 若把非法值夹成 0 会把「总会开口」
  // 翻成「永不开口」——对既有生产路径的语义改动。因此非法值一律 pass-through。
  assert.equal(effectiveInitiateChance({ facts: [PLAN_FACT_SYNTHETIC], baseChance: NaN, enabled: true }), NaN);
  assert.equal(effectiveInitiateChance({ facts: [PLAN_FACT_SYNTHETIC], baseChance: Infinity, enabled: true }), Infinity);
  const stateFn = () => "walking";
  assert.equal(effectiveInitiateChance({ facts: [PLAN_FACT_SYNTHETIC], baseChance: stateFn, enabled: true }), stateFn);
});

/* ================= 生产 wiring 静态 seam ================= */

test("features.js seam：外层门调用 policy；OFF 短路先于 memory 读取；inner cascade 零触碰", () => {
  const featuresSrc = fs.readFileSync(require.resolve("../src/features.js"), "utf8").replace(/\r\n/g, "\n");
  assert.match(featuresSrc, /if \(Math\.random\(\) > proactiveOuterChance\(\)\) return;/,
    "外层门仍是一次 Math.random() 比较，只是概率来源换成 policy");
  const helperAt = featuresSrc.indexOf("function proactiveOuterChance()");
  assert.ok(helperAt > 0, "proactiveOuterChance helper 必须存在");
  const helperBody = featuresSrc.slice(helperAt, featuresSrc.indexOf("}", featuresSrc.indexOf("getFactsList", helperAt)) + 1);
  const gateAt = helperBody.indexOf("characterRuntimePlanInitiationV0Enabled");
  const factsAt = helperBody.indexOf("getFactsList");
  assert.ok(gateAt > 0 && factsAt > gateAt, "OFF 时必须先短路返回，连 memory 都不读（OFF 逐位等同 baseline 的结构保证）");

  // 内联级联只负责「说什么」：既有分支与概率一处都不许动
  assert.match(featuresSrc, /chooseExperienceTopic\(\{ facts, random: Math\.random, now: new Date\(\) \}\)/);
  assert.match(featuresSrc, /h >= 5 && h < 8 && Math\.random\(\) < 0\.25/, "清晨门 0.25 不变");
  assert.match(featuresSrc, /\(st\.key === "fd" \|\| st\.key === "xl" \|\| st\.key === "sy"\) && Math\.random\(\) < 0\.18/, "阶段门 0.18 不变");
  assert.match(featuresSrc, /isMilestone && days > lastMilestoneSaid && Math\.random\(\) < 0\.2/, "里程碑门 0.2 不变");
  assert.match(featuresSrc, /idle > 45 \* 60 \* 1000 && Math\.random\(\) < 0\.4/, "超长闲置门 0.4 不变");
  assert.match(featuresSrc, /const PROACTIVE_DEFAULTS = Object\.freeze\(\{ intervalMin: 12, chance: 0\.18 \}\);/, "baseChance 0.18 不变");
});

test("config 默认关：DEFAULTS 显式 false；用户 config 缺字段 → false（无 schema migration）", () => {
  const configSrc = fs.readFileSync(require.resolve("../src/config.js"), "utf8");
  assert.match(configSrc, /characterRuntimePlanInitiationV0Enabled: false/,
    "实验 gate 必须默认 OFF（EXPERIMENTAL CAUSAL PROBE）");
  assert.equal(characterRuntimePlanInitiationV0Enabled(config.getConfig()), false,
    "临时 userdir 的 config.json 里没有这个字段 → gate 必须落回 false");
});

/* ================= 生产动态 A/B（真实 startProactive） ================= */

test("同 random A/B（分离带 0.24）：PLAN present → sendFn 一次；PLAN absent → 零调用", () => {
  // Condition A：ON + PLAN
  const a = runProactive({ gate: true, seedFacts: [PLAN_FACT_SYNTHETIC], outerVals: [BAND] });
  assert.equal(a.sent.length, 1, "A：0.24 > 0.30 为假 → 外层门放行 → ACT：" + JSON.stringify(a.sent));
  assert.ok(a.sent[0].prompt.includes(SUBJECT), "A 的输出由内联级联照旧决定（event 由头）：" + a.sent[0].prompt);

  // Condition B：ON + 无 PLAN，完全相同的 scripted random
  const b = runProactive({ gate: true, seedFacts: [BASELINE_FACT], outerVals: [BAND] });
  assert.equal(b.sent.length, 0, "B：0.24 > 0.18 → NO_ACT，同一个 r 在 baseline 概率下必须被拒绝");
  assert.equal(b.drained.length, 1, "B：miss 后短路，inner 一次 random 都不消费");
});

test("A/B 边界：r=0.18 等号两臂都放行；r=0.31 两臂都拒绝（boost 不越出分离带）", () => {
  const onPlanEq = runProactive({ gate: true, seedFacts: [PLAN_FACT_SYNTHETIC], outerVals: [BASE] });
  const onNoPlanEq = runProactive({ gate: true, seedFacts: [BASELINE_FACT], outerVals: [BASE] });
  assert.equal(onPlanEq.sent.length, 1, "0.18 > 0.18 为假 → PLAN 臂放行");
  assert.equal(onNoPlanEq.sent.length, 1, "等号放行是 baseline 既有语义，无 PLAN 臂同样放行");

  const onPlanHi = runProactive({ gate: true, seedFacts: [PLAN_FACT_SYNTHETIC], outerVals: [0.31] });
  const onNoPlanHi = runProactive({ gate: true, seedFacts: [BASELINE_FACT], outerVals: [0.31] });
  assert.equal(onPlanHi.sent.length, 0, "0.31 > 0.30 → PLAN 臂也必须拒绝");
  assert.equal(onNoPlanHi.sent.length, 0);
});

test("四组合矩阵：OFF 逐位等同（ACT/NO_ACT 与首个 draw 全同）；ON miss 短路；首个 draw 恒归外层门", () => {
  for (const outer of [0.0, BASE, BAND, 0.31, 0.9]) {
    const offPlan = runProactive({ gate: false, seedFacts: [PLAN_FACT_SYNTHETIC], outerVals: [outer] });
    const offNoPlan = runProactive({ gate: false, seedFacts: [BASELINE_FACT], outerVals: [outer] });
    // OFF 时「说不说」必须逐位等同：sent 数、外层门读到的 draw 全同。
    // （内联台词内容允许不同——有无 PLAN 本来就会改变「说什么」那一层，与本实验无关。）
    assert.equal(offPlan.sent.length, offNoPlan.sent.length, "outer=" + outer + "：OFF 时 ACT/NO_ACT 判定必须相同");
    assert.equal(offPlan.drained[0], offNoPlan.drained[0], "outer=" + outer + "：OFF 时外层门读到的 random 必须相同");
    if (outer > BASE) { // 两臂都 miss：整个 tick 只消费外层门那 1 次
      assert.deepEqual(offPlan.drained, [outer], "outer=" + outer + "：OFF+PLAN miss 时 drained 必须恰好是 [outer]");
      assert.deepEqual(offNoPlan.drained, [outer]);
    }
  }

  const onPlanMiss = runProactive({ gate: true, seedFacts: [PLAN_FACT_SYNTHETIC], outerVals: [0.9] });
  assert.equal(onPlanMiss.sent.length, 0);
  assert.deepEqual(onPlanMiss.drained, [0.9], "ON+PLAN miss：短路，整个 tick 恰好 1 次 random");

  const onPlanHit = runProactive({ gate: true, seedFacts: [PLAN_FACT_SYNTHETIC], outerVals: [0.0], inner: [0.0] });
  assert.equal(onPlanHit.sent.length, 1);
  assert.equal(onPlanHit.drained[0], 0.0, "hit 时第 1 次 draw 仍归外层门（顺序未被打乱）");
  assert.ok(onPlanHit.drained.length >= 2, "hit 之后 inner cascade 继续消费 random");
});

test("hit 保持 inner random 顺序：event 分支读的仍是本 tick 第 2 次 draw", () => {
  // 若接线在外层门后多消费一次 random，event 分支会读到错位的值，以下两个断言必然翻转
  const hit = runProactive({ gate: true, seedFacts: [PLAN_FACT_SYNTHETIC], outerVals: [0.0], inner: [0.0] });
  assert.ok(hit.sent[0].prompt.includes(SUBJECT), "第 2 次 draw=0.0 < 0.25 → event 由头：" + hit.sent[0].prompt);

  const missInner = runProactive({ gate: true, seedFacts: [PLAN_FACT_SYNTHETIC], outerVals: [0.0], inner: [0.5] });
  assert.equal(missInner.sent[0].prompt.includes(SUBJECT), false,
    "第 2 次 draw=0.5 不小于 0.25 → 不得出现 event 由头：" + missInner.sent[0].prompt);
});

test("既有参数错位 pass-through：chance 位传函数时，ON 与 OFF 行为逐位一致（恒 ACT 语义不翻转）", () => {
  const stateFn = () => "walking"; // main.js:3078 现状把 proactiveStateFn 传在 chance 位
  for (const seedFacts of [[PLAN_FACT_SYNTHETIC], [BASELINE_FACT]]) {
    const off = runProactive({ gate: false, seedFacts, outerVals: [0.0], inner: [0.0] });
    const on = runProactive({ gate: true, seedFacts, outerVals: [0.0], inner: [0.0] });
    assert.equal(off.sent.length, 1, "OFF：Math.random() > fn 恒假 → baseline 恒 ACT");
    assert.equal(on.sent.length, 1, "ON：policy 对非法 baseChance pass-through → 同样恒 ACT（不得翻转为恒 NO_ACT）");
    assert.deepEqual(on.drained, off.drained, "同一 facts 下 ON 与 OFF 的 random 消费逐位一致");
  }
});

/* ================= 反转（真实 memory mutation） ================= */

test("exact-id 反转：B 无 PLAN→NO_ACT；addFacts 实际 PLAN→ACT；deleteFact(同一 id)→NO_ACT", () => {
  setGate(true);
  const h = startHarness();
  try {
    reset();
    memory.addFacts([BASELINE_FACT]);
    h.tick(BAND);
    assert.equal(h.sent.length, 0, "B：无 PLAN，0.24 在 baseline 概率下被拒绝");

    const plan = establishPlan(); // 真实 extractFacts 路径，事实落盘
    h.tick(BAND);
    assert.equal(h.sent.length, 1, "A：同一 r，PLAN 存在 → ACT");

    memory.deleteFact(plan.id); // 精确删除同一条 fact id
    assert.equal(planned(), null, "PLAN 必须真正退场");
    h.tick(BAND);
    assert.equal(h.sent.length, 1, "B'：同一 r，PLAN 删除后回到 NO_ACT（不再新增发送）");
    assert.equal(hasPlannedFact(facts()), false);
  } finally {
    h.stop();
  }
});

test("PLAN→HISTORY lifecycle 反转：完成后 type:'event' 消失，外层门自动回落 baseChance", () => {
  setGate(true);
  const h = startHarness();
  try {
    reset();
    memory.addFacts([BASELINE_FACT]);
    const plan = establishPlan();
    h.tick(BAND);
    assert.equal(h.sent.length, 1, "A：PLAN 存在 → ACT");

    const r = applyCompletion(); // Phase 7-F 既有 resolver + deleteFact + addFacts，零重新实现
    assert.equal(r.applied, true);
    assert.equal(planned(), null, "completion 后 PLAN 退场");
    const hist = facts().find((f) => String(f.type).startsWith(HISTORY_TYPE_PREFIX));
    assert.ok(hist, "HISTORY 进场");
    assert.equal(hasPlannedFact(facts()), false, "history:* 不是 PLAN");

    // policy 级：同一 facts 喂给纯函数，必须返回 baseline 概率
    assert.equal(effectiveInitiateChance({ facts: facts(), baseChance: BASE, enabled: true }), BASE,
      "未完成的事情提高发起概率；事情完成后这份行动压力消失");

    h.tick(BAND);
    assert.equal(h.sent.length, 1, "B'：完成后同一 r 回到 NO_ACT（不再新增发送）");
  } finally {
    h.stop();
  }
});

/* ================= 重启（决策级） ================= */

test("模块重载：新模块实例对同一输入给出同一决策", () => {
  const modPath = require.resolve("../src/character-runtime/proactive-initiation");
  const original = require.cache[modPath];
  const input = { facts: [PLAN_FACT_SYNTHETIC], baseChance: BASE, enabled: true };
  const before = original.exports.effectiveInitiateChance(input);
  assert.equal(before, BASE + PLAN_BOOST);

  delete require.cache[modPath];
  try {
    const reloaded = require("../src/character-runtime/proactive-initiation");
    assert.notEqual(reloaded, original.exports, "确实是新加载的模块实例");
    assert.equal(reloaded.effectiveInitiateChance(input), before, "重载后决策逐位一致");
    assert.equal(reloaded.effectiveInitiateChance({ facts: [BASELINE_FACT], baseChance: BASE, enabled: true }), BASE);
  } finally {
    require.cache[modPath] = original; // 还原模块缓存，避免影响同文件后续用例
  }
});

test("真实独立进程：PLAN 落盘 → 新进程 policy 给出同一提升概率；删除后回落 baseline", () => {
  reset();
  memory.addFacts([BASELINE_FACT]);
  const plan = establishPlan(); // 事实同步落盘（与 p7f1 同款持久化路径）

  const out1 = JSON.parse(execFileSync("node", ["tests/fixtures/p8d-restart-probe.cjs"], { encoding: "utf8" }));
  assert.equal(out1.hasPlan, true, "新进程从磁盘读到了那条 PLAN：" + JSON.stringify(out1));
  assert.equal(out1.chance, Math.min(1, BASE + PLAN_BOOST), "决策输出跨进程稳定：PLAN 在 → 提升概率");

  memory.deleteFact(plan.id);
  const out2 = JSON.parse(execFileSync("node", ["tests/fixtures/p8d-restart-probe.cjs"], { encoding: "utf8" }));
  assert.equal(out2.hasPlan, false, "删除落盘后，新进程不再看到 PLAN");
  assert.equal(out2.chance, BASE, "决策输出跨进程稳定：PLAN 不在 → baseline 概率");

  // 结论边界：这是 decision-level restart stability（policy 输入/输出跨重启一致）。
  // 真实 60s timer 的跨重启发言频率未实测，NOT DIRECTLY DEMONSTRATED。
});

/* ================= 多 tick 确定性模拟：act_rate / plan_topic_rate / conditional_plan_share ================= */

test("600 tick 模拟：act_rate 与 plan_topic_rate 精确等于解析期望，PLAN 同时抬高两者", () => {
  const N = 600;
  const outerVals = lcgValues(20261005, N); // 两臂共用同一条外层门随机流
  const innerVals = lcgValues(20261006, N); // 每 tick 的第 2 次 draw（event 分支的抽签）

  const run = (gate, seedFacts) => simulate({ gate, seedFacts, outerVals, innerVals });

  // 四臂：A=ON+PLAN（实验臂），B=ON+无 PLAN，C=OFF+PLAN，D=OFF+无 PLAN（全部对照）
  const A = run(true, [PLAN_FACT_SYNTHETIC]);
  const B = run(true, [BASELINE_FACT]);
  const C = run(false, [PLAN_FACT_SYNTHETIC]);
  const D = run(false, [BASELINE_FACT]);

  // 解析期望：tick i 发送 ⇔ !(outerVals[i] > chance)；PLAN-topic ⇔ 发送且 innerVals[i] < EVENT_CHANCE(0.25)
  const acts = (chance) => outerVals.reduce((n, v) => n + (!(v > chance) ? 1 : 0), 0);
  const planActs = (chance) => outerVals.reduce((n, v, i) => n + ((!(v > chance) && innerVals[i] < 0.25) ? 1 : 0), 0);

  const actRate = (sent) => sent.length / N;
  const planTopicRate = (sent) => sent.filter((s) => s.prompt.includes(SUBJECT)).length / N;

  // 1) act_rate：模拟器与生产路径逐位对账，再验证因果方向
  assert.equal(A.length, acts(BOOSTED), "ON+PLAN 的发送数必须精确等于 P(outer <= 0.18+boost) 的解析期望");
  assert.equal(B.length, acts(BASE), "ON+无 PLAN 必须精确等于 baseline 期望");
  assert.equal(C.length, acts(BASE), "OFF+PLAN 必须精确等于 baseline 期望（PLAN 不得影响 OFF 臂）");
  assert.equal(D.length, acts(BASE));
  assert.equal(actRate(A) > actRate(B), true,
    "act_rate(A)=" + actRate(A) + " > act_rate(B)=" + actRate(B) + "：PLAN 因果性提高主动发起频率");
  assert.equal(C.length, B.length, "OFF 两臂逐位一致");

  // 2) plan_topic_rate：单位机会里 PLAN-directed 主动行为的绝对频率
  assert.equal(A.filter((s) => s.prompt.includes(SUBJECT)).length, planActs(BOOSTED),
    "ON+PLAN 的 PLAN-topic 发送数精确对账");
  assert.equal(planTopicRate(A) > planTopicRate(B), true,
    "plan_topic_rate(A)=" + planTopicRate(A) + " > plan_topic_rate(B)=" + planTopicRate(B) +
    "：PLAN 同时提高 PLAN-directed 主动交互的绝对频率（F1 dilution guard 通过）");
  assert.equal(planTopicRate(B), 0, "无 PLAN 臂不可能出现 PLAN-topic 输出");
  assert.ok(planTopicRate(C) > 0, "OFF+PLAN 臂仍按 baseline 内联级联偶尔谈 PLAN（内联概率未被改动）");
  assert.equal(C.filter((s) => s.prompt.includes(SUBJECT)).length, planActs(BASE), "OFF+PLAN 的 PLAN-topic 数也精确对账");

  // 3) conditional_plan_share：只报告，不强制方向（§20）。外层门与内联级联相互独立，
  //    预期 share ≈ 内联 event 命中率（≈0.25），即抬高外层门不同比稀释 PLAN 内容。
  const shareA = A.length ? planTopicRate(A) / actRate(A) : null;
  const shareC = C.length ? planTopicRate(C) / actRate(C) : null;
  assert.ok(shareA > 0 && shareA <= 1, "conditional_plan_share(A)=" + shareA + " 必须落在 (0,1]");
  assert.ok(shareC > 0 && shareC <= 1, "conditional_plan_share(C)=" + shareC + " 必须落在 (0,1]");
});
