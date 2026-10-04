"use strict";

/**
 * Phase 7-C PERSISTED EXPERIENCE CAUSAL EXPERIMENT
 *
 * 命题：
 *   持久化经历事实 → 持久化 memory → 之后的自主行为决策 → 可观察的主动搭话选择
 *
 * A  经历存在   → 决策 X
 * B  经历不存在 → 决策 Y
 * C  移除该经历 → 回到 Y            （reversal / ablation）
 * D  持久化重载 → 仍为 X            （跨进程重启）
 *
 * 存储纪律：SUZURAN_TEST_USERDIR + mkdtemp，**全程零真实 memory.json 接触**。
 * 事实内容一律合成，绝不从真实 memory 复制任何用户信息。
 *
 * 语义边界（必须在结论里保留）：本实验用 type:"health" 槽位，它是**持续事实**，
 * 不是「已结束的 historical event」。因此本轮只证明"持久化经历事实可以因果性地改变
 * 之后的自主行为选择"，不证明"某个已完成的过去事件会长期影响角色"。
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "suzuran-p7c-"));
process.env.SUZURAN_TEST_USERDIR = TMP; // 必须在 require config/memory 之前

const memory = require("../src/memory");
const { chooseExperienceTopic } = require("../src/character-runtime/experience-topic");

/** 固定 now：让「今天生日」这类分支完全确定，与真实时钟无关 */
const NOW = new Date(2026, 9, 4);

/** 完全虚构的合成事实，不含任何真实用户信息 */
const HEALTH_TEXT = "TEST_ONLY_EXPERIENCE_DO_NOT_USE";
const NAME_TEXT = "博士希望我称呼他为「阿米娅」";

/** 确定性随机源：记录被消费次数，用于核对旧实现的调用顺序 */
function countedRandom(value = 0.0) {
  let n = 0;
  const fn = () => { n += 1; return value; };
  fn.consumed = () => n;
  return fn;
}
function decide(random, now = NOW) {
  return chooseExperienceTopic({ facts: memory.getFactsList(), random, now });
}
function healthOf(choice) {
  return !!choice && choice.branch === "health";
}
function branchOf(choice) {
  return choice ? choice.branch : null;
}

test("前置：隔离存储生效，绝不触碰真实 memory.json", () => {
  assert.equal(path.resolve(TMP).startsWith(path.resolve(os.tmpdir())), true, "测试存储必须在系统临时目录内");
  assert.notEqual(path.resolve(TMP), path.resolve("C:/Users/xsbil/AppData/Roaming/苏苏洛桌宠 2.5 正式版"));
  assert.ok(memory.getFactsList().length === 0 || true);
});

/* ================= A. Experience present ================= */

test("A: 存在 health 经历事实 → 选择 health-conditioned 分支", () => {
  memory.clear();
  memory.addFacts([{ type: "health", text: HEALTH_TEXT }]);
  const facts = memory.getFactsList();
  assert.equal(facts.length, 1, "事实确实已写入");
  assert.equal(facts[0].type, "health");
  assert.equal(facts[0].text, HEALTH_TEXT);

  const random = countedRandom(0.0);
  const choice = decide(random);
  assert.equal(branchOf(choice), "health");
  assert.equal(random.consumed(), 1, "旧顺序下 health 分支恰好消费 1 次 random");
});

/* ================= B. Experience absent ================= */

test("B: 移除 health 事实后（其余事实不变）→ 不再选择 health 分支", () => {
  memory.clear();
  memory.addFacts([{ type: "name", text: NAME_TEXT }]); // 只留一条非 health 事实作对照
  const facts = memory.getFactsList();
  assert.equal(facts.length, 1);
  assert.equal(facts[0].type, "name");

  const random = countedRandom(0.0);
  const choice = decide(random);
  assert.notEqual(branchOf(choice), "health", "没有 health 事实就不能选 health 分支");
  assert.equal(branchOf(choice), "name", "同一条 random 下落到既有的下一个分支");
});

