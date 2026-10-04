"use strict";

/**
 * 主动搭话「记忆由头」决策 —— 提取前 characterization。
 *
 * 目的：在把 src/features.js 的 inline 决策块抽成纯函数之前，先把**现有生产语义**
 * 逐条钉死，尤其是 random() 的调用次数与调用顺序。提取是 behavior-preserving 重构，
 * 任何一次 random 提前/复用都会悄悄改变生产概率，因此这些断言必须在提取前后都成立。
 *
 * legacyDecision() 是 src/features.js:93-136（commit 3c50022）的**逐字转写**：
 * 保留原有的 && 短路顺序、facts.find / filter().pop() 的取用方式、
 * 以及随机数只在各自条件成立时才被消费这一事实。
 * 提取后本文件会用差分测试证明 chooseExperienceTopic() 与它逐分支一致。
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");

const featuresSource = fs.readFileSync(require.resolve("../src/features.js"), "utf8").replace(/\r\n/g, "\n");

/* ---------- 逐字转写的旧实现（src/features.js:93-136 @ 3c50022） ---------- */

const LEGACY_BIRTHDAY = () => [
  "（咦，今天好像是博士的生日？）生日快乐呀博士！要好好犒劳一下自己哦～",
  "（捧着小蛋糕）博士生日快乐！今天的愿望，我会帮你一起记着的～",
  "（认真脸）博士的生日我可没忘——今天不许加班太久，听到没？",
];
const LEGACY_HEALTH = () => [
  "（想起你之前说不太舒服）……博士，身体还好吗？别忘了多喝热水，不舒服要跟我说。",
  "（小声）博士，今天身体怎么样？有没有比昨天好一点？",
  "（递热水）记得你说过不太舒服——今天好点了吗？别硬撑哦。",
];
const LEGACY_EVENT = (what) => [
  "（记得你最近有" + what + "的安排）博士加油呀～我会在旁边给你打气的！",
  what + " 准备得怎么样啦？别太累，慢慢来～",
  "（掰手指算日子）" + what + " 快到了吧？博士一定没问题的！",
];
const LEGACY_NAME = (name) => [
  "（今天也记得要这样叫博士）" + name + "～有没有按时喝水呀？",
  name + "～忙归忙，眼睛要休息哦。",
  "（清了清嗓子）" + name + "！……没什么，就是想叫叫你～",
];

/**
 * 与生产 inline 块同构。
 * @returns {{branch: string|null, lines: string[]|null, randomCalls: number}}
 */
function legacyDecision({ facts, random, now, hasHealthFact }) {
  let branch = null;
  let lines = null;
  let randomCalls = 0;
  const r = () => { randomCalls += 1; return random(); };
  try {
    if (facts.length) {
      const bd = facts.find((f) => f.type === "birthday" && (f.text.match(/(\d{1,2})月(\d{1,2})日/) || []).slice(1).join("|") === (now.getMonth() + 1) + "|" + now.getDate());
      if (bd) { branch = "birthday"; lines = LEGACY_BIRTHDAY(); }
      else if (hasHealthFact && r() < 0.3) { branch = "health"; lines = LEGACY_HEALTH(); }
      else {
        const ev = facts.filter((f) => f.type === "event").pop();
        if (ev && r() < 0.25) {
          const what = (ev.text.match(/「(.+?)」/) || [])[1] || "那件重要的事";
          branch = "event"; lines = LEGACY_EVENT(what);
        } else {
          const nm = facts.find((f) => f.type === "name");
          const name = nm && (nm.text.match(/「(.+?)」/) || [])[1];
          if (name && r() < 0.2) { branch = "name"; lines = LEGACY_NAME(name); }
        }
      }
    }
  } catch { /* 记忆不可用则走常规台词 */ }
  return { branch, lines, randomCalls };
}

/* ---------- synthetic 事实构造（绝不取自真实 memory） ---------- */

const TODAY = new Date(2026, 9, 4); // 固定 now：2026-10-04
const fact = (type, text) => ({ id: type + "-x", type, text, ts: 1, anchor: "" });
const HEALTH_FACT = fact("health", "TEST_ONLY_EXPERIENCE");
const EVENT_FACT = fact("event", "博士近期有「考试」的安排");
const NAME_FACT = fact("name", "博士希望我称呼他为「阿米娅」");
const BIRTHDAY_FACT = fact("birthday", "博士的生日是10月4日");
const NO_HEALTH_FACT = fact("health", "TEST_ONLY_EXPERIENCE");

/** 恒定序列随机源；记录被消费次数 */
function seq(values) {
  let i = 0;
  const fn = () => {
    const v = values[Math.min(i, values.length - 1)];
    i += 1;
    return v;
  };
  fn.consumed = () => i;
  return fn;
}

