/**
 * Runtime V2 DRAG↔LOCOMOTION Ownership Handoff v0.1 — 生产所有权测试。
 * 证明交接是真实的：V2_LOCOMOTION→EXTERNAL_DRAG→release→LEGACY/新 episode，
 * 不出现 V2/Drag 同时写、旧 callback 抢回、复活旧 attempt、ownership 卡死、双套 authority。
 * 用真实 runtime-v2 模块（authority/commit/controller/drag-session），并提取真实 main.js
 * pet:move 块验证 commit 路由 + 迟到拒绝 + gate OFF 路径逐字不变。
 */
"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");

const runtimeV2 = require("../src/runtime-v2");
const walkGeo = require("../src/walk-geo");
const mainSource = fs.readFileSync(require.resolve("../main.js"), "utf8").replace(/\r\n/g, "\n");

function sourceBlock(startMarker, endMarker, name) {
  const start = mainSource.indexOf(startMarker);
  const end = mainSource.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `${name} block exists`);
  return mainSource.slice(start, end);
}

/** 组合出与 main 接线同构的 V2 运行时（locomotion + drag 共享一个 authority + commit） */
function makeRuntime(opts = {}) {
  const wa = { x: 0, y: 0, width: 1536, height: 864 };
  const baseY = wa.y + wa.height + 10 - 200;
  const st = {
    now: 1000, bounds: { x: 600, y: baseY + (opts.startOffsetY || 0), width: 260, height: 200 },
    docEpoch: opts.docEpoch || 5, writes: [], snapCalls: [], events: [], resumed: [], sitScheduled: 0,
    geometryUsable: true, bodyIdentity: { docEpoch: opts.docEpoch || 5, renderGeneration: 3 }, face: 1,
    projection: { seated: true, resting: true, sunk: true, dir: 1, standingUpUntil: 0 }
  };
  const authority = runtimeV2.createMotionAuthority();
  const commit = runtimeV2.createWindowCommit({
    authority,
    writePosition: (x, y) => { st.writes.push({ x, y }); st.bounds = Object.assign({}, st.bounds, { x, y }); },
    writePositionExternal: (x, y) => { st.writes.push({ x, y }); st.bounds = Object.assign({}, st.bounds, { x, y }); },
    readRect: () => Object.assign({}, st.bounds),
    notifyWrite: (r) => st.events.push({ commit: r.kind, outcome: r.outcome })
  });
  const controller = runtimeV2.createLocomotionController({
    authority, commit,
    deps: {
      now: () => st.now, bounds: () => Object.assign({}, st.bounds), workArea: () => wa,
      clampX: (x, w, width) => walkGeo.clampWalkX(x, w, width, false, 138),
      speed: () => 1.2, groundGap: () => 10, seatSink: () => 30, skinHasSit: () => true, face: () => st.face,
      standBaseY: (b, w) => w.y + w.height + 10 - b.height,
      geometryUsable: () => st.geometryUsable ? { usable: true, validity: "valid", reason: "identity-match" } : { usable: false, validity: "stale", reason: "x" },
      geometryDependency: () => ({ value: 10, renderGeneration: 3 }), bodyIdentity: () => st.bodyIdentity,
      policies: { standBeatMs: 260, seatExitMs: 200 }, enterSitHoldTicks: 2
    },
    hooks: {
      setProjection: (patch) => Object.assign(st.projection, patch),
      broadcast: () => st.events.push({ ev: "broadcast" }),
      beginStandBroadcast: () => st.events.push({ ev: "stand-broadcast" }),
      setFace: (f) => { st.face = f; }, scheduleLegacySit: () => { st.sitScheduled += 1; },
      resumeLegacy: (r) => st.resumed.push(r), noteEvent: (e) => st.events.push(e)
    }
  });
  const drag = runtimeV2.createDragSession({
    authority, commit,
    deps: { now: () => st.now, currentRect: () => Object.assign({}, st.bounds) }
  });
  // 与 main 同构的门面对象
  const v2Locomotion = {
    owns: () => controller.owns(),
    beginEpisode: (i) => controller.beginEpisode(i),
    tick: () => controller.tick(),
    interrupt: (r) => controller.interrupt(r),
    onGeometryAccepted: (id) => controller.onGeometryAccepted(id),
    deniesLegacy: (c) => authority.denyLegacyWriter(c)
  };
  const api = {
    st, authority, commit, controller, drag, v2Locomotion, baseY,
    beginDrag() { // 复刻 walking-pause(true,drag) 的交接顺序：先 interrupt V2，再 externalAcquire
      v2Locomotion.interrupt("drag-pause");
      return drag.begin("drag", { docEpoch: st.docEpoch, senderId: 42 });
    },
    endDrag(reason) { return drag.end(reason); }, // 复刻 clearDragPause 收口
    advance(ms) { st.now += ms; if (v2Locomotion.owns()) v2Locomotion.tick(); }
  };
  return api;
}

