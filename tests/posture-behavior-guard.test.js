"use strict";

/**
 * posture-behavior-guard.test.js — 真机派生**行为级**守卫（ADR-009 / D-009 迁移前置）。
 *
 * 为什么有这个文件：现有 posture 契约多为对 `mainSource` 的**文本锁**。文本锁能挡住
 * 结构被改，但挡不住「结构在、行为已经不对」。本文件**只增不减**：不解除、不削弱、
 * 不重写任何既有文本锁，只在其旁边补上**真实执行生产代码**的行为断言。
 *
 * 方法沿用仓库既有做法（render-mode.test.js 的 createWalkEngineFixture）：
 * 从 main.js 真实源码抽取函数块，用 new Function 注入 fake 后**实际执行**，
 * 断言其对外可观测行为——而不是断言源码文本长什么样。
 *
 * 覆盖任务指定的四项：
 *   ① seated seatSink 行为           → G-1 / G-2 / G-3
 *   ② standingUpUntil deadline 语义   → G-4 / G-5 / G-6
 *   ③ stand real-edge arm             → G-7（见 NOT-TESTABLE 记录，尝试真实执行）
 *   ④ Sit → StandUp → Move 转换语义   → G-8（同上）
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");

const mainSource = fs.readFileSync(require.resolve("../main.js"), "utf8");

/** 从真实源码抽取 [startMarker, endMarker) 之间的代码块。 */
function sourceBlock(src, startMarker, endMarker) {
  const a = src.indexOf(startMarker);
  assert.notEqual(a, -1, "抽取失败：找不到起始标记 " + startMarker);
  const b = src.indexOf(endMarker, a + startMarker.length);
  assert.notEqual(b, -1, "抽取失败：找不到结束标记 " + endMarker);
  return src.slice(a, b);
}

/** 构造一份 walk 形状对象，只包含本组守卫涉及的字段（其余按需再补）。 */
function makeWalk(over) {
  return Object.assign({
    active: true, paused: false, dragPaused: false, chatPaused: false, zoomPaused: false,
    sleeping: false, catToy: false, resting: true, perched: false, iconRest: false,
    seated: false, sunk: false, gotoPerch: false, returning: false, iconTarget: false,
    freeStand: false, face: 1, dir: 1, groundGap: 24, standingUpUntil: 0,
    timer: null, phaseTimer: null, flight: null, jump: null, taskbarHang: false
  }, over || {});
}

/* ==================================================================
 * ① seated seatSink 行为
 * ================================================================== */

test("BEH-1: enterRestPose —— 有坐下动画的身体进入 seated，无则站立（skinHasSit 是物理能力门）", () => {
  const block = sourceBlock(mainSource, "function enterRestPose", "/** 尺寸提交后的最终定位");
  const build = (skinHasSit) => {
    const walk = makeWalk();
    const applied = [];
    const enterRestPose = new Function(
      "walk", "skinHasSit", "applySeatPosition", "shadowBridge",
      block + "\n return enterRestPose;"
    )(walk, skinHasSit, () => applied.push(true), undefined);
    return { walk, applied, enterRestPose };
  };

  const capable = build(true);
  capable.enterRestPose();
  assert.equal(capable.walk.resting, true);
  assert.equal(capable.walk.seated, true, "有坐下动画 → seated");
  assert.equal(capable.applied.length, 1, "必须触发一次坐姿定位");

  const incapable = build(false);
  incapable.enterRestPose();
  assert.equal(incapable.walk.resting, true, "无坐下动画也进入休息");
  assert.equal(incapable.walk.seated, false, "无坐下动画的身体不得进入坐姿");
});

test("BEH-2: enterRestPose 在无坐下能力时把 sunk 一并清掉（不得留下悬空坐姿证据）", () => {
  const block = sourceBlock(mainSource, "function enterRestPose", "/** 尺寸提交后的最终定位");
  const walk = makeWalk({ seated: true, sunk: true });
  const enterRestPose = new Function(
    "walk", "skinHasSit", "applySeatPosition", "shadowBridge",
    block + "\n return enterRestPose;"
  )(walk, false, () => {}, undefined);

  enterRestPose();
  assert.equal(walk.seated, false);
  assert.equal(walk.sunk, false, "能力缺失时 sunk 必须同步清零");
});

