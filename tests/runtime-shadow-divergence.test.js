/**
 * Runtime V2 Shadow Slice v0.1 — divergence 停止语义 / 替换失效 / 有界性测试（Blocker Closure）。
 * 覆盖：#11 PREMATURE_MOTION 立即停止；#12 停止后 V1 后续事件不能完成旧 episode；
 * #13 替换后旧 geometry/capability 不能 seed 新 episode；#14 A→B→late A 身份不回滚；
 * #17 2000 重复观测全部活动存储有界 + dropped 可观测。
 */
"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");

const RS = require("../src/runtime-shadow");
const { createShadowSession } = RS;
const { DIVERGENCE_TYPES, STOP_REASONS, EPISODE_RINGS } = RS.evaluator;
const { SHADOW_PHASES } = RS.contract;
const ownership = RS.motionOwnership;

function makeSession(logs) {
  let i = 0;
  return createShadowSession({
    deps: { log: (ev, msg) => logs.push(msg), pid: 11, nowMs: () => 7000 + (i++) * 10, monoMs: () => 8000 + (i++) * 10, gitBaseline: "c63d82b", standBeatEnabled: true }
  });
}
const STABLE = { active: true, resting: true, seated: true, paused: false, sleeping: false };
const HOST = { scaleRequested: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, displayScaleFactor: 1, seatSink: 30, standSinkOffset: 0, sinkTier: "standard" };

function prime(s) {
  s.observeRendererEvidence({ v: 2, seq: 1, kind: "body-generation", payload: { renderGeneration: 3, skinId: "a.skel" }, docEpoch: 5 });
  s.record("main", "body-capability", { skinHasSit: true });
  s.record("main", "geom-report", {
    px: 10, meta: { renderGeneration: 3, docEpoch: 5 }, decision: { accepted: true, value: 10 },
    shadowGeom: { seq: 1, scaleEpoch: 0, sampledAt: { clock: "renderer-dateNow-ms", value: 6990 }, scaleApplied: 0.27, viewport: { width: 260, height: 200 }, layoutBasis: "autoScale" },
    hostAtReceive: HOST
  });
  s.record("main", "engine", { on: true });
}

function summaryOf(logs) {
  const line = logs.find((l) => l.startsWith("[RTSHADOW-EPISODE]"));
  return line ? JSON.parse(line.slice("[RTSHADOW-EPISODE] ".length)) : null;
}

test("G7：PREMATURE_MOTION 立即停止比较；后续 V1 完整 cycle 不能完成旧 episode（#11/#12）", () => {
  const logs = [];
  const s = makeSession(logs);
  prime(s);
  s.record("main", "broadcast", STABLE); // ep-A 建立
  const epAId = s.evaluator.episode.id;
  s.record("main", "stand-up-arm", { standingUpUntil: 7300, dir: 1 });
  assert.equal(s.evaluator.episode.phase, SHADOW_PHASES.STAND_UP);
  // PREMATURE_MOTION：beat 窗口内成功位移写入 → 立即停止
  s.record("main", "rect-write", { via: "walkTick", x: 105, y: 900, outcome: "succeeded", hostRectAfter: { x: 105, y: 900, width: 260, height: 200 }, translate: true });
  assert.equal(s.evaluator.episode, null, "divergence 出现 → episode 立即关闭");
  const epA = summaryOf(logs);
  assert.equal(epA.episodeId, epAId);
  assert.equal(epA.stopped, true);
  assert.equal(epA.stopReason, STOP_REASONS.DIVERGENCE + ":" + DIVERGENCE_TYPES.PREMATURE_MOTION);
  assert.equal(epA.completed, false);
  // divergence 后 geometry 又变 stale —— 也不再产生新 divergence（episode 已关）
  s.record("main", "geom-scale-changed", { scale: 1.3 });
  s.record("main", "rect-write", { via: "seat", x: 100, yBefore: 900, targetY: 930, outcome: "succeeded", hostRectAfter: { x: 100, y: 930, width: 260, height: 200 }, seated: true, sink: 30, groundGap: 10 });
  const staleCount = s.evaluator.divergenceCounts.STALE_GEOMETRY_CONSUMPTION || 0;
  assert.equal(staleCount, 0, "episode 外的 raw 写入只记录，不当 divergence");
  // V1 自己走完一个 cycle：旧 episode 不得被补成 completed
  s.record("main", "beat-end", { beatDeadline: 7300 });
  s.record("main", "enter-rest-pose", { seated: true });
  s.record("main", "broadcast", STABLE);
  assert.equal(s.evaluator.episodesCompleted, 0, "重启用前提不满足（geometry stale）→ 无任何 episode 完成");
  const epAAfter = s.summaries.find((x) => x.episodeId === epAId);
  assert.equal(epAAfter.completed, false, "旧 episode 永远 stopped，不回填成功");
  assert.equal(epAAfter.stopped, true);
});

