/**
 * Runtime V2 Shadow Slice v0.1 — episode 序列与接管测试（Blocker Closure）。
 * 覆盖：#2 正常序列（request/effect 分离语义）；#11 外部接管停止；#12 body not-ready 只观察；
 * #15 failed write 不产生 actual-motion divergence；#16 arm/cancel 不是位移；
 * #9 animation requested 不能成为 ready。
 */
"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");

const RS = require("../src/runtime-shadow");
const { createShadowSession } = RS;
const { SHADOW_PHASES } = RS.contract;
const { evidenceLevelOf } = RS.evaluator;

function makeSession(logs) {
  let i = 0;
  return createShadowSession({
    deps: { log: (ev, msg) => logs.push(msg), pid: 9, nowMs: () => 5000 + (i++) * 10, monoMs: () => 6000 + (i++) * 10, gitBaseline: "c63d82b", standBeatEnabled: true }
  });
}
const HOST = { scaleRequested: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, displayScaleFactor: 1, seatSink: 30, standSinkOffset: 0, sinkTier: "standard" };

function prime(s) {
  s.observeRendererEvidence({ v: 2, seq: 1, kind: "body-generation", payload: { renderGeneration: 3, skinId: "a.skel" }, docEpoch: 5 });
  s.record("main", "body-capability", { skinHasSit: true });
  s.record("main", "geom-report", {
    px: 10, meta: { renderGeneration: 3, docEpoch: 5 }, decision: { accepted: true, value: 10 },
    shadowGeom: { seq: 1, scaleEpoch: 0, sampledAt: { clock: "renderer-dateNow-ms", value: 4990 }, scaleApplied: 0.27, viewport: { width: 260, height: 200 }, layoutBasis: "autoScale" },
    hostAtReceive: HOST
  });
  s.record("main", "engine", { on: true });
}

test("正常序列：stable Sit → StandUp → Move → EnterSit → stable Sit（request/effect 分离语义）", () => {
  const logs = [];
  const s = makeSession(logs);
  prime(s);
  s.record("main", "broadcast", { active: true, resting: true, seated: true, paused: false, sleeping: false });
  assert.ok(s.evaluator.episode, "基线成立后应开 episode");
  assert.equal(s.evaluator.episode.phase, SHADOW_PHASES.STABLE_SIT);

  s.record("main", "stand-up-arm", { standingUpUntil: 5300, dir: 1 });
  assert.equal(s.evaluator.episode.phase, SHADOW_PHASES.STAND_UP);

  // INTENT（arm）与写尝试（outcome）分离：arm 不产生 effect 判定
  s.record("main", "seat-exit", { via: "seat-exit-y", event: "arm", reason: "move", source: "phase", fromOffsetY: 30 });
  // stand-beat 期间 Y 过渡写入成功（effect candidate，anchorUpdate 合法）
  s.record("main", "seat-exit", { via: "seat-exit-y", event: "step", outcome: "succeeded", hostRectAfter: { x: 100, y: 910, width: 260, height: 200 }, reason: "move", source: "standBeat", complete: false });
  s.record("main", "beat-end", { beatDeadline: 5300 });
  assert.equal(s.evaluator.episode.phase, SHADOW_PHASES.MOVE);

  // move 期间位移写入成功合法（host-observed 层）
  s.record("main", "rect-write", { via: "walkTick", x: 110, y: 900, outcome: "succeeded", hostRectAfter: { x: 110, y: 900, width: 260, height: 200 }, translate: true });
  s.record("main", "enter-rest-pose", { seated: true });
  assert.equal(s.evaluator.episode.phase, SHADOW_PHASES.ENTER_SIT);

  // renderer：anim entry（请求 + track entry 被接受——不是 pose applied）
  s.observeRendererEvidence({ v: 2, seq: 2, kind: "anim-entry", payload: { requested: "Sit", loop: true, reason: "seat-phase", track: 0, mixDuration: 0.12, renderGeneration: 3 }, docEpoch: 5 });
  // 坐姿锚定成功（skipped→succeeded）
  s.record("main", "seat-position", { via: "seat", x: 110, yBefore: 910, targetY: 930, outcome: "succeeded", hostRectAfter: { x: 110, y: 930, width: 260, height: 200 }, seated: true, sink: 30, groundGap: 10 });

  s.record("main", "broadcast", { active: true, resting: true, seated: true, paused: false, sleeping: false });
  assert.equal(s.evaluator.episode, null, "cycle 完成后 episode 关闭");
  assert.equal(s.evaluator.episodesCompleted, 1);
  assert.equal(s.evaluator.episodesStopped, 0);

  const summaryLine = logs.find((l) => l.startsWith("[RTSHADOW-EPISODE]"));
  assert.ok(summaryLine, "应输出 episode 摘要");
  const summary = JSON.parse(summaryLine.slice("[RTSHADOW-EPISODE] ".length));
  assert.deepEqual(summary.phaseSequence, ["stable-sit", "stand-up", "move", "enter-sit", "stable-sit"]);
  assert.equal(summary.completed, true);
  assert.equal(summary.stopped, false);
  assert.deepEqual(summary.divergenceCounts, {});
  assert.ok(summary.decisionOpportunities > 0);
  assert.ok(summary.inputCoverage["broadcast"] >= 2);
  assert.ok(Array.isArray(summary.evidenceRefs) && summary.evidenceRefs.length > 0);
  // exit-supported ≠ body 成功：body readiness 在摘要之外单独报告为观察
  const interpLine = logs.filter((l) => l.includes('"ev":"interpretation"')).pop();
  const interp = JSON.parse(interpLine.slice("[RTSHADOW] ".length));
  assert.equal(interp.interpretation, "exit-supported");
  assert.notEqual(interp.interpretation, "body-success");
});

