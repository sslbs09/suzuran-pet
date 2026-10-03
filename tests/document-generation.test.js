"use strict";

/**
 * document-generation.test.js — DocumentGenerationAuthority v0.1 基础件单测（ADR-010 / D-010）。
 *
 * 覆盖：代际只前进、宽容语义（代际未知不妄拒）、陈旧判定、台账有界、
 * 以及"本模块不拥有 body instance generation"的边界断言。
 */

const assert = require("node:assert/strict");
const test = require("node:test");

const { createDocumentGenerationAuthority, INVALIDATION_LEDGER_MAX } = require("../src/host/document-generation");

/* ============================ 代际推进 ============================ */

test("DOC-GEN-1: begin 推进 epoch 并单调抬升 revision", () => {
  const g = createDocumentGenerationAuthority();
  assert.equal(g.isKnown(), false, "初始代际未知");
  assert.deepEqual(g.current(), { epoch: null, revision: 0 });

  const a = g.begin(5);
  assert.equal(a.changed, true);
  assert.equal(a.epoch, 5);
  assert.equal(a.revision, 1);
  assert.equal(g.currentEpoch(), 5);
  assert.equal(g.currentRevision(), 1);
  assert.equal(g.isKnown(), true);
});

test("DOC-GEN-2: 代际只前进不回卷（更小的 epoch 被标 stale 且不改状态）", () => {
  const g = createDocumentGenerationAuthority();
  g.begin(5);
  const older = g.begin(4);
  assert.equal(older.changed, false);
  assert.equal(older.stale, true);
  assert.equal(g.currentEpoch(), 5, "旧 epoch 不得回卷代际");
  assert.equal(g.currentRevision(), 1);
});

test("DOC-GEN-3: 相同 epoch 重复 begin 不推进 revision", () => {
  const g = createDocumentGenerationAuthority();
  g.begin(5);
  const same = g.begin(5);
  assert.equal(same.changed, false);
  assert.equal(same.stale, undefined, "相同代次不是 stale，只是未变化");
  assert.equal(g.currentRevision(), 1);
});

test("DOC-GEN-4: 非法 epoch 既不推进也不回卷，且不伪造代次", () => {
  const g = createDocumentGenerationAuthority();
  for (const bad of [undefined, null, NaN, Infinity, "6", {}, []]) {
    const r = g.begin(bad);
    assert.equal(r.changed, false);
    assert.equal(r.ignored, "bad-epoch");
  }
  assert.equal(g.currentEpoch(), null, "不得凭空生成代次");
  assert.equal(g.currentRevision(), 0);
});

/* ============================ 宽容语义：代际未知不妄拒 ============================ */

test("DOC-GEN-5: 未带纪元或非法类型一律视为 current（核心宽容契约）", () => {
  const g = createDocumentGenerationAuthority();
  g.begin(5);
  for (const none of [null, undefined, NaN, Infinity, "not-a-number", {}, [], [5], true, false]) {
    assert.equal(g.isCurrent(none), true, "没报告纪元 ≠ 纪元过期，身份由各域自证");
  }
  // 强制转换陷阱：`Number([])===0`、`Number(true)===1` —— 盲转换会制造假拒绝
  assert.equal(Number([]), 0);
  assert.equal(Number(true), 1);
});

test("DOC-GEN-5b: 数值与数值字符串被正常采信（与既有 epoch 传递形态兼容）", () => {
  const g = createDocumentGenerationAuthority();
  g.begin(5);
  assert.equal(g.isCurrent(5), true);
  assert.equal(g.isCurrent(4), false);
  assert.equal(g.isCurrent("5"), true, "数值字符串等同数值（renderer 侧可能以字符串传递）");
  assert.equal(g.isCurrent("4"), false);
  assert.equal(g.isCurrent(""), true, "空字符串视为未报告");
});

test("DOC-GEN-6: 本权威尚不知道代次时，不拒绝任何候选", () => {
  const g = createDocumentGenerationAuthority();
  assert.equal(g.isKnown(), false);
  assert.equal(g.isCurrent(99), true, "代际未知时不妄拒（身份由各域自证）");
  g.begin(100);
  assert.equal(g.isCurrent(99), false, "代次一旦已知，旧纪元即可被拒");
});

test("DOC-GEN-7: 陈旧判定——旧 epoch 拒、当期 epoch 收、未来 epoch 收", () => {
  const g = createDocumentGenerationAuthority();
  g.begin(10);
  assert.equal(g.isCurrent(9), false, "旧文档的迟到 continuation 必须被拒");
  assert.equal(g.isCurrent(10), true, "当期收");
  assert.equal(g.isCurrent(11), true, "更新代次不得被旧权威误拒");
});

