/**
 * Runtime V2 Shadow Slice v0.1 — gate / bridge 纪律测试。
 * 覆盖 FREEZE PHASE 15 #1（gate OFF 零 session/log/生产影响）、#3（确定性输出）、
 * #13（observation 不推进 timer/phase/state）+ 接线合同（源码级）。
 */
"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");

const RS = require("../src/runtime-shadow");
const { createShadowSession, createShadowBridge } = RS;

function readLf(p) { return fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n"); }
const mainSource = readLf(require.resolve("../main.js"));
const petSource = readLf(require.resolve("../renderer/pet.js"));
const preloadSource = readLf(require.resolve("../preload.js"));
const indexHtmlSource = readLf(require.resolve("../renderer/index.html"));

function makeDeps(clock, logs) {
  let i = 0;
  return {
    log: (ev, msg) => logs.push(msg),
    pid: 4242,
    nowMs: () => 100000 + (i++) * 10,
    monoMs: () => 200000 + (i++) * 10,
    gitBaseline: "c63d82b",
    standBeatEnabled: true
  };
}

test("gate OFF：零 session、零 log、零额外生产行为", () => {
  const logs = [];
  const s = createShadowSession({ enabled: false, deps: makeDeps(null, logs) });
  assert.equal(s.active, false);
  // record / broadcastMeta / flush 全 no-op 且不产生日志
  assert.equal(s.record("main", "broadcast", { active: true }), null);
  assert.equal(s.broadcastMeta(), null);
  assert.equal(s.flush("test"), undefined);
  assert.equal(logs.length, 0);
  // bridge 全方法 OFF 短路
  const b = createShadowBridge({ session: s, deps: { walk: () => ({ active: true, seated: true, resting: true }) } });
  assert.equal(b.active(), false);
  assert.equal(b.broadcastMeta(), null);
  assert.doesNotThrow(() => {
    b.obsPhaseEnd(); b.obsBehaviorSelected("walk"); b.obsStandUpArm(); b.obsBeatEnd(1);
    b.obsEnterRestPose(); b.obsRectWrite("walkTick", 1, 2, true);
    b.obsSeatPosition({}); b.obsSeatExit("arm", {}); b.obsGroundGapReport({});
    b.obsHasSit(true); b.obsScaleChanged(1); b.obsHostChanged("t"); b.obsTakeover("drag", true);
    b.obsEngine(true); b.obsRendererEvidence({ kind: "anim-applied", payload: {} });
  });
  assert.equal(logs.length, 0);
});

test("gate OFF：walkBroadcast payload 无 shadow 字段（源码合同）", () => {
  assert.match(mainSource, /const RUNTIME_V2_SHADOW_ENABLED = runtimeShadow\.shadowGateEnabled\(\);/);
  const indexSource = readLf(require.resolve("../src/runtime-shadow/index.js"));
  assert.match(indexSource, /SUSSURRO_RUNTIME_V2_SHADOW === "1"/, "gate 默认 OFF，env='1' 显式开启");
  assert.match(mainSource, /\.\.\.\(shadowMeta \? \{ shadow: shadowMeta \} : \{\}\)/, "shadow meta 只在 ON 时附加");
  assert.match(mainSource, /ipcMain\.on\("pet:shadow-evidence"/);
  assert.match(preloadSource, /reportShadowEvidence: \(ev\) => ipcRenderer\.send\("pet:shadow-evidence"/);
  assert.match(petSource, /reportShadowEvidence && window\.petAPI\.reportShadowEvidence\(ev\)/);
  assert.match(indexHtmlSource, /src="\.\.\/src\/runtime-shadow\/renderer-observer\.js"/);
  // 渲染层 hook 全部有 active 守卫
  const hooks = petSource.match(/if \(shadowObs && shadowObs\.active\)/g) || [];
  assert.ok(hooks.length >= 6, "pet.js shadow hook 应全部带 active 守卫，got " + hooks.length);
  assert.match(petSource, /if \(s && s\.shadow\) shadowObs\.arm\(s\.shadow\);\n {6}else if \(s\) shadowObs\.disarm\(\);/);
  // 双端模块挂 window
  const obsSource = readLf(require.resolve("../src/runtime-shadow/renderer-observer.js"));
  assert.match(obsSource, /window\.RuntimeShadowObs = \{ createRendererShadowObserver \}/);
});

test("observation 不推进 timer/phase/state：bridge 只读（冻结依赖无异常、无突变）", () => {
  const logs = [];
  const s = createShadowSession({ enabled: true, deps: makeDeps(null, logs) });
  const frozenWalk = Object.freeze({
    active: true, resting: true, seated: true, perched: false, iconRest: false, iconTarget: false,
    gotoPerch: false, returning: false, freeStand: false, sleeping: false, paused: false, catToy: false,
    taskbarHang: false, flight: false, jump: false, edgeLeft: false, face: 1, dir: 1, standingUpUntil: 0, sunk: true
  });
  const frozenBounds = Object.freeze({ x: 100, y: 900, width: 260, height: 200 });
  const b = createShadowBridge({
    session: s,
    deps: {
      walk: () => frozenWalk,
      bounds: () => frozenBounds,
      workArea: () => Object.freeze({ x: 0, y: 0, width: 1920, height: 1040 }),
      displayScaleFactor: () => 1,
      scaleRequested: () => 1,
      seatSink: () => 30,
      standSink: () => 0,
      sinkTier: () => "standard",
      skinHasSit: () => true
    }
  });
  // 全部观察方法可安全执行（冻结对象上任何写入都会抛 TypeError）
  assert.doesNotThrow(() => {
    b.obsPhaseEnd();
    b.obsRectWrite("walkTick", 100, 900, true);
    b.obsSeatPosition({ x: 100, yBefore: 900, targetY: 930, wrote: true, seated: true, sink: 30, groundGap: 10 });
    b.obsGroundGapReport({ px: 10, meta: { renderGeneration: 1, docEpoch: 2 }, decision: { accepted: true, value: 10 } });
    b.obsHasSit(true);
  });
  // walkSnapshot 是显式字段表，不引用原对象
  const snap = b.walkSnapshot();
  assert.deepEqual(Object.keys(snap).sort(), [
    "active", "catToy", "dir", "edgeLeft", "face", "flight", "freeStand", "gotoPerch", "iconRest",
    "iconTarget", "jump", "paused", "perched", "resting", "returning", "seated", "sleeping",
    "standingUpUntil", "sunk", "taskbarHang"
  ].sort());
  assert.equal(Object.isFrozen(snap), false, "快照是拷贝，不是生产对象引用");
  // 两次同样调用产生同一 payload（观察无状态漂移）
  const a1 = b.walkSnapshot();
  const a2 = b.walkSnapshot();
  assert.deepEqual(a1, a2);
});

test("相同输入序列 → 确定性 Shadow 输出", () => {
  const runOnce = () => {
    const logs = [];
    let i = 0;
    const s = createShadowSession({
      enabled: true,
      deps: { log: (ev, msg) => logs.push(msg), pid: 7, nowMs: () => 1000 + (i++) * 10, monoMs: () => 2000 + (i++) * 10, gitBaseline: "c63d82b", standBeatEnabled: true }
    });
    s.record("main", "body-capability", { skinHasSit: true });
    s.record("main", "geom-report", { px: 10, meta: { renderGeneration: 3, docEpoch: 5 }, decision: { accepted: true, value: 10 }, supplement: { scaleRequested: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, displayScaleFactor: 1, seatSink: 30, standSinkOffset: 0, sinkTier: "standard" } });
    s.record("main", "engine", { on: true });
    s.record("main", "broadcast", { active: true, resting: true, seated: true, paused: false, sleeping: false });
    s.record("main", "stand-up-arm", { standingUpUntil: 1300, dir: 1 });
    s.record("main", "beat-end", { beatDeadline: 1300 });
    s.record("main", "rect-write", { via: "walkTick", x: 100, y: 900, ok: true, translate: true });
    s.record("main", "enter-rest-pose", { seated: true });
    s.observeRendererEvidence({ v: 1, seq: 1, kind: "anim-applied", payload: { requested: "Sit", loop: true, reason: "seat-phase", track: 0, mixDuration: 0.12, docEpoch: 5, renderGeneration: 3 }, docEpoch: 5, causeRef: { source: "main", sourceSeq: 5 } });
    s.record("main", "broadcast", { active: true, resting: true, seated: true, paused: false, sleeping: false });
    s.flush("test-end");
    return logs;
  };
  const a = runOnce(), b = runOnce();
  assert.equal(a.length, b.length);
  assert.deepEqual(a, b, "相同输入+注入时钟 → 逐字节相同输出");
  assert.ok(a.some((l) => l.startsWith("[RTSHADOW-EPISODE]")));
  assert.ok(a.some((l) => l.startsWith("[RTSHADOW-FLUSH]")));
});