test("BEH-3: effectiveSeatSink —— 有坐下能力才计入 seatSink，否则为 0", () => {
  const block = sourceBlock(mainSource, "function effectiveSeatSink", "function applySeatPosition");
  const build = (skinHasSit, sink) => new Function(
    "skinHasSit", "getSeatSink", block + "\n return effectiveSeatSink;"
  )(skinHasSit, () => sink);

  assert.equal(build(true, 30)(), 30, "坐姿保留 seatSink");
  assert.equal(build(false, 30)(), 0, "无坐下能力时 seatSink 为 0（不无意义下沉）");
});

test("BEH-4: applySeatPosition 的 rawTargetY —— 坐姿计入 seatSink，站姿不计入", () => {
  const block = sourceBlock(mainSource, "function applySeatPosition", "function resizeTransientActive");
  const build = (seated, sink) => {
    const walk = makeWalk({ seated: seated, sunk: seated, groundGap: 10 });
    const writes = [];
    const wa = { x: 0, y: 0, width: 1920, height: 1040 };
    const applySeatPosition = new Function(
      "walk", "win", "screen", "config", "walkGeo", "v2Locomotion", "v2StateCore",
      "effectiveSeatSink", "seatExit", "seatExitOffsetY", "shadowBridge", "applyLayer",
      block + "\n return applySeatPosition;"
    )(
      walk,
      { isDestroyed: () => false, getBounds: () => ({ x: 100, y: 900, width: 260, height: 200 }), setPosition: (x, y) => writes.push({ x, y }) },
      {},
      { getConfig: () => ({ renderMode: "spine" }) },
      { workAreaOf: () => wa },
      null, null,
      () => sink, null, () => 0, undefined, () => {}
    );
    return { walk, writes, applySeatPosition };
  };

  const standing = build(false, 30);
  standing.applySeatPosition();
  // baseY = wa.y + wa.height + groundGap - height = 0 + 1040 + 10 - 200 = 850
  assert.equal(standing.writes.at(-1).y, 850, "站姿不计入 seatSink");

  const seated = build(true, 30);
  seated.applySeatPosition();
  assert.equal(seated.writes.at(-1).y, 850 + 30, "坐姿计入 seatSink（850+30）");
  assert.equal(seated.walk.sunk, true, "sunk 恒等派生自 seated");
});

/* ==================================================================
 * ② standingUpUntil deadline 语义
 * ================================================================== */

const BEAT_BLOCK = "if (STANDBEAT_ENABLED && Number(walk.standingUpUntil) > 0)";
const BEAT_END_MARKER = "/* —— 地面状态 —— */";

/** 真实执行 walkTick 里的 stand-beat 拍分支。 */
function buildBeat(walk, opts) {
  const o = opts || {};
  const block = sourceBlock(mainSource, BEAT_BLOCK, BEAT_END_MARKER);
  const broadcasts = [];
  const scheduled = [];
  const beatEvents = [];
  const run = new Function(
    "walk", "STANDBEAT_ENABLED", "seatExit", "seatExitStep", "seatExitForensicSnapshot",
    "shadowBridge", "walkBroadcast", "walkSchedulePhase", "walkPhaseMs", "Date", "Math",
    "function beat() {\n" + block + "\n}\n return beat;"
  )(
    walk,
    o.standbeatEnabled !== false,
    o.seatExit || null,
    (why) => o.seatExitSteps.push(why),
    undefined,
    { obsBeatEnd: (d) => beatEvents.push(d) },
    () => broadcasts.push(1),
    (ms) => scheduled.push(ms),
    () => o.walkPhaseMs === undefined ? 9000 : o.walkPhaseMs,
    { now: () => o.now === undefined ? 1000 : o.now },
    Math
  );
  return { run, broadcasts, scheduled, beatEvents };
}

test("BEH-5: stand-beat 到期 → 清 deadline、切 resting=false、广播 Move、重排散步相位", () => {
  const walk = makeWalk({ seated: false, resting: true, standingUpUntil: 500 });
  const seatExitSteps = [];
  const h = buildBeat(walk, { now: 500, seatExitSteps: seatExitSteps });

  h.run();

  assert.equal(walk.standingUpUntil, 0, "到期即清 beat deadline");
  assert.equal(walk.resting, false, "到期即开始走动（resting=false）");
  assert.equal(h.broadcasts.length, 1, "切 Move 必须广播一次");
  assert.deepEqual(h.scheduled, [9000], "从真正开走这一拍起算散步时长");
  assert.deepEqual(h.beatEvents, [500], "shadow 观测到 beat-end 的原 deadline");
  assert.equal(seatExitSteps.length, 0);
});

