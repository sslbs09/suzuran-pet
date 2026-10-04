"use strict";

/**
 * Phase 6-D.3 MINIMAL CHARACTER RUNTIME EXPERIMENT — 自动因果测试
 * EXPERIMENTAL CAUSAL-PATH PROBE, NOT PRODUCT TUNING
 *
 * 本测试要证明的唯一命题：
 *
 *   外部经历（bond.days）
 *       ↓  既有 moodOfTheDay(date, bondDays)（不修改它）
 *   派生内部状态信号（todayMood）
 *       ↓  src/character-runtime/sleep-intent.js（纯函数）
 *   意图参数（sleepIdleThresholdMs）
 *
 * 并且要证明它可被关掉：gate OFF 时这条链对经历**不敏感**（ablation 的 OFF 臂）。
 *
 * 纪律：
 *   - 全部使用 synthetic bondDays，绝不碰真实 bond.json（不 require bond、不 addExp、不改系统日期）；
 *   - 渲染层消费契约的**运行时**断言在 render-lifecycle-contract.test.js 里跑真实 renderer，
 *     本文件负责纯函数侧与 main/renderer 的静态接线护栏；
 *   - 不复算 moodOfTheDay 自己的算法（那是既有模块的职责），只断言它与本链的合成结果。
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");

const sleepIntent = require("../src/character-runtime/sleep-intent");
const moodDay = require("../src/mood-day");

const mainSource = fs.readFileSync(require.resolve("../main.js"), "utf8").replace(/\r\n/g, "\n");
const petSource = fs.readFileSync(require.resolve("../renderer/pet.js"), "utf8").replace(/\r\n/g, "\n");
const indexSource = fs.readFileSync(require.resolve("../renderer/index.html"), "utf8").replace(/\r\n/g, "\n");
const intentSource = fs.readFileSync(require.resolve("../src/character-runtime/sleep-intent.js"), "utf8").replace(/\r\n/g, "\n");

const DEFAULT_MS = 300000; // 改造前 renderer 里 5 * 60 * 1000 的逐位结果

/** 冻结的实验表（gate ON）。数值刻意拉得开，避免假阴性——不是产品调参。 */
const FROZEN_EXPERIMENT_MS = Object.freeze({
  "慵懒": 30000,
  "平静": 60000,
  "软萌": 90000,
  "温暖": 120000,
  "元气": 180000
});

/** 剥掉注释再匹配——「renderer 不重算」是关于代码的断言，注释里提到 bond.json 不算违反。 */
function codeOnly(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\/\/.*$/gm, "");
}

/** 端到端链路用的 synthetic 输入：同一天、同一段经历区间，只有 bondDays 不同。 */
const PROBE_DATE = "2026-08-27";
const PROBE_BOND_DAYS_A = 5; //  → 温暖 → 120000
const PROBE_BOND_DAYS_B = 60; //  → 慵懒 → 30000

/** 完整链路：bond.days → todayMood → sleepIdleThresholdMs（复现 main 侧的真实合成顺序）。 */
function causalChain(bondDays, enabled) {
  const mood = moodDay.moodOfTheDay(PROBE_DATE, bondDays);
  return {
    bondDays,
    mood,
    thresholdMs: sleepIntent.sleepIdleThresholdMsForMood(mood, { enabled }),
  };
}

/* ================= A. Gate-off equivalence ================= */

test("A: gate OFF 时所有心情（合法的、未知的、空的）都严格等于 300000", () => {
  const inputs = [...moodDay.MOODS, "未知心情", "", "   ", null, undefined, 0, false, {}, []];
  for (const mood of inputs) {
    assert.equal(sleepIntent.sleepIdleThresholdMsForMood(mood, { enabled: false }), DEFAULT_MS,
      "gate OFF 必须逐位保持旧行为，mood=" + JSON.stringify(mood));
  }
});

