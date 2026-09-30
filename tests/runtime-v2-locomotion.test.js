/**
 * Runtime V2 Locomotion Cutover v0.1 — production ownership 测试（A–N）。
 * 纯模块 + 真实生产代码块（从 main.js 提取执行），证明 ownership cutover 是真实的：
 * V2 持有时 legacy writer 被明确拒绝（不是碰巧没调用），唯一 commit point 驱动窗口，
 * 中断/替换后旧 callback 不能重提交，geometry 过期不得用于新 anchor，关闭交回 V1。
 */
"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");

const runtimeV2 = require("../src/runtime-v2");
const walkGeo = require("../src/walk-geo");

const mainSource = fs.readFileSync(require.resolve("../main.js"), "utf8").replace(/\r\n/g, "\n");
const controllerSource = fs.readFileSync(require.resolve("../src/runtime-v2/locomotion-controller.js"), "utf8");
function sourceBlock(source, startMarker, endMarker, name) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `${name} block exists`);
  return source.slice(start, end);
}

/* ---------------- fake world（真实 walk-geo 纯函数复用，不复制算法） ---------------- */

function makeWorld(opts = {}) {
  const wa = { x: 0, y: 0, width: 1536, height: 864 };
  const baseY = wa.y + wa.height + 10 - 200; // standBaseY 同式（gap=10, h=200）
  const st = {
    now: 1000,
    bounds: { x: 600, y: baseY + (opts.startOffsetY || 0), width: 260, height: 200 },
    writes: [], broadcasts: [], events: [], resumed: [], sitScheduled: 0, face: 1,
    projection: { seated: true, resting: true, sunk: true, dir: 1, standingUpUntil: 0 },
    geometryUsable: true, bodyIdentity: { docEpoch: 5, renderGeneration: 3 },
    throwProjection: false
  };
  const authority = runtimeV2.createMotionAuthority();
  const commit = runtimeV2.createWindowCommit({
    authority,
    writePosition: (x, y) => { st.writes.push({ x, y }); st.bounds = Object.assign({}, st.bounds, { x, y }); },
    readRect: () => Object.assign({}, st.bounds),
    notifyWrite: (r) => st.events.push({ commit: r.kind, outcome: r.outcome })
  });
  const controller = runtimeV2.createLocomotionController({
    authority, commit,
    deps: {
      now: () => st.now,
      bounds: () => Object.assign({}, st.bounds),
      workArea: () => wa,
      clampX: (x, w, width) => walkGeo.clampWalkX(x, w, width, false, 138),
      speed: () => 1.2,
      groundGap: () => 10,
      seatSink: () => 30,
      skinHasSit: () => true,
      face: () => st.face,
      standBaseY: (b, w) => w.y + w.height + 10 - b.height,
      geometryUsable: () => st.geometryUsable
        ? { usable: true, validity: "valid", reason: "identity-match" }
        : { usable: false, validity: "stale", reason: "scale-generation-advanced" },
      geometryDependency: () => ({ value: 10, renderGeneration: 3 }),
      bodyIdentity: () => st.bodyIdentity,
      policies: { standBeatMs: 260, seatExitMs: 200 },
      enterSitHoldTicks: 2
    },
    hooks: {
      setProjection: (patch) => {
        if (st.throwProjection) throw new Error("projection-boom");
        Object.assign(st.projection, patch);
      },
      broadcast: () => st.broadcasts.push({ ev: "broadcast", projection: Object.assign({}, st.projection) }),
      beginStandBroadcast: () => st.broadcasts.push({ ev: "stand-broadcast", projection: Object.assign({}, st.projection) }),
      setFace: (f) => { st.face = f; },
      scheduleLegacySit: () => { st.sitScheduled += 1; },
      resumeLegacy: (reason) => st.resumed.push(reason),
      noteEvent: (ev) => st.events.push(ev)
    }
  });
  return {
    st, baseY, authority, commit, controller,
    owns: () => controller.owns(),
    begin(input) { return controller.beginEpisode(input || { dir: 1, moveMs: 1000 }); },
    advance(ms) { st.now += ms; controller.tick(); }
  };
}

/* ---------------- B/C/M/N：ownership 权威与 legacy 拒绝 ---------------- */

