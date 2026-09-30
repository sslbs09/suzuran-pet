/**
 * Runtime V2 Shadow Slice v0.1 — input contract v0.1 测试（FREEZE PHASE 3）。
 * 事件信封：sourceSeq 单来源顺序 / observedAt 时钟域 / causeRef 证明不了保持 null /
 * 晚收到不自动 stale / run context 固定字段。含 renderer-observer 双端模块单测。
 */
"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");

const RS = require("../src/runtime-shadow");
const { createShadowSession } = RS;
const { normalizeShadowEvent, createShadowRunContext, SHADOW_CONTRACT_VERSION } = RS.contract;
const { createRendererShadowObserver } = RS.rendererObserver;

test("信封白名单：非法来源/kind 拒绝（session drop 计数）", () => {
  const logs = [];
  let i = 0;
  const s = createShadowSession({
    enabled: true,
    deps: { log: (ev, msg) => logs.push(msg), pid: 1, nowMs: () => 100 + (i++) * 10, monoMs: () => 200 + (i++) * 10, gitBaseline: "c63d82b", standBeatEnabled: true }
  });
  assert.equal(s.record("evil", "broadcast", {}), null);
  assert.equal(s.record("main", "not-a-kind", {}), null);
  assert.equal(s.drops, 2);
  assert.ok(s.record("main", "broadcast", { active: true }));
  assert.ok(s.record("renderer", "anim-applied", { requested: "Sit" }));
});

test("sourceSeq 只保证单来源顺序，不伪造跨进程全局顺序", () => {
  const logs = [];
  let i = 0;
  const s = createShadowSession({
    enabled: true,
    deps: { log: (ev, msg) => logs.push(msg), pid: 1, nowMs: () => 100 + (i++) * 10, monoMs: () => 200 + (i++) * 10, gitBaseline: "x", standBeatEnabled: true }
  });
  const m1 = s.record("main", "broadcast", {});
  const r1 = s.record("renderer", "anim-applied", { requested: "Sit" });
  const m2 = s.record("main", "broadcast", {});
  const r2 = s.record("renderer", "anim-applied", { requested: "Move" });
  assert.deepEqual([m1.sourceSeq, m2.sourceSeq], [1, 2], "main 序列独立单调");
  assert.deepEqual([r1.sourceSeq, r2.sourceSeq], [1, 2], "renderer 序列独立单调");
  assert.equal(m1.source, "main");
  assert.equal(r1.source, "renderer");
});

test("observedAt 明确时钟域 {monoMs, dateNow}，由注入时钟提供", () => {
  const env = normalizeShadowEvent({ source: "main", kind: "broadcast", payload: {} });
  assert.equal(env.observedAt, null, "normalize 阶段不带时钟——由 session 注入");
  const logs = [];
  let i = 0;
  const s = createShadowSession({
    enabled: true,
    deps: { log: (ev, msg) => logs.push(msg), pid: 1, nowMs: () => 555, monoMs: () => 777, gitBaseline: "x", standBeatEnabled: true }
  });
  const env2 = s.record("main", "broadcast", {});
  assert.deepEqual(env2.observedAt, { monoMs: 777, dateNow: 555 });
});

test("causeRef 证明不了时保持 null；能证明时必须含来源+序号", () => {
  const bad = normalizeShadowEvent({ source: "renderer", kind: "anim-applied", payload: {}, causeRef: { source: "main" } });
  assert.equal(bad.causeRef, null, "缺 sourceSeq → null");
  const bad2 = normalizeShadowEvent({ source: "renderer", kind: "anim-applied", payload: {}, causeRef: { source: "nowhere", sourceSeq: 3 } });
  assert.equal(bad2.causeRef, null, "非法来源 → null");
  const ok = normalizeShadowEvent({ source: "renderer", kind: "anim-applied", payload: {}, causeRef: { source: "main", sourceSeq: 9 } });
  assert.deepEqual(ok.causeRef, { source: "main", sourceSeq: 9 });
  const none = normalizeShadowEvent({ source: "main", kind: "broadcast", payload: {} });
  assert.equal(none.causeRef, null);
});