test("A: gate 缺省 / opts 缺失 / enabled 非 true 时同样回落 300000", () => {
  for (const opts of [undefined, null, {}, { enabled: 0 }, { enabled: "1" }, { enabled: "true" }, { enabled: null }]) {
    assert.equal(sleepIntent.sleepIdleThresholdMsForMood("慵懒", opts), DEFAULT_MS,
      "只有显式 enabled === true 才算开启：" + JSON.stringify(opts));
  }
});

test("A: gate 默认就是关的（config DEFAULTS 显式 false，不靠缺省）", () => {
  const configSource = fs.readFileSync(require.resolve("../src/config.js"), "utf8").replace(/\r\n/g, "\n");
  assert.match(configSource, /characterRuntimeV0Enabled:\s*false/,
    "gate 必须在 DEFAULTS 里显式为 false；只靠缺省会让「关」变成未定义行为");
  // OFF 臂的端到端形态：main 不算 mood，快照里 threshold 仍是 300000
  const off = sleepIntent.buildCharacterRuntimeV0Snapshot({ enabled: false, todayMood: "慵懒" });
  assert.deepEqual(off, { enabled: false, todayMood: "慵懒", sleepIdleThresholdMs: DEFAULT_MS });
});

/* ================= B. Mood mapping ================= */

test("B: 五个心情映射到冻结的实验阈值", () => {
  for (const [mood, ms] of Object.entries(FROZEN_EXPERIMENT_MS)) {
    assert.equal(sleepIntent.sleepIdleThresholdMsForMood(mood, { enabled: true }), ms, "心情 " + mood);
  }
});

test("B: 策略表与 mood-day 的 MOODS 集合严格一致（新增心情必须显式裁定阈值）", () => {
  assert.deepEqual(
    [...moodDay.MOODS].sort(),
    Object.keys(sleepIntent.SLEEP_IDLE_MS_BY_MOOD).sort(),
    "mood-day.MOODS 与实验阈值表不一致：新增/删除心情必须显式决定它的入睡阈值"
  );
  assert.equal(Object.keys(FROZEN_EXPERIMENT_MS).length, 5, "实验表恰好五档");
});

test("B: 五个心情两两不同（差异够大，避免假阴性）", () => {
  const values = Object.values(FROZEN_EXPERIMENT_MS);
  assert.equal(new Set(values).size, values.length, "阈值必须互不相同");
  assert.ok(Math.min(...values) <= DEFAULT_MS / 10, "最短档与默认 300s 拉开一个数量级");
});

/* ================= C. Unknown fallback ================= */

test("C: 未知 / 缺失心情在 gate ON 时回落 300000", () => {
  for (const mood of ["未知心情", "", "   ", null, undefined, "慵懒 ", "lazy"]) {
    const ms = sleepIntent.sleepIdleThresholdMsForMood(mood, { enabled: true });
    if (typeof mood === "string" && mood.trim() === "慵懒") {
      assert.equal(ms, FROZEN_EXPERIMENT_MS["慵懒"], "首尾空白应被容忍");
    } else {
      assert.equal(ms, DEFAULT_MS, "无法识别的 mood 必须回落：" + JSON.stringify(mood));
    }
  }
});

/* ================= D. Experience → Derived State ================= */

test("D: 同一日期下，不同 bondDays 产生不同 todayMood（用的是既有 moodOfTheDay）", () => {
  const a = moodDay.moodOfTheDay(PROBE_DATE, PROBE_BOND_DAYS_A);
  const b = moodDay.moodOfTheDay(PROBE_DATE, PROBE_BOND_DAYS_B);
  assert.notEqual(PROBE_BOND_DAYS_A, PROBE_BOND_DAYS_B, "前提：两段经历本身不同");
  assert.notEqual(a, b, `同一天不同羁绊天数必须给出不同心情（得到 ${a} / ${b}）`);
});

