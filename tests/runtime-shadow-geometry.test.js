/**
 * Runtime V2 Shadow Slice v0.1 — geometry provenance 测试（Blocker Closure）。
 * 覆盖：#6 旧 viewport measurement 晚到 → stale/insufficient 绝不 valid；
 * #7 missing generation = null → insufficient 绝不 0；#8 新 scale + 旧 measurement 不可消费；
 * rejected 不覆盖 good；derivedConsumedGap 只有 valid 可派生。
 * 身份模型：SAMPLE-TIME PROVENANCE（renderer 自带）+ receive-time host observation（显式分离）。
 */
"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");

const RS = require("../src/runtime-shadow");
const G = RS.geometrySnapshot;

const WORKAREA = { x: 0, y: 0, width: 1920, height: 1040 };
const HOST = { scaleRequested: 1, workArea: WORKAREA, displayScaleFactor: 1, seatSink: 30, standSinkOffset: 0, sinkTier: "standard" };
const GEOM = (over = {}) => ({ seq: 1, scaleEpoch: 0, sampledAt: { clock: "renderer-dateNow-ms", value: 1000 }, scaleApplied: 0.27, viewport: { width: 260, height: 200 }, layoutBasis: "autoScale", ...over });
const REPORT = (over = {}) => ({ px: 10, meta: { renderGeneration: 3, docEpoch: 5 }, decision: { accepted: true, value: 10 }, shadowGeom: GEOM(), hostAtReceive: HOST, ...over });

test("基线：采样时 provenance 齐备 → valid；身份全部来自 renderer 采样", () => {
  const st = G.createGeometrySnapshotState();
  G.noteDocGeneration(st, { docEpoch: 5, renderGeneration: 3 });
  G.noteMeasurement(st, REPORT());
  const v = G.geometryValidity(st);
  assert.equal(v.validity, "valid");
  const m = st.measurement;
  assert.equal(m.provenance.renderGeneration, 3);
  assert.equal(m.provenance.docEpoch, 5);
  assert.equal(m.provenance.seq, 1);
  assert.equal(m.provenance.scaleEpoch, 0);
  assert.deepEqual(m.provenance.viewport, { width: 260, height: 200 });
  // receive-time host observation 显式分离（不是 provenance）
  assert.equal(m.hostAtReceive.scaleRequested, 1);
  assert.deepEqual(m.hostAtReceive.workArea, WORKAREA);
});

test("#6 旧 viewport measurement 晚到（同代内 seq 倒退）→ 拒绝替换，good 保持 valid", () => {
  const st = G.createGeometrySnapshotState();
  G.noteDocGeneration(st, { docEpoch: 5, renderGeneration: 3 });
  // M1：viewport A
  G.noteMeasurement(st, REPORT({ shadowGeom: GEOM({ seq: 1, viewport: { width: 260, height: 200 } }) }));
  // M2：窗口 resize → viewport B（更新、更晚）
  G.noteMeasurement(st, REPORT({ px: 12, shadowGeom: GEOM({ seq: 2, viewport: { width: 300, height: 220 } }), decision: { accepted: true, value: 12 } }));
  assert.equal(G.geometryValidity(st).validity, "valid");
  assert.equal(st.measurement.provenance.viewport.width, 300);
  // M3：旧 viewport 报告晚到（seq 1 < 已收 2）→ 拒绝替换；measurement-of-record 不变
  G.noteMeasurement(st, REPORT({ px: 10, shadowGeom: GEOM({ seq: 1, viewport: { width: 260, height: 200 } }) }));
  assert.equal(st.lastRejected.reason, "late-report-seq");
  assert.equal(st.measurement.value, 12, "旧 viewport 测量绝不覆盖新测量");
  assert.equal(G.geometryValidity(st).validity, "valid");
});

test("#6b 无 seq 时退化为 scaleEpoch identity 比较：旧 epoch 晚到 → stale", () => {
  const st = G.createGeometrySnapshotState();
  G.noteDocGeneration(st, { docEpoch: 5, renderGeneration: 3 });
  G.noteMeasurement(st, REPORT({ shadowGeom: GEOM({ seq: 1, scaleEpoch: 0 }) }));
  // renderer scale 换代（applyScale）后的新报告
  G.noteMeasurement(st, REPORT({ px: 11, shadowGeom: GEOM({ seq: 2, scaleEpoch: 1 }), decision: { accepted: true, value: 11 } }));
  assert.equal(G.geometryValidity(st).validity, "valid");
  // 人为把 record 换成旧 epoch 报告（模拟绕过 seq 的晚到路径）→ stale
  G.noteMeasurement(st, REPORT({ px: 10, shadowGeom: GEOM({ seq: 3, scaleEpoch: 0 }), decision: { accepted: true, value: 10 } }));
  assert.equal(G.geometryValidity(st).validity, "stale");
  assert.equal(G.geometryValidity(st).reason, "scale-epoch-older-than-observed");
  assert.equal(G.derivedConsumedGap(st), null, "stale 不可消费");
});