/** 提取真实 pet:move 块，注入 fake win/v2Drag/dragSeatUpdate，跑生产路由 */
function buildPetMove(v2Drag, docEpoch) {
  let nativeWrites = 0;
  const win = {
    isDestroyed: () => false,
    getPosition: () => [600, 500],
    setPosition: () => { nativeWrites += 1; }
  };
  const state = { nativeWrites: () => nativeWrites };
  const dragSeatUpdate = () => { state.snap = (state.snap || 0) + 1; };
  new Function(
    "on", "win", "v2Drag", "v2Perf", "renderModeSeq", "dragSeatUpdate",
    `const ipcMain = { on }; let dbgLastMoveTs = 0;\n${sourceBlock('ipcMain.on("pet:move"', "let dbgLastMoveTs", "pet:move")}`
  )((ch, fn) => { state.fn = fn; }, win, v2Drag, null, docEpoch, dragSeatUpdate);
  return { fire: (dx, dy) => state.fn(null, dx, dy), state };
}

/* ---------------- A/B/C/D/E/F：ownership handoff 主链 ---------------- */

test("A: V2 locomotion active → drag begin → 旧 V2 token 失效 + EXTERNAL_DRAG current（绝不并存）", () => {
  const r = makeRuntime();
  const ep = r.v2Locomotion.beginEpisode({ dir: 1, moveMs: 1000 });
  assert.equal(ep.ok, true);
  assert.equal(r.authority.owner(), "v2-locomotion");
  const oldV2 = { token: ep.token, episodeId: ep.episodeId, kind: "move", x: 700, y: 500 };
  const b = r.beginDrag();
  assert.equal(b.ok, true, "drag begin 成功");
  assert.equal(r.authority.owner(), "external-drag", "V2 已释放→EXTERNAL，从不重叠");
  assert.equal(r.v2Locomotion.owns(), false, "V2 episode 不再持有");
  assert.equal(r.commit.commitPosition(oldV2).ok, false, "旧 V2 commit 被拒");
  assert.equal(r.authority.snapshot().lastTransition.from, "legacy", "V2→LEGACY→EXTERNAL 顺序交接");
  assert.equal(r.authority.isExternalCurrent(b.token), true);
});

test("B: Drag active → V2 locomotion 无法 acquire，且旧 V2 commit 被拒", () => {
  const r = makeRuntime();
  const ep = r.v2Locomotion.beginEpisode({ dir: 1, moveMs: 1000 });
  r.beginDrag();
  // 拖拽期间行为选择若试图开新 episode 必须失败（owner 非 LEGACY）
  assert.equal(r.v2Locomotion.beginEpisode({ dir: -1, moveMs: 500 }).ok, false, "drag 期禁止 V2 acquire");
  assert.equal(r.commit.commitPosition({ token: ep.token, episodeId: ep.episodeId, kind: "move", x: 650, y: 500 }).ok, false);
});

test("C+G: 真实 pet:move 块——drag session 活动时经 commitExternal 写 + 触发 V1 磁吸；非 owner 迟到事件被拒且不吸附", () => {
  const r = makeRuntime();
  const dragFacade = {
    active: () => r.drag.active(),
    commitMove: (x, y, meta) => r.drag.commitMove(x, y, meta)
  };
  const h = buildPetMove(dragFacade, r.st.docEpoch);
  r.beginDrag();
  h.fire(20, -30); // 提取块读 fake win [600,500]+delta → commitExternal 绝对写 (620,470)
  assert.ok(r.st.writes.some((w) => w.x === 620 && w.y === 470), "经 commitExternal 写入绝对位移");
  assert.equal(h.state.snap, 1, "成功移动后 V1 磁吸照常执行（snap/landing 仍工作）");
  // 迟到的旧 token：会话结束后的 pet:move 被拒（不写、不吸附）
  r.endDrag("drag-cleanup");
  const writesAfter = r.st.writes.length, snapAfter = h.state.snap;
  h.fire(50, 0);
  assert.equal(r.st.writes.length, writesAfter, "release 后 pet:move 被拒：不写窗口");
  assert.equal(h.state.snap, snapAfter, "被拒不触发磁吸");
});

