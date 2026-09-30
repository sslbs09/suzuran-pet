/**
 * Runtime V2 Shadow Slice v0.1 — divergence / 停止规则 / renderer 替换测试。
 * 覆盖 FREEZE PHASE 15 #6（旧代证据拒绝）、#7（替换失效）、#8（missing evidence → unknown，
 * 不是 false/reject）、#9（path divergence 停止）、#10（divergence 后 V1 result 不回填成功）。
 */
"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");

const RS = require("../src/runtime-shadow");
const { createShadowSession, evaluator } = RS;
const { DIVERGENCE_TYPES, STOP_REASONS } = evaluator;
const { SHADOW_PHASES } = RS.contract;
const ownership = RS.motionOwnership;

function makeSession(logs) {
  let i = 0;
  return createShadowSession({
    enabled: true,
    deps: { log: (ev, msg) => logs.push(msg), pid: 11, nowMs: () => 7000 + (i++) * 10, monoMs: () => 8000 + (i++) * 10, gitBaseline: "c63d82b", standBeatEnabled: true }
  });
}
const STABLE = { active: true, resting: true, seated: true, paused: false, sleeping: false };
const SUPP = { scaleRequested: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, displayScaleFactor: 1, seatSink: 30, standSinkOffset: 0, sinkTier: "standard" };

function prime(s) {
  s.record("main", "body-capability", { skinHasSit: true });
  s.record("main", "geom-report", { px: 10, meta: { renderGeneration: 3, docEpoch: 5 }, decision: { accepted: true, value: 10 }, supplement: SUPP });
  s.record("main", "engine", { on: true });
}

test("旧 renderer generation 晚到：stale evidence rejected（PHASE 15 #6）", () => {
  const logs = [];
  const s = makeSession(logs);
  prime(s);
  // 当前 body 身份 docEpoch=5
  s.observeRendererEvidence({ v: 1, seq: 1, kind: "body-generation", payload: { docEpoch: 5, renderGeneration: 3, skinId: "a.skel" }, docEpoch: 5 });
  // 旧文档（docEpoch=4）证据晚到 → STALE_RESULT_ACCEPTED 计数（只记不解释）
  s.observeRendererEvidence({ v: 1, seq: 2, kind: "anim-applied", payload: { requested: "Sit", loop: true, track: 0, docEpoch: 4, renderGeneration: 2 }, docEpoch: 4 });
  assert.equal(s.evaluator.divergenceCounts.STALE_RESULT_ACCEPTED, 1);
  // 旧代 anim-applied 不得支撑 readiness
  const r = RS.bodyEvidence.bodyReadiness(s.evaluator.body, "sit");
  assert.equal(r.readiness, "unknown", "跨代 applied 证据 → unknown（同名字段不可信）");
});

test("renderer/body generation replacement：old attempt invalidated（PHASE 15 #7）", () => {
  const logs = [];
  const s = makeSession(logs);
  prime(s);
  s.observeRendererEvidence({ v: 1, seq: 1, kind: "body-generation", payload: { docEpoch: 5, renderGeneration: 3, skinId: "a.skel" }, docEpoch: 5 });
  s.record("main", "broadcast", STABLE);
  assert.ok(s.evaluator.episode, "episode 已建立");
  // renderer 替换（新文档）
  s.observeRendererEvidence({ v: 1, seq: 2, kind: "body-generation", payload: { docEpoch: 6, renderGeneration: 1, skinId: "b.skel" }, docEpoch: 6 });
  assert.equal(s.evaluator.episode, null, "替换 → 旧 episode 停止");
  assert.equal(s.evaluator.episodesStopped, 1);
  const summary = JSON.parse(logs.find((l) => l.startsWith("[RTSHADOW-EPISODE]")).slice("[RTSHADOW-EPISODE] ".length));
  assert.equal(summary.stopReason, STOP_REASONS.GENERATION_REPLACEMENT);
  assert.ok(s.evaluator.invalidated, "失效标记在位");
  assert.equal(s.evaluator.body.capability, null, "旧 capability 失效，等待新 body 上报");
  // 替换后 capability/geometry 未重建 → 不能开新 episode
  s.record("main", "broadcast", STABLE);
  assert.equal(s.evaluator.episode, null);
  assert.equal(s.evaluator.episodesCompleted, 0);
  // 新 capability + 新 geometry 到位 → 重建 stable Sit 基线（新 episode）
  s.observeRendererEvidence({ v: 1, seq: 3, kind: "body-capability-report", payload: {}, docEpoch: 6 }); // 未知 kind → drop（不入评估）
  s.record("main", "body-capability", { skinHasSit: true });
  s.record("main", "geom-report", { px: 12, meta: { renderGeneration: 1, docEpoch: 6 }, decision: { accepted: true, value: 12 }, supplement: SUPP });
  s.record("main", "broadcast", STABLE);
  assert.ok(s.evaluator.episode, "新基线建立");
  assert.equal(s.evaluator.invalidated, null);
  const ep = s.evaluator.episode;
  assert.equal(ep.phase, SHADOW_PHASES.STABLE_SIT);
});

