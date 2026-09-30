/**
 * Runtime V2 Shadow Slice v0.1 — episode 序列与接管测试。
 * 覆盖 FREEZE PHASE 15 #2（正常序列）、#11（外部接管停止）、#12（body not-ready 只观察）。
 */
"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");

const RS = require("../src/runtime-shadow");
const { createShadowSession } = RS;
const { SHADOW_PHASES } = RS.contract;

function makeSession(logs) {
  let i = 0;
  return createShadowSession({
    enabled: true,
    deps: { log: (ev, msg) => logs.push(msg), pid: 9, nowMs: () => 5000 + (i++) * 10, monoMs: () => 6000 + (i++) * 10, gitBaseline: "c63d82b", standBeatEnabled: true }
  });
}

/** 建立合格基线：capability + geometry valid + engine on */
function primeBaseline(s) {
  s.record("main", "body-capability", { skinHasSit: true });
  s.record("main", "geom-report", {
    px: 10, meta: { renderGeneration: 3, docEpoch: 5 }, decision: { accepted: true, value: 10 },
    supplement: { scaleRequested: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, displayScaleFactor: 1, seatSink: 30, standSinkOffset: 0, sinkTier: "standard" }
  });
  s.record("main", "engine", { on: true });
}

test("正常序列：stable Sit → StandUp → Move → EnterSit → stable Sit（PHASE 15 #2）", () => {
  const logs = [];
  const s = makeSession(logs);
  primeBaseline(s);
  s.record("main", "broadcast", { active: true, resting: true, seated: true, paused: false, sleeping: false });
  assert.ok(s.evaluator.episode, "基线成立后应开 episode");
  assert.equal(s.evaluator.episode.phase, SHADOW_PHASES.STABLE_SIT);

  s.record("main", "stand-up-arm", { standingUpUntil: 5300, dir: 1 });
  assert.equal(s.evaluator.episode.phase, SHADOW_PHASES.STAND_UP);

  // stand-beat 期间 Y 过渡写入合法；X 位移非法（另测）
  s.record("main", "rect-write", { via: "seat-exit-y", y: 910, ok: true, translate: false });
  s.record("main", "beat-end", { beatDeadline: 5300 });
  assert.equal(s.evaluator.episode.phase, SHADOW_PHASES.MOVE);

  // move 期间位移写入合法
  s.record("main", "rect-write", { via: "walkTick", x: 110, y: 900, ok: true, translate: true });
  s.record("main", "enter-rest-pose", { seated: true });
  assert.equal(s.evaluator.episode.phase, SHADOW_PHASES.ENTER_SIT);

  // renderer 应用 Sit 动画（携带 generation 身份）
  s.observeRendererEvidence({
    v: 1, seq: 1, kind: "anim-applied",
    payload: { requested: "Sit", loop: true, reason: "seat-phase", track: 0, mixDuration: 0.12, docEpoch: 5, renderGeneration: 3 },
    docEpoch: 5, causeRef: { source: "main", sourceSeq: 6 }
  });

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
  // 摘要必须有 decision opportunity / evaluable / unknown 计数（PHASE 14：不只 PASS/FAIL）
  assert.ok(summary.decisionOpportunities > 0);
  assert.ok(typeof summary.evaluable === "number" && typeof summary.unknownDecisions === "number");
  assert.ok(summary.inputCoverage && summary.inputCoverage["broadcast"] >= 2);
  assert.ok(Array.isArray(summary.evidenceRefs) && summary.evidenceRefs.length > 0);
});