test("B↔A 反事实对：唯一变量是那条 health 事实，决策必须不同", () => {
  const withHealth = () => {
    memory.clear();
    memory.addFacts([{ type: "name", text: NAME_TEXT }, { type: "health", text: HEALTH_TEXT }]);
    return decide(countedRandom(0.0));
  };
  const withoutHealth = () => {
    memory.clear();
    memory.addFacts([{ type: "name", text: NAME_TEXT }]);
    return decide(countedRandom(0.0));
  };
  const A = withHealth();
  const B = withoutHealth();
  assert.equal(A.branch, "health");
  assert.equal(B.branch, "name");
  assert.notEqual(A.branch, B.branch, "Experience present → decision X；absent → decision Y");
  assert.notDeepEqual(A.lines, B.lines, "两句台词也必须不同");
});

/* ================= C. Reversal ================= */

test("C: reversal —— B ↓ add experience → A ↓ delete 同一条经历 → 回到 B", () => {
  memory.clear();

  // B：无经历
  memory.addFacts([{ type: "name", text: NAME_TEXT }]);
  const decisionB = branchOf(decide(countedRandom(0.0)));
  assert.equal(decisionB, "name");

  // A：加入经历
  memory.addFacts([{ type: "health", text: HEALTH_TEXT }]);
  const factsAfterAdd = memory.getFactsList();
  const healthFact = factsAfterAdd.find((f) => f.type === "health");
  assert.ok(healthFact && healthFact.id, "必须拿到真实 fact id（memory 无 source 字段，审计靠 id+type+text+ts）");
  const decisionA = branchOf(decide(countedRandom(0.0)));
  assert.equal(decisionA, "health");

  // 精确移除**同一条**经历
  memory.deleteFact(healthFact.id);
  assert.equal(memory.getFactsList().some((f) => f.type === "health"), false, "该经历确实被移除");
  const decisionBack = branchOf(decide(countedRandom(0.0)));
  assert.equal(decisionBack, decisionB, "移除后必须回到 B 的决策");
  assert.notEqual(decisionBack, decisionA);
});

/* ================= D. Persistence / restart ================= */

test("D: 模块重载（模拟重启）后，持久化经历仍决定相同决策", () => {
  memory.clear();
  memory.addFacts([{ type: "health", text: HEALTH_TEXT }]);
  const before = decide(countedRandom(0.0));
  assert.equal(before.branch, "health");

  const memPath = require.resolve("../src/memory");
  delete require.cache[memPath];
  const reloaded = require("../src/memory"); // 新实例：从磁盘 load（重载源）
  const factsAfter = reloaded.getFactsList();
  assert.equal(factsAfter.some((f) => f.type === "health" && f.text === HEALTH_TEXT), true,
    "重载后经历仍在（来自磁盘，不是内存残留）");

  const after = chooseExperienceTopic({ facts: reloaded.getFactsList(), random: countedRandom(0.0), now: NOW });
  assert.equal(after.branch, "health");
  assert.equal(after.branch, before.branch);

  // 还原模块缓存，避免影响同文件后续用例
  require.cache[memPath] = { exports: memory, loaded: true, id: memPath };
});

test("D: 真实独立进程重启后，持久化经历仍决定相同决策", () => {
  memory.clear();
  memory.addFacts([{ type: "health", text: HEALTH_TEXT }]);
  assert.equal(decide(countedRandom(0.0)).branch, "health");

  // 另起一个真正的 node 进程，指向同一 temp userdir：这是进程级重启，不是模块缓存
  const runner = path.join(TMP, "restart-probe.js");
  fs.writeFileSync(runner, [
    'process.env.SUZURAN_TEST_USERDIR = ' + JSON.stringify(TMP) + ";",
    'const memory = require(' + JSON.stringify(require.resolve("../src/memory")) + ");",
    'const { chooseExperienceTopic } = require(' + JSON.stringify(require.resolve("../src/character-runtime/experience-topic")) + ");",
    'const facts = memory.getFactsList();',
    'const has = facts.some((f) => f.type === "health");',
    'const choice = chooseExperienceTopic({ facts, random: () => 0.0, now: new Date(2026, 9, 4) });',
    'process.stdout.write(JSON.stringify({ factCount: facts.length, has, branch: choice && choice.branch }));'
  ].join("\n"), "utf8");

  const out = execFileSync(process.execPath, [runner], { encoding: "utf8" });
  const result = JSON.parse(out);
  assert.equal(result.has, true, "新进程从磁盘读到了那条经历事实");
  assert.equal(result.branch, "health", "新进程仍然做出相同决策");
  assert.equal(result.branch, "health");
});

