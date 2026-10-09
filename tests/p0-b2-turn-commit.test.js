/**
 * p0-b2-turn-commit.test.js — §12/§14/§18/§19/§20 提交边界纪律（纯逻辑）
 *
 * 锁定目标 turn 语义：PROVIDER SUCCESS 才提交；FAILURE / CANCELLED /
 * LATE RESULT AFTER CANCEL 一次都不提交；栅栏复用现有 ownership 判定（不新建第二套）。
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const { createTurnCommitBoundary } = require("../src/turn-commit");

function tracker() {
  const ran = [];
  return {
    ran,
    fx: (name) => () => ran.push(name)
  };
}

test("success commit runs every staged effect EXACTLY once; repeat commit is inert", () => {
  const t = tracker();
  const b = createTurnCommitBoundary({ isCurrent: () => true, generationValid: () => true });
  b.stage("history-user", t.fx("user"));
  b.stage("history-assistant", t.fx("assistant"));
  b.stage("bond", t.fx("bond"));
  b.stage("vector", t.fx("vector"));
  const r1 = b.commit();
  assert.equal(r1.committed, true);
  assert.deepEqual(t.ran, ["user", "assistant", "bond", "vector"]);
  const r2 = b.commit();
  assert.equal(r2, r1, "唯一终局：重复 commit 返回同一 settlement");
  assert.equal(t.ran.length, 4, "effects never re-run on a settled boundary");
});

test("fence: not-current (user cancelled / late result) ⇒ zero effects (T7/T8/§19)", () => {
  const t = tracker();
  let current = true;
  const b = createTurnCommitBoundary({ isCurrent: () => current, generationValid: () => true });
  b.stage("assistant", t.fx("assistant"));
  b.stage("bond", t.fx("bond"));
  current = false; // cancel 落在 provider resolve 之后、提交之前（迟到结果竞态）
  const r = b.commit();
  assert.equal(r.committed, false);
  assert.equal(r.reason, "cancelled");
  assert.deepEqual(r.dropped, ["assistant", "bond"]);
  assert.equal(t.ran.length, 0, "cancel must fence ALL persistence side effects");
});

test("fence: stale clear-history generation ⇒ no persistence revival (F-03 一致性)", () => {
  const t = tracker();
  const b = createTurnCommitBoundary({ isCurrent: () => true, generationValid: () => false });
  b.stage("assistant", t.fx("assistant"));
  b.stage("vector", t.fx("vector"));
  const r = b.commit();
  assert.equal(r.committed, false);
  assert.equal(r.reason, "stale-generation");
  assert.equal(t.ran.length, 0);
});

test("discard on provider failure: boundary settles without touching stores; late commit stays fenced (§12)", () => {
  const t = tracker();
  const b = createTurnCommitBoundary({ isCurrent: () => true, generationValid: () => true });
  b.stage("assistant", t.fx("assistant"));
  const d = b.discard("provider-error");
  assert.equal(d.committed, false);
  assert.equal(d.reason, "provider-error");
  assert.equal(t.ran.length, 0);
  const again = b.commit();
  assert.equal(again, d, "after discard the terminal is frozen: a late commit cannot resurrect writes");
  assert.equal(t.ran.length, 0);
});

test("staging after settle throws (a raced post-commit effect cannot smuggle itself in)", () => {
  const b = createTurnCommitBoundary({ isCurrent: () => true, generationValid: () => true });
  b.discard("failed");
  assert.throws(() => b.stage("late", () => {}), /after settle/);
});

test("one failing effect is recorded, others still commit, boundary remains single-terminal (磁盘故障不伪装)", () => {
  const ran = [];
  const logs = [];
  const b = createTurnCommitBoundary({
    isCurrent: () => true, generationValid: () => true, log: (m) => logs.push(m)
  });
  b.stage("a", () => ran.push("a"));
  b.stage("boom", () => { throw new Error("disk full"); });
  b.stage("c", () => ran.push("c"));
  const r = b.commit();
  assert.equal(r.committed, true);
  assert.deepEqual(r.failed, ["boom"]);
  assert.deepEqual(ran, ["a", "c"]);
  assert.ok(logs.some((l) => l.includes("effect failed: boom")));
});

test("constructor guards: boundary requires both fences (no half-wired fence)", () => {
  assert.throws(() => createTurnCommitBoundary({ generationValid: () => true }), TypeError);
  assert.throws(() => createTurnCommitBoundary({ isCurrent: () => true }), TypeError);
});