test("missing evidence：UNKNOWN / wait-for-evidence，不是 false / reject（PHASE 15 #8）", () => {
  const logs = [];
  const s = makeSession(logs);
  // 不喂 capability / geom-report：eligibility 失败 → 无 episode（不是 reject，是等证据）
  s.record("main", "engine", { on: true });
  s.record("main", "broadcast", STABLE);
  assert.equal(s.evaluator.episode, null, "capability unknown → 不开 episode（重启前提未满足）");
  // capability 有但 geometry 无 → 仍不开
  s.record("main", "body-capability", { skinHasSit: true });
  s.record("main", "broadcast", STABLE);
  assert.equal(s.evaluator.episode, null);
  // episode 内证据缺失 → decision=wait-for-evidence、interpretation=unknown（绝不 reject）
  prime(s);
  s.record("main", "broadcast", STABLE);
  assert.ok(s.evaluator.episode);
  s.record("main", "stand-up-arm", { standingUpUntil: 7300, dir: 1 });
  const interpLine = logs.filter((l) => l.includes('"ev":"interpretation"')).pop();
  const interp = JSON.parse(interpLine.slice("[RTSHADOW] ".length));
  assert.equal(interp.decision, "wait-for-evidence");
  assert.equal(interp.interpretation, "unknown");
  assert.equal(interp.body.readiness, "unknown", "无 applied 证据 → unknown（不是 not-ready）");
  // summary 报 unknown 计数（PHASE 14）
  s.record("main", "takeover", { kind: "drag", on: true });
  const summary = JSON.parse(logs.find((l) => l.startsWith("[RTSHADOW-EPISODE]")).slice("[RTSHADOW-EPISODE] ".length));
  assert.ok(summary.unknownDecisions > 0);
  assert.ok(summary.unknownCount > 0);
});

test("V1 与 Shadow path divergence → comparison stops（PHASE 15 #9）", () => {
  const logs = [];
  const s = makeSession(logs);
  prime(s);
  s.record("main", "broadcast", STABLE);
  assert.ok(s.evaluator.episode);
  // V1 走到 scope 外：perched（跳窗顶）
  s.record("main", "broadcast", { active: true, resting: true, seated: true, perched: true, paused: false, sleeping: false });
  assert.equal(s.evaluator.episode, null);
  const summary = JSON.parse(logs.find((l) => l.startsWith("[RTSHADOW-EPISODE]")).slice("[RTSHADOW-EPISODE] ".length));
  assert.equal(summary.stopReason, "v1-path-divergence:perched");
  // behavior-selected perch 同样触发
  const s2 = makeSession([]);
  prime(s2);
  s2.record("main", "broadcast", STABLE);
  s2.record("main", "behavior-selected", { behavior: "perch", seated: true, resting: true });
  assert.equal(s2.evaluator.episode, null);
  assert.equal(s2.evaluator.episodesStopped, 1);
  // PREMATURE_MOTION：stand-up 相位内 X 位移（beat 未结束）
  const s3 = makeSession([]);
  prime(s3);
  s3.record("main", "broadcast", STABLE);
  s3.record("main", "stand-up-arm", { standingUpUntil: 7300, dir: 1 });
  s3.record("main", "rect-write", { via: "walkTick", x: 105, y: 900, ok: true, translate: true });
  assert.equal(s3.evaluator.episode.divergences.some((d) => d.divergenceType === DIVERGENCE_TYPES.PREMATURE_MOTION), true);
  // STALE_GEOMETRY_CONSUMPTION：scale 换代后 seat 锚定写入
  const s4 = makeSession([]);
  prime(s4);
  s4.record("main", "broadcast", STABLE);
  s4.record("main", "geom-scale-changed", { scale: 1.3 });
  s4.record("main", "rect-write", { via: "seat", x: 100, yBefore: 900, targetY: 930, wrote: true, seated: true, sink: 30, groundGap: 10 });
  assert.equal(s4.evaluator.episode.divergences.some((d) => d.divergenceType === DIVERGENCE_TYPES.STALE_GEOMETRY_CONSUMPTION), true);
});

