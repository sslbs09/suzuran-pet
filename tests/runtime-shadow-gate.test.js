/**
 * Runtime V2 Shadow Slice v0.1 — gate / 故障隔离 / 生产接线测试（Blocker Closure）。
 * 覆盖：#1 observer 抛错后 native write 成功、V1 返回值不变；#2 renderer hook 抛错不打断动画；
 * #3 gate OFF 生产接线（条件创建/条件监听/惰性 observer）；#20 确定性。
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

function sourceBlock(source, startMarker, endMarker, name) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `${name} block exists`);
  return source.slice(start, end);
}

/** 敌意 session：一切调用都抛（G1 故障注入源） */
function hostileSession(faultSink) {
  return {
    active: true,
    record: () => { throw new Error("boom-record"); },
    broadcastMeta: () => { throw new Error("boom-meta"); },
    observeRendererEvidence: () => { throw new Error("boom-evidence"); },
    noteFault: (op, e) => { faultSink.push(op + ":" + (e && e.message)); }
  };
}

test("G1 故障注入：native write 成功后 Shadow observer 抛错，V1 返回值与行为不变（#1）", () => {
  // 生产 walkSetPosition 代码块 + 真实 bridge（接敌意 session）
  const faults = [];
  const bridge = createShadowBridge({ session: hostileSession(faults), deps: { bounds: () => ({ x: 1, y: 2, width: 260, height: 200 }) } });
  const block = sourceBlock(mainSource, "function walkSetPosition", "function walkBroadcast", "walkSetPosition");
  const writes = [];
  const fakeWin = {
    isDestroyed: () => false,
    setPosition: (x, y) => { writes.push([x, y]); } // native write 总是成功
  };
  const walkSetPosition = new Function(
    "win", "logTts", "applyLayerThrottled", "shadowBridge", "commitLegacyPosition",
    `${block}; return walkSetPosition;`
  )(fakeWin, () => {}, () => {}, bridge,
    (x, y) => { fakeWin.setPosition(x, y); return { ok: true }; });
  // 基线语义：成功 → true
  assert.equal(walkSetPosition(100, 200, "walkTick"), true, "Shadow 异常不得改变 V1 返回值");
  assert.deepEqual(writes, [[100, 200]], "native write 已发生且只发生一次");
  // 守卫拦截路径（越界 rejected）：V1 返回 false 不变（NaN 会被 ||0 归一为 0——生产行为如此，不在此改动）
  assert.equal(walkSetPosition(10 ** 9, 200, "walkTick"), false);
  assert.deepEqual(writes, [[100, 200]], "rejected 路径无写入");
  assert.equal(faults.length >= 1, true, "Shadow fault 被诊断记录（有界）");
});

test("G1 故障注入：walkBroadcast 中 Shadow 抛错，生产广播照常发出且 payload 无 shadow 字段（#1）", () => {
  const faults = [];
  const bridge = createShadowBridge({ session: hostileSession(faults), deps: {} });
  const block = sourceBlock(mainSource, "function walkBroadcast(options = {})", "function walkSchedulePhase", "walkBroadcast");
  const sent = [];
  const walkBroadcast = new Function(
    "STANDBEAT_ENABLED", "STANDBEAT_POSE_ENABLED", "seatExitForensicBroadcastMeta", "seatExitForensicSnapshot",
    "shadowBridge", "walk", "edgeDiagTurnPendingId", "sendToRenderer",
    `${block}; return walkBroadcast;`
  )(true, true, () => null, () => {}, bridge,
    { active: true, resting: true, perched: false, seated: true, face: 1, paused: false, sleeping: false },
    0, (ch, p) => sent.push(p));
  assert.doesNotThrow(() => walkBroadcast({}));
  assert.equal(sent.length, 1, "生产广播照常发出");
  assert.equal("shadow" in sent[0], false, "Shadow 故障时 payload 不携带 shadow 字段");
  assert.equal(sent[0].active, true && sent[0].seated, true);
  assert.ok(faults.length >= 1);
});