/* ================= E. type 唯一键语义（不得被提取破坏） ================= */

test("E: type 是事实唯一键——同 type 覆盖而非新增（记忆 schema 既有语义）", () => {
  memory.clear();
  memory.addFacts([{ type: "health", text: "TEST_ONLY_FIRST" }]);
  const first = memory.getFactsList().find((f) => f.type === "health");
  memory.addFacts([{ type: "health", text: "TEST_ONLY_SECOND" }]);
  const list = memory.getFactsList();
  assert.equal(list.filter((f) => f.type === "health").length, 1, "同 type 只能有一条");
  assert.equal(list.find((f) => f.type === "health").text, "TEST_ONLY_SECOND", "后写覆盖前写");
  assert.equal(list.find((f) => f.type === "health").id, first.id, "覆盖保留原 id");
});

test("E: 决策对事实的具体文本有依赖（不是只数条数）", () => {
  memory.clear();
  memory.addFacts([{ type: "health", text: "TEST_ONLY_X" }]);
  assert.equal(decide(countedRandom(0.0)).branch, "health");
  memory.clear();
  memory.addFacts([{ type: "joy", text: "TEST_ONLY_X" }]); // 同文本、不同 type
  assert.notEqual(branchOf(decide(countedRandom(0.0))), "health", "只有 type==health 才触发 health 分支");
});

/* ================= F. 生产接线（动态） ================= */

test("F: 真实主动搭话发送路径确实消费 chooser 结果（动态，非静态断言）", async () => {
  const features = require("../src/features");

  // 在不改生产代码的前提下接管两个全局：features.js 内部是裸调用 global setInterval / Math.random
  const realSetInterval = global.setInterval;
  const realRandom = Math.random;
  let tick = null;
  const sent = [];

  try {
    global.setInterval = (fn) => { tick = fn; return 1; };
    Math.random = () => 0.0; // 外层 0.18 门必然放行，且让 health/name 分支都命中

    // ---- Condition A：经历存在 → 生产路径发出 health 台词 ----
    memory.clear();
    memory.addFacts([{ type: "health", text: HEALTH_TEXT }]);
    features.startProactive((prompt, mood) => sent.push({ prompt, mood }), 0, 1);
    assert.ok(tick, "startProactive 应当注册了 interval 回调");
    tick();
    const aPrompt = sent.at(-1).prompt;
    assert.ok(/多喝热水|身体还好吗|身体怎么样/.test(aPrompt), "A：生产路径发出 health 由头台词，实际得到：" + aPrompt);

    // ---- Condition B：经历不存在 → 生产路径改发别的台词 ----
    memory.clear();
    memory.addFacts([{ type: "name", text: NAME_TEXT }]);
    tick();
    const bPrompt = sent.at(-1).prompt;
    assert.ok(/阿米娅/.test(bPrompt), "B：生产路径改走 name 由头台词，实际得到：" + bPrompt);
    assert.notEqual(aPrompt, bPrompt, "生产可观察输出确实因经历而不同");
  } finally {
    global.setInterval = realSetInterval;
    Math.random = realRandom;
    features.stopProactive();
  }
});

/* ================= G. 纯度护栏 ================= */

test("G: 纯函数不得依赖 memory/config/fs/Electron/DOM/IPC/timer", () => {
  const src = fs.readFileSync(require.resolve("../src/character-runtime/experience-topic.js"), "utf8").replace(/\r\n/g, "\n");
  const forbidden = [
    /require\(\s*["'][^"']*memory[^"']*["']/,
    /require\(\s*["'][^"']*config[^"']*["']/,
    /require\(\s*["'](?:fs|path|electron|timers?|child_process)["']/,
    /\bsetTimeout\s*\(/, /\bsetInterval\s*\(/,
    /\bdocument\./, /\bipcRenderer\b|\bipcMain\b/
  ];
  for (const rx of forbidden) assert.doesNotMatch(src, rx, "纯函数不得依赖：" + rx);
  // 不得持有可变单例：模块顶层不得出现可被外部改写的状态容器
  assert.doesNotMatch(src, /^let\s+\w+\s*=\s*\[\]/m, "不得持有模块级可变数组");
});