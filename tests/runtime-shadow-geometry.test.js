/**
 * Runtime V2 Shadow Slice v0.1 — geometry dependency 测试。
 * 覆盖 FREEZE PHASE 15 #4（scale requested 变化后旧 geometry stale）、
 * #5（新 scale applied 无新测量 → 旧 snapshot 不可消费）、#14（缺失来源不得被当前版本补齐）。
 */
"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");

const RS = require("../src/runtime-shadow");
const G = RS.geometrySnapshot;

const WORKAREA = { x: 0, y: 0, width: 1920, height: 1040 };
const SUPP = (over = {}) => ({
  scaleRequested: 1, workArea: WORKAREA, displayScaleFactor: 1,
  seatSink: 30, standSinkOffset: 0, sinkTier: "standard", ...over
});

test("scale requested 变化后旧 geometry → stale（PHASE 15 #4）", () => {
  const st = G.createGeometrySnapshotState();
  G.noteDocGeneration(st, { docEpoch: 5, renderGeneration: 3 });
  G.noteMeasurement(st, { px: 10, meta: { renderGeneration: 3, docEpoch: 5 }, decision: { accepted: true, value: 10 }, supplement: SUPP() });
  assert.equal(G.geometryValidity(st).validity, "valid");
  // setScale：requested 1 → 1.2
  G.noteScaleRequested(st, 1.2);
  const v = G.geometryValidity(st);
  assert.equal(v.validity, "stale");
  assert.equal(v.reason, "scale-generation-advanced");
  // 同值 setScale 不换代
  assert.equal(G.noteScaleRequested(st, 1.2), false);
});

test("新 scale 已应用但无新测量：旧 snapshot 不可消费（PHASE 15 #5）", () => {
  const st = G.createGeometrySnapshotState();
  G.noteDocGeneration(st, { docEpoch: 5, renderGeneration: 3 });
  G.noteMeasurement(st, { px: 10, meta: { renderGeneration: 3, docEpoch: 5 }, decision: { accepted: true, value: 10 }, supplement: SUPP() });
  // scale 换代后：derived 消费必须返回 null（不得把旧 gap 用于新定位判断）
  G.noteScaleRequested(st, 1.4);
  assert.equal(G.geometryValidity(st).validity, "stale");
  assert.equal(G.derivedConsumedGap(st), null, "stale snapshot 的 gap 不得派生为可消费值");
  assert.equal(G.derivedSeatBottom(st, 200, true), null);
  // 新测量带新 viewport/workArea 同拍补充 → 重新 valid
  G.noteMeasurement(st, {
    px: 14, meta: { renderGeneration: 3, docEpoch: 5 }, decision: { accepted: true, value: 14 },
    supplement: SUPP({ scaleRequested: 1.4 })
  });
  assert.equal(G.geometryValidity(st).validity, "valid");
});

test("viewport / workArea 变化同样使旧测量 stale", () => {
  const st = G.createGeometrySnapshotState();
  G.noteDocGeneration(st, { docEpoch: 5, renderGeneration: 3 });
  G.noteMeasurement(st, { px: 10, meta: { renderGeneration: 3, docEpoch: 5 }, decision: { accepted: true, value: 10 }, supplement: SUPP() });
  assert.equal(G.geometryValidity(st).validity, "valid");
  // display 拔掉一个：workArea 高度变化（经下一次采样的同拍补充发现不了——这里直接推 host）
  G.noteHost(st, { workArea: { x: 0, y: 0, width: 1920, height: 900 } });
  const v = G.geometryValidity(st);
  assert.equal(v.validity, "stale");
  assert.equal(v.reason, "work-area-changed");
});

test("geometry dependency metadata：缺失来源不得被当前版本补齐（PHASE 15 #14）", () => {
  const st = G.createGeometrySnapshotState();
  // 当前依赖身份已经成立（body-generation 先到）
  G.noteDocGeneration(st, { docEpoch: 5, renderGeneration: 3 });
  // 旧报告缺 renderGeneration → insufficient，且 provenance 保持 null——绝不拿当前身份补贴
  G.noteMeasurement(st, { px: 10, meta: { docEpoch: 5 }, decision: { accepted: true, value: 10 }, supplement: SUPP() });
  const v = G.geometryValidity(st);
  assert.equal(v.validity, "insufficient");
  assert.equal(v.reason, "provenance-missing-renderGeneration");
  assert.equal(st.measurement.provenance.renderGeneration, null, "provenance 不得被当前 renderGeneration 补齐");
  assert.equal(G.derivedConsumedGap(st), null, "insufficient 测量的 gap 不得派生消费");
  // rejected 报告不覆盖好测量
  const st2 = G.createGeometrySnapshotState();
  G.noteDocGeneration(st2, { docEpoch: 5, renderGeneration: 3 });
  G.noteMeasurement(st2, { px: 10, meta: { renderGeneration: 3, docEpoch: 5 }, decision: { accepted: true, value: 10 }, supplement: SUPP() });
  G.noteMeasurement(st2, { px: 66, meta: { renderGeneration: 2, docEpoch: 4 }, decision: { accepted: false, stale: true, reason: "stale" } });
  assert.equal(st2.measurement.value, 10, "rejected 旧包不得替换 measurement-of-record");
  assert.equal(st2.lastRejected.stale, true);
  assert.equal(G.geometryValidity(st2).validity, "valid");
});

test("晚到旧代证据：identity 判 stale（不是靠到达时间），good 测量不受影响（PHASE 15 #6 几何半边）", () => {
  const st = G.createGeometrySnapshotState();
  G.noteDocGeneration(st, { docEpoch: 5, renderGeneration: 3 });
  G.noteMeasurement(st, { px: 10, meta: { renderGeneration: 3, docEpoch: 5 }, decision: { accepted: true, value: 10 }, supplement: SUPP() });
  assert.equal(G.geometryValidity(st).validity, "valid");
  // 文档换代（renderer body-generation 先行推进身份）
  G.noteDocGeneration(st, { docEpoch: 6, renderGeneration: 4 });
  const v = G.geometryValidity(st);
  assert.equal(v.validity, "stale");
  assert.equal(v.reason, "doc-epoch-older-than-current");
});

test("geom-report 决策链（bridge 观察的 payload 形状）直接进 snapshot", () => {
  // 模拟 main 桥的 obsGroundGapReport payload
  const st = G.createGeometrySnapshotState();
  G.noteMeasurement(st, {
    px: 10,
    meta: { sourceMode: "spine", renderGeneration: 3, docEpoch: 5 },
    decision: { accepted: true, value: 40, target: "spine", changed: true },
    supplement: { scaleApplied: 0.275, viewport: { width: 260, height: 200 }, layoutBasis: "autoScale", scaleRequested: 1, workArea: WORKAREA, displayScaleFactor: 1, seatSink: 30, standSinkOffset: 0, sinkTier: "standard" }
  });
  const v = G.geometryValidity(st);
  assert.equal(v.validity, "valid");
  assert.equal(st.measurement.supplement.scaleApplied, 0.275);
  assert.equal(st.measurement.supplement.layoutBasis, "autoScale");
  assert.equal(st.configuration.seatSink, 30);
  assert.equal(st.configuration.sinkTier, "standard");
});