test("D+E: release → EXTERNAL 释放回 LEGACY；旧 external token 的迟到 commitExternal 被拒", () => {
  const r = makeRuntime();
  const b = r.beginDrag();
  const tok = b.token;
  r.endDrag("drag-cleanup");
  assert.equal(r.authority.owner(), "legacy", "release 后 ownership 不卡在 EXTERNAL");
  assert.equal(r.drag.active(), false);
  assert.equal(r.commit.commitExternal({ externalToken: tok, kind: "drag-move", x: 700, y: 400 }).ok, false, "迟到旧 pointer commit 被拒");
});

test("F: drag release → 不恢复旧 Move 剩余时长；后续新 episode 是新 attempt", () => {
  const r = makeRuntime();
  const ep1 = r.v2Locomotion.beginEpisode({ dir: 1, moveMs: 5000 });
  r.advance(140); r.advance(140); // 越过 260ms beat → 进入 MOVE
  assert.equal(r.controller.phase(), "move");
  r.beginDrag();
  r.endDrag("drag-cleanup");
  // 旧 episode 已作废：其 commit 永远失效
  assert.equal(r.commit.commitPosition({ token: ep1.token, episodeId: ep1.episodeId, kind: "move", x: 800, y: 500 }).ok, false, "不复活旧 attempt");
  // 下一次行为选择才建立新 episode（新 id/attempt，moveMs 由调用方给，非旧剩余时间）
  const ep2 = r.v2Locomotion.beginEpisode({ dir: 1, moveMs: 800 });
  assert.equal(ep2.ok, true);
  assert.notEqual(ep2.episodeId, ep1.episodeId, "新 episode 新身份，绝不续用旧路径");
});

/* ---------------- H/I/J：throw / reload / late pointer ---------------- */

test("H: throw release → 经 clearDragPause 收口 EXTERNAL→LEGACY，飞行归 V1（out-of-scope）", () => {
  const r = makeRuntime();
  r.beginDrag();
  // pet:throw 成功路径 startFlight 内 clearDragPause("throw-accepted") → endDrag 收口
  r.endDrag("throw-accepted");
  assert.equal(r.authority.owner(), "legacy", "throw 后 ownership 回 LEGACY，交 V1 飞行");
  // V2 不会在 flight 期 acquire（canEnter 由 owner LEGACY + out-of-scope 双闸；此处只验不并存于 drag）
  assert.equal(r.drag.active(), false);
});

test("I: renderer reload during drag → 旧 dragSession 失效，旧 pointer 不得继续 commit", () => {
  const r = makeRuntime();
  const b = r.beginDrag();
  // reload 走 clearDragPause("renderer-reload")
  r.endDrag("renderer-reload");
  assert.equal(r.drag.active(), false, "reload 后旧会话失效");
  assert.equal(r.commit.commitExternal({ externalToken: b.token, kind: "drag-move", x: 300, y: 300 }).ok, false, "旧 pointer 事件被拒");
  // 即便有遗漏的 end，docEpoch 变化也让 commitMove 自行失效：
  const r2 = makeRuntime({ docEpoch: 5 });
  const b2 = r2.beginDrag();
  const tok = b2.token;
  assert.equal(r2.drag.commitMove(610, 500, { docEpoch: 9 }).ok, false, "文档纪元变化 → stale-renderer-doc 拒绝");
  assert.equal(r2.authority.owner(), "legacy", "失效即 release，不卡死");
  void tok;
});