test("D: 跨重启可复现——同日期 + 同经历必得同心情（纯函数，无隐藏状态）", () => {
  const first = moodDay.moodOfTheDay(PROBE_DATE, PROBE_BOND_DAYS_B);
  const second = moodDay.moodOfTheDay(PROBE_DATE, PROBE_BOND_DAYS_B);
  assert.equal(first, second);
  assert.equal(
    sleepIntent.sleepIdleThresholdMsForMood(first, { enabled: true }),
    sleepIntent.sleepIdleThresholdMsForMood(second, { enabled: true })
  );
});

/* ================= E. End-to-end pure causal chain ================= */

test("E: 端到端——同一天，两段经历得到不同意图参数", () => {
  const a = causalChain(PROBE_BOND_DAYS_A, true);
  const b = causalChain(PROBE_BOND_DAYS_B, true);

  assert.equal(a.thresholdMs, FROZEN_EXPERIMENT_MS[a.mood], "A 臂走完整链路后落在表内");
  assert.equal(b.thresholdMs, FROZEN_EXPERIMENT_MS[b.mood], "B 臂走完整链路后落在表内");
  assert.notEqual(a.thresholdMs, b.thresholdMs, "因果链闭合：经历不同 → 未来入睡时刻不同");
});

test("E: 时间上下文也是真实输入——同经历、不同日期同样得到不同阈值", () => {
  const onDateA = moodDay.moodOfTheDay("2026-08-27", 40);
  const onDateB = moodDay.moodOfTheDay("2026-08-28", 40);
  assert.notEqual(onDateA, onDateB, "同经历不同日期心情不同（mood-of-the-day 的时间杠杆）");
  assert.notEqual(
    sleepIntent.sleepIdleThresholdMsForMood(onDateA, { enabled: true }),
    sleepIntent.sleepIdleThresholdMsForMood(onDateB, { enabled: true })
  );
});

test("E: 链条在 snapshot 形态上也成立（main 实际下发的就是这个对象）", () => {
  const snapA = sleepIntent.buildCharacterRuntimeV0Snapshot({ enabled: true, todayMood: moodDay.moodOfTheDay(PROBE_DATE, PROBE_BOND_DAYS_A) });
  const snapB = sleepIntent.buildCharacterRuntimeV0Snapshot({ enabled: true, todayMood: moodDay.moodOfTheDay(PROBE_DATE, PROBE_BOND_DAYS_B) });
  assert.equal(snapA.enabled, true);
  assert.equal(snapB.enabled, true);
  assert.notEqual(snapA.sleepIdleThresholdMs, snapB.sleepIdleThresholdMs);
});

/* ================= F. Renderer fallback contract ================= */

test("F: 渲染层消费——没有合法 snapshot threshold 就回落 300000", () => {
  const resolve = sleepIntent.resolveSleepIdleThresholdMs;
  const illegal = [undefined, null, {}, 0, "30000", true, [], { sleepIdleThresholdMs: undefined },
    { sleepIdleThresholdMs: null }, { sleepIdleThresholdMs: NaN }, { sleepIdleThresholdMs: Infinity },
    { sleepIdleThresholdMs: 0 }, { sleepIdleThresholdMs: -30000 }];
  for (const snapshot of illegal) {
    assert.equal(resolve(snapshot), DEFAULT_MS, "非法快照必须回落：" + JSON.stringify(snapshot === undefined ? null : snapshot));
  }
});

test("F: 渲染层对合法快照逐位采用（不改写、不反推 bond）", () => {
  const resolve = sleepIntent.resolveSleepIdleThresholdMs;
  for (const ms of Object.values(FROZEN_EXPERIMENT_MS).concat([DEFAULT_MS, 1, 12345])) {
    assert.equal(resolve({ enabled: true, todayMood: "任意", sleepIdleThresholdMs: ms }), ms);
  }
});

/* ================= Ablation ================= */