test("外部接管：HeadPat / Drag 停止当前 episode，Shadow 不迁移 interaction（#11）", () => {
  // headpat（渲染层边界）
  {
    const logs = [];
    const s = makeSession(logs);
    prime(s);
    s.record("main", "broadcast", { active: true, resting: true, seated: true, paused: false, sleeping: false });
    assert.ok(s.evaluator.episode);
    s.observeRendererEvidence({ v: 2, seq: 2, kind: "boundary-takeover", payload: { kind: "headpat" }, docEpoch: 5 });
    assert.equal(s.evaluator.episode, null, "headpat 接管 → episode 停止");
    assert.equal(s.evaluator.episodesStopped, 1);
    const summary = JSON.parse(logs.find((l) => l.startsWith("[RTSHADOW-EPISODE]")).slice("[RTSHADOW-EPISODE] ".length));
    assert.equal(summary.stopped, true);
    assert.equal(summary.stopReason, "takeover:headpat");
    assert.equal(summary.completed, false);
    assert.equal(s.evaluator.takeover, null, "headpat 无 off 事件，不设永久占用标记");
  }
  // drag（主进程接管意图）
  {
    const logs = [];
    const s = makeSession(logs);
    prime(s);
    s.record("main", "broadcast", { active: true, resting: true, seated: true, paused: false, sleeping: false });
    assert.ok(s.evaluator.episode);
    s.record("main", "takeover", { kind: "drag", on: true });
    assert.equal(s.evaluator.episode, null);
    assert.equal(s.evaluator.takeover.kind, "drag");
    // episode 已停止：raw 观测继续记录，但不再归类 divergence（不回填、不误判）
    const before = s.evaluator.divergenceCounts.RESOURCE_OWNERSHIP_DIVERGENCE || 0;
    s.record("main", "rect-write", { via: "walkTick", x: 200, y: 900, outcome: "succeeded", hostRectAfter: { x: 200, y: 900, width: 260, height: 200 }, translate: true });
    assert.equal(s.evaluator.divergenceCounts.RESOURCE_OWNERSHIP_DIVERGENCE || 0, before);
    s.record("main", "takeover", { kind: "drag", on: false });
    assert.equal(s.evaluator.takeover, null);
  }
});

test("Body not-ready during V1 Move：只记 MOTION_WITH_BODY_NOT_READY，不改生产行为（#12）", () => {
  const logs = [];
  const s = makeSession(logs);
  prime(s);
  s.record("main", "broadcast", { active: true, resting: true, seated: true, paused: false, sleeping: false });
  s.record("main", "stand-up-arm", { standingUpUntil: 5300, dir: 1 });
  s.record("main", "beat-end", { beatDeadline: 5300 });
  assert.equal(s.evaluator.episode.phase, SHADOW_PHASES.MOVE);
  // renderer 身份 + 实际 entry 与 move 期望矛盾（当前代、真实 track 证据）→ not-ready
  s.observeRendererEvidence({ v: 2, seq: 2, kind: "anim-entry", payload: { requested: "Relax", loop: true, reason: "paused-idle", track: 0, mixDuration: 0.2, renderGeneration: 3 }, docEpoch: 5 });
  s.record("main", "rect-write", { via: "walkTick", x: 120, y: 900, outcome: "succeeded", hostRectAfter: { x: 120, y: 900, width: 260, height: 200 }, translate: true });
  assert.equal(s.evaluator.observationCounts.MOTION_WITH_BODY_NOT_READY, 1);
  const ep = s.evaluator.episode;
  assert.equal(ep.observations.length, 1);
  assert.equal(ep.observations[0].type, "MOTION_WITH_BODY_NOT_READY");
  assert.equal(ep.divergences.length, 0, "观察项不是合同违规，不停止比较");
  assert.ok(s.evaluator.episode, "episode 继续（观察-only 不停止）");
  const obsLine = logs.find((l) => l.includes('"noteType":"MOTION_WITH_BODY_NOT_READY"'));
  assert.ok(obsLine);
});

