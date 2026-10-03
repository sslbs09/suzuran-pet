"use strict";

/**
 * body-state-shadow-wiring.test.js — M1 wiring 级测试。
 *
 * 跑的是**真实接线**：从 main.js 抽取 bodyStateShadowGateEnabled / bodyStateShadow /
 * bodyStateShadowObserve / walkBroadcast 四段生产代码，用 new Function 注入 fake 后实际执行；
 * shadow 用真实的 src/body-state/shadow 模块（不是重实现）。
 *
 * 本文件不重实现 walkOnPhaseEnd，也不触碰任何 posture writer。
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");

const realShadowMod = require("../src/body-state/shadow");

const mainSource = fs.readFileSync(require.resolve("../main.js"), "utf8");

/** 抽取 M1 接线块 + walkBroadcast（严格取自生产源码）。 */
function wiringBlock() {
  const a = mainSource.indexOf("function bodyStateShadowGateEnabled");
  assert.notEqual(a, -1, "找不到 bodyStateShadowGateEnabled —— M1 接线缺失");
  const b = mainSource.indexOf("function walkSchedulePhase", a);
  assert.notEqual(b, -1, "找不到 walkSchedulePhase 边界");
  return mainSource.slice(a, b);
}

/**
 * 用真实生产接线构建一个可驱动的 walkBroadcast。
 * @param env        注入给 gate 的 env
 * @param walk       legacy walk 对象（会被就地观察，测试自行断言其未被修改）
 * @param skinHasSit 能力真值（或传非布尔以模拟未知）
 * @param shadowMod  可注入的 shadow 模块（默认用真实模块）
 */
function buildWiring(opts = {}) {
  const env = opts.env || {};
  const walk = opts.walk;
  const shadowMod = opts.shadowMod || realShadowMod;
  // 注意：不能用默认参数 `skinHasSit = true`——显式传 undefined 时会回退成 true，
  // 那就测不到「能力未知」这条路径了。这里用 in 判定是否显式提供。
  const skinHasSit = Object.prototype.hasOwnProperty.call(opts, "skinHasSit") ? opts.skinHasSit : true;
  const sent = [];
  const logs = [];
  const api = new Function(
    "process", "bodyStateShadowMod", "logTts", "walk", "skinHasSit",
    "v2StateCore", "shadowBridge", "sendToRenderer",
    "STANDBEAT_ENABLED", "STANDBEAT_POSE_ENABLED",
    "seatExitForensicBroadcastMeta", "seatExitForensicSnapshot", "edgeDiagTurnPendingId",
    wiringBlock() + "\n return { bodyStateShadow, bodyStateShadowObserve, walkBroadcast, bodyStateShadowGateEnabled };"
  )(
    { env: env },
    shadowMod,
    (tag, msg) => logs.push([tag, msg]),
    walk,
    skinHasSit,
    null, // v2StateCore gate OFF
    null, // shadowBridge gate OFF
    (ch, payload) => sent.push(payload),
    true, false,
    () => null, () => {}, 0
  );
  return { api, sent, logs, walk };
}

function makeWalk(over) {
  return Object.assign({
    active: true, resting: true, perched: false, seated: false, sunk: false,
    iconRest: false, iconTarget: false, taskbarHang: false,
    face: 1, paused: false, sleeping: false
  }, over || {});
}

/* ==================== A. gate OFF ==================== */

test("WIRE-A: gate OFF → 接线被调用但不记录任何 observation，payload 零差异", () => {
  const walk = makeWalk();
  const before = JSON.stringify(walk);
  const h = buildWiring({ env: {}, walk: walk });

  assert.equal(h.api.bodyStateShadow, null, "strict OFF：gate 关闭时不创建任何 shadow 对象");
  assert.equal(h.api.bodyStateShadowGateEnabled({}), false);
  assert.equal(h.api.bodyStateShadowGateEnabled({ SUSSURRO_BODYSTATE_SHADOW: "1" }), true, "仅 \"1\" 开启");

  h.api.walkBroadcast({});

  assert.equal(h.sent.length, 1, "生产广播照常发出");
  assert.equal(JSON.stringify(walk), before, "legacy walk 未被修改");
  assert.equal("shadow" in h.sent[0], false, "payload 零新增字段");
  assert.equal("bodyshadow" in h.sent[0], false, "M1 观察不得进入 renderer payload");
  assert.equal(h.logs.length, 0, "OFF 时零日志");
});