test("晚收到不自动 stale：同代事件迟到不被拒、不被判 stale（stale 只看 identity）", () => {
  const logs = [];
  let i = 0;
  const s = createShadowSession({
    enabled: true,
    deps: { log: (ev, msg) => logs.push(msg), pid: 1, nowMs: () => 100 + (i++) * 10, monoMs: () => 200 + (i++) * 10, gitBaseline: "x", standBeatEnabled: true }
  });
  // 同代两份 geom-report 乱序到达（main 决策层都 accepted）
  s.record("main", "geom-report", { px: 10, meta: { renderGeneration: 3, docEpoch: 5 }, decision: { accepted: true, value: 10 }, supplement: {} });
  s.record("main", "geom-report", { px: 11, meta: { renderGeneration: 3, docEpoch: 5 }, decision: { accepted: true, value: 11 }, supplement: {} });
  const v = RS.geometrySnapshot.geometryValidity(s.evaluator.geom);
  assert.equal(v.validity, "valid", "同代晚到 ≠ stale");
  // 只有 identity 变化（换代）才 stale——由 geometry 测试覆盖，这里确认无时间字段参与
  assert.equal(s.evaluator.geom.measurement.observedAt !== undefined, true);
});

test("run context 固定字段（contract version / run id / git baseline / 策略版本）", () => {
  const ctx = createShadowRunContext({ runId: "r1", gitBaseline: "c63d82b", standBeatEnabled: true });
  assert.equal(ctx.contractVersion, SHADOW_CONTRACT_VERSION);
  assert.equal(ctx.contractVersion, "shadow-v0.1");
  assert.equal(ctx.runId, "r1");
  assert.equal(ctx.gitBaseline, "c63d82b");
  assert.match(ctx.geometryPolicy, /shadow-v0\.1/);
  assert.match(ctx.coordinateConvention, /electron-bounds-dip/);
  assert.match(ctx.taskbarSupportScope, /workArea-bottom-edge/);
});

test("renderer-observer：gate OFF（未 arm）零发送；arm 后 note 上行；anim-applied 才带 causeRef", () => {
  const sent = [];
  const obs = createRendererShadowObserver({ send: (ev) => sent.push(ev), nowMs: () => 42 });
  assert.equal(obs.active, false);
  assert.equal(obs.note("anim-applied", { requested: "Sit" }), null, "未激活零动作");
  assert.equal(sent.length, 0);
  // arm（main gate ON 的 broadcast 携带 shadow meta）
  obs.arm({ runId: "r1", episodeId: "ep-1", seq: 7 });
  assert.equal(obs.active, true);
  const ev = obs.note("anim-applied", { requested: "Sit", track: 0 });
  assert.ok(ev);
  assert.equal(ev.seq, 1);
  assert.deepEqual(ev.causeRef, { source: "main", sourceSeq: 7 }, "broadcast 因果可证明");
  // 非 anim-applied 不顺带因果
  const ev2 = obs.note("boundary-takeover", { kind: "headpat" });
  assert.equal(ev2.causeRef, null);
  // 无因果可证明 → null
  const sent2 = [];
  const obs2 = createRendererShadowObserver({ send: (e) => sent2.push(e), nowMs: () => 42 });
  obs2.arm({}); // 无 seq
  assert.equal(obs2.note("anim-applied", {}).causeRef, null);
  // disarm 后零发送
  obs.disarm();
  assert.equal(obs.active, false);
  assert.equal(obs.note("anim-applied", {}), null);
  assert.equal(sent.length, 2);
  assert.equal(sent2.length, 1);
});

test("renderer-observer 发送失败不影响渲染（send 抛异常被吞）", () => {
  const obs = createRendererShadowObserver({ send: () => { throw new Error("ipc gone"); }, nowMs: () => 1 });
  obs.arm({ seq: 1 });
  assert.doesNotThrow(() => obs.note("fit-handoff", { kind: "hold-seat" }));
});