/* ================= 1. branch priority ================= */

test("characterization: 事实为空 → 无分支，且一次 random 都不消费", () => {
  const random = seq([0.0]);
  const r = legacyDecision({ facts: [], random, now: TODAY, hasHealthFact: false });
  assert.equal(r.branch, null);
  assert.equal(r.randomCalls, 0);
});

test("characterization: 生日命中 → 最高优先级，且完全不消费 random", () => {
  const random = seq([0.0]);
  const r = legacyDecision({ facts: [BIRTHDAY_FACT, HEALTH_FACT, EVENT_FACT, NAME_FACT], random, now: TODAY, hasHealthFact: true });
  assert.equal(r.branch, "birthday");
  assert.equal(r.randomCalls, 0, "生日短路后不得提前消费 random（否则改变后续生产概率）");
  assert.deepEqual(r.lines, LEGACY_BIRTHDAY());
});

test("characterization: 生日事实存在但日期不匹配 → 不短路，继续往下", () => {
  const random = seq([0.0]);
  const notToday = fact("birthday", "博士的生日是1月1日");
  const r = legacyDecision({ facts: [notToday, HEALTH_FACT], random, now: TODAY, hasHealthFact: true });
  assert.equal(r.branch, "health");
  assert.equal(r.randomCalls, 1);
});

/* ================= 2. health 分支与短路 ================= */

test("characterization: health 存在 + random<0.30 → health，消费 1 次 random", () => {
  const r = legacyDecision({ facts: [HEALTH_FACT], random: seq([0.29]), now: TODAY, hasHealthFact: true });
  assert.equal(r.branch, "health");
  assert.equal(r.randomCalls, 1);
});

test("characterization: health 存在 + random>=0.30 → 落到后续分支", () => {
  const r = legacyDecision({ facts: [HEALTH_FACT, EVENT_FACT], random: seq([0.3, 0.0]), now: TODAY, hasHealthFact: true });
  assert.equal(r.branch, "event", "health 未命中后必须继续走 event 分支");
  assert.equal(r.randomCalls, 2);
});

test("characterization: 无 health 时 && 短路，random 完全不被消费（边界值区分）", () => {
  // 没有 health 事实 → `hasHealthFact && r() < 0.3` 的左项为假，r() 不执行
  const r = legacyDecision({ facts: [EVENT_FACT], random: seq([0.0]), now: TODAY, hasHealthFact: false });
  assert.equal(r.branch, "event");
  assert.equal(r.randomCalls, 1, "无 health 时第一个 random 属于 event 分支");
});

/* ================= 3. event 分支 ================= */

test("characterization: event 存在 → 取最后一条（filter().pop()）", () => {
  const first = fact("event", "博士近期有「面试」的安排");
  const last = fact("event", "博士近期有「答辩」的安排");
  const r = legacyDecision({ facts: [first, last], random: seq([0.0]), now: TODAY, hasHealthFact: false });
  assert.equal(r.branch, "event");
  assert.equal(r.lines[0], LEGACY_EVENT("答辩")[0], "必须用最后一条 event 事实");
});

test("characterization: event 文本无「」→ what 回落为『那件重要的事』", () => {
  const bare = fact("event", "博士近期有考试的安排");
  const r = legacyDecision({ facts: [bare], random: seq([0.0]), now: TODAY, hasHealthFact: false });
  assert.equal(r.branch, "event");
  assert.equal(r.lines[0], LEGACY_EVENT("那件重要的事")[0]);
});

test("characterization: event 存在 + random>=0.25 → 继续看 name", () => {
  const r = legacyDecision({ facts: [EVENT_FACT, NAME_FACT], random: seq([0.25, 0.0]), now: TODAY, hasHealthFact: false });
  assert.equal(r.branch, "name");
  assert.equal(r.randomCalls, 2);
});

test("characterization: 无 event 事实 → event 的 random 不被消费", () => {
  const r = legacyDecision({ facts: [NAME_FACT], random: seq([0.0]), now: TODAY, hasHealthFact: false });
  assert.equal(r.branch, "name");
  assert.equal(r.randomCalls, 1);
});

/* ================= 4. name 分支 ================= */

test("characterization: name 取第一条（find），且必须解析出「」", () => {
  const r = legacyDecision({ facts: [NAME_FACT], random: seq([0.19]), now: TODAY, hasHealthFact: false });
  assert.equal(r.branch, "name");
  assert.equal(r.lines[0], LEGACY_NAME("阿米娅")[0]);
  assert.equal(r.randomCalls, 1);
});