test("WIRE-A2: gate OFF 时直接调用 observe 也是 no-op（零成本短路）", () => {
  const walk = makeWalk();
  const h = buildWiring({ env: {}, walk: walk });
  assert.equal(h.api.bodyStateShadowObserve(), undefined, "OFF：observe 直接返回");
});

/* ==================== B. gate ON → standing 被记录 ==================== */

test("WIRE-B: gate ON → standing 观察被记录且零分歧", () => {
  const walk = makeWalk({ resting: false, seated: false });
  const before = JSON.stringify(walk);
  const h = buildWiring({ env: { SUSSURRO_BODYSTATE_SHADOW: "1" }, walk: walk });

  assert.notEqual(h.api.bodyStateShadow, null, "gate ON：shadow 对象已创建");
  h.api.walkBroadcast({});

  const s = h.api.bodyStateShadow.snapshot();
  assert.equal(s.observations, 1, "standing 观察被记录");
  assert.equal(s.divergences, 0);
  assert.equal(s.coverage.postures.standing, 1);
  assert.equal(JSON.stringify(walk), before, "legacy walk 未被修改");
  assert.equal(h.sent.length, 1, "生产广播照常发出");
});

/* ==================== C. seated + canSit → 一致 ==================== */

test("WIRE-C: gate ON + seated + canSit → 与 legacy 一致，divergence 0", () => {
  const walk = makeWalk({ seated: true, sunk: true, resting: true });
  const h = buildWiring({ env: { SUSSURRO_BODYSTATE_SHADOW: "1" }, walk: walk, skinHasSit: true });
  h.api.walkBroadcast({});

  const s = h.api.bodyStateShadow.snapshot();
  assert.equal(s.observations, 1);
  assert.equal(s.divergences, 0, "可坐的身体声称 seated 无任何分歧");
  assert.equal(s.coverage.postures.seated, 1);
  assert.equal(s.coverage.supports.taskbar, 1, "坐姿支撑面识别为 taskbar");
  assert.equal(s.coverage.capability["can-sit"], 1);
  assert.equal(s.coverage.capabilityUnknownSkips, 0);
});

test("WIRE-C2: perched 同样被识别（支撑面正确区分窗顶与图标）", () => {
  const perched = buildWiring({ env: { SUSSURRO_BODYSTATE_SHADOW: "1" }, walk: makeWalk({ perched: true }) });
  perched.api.walkBroadcast({});
  assert.equal(perched.api.bodyStateShadow.snapshot().coverage.postures.perched, 1);
  assert.equal(perched.api.bodyStateShadow.snapshot().coverage.supports["window-top"], 1);

  const icon = buildWiring({ env: { SUSSURRO_BODYSTATE_SHADOW: "1" }, walk: makeWalk({ iconRest: true, iconTarget: true }) });
  icon.api.walkBroadcast({});
  assert.equal(icon.api.bodyStateShadow.snapshot().coverage.supports.icon, 1);
});

/* ==================== D. 构造分歧 ==================== */