test("J: late pointer move after release（提取真实 pet:move 块）→ 无活动会话即整条拒绝", () => {
  const r = makeRuntime();
  const dragFacade = { active: () => r.drag.active(), commitMove: (x, y, m) => r.drag.commitMove(x, y, m) };
  const h = buildPetMove(dragFacade, r.st.docEpoch);
  h.fire(30, 0); // 未经 beginDrag 的裸 pet:move：无 session → 拒绝
  assert.equal(r.st.writes.length, 0);
  assert.equal(h.state.snap || 0, 0, "无会话时既不写也不吸附");
});

/* ---------------- K/L：新稳态重新进入 V2 / gate OFF 不变 ---------------- */

test("K: release 后达到稳定合法状态 → 下一次行为选择可建立新 V2 episode", () => {
  const r = makeRuntime();
  r.beginDrag();
  r.endDrag("drag-cleanup");
  // 归位到 stable sit 投影后（main 中由 landing/snap 达成）下一次 acquire 成功
  Object.assign(r.st.projection, { seated: true, resting: true });
  const res = r.v2Locomotion.beginEpisode({ dir: -1, moveMs: 600 });
  assert.equal(res.ok, true, "新稳态可再次进入 V2 locomotion");
  assert.equal(r.authority.owner(), "v2-locomotion");
});

test("L: gate OFF——真实 pet:move 块在无 v2Drag 时走原 V1 路径（写 + 吸附），逐字不变", () => {
  const h = buildPetMove(undefined, 5); // v2Drag undefined → typeof 短路到 V1 分支
  h.fire(15, -7);
  assert.equal(h.state.nativeWrites(), 1, "OFF：一次 native setPosition");
  assert.equal(h.state.snap, 1, "OFF：dragSeatUpdate 照常");
});

/* ---------------- ownership 语义单元 ---------------- */

test("authority 交接不变量：externalAcquire 从 V2 直接抢占被拒（强制先 release）", () => {
  const a = runtimeV2.createMotionAuthority();
  a.acquire("e1");
  assert.equal(a.externalAcquire("drag").ok, false, "V2 未释放时不得直接抢占为 EXTERNAL");
  a.release("interrupt");
  assert.equal(a.externalAcquire("drag").ok, true, "先 release 回 LEGACY 后才可交接");
});

test("commit point 统一：drag-move 与 locomotion kind 都记在同一 stats（单一 commit point，无第二套）", () => {
  const r = makeRuntime();
  const b = r.beginDrag();
  r.drag.commitMove(620, 500, { docEpoch: r.st.docEpoch });
  assert.ok(r.commit.stats.byKind["drag-move"] >= 1);
  assert.equal(r.commit.stats.committed >= 1, true);
  assert.equal(r.authority.owner(), "external-drag");
  void b;
});

/* ---------------- 性能合同：热路径最小成本（ownership 语义不放松） ---------------- */

test("PERF-1: commitExternal 成功路径零 host reread（getBounds 只在 needHostRect 显式要求时读）", () => {
  let rectReads = 0, extWrites = 0, locoWrites = 0;
  const authority = runtimeV2.createMotionAuthority();
  const commit = runtimeV2.createWindowCommit({
    authority,
    writePosition: () => { locoWrites += 1; },
    writePositionExternal: () => { extWrites += 1; },
    readRect: () => { rectReads += 1; return { x: 0, y: 0, width: 1, height: 1 }; },
    notifyWrite: () => {}
  });
  const acq = authority.externalAcquire("drag");
  for (let i = 0; i < 50; i++) {
    const res = commit.commitExternal({ externalToken: acq.token, kind: "drag-move", x: 100 + i, y: 200 });
    assert.equal(res.ok, true);
  }
  assert.equal(rectReads, 0, "50 次 drag move：零 getBounds/host reread");
  assert.equal(extWrites, 50, "drag 写走 external writer");
  assert.equal(locoWrites, 0, "drag 不走 locomotion writer（不触发 layer 断言）");
  // locomotion 需要时才读（needHostRect 显式）
  authority.externalRelease("test");
  const ep = authority.acquire("e1");
  commit.commitPosition({ token: ep.token, episodeId: "e1", kind: "enter-sit", x: 1, y: 2, needHostRect: true });
  assert.equal(rectReads, 1, "仅显式 needHostRect 才读");
});

