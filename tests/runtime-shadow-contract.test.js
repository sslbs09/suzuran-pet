/**
 * Runtime V2 Shadow Slice v0.1 — input contract v0.1 测试（Blocker Closure）。
 * 覆盖：#4 恶意 payload 拒收；#10 causeRef 恒 null；#18 source epoch/seq 保留；
 * #19 receivedAt ≠ sampledAt 分离；monoMs 不可得保持 null（不回退墙钟）。
 */
"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");

const RS = require("../src/runtime-shadow");
const { createShadowSession } = RS;
const { normalizeShadowEvent, createShadowRunContext, sanitizeRendererEvidence, SHADOW_CONTRACT_VERSION } = RS.contract;
const { createRendererShadowObserver } = RS.rendererObserver;

function makeSession(logs) {
  let i = 0;
  return createShadowSession({
    deps: { log: (ev, msg) => logs.push(msg), pid: 1, nowMs: () => 100 + (i++) * 10, monoMs: () => 200 + (i++) * 10, gitBaseline: "x", standBeatEnabled: true }
  });
}

test("信封白名单：非法来源/kind 拒绝（session drop 计数）", () => {
  const logs = [];
  const s = makeSession(logs);
  assert.equal(s.record("evil", "broadcast", {}), null);
  assert.equal(s.record("main", "not-a-kind", {}), null);
  assert.equal(s.drops, 2);
  assert.ok(s.record("main", "broadcast", { active: true }));
  assert.ok(s.record("renderer", "anim-entry", { requested: "Sit" }, { seq: 3 }));
});

test("G3 IPC 信任边界：恶意/畸形 renderer payload 整条拒收，main 存活（#4）", () => {
  // Astra 反例：奇异对象字段 → 整条拒绝，处理链零执行
  assert.equal(sanitizeRendererEvidence({ v: 2, seq: 4, kind: "anim-entry", payload: { requested: { toString: null } }, docEpoch: 5 }).ok, false);
  assert.equal(sanitizeRendererEvidence({ v: 2, seq: 4, kind: "anim-entry", payload: { requested: { toString: null } }, docEpoch: 5 }).reason, "bad-field:requested");
  // 非 plain object / 异型原型
  class Exotic {}
  assert.equal(sanitizeRendererEvidence(new Exotic()).ok, false);
  assert.equal(sanitizeRendererEvidence(Object.assign(Object.create({ evil: 1 }), { kind: "anim-entry", seq: 1 })).ok, false);
  assert.equal(sanitizeRendererEvidence([1, 2]).ok, false);
  assert.equal(sanitizeRendererEvidence(null).ok, false);
  assert.equal(sanitizeRendererEvidence("x").ok, false);
  // 非白名单 kind / 非法 seq / epoch
  assert.equal(sanitizeRendererEvidence({ seq: 1, kind: "takeover", payload: {} }).ok, false);
  assert.equal(sanitizeRendererEvidence({ seq: 0, kind: "anim-entry", payload: {} }).ok, false);
  assert.equal(sanitizeRendererEvidence({ seq: 1.5, kind: "anim-entry", payload: {} }).ok, false);
  assert.equal(sanitizeRendererEvidence({ seq: 1, kind: "anim-entry", payload: {}, docEpoch: -1 }).ok, false);
  assert.equal(sanitizeRendererEvidence({ seq: 1, kind: "anim-entry", payload: {}, docEpoch: "5" }).ok, false);
  // 超大 payload
  const big = { seq: 1, kind: "anim-entry", payload: { reason: "x".repeat(8192) }, docEpoch: 1 };
  assert.equal(sanitizeRendererEvidence(big).ok, false);
  assert.equal(sanitizeRendererEvidence(big).reason, "payload-too-large");
  // 非白名单键被丢弃（未知字段不进处理链）
  const leaky = sanitizeRendererEvidence({ seq: 1, kind: "anim-entry", payload: { requested: "Sit", evil: { a: 1 } }, docEpoch: 1 });
  assert.equal(leaky.ok, true);
  assert.equal("evil" in leaky.ev.payload, false);
  // session 侧：拒收计 drops、不进评估器
  const logs = [];
  const s = makeSession(logs);
  assert.equal(s.observeRendererEvidence({ v: 2, seq: 4, kind: "anim-entry", payload: { requested: { toString: null } }, docEpoch: 5 }), null);
  assert.equal(s.drops, 1);
  assert.equal(s.evaluator.body.lastAnimEntry, null);
  // JSON 序列化抛错（循环引用）→ 拒收不抛
  const circular = { seq: 1, kind: "anim-entry", payload: {}, docEpoch: 1 };
  circular.payload.self = circular;
  assert.equal(sanitizeRendererEvidence(circular).ok, false);
});