test("WIRE-D: 故意 disagreement → divergence +1、有界台账有条目、生产路径不受影响", () => {
  // 身体坐不了，却声称 seated —— 真实的能力违规
  const walk = makeWalk({ seated: true, sunk: true, resting: true });
  const before = JSON.stringify(walk);
  const h = buildWiring({ env: { SUSSURRO_BODYSTATE_SHADOW: "1" }, walk: walk, skinHasSit: false });

  h.api.walkBroadcast({});
  h.api.walkBroadcast({});
  h.api.walkBroadcast({});

  const s = h.api.bodyStateShadow.snapshot();
  assert.equal(s.observations, 3);
  assert.equal(s.divergences, 3, "每次能力违规都被记录");
  assert.equal(s.ledger.length, 3);
  assert.deepEqual(s.ledger[0].fields, ["capability"]);
  assert.equal(s.ledger[0].capabilityViolation, "body-cannot-sit-but-legacy-seated");
  assert.equal(s.ledger[0].capability, false, "条目自带 capability 上下文");
  assert.equal(typeof s.ledger[0].at, "number", "条目自带观测时刻");

  // 生产路径完全不受影响
  assert.equal(JSON.stringify(walk), before, "legacy walk 未被修改");
  assert.equal(h.sent.length, 3, "三次生产广播全部照常发出");
});

test("WIRE-D2: 台账有界——高频分歧不得撑爆诊断", () => {
  const walk = makeWalk({ seated: true, resting: true });
  const h = buildWiring({ env: { SUSSURRO_BODYSTATE_SHADOW: "1" }, walk: walk, skinHasSit: false });
  for (let i = 0; i < 50; i += 1) h.api.walkBroadcast({});
  const s = h.api.bodyStateShadow.snapshot();
  assert.equal(s.observations, 50, "计数不受台账上限影响");
  assert.equal(s.ledger.length, 16, "台账保持有界（默认 16）");
  assert.equal(s.divergences, 50);
});

/* ==================== E. resting 不构成姿态分歧 ==================== */

test("WIRE-E: resting 变化不得单独造成 physical posture divergence", () => {
  const walk = makeWalk({ seated: false });
  const h = buildWiring({ env: { SUSSURRO_BODYSTATE_SHADOW: "1" }, walk: walk, skinHasSit: true });

  walk.resting = true;  h.api.walkBroadcast({});
  walk.resting = false; h.api.walkBroadcast({});
  walk.resting = true;  h.api.walkBroadcast({});

  const s = h.api.bodyStateShadow.snapshot();
  assert.equal(s.observations, 3);
  assert.equal(s.divergences, 0, "resting 是策略/动画轴（ADR-009），不参与姿态裁决");
  assert.equal(s.coverage.postures.standing, 3, "三种 resting 状态都投影为同一 physical posture");
});

/* ==================== F. capability unknown ==================== */

test("WIRE-F: capability unknown → 不得制造假分歧", () => {
  const walk = makeWalk({ seated: true, sunk: true });
  const h = buildWiring({ env: { SUSSURRO_BODYSTATE_SHADOW: "1" }, walk: walk, skinHasSit: undefined });
  h.api.walkBroadcast({});

  const s = h.api.bodyStateShadow.snapshot();
  assert.equal(s.observations, 1, "观察照常进行");
  assert.equal(s.divergences, 0, "能力未知不得被当成坐不了而造假分歧");
  assert.equal(s.coverage.capabilityUnknownSkips, 1, "未知被显式标记");
  assert.equal(s.coverage.capability.unknown, 1);
  assert.equal(s.coverage.postures.seated, 1);
});

/* ==================== G. fail-open ==================== */

test("WIRE-G: shadow 内部抛错 → 生产广播照常发出（fail-open）", () => {
  const hostileShadowMod = {
    createBodyStateShadow: () => ({
      isEnabled: () => true,
      observe() { throw new Error("shadow-boom"); },
      snapshot: () => ({ observations: 0, divergences: 0 })
    })
  };
  const walk = makeWalk();
  const before = JSON.stringify(walk);
  const h = buildWiring({ env: { SUSSURRO_BODYSTATE_SHADOW: "1" }, walk: walk, shadowMod: hostileShadowMod });

  assert.doesNotThrow(() => h.api.walkBroadcast({}), "shadow 抛错不得外泄到 walkBroadcast 调用方");
  assert.equal(h.sent.length, 1, "生产广播照常发出");
  assert.equal(JSON.stringify(walk), before, "legacy walk 未被修改");
});