test("G7：STALE_GEOMETRY_CONSUMPTION / ADMISSION_DIVERGENCE / RESOURCE_OWNERSHIP 同样立即停止", () => {
  // STALE_GEOMETRY_CONSUMPTION
  {
    const logs = [];
    const s = makeSession(logs);
    prime(s);
    s.record("main", "broadcast", STABLE);
    s.record("main", "geom-scale-changed", { scale: 1.3 });
    s.record("main", "rect-write", { via: "seat", x: 100, yBefore: 900, targetY: 930, outcome: "succeeded", hostRectAfter: { x: 100, y: 930, width: 260, height: 200 }, seated: true, sink: 30, groundGap: 10 });
    assert.equal(s.evaluator.episode, null);
    assert.equal(summaryOf(logs).stopReason, STOP_REASONS.DIVERGENCE + ":" + DIVERGENCE_TYPES.STALE_GEOMETRY_CONSUMPTION);
  }
  // ADMISSION_DIVERGENCE（坐姿直接进 move，跳过 stand-beat）
  {
    const logs = [];
    const s = makeSession(logs);
    prime(s);
    s.record("main", "broadcast", STABLE);
    s.record("main", "broadcast", { active: true, resting: false, seated: false, paused: false, sleeping: false });
    assert.equal(s.evaluator.episode, null);
    assert.equal(summaryOf(logs).stopReason, STOP_REASONS.DIVERGENCE + ":" + DIVERGENCE_TYPES.ADMISSION_DIVERGENCE);
  }
  // RESOURCE_OWNERSHIP_DIVERGENCE（move 相位出现 cat-toy 写入 = V1 隐藏路径）
  {
    const logs = [];
    const s = makeSession(logs);
    prime(s);
    s.record("main", "broadcast", STABLE);
    s.record("main", "stand-up-arm", { standingUpUntil: 7300, dir: 1 });
    s.record("main", "beat-end", { beatDeadline: 7300 });
    assert.equal(s.evaluator.episode.phase, SHADOW_PHASES.MOVE);
    s.record("main", "rect-write", { via: "cat-toy", x: 500, y: 900, outcome: "succeeded", hostRectAfter: { x: 500, y: 900, width: 260, height: 200 }, translate: true });
    assert.equal(s.evaluator.episode, null);
    assert.equal(summaryOf(logs).stopReason, STOP_REASONS.DIVERGENCE + ":" + DIVERGENCE_TYPES.RESOURCE_OWNERSHIP_DIVERGENCE);
  }
});