test("B: eligible begin → V2 持有；projection 同步（V1 字段成为兼容投影）", () => {
  const w = makeWorld();
  assert.equal(w.authority.owner(), "legacy");
  const res = w.begin();
  assert.equal(res.ok, true);
  assert.equal(w.owns(), true);
  assert.equal(w.authority.owner(), "v2-locomotion");
  assert.equal(w.st.projection.seated, false, "stand-up 开始：seated=false（V1 同语义）");
  assert.equal(w.st.projection.resting, true);
  assert.equal(w.st.projection.standingUpUntil, 1000 + 260, "beat deadline 镜像进投影");
  assert.equal(w.st.broadcasts[0].ev, "stand-broadcast");
  // 单所有权：第二 episode 被拒
  assert.equal(w.begin({ dir: -1, moveMs: 500 }).ok, false);
});

test("C+N: V2 持有期间，真实生产 walkSetPosition 块被 ownership 明确拒绝（写不发生）", () => {
  const block = sourceBlock(mainSource, "function walkSetPosition", "function walkBroadcast", "walkSetPosition");
  const w = makeWorld();
  const v2Locomotion = { deniesLegacy: (caller) => w.authority.denyLegacyWriter(caller), owns: () => w.owns() };
  let nativeWrites = 0;
  const fakeWin = { isDestroyed: () => false, setPosition: () => { nativeWrites += 1; } };
  const walkSetPosition = new Function(
    "win", "logTts", "applyLayerThrottled", "shadowBridge", "v2Locomotion",
    `${block}; return walkSetPosition;`
  )(fakeWin, () => {}, () => {}, null, v2Locomotion);
  w.begin(); // V2 持有
  assert.equal(walkSetPosition(700, 600, "walkTick"), false, "legacy writer 被真实拒绝（不是碰巧没调用）");
  assert.equal(nativeWrites, 0);
  assert.equal(w.authority.snapshot().denyCounts["walkSetPosition:walkTick"], 1, "拒绝计数可观测");
  // 释放后同一路径恢复正常
  w.controller.interrupt("test-release");
  assert.equal(walkSetPosition(700, 600, "walkTick"), true);
  assert.equal(nativeWrites, 1);
});

test("M: episode 完成 → ownership 释放 + V1 sit 等待期交回", () => {
  const w = makeWorld();
  w.begin();
  let guard = 0;
  while (w.owns() && guard++ < 200) w.advance(100);
  assert.equal(w.authority.owner(), "legacy");
  assert.equal(w.st.sitScheduled, 1, "scheduleLegacySit 交回 V1 timed policy");
  assert.equal(w.st.events.filter((e) => e.ev === "episode-close" && e.completed).length, 1);
  assert.equal(w.st.resumed.length, 0, "正常完成走 scheduleLegacySit，不触发 resumeLegacy（区分 close/interrupt）");
});

/* ---------------- D：Move 经唯一 commit point，无 legacy 旁路 ---------------- */

test("D: V2 Move 只有统一 commit point 写 native position；X 推进=速度策略；STAND_UP 期无 X", () => {
  const w = makeWorld();
  w.begin();
  const startX = w.st.bounds.x;
  for (let t = 0; t < 240; t += 40) w.advance(40); // beat 前
  assert.equal(w.st.bounds.x, startX, "STAND_UP 期无 X 位移（hold 语义保持）");
  w.advance(40); // 1280 ≥ beatEndAt → MOVE
  assert.equal(w.controller.phase(), "move");
  const moveWritesStart = w.st.writes.length;
  for (let t = 0; t < 400; t += 40) w.advance(40);
  assert.ok(w.st.bounds.x > startX + 8, "MOVE 期 X 前进（V2 commit）");
  assert.ok(w.st.writes.length - moveWritesStart >= 8, "MOVE 期间连续提交");
  // 每次 native write 必然对应一次 commit notify（唯一写路径）
  const succeededCommits = w.st.events.filter((e) => e.commit && e.outcome === "succeeded").length;
  assert.equal(w.st.writes.length, succeededCommits, "writes 与 commit 一一对应：没有绕过 commit point 的写入");
});

test("E: StandUp 的 seatExit Y 轨迹走 V2 ownership + commit point（原线性轨迹）", () => {
  const w = makeWorld({ startOffsetY: 30 });
  w.begin();
  const y0 = w.st.bounds.y;
  assert.ok(Math.abs(y0 - (w.baseY + 30)) < 1, "起始 Y=站立线+30（fromOffsetY 实测）");
  for (let t = 0; t < 120; t += 40) w.advance(40);
  const yMid = w.st.bounds.y;
  assert.ok(yMid < y0 && yMid > w.baseY, `线性过渡中：${y0} > ${yMid} > ${w.baseY}`);
  for (let t = 0; t < 120; t += 40) w.advance(40);
  assert.ok(Math.abs(w.st.bounds.y - w.baseY) <= 1, "过渡收敛到站立线（与 V1 seatExit 同式）");
  assert.ok(w.st.events.some((e) => e.commit === "standup-y"), "commit kind=standup-y");
});

