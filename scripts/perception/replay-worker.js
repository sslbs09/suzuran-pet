"use strict";

/*
 * replay-worker.js — Phase 9-B replay 生成器（researcher-only tooling，无头受控执行）。
 *
 * 复用真实 Character Runtime proactive 路径（features.startProactive →
 * character-runtime/experience-topic.chooseExperienceTopic → lines.pick），
 * production runtime 代码零改动；本模块只在测试环境层面控制：
 *   - 时钟：FakeDate（真实 Date 的子类，仅 run() 期间替换，restoreEnvironment() 还原）
 *   - timer：setInterval 只捕获 callback，由 harness 手动驱动（不等 wall clock）
 *   - random：按 semantic opportunity 划分独立 random slot——每个 opportunity
 *     重置为三条独立流：gate 流（ACT/NO_ACT 外层门，跨臂同种子共享）、
 *     decision 值（history 分支那一次比较的受控值，schedule 显式给定）、
 *     pick 流（台词池抽取，跨臂同种子共享）。
 *     这样一个 branch short-circuit 只影响本 opportunity 的 slot，
 *     不会造成后续所有 replay 台词漂移（Phase 9-B 任务书第 14 条）。
 *
 * 公平性断言（slot 抽取记账）：continuity 臂（有 history:* fact）ACT 时恰好消费
 * gate+decision+pick=3 次 random，NO_ACT 时 1 次；control 臂 ACT=2、NO_ACT=1。
 * 记账不符 ⇒ production 消费序变化 ⇒ 本协议无法公平同步 ⇒ 输出 BLOCKER。
 *
 * 必须在 SUZURAN_TEST_USERDIR 下运行（临时目录内），不写 snapshot
 * （由 launcher 做 dump-semantic 前后比对复核）。
 */

const path = require("path");
const isolation = require("./isolation");

// fail-closed 前置断言：早于任何 src/ 模块加载（storage.js 在 require 时即绑定 userData）。
if (!process.env[isolation.USERDIR_ENV]) {
  throw new Error("PERCEPTION_ISOLATION_REFUSED: " + isolation.USERDIR_ENV
    + " 未设置：replay-worker 拒绝加载（绝不会回退到真实产品 userData）");
}

/* ---------- 受控环境（install / restore，仅 run() 期间生效） ---------- */
const RealDate = Date;
let nowMs = 0;
let envInstalled = false;
let savedRandom = null;
class FakeDate extends RealDate {
  constructor(...args) { args.length ? super(...args) : super(nowMs); }
  static now() { return nowMs; }
}
const capturedIntervals = [];
const capturedTimeouts = [];

function installEnvironment() {
  if (envInstalled) return;
  envInstalled = true;
  savedRandom = Math.random;
  global.Date = FakeDate;
  global.setInterval = (cb, ms) => { capturedIntervals.push({ cb, ms }); return capturedIntervals.length; };
  global.clearInterval = () => {};
  global.setTimeout = (cb, ms) => { capturedTimeouts.push({ cb, ms, fired: false }); return capturedTimeouts.length; };
  global.clearTimeout = () => {};
}

function restoreEnvironment() {
  if (!envInstalled) return;
  envInstalled = false;
  global.Date = RealDate;
  if (savedRandom) Math.random = savedRandom;
  capturedIntervals.length = 0;
  capturedTimeouts.length = 0;
  nowMs = 0;
}

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function parseOpts(raw) {
  const o = raw ? JSON.parse(raw) : {};
  return {
    opportunities: Number(o.opportunities || 10),
    seed: Number(o.seed || 1),
    decision: Array.isArray(o.decision) ? o.decision.map(Number) : null,
    arm: String(o.arm || ""),
    startHour: Number(o.startHour || 14)
  };
}

function run(opts) {
  installEnvironment();
  try {
    return runProtected(opts);
  } finally {
    restoreEnvironment(); // 无论成功/异常都必须还原全局环境（launcher 进程内复用）
  }
}

function runProtected(opts) {
  const safeOpts = {
    opportunities: Number.isFinite(opts.opportunities) ? opts.opportunities : 10,
    seed: Number.isFinite(opts.seed) ? opts.seed : 1,
    decision: Array.isArray(opts.decision) ? opts.decision.map(Number) : null,
    arm: String(opts.arm || ""),
    startHour: Number.isFinite(opts.startHour) ? opts.startHour : 14
  };
  opts = safeOpts;
  const userDir = isolation.assertPerceptionIsolation(); // 强制 snapshot 位于允许实验根内的 run 目录
  if (path.resolve(require("../../src/storage").PATHS.userDir) !== userDir) {
    throw new Error("replay-worker 的 userDir 与 SUZURAN_TEST_USERDIR 不一致");
  }

  const memory = require("../../src/memory");
  const facts = memory.getFactsList();
  const historyFacts = facts.filter((f) => typeof f.type === "string" && f.type.startsWith("history:"));
  const hasHistoryFact = historyFacts.length > 0;
  const historyFactText = hasHistoryFact ? String(historyFacts[historyFacts.length - 1].text || "").trim() : "";

  // 期望 history 台词池直接取自 production 决策函数（零复制模板，杜绝漂移）：
  const { chooseExperienceTopic } = require("../../src/character-runtime/experience-topic");
  const historyPool = hasHistoryFact
    ? (chooseExperienceTopic({ facts: historyFacts, random: () => 0.1, now: new RealDate(2020, 0, 1) }) || { lines: [] }).lines
    : [];

  const startMs = new RealDate(2024, 0, 15, opts.startHour, 0, 0, 0).getTime(); // 下午 14:00 起（避开清晨分支）
  nowMs = startMs; // 必须先于 require features：lastChatTs=Date.now() 在模块加载时取值，
                   // 保证每 slot idle=(k+1)min<45min，长闲置分支不消费额外 random
  const features = require("../../src/features");
  const delivered = [];
  const sendFn = (msg, mood) => { delivered.push({ atSlot: slotIdx, prompt: String(msg), mood: String(mood || "") }); };

  features.startProactive(sendFn, 1, features.PROACTIVE_DEFAULTS.chance, null);
  if (capturedIntervals.length !== 1) throw new Error("startProactive 未注册唯一 interval");
  const intervalMs = capturedIntervals[0].ms;
  const tick = capturedIntervals[0].cb;

  const slotDrawLog = [];
  let slotIdx = -1;
  let gate, decision, pick, drawCount;
  Math.random = () => {
    drawCount += 1;
    if (drawCount === 1) { const v = gate(); slotDrawLog.push({ slot: slotIdx, stream: "gate", value: v }); return v; }
    if (hasHistoryFact && drawCount === 2) { slotDrawLog.push({ slot: slotIdx, stream: "decision", value: decision }); return decision; }
    const v = pick();
    slotDrawLog.push({ slot: slotIdx, stream: "pick", value: v });
    return v;
  };

  const opportunities = [];
  for (let k = 0; k < opts.opportunities; k++) {
    slotIdx = k;
    drawCount = 0;
    gate = mulberry32((opts.seed * 2 + 1 + k * 7919) | 0);   // 跨臂共享：ACT 模式一致
    pick = mulberry32((opts.seed * 2 + 2 + k * 7919) | 0);   // 跨臂共享：台词抽取一致
    decision = (opts.decision && Number.isFinite(opts.decision[k])) ? opts.decision[k] : 0.9;
    nowMs = startMs + (k + 1) * intervalMs; // 第 k 个 opportunity：idle 恰好达到 interval 阈值
    delivered.length = 0;
    tick();
    const sent = delivered.slice();
    const draws = drawCount;
    const expected = hasHistoryFact ? (sent.length ? 3 : 1) : (sent.length ? 2 : 1);
    const prompt = sent.length ? sent[0].prompt : null;
    const kind = prompt === null ? "none" : (historyPool.indexOf(prompt) >= 0 ? "history" : "generic");
    opportunities.push({
      opportunityId: k + 1,
      clockIso: new RealDate(nowMs).toISOString(),
      act: sent.length > 0,
      delivered: sent.length > 0,
      prompt,
      mood: sent.length ? sent[0].mood : null,
      kind,
      isHistorySignal: kind === "history",
      randomDraws: draws,
      randomDrawsExpected: expected,
      idleMinutes: Math.round((nowMs - startMs) / 60000),
      drawAccountingOk: draws === expected
    });
  }
  features.stopProactive();
  restoreEnvironment();

  if (opportunities.some((o) => !o.drawAccountingOk)) {
    // 公平同步失败：production random 消费序已变 → 协议 blocker，绝不出素材
    return {
      ok: false, blocker: "RANDOM_CONSUMPTION_MISMATCH",
      arm: opts.arm, userDirTag: path.basename(userDir), opportunities, slotDrawLog
    };
  }
  return {
    ok: true,
    arm: opts.arm,
    userDirTag: path.basename(userDir),
    hasHistoryFact,
    historyFactText,
    intervalMs,
    startClockIso: new RealDate(startMs).toISOString(),
    totalOpportunities: opportunities.length,
    deliveredCount: opportunities.filter((o) => o.delivered).length,
    historySignalCount: opportunities.filter((o) => o.isHistorySignal).length,
    decisionSchedule: opts.decision,
    seed: opts.seed,
    opportunities,
    slotDrawLog,
    memoryFactsAfter: memory.getFactsList().map((f) => ({ type: f.type, text: f.text, anchor: f.anchor || null }))
  };
}

function main() {
  const opts = parseOpts(process.argv[2]);
  process.stdout.write(JSON.stringify({ ok: true, result: run(opts) }));
}

if (require.main === module) {
  try { main(); } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: String((e && e.stack) || e) }));
    process.exit(1);
  }
}

module.exports = { run, restoreEnvironment, installEnvironment, parseOpts };