test("外部接管：HeadPat / Drag 停止当前 episode，Shadow 不迁移 interaction（PHASE 15 #11）", () => {
  // headpat（渲染层边界）
  {
    const logs = [];
    const s = makeSession(logs);
    primeBaseline(s);
    s.record("main", "broadcast", { active: true, resting: true, seated: true, paused: false, sleeping: false });
    assert.ok(s.evaluator.episode);
    s.observeRendererEvidence({ v: 1, seq: 1, kind: "boundary-takeover", payload: { kind: "headpat" }, docEpoch: 5 });
    assert.equal(s.evaluator.episode, null, "headpat 接管 → episode 停止");
    assert.equal(s.evaluator.episodesStopped, 1);
    const summary = JSON.parse(logs.find((l) => l.startsWith("[RTSHADOW-EPISODE]")).slice("[RTSHADOW-EPISODE] ".length));
    assert.equal(summary.stopped, true);
    assert.equal(summary.stopReason, "takeover:headpat");
    assert.equal(summary.completed, false);
    // headpat 无 off 事件：不得留下永久占用标记（后续可重启）
    assert.equal(s.evaluator.takeover, null);
  }
  // drag（主进程接管意图）
  {
    const logs = [];
    const s = makeSession(logs);
    primeBaseline(s);
    s.record("main", "broadcast", { active: true, resting: true, seated: true, paused: false, sleeping: false });
    assert.ok(s.evaluator.episode);
    s.record("main", "takeover", { kind: "drag", on: true });
    assert.equal(s.evaluator.episode, null);
    assert.equal(s.evaluator.takeover.kind, "drag", "drag 有 off 事件，占用标记保留至恢复");
    // drag 接管期的 translate 写入 = 所有权越权（ownership 检查在 episode 外也计 session 级……
    // 实际上 episode 已关，此写入只做 raw 记录，不产生 divergence——PHASE 12「停止后继续记 raw」）
    const before = s.evaluator.divergenceCounts.RESOURCE_OWNERSHIP_DIVERGENCE || 0;
    s.record("main", "rect-write", { via: "walkTick", x: 200, y: 900, ok: true, translate: true });
    assert.equal(s.evaluator.divergenceCounts.RESOURCE_OWNERSHIP_DIVERGENCE || 0, before,
      "episode 已停止：raw 观测继续，但不再归类 divergence（不回填、不误判）");
    // off 恢复后可重启
    s.record("main", "takeover", { kind: "drag", on: false });
    assert.equal(s.evaluator.takeover, null);
  }
});

test("Body not-ready during V1 Move：只记 MOTION_WITH_BODY_NOT_READY，不改生产行为（PHASE 15 #12）", () => {
  const logs = [];
  const s = makeSession(logs);
  primeBaseline(s);
  s.record("main", "broadcast", { active: true, resting: true, seated: true, paused: false, sleeping: false });
  s.record("main", "stand-up-arm", { standingUpUntil: 5300, dir: 1 });
  s.record("main", "beat-end", { beatDeadline: 5300 });
  assert.equal(s.evaluator.episode.phase, SHADOW_PHASES.MOVE);
  // renderer 身份 + 实际 applied 与 move 期望矛盾（当前代、真实 track 证据）→ not-ready
  s.observeRendererEvidence({
    v: 1, seq: 1, kind: "body-generation", payload: { docEpoch: 5, renderGeneration: 3, skinId: "a.skel" }, docEpoch: 5
  });
  s.observeRendererEvidence({
    v: 1, seq: 2, kind: "anim-applied",
    payload: { requested: "Relax", loop: true, reason: "paused-idle", track: 0, mixDuration: 0.2, docEpoch: 5, renderGeneration: 3 },
    docEpoch: 5
  });
  s.record("main", "rect-write", { via: "walkTick", x: 120, y: 900, ok: true, translate: true });
  // 观察项入 episode.observations + session 观察计数；绝不入 divergenceCounts
  assert.equal(s.evaluator.observationCounts.MOTION_WITH_BODY_NOT_READY, 1);
  const ep = s.evaluator.episode;
  assert.equal(ep.observations.length, 1);
  assert.equal(ep.observations[0].type, "MOTION_WITH_BODY_NOT_READY");
  assert.equal(ep.divergences.length, 0, "观察项不是合同违规");
  assert.equal(s.evaluator.divergenceCounts.MOTION_WITH_BODY_NOT_READY, undefined);
  // 输出行是 observation 而非 divergence
  const obsLine = logs.find((l) => l.includes('"noteType":"MOTION_WITH_BODY_NOT_READY"'));
  assert.ok(obsLine, "应输出 observation note 行");
});