/* ---------------- F/J：EnterSit 锚定与 geometry 规则 ---------------- */

test("F: EnterSit 用同一 commit point 完成 sink anchor（deadline 同帧锚定，与 V1 一致）", () => {
  const w = makeWorld();
  w.begin();
  let guard = 0;
  while (w.owns() && guard++ < 200) w.advance(50); // 完整 cycle（enter-sit 锚定 + close 同 tick）
  assert.ok(w.st.events.some((e) => e.commit === "enter-sit"), "anchor 经统一 commit point");
  assert.equal(w.st.projection.seated, true);
  const anchor = w.st.writes[w.st.writes.length - 1];
  assert.ok(Math.abs(anchor.y - (w.baseY + 30)) <= 1, "anchor Y = 站立线 + seatSink（30）");
});

test("J: geometry stale → 不得拿旧 gap 做新 Sit anchor：有界 hold 后安全 fallback V1", () => {
  const w = makeWorld();
  w.begin();
  let guard = 0;
  while (w.controller.phase() !== "move" && w.owns() && guard++ < 50) w.advance(40);
  w.st.geometryUsable = false; // MOVE 期间几何失效 → ENTER_SIT 锚定必须拒用旧 gap
  const writesAtFail = w.st.writes.length;
  guard = 0;
  while (w.owns() && guard++ < 100) w.advance(40); // MOVE 继续（规则绑在 Sit anchor），deadline 后 hold→fallback
  assert.equal(w.owns(), false, "hold 超时 → fallback（interrupt）");
  assert.ok(w.st.resumed.includes("geometry-unusable-fallback"), "交回 V1（resumeLegacy）");
  assert.ok(!w.st.events.some((e) => e.commit === "enter-sit"), "stale 期间没有发生任何 Sit anchor commit（拒绝旧 gap 假装 fresh）");
});

/* ---------------- G/H/I：stale callback / 中断 / 替换 ---------------- */

test("G: episode 关闭后的旧 commit（stale token/episodeId）被拒，不产生写入", () => {
  const w = makeWorld();
  const res = w.begin();
  const oldCtx = { token: res.token, episodeId: res.episodeId, kind: "move", x: 999, y: 500 };
  let guard = 0;
  while (w.owns() && guard++ < 200) w.advance(100);
  const denied = w.commit.commitPosition(oldCtx);
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, "stale-or-not-owner");
  assert.ok(!w.st.writes.some((wr) => wr.x === 999), "stale callback 未能写窗口");
  const before = w.st.writes.length;
  w.advance(100); // tick 对已关闭 episode 惰性
  assert.equal(w.st.writes.length, before);
});

test("H: Drag 中断 → V2 释放 ownership，外部/legacy 接管；V2 旧 callback 不能夺回", () => {
  const w = makeWorld();
  const res = w.begin();
  w.advance(100);
  w.controller.interrupt("drag-pause");
  assert.equal(w.owns(), false);
  assert.equal(w.authority.owner(), "legacy", "交回 legacy（drag 由 V1 路径处理）");
  assert.equal(w.st.resumed[0], "drag-pause");
  assert.equal(w.commit.commitPosition({ token: res.token, episodeId: res.episodeId, kind: "move", x: 700, y: 600 }).ok, false);
  // 再 begin 得到新 token/episode，旧 attempt 的 callback 永远失效
  const res2 = w.begin({ dir: 1, moveMs: 500 });
  assert.equal(res2.ok, true);
  assert.notEqual(res2.episodeId, res.episodeId);
  assert.equal(w.commit.commitPosition({ token: res.token, episodeId: res.episodeId, kind: "move", x: 710, y: 600 }).ok, false, "旧 attempt 永远失效");
});

test("I: renderer replacement（body 代际变化）→ episode 失效，不能恢复", () => {
  const w = makeWorld();
  w.begin();
  w.advance(100);
  w.st.bodyIdentity = { docEpoch: 6, renderGeneration: 1 }; // main 接线顺序：先更新 v2Geo.bodyIdentity，再通知 controller
  w.controller.onGeometryAccepted(w.st.bodyIdentity);
  assert.equal(w.owns(), false);
  assert.ok(w.st.events.some((e) => e.ev === "episode-close" && /body-replacement/.test(e.reason || "")));
  assert.ok(w.st.resumed.includes("body-replacement"));
  const before = w.st.writes.length;
  w.advance(100); // 后续 tick/证据不再驱动
  assert.equal(w.st.writes.length, before);
});

/* ---------------- K/L：fallback 与不重抽 ---------------- */

