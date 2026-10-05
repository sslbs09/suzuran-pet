"use strict";

/**
 * Phase 8-D 前置 characterization —— 主动搭话「外层 proactive gate」。
 *
 * 本文件在任何生产改动落地之前先跑，目标是逐条钉死**现状**（commit 79c1cf2）：
 *   - gate 的判定语义（`Math.random() > chance` 即 NO_ACT，边界含等号）；
 *   - eligible tick 的定义（开关 → idle 阈值 → 概率门）；
 *   - 每个 eligible tick 外层门**恰好消费 1 次 random**；
 *   - miss 时短路，inner cascade 一次 random 都不消费；
 *   - hit 时 inner random 的消费顺序与旧级联逐位一致；
 *   - fallback prompt 语义（门内内容级联，仍只负责「说什么」）。
 *
 * 这些断言在 Phase 8-D 接线前后都必须成立：OFF 臂必须逐位等同 baseline。
 * 凡是需要「新增配置项」才能观察的断言（ON 臂、PLAN 检测、boost）一律不写在本文件，
 * 它们属于 tests/plan-initiation-causal.test.js。
 *
 * 存储纪律：SUZURAN_TEST_USERDIR + mkdtemp，全程零真实 memory.json 接触。
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "suzuran-p8d-char-"));
process.env.SUZURAN_TEST_USERDIR = TMP; // 必须在 require config/memory 之前

const memory = require("../src/memory");
const features = require("../src/features");

/* ---------- 合成事实（绝不取自真实 memory） ---------- */

const NAME_FACT = { type: "name", text: "博士希望我称呼他为「测试昵称」" };
const NAME_SUBJECT = "测试昵称";
const HEALTH_FACT = { type: "health", text: "TEST_ONLY_P8D_HEALTH" };
const EVENT_FACT = { type: "event", text: "博士近期有「测试答辩」的安排", anchor: "PLAN" };
const EVENT_SUBJECT = "测试答辩";

/* ---------- 旧外层门的逐字转写（src/features.js:85 @ 79c1cf2） ---------- */

/**
 * `if (Math.random() > chance) return;` 的字面语义。
 * @returns {{act: boolean, randomCalls: number}}
 */
function legacyOuterGate({ chance, random }) {
  let randomCalls = 0;
  const r = () => { randomCalls += 1; return random(); };
  return { act: !(r() > chance), randomCalls };
}

/* ---------- 真实生产 harness：接管 setInterval / Math.random，不改生产代码 ---------- */

/**
 * 在 features.js 的真实 startProactive 路径上跑 N 个 tick。
 * features.js 内部是裸调用 global setInterval 与 Math.random，所以这里只接管这两个全局。
 */
function runProactive({ chance, intervalMin = 0, ticks = 1, seedFacts = null, outerValue = 0.0, innerValues = [0.0] }) {
  const realSetInterval = global.setInterval;
  const realRandom = Math.random;
  let tick = null;
  const sent = [];
  const drained = [];
  let innerIdx = 0;

  try {
    global.setInterval = (fn) => { tick = fn; return 1; };
    // 每个 tick 的第 1 次 draw 归外层门；其余 draw 归 inner cascade（按 innerValues 顺序循环取用）
    Math.random = () => {
      let v;
      if (innerIdx === 0) {
        innerIdx = 1;
        v = outerValue;
      } else {
        v = innerValues[Math.min(innerIdx - 1, innerValues.length - 1)];
        innerIdx += 1;
      }
      drained.push(v);
      return v;
    };

    memory.clear();
    if (seedFacts) memory.addFacts(seedFacts);
    features.startProactive((prompt, mood) => sent.push({ prompt, mood }), intervalMin, chance);
    assert.ok(tick, "startProactive 应当注册了 interval 回调");
    for (let i = 0; i < ticks; i++) { innerIdx = 0; tick(); }
  } finally {
    global.setInterval = realSetInterval;
    Math.random = realRandom;
    features.stopProactive();
  }
  return { sent, drained, promptOf: () => (sent.length ? sent[sent.length - 1].prompt : null) };
}

/* ================= 1. 外层门判定语义（逐字冻结） ================= */

test("characterization: 外层门是 `Math.random() > chance` → NO_ACT，等号放行", () => {
  assert.equal(legacyOuterGate({ chance: 0.18, random: () => 0.0 }).act, true);
  assert.equal(legacyOuterGate({ chance: 0.18, random: () => 0.18 }).act, true, "0.18 > 0.18 为假 → 放行");
  assert.equal(legacyOuterGate({ chance: 0.18, random: () => 0.180001 }).act, false);
  assert.equal(legacyOuterGate({ chance: 0.18, random: () => 0.9 }).act, false);
  assert.equal(legacyOuterGate({ chance: 0.18, random: () => 0.999999 }).act, false);
  assert.equal(legacyOuterGate({ chance: 0.18, random: () => 0.0 }).randomCalls, 1, "外层门恰好消费 1 次 random");
});