test("G1 渲染层故障边界：payload 工厂抛错不打断调用方；send 抛错被吞（#2）", () => {
  const sent = [];
  const obs = RS.rendererObserver.createRendererShadowObserver({ send: (ev) => sent.push(ev), nowMs: () => 7 });
  obs.arm({ seq: 1 });
  assert.equal(obs.noteSafely("anim-entry", () => { throw new Error("getter-boom"); }), null);
  assert.equal(sent.length, 0, "构造抛错 → 不发送");
  assert.equal(obs.faults.count, 1);
  assert.ok(obs.noteSafely("anim-entry", () => ({ requested: "Sit" })), "正常路径不受影响");
  assert.equal(sent.length, 1);
  // send 抛错：不向调用方传播
  const obs2 = RS.rendererObserver.createRendererShadowObserver({ send: () => { throw new Error("ipc-gone"); }, nowMs: () => 7 });
  obs2.arm({ seq: 1 });
  assert.doesNotThrow(() => obs2.noteSafely("anim-entry", () => ({ requested: "Move" })));
});

test("G2 strict OFF：生产接线源码合同（条件创建 / 条件监听 / 惰性 observer）+ OFF bridge 惰性（#3）", () => {
  // main：session/bridge 仅在 gate ON 时创建（OFF = null，无对象/无 deps getter 构造）
  assert.match(mainSource, /const shadowSession = RUNTIME_V2_SHADOW_ENABLED \? runtimeShadow\.createShadowSession\(\{/);
  assert.match(mainSource, /const shadowBridge = RUNTIME_V2_SHADOW_ENABLED \? runtimeShadow\.createShadowBridge\(\{/);
  assert.match(mainSource, /\}\) : null;/, "条件创建的 else 分支是 null");
  // main：IPC listener 仅在 gate ON 时注册 + sender 校验
  assert.match(mainSource, /if \(RUNTIME_V2_SHADOW_ENABLED\) \{[\s\S]{0,80}ipcMain\.on\("pet:shadow-evidence"/);
  assert.match(mainSource, /_e\.sender !== win\.webContents/, "拒绝非当前 pet renderer 的 sender");
  // pet：observer 惰性创建（模块加载时不实例化）
  assert.match(petSource, /let shadowObs = null;/);
  assert.match(petSource, /ensureShadowObserver\(\)\.arm\(s\.shadow\);/);
  assert.doesNotMatch(petSource, /const shadowObs = window\.RuntimeShadowObs/, "不得在模块加载时创建 observer");
  // 渲染层 hook 全部走 noteSafely 故障边界，无裸 note(
  assert.match(petSource, /if \(shadowObs && shadowObs\.active\) shadowObs\.noteSafely\(/);
  assert.doesNotMatch(petSource, /shadowObs\.note\(/, "渲染层 hook 禁止绕过故障边界");
  // preload：静态 API surface 无法字面不存在（contextBridge 静态结构），但必须保持惰性：
  // 不注册 listener、不主动触发 IPC——仅在被调用时 send（报告里说明此例外）
  assert.match(preloadSource, /reportShadowEvidence: \(ev\) => ipcRenderer\.send\("pet:shadow-evidence", ev \|\| null\)/);
  // index.html 静态 script 标签（工厂命名空间，无实例/无 listener；与 seat-fit.js 同先例）
  assert.match(indexHtmlSource, /src="\.\.\/src\/runtime-shadow\/renderer-observer\.js"/);
  const obsSource = readLf(require.resolve("../src/runtime-shadow/renderer-observer.js"));
  assert.doesNotMatch(obsSource.split("if (typeof window")[0], /addEventListener|ipcRenderer|sendSync/, "模块加载路径无 listener/IPC");
  // OFF bridge（null session）：所有方法惰性短路
  const b = createShadowBridge({ session: null, deps: { walk: () => { throw new Error("OFF 不得读 deps"); } } });
  assert.equal(b.active(), false);
  assert.equal(b.broadcastMeta(), null);
  assert.doesNotThrow(() => {
    b.obsPhaseEnd(); b.obsBehaviorSelected("walk"); b.obsStandUpArm(); b.obsBeatEnd(1);
    b.obsEnterRestPose(); b.obsRectWrite("walkTick", 1, 2, "succeeded"); b.obsSeatPosition({});
    b.obsSeatExit("arm", {}); b.obsGroundGapReport({}); b.obsHasSit(true); b.obsScaleChanged(1);
    b.obsHostChanged("t"); b.obsTakeover("drag", true); b.obsEngine(true); b.obsRendererEvidence({ kind: "anim-entry", seq: 1 });
  });
});

test("G2 strict OFF：index.html 无条件加载工厂脚本的理由成立（无全局副作用）", () => {
  // 本渲染层为静态 <script> 无条件 loader；工厂脚本必须存在，但加载时只注册工厂命名空间
  // （无 observer 实例、无 listener、无 IPC），与 seat-fit.js/animation-watch.js 同先例。
  // 已在上一测试断言模块加载路径无 listener/IPC；此处锁定 window 注册仅为工厂命名空间。
  const obsSource = readLf(require.resolve("../src/runtime-shadow/renderer-observer.js"));
  assert.match(obsSource, /window\.RuntimeShadowObs = \{ createRendererShadowObserver \};/);
});

test("确定性：相同输入序列 → 逐字节相同输出（#20）", () => {
  const SUPP = { scaleRequested: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, displayScaleFactor: 1, seatSink: 30, standSinkOffset: 0, sinkTier: "standard" };
  const runOnce = () => {
    const logs = [];
    let i = 0;
    const s = createShadowSession({
      deps: { log: (ev, msg) => logs.push(msg), pid: 7, nowMs: () => 1000 + (i++) * 10, monoMs: () => 2000 + (i++) * 10, gitBaseline: "c63d82b", standBeatEnabled: true }
    });
    s.observeRendererEvidence({ v: 2, seq: 1, kind: "body-generation", payload: { renderGeneration: 3, skinId: "a.skel" }, docEpoch: 5 });
    s.record("main", "body-capability", { skinHasSit: true });
    s.record("main", "geom-report", { px: 10, meta: { renderGeneration: 3, docEpoch: 5 }, decision: { accepted: true, value: 10 }, shadowGeom: { seq: 1, scaleEpoch: 0, sampledAt: { clock: "renderer-dateNow-ms", value: 990 }, scaleApplied: 0.27, viewport: { width: 260, height: 200 }, layoutBasis: "autoScale" }, hostAtReceive: SUPP });
    s.record("main", "engine", { on: true });
    s.record("main", "broadcast", { active: true, resting: true, seated: true, paused: false, sleeping: false });
    s.record("main", "stand-up-arm", { standingUpUntil: 1300, dir: 1 });
    s.record("main", "beat-end", { beatDeadline: 1300 });
    s.record("main", "rect-write", { via: "walkTick", x: 100, y: 900, outcome: "succeeded", hostRectAfter: { x: 100, y: 900, width: 260, height: 200 }, translate: true });
    s.record("main", "enter-rest-pose", { seated: true });
    s.observeRendererEvidence({ v: 2, seq: 2, kind: "anim-entry", payload: { requested: "Sit", loop: true, reason: "seat-phase", track: 0, mixDuration: 0.12, renderGeneration: 3 }, docEpoch: 5 });
    s.record("main", "broadcast", { active: true, resting: true, seated: true, paused: false, sleeping: false });
    s.flush("test-end");
    return logs;
  };
  const a = runOnce(), b = runOnce();
  assert.equal(a.length, b.length);
  assert.deepEqual(a, b, "相同输入 + 注入时钟 → 逐字节相同输出");
  assert.ok(a.some((l) => l.startsWith("[RTSHADOW-EPISODE]")));
  assert.ok(a.some((l) => l.startsWith("[RTSHADOW-FLUSH]")));
});