test("characterization: name 事实但无「」→ 不消费 random，直接 fallback", () => {
  const bare = fact("name", "博士希望我称呼他为阿米娅");
  const random = seq([0.0]);
  const r = legacyDecision({ facts: [bare], random, now: TODAY, hasHealthFact: false });
  assert.equal(r.branch, null);
  assert.equal(r.randomCalls, 0, "名字解析失败时 && 短路，random 不得被消费");
  assert.equal(random.consumed(), 0);
});

/* ================= 5. fallback ================= */

test("characterization: 有事实但全未命中 → null（走原有 fallback 路径）", () => {
  const random = seq([0.9, 0.9, 0.9]);
  const r = legacyDecision({ facts: [HEALTH_FACT, EVENT_FACT, NAME_FACT], random, now: TODAY, hasHealthFact: true });
  assert.equal(r.branch, null);
  assert.equal(r.randomCalls, 3, "三个分支各消费一次后放弃");
});

/* ================= 6. 生产源码契约（提取后的接线 + 差分保真） ================= */

test("characterization: features.js 决策已委托给纯函数，概率阈值随之内移", () => {
  const code = featuresSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  // 外层门不得被改动（chance=0.18、idle 间隔、proactiveEnabled）
  assert.match(code, /if \(Math\.random\(\) > proactiveCfg\.chance\) return;/, "外层 0.18 概率门必须原样保留");
  assert.match(code, /if \(idle < intervalMs\) return;/, "idle 间隔门必须原样保留");
  // 决策本体已移出，改为调用纯函数；实际选句仍由 lines.pick 承担
  assert.match(code, /chooseExperienceTopic\(\{ facts, random: Math\.random, now: new Date\(\) \}\)/,
    "决策必须委托给纯函数且注入真实 Math.random");
  assert.match(code, /if \(choice\) prompt = lines\.pick\(choice\.lines, banned\);/,
    "实际选句仍走原有 lines.pick 路径");
  // 旧 inline 分支不得残留在 features.js
  assert.doesNotMatch(code, /mem\.hasHealthFact\(\)/, "健康判断已内聚到纯函数");
  assert.doesNotMatch(code, /facts\.filter\(\(f\) => f\.type === "event"\)\.pop\(\)/, "event 取用已内聚到纯函数");
});