test("G8：renderer replacement —— 旧 geometry/capability 不能 seed 新 episode（#13）", () => {
  const logs = [];
  const s = makeSession(logs);
  prime(s);
  s.record("main", "broadcast", STABLE);
  assert.ok(s.evaluator.episode, "episode 已建立");
  // renderer 替换（新文档 commit）
  s.observeRendererEvidence({ v: 2, seq: 2, kind: "body-generation", payload: { renderGeneration: 1, skinId: "b.skel" }, docEpoch: 6 });
  assert.equal(s.evaluator.episode, null, "替换 → 旧 episode 停止");
  const summary = summaryOf(logs);
  assert.equal(summary.stopReason, STOP_REASONS.GENERATION_REPLACEMENT);
  assert.ok(s.evaluator.invalidated, "失效标记在位");
  assert.equal(s.evaluator.body.capability, null, "旧 capability 失效");
  assert.equal(s.evaluator.geom.measurement, null, "旧 geometry measurement 失效（不只是 stale）");
  assert.equal(s.evaluator.body.lastAnimEntry, null, "旧 entry 证据失效");
  // 替换后 capability 未重建 → 不能开新 episode
  s.record("main", "broadcast", STABLE);
  assert.equal(s.evaluator.episode, null);
  // 只重建 capability、geometry 仍无测量 → 仍不能
  s.record("main", "body-capability", { skinHasSit: true });
  s.record("main", "broadcast", STABLE);
  assert.equal(s.evaluator.episode, null);
  // 新 capability + 新 geometry 测量到位 → 新基线（新 episode）
  s.record("main", "geom-report", { px: 12, meta: { renderGeneration: 1, docEpoch: 6 }, decision: { accepted: true, value: 12 }, shadowGeom: { seq: 1, scaleEpoch: 0, sampledAt: { clock: "renderer-dateNow-ms", value: 7500 }, scaleApplied: 0.3, viewport: { width: 260, height: 200 }, layoutBasis: "manual" }, hostAtReceive: HOST });
  s.record("main", "broadcast", STABLE);
  assert.ok(s.evaluator.episode, "新基线建立");
  assert.equal(s.evaluator.invalidated, null);
  assert.equal(s.evaluator.episode.phase, SHADOW_PHASES.STABLE_SIT);
});

test("G8：A→B→late A 身份不回滚；同代旧代证据只记 stale（#14）", () => {
  const logs = [];
  const s = makeSession(logs);
  prime(s); // identity A = {docEpoch 5, rg 3}
  s.observeRendererEvidence({ v: 2, seq: 10, kind: "body-generation", payload: { renderGeneration: 4, skinId: "a.skel" }, docEpoch: 6 }); // B
  assert.deepEqual(s.evaluator.body.generation, { docEpoch: 6, renderGeneration: 4, skinId: "a.skel", receivedAt: s.evaluator.body.generation.receivedAt });
  s.observeRendererEvidence({ v: 2, seq: 5, kind: "body-generation", payload: { renderGeneration: 3, skinId: "a.skel" }, docEpoch: 5 }); // late A
  assert.equal(s.evaluator.body.generation.docEpoch, 6, "身份不回滚");
  assert.equal(s.evaluator.body.generation.renderGeneration, 4);
  assert.ok(s.evaluator.divergenceCounts.STALE_RESULT_ACCEPTED >= 1, "旧代证据 → STALE_RESULT_ACCEPTED（只记不解释）");
  // 资源名 reused 不构成身份：同 skinId 不同 epoch = 替换，不按名字恢复
  s.observeRendererEvidence({ v: 2, seq: 20, kind: "body-generation", payload: { renderGeneration: 1, skinId: "a.skel" }, docEpoch: 7 });
  assert.equal(s.evaluator.body.generation.docEpoch, 7, "身份按 epoch/generation，不按资源名");
  s.observeRendererEvidence({ v: 2, seq: 21, kind: "body-generation", payload: { renderGeneration: 3, skinId: "a.skel" }, docEpoch: 7 });
  assert.equal(s.evaluator.body.generation.renderGeneration, 3, "同 epoch 内 generation 前进 = 替换");
});

