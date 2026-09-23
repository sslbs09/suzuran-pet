"use strict";
/**
 * A-v2 纯决策函数回归：seat-hold 欠账兑现 + 坐姿棘轮同步。
 * 真机 FITDIAG 实证的两个根因路径（cold-start 6 pass 全被 seat-hold 吃掉；
 * autoScale 新 baseline 被过期 entryScale 棘轮拉回旧值=坐下变小/走路恢复）。
 */
const assert = require("node:assert/strict");
const test = require("node:test");
const { seatReleaseShouldRefit, seatRatchetSync, bootstrapShouldDeferWalk } = require("../src/seat-fit");

test("S1: pendingFit from held passes forces a release re-anchor; without debt no re-anchor", () => {
  assert.equal(seatReleaseShouldRefit({ pendingFit: true }), true, "T1: hold 消费过 pass ⇒ 释放必须重锚");
  assert.equal(seatReleaseShouldRefit({ pendingFit: false }), false);
  assert.equal(seatReleaseShouldRefit(null), false);
  assert.equal(seatReleaseShouldRefit(undefined), false);
});

test("S2: ratchet sync lifts stale snapshots to the new authoritative base", () => {
  const ep = { active: true, entryScale: 0.205, previousScale: 0.205 };
  assert.equal(seatRatchetSync(ep, 0.27514), true);
  assert.equal(ep.entryScale, 0.27514, "T2: autoScale 后 Sit 不得再把 scale 写回旧 baseline");
  assert.equal(ep.previousScale, 0.27514);
});

test("S3: sync is inert for inactive episode and idempotent when already at anchor", () => {
  assert.equal(seatRatchetSync({ active: false, entryScale: 0.205, previousScale: 0.205 }, 0.27514), false);
  const ep = { active: true, entryScale: 0.27514, previousScale: 0.27514 };
  assert.equal(seatRatchetSync(ep, 0.27514), false, "幂等：无变化不写不回卷");
  assert.equal(ep.entryScale, 0.27514);
});

test("S4: zero/NaN base never syncs (T4: manual-skin 无 autoScale 时棘轮语义原样)", () => {
  const ep = { active: true, entryScale: 0.4, previousScale: 0.35 };
  assert.equal(seatRatchetSync(ep, 0), false);
  assert.equal(seatRatchetSync(ep, NaN), false);
  assert.equal(seatRatchetSync(ep, null), false);
  assert.deepEqual({ entryScale: ep.entryScale, previousScale: ep.previousScale }, { entryScale: 0.4, previousScale: 0.35 },
    "非 autoScale 路径不得触碰 ratchet（T5 前置：guard/grounding 的只降不升语义保持）");
});

test("S5: signed base normalizes to magnitude", () => {
  const ep = { active: true, entryScale: 0.205, previousScale: 0.205 };
  assert.equal(seatRatchetSync(ep, -0.27514), true, "face=-1 时 base 取绝对值比较");
  assert.equal(ep.entryScale, 0.27514);
});

test("S6: bootstrap gate defers walk/sit phase replay until first visible", () => {
  assert.equal(bootstrapShouldDeferWalk(true), true, "A21: gate 期间 boot-Sit 相位切换延后（idle 采样不被坐矮轮廓污染）");
  assert.equal(bootstrapShouldDeferWalk(false), false, "释放后相位切换恢复正常路径");
  assert.equal(bootstrapShouldDeferWalk(undefined), false);
});