test("K: 左缘特殊触边（edgeLeft 区域）→ V2 让位 V1（不为覆盖率硬扩）", () => {
  const w = makeWorld();
  // minX = wa.x - inset(138) = -138；把窗口放到左缘附近，向左走会越界
  w.st.bounds = Object.assign({}, w.st.bounds, { x: -130 });
  const res = w.begin({ dir: -1, moveMs: 5000 });
  assert.equal(res.ok, true);
  let guard = 0;
  while (w.owns() && guard++ < 400) w.advance(40);
  assert.equal(w.st.resumed[w.st.resumed.length - 1], "left-edge-special-fallback", "左缘到达 → 交回 V1（edgeLeft/翻边属特殊触边）");
  assert.equal(w.authority.owner(), "legacy");
});

test("L: direction/duration 全由 V1 传入；controller 无任何 Math.random（不重抽）", () => {
  assert.doesNotMatch(controllerSource, /Math\.random/, "controller 源码零随机数");
  const a = makeWorld(), b = makeWorld();
  a.begin({ dir: -1, moveMs: 600 });
  b.begin({ dir: -1, moveMs: 600 });
  let g = 0;
  while (a.owns() && g++ < 100) { a.advance(40); if (b.owns()) b.advance(40); }
  assert.equal(a.st.bounds.x, b.st.bounds.x, "同输入序列 → 同轨迹（确定性）");
  assert.equal(a.st.bounds.y, b.st.bounds.y);
});

/* ---------------- A：gate OFF 生产接线（源码合同） ---------------- */