test("G10 有界性：2000 重复观测 → 所有活动存储 by construction 有界 + dropped 可观测（#17）", () => {
  const logs = [];
  const s = makeSession(logs);
  prime(s);
  s.record("main", "broadcast", STABLE);
  s.record("main", "stand-up-arm", { standingUpUntil: 7300, dir: 1 });
  s.record("main", "beat-end", { beatDeadline: 7300 });
  s.observeRendererEvidence({ v: 2, seq: 2, kind: "anim-entry", payload: { requested: "Relax", loop: true, track: 0, renderGeneration: 3 }, docEpoch: 5 }); // move 期望矛盾
  const epId = s.evaluator.episode.id;
  for (let k = 0; k < 2000; k++) {
    s.record("main", "rect-write", { via: "walkTick", x: 100 + k, y: 900, outcome: "succeeded", hostRectAfter: { x: 100 + k, y: 900, width: 260, height: 200 }, translate: true });
  }
  const ep = s.summaries.find((x) => x.episodeId === epId) || s.evaluator.episode;
  assert.equal(s.evaluator.observationCounts.MOTION_WITH_BODY_NOT_READY, 2000, "session 级计数（固定键）");
  // episode rings bounded
  assert.ok(s.evaluator.episode === null || s.evaluator.episode.observations.length <= EPISODE_RINGS.observations);
  // force close and check ring bounds
  s.record("main", "takeover", { kind: "chat", on: true });
  const closed = s.summaries.find((x) => x.episodeId === epId);
  assert.ok(closed, "episode 已关闭");
  assert.ok(closed.observationsDropped >= 2000 - EPISODE_RINGS.observations, "observations dropped 可观测");
  assert.equal(closed.divergencesDropped, 0);
  assert.deepEqual(closed.divergenceCounts, {}, "合法 move 位移不产生 divergence");
  // session 事件 ring 有界
  assert.ok(s.ring.length <= 512, "session ring ≤ 512");
  assert.ok(s.drops > 0, "ring 丢最旧计入 drops");
  // 重复 fault 聚合
  for (let k = 0; k < 300; k++) s.noteFault("op-x", new Error("same"));
  assert.equal(s.faults.count, 300);
  assert.equal(s.faults.suppressed, 299);
  assert.ok(s.faults.recent.length <= 8);
  // 日志行数有界（非每事件一行刷屏）
  const faultLines = logs.filter((l) => l.startsWith("[RTSHADOW-FAULT]")).length;
  assert.ok(faultLines <= 4, "重复 fault 抑制刷屏，got " + faultLines);
  s.flush("bounded-test");
});

test("divergence taxonomy 单元：ownershipViolation 判定表", () => {
  const P = ownership.predictMotionOwnership;
  const V = ownership.ownershipViolation;
  assert.deepEqual(V(P("move", { takeoverKind: "drag" }), { via: "walkTick", translate: true }),
    { type: DIVERGENCE_TYPES.RESOURCE_OWNERSHIP_DIVERGENCE, reason: "translate-during-takeover:takeover:drag" });
  assert.equal(V(P("stand-up", {}), { via: "walkTick", translate: true }).type, DIVERGENCE_TYPES.PREMATURE_MOTION);
  assert.equal(V(P("stable-sit", {}), { via: "jump-ease", translate: true }).type, DIVERGENCE_TYPES.PREMATURE_MOTION);
  assert.equal(V(P("move", {}), { via: "walkTick", translate: true }), null);
  assert.equal(V(P("move", {}), { via: "mystery-writer", translate: false }), null);
  assert.equal(V(P("move", {}), { via: "cat-toy", translate: true }).type, DIVERGENCE_TYPES.RESOURCE_OWNERSHIP_DIVERGENCE);
});

test("G6/G10：missing evidence → wait-for-evidence 不是 reject；capability 已知 + geometry valid → accept", () => {
  const logs = [];
  const s = makeSession(logs);
  // 无 capability / 无 geometry：eligibility 失败 → 无 episode（等证据）
  s.record("main", "engine", { on: true });
  s.record("main", "broadcast", STABLE);
  assert.equal(s.evaluator.episode, null);
  // episode 内：geometry valid + capability known → decision accept（body readiness 不参与控制）
  prime(s);
  s.record("main", "broadcast", STABLE);
  assert.ok(s.evaluator.episode);
  const interpLine = logs.filter((l) => l.includes('"ev":"interpretation"')).pop();
  const interp = JSON.parse(interpLine.slice("[RTSHADOW] ".length));
  assert.equal(interp.decision, "accept", "readiness unknown 不得驱动 wait-for-evidence");
  assert.equal(interp.body.readiness, "unknown", "readiness 仅观察输出");
  // geometry 失效（无消费）→ decision wait-for-evidence（冻结依赖本身要求等待）
  s.record("main", "geom-scale-changed", { scale: 1.5 });
  s.record("main", "stand-up-arm", { standingUpUntil: 7400, dir: 1 });
  const interp2 = JSON.parse(logs.filter((l) => l.includes('"ev":"interpretation"')).pop().slice("[RTSHADOW] ".length));
  assert.equal(interp2.decision, "wait-for-evidence");
  assert.equal(interp2.geometry.validity, "stale");
});