test("#7 缺失 generation = null → insufficient，绝不能转 0（Number(null) 陷阱已封）", () => {
  const st = G.createGeometrySnapshotState();
  G.noteDocGeneration(st, { docEpoch: 5, renderGeneration: 3 });
  // meta 缺 renderGeneration
  G.noteMeasurement(st, REPORT({ meta: { docEpoch: 5 } }));
  const v = G.geometryValidity(st);
  assert.equal(v.validity, "insufficient");
  assert.equal(v.reason, "provenance-missing-renderGeneration");
  assert.equal(st.measurement.provenance.renderGeneration, null, "缺失保持 missing，不是 0");
  assert.equal(G.derivedConsumedGap(st), null);
  // meta.renderGeneration: null 同样保持 missing
  const st2 = G.createGeometrySnapshotState();
  G.noteMeasurement(st2, REPORT({ meta: { renderGeneration: null, docEpoch: 5 } }));
  assert.equal(st2.measurement.provenance.renderGeneration, null);
  assert.equal(G.geometryValidity(st2).validity, "insufficient");
  // docEpoch 缺失 → null（不是 0）；且不与纪元 0 混淆
  const st3 = G.createGeometrySnapshotState();
  G.noteDocGeneration(st3, { docEpoch: 0, renderGeneration: 1 });
  G.noteMeasurement(st3, REPORT({ meta: { renderGeneration: 1 } }));
  assert.equal(st3.measurement.provenance.docEpoch, null);
  // 身份 0 是合法纪元值：0 不得被当作缺失
  const st4 = G.createGeometrySnapshotState();
  G.noteDocGeneration(st4, { docEpoch: 0, renderGeneration: 1 });
  assert.equal(st4.dependency.docEpoch, 0);
});

test("#8 新 scale 已应用 + 旧 measurement → 不可消费（derivedConsumedGap 仅 valid）", () => {
  const st = G.createGeometrySnapshotState();
  G.noteDocGeneration(st, { docEpoch: 5, renderGeneration: 3 });
  G.noteMeasurement(st, REPORT());
  assert.equal(G.derivedConsumedGap(st), 10);
  // main setScale：receive 后依赖换代 → stale → 不可消费
  G.noteScaleRequested(st, 1.4);
  assert.equal(G.geometryValidity(st).validity, "stale");
  assert.equal(G.geometryValidity(st).reason, "scale-generation-advanced-after-receive");
  assert.equal(G.derivedConsumedGap(st), null, "旧 snapshot 的 gap 不得用于新定位判断");
  // 新测量（携带新 scaleEpoch）→ 重新 valid
  G.noteMeasurement(st, REPORT({ px: 14, decision: { accepted: true, value: 14 }, shadowGeom: GEOM({ seq: 2, scaleEpoch: 1 }) }));
  assert.equal(G.geometryValidity(st).validity, "valid");
  assert.equal(G.derivedConsumedGap(st), 14);
  // 同值 setScale 不换代
  assert.equal(G.noteScaleRequested(st, 1.4), false);
});

test("rejected measurement 不覆盖最后一份 accepted good measurement", () => {
  const st = G.createGeometrySnapshotState();
  G.noteDocGeneration(st, { docEpoch: 5, renderGeneration: 3 });
  G.noteMeasurement(st, REPORT());
  G.noteMeasurement(st, REPORT({ px: 66, meta: { renderGeneration: 2, docEpoch: 4 }, decision: { accepted: false, stale: true, reason: "stale" } }));
  assert.equal(st.measurement.value, 10, "good measurement 保持");
  assert.equal(st.lastRejected.stale, true);
  assert.equal(G.geometryValidity(st).validity, "valid");
});

test("receive-time host 观测变化 → stale（workArea / displayScaleFactor 是 main 侧独立观测）", () => {
  const st = G.createGeometrySnapshotState();
  G.noteDocGeneration(st, { docEpoch: 5, renderGeneration: 3 });
  G.noteMeasurement(st, REPORT());
  assert.equal(G.geometryValidity(st).validity, "valid");
  // 显示器拔掉：workArea 变化（main receive-time 观测，与 renderer provenance 无关）
  G.noteHost(st, { workArea: { x: 0, y: 0, width: 1920, height: 900 } });
  assert.equal(G.geometryValidity(st).validity, "stale");
  assert.equal(G.geometryValidity(st).reason, "work-area-changed-after-receive");
});

test("renderer 文档换代：旧代 measurement → stale；身份单调（不回卷）", () => {
  const st = G.createGeometrySnapshotState();
  G.noteDocGeneration(st, { docEpoch: 5, renderGeneration: 3 });
  G.noteMeasurement(st, REPORT());
  assert.equal(G.geometryValidity(st).validity, "valid");
  // 身份推进（新 owner commit）
  assert.equal(G.noteDocGeneration(st, { docEpoch: 6, renderGeneration: 1 }).changed, true);
  assert.equal(G.geometryValidity(st).validity, "stale");
  assert.equal(G.geometryValidity(st).reason, "doc-epoch-older-than-current");
  // 旧代身份晚到 → 拒绝回卷（A→B→late A）
  assert.equal(G.noteDocGeneration(st, { docEpoch: 5, renderGeneration: 3 }).rolledBackAttempt, true);
  assert.equal(st.dependency.docEpoch, 6, "identity 不回滚");
  // 跨代旧报告直接被 intake 拒绝
  G.noteMeasurement(st, REPORT({ px: 10, meta: { renderGeneration: 3, docEpoch: 5 }, decision: { accepted: true, value: 10 }, shadowGeom: GEOM({ seq: 9 }) }));
  assert.equal(st.lastRejected.reason, "stale-doc-epoch");
});

test("snapshot 视图（诊断有界字段表）", () => {
  const st = G.createGeometrySnapshotState();
  G.noteDocGeneration(st, { docEpoch: 5, renderGeneration: 3 });
  G.noteMeasurement(st, REPORT());
  const view = G.geometrySnapshotView(st);
  assert.equal(view.validity, "valid");
  assert.equal(view.consumedGap, 10);
  assert.ok(view.measurement.provenance);
  assert.ok(view.measurement.hostAtReceive);
});
