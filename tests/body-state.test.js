"use strict";

/**
 * body-state.test.js — BodyStateAuthority v0.1 基础件单测（ADR-009 / D-009）。
 *
 * 覆盖任务要求：能力门、enterRest 落点、enterPerched 一致性、leaveSupport 清理、
 * 陈旧支撑证据不破坏姿态语义、body generation 只作为输入不由本权威推进。
 * 外加 shadow observer 的 gate / 有界台账 / 只读约束。
 *
 * 不 mock legacy walk：shadow 侧使用真实形状的 walk 对象断言只读性与分歧检测。
 */

const assert = require("node:assert/strict");
const test = require("node:test");

const { createBodyStateAuthority, BODY_POSTURES, SUPPORT_KINDS } = require("../src/body-state");
const { createBodyStateShadow, projectLegacyWalk } = require("../src/body-state/shadow");

const CAPABLE = { canSit: true };
const INCAPABLE = { canSit: false };

/* ============================ 模型边界 ============================ */

test("MODEL-1: 姿态枚举不含 resting / airborne / transition / 移动意图 / 动画名", () => {
  assert.deepEqual(BODY_POSTURES, ["standing", "seated", "perched", "unknown"]);
  for (const forbidden of ["resting", "airborne", "transition", "gotoPerch", "returning", "Move", "Sitd", "Relax"]) {
    assert.equal(BODY_POSTURES.indexOf(forbidden), -1, `姿态枚举不得包含 ${forbidden}（ADR-009 明确排除）`);
  }
});

test("MODEL-2: 支撑面枚举复用 posture-support 成立的领域知识", () => {
  assert.deepEqual(SUPPORT_KINDS, ["taskbar", "icon", "window-top", "none", "unknown"]);
});

test("MODEL-3: capabilities 必须是对象；缺省视为无能力", () => {
  assert.throws(() => createBodyStateAuthority({ capabilities: null }), TypeError);
  const b = createBodyStateAuthority({});
  assert.equal(b.canSitNow(), false);
  b.enterRest();
  assert.equal(b.posture(), "standing", "缺省无能力 → 不得进入坐姿");
});

/* ============================ enterRest 能力门 ============================ */

test("ENTER-REST-1: capable body enterRest → seated", () => {
  const b = createBodyStateAuthority({ capabilities: CAPABLE });
  const r = b.enterRest();
  assert.equal(b.posture(), "seated");
  assert.equal(r.posture, "seated");
  assert.equal(r.capability, "can-sit");
});

test("ENTER-REST-2: incapable body enterRest → standing（skinHasSit 门是物理能力，不是策略）", () => {
  const b = createBodyStateAuthority({ capabilities: INCAPABLE });
  const r = b.enterRest();
  assert.equal(b.posture(), "standing", "无坐下动画的身体不得进入坐姿");
  assert.equal(r.capability, "cannot-sit");
});

test("ENTER-REST-3: enterRest 不声明支撑（姿态与支撑严格分离）", () => {
  const b = createBodyStateAuthority({ capabilities: CAPABLE });
  b.enterRest();
  assert.equal(b.posture(), "seated");
  const s = b.support();
  assert.equal(s.kind, "unknown", "支撑须由 declareSupport 单独声明");
  assert.equal(s.valid, false);
});

test("ENTER-REST-4: 能力变更后 enterRest 落点随之改变（能力是被消费的外部输入）", () => {
  const caps = { canSit: false };
  const b = createBodyStateAuthority({ capabilities: caps });
  b.enterRest();
  assert.equal(b.posture(), "standing");
  caps.canSit = true; // 能力 owner 变更能力值；本权威只消费
  b.enterRest();
  assert.equal(b.posture(), "seated");
});

/* ============================ enterPerched / leaveSupport ============================ */

test("PERCH-1: enterPerched → 姿态与支撑一致（perched 必有支撑面）", () => {
  const b = createBodyStateAuthority({ capabilities: CAPABLE });
  const r = b.enterPerched("window-top", { valid: true, evidenceGeneration: 7 });
  assert.equal(b.posture(), "perched");
  assert.equal(r.posture, "perched");
  assert.equal(r.support, "window-top");
  assert.equal(r.supportValid, true);
  assert.equal(b.support().evidenceGeneration, 7);
});