test("ABLATION: ON 臂——只改 bondDays，阈值改变", () => {
  const a = causalChain(PROBE_BOND_DAYS_A, true);
  const b = causalChain(PROBE_BOND_DAYS_B, true);
  assert.equal(PROBE_DATE, PROBE_DATE, "控制变量：日期相同");
  assert.notEqual(a.thresholdMs, b.thresholdMs, "ON：经历 → 意图参数");
});

test("ABLATION: OFF 臂——只改 bondDays，阈值恒为 300000（Experience -X→ Intent parameter）", () => {
  const days = [0, 1, 5, 29, 30, 31, 59, 60, 61, 120, 400, 3650];
  const seen = new Set();
  for (const d of days) {
    const mood = moodDay.moodOfTheDay(PROBE_DATE, d);
    const ms = sleepIntent.sleepIdleThresholdMsForMood(mood, { enabled: false });
    seen.add(ms);
    assert.equal(ms, DEFAULT_MS, "OFF 臂对经历必须完全不敏感：bondDays=" + d + " mood=" + mood);
  }
  assert.equal(seen.size, 1, "OFF 臂全程只有一个取值");
});

test("ABLATION: 两臂对照——同一对经历，ON 分化 / OFF 恒定", () => {
  const onA = causalChain(PROBE_BOND_DAYS_A, true).thresholdMs;
  const onB = causalChain(PROBE_BOND_DAYS_B, true).thresholdMs;
  const offA = causalChain(PROBE_BOND_DAYS_A, false).thresholdMs;
  const offB = causalChain(PROBE_BOND_DAYS_B, false).thresholdMs;
  assert.notEqual(onA, onB);
  assert.equal(offA, offB);
  assert.equal(offA, DEFAULT_MS);
});

/* ================= 边界护栏：纯模块的依赖面 ================= */