test("DOC-GEN-8: 宽容语义在换代后依然成立（陈旧检查不得退化为拒绝一切）", () => {
  const g = createDocumentGenerationAuthority();
  g.begin(3);
  assert.equal(g.isCurrent(null), true);
  g.begin(4);
  assert.equal(g.isCurrent(undefined), true);
  assert.equal(g.isCurrent(3), false, "换代后旧纪元确实被拒");
});

/* ============================ 失效台账 ============================ */

test("DOC-GEN-9: invalidate 只记账，不改变代次", () => {
  const g = createDocumentGenerationAuthority();
  g.begin(7);
  const e = g.invalidate("renderer-crash", "render-process-gone");
  assert.equal(e.kind, "renderer-crash");
  assert.equal(e.reason, "render-process-gone");
  assert.equal(e.epoch, 7);
  assert.equal(e.revision, 1);
  assert.equal(g.currentEpoch(), 7, "invalidate 不得隐式推进代次");
});

test("DOC-GEN-10: 台账有界，FIFO 淘汰", () => {
  const g = createDocumentGenerationAuthority({ ledgerMax: 3 });
  g.begin(1);
  for (let i = 0; i < 8; i += 1) g.invalidate("reload", "r" + i);
  const s = g.snapshot();
  assert.equal(s.ledger.length, 3);
  assert.equal(s.ledgerMax, 3);
  assert.equal(s.ledger[0].reason, "r5");
  assert.equal(s.ledger[2].reason, "r7");
});

test("DOC-GEN-11: ledger 返回副本，外部改动不得污染内部", () => {
  const g = createDocumentGenerationAuthority();
  g.invalidate("a", "x");
  const l = g.ledger();
  l.push({ kind: "injected" });
  l[0].reason = "tampered";
  assert.equal(g.ledger().length, 1);
  assert.equal(g.ledger()[0].reason, "x");
});

test("DOC-GEN-12: 缺省台账上限沿用 runtime-shadow 惯例", () => {
  const g = createDocumentGenerationAuthority();
  assert.equal(g.INVALIDATION_LEDGER_MAX, INVALIDATION_LEDGER_MAX);
  assert.equal(INVALIDATION_LEDGER_MAX, 16);
});

/* ============================ 边界：不拥有 body generation ============================ */

test("DOC-GEN-13: 本模块不提供任何 body instance generation 的裁决入口", () => {
  const g = createDocumentGenerationAuthority();
  // ADR-010：body instance generation 是独立未决域。本模块不得裁决它。
  for (const forbidden of ["beginBody", "bodyGeneration", "noteBodyGeneration", "replaceBody", "isBodyCurrent", "invalidateBody"]) {
    assert.equal(g[forbidden], undefined, `本模块不得暴露 ${forbidden}`);
  }
  // snapshot 里也不得出现 bodyGeneration 字段
  g.begin(2);
  assert.equal(Object.prototype.hasOwnProperty.call(g.snapshot(), "bodyGeneration"), false);
});

test("DOC-GEN-14: 本模块只读 document 维度，不引入 drag/locomotion/animation/shadow 概念", () => {
  const g = createDocumentGenerationAuthority();
  for (const forbidden of ["dragToken", "attemptId", "animationGeneration", "sourceSeq", "causeRef"]) {
    assert.equal(g[forbidden], undefined, `本模块不得持有 ${forbidden}`);
  }
});

test("DOC-GEN-15: 局部 generation 判定与 document generation 互不干涉", () => {
  const g = createDocumentGenerationAuthority();
  g.begin(5);
  // drag session token / locomotion attemptId 由各自局部 authority 持有，
  // 它们不变时 document 代次也不应因此变化。
  const before = g.currentRevision();
  // 模拟局部权威自行推进（此处不接线，仅断言两者独立）
  assert.equal(g.currentRevision(), before);
  g.begin(6);
  assert.equal(g.currentRevision(), before + 1, "只有 document 换代才推进本权威");
});

/* ============================ reset / 构造约束 ============================ */

test("DOC-GEN-16: reset 回到初始未知态（供测试与 teardown 使用）", () => {
  const g = createDocumentGenerationAuthority({ ledgerMax: 2 });
  g.begin(3);
  g.invalidate("a", "b");
  g.reset();
  assert.deepEqual(g.current(), { epoch: null, revision: 0 });
  assert.equal(g.isKnown(), false);
  assert.equal(g.snapshot().ledger.length, 0);
  assert.equal(g.isCurrent(5), true, "reset 后回到宽容态");
});

test("DOC-GEN-17: ledgerMax 非法即拒绝（构造期错误可被看见）", () => {
  assert.throws(() => createDocumentGenerationAuthority({ ledgerMax: 0 }), TypeError);
  assert.throws(() => createDocumentGenerationAuthority({ ledgerMax: -1 }), TypeError);
  assert.throws(() => createDocumentGenerationAuthority({ ledgerMax: "x" }), TypeError);
});