test("PERCH-2: enterPerched 缺省支撑面为 window-top；未知值不得静默通过", () => {
  const b = createBodyStateAuthority({});
  assert.equal(b.enterPerched().support, "window-top");
  assert.equal(b.enterPerched("bogus-kind").support, "window-top", "非法支撑名不得进入");
  assert.equal(b.enterPerched("icon").support, "icon");
});

test("LEAVE-1: leaveSupport → 支撑清理且姿态回到站立", () => {
  const b = createBodyStateAuthority({ capabilities: CAPABLE });
  b.enterPerched("window-top", { valid: true, evidenceGeneration: 3 });
  assert.equal(b.posture(), "perched");

  b.leaveSupport();
  const s = b.support();
  assert.equal(b.posture(), "standing");
  assert.equal(s.kind, "none");
  assert.equal(s.valid, false);
  assert.equal(s.anchorStatus, "unknown");
  assert.equal(s.evidenceGeneration, null, "证据代数一并清理");
  assert.equal(s.staleReason, null);
});

/* ============================ 支撑证据语义 ============================ */

test("EVIDENCE-1: 陈旧支撑证据只降 support，**不破坏姿态语义**", () => {
  const b = createBodyStateAuthority({ capabilities: CAPABLE });
  b.enterRest();
  b.declareSupport("taskbar", { valid: true, evidenceGeneration: 5 });
  assert.equal(b.posture(), "seated");
  assert.equal(b.support().valid, true);

  // 支撑证据过期（scale/resize/reload）——姿态语义仍然成立
  const r = b.observeEvidence({ generation: 6, valid: false, reason: "scale-change" });
  assert.equal(r.stale, true);
  assert.equal(b.posture(), "seated", "姿态语义不得被证据失效改写（承接 posture-support 的优良建模）");
  const s = b.support();
  assert.equal(s.valid, false);
  assert.equal(s.anchorStatus, "stale");
  assert.equal(s.staleReason, "scale-change");
});

test("EVIDENCE-2: 支撑证据恢复有效不改变姿态", () => {
  const b = createBodyStateAuthority({ capabilities: CAPABLE });
  b.enterRest();
  b.declareSupport("taskbar", { valid: true, evidenceGeneration: 1 });
  b.observeEvidence({ generation: 2, valid: false, reason: "reload" });
  assert.equal(b.posture(), "seated");
  b.observeEvidence({ generation: 3, valid: true });
  assert.equal(b.posture(), "seated");
  assert.equal(b.support().valid, true);
  assert.equal(b.support().anchorStatus, "anchored");
  assert.equal(b.support().staleReason, null);
});

test("EVIDENCE-3: 失效次数有界台账可查（供诊断，非持久）", () => {
  const b = createBodyStateAuthority({});
  b.observeEvidence({ generation: 1, valid: false, reason: "a" });
  b.observeEvidence({ generation: 2, valid: false, reason: "b" });
  const snap = b.snapshot();
  assert.equal(snap.invalidations, 2);
  assert.equal(snap.lastInvalidation.reason, "b");
});

/* ============================ body generation 只作为输入 ============================ */

test("GEN-1: observeEvidence 记录外部代次，但权威**没有任何 API 推进它**", () => {
  const b = createBodyStateAuthority({});
  b.observeEvidence({ generation: 11, valid: true });
  assert.equal(b.snapshot().observedGeneration, 11);

  // 权威不提供 begin/advance 之类推进代际的入口——ADR-010 明确 body generation owner 未决
  const api = Object.keys(b).concat(["begin", "advanceGeneration", "newGeneration", "bump"]);
  for (const forbidden of ["begin", "advanceGeneration", "newGeneration", "bump"]) {
    assert.equal(typeof b[forbidden], "undefined", `本权威不得暴露 ${forbidden}（body generation owner 未决）`);
  }
  assert.ok(api.length > 0);
});