test("A: gate OFF——零 V2 运行时对象、所有 bypass 点 typeof 守卫、V1 路径完整保留", () => {
  assert.match(mainSource, /const RUNTIME_V2_LOCOMOTION_ENABLED = runtimeV2Module\.locomotionGateEnabled\(\);/);
  const v2IndexSource = fs.readFileSync(require.resolve("../src/runtime-v2/index.js"), "utf8");
  assert.match(v2IndexSource, /SUSSURRO_RUNTIME_V2_LOCOMOTION === "1"/, "gate：env='1' 显式开启，默认 OFF");
  assert.match(mainSource, /const v2Geo = RUNTIME_V2_LOCOMOTION_ENABLED \? \{/);
  assert.match(mainSource, /const v2Authority = RUNTIME_V2_LOCOMOTION_ENABLED \? runtimeV2Module\.createMotionAuthority\(\) : null;/);
  assert.match(mainSource, /const v2Commit = RUNTIME_V2_LOCOMOTION_ENABLED \? runtimeV2Module\.createWindowCommit\(\{/);
  assert.match(mainSource, /const v2Locomotion = RUNTIME_V2_LOCOMOTION_ENABLED \? \(\(\) => \{/);
  assert.match(mainSource, /const v2Drag = RUNTIME_V2_LOCOMOTION_ENABLED \? runtimeV2Module\.createDragSession\(\{/, "drag 会话条件创建：OFF 全为 null");
  assert.match(mainSource, /\}\) : null;\n\nfunction cancelFlight/, "v2Drag : null 收尾后接 cancelFlight（OFF 无 V2 运行时对象）");
  assert.match(mainSource, /const res = v2Drag\.commitMove\(/, "pet:move 经 commit point（EXTERNAL 准入）");
  assert.match(mainSource, /v2Drag\.begin\("drag", \{ docEpoch: renderModeSeq, senderId: _e\.sender && _e\.sender\.id \}\)/, "drag begin：LEGACY→EXTERNAL_DRAG 显式交接");
  assert.match(mainSource, /v2Drag\.active\(\)\) v2Drag\.end\(reason\)/, "clearDragPause 统一收口 end");
  assert.match(mainSource, /if \(typeof v2Locomotion !== "undefined" && v2Locomotion && v2Locomotion\.owns\(\)\) \{ v2Locomotion\.tick\(\); return; \}/, "walkTick cutover");
  assert.match(mainSource, /if \(typeof v2Locomotion !== "undefined" && v2Locomotion && v2Locomotion\.deniesLegacy\("walkSetPosition:" \+ where\)\) return false;/);
  assert.match(mainSource, /if \(typeof v2Locomotion !== "undefined" && v2Locomotion && v2Locomotion\.deniesLegacy\("applySeatPosition"\)\) return;/);
  assert.match(mainSource, /if \(typeof v2Locomotion !== "undefined" && v2Locomotion && v2Locomotion\.deniesLegacy\("seatExitStep"\)\) return;/);
  assert.match(mainSource, /const v2Take = typeof v2CanEnterSlice === "function" \? v2CanEnterSlice\(\) : \{ ok: false, reason: "gate-off" \};/);
  assert.match(mainSource, /if \(v2Take\.ok\) \{[\s\S]{0,160}walk\.dir = Math\.random\(\) < 0\.5 \? -1 : 1;[\s\S]{0,140}beginEpisode[\s\S]{0,80}if \(v2Res\.ok\) return;/, "方向/时长由 V1 选定；接管失败无缝回 V1");
  assert.match(mainSource, /armSeatExit\("move", "phase"\);[\s\S]{0,60}walk\.seated = false;/, "V1 原 stand-beat 路径完整保留（fallback）");
});

/* ---------------- 真实 V1 函数块 × V2：applySeatPosition deny ---------------- */

test("applySeatPosition 生产块：V2 持有时不写窗口；释放后照常", () => {
  const block = sourceBlock(mainSource, "function applySeatPosition", "function resizeTransientActive", "applySeatPosition");
  const w = makeWorld();
  const v2Locomotion = { deniesLegacy: (caller) => w.authority.denyLegacyWriter(caller) };
  let native = 0;
  const fakeWin = {
    isDestroyed: () => false,
    getBounds: () => ({ x: 600, y: w.baseY + 36, width: 260, height: 200 }), // 漂移 6px：触发真实重锚写
    setPosition: () => { native += 1; }
  };
  let layerCalls = 0;
  const applySeatPosition = new Function(
    "win", "config", "walk", "walkGeo", "screen", "effectiveSeatSink", "seatExitOffsetY", "applyLayer",
    "shadowBridge", "v2Locomotion",
    `let seatExit = null;
     ${block}; return applySeatPosition;`
  )(fakeWin, { getConfig: () => ({ renderMode: "spine" }) }, { groundGap: 10, seated: true, sunk: false, active: true },
    { workAreaOf: () => ({ x: 0, y: 0, width: 1536, height: 864 }) }, {}, () => 30, () => 0, () => { layerCalls += 1; },
    null, v2Locomotion);
  applySeatPosition(); // LEGACY：正常锚定
  assert.equal(native, 1);
  w.begin(); // V2 持有
  applySeatPosition();
  assert.equal(native, 1, "V2 持有：V1 seat anchor 被 ownership 拒绝");
  assert.equal(w.authority.snapshot().denyCounts.applySeatPosition, 1);
});

test("commit 坐标守卫 + 所有权拒绝：stale/非法坐标零写入", () => {
  const w = makeWorld();
  const res = w.begin();
  assert.equal(w.commit.commitPosition({ token: res.token, episodeId: res.episodeId, kind: "move", x: 1e9, y: 0 }).reason, "illegal-coords");
  assert.equal(w.commit.commitPosition({ token: res.token + 1, episodeId: res.episodeId, kind: "move", x: 100, y: 100 }).reason, "stale-or-not-owner");
  assert.equal(w.commit.commitPosition({ token: res.token, episodeId: "other-ep", kind: "move", x: 100, y: 100 }).reason, "stale-or-not-owner");
  assert.ok(!w.st.writes.some((wr) => wr.x === 100), "被拒 commit 全部零写入");
});

test("controller 异常 → 安全交回 V1（故障隔离：不撕裂、不夺权）", () => {
  const w = makeWorld();
  const res = w.begin();
  w.advance(40);
  w.st.throwProjection = true; // beat 到点的 projection 写抛错 → tick catch → interrupt
  w.advance(300);
  assert.equal(w.authority.owner(), "legacy", "controller-fault 后 ownership 已释放");
  assert.ok(w.st.resumed.some((r) => /controller-fault/.test(r)));
  w.st.throwProjection = false;
  // 释放后旧 episode 的 commit 不能复活
  assert.equal(w.commit.commitPosition({ token: res.token, episodeId: res.episodeId, kind: "move", x: 400, y: 500 }).ok, false);
});

test("authority 语义：acquire 仅从 LEGACY；release 后 token 单调不回收；external 拒绝 acquire", () => {
  const a = runtimeV2.createMotionAuthority();
  assert.equal(a.acquire("e1").ok, true);
  assert.equal(a.acquire("e2").ok, false);
  assert.equal(a.snapshot().episodeId, "e1");
  a.release("test");
  assert.equal(a.owner(), "legacy");
  a.externalAcquire("drag");
  assert.equal(a.acquire("e2").ok, false, "external 占用期拒绝 V2 acquire");
  a.externalRelease();
  const r = a.acquire("e2");
  assert.equal(r.ok, true);
  assert.ok(r.token > 1, "token 单调递增（旧 token 永不复用）");
});