test("divergence 后 V1 后续 result 不得补成 Shadow success（PHASE 15 #10）", () => {
  const logs = [];
  const s = makeSession(logs);
  prime(s);
  s.record("main", "broadcast", STABLE); // ep-A 建立
  const epAId = s.evaluator.episode.id;
  s.record("main", "takeover", { kind: "chat", on: true }); // ep-A 停止
  assert.equal(s.evaluator.episode, null);
  // V1 在 divergence 后自己完成了一个 cycle（raw 事件继续录）
  s.record("main", "takeover", { kind: "chat", on: false });
  // 但重启前提满足后，新 episode 是全新 episode——其成功不属于 ep-A
  s.record("main", "broadcast", STABLE);
  assert.ok(s.evaluator.episode);
  assert.notEqual(s.evaluator.episode.id, epAId, "新 episode 新 id，绝不续用旧路径");
  const epA = s.summaries.find((x) => x.episodeId === epAId);
  assert.equal(epA.completed, false, "旧 episode 永远保持 stopped，不回填成功");
  assert.equal(epA.stopped, true);
  // 重启前提不满足（geometry stale）时：V1 即便走完 cycle 也不产生 completed episode
  const s2 = makeSession([]);
  prime(s2);
  s2.record("main", "geom-scale-changed", { scale: 1.5 }); // 旧测量 stale，无新测量
  s2.record("main", "broadcast", STABLE);
  assert.equal(s2.evaluator.episode, null, "geometry stale → 不开 episode");
  // 整个 cycle 事件流过：没有任何 episode 完成
  s2.record("main", "stand-up-arm", { standingUpUntil: 7300, dir: 1 });
  s2.record("main", "beat-end", { beatDeadline: 7300 });
  s2.record("main", "enter-rest-pose", { seated: true });
  s2.record("main", "broadcast", STABLE);
  assert.equal(s2.evaluator.episodesCompleted, 0, "V1 result 未被回填成 Shadow success");
  assert.equal(s2.evaluator.episode, null);
});

test("divergence taxonomy 单元：ownershipViolation 判定表", () => {
  const P = ownership.predictMotionOwnership;
  const V = ownership.ownershipViolation;
  // external 接管期 translate → RESOURCE_OWNERSHIP_DIVERGENCE
  assert.deepEqual(V(P("move", { takeoverKind: "drag" }), { via: "walkTick", translate: true }),
    { type: DIVERGENCE_TYPES.RESOURCE_OWNERSHIP_DIVERGENCE, reason: "translate-during-takeover:takeover:drag" });
  // V1 冻结期 translate → PREMATURE_MOTION
  assert.equal(V(P("stand-up", {}), { via: "walkTick", translate: true }).type, DIVERGENCE_TYPES.PREMATURE_MOTION);
  assert.equal(V(P("stable-sit", {}), { via: "jump-ease", translate: true }).type, DIVERGENCE_TYPES.PREMATURE_MOTION);
  // move 相位合法位移 → null
  assert.equal(V(P("move", {}), { via: "walkTick", translate: true }), null);
  // 未知 writer 不妄判
  assert.equal(V(P("move", {}), { via: "mystery-writer", translate: false }), null);
  // 相位内越权 writer（move 期 cat-toy 写入 = V1 隐藏路径）
  assert.equal(V(P("move", {}), { via: "cat-toy", translate: true }).type, DIVERGENCE_TYPES.RESOURCE_OWNERSHIP_DIVERGENCE);
});