test("GEN-2: 未提供 generation 时不伪造（保持 unknown，不臆造代次）", () => {
  const b = createBodyStateAuthority({});
  b.observeEvidence({ valid: true });
  assert.equal(b.snapshot().observedGeneration, null, "不得凭空生成代次");
});

test("GEN-3: 支撑证据代数与 body 代次是两个独立字段，互不串写", () => {
  const b = createBodyStateAuthority({});
  b.enterPerched("icon", { valid: true, evidenceGeneration: 4 });
  assert.equal(b.support().evidenceGeneration, 4);
  assert.equal(b.snapshot().observedGeneration, null, "body 代次未提供时不得被支撑代数填充");
  b.observeEvidence({ generation: 9, valid: true });
  assert.equal(b.snapshot().observedGeneration, 9);
  assert.equal(b.support().evidenceGeneration, 4, "支撑证据代数不被 body 代次覆盖");
});

/* ============================ snapshot / 只读 ============================ */

test("SNAP-1: snapshot 返回副本，外部改动不得污染内部状态", () => {
  const b = createBodyStateAuthority({ capabilities: CAPABLE });
  b.enterRest();
  const s = b.snapshot();
  s.posture.value = "perched";
  s.support.kind = "icon";
  s.capabilities.canSit = false;
  assert.equal(b.posture(), "seated", "内部姿态未被外部副本污染");
  assert.equal(b.support().kind, "unknown");
  assert.equal(b.canSitNow(), true);
});

/* ============================ shadow observer ============================ */

test("SHADOW-1: 纯投影——legacy walk → expected posture/support（不推导 resting）", () => {
  assert.deepEqual(projectLegacyWalk({ seated: true, resting: true }), { posture: "seated", support: "taskbar" });
  assert.deepEqual(projectLegacyWalk({ perched: true, resting: true }), { posture: "perched", support: "window-top" });
  assert.deepEqual(projectLegacyWalk({ iconRest: true }), { posture: "perched", support: "icon" });
  assert.deepEqual(projectLegacyWalk({ seated: false, resting: false }), { posture: "standing", support: "none" });
  // resting 变化不得改变投影结果——resting 是策略轴（ADR-009 排除）
  assert.deepEqual(
    projectLegacyWalk({ seated: false, resting: false }),
    projectLegacyWalk({ seated: false, resting: true })
  );
});

test("SHADOW-2: gate 默认 OFF → observe 首行短路，零记录", () => {
  const b = createBodyStateAuthority({ capabilities: CAPABLE });
  const sh = createBodyStateShadow({ bodyState: b });
  assert.equal(sh.isEnabled(), false);
  assert.equal(sh.observe({ seated: true }), null);
  const s = sh.snapshot();
  assert.equal(s.enabled, false);
  assert.equal(s.observations, 0);
  assert.equal(s.divergences, 0);
});

test("SHADOW-3: gate ON 时检测分歧，且**只读** legacy walk（不写回任何字段）", () => {
  const b = createBodyStateAuthority({ capabilities: CAPABLE });
  const sh = createBodyStateShadow({ bodyState: b, enabled: true });

  // authority 仍在 unknown，legacy 已是 seated → posture 与 support 同时分歧
  const walk = { seated: true, resting: true, perched: false };
  const before = JSON.stringify(walk);
  const d = sh.observe(walk, { reason: "unit" });
  assert.ok(d, "应记录分歧");
  assert.deepEqual(d.fields, ["posture", "support"], "支撑未声明时两个维度都应报分歧");
  assert.deepEqual(d.expected, { posture: "seated", support: "taskbar" });
  assert.deepEqual(d.actual, { posture: "unknown", support: "unknown" });
  assert.equal(JSON.stringify(walk), before, "shadow 绝不写 legacy walk");
  assert.equal(sh.hasDivergence(), true);
});