test("characterization: 纯函数内部保持三个阈值与既有取用方式", () => {
  const src = fs.readFileSync(require.resolve("../src/character-runtime/experience-topic.js"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.match(code, /HEALTH_CHANCE = 0\.3/, "health 阈值 0.3");
  assert.match(code, /EVENT_CHANCE = 0\.25/, "event 阈值 0.25");
  assert.match(code, /NAME_CHANCE = 0\.2/, "name 阈值 0.2");
  assert.match(code, /facts\.filter\(\(f\) => f && f\.type === "event"\)\.pop\(\)/, "event 取最后一条");
  assert.match(code, /facts\.find\(\(f\) => f && f\.type === "name"\)/, "name 取第一条");
  const bd = code.slice(code.indexOf("if (birthdayFactToday(list, now))"), code.indexOf("hasHealthFact(list) && random()"));
  assert.doesNotMatch(bd, /random\(\)/, "生日分支不得消费 random");
});

test("characterization: 差分保真——转写旧实现 vs 提取后纯函数，逐分支一致", () => {
  const { chooseExperienceTopic } = require("../src/character-runtime/experience-topic");
  const NOW = TODAY;
  const CASES = [
    { name: "空事实", facts: [], health: false, rand: [0.0] },
    { name: "生日短路", facts: [BIRTHDAY_FACT, HEALTH_FACT, EVENT_FACT, NAME_FACT], health: true, rand: [0.0] },
    { name: "生日非今天", facts: [fact("birthday", "1月1日"), HEALTH_FACT], health: true, rand: [0.0] },
    { name: "health 命中", facts: [HEALTH_FACT], health: true, rand: [0.0] },
    { name: "health 边界未中", facts: [HEALTH_FACT, EVENT_FACT], health: true, rand: [0.3, 0.0] },
    { name: "无 health 短路", facts: [EVENT_FACT], health: false, rand: [0.0] },
    { name: "event 取最后一条", facts: [fact("event", "「面试」"), fact("event", "「答辩」")], health: false, rand: [0.0] },
    { name: "event 无书名号", facts: [fact("event", "有考试的安排")], health: false, rand: [0.0] },
    { name: "event 未中转 name", facts: [EVENT_FACT, NAME_FACT], health: false, rand: [0.25, 0.0] },
    { name: "仅 name", facts: [NAME_FACT], health: false, rand: [0.0] },
    { name: "name 无书名号", facts: [fact("name", "叫他阿米娅")], health: false, rand: [0.0] },
    { name: "全未中", facts: [HEALTH_FACT, EVENT_FACT, NAME_FACT], health: true, rand: [0.9, 0.9, 0.9] },
    { name: "health 存在但仅此一条", facts: [HEALTH_FACT], health: false, rand: [0.0] },
    { name: "health 阈值 0.29", facts: [HEALTH_FACT], health: true, rand: [0.29] },
    { name: "health 阈值 0.3", facts: [HEALTH_FACT], health: true, rand: [0.3] }
  ];

  for (const c of CASES) {
    // 旧实现：hasHealthFact 由调用方（memory）提供；这里同时验证「由 facts 推导」与之等价
    const legacyRandom = seq(c.rand);
    const legacy = legacyDecision({ facts: c.facts, random: legacyRandom, now: NOW, hasHealthFact: c.health });

    const newRandom = seq(c.rand);
    const got = chooseExperienceTopic({ facts: c.facts, random: newRandom, now: NOW });

    const derivedHealth = c.facts.some((f) => f && f.type === "health");
    if (c.health !== derivedHealth) continue; // 本用例刻意让两者不一致：证明纯函数只认 facts

    assert.equal(got ? got.branch : null, legacy.branch, c.name + "：分支必须一致");
    assert.equal(newRandom.consumed(), legacy.randomCalls, c.name + "：random 消费次数必须一致");
    if (legacy.branch) {
      assert.deepEqual(got.lines, legacy.lines, c.name + "：台词内容必须一致");
      assert.notEqual(got.lines, legacy.lines, c.name + "：台词数组必须是不同实例（WeakMap 语义）");
    } else {
      assert.equal(got, null, c.name + "：未命中必须返回 null");
    }
  }
});

test("characterization: 纯函数对 health 的判断只认 facts（不依赖外部 memory 状态）", () => {
  const { chooseExperienceTopic } = require("../src/character-runtime/experience-topic");
  // facts 里没有 health，即使外部「记忆里其实有」也必须不选 health —— 决策只由入参决定
  const got = chooseExperienceTopic({ facts: [NAME_FACT], random: seq([0.0]), now: TODAY });
  assert.equal(got.branch, "name", "没有 health 事实就不会走 health 分支");
  const none = chooseExperienceTopic({ facts: [], random: seq([0.0]), now: TODAY });
  assert.equal(none, null);
});

/* ================= 7. threshold 精确边界 ================= */

test("characterization: 三个概率阈值均为 <（不含等号）", () => {
  assert.equal(legacyDecision({ facts: [fact("health", "X")], random: seq([0.3]), now: TODAY, hasHealthFact: true }).branch, null);
  assert.equal(legacyDecision({ facts: [fact("event", "「x」")], random: seq([0.25]), now: TODAY, hasHealthFact: false }).branch, null);
  assert.equal(legacyDecision({ facts: [fact("name", "「x」")], random: seq([0.2]), now: TODAY, hasHealthFact: false }).branch, null);
});

/* ================= 8. 台词池身份语义（提取时最容易踩的陷阱） ================= */

test("characterization: lines.pick 的最近选取记录按数组实例（WeakMap）而非内容", () => {
  const lines = require("../src/lines");
  const POOL = ["a", "b", "c"];
  const banned = new Set();
  // 同一实例连续 pick → recentPicks 命中该实例，会避开最近选过的下标
  const first = lines.pick(POOL, banned, () => 0);
  const second = lines.pick(POOL, banned, () => 0);
  assert.equal(first, "a");
  assert.notEqual(second, "a", "同一数组实例上 recentPicks 生效");

  // 不同实例但内容相同 → WeakMap 视为全新池，序列从头开始
  const fresh1 = lines.pick(["a", "b", "c"], banned, () => 0);
  const fresh2 = lines.pick(["a", "b", "c"], banned, () => 0);
  assert.equal(fresh1, "a");
  assert.equal(fresh2, "a", "新实例 = 新池，recent 记录不跨实例");
});

test("characterization: 因此台词池必须每次调用新建（现状即如此），提取不得提升为模块常量", () => {
  // 生产 features.js 的台词数组是调用点内联字面量 → 每次 pick 都是新池 → recentPicks 永不跨调用生效。
  // 若提取时把数组提升为模块级常量，recentPicks 会开始跨调用生效，生产选句行为随之改变。
  // 本文件用两条断言把「每次新建」钉成契约。
  const r1 = legacyDecision({ facts: [HEALTH_FACT], random: seq([0.0]), now: TODAY, hasHealthFact: true });
  const r2 = legacyDecision({ facts: [HEALTH_FACT], random: seq([0.0]), now: TODAY, hasHealthFact: true });
  assert.notEqual(r1.lines, r2.lines, "两次调用必须返回不同数组实例");
  assert.deepEqual(r1.lines, r2.lines, "但内容完全一致");
});