test("characterization: 真实生产路径逐位等同 baseline（chance=0.18 的三个边界）", () => {
  assert.equal(runProactive({ chance: 0.18, outerValue: 0.0 }).sent.length, 1, "0.0 → ACT");
  assert.equal(runProactive({ chance: 0.18, outerValue: 0.18 }).sent.length, 1, "0.18（等号）→ ACT");
  assert.equal(runProactive({ chance: 0.18, outerValue: 0.19 }).sent.length, 0, "0.19 → NO_ACT");
});

test("characterization: startProactive 的默认 chance 就是 PROACTIVE_DEFAULTS.chance = 0.18", () => {
  const featuresSrc = fs.readFileSync(require.resolve("../src/features.js"), "utf8").replace(/\r\n/g, "\n");
  assert.match(featuresSrc, /const PROACTIVE_DEFAULTS = Object\.freeze\(\{ intervalMin: 12, chance: 0\.18 \}\);/,
    "默认概率常量必须逐位保持 0.18（Phase 8-D 禁止改这个数）");
  // 走默认参数（不传 chance）时行为同样落在 0.18
  assert.equal(runProactive({ chance: undefined, outerValue: 0.18 }).sent.length, 1);
  assert.equal(runProactive({ chance: undefined, outerValue: 0.19 }).sent.length, 0);
});

/* ================= 2. eligible tick 语义与 random 消费次数 ================= */

test("characterization: eligible tick 外层门恰好消费 1 次 random；miss 后 inner 零消费", () => {
  const miss = runProactive({ chance: 0.18, outerValue: 0.9, innerValues: [0.0] });
  assert.equal(miss.sent.length, 0, "miss → 绝不调用 sendFn");
  assert.equal(miss.drained.length, 1, "miss 时整个 tick 只消费 1 次 random（外层门），inner 一次都没有");
  assert.equal(miss.drained[0], 0.9, "外层门是本 tick 的第 1 次 draw");
});

test("characterization: hit 时本 tick 的第 1 次 draw 仍归外层门（顺序未被打乱）", () => {
  const hit = runProactive({ chance: 0.18, outerValue: 0.0, innerValues: [0.0] });
  assert.equal(hit.sent.length, 1, "hit → 恰好发送一次");
  assert.equal(hit.drained[0], 0.0);
  assert.ok(hit.drained.length >= 2, "hit 之后 inner cascade 还会继续消费 random");
});

test("characterization: 不合格 tick（未达 idle 阈值）零 random 消费", () => {
  // intervalMin=1 → 60s 阈值；模块刚加载，idle ≈ 0ms → 外层门根本到不了
  const idle = runProactive({ chance: 0.18, intervalMin: 1, outerValue: 0.0 });
  assert.equal(idle.sent.length, 0);
  assert.equal(idle.drained.length, 0, "idle 门在概率门之前 return，零 random");
});

test("characterization: 开关关闭时零 random 消费（enabled 门仍是最外层）", () => {
  const realSetInterval = global.setInterval;
  const realRandom = Math.random;
  let tick = null;
  let drained = 0;
  try {
    global.setInterval = (fn) => { tick = fn; return 1; };
    Math.random = () => { drained += 1; return 0.0; };
    features.startProactive(() => {}, 0, 0.18);
    features.setProactiveEnabled(false);
    tick();
    assert.equal(drained, 0, "proactiveEnabled=false → 零 random");
  } finally {
    global.setInterval = realSetInterval;
    Math.random = realRandom;
    features.setProactiveEnabled(true);
    features.stopProactive();
  }
});

/* ================= 3. inner cascade 的 random 顺序（命中/未命中双向锁） ================= */

test("characterization: name 分支读的是本 tick 第 2 次 draw（第 1 次归外层门）", () => {
  // 事实只有 name：birthday/health/event 全部 && 短路不消费 → name 分支应当正好读第 2 次 draw
  const hit = runProactive({ chance: 0.18, outerValue: 0.0, seedFacts: [NAME_FACT], innerValues: [0.0, 0.9] });
  assert.ok(hit.promptOf().includes(NAME_SUBJECT), "第 2 次 draw=0.0 < 0.2 → 必须命中 name 台词：" + hit.promptOf());

  const miss = runProactive({ chance: 0.18, outerValue: 0.0, seedFacts: [NAME_FACT], innerValues: [0.5, 0.9] });
  assert.equal(miss.promptOf().includes(NAME_SUBJECT), false,
    "第 2 次 draw=0.5 不小于 0.2 → 不得出现 name 台词（若外层门多消费一次 random，这里会读 0.9 之外的错位值）：" + miss.promptOf());
});

test("characterization: health 分支读的是本 tick 第 2 次 draw", () => {
  const HEALTH_LINE = /多喝热水|身体还好吗|身体怎么样|不太舒服/;
  const hit = runProactive({ chance: 0.18, outerValue: 0.0, seedFacts: [HEALTH_FACT], innerValues: [0.0, 0.9] });
  assert.match(hit.promptOf(), HEALTH_LINE, "0.0 < 0.3 → 命中 health：" + hit.promptOf());

  const miss = runProactive({ chance: 0.18, outerValue: 0.0, seedFacts: [HEALTH_FACT], innerValues: [0.5, 0.9] });
  assert.doesNotMatch(miss.promptOf(), HEALTH_LINE, "0.5 不小于 0.3 → 不得出现 health 台词：" + miss.promptOf());
});

test("characterization: event 分支读的是本 tick 第 2 次 draw", () => {
  const hit = runProactive({ chance: 0.18, outerValue: 0.0, seedFacts: [EVENT_FACT], innerValues: [0.0, 0.9] });
  assert.ok(hit.promptOf().includes(EVENT_SUBJECT), "0.0 < 0.25 → 命中 event：" + hit.promptOf());

  const miss = runProactive({ chance: 0.18, outerValue: 0.0, seedFacts: [EVENT_FACT], innerValues: [0.5, 0.9] });
  assert.equal(miss.promptOf().includes(EVENT_SUBJECT), false, "0.5 不小于 0.25 → 不得出现 event 台词：" + miss.promptOf());
});

/* ================= 4. memory 里有没有 PLAN，对现状的外层门零影响（OFF 臂预锁） ================= */

test("characterization: 现状下 PLAN 事实存在与否，对外层门的 ACT/NO_ACT 判定没有任何影响", () => {
  for (const outerValue of [0.0, 0.18, 0.19, 0.25]) {
    const withoutPlan = runProactive({ chance: 0.18, outerValue, seedFacts: [{ type: "joy", text: "TEST_ONLY_BASELINE" }] });
    const withPlan = runProactive({ chance: 0.18, outerValue, seedFacts: [EVENT_FACT, { type: "joy", text: "TEST_ONLY_BASELINE" }] });
    assert.equal(withPlan.sent.length, withoutPlan.sent.length,
      "outer=" + outerValue + "：有无 PLAN 的 ACT/NO_ACT 结果必须相同（现状语义）");
    assert.equal(withPlan.drained[0], withoutPlan.drained[0],
      "outer=" + outerValue + "：外层门读到的 random 必须相同");
  }
});

/* ================= 5. 内层概率常量逐位冻结（Phase 8-D 禁止改动） ================= */

test("characterization: 内层概率常量逐位冻结（0.25 / 0.18 / 0.2 / 0.4 与 chooser 四个阈值）", () => {
  const featuresSrc = fs.readFileSync(require.resolve("../src/features.js"), "utf8").replace(/\r\n/g, "\n");
  assert.match(featuresSrc, /h >= 5 && h < 8 && Math\.random\(\) < 0\.25/, "清晨门 0.25");
  assert.match(featuresSrc, /\(st\.key === "fd" \|\| st\.key === "xl" \|\| st\.key === "sy"\) && Math\.random\(\) < 0\.18/, "阶段门 0.18");
  assert.match(featuresSrc, /isMilestone && days > lastMilestoneSaid && Math\.random\(\) < 0\.2/, "里程碑门 0.2");
  assert.match(featuresSrc, /idle > 45 \* 60 \* 1000 && Math\.random\(\) < 0\.4/, "超长闲置门 0.4");

  const { HEALTH_CHANCE, EVENT_CHANCE, NAME_CHANCE, HISTORY_RECALL_CHANCE } =
    require("../src/character-runtime/experience-topic");
  assert.equal(HEALTH_CHANCE, 0.3);
  assert.equal(EVENT_CHANCE, 0.25);
  assert.equal(NAME_CHANCE, 0.2);
  assert.equal(HISTORY_RECALL_CHANCE, 0.2);
});

/* ================= 6. 归属纪律：投递安全闸门仍只属于 main.js ================= */

test("characterization: features.js 不掌握任何投递安全闸门（窗口可见 / 离开 / lineGate / force）", () => {
  const featuresSrc = fs.readFileSync(require.resolve("../src/features.js"), "utf8");
  for (const token of ["isWindowVisible", "awaySince", "lineGate", "force"]) {
    assert.equal(featuresSrc.includes(token), false,
      "features.js 不得触碰投递安全闸门：" + token + "（角色意图 ≠ 投递许可）");
  }

  const mainSrc = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  const start = mainSrc.indexOf("function sendProactive(text, emotion, { force = false } = {})");
  assert.ok(start > 0, "main.js 必须保留 sendProactive 作为唯一投递闸门");
  const body = mainSrc.slice(start, start + 500);
  assert.match(body, /if \(!force && !isWindowVisible\(\)\) return false;/, "窗口不可见闸门");
  assert.match(body, /if \(!force && awaySince\) return false;/, "离开模式闸门");
  assert.match(body, /lineGate\.admit\(t, \{ force \}\)/, "台词冷却/去重闸门");
});

/* ================= 7. 隔离存储 ================= */

test("前置：隔离存储生效，绝不触碰真实 memory.json", () => {
  assert.equal(path.resolve(TMP).startsWith(path.resolve(os.tmpdir())), true);
});