test("护栏: sleep-intent.js 不依赖 bond / memory / config / 文件系统 / 计时器 / DOM", () => {
  const forbidden = [
    /require\(\s*["'][^"']*bond[^"']*["']/,
    /require\(\s*["'][^"']*memory[^"']*["']/,
    /require\(\s*["'][^"']*config[^"']*["']/,
    /require\(\s*["'](?:fs|path|electron|timers?|child_process)["']/,
    /require\(\s*["'][^"']*mood-day[^"']*["']/,
    /\bsetTimeout\s*\(/,
    /\bsetInterval\s*\(/,
    /\bdocument\./,
    /\bipcRenderer\b|\bipcMain\b/
  ];
  for (const rx of forbidden) {
    assert.doesNotMatch(intentSource, rx, "纯策略模块不得依赖：" + rx);
  }
});

/* ================= 接线护栏：main → renderer ================= */

test("接线: main 侧 require 纯策略模块，并把快照挂进 pet:get-state 载荷", () => {
  assert.match(mainSource, /require\("\.\/src\/character-runtime\/sleep-intent"\)/,
    "main 必须 require 纯策略模块（唯一策略来源，renderer 不自己算）");
  assert.match(mainSource, /characterRuntimeV0:\s*characterRuntimeV0Snapshot\(\)/,
    "pet:get-state 载荷必须带 characterRuntimeV0 快照");
  assert.equal(mainSource.indexOf("adoptSleepIdleThreshold"), -1,
    "阈值采纳是 renderer 的消费点，main 不得直接改渲染层变量");
});

test("接线: main 侧 gate OFF 时连 todayMood 都不算（OFF 臂零派生、零日志）", () => {
  const fn = mainSource.slice(mainSource.indexOf("function characterRuntimeV0Snapshot"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.match(body, /characterRuntimeV0Enabled\(config\.getConfig\(\)\)/,
    "config 只在 main 侧解析一次");
  assert.match(body, /todayMood:\s*enabled\s*\?\s*todayMood\(\)\s*:\s*""/,
    "gate OFF 必须是零派生");
  assert.match(body, /snapshot\.enabled\s*&&\s*!characterRuntimeV0Logged/,
    "诊断日志只在 gate ON 时输出");
});

test("接线: renderer 只消费、不重算——pet.js 不碰 bond / mood-day", () => {
  const petCode = codeOnly(petSource);
  assert.doesNotMatch(petCode, /require\(\s*["'][^"']*bond[^"']*["']/,
    "renderer 不得读 bond");
  assert.doesNotMatch(petCode, /require\(\s*["'][^"']*mood-day[^"']*["']/,
    "renderer 不得自己算 todayMood");
  assert.doesNotMatch(petCode, /moodOfTheDay|bond\.json/,
    "renderer 不得出现任何心情/bond 重算痕迹");
});

test("接线: resetSleepTimer 只换掉那一个参数，timer 生命周期与调用结构不变", () => {
  const start = petSource.indexOf("function resetSleepTimer");
  assert.ok(start >= 0);
  const body = codeOnly(petSource.slice(start, petSource.indexOf("\n}\n", start)));
  assert.match(body, /if \(sleepTimer\) clearTimeout\(sleepTimer\);/, "clearTimeout 语义不变");
  assert.match(body, /setTimeout\(\(\) => \{ if \(!busy\) setMood\("sleep"\); \}, sleepIdleThresholdMs\)/,
    "只把阈值换成已解析的意图参数，回调体逐字不变");
  assert.doesNotMatch(body, /5 \* 60 \* 1000/, "resetSleepTimer 内不得再有硬编码 300s");
});

test("接线: init 必须先采纳快照再排计时器（顺序错了就退化成旧行为）", () => {
  const adopt = petSource.indexOf("adoptSleepIdleThreshold(state.characterRuntimeV0)");
  const arm = petSource.indexOf("resetSleepTimer();", adopt);
  assert.ok(adopt >= 0, "init 必须采纳快照");
  assert.ok(arm > adopt, "采纳必须早于第一次排程");
  assert.ok(petSource.includes("let sleepIdleThresholdMs = 300000"),
    "渲染层缺快照时的初值必须是 300000");
});

test("接线: 双端核心在 index.html 里先于 pet.js 加载（否则回落分支会一直生效）", () => {
  const coreAt = indexSource.indexOf("src/character-runtime/sleep-intent.js");
  const petAt = indexSource.indexOf('src="pet.js"');
  assert.ok(coreAt >= 0, "index.html 必须加载双端纯函数核心");
  assert.ok(coreAt < petAt, "纯函数核心必须早于 pet.js");
});

test("接线: 只在消费点改了一处——pet.js 中 setMood(\"sleep\") 的排程唯一", () => {
  const calls = [...petSource.matchAll(/setTimeout\(\(\) => \{ if \(!busy\) setMood\("sleep"\); \}/g)];
  assert.equal(calls.length, 1, "入睡排程点必须唯一（多处排程会让意图参数失效）");
});

test("接线: <script> 加载路径下核心真的挂上 window（生产渲染层走这条，require 走不通）", () => {
  const sandbox = { window: {}, module: undefined };
  vm.runInNewContext(intentSource, sandbox, { filename: "src/character-runtime/sleep-intent.js" });
  const core = sandbox.window.CharacterSleepIntent;
  assert.ok(core, "浏览器 script 路径必须挂 window.CharacterSleepIntent（否则 pet.js 永远走回落分支）");
  assert.equal(core.resolveSleepIdleThresholdMs({ sleepIdleThresholdMs: 30000 }), 30000);
  assert.equal(core.resolveSleepIdleThresholdMs(null), DEFAULT_MS);
  assert.equal(core.sleepIdleThresholdMsForMood("慵懒", { enabled: true }), FROZEN_EXPERIMENT_MS["慵懒"]);
  assert.equal(core.sleepIdleThresholdMsForMood("慵懒", { enabled: false }), DEFAULT_MS);
});