test("WIRE-G2: 接线本身缺失（未定义 observe）也不得阻断广播", () => {
  // 直接跑没有 bodyStateShadowObserve 的 walkBroadcast 段——模拟接线被破坏的极端情况
  const a = mainSource.indexOf("function walkBroadcast(options = {})");
  const b = mainSource.indexOf("function walkSchedulePhase", a);
  const sent = [];
  const walkBroadcast = new Function(
    "STANDBEAT_ENABLED", "STANDBEAT_POSE_ENABLED", "seatExitForensicBroadcastMeta",
    "seatExitForensicSnapshot", "shadowBridge", "walk", "edgeDiagTurnPendingId", "sendToRenderer", "v2StateCore",
    mainSource.slice(a, b) + "\n return walkBroadcast;"
  )(true, false, () => null, () => {}, null, makeWalk(), 0, (c, p) => sent.push(p), null);
  assert.doesNotThrow(() => walkBroadcast({}), "观察函数缺失时也必须 fail-open");
  assert.equal(sent.length, 1, "生产广播照常发出");
});

/* ==================== H. coverage 信号 ==================== */

test("WIRE-H: coverage 能区分「多状态覆盖」与「只见过 standing」", () => {
  const multi = buildWiring({ env: { SUSSURRO_BODYSTATE_SHADOW: "1" }, walk: makeWalk() });
  multi.walk.seated = true;  multi.api.walkBroadcast({});
  multi.walk.seated = false; multi.walk.perched = true; multi.api.walkBroadcast({});
  multi.walk.perched = false; multi.api.walkBroadcast({});
  const a = multi.api.bodyStateShadow.coverageSummary();

  const single = buildWiring({ env: { SUSSURRO_BODYSTATE_SHADOW: "1" }, walk: makeWalk() });
  single.api.walkBroadcast({});
  single.api.walkBroadcast({});
  const b = single.api.bodyStateShadow.coverageSummary();

  assert.equal(a.distinctPostures, 3, "覆盖 standing/seated/perched");
  assert.equal(b.distinctPostures, 1, "只见过 standing");
  assert.notDeepEqual(a.postureStates, b.postureStates, "两者不得等价");
  assert.equal(a.observations > b.observations, true);
});

test("WIRE-H2: coverage 只用闭合枚举，不会被脏输入撑大", () => {
  const walk = makeWalk({ seated: true });
  const h = buildWiring({ env: { SUSSURRO_BODYSTATE_SHADOW: "1" }, walk: walk, skinHasSit: "weird-value" });
  h.api.walkBroadcast({});
  const cov = h.api.bodyStateShadow.snapshot().coverage;
  assert.deepEqual(Object.keys(cov.postures), ["seated"], "只记录观测到的闭合枚举值");
  assert.deepEqual(Object.keys(cov.supports), ["taskbar"]);
  assert.equal(cov.capability.unknown, 1, "非布尔能力值归 UNKNOWN");
});

/* ==================== 诊断无敏感内容 ==================== */

test("WIRE-I: 诊断输出不含对话内容，且不上传网络", () => {
  const walk = makeWalk({ seated: true, resting: true });
  const h = buildWiring({ env: { SUSSURRO_BODYSTATE_SHADOW: "1" }, walk: walk, skinHasSit: false });
  // 触发一次摘要输出
  for (let i = 0; i < 2; i += 1) h.api.walkBroadcast({});
  h.api.walkBroadcast({});

  const lines = h.logs.map(([, m]) => String(m)).join("\n");
  for (const forbidden of ["text", "prompt", "reply", "content", "message"]) {
    assert.equal(lines.indexOf(forbidden), -1, "诊断不得包含 " + forbidden);
  }
  assert.equal(/https?:\/\//.test(lines), false, "诊断不得包含任何网络地址");
  // shadow 模块本身也不得引入网络能力
  const shadowSrc = fs.readFileSync(require.resolve("../src/body-state/shadow"), "utf8");
  for (const forbidden of ["http", "fetch", "net", "dgram", "child_process"]) {
    assert.equal(shadowSrc.indexOf(forbidden), -1, "shadow 模块不得引入 " + forbidden);
  }
});