test("BEH-6: stand-beat 未到期 → 维持 Relax 且不广播、不重排（拍内保持）", () => {
  const walk = makeWalk({ seated: false, resting: true, standingUpUntil: 2000 });
  const seatExitSteps = [];
  const h = buildBeat(walk, { now: 1500, seatExitSteps: seatExitSteps });

  h.run();

  assert.equal(walk.standingUpUntil, 2000, "未到期不得清 deadline");
  assert.equal(walk.resting, true, "拍内维持原地");
  assert.equal(h.broadcasts.length, 0, "未到期不广播（避免每拍翻转）");
  assert.equal(h.scheduled.length, 0);
});

test("BEH-7: sleeping 抢占 → 立即作废当拍，不产生 Move 广播", () => {
  const walk = makeWalk({ seated: false, resting: true, sleeping: true, standingUpUntil: 2000 });
  const h = buildBeat(walk, { now: 1500, seatExitSteps: [] });

  h.run();

  assert.equal(walk.standingUpUntil, 0, "sleeping 抢占时拍作废");
  assert.equal(h.broadcasts.length, 0, "作废的拍不得广播 Move");
  assert.equal(h.scheduled.length, 0);
});

test("BEH-8: stand-beat 关闭时整块不生效（gate 语义）", () => {
  const walk = makeWalk({ resting: true, standingUpUntil: 500 });
  const h = buildBeat(walk, { now: 900, standbeatEnabled: false, seatExitSteps: [] });
  h.run();
  assert.equal(walk.standingUpUntil, 500, "gate OFF 不得消费 beat");
  assert.equal(walk.resting, true);
  assert.equal(h.broadcasts.length, 0);
});

/* ==================================================================
 * ③ stand real-edge arm 与 ④ Sit → StandUp → Move
 * ------------------------------------------------------------------
 * 以下两条的既有护栏是文本锁：
 *   render-mode.test.js:1496  `if \(walk\.seated\) armSeatExit\("move", "phase"\);`
 *   runtime-v2-locomotion.test.js:288  armSeatExit("move","phase") ... walk.seated = false
 * 二者都位于 `walkOnPhaseEnd` 内。
 *
 * 真实执行评估见下方 NOT-TESTABLE-RECORD 区块：walkOnPhaseEnd 是 async 函数，
 * 依赖 v2Locomotion / v2StateCore / shadowBridge / win / walkGeo / desktopIconMode 等
 * 约 20 个注入符号，且其 stand-beat 分支与 plain-walk 分支共享同一段前置门。
 * 用 new Function 跑它需要把这些全部 fake 出来——那已经不是"执行生产代码"，
 * 而是一次**重实现**，违反「不要写一个假的行为测试」。
 * 因此此处**不写行为测试**，改为如实记录 NOT TESTABLE，并保留文本锁原样。
 */

/* ==================================================================
 * NOT-TESTABLE-RECORD
 * ================================================================== */

test("NOT-TESTABLE-RECORD: 已如实登记无法在当前 harness 真实表达的行为", () => {
  // 这条测试本身就是记录：断言这些行为当前只有文本锁，没有行为守卫。
  // 当未来 harness 能真实执行 walkOnPhaseEnd 时，应补上行为守卫并更新本记录。
  const textGuardsIntact = [
    // render-mode.test.js:1496 —— stand 真实边沿 arm
    /if \(walk\.seated\) armSeatExit\("move", "phase"\);/,
    // runtime-v2-locomotion.test.js:288 —— V1 原 stand-beat 路径完整保留
    /armSeatExit\("move", "phase"\);[\s\S]{0,60}walk\.seated = false;/,
    // render-mode.test.js:1584 —— deadline 仍由 main 清 beat 后广播 Move
    /walk\.standingUpUntil = 0;\s*walk\.resting = false;\s*walkBroadcast\(\);/
  ];
  for (const re of textGuardsIntact) {
    assert.match(mainSource, re, "既有文本锁必须仍然存在（本任务不得解除）");
  }
  assert.deepEqual(
    [true, true, true],
    textGuardsIntact.map((re) => re.test(mainSource)),
    "三条文本锁全部健在"
  );
});