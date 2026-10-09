/**
 * p0-b2-alive-status.test.js — T13 / T14 / T15 / T16 / T12（状态真相侧）
 *
 * 锁定任务 §6/§7/§8/§30 的硬规则：
 *  - configured ≠ healthy：API key / baseUrl 存在绝不能把 COGNITION 标成 AVAILABLE；
 *    未尝试过 = IDLE（诚实初值）。
 *  - 四态分层互不掩盖：provider 失败 ⇒ COGNITION=UNAVAILABLE 但 BODY 仍 READY（T14）；
 *    Host/formal 失败 ⇒ FORMAL=UNAVAILABLE 但 BODY 仍 READY（T15）。
 *  - 每个状态带 source + lastObservedAt；同状态刷新也留下新观察时间。
 *  - voice 失败只降 VOICE 层，不碰 COGNITION（T16 的状态语义）。
 *  - 状态迁移事件驱动（订阅只在真实迁移时触发），无轮询。
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const { createAliveStatus, formalFromProjectionState, SOURCES } = require("../src/alive-status");

test("initial states are honest: nothing is 'healthy' before a real observation (T13)", () => {
  const s = createAliveStatus();
  const snap = s.snapshot();
  assert.equal(snap.cognition.state, "IDLE", "never attempted ⇒ IDLE, not AVAILABLE");
  assert.equal(snap.cognition.source, SOURCES.NEVER_OBSERVED);
  assert.equal(snap.cognition.lastObservedAt, null);
  assert.equal(snap.formal.state, "UNAVAILABLE", "formal not yet read ⇒ UNAVAILABLE (unproven)");
  assert.equal(snap.body.state, "DEGRADED", "renderer not confirmed ⇒ DEGRADED");
  assert.equal(snap.voice.state, "UNKNOWN");
});

test("configured provider never implies AVAILABLE; only an observed success turn does (T13/§8)", () => {
  let t = 1000;
  const s = createAliveStatus({ now: () => t });
  // 模拟 main 在「配置存在/keyReady」情形下什么都不喂 —— 状态必须纹丝不动
  assert.equal(s.snapshot().cognition.state, "IDLE");
  // 一次真实成功 turn 之后才允许 AVAILABLE
  s.noteTurnStarted();
  assert.equal(s.snapshot().cognition.state, "WORKING");
  assert.equal(s.snapshot().cognition.source, SOURCES.CURRENT_TURN);
  s.noteTurnSucceeded();
  const c = s.snapshot().cognition;
  assert.equal(c.state, "AVAILABLE");
  assert.equal(c.source, SOURCES.OBSERVED_SUCCESS);
  assert.equal(c.lastObservedAt, 1000);
});

test("provider failure ⇒ COGNITION UNAVAILABLE while BODY remains READY; layers never conflate (T14)", () => {
  const s = createAliveStatus();
  s.noteBody("READY", "pet:body-ready");
  s.noteProjection("ok");
  s.noteTurnStarted();
  s.noteTurnFailed("NETWORK_ERROR");
  const snap = s.snapshot();
  assert.equal(snap.cognition.state, "UNAVAILABLE");
  assert.equal(snap.cognition.source, SOURCES.OBSERVED_FAILURE);
  assert.equal(snap.body.state, "READY", "provider failure must not degrade the desktop body");
  assert.equal(snap.formal.state, "OK", "provider failure must not masquerade as formal character loss");
});

test("Host/formal failure ⇒ FORMAL CHARACTER UNAVAILABLE while BODY remains READY (T15)", () => {
  const s = createAliveStatus();
  s.noteBody("READY", "renderer ready");
  s.noteTurnSucceeded(); // provider 本身是好的
  s.noteProjection("unavailable", "无法连接 Runtime Host");
  const snap = s.snapshot();
  assert.equal(snap.formal.state, "UNAVAILABLE");
  assert.equal(snap.formal.source, SOURCES.PROJECTION_RESPONSE);
  assert.equal(snap.body.state, "READY");
  assert.equal(snap.cognition.state, "AVAILABLE", "Host loss ≠ model loss（§6 不得互相冒充）");
});

test("projection-state mapping is exhaustive and fail-closed (§28 状态区分)", () => {
  assert.equal(formalFromProjectionState("ok"), "OK");
  assert.equal(formalFromProjectionState("package_mismatch"), "PACKAGE_MISMATCH");
  assert.equal(formalFromProjectionState("disabled"), "DISABLED");
  for (const bad of ["host_not_ready", "instance_unavailable", "unauthorized", "unavailable", "unknown", "failed", "nonsense"]) {
    assert.equal(formalFromProjectionState(bad), "UNAVAILABLE", bad);
  }
});

test("voice failure degrades ONLY the voice layer; text cognition success stands (T16 §24)", () => {
  const s = createAliveStatus();
  s.noteBody("READY");
  s.noteTurnSucceeded();
  s.noteVoice("DEGRADED", "克隆语音失败，已回退系统语音");
  const snap = s.snapshot();
  assert.equal(snap.voice.state, "DEGRADED");
  assert.equal(snap.voice.source, SOURCES.RENDERER_REPORT);
  assert.equal(snap.cognition.state, "AVAILABLE", "TTS 失败不得把成功 cognition 整体标成失败");
  assert.equal(snap.body.state, "READY");
});

test("recovery transitions need no restart: failed → next turn success flips truth back (T12 status side)", () => {
  const s = createAliveStatus();
  s.noteTurnFailed("HTTP_ERROR");
  assert.equal(s.snapshot().cognition.state, "UNAVAILABLE");
  s.noteTurnStarted();
  s.noteTurnSucceeded();
  const snap = s.snapshot();
  assert.equal(snap.cognition.state, "AVAILABLE");
  assert.equal(snap.cognition.source, SOURCES.OBSERVED_SUCCESS);
});

test("cancel is its own honest cognition state, distinct from failure", () => {
  const s = createAliveStatus();
  s.noteTurnStarted();
  s.noteTurnCancelled("requestId fence");
  const c = s.snapshot().cognition;
  assert.equal(c.state, "CANCELLED");
  assert.equal(c.source, SOURCES.OBSERVED_CANCEL);
});

test("stale-state refresh: same-state observations still update lastObservedAt/source (§30)", () => {
  let t = 100;
  const s = createAliveStatus({ now: () => t });
  s.noteProjection("ok");
  assert.equal(s.snapshot().formal.lastObservedAt, 100);
  t = 200;
  s.noteProjection("ok"); // 同状态再次观察
  const f = s.snapshot().formal;
  assert.equal(f.state, "OK");
  assert.equal(f.lastObservedAt, 200, "staleness must be traceable via lastObservedAt");
});

test("invalid states and sources fail loudly; detail is length-bounded (no generic registry creeping in)", () => {
  const s = createAliveStatus({ maxDetail: 20 });
  assert.throws(() => s.setLayer("cognition", "HEALTHY", {}), /must be one of/);
  assert.throws(() => s.setLayer("service", "OK", {}), /unknown layer/);
  assert.throws(() => s.setLayer("body", "READY", { source: "config exists" }), /unknown source/);
  s.setLayer("voice", "DEGRADED", { source: SOURCES.RENDERER_REPORT, detail: "x".repeat(500) });
  assert.equal(s.snapshot().voice.detail.length, 20);
});

test("subscribe fires exactly on real transitions, not on same-state refresh; unsubscribe honored", () => {
  const s = createAliveStatus();
  const seen = [];
  const off = s.subscribe((snap, layer) => seen.push([layer, snap[layer].state]));
  s.noteBody("READY");        // DEGRADED→READY：transition
  s.noteBody("READY");        // 同状态刷新：无通知
  s.noteTurnFailed("NET");    // IDLE→UNAVAILABLE：transition
  assert.deepEqual(seen, [["body", "READY"], ["cognition", "UNAVAILABLE"]]);
  off();
  s.noteTurnSucceeded();      // 已退订
  assert.equal(seen.length, 2);
});