test("G3 信任边界：sender 校验在生产 handler（源码合同）", () => {
  const fs = require("node:fs");
  const mainSource = fs.readFileSync(require.resolve("../main.js"), "utf8").replace(/\r\n/g, "\n");
  assert.match(mainSource, /if \(RUNTIME_V2_SHADOW_ENABLED\) \{[\s\S]{0,120}ipcMain\.on\("pet:shadow-evidence"/, "gate OFF 不注册监听");
  assert.match(mainSource, /!win \|\| win\.isDestroyed\(\) \|\| !_e\.sender \|\| _e\.sender !== win\.webContents/, "sender 必须是当前 pet renderer webContents");
  assert.match(mainSource, /\} catch \{ \/\* 诊断链路绝不影响主进程 \*\/ \}/, "handler 顶层故障边界");
});

test("G4 事件身份：renderer 生产者 seq / sourceEpoch 原样保留，main 接收顺序独立记录（#18）", () => {
  const logs = [];
  const s = makeSession(logs);
  const e1 = s.observeRendererEvidence({ v: 2, seq: 42, kind: "anim-entry", payload: { requested: "Sit" }, docEpoch: 9 });
  assert.equal(e1.sourceSeq, 42, "renderer 生产者 seq 原样保留（不被重编号）");
  assert.equal(e1.sourceEpoch, 9, "renderer sourceEpoch = docEpoch");
  assert.equal(e1.receiveOrder, 1, "main 接收顺序独立记录");
  const m1 = s.record("main", "broadcast", {});
  const e2 = s.observeRendererEvidence({ v: 2, seq: 43, kind: "anim-entry", payload: { requested: "Move" }, docEpoch: 9 });
  assert.deepEqual([m1.sourceSeq, e1.sourceSeq, e2.sourceSeq], [1, 42, 43], "main 与 renderer 各自独立序");
  assert.notEqual(e2.receiveOrder, e2.sourceSeq, "接收顺序绝不冒充 sourceSeq");
  // 无生产者 seq → 拒收（不能伪造）
  assert.equal(s.observeRendererEvidence({ v: 2, kind: "anim-entry", payload: {}, docEpoch: 9 }), null);
});

test("G4 时钟域：sampledAt（生产者）与 receivedAt（main）分离；monoMs 不可得保持 null（#19）", () => {
  const logs = [];
  let i = 0;
  const s = createShadowSession({
    deps: { log: (ev, msg) => logs.push(msg), pid: 1, nowMs: () => 1000 + (i++) * 10, monoMs: () => null, gitBaseline: "x", standBeatEnabled: true }
  });
  const env = s.observeRendererEvidence({
    v: 2, seq: 7, kind: "anim-entry", payload: { requested: "Sit" }, docEpoch: 3,
    sampledAt: { clock: "renderer-dateNow-ms", value: 950 }
  });
  assert.deepEqual(env.sampledAt, { clock: "renderer-dateNow-ms", value: 950 }, "renderer 采样时刻原样保留");
  assert.notEqual(env.receivedAt.dateNow, env.sampledAt.value, "receivedAt ≠ sampledAt（两者独立）");
  assert.equal(env.receivedAt.monoMs, null, "单调钟不可得 → null（绝不回退墙钟冒充单调钟）");
  // main 事件：sampledAt=receivedAt 同钟（内联观察）
  const m = s.record("main", "broadcast", {});
  assert.equal(m.sampledAt.clock, "main-hrtime-dateNow");
  assert.equal(m.sampledAt.value, m.receivedAt.dateNow);
  // 恶意 sampledAt → 拒收
  assert.equal(sanitizeRendererEvidence({ seq: 1, kind: "anim-entry", payload: {}, docEpoch: 1, sampledAt: { clock: 5, value: 1 } }).ok, false);
  assert.equal(sanitizeRendererEvidence({ seq: 1, kind: "anim-entry", payload: {}, docEpoch: 1, sampledAt: { clock: "x", value: "boom" } }).ok, false);
});

test("G4 causeRef：无已证明因果 → 恒 null（#10）", () => {
  // normalize 层：无法证明 → null
  assert.equal(normalizeShadowEvent({ source: "renderer", kind: "anim-entry", payload: {}, causeRef: { source: "main", sourceSeq: 3 } }).causeRef, null,
    "v0.1 无可证明因果链 → 即使带了也不采信");
  // renderer-observer：setCause/takeCause 已删除；note 恒 null
  const obs = createRendererShadowObserver({ send: () => {}, nowMs: () => 1 });
  obs.arm({ seq: 5 });
  assert.equal(obs.note("anim-entry", { requested: "Sit" }).causeRef, null, "最近广播自动关联已删除");
  assert.equal(typeof obs.setCause, "undefined", "setCause 已删除");
  assert.equal(typeof obs.takeCause, "undefined", "takeCause 已删除");
  const src = require("node:fs").readFileSync(require.resolve("../src/runtime-shadow/renderer-observer.js"), "utf8");
  assert.doesNotMatch(src, /setCause|takeCause/, "源码中无残留");
});

test("run context 固定字段（contract version / run id / git baseline / 策略版本）", () => {
  const ctx = createShadowRunContext({ runId: "r1", gitBaseline: "c63d82b" });
  assert.equal(ctx.contractVersion, SHADOW_CONTRACT_VERSION);
  assert.equal(ctx.contractVersion, "shadow-v0.1");
  assert.equal(ctx.runId, "r1");
  assert.equal(ctx.gitBaseline, "c63d82b");
  assert.match(ctx.geometryPolicy, /sample-time-provenance/);
  assert.match(ctx.timePolicy, /cross-clock subtraction forbidden/);
});

test("renderer-observer：未激活零发送；激活后 note 上行；v2 信封带 sampledAt", () => {
  const sent = [];
  const obs = createRendererShadowObserver({ send: (ev) => sent.push(ev), nowMs: () => 42 });
  assert.equal(obs.active, false);
  assert.equal(obs.note("anim-entry", { requested: "Sit" }), null);
  assert.equal(sent.length, 0);
  obs.arm({ runId: "r1", episodeId: "ep-1", seq: 7 });
  assert.equal(obs.active, true);
  const ev = obs.note("anim-entry", { requested: "Sit", track: 0 });
  assert.equal(ev.seq, 1);
  assert.deepEqual(ev.sampledAt, { clock: "renderer-dateNow-ms", value: 42 });
  assert.equal(ev.causeRef, null);
  obs.disarm();
  assert.equal(obs.note("anim-entry", {}), null);
  assert.equal(sent.length, 1);
});

test("renderer-observer 发送失败不影响渲染（send 抛异常被吞）", () => {
  const obs = createRendererShadowObserver({ send: () => { throw new Error("ipc gone"); }, nowMs: () => 1 });
  obs.arm({ seq: 1 });
  assert.doesNotThrow(() => obs.noteSafely("fit-handoff", () => ({ kind: "hold-seat" })));
  assert.equal(obs.faults.count, 0, "send 抛错在 note 内部吞掉，不算构造 fault");
});