test("PERF-2: drag writer 与 locomotion writer 分离——drag-move 不触发 applyLayerThrottled 族成本", () => {
  let layerThrottleCalls = 0, bareCalls = 0;
  const authority = runtimeV2.createMotionAuthority();
  const commit = runtimeV2.createWindowCommit({
    authority,
    writePosition: () => { layerThrottleCalls += 1; },   // 代表含 applyLayerThrottled 的 walk/seat writer
    writePositionExternal: () => { bareCalls += 1; },    // 代表裸 setPosition（legacy pet:move 同价）
    notifyWrite: () => {}
  });
  const acq = authority.externalAcquire("drag");
  commit.commitExternal({ externalToken: acq.token, kind: "drag-move", x: 5, y: 5 });
  assert.equal(bareCalls, 1);
  assert.equal(layerThrottleCalls, 0, "drag move 不做 layer 断言（根因修复点）");
});

test("PERF-3: ownership/token 准入在热路径修复后仍然生效（stale 全拒）", () => {
  const r = makeRuntime();
  const b = r.beginDrag();
  assert.equal(r.commit.commitExternal({ externalToken: b.token, kind: "drag-move", x: 610, y: 500 }).ok, true);
  r.endDrag("drag-cleanup");
  assert.equal(r.commit.commitExternal({ externalToken: b.token, kind: "drag-move", x: 620, y: 500 }).ok, false, "release 后 stale token 仍拒");
  assert.equal(r.commit.commitExternal({ externalToken: b.token + 5, kind: "drag-move", x: 630, y: 500 }).ok, false, "错 token 仍拒");
  const ep = r.v2Locomotion.beginEpisode({ dir: 1, moveMs: 500 });
  r.advance(300);
  assert.equal(r.commit.commitPosition({ token: ep.token, episodeId: ep.episodeId, kind: "move", x: 610, y: 400 }).ok, true, "V2 locomotion commit 不受影响");
  r.v2Locomotion.interrupt("test");
  assert.equal(r.commit.commitPosition({ token: ep.token, episodeId: ep.episodeId, kind: "move", x: 615, y: 400 }).ok, false, "stale V2 仍拒");
});

test("PERF-4: 源码合同——drag 热路径零逐帧日志/stringify；notify 跳过 drag-move；单一 IPC 上行", () => {
  // notifyWrite 对 drag-move 零工作（drag 的 Shadow 可见性由 obsTakeover 覆盖）
  assert.match(mainSource, /if \(r\.kind === "drag-move"\) return;/, "notifyWrite 跳过 drag-move");
  // drag writer 是裸 setPosition（不含 applyLayerThrottled）
  assert.match(mainSource, /writePositionExternal: \(x, y\) => \{ win\.setPosition\(x, y\); \}/, "external writer 裸 setPosition");
  assert.doesNotMatch(mainSource, /writePositionExternal:[^\n]*applyLayerThrottled/, "external writer 不得带 layer 断言");
  // pet:move V2 分支热路径无逐帧 stringify/logTts（PERF 汇总在 v2Perf gate 之后、200 次才一行）
  const moveStart = mainSource.indexOf("ipcMain.on(\"pet:move\"");
  const moveBlock = mainSource.slice(moveStart, mainSource.indexOf("dragSeatUpdate();", moveStart));
  assert.doesNotMatch(moveBlock, /JSON\.stringify/, "pet:move 热路径零 stringify");
  const hotLogs = (moveBlock.match(/logTts\(/g) || []);
  assert.equal(hotLogs.length, 1, "pet:move 热路径唯一 logTts 是 PERF 采样行");
  assert.match(moveBlock, /v2Perf\.moves % 200 === 0\) logTts/, "该行在 200 次有界采样 gate 内");
  assert.match(mainSource, /v2Perf\.moves % 200 === 0/, "PERF 汇总有界采样（200 次一行）");
  // 单一 IPC：pointermove 仍只经 moveWindow→pet:move 一条上行（renderer 未新增第二条高频 IPC）
  const petSource = fs.readFileSync(require.resolve("../renderer/pet.js"), "utf8").replace(/\r\n/g, "\n");
  const moveCalls = (petSource.match(/petAPI\.moveWindow\(/g) || []).length;
  assert.equal(moveCalls, 1, "renderer 仅一条 pet:move 上行路径");
});