test("G6：animation requested/entry 不能成为 ready（#9）", () => {
  const B = RS.bodyEvidence;
  const st = B.createBodyEvidenceState();
  // 无 capability → unknown
  assert.equal(B.bodyReadiness(st, "sit").readiness, "unknown");
  B.noteCapability(st, true);
  B.noteBodyGeneration(st, { docEpoch: 5, renderGeneration: 3 });
  // 同类 entry + 同代 → 仍然 unknown（无 pose proof；v0.1 绝不输出 ready）
  B.noteAnimEntry(st, { requested: "Sit", loop: true, track: 0, mixDuration: 0.12, renderGeneration: 3 });
  const r = B.bodyReadiness(st, "sit");
  assert.equal(r.readiness, "unknown");
  assert.equal(r.reason, "no-pose-proof-in-v0.1");
  // 全枚举：任何输入组合都不产生 ready
  B.noteFitHandoff(st, { kind: "autoscale" });
  for (const cls of ["sit", "move", null]) {
    assert.notEqual(B.bodyReadiness(st, cls).readiness, "ready");
  }
  // 矛盾 entry → not-ready（显式矛盾，仍不是 ready 的反面证明）
  B.noteAnimEntry(st, { requested: "Move", loop: true, track: 0, renderGeneration: 3 });
  assert.equal(B.bodyReadiness(st, "sit").readiness, "not-ready");
  // capability false + 期望 sit → not-ready
  const st2 = B.createBodyEvidenceState();
  B.noteCapability(st2, false);
  B.noteBodyGeneration(st2, { docEpoch: 5, renderGeneration: 3 });
  B.noteAnimEntry(st2, { requested: "Sit", track: 0, renderGeneration: 3 });
  assert.equal(B.bodyReadiness(st2, "sit").readiness, "not-ready");
  assert.equal(B.bodyReadiness(st2, "sit").reason, "sit-capability-absent");
  // 跨代 entry → unknown（同名字段不可信）；capability true 的状态上验证（capability-false 短路在前）
  B.noteAnimEntry(st, { requested: "Sit", track: 0, renderGeneration: 99 });
  assert.equal(B.bodyReadiness(st, "sit").readiness, "unknown");
  assert.equal(B.bodyReadiness(st, "sit").reason, "entry-evidence-stale-generation");
});

test("G9 request/effect：failed/rejected 写入不产生 actual-motion divergence（#15）", () => {
  const logs = [];
  const s = makeSession(logs);
  prime(s);
  s.record("main", "broadcast", { active: true, resting: true, seated: true, paused: false, sleeping: false });
  s.record("main", "stand-up-arm", { standingUpUntil: 5300, dir: 1 });
  // stand-up 相位（hold 预测）：
  // WRITE_FAILED：写入抛错 → effect candidate 不成立 → 无 PREMATURE_MOTION
  s.record("main", "rect-write", { via: "walkTick", x: 105, y: 900, outcome: "failed", hostRectAfter: null, translate: true });
  assert.equal(s.evaluator.episode.divergences.length, 0);
  // REQUEST 级（守卫拦截，未尝试写入）→ 无 divergence
  s.record("main", "rect-write", { via: "walkTick", x: 10 ** 9, y: 900, outcome: "rejected", hostRectAfter: null, translate: true });
  assert.equal(s.evaluator.episode.divergences.length, 0);
  // arm/cancel = INTENT：即使带 translate 标签也不判位移（#16）
  s.record("main", "seat-exit", { via: "seat-exit-y", event: "arm", reason: "move", source: "phase", fromOffsetY: 30, translate: false });
  s.record("main", "seat-exit", { via: "seat-exit-y", event: "cancel", reason: "drag", translate: false });
  assert.equal(s.evaluator.episode.divergences.length, 0);
  assert.equal(s.evaluator.episode.phase, SHADOW_PHASES.STAND_UP, "INTENT 不推进也不打断相位");
  // 成功写入同相位 → PREMATURE_MOTION（对照：只有 effect candidate 才判定）
  s.record("main", "rect-write", { via: "walkTick", x: 105, y: 900, outcome: "succeeded", hostRectAfter: { x: 105, y: 900, width: 260, height: 200 }, translate: true });
  assert.equal(s.evaluator.episode, null, "PREMATURE_MOTION 立即停止（G7）");
});

test("evidenceLevelOf 分级表（#16 辅助）", () => {
  assert.equal(evidenceLevelOf("rect-write", { outcome: "succeeded", hostRectAfter: { x: 1 } }), "host-observed");
  assert.equal(evidenceLevelOf("rect-write", { outcome: "succeeded" }), "write-succeeded");
  assert.equal(evidenceLevelOf("rect-write", { outcome: "failed" }), "attempt");
  assert.equal(evidenceLevelOf("rect-write", { outcome: "rejected" }), "attempt");
  assert.equal(evidenceLevelOf("seat-position", { outcome: "skipped" }), "attempt");
  assert.equal(evidenceLevelOf("seat-exit", { event: "arm" }), "intent");
  assert.equal(evidenceLevelOf("seat-exit", { event: "cancel" }), "intent");
  assert.equal(evidenceLevelOf("seat-exit", { event: "step", outcome: "succeeded", hostRectAfter: { x: 1, y: 2 } }), "host-observed");
  assert.equal(evidenceLevelOf("seat-exit", { event: "step", outcome: "succeeded" }), "write-succeeded");
  assert.equal(evidenceLevelOf("seat-exit", { event: "step", outcome: "failed" }), "attempt");
  assert.equal(evidenceLevelOf("broadcast", {}), "observation");
});