test("SHADOW-3b: 支撑已对齐时只报 posture 单维分歧（逐维定位能力）", () => {
  const b = createBodyStateAuthority({ capabilities: CAPABLE });
  b.declareSupport("taskbar", { valid: true }); // 支撑已对齐，姿态仍 unknown
  const sh = createBodyStateShadow({ bodyState: b, enabled: true });
  const d = sh.observe({ seated: true });
  assert.deepEqual(d.fields, ["posture"], "支撑一致时不得误报 support");
  assert.equal(d.actual.support, "taskbar");
});

test("SHADOW-4: 一致时无分歧记录（可作为迁移退出条件的证据源）", () => {
  const b = createBodyStateAuthority({ capabilities: CAPABLE });
  b.enterRest();
  b.declareSupport("taskbar", { valid: true });
  const sh = createBodyStateShadow({ bodyState: b, enabled: true });
  assert.equal(sh.observe({ seated: true, resting: false, perched: false }), null);
  assert.equal(sh.hasDivergence(), false);
  assert.equal(sh.snapshot().divergences, 0);
  assert.equal(sh.snapshot().observations, 1);
});

test("SHADOW-5: 台账有界，超出上限按 FIFO 淘汰", () => {
  const b = createBodyStateAuthority({});
  const sh = createBodyStateShadow({ bodyState: b, enabled: true, ledgerMax: 3 });
  for (let i = 0; i < 10; i += 1) sh.observe({ seated: true }, { reason: "r" + i });
  const s = sh.snapshot();
  assert.equal(s.ledger.length, 3, "台账不得无限增长");
  assert.equal(s.ledgerMax, 3);
  assert.equal(s.ledger[0].reason, "r7", "保留最近 3 条");
  assert.equal(s.ledger[2].reason, "r9");
  assert.equal(s.divergences, 10, "计数不受台账上限影响");
});

test("SHADOW-6: 影子观测永不外抛，且脏输入被忽略而非记为分歧", () => {
  const b = createBodyStateAuthority({});
  const sh = createBodyStateShadow({ bodyState: b, enabled: true });
  const boom = { get seated() { throw new Error("explode"); } };
  assert.equal(sh.observe(boom), null, "getter 抛错被吞掉");
  assert.equal(sh.observe(null), null, "null 视为无观测");
  assert.equal(sh.observe(undefined), null);
  assert.equal(sh.observe("not-an-object"), null);
  assert.equal(sh.snapshot().divergences, 0, "脏输入不得污染迁移退出条件的分歧信号");
  assert.equal(sh.snapshot().observations, 0);
});

test("SHADOW-7: ledgerMax 非法即拒绝（构造期错误可被看见）", () => {
  assert.throws(() => createBodyStateShadow({ ledgerMax: 0 }), TypeError);
  assert.throws(() => createBodyStateShadow({ ledgerMax: -1 }), TypeError);
});

test("SHADOW-8: 无 bodyState 时不与 authority 比对（M1：只做能力裁决 + 覆盖统计）", () => {
  // M1 语义（较 M0 强化）：生产 authority 尚未被驱动（M2 未开始），此时比对必然恒分歧、
  // 毫无信息量。因此 bodyState 缺席时**完全跳过比对**，而不是拿空真值去比——
  // 原意图「不得误判为空真值」由此得到更强满足：不存在任何虚假 posture/support 分歧。
  const sh = createBodyStateShadow({ bodyState: null, enabled: true });
  assert.equal(sh.isEnabled(), true, "gate 本身独立于 authority 是否接入");
  assert.equal(sh.comparesAgainstAuthority(), false, "未接入 authority 时不做姿态比对");
  assert.equal(sh.observe({ seated: true }, { capability: true }), null, "能力可坐 + 声称 seated → 无分歧");
  assert.equal(sh.hasDivergence(), false, "绝不拿未接入的 authority 制造虚假分歧");
  const s = sh.snapshot();
  assert.equal(s.observations, 1, "观察与覆盖仍然记录");
  assert.equal(s.comparesAuthority, false);
  assert.equal(s.coverage.postures.seated, 1, "覆盖信号不依赖 authority 比对");
});

test("SHADOW-9: capability 未知 → 只标记不裁决，绝不制造假分歧", () => {
  const sh = createBodyStateShadow({ enabled: true });
  // 身体能力不可靠时不得默认 canSit=true/false
  assert.equal(sh.observe({ seated: true }, { capability: "UNKNOWN" }), null);
  assert.equal(sh.observe({ seated: true }, { capability: undefined }), null);
  assert.equal(sh.observe({ seated: true }, { capability: "garbage" }), null);
  const s = sh.snapshot();
  assert.equal(s.divergences, 0, "未知能力不得被当成坐不了而产生假分歧");
  assert.equal(s.coverage.capabilityUnknownSkips, 3);
  assert.equal(s.coverage.capability.unknown, 3);
  assert.equal(s.coverage.postures.seated, 3, "覆盖照常统计");
});

test("SHADOW-10: capability 违规（坐不了却声称 seated）→ 记分歧，且条目自带上下文", () => {
  const sh = createBodyStateShadow({ enabled: true });
  const d = sh.observe({ seated: true }, { capability: false });
  assert.ok(d, "能力不允许的物理姿态必须被记为分歧");
  assert.deepEqual(d.fields, ["capability"]);
  assert.equal(d.capabilityViolation, "body-cannot-sit-but-legacy-seated");
  assert.equal(d.capability, false, "条目自带 capability 上下文");
  assert.equal(d.expected.posture, "seated");
  assert.equal(typeof d.at, "number", "条目自带观测时刻");
});

test("SHADOW-11: 覆盖信号能区分「多状态覆盖」与「只见过 standing」，且样本量不足不算退出条件", () => {
  const rich = createBodyStateShadow({ enabled: true });
  for (const w of [{ seated: false }, { seated: true }, { perched: true }, { seated: false }]) {
    rich.observe(w, { capability: true });
  }
  const poor = createBodyStateShadow({ enabled: true });
  for (let i = 0; i < 3; i += 1) poor.observe({ seated: false }, { capability: true });

  const a = rich.coverageSummary();
  const b = poor.coverageSummary();

  // ① 两者必须可区分：覆盖状态集合与观测次数都不同
  assert.deepEqual(a.postureStates.sort(), ["perched", "seated", "standing"]);
  assert.deepEqual(b.postureStates, ["standing"]);
  assert.equal(a.distinctPostures, 3);
  assert.equal(b.distinctPostures, 1);
  assert.equal(a.observations > b.observations, true);
  assert.equal(rich.hasDivergence(), false);
  assert.equal(poor.hasDivergence(), false);
  assert.notDeepEqual(a, b, "「多状态+多样本」与「单状态+少样本」不得等价");

  // ② 即使覆盖多状态，样本量不足仍不算 M2 退出条件——这正是任务的 B 情形要防的
  assert.equal(a.insufficientCoverage, true, "4 次观测不足以作为 M2 退出条件");
  assert.equal(b.insufficientCoverage, true);

  // ③ 样本量与状态数都达标后才翻转
  const solid = createBodyStateShadow({ enabled: true });
  for (let i = 0; i < 60; i += 1) {
    solid.observe(i % 2 === 0 ? { seated: true } : { perched: true }, { capability: true });
  }
  const c = solid.coverageSummary();
  assert.equal(c.observations, 60);
  assert.equal(c.distinctPostures, 2);
  assert.equal(c.insufficientCoverage, false, "样本量与覆盖都达标才可作为退出条件");
});

test("SHADOW-12: 诊断不含任何对话内容（本机诊断，非 telemetry）", () => {
  const sh = createBodyStateShadow({ enabled: true });
  sh.observe({ seated: true }, { capability: false, reason: "unit" });
  const entry = sh.snapshot().ledger[0];
  const keys = Object.keys(entry);
  for (const forbidden of ["text", "prompt", "reply", "content", "message", "user"]) {
    assert.equal(keys.indexOf(forbidden), -1, `诊断条目不得包含 ${forbidden}`);
  }
  assert.deepEqual(keys.sort(), ["actual", "at", "capability", "capabilityViolation", "expected", "fields", "reason"].sort());
});