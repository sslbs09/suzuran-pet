"use strict";

/**
 * STAGE B：EXTERNAL AGENT FORMAL COGNITION PARITY — Body 合同测试。
 * 单一 formal cognition 读取 owner（fetchFormalCognition）：UI chat 与 External Agent /chat 共用。
 * 覆盖：helper 行为真值表、引用点封闭（无第二套 builder）、External /chat 组装合同、
 *       instance 标记写回、formal 不可达 honest failure（不降级 legacy）、/speak 隔离、legacy 模式零变化。
 */
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");

const mainSource = fs.readFileSync(require.resolve("../main.js"), "utf8").replace(/\r\n/g, "\n");
function sourceBlock(startMarker, endMarker, name) {
  const start = mainSource.indexOf(startMarker);
  const end = mainSource.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `${name} block exists`);
  return mainSource.slice(start, end);
}

/* ---------------- helper 行为真值表（真实生产代码块） ---------------- */

const SUPPRESSION_CATEGORIES = ["LEGACY_BOND", "LEGACY_FACT", "LEGACY_SUMMARY", "LEGACY_VECTOR_RECALL", "EXPLICIT_USER_PREFERENCE"];

function buildHelper(projectionClient) {
  const events = [];
  const frozen = Object.freeze(SUPPRESSION_CATEGORIES.map((c) => ({ category: c, reason: "INSTANCE_PROVENANCE_UNKNOWN" })));
  const fn = new Function(
    "formalProjection", "aliveStatus", "logTts", "FORMAL_LEGACY_SUPPRESSIONS",
    sourceBlock("async function fetchFormalCognition()", "async function handleAsk(", "fetchFormalCognition") + "; return fetchFormalCognition;"
  )(
    projectionClient,
    { noteProjection: (s, e) => events.push({ note: "projection", s, e }), noteFormalDisabled: () => events.push({ note: "disabled" }) },
    (line) => events.push({ log: line }),
    frozen
  );
  return { fn, events };
}

test("main.js 冻结的抑制清单与 helper 返回类别一致（源码合同）", () => {
  const block = sourceBlock("const FORMAL_LEGACY_SUPPRESSIONS = Object.freeze(", "]);", "suppressions const");
  for (const c of SUPPRESSION_CATEGORIES) {
    assert.ok(block.includes(`category: "${c}"`), "源码抑制清单含 " + c);
  }
});

test("fetchFormalCognition：ok 路径返回 cognition + 5 类 legacy 抑制（逐类别冻结）", async () => {
  const character = { instanceId: "I-1", packageId: "sussurro", state: {}, relationship: {}, currentMemory: { revision: 7 } };
  const h = buildHelper({ fetchProjection: async () => ({ state: "ok", projection: { character } }) });
  const r = await h.fn();
  assert.equal(r.state, "ok");
  assert.equal(r.cognition, character);
  assert.deepEqual(r.suppressions.map((s) => s.category), [
    "LEGACY_BOND", "LEGACY_FACT", "LEGACY_SUMMARY", "LEGACY_VECTOR_RECALL", "EXPLICIT_USER_PREFERENCE"
  ]);
  assert.ok(h.events.some((e) => e.note === "projection" && e.s === "ok"), "ok 记账 noteProjection(ok)");
  // 返回的 suppressions 是克隆（调用方污染返回数组不得影响后续轮次）
  r.suppressions[0].category = "MUTATED";
  const r2 = await h.fn();
  assert.equal(r2.suppressions[0].category, "LEGACY_BOND", "二次调用不受上次污染");
});

test("fetchFormalCognition：失败/异常/unconstructed 全部显式返回失败态并记账，绝不返回 cognition", async () => {
  // client 未构造
  let h = buildHelper(null);
  let r = await h.fn();
  assert.equal(r.state, "unavailable");
  assert.equal(r.cognition, undefined);
  assert.ok(h.events.some((e) => e.note === "projection" && e.s === "unavailable"));
  // fetch 抛异常
  h = buildHelper({ fetchProjection: async () => { throw new Error("host down"); } });
  r = await h.fn();
  assert.equal(r.state, "unknown");
  assert.equal(r.cognition, undefined);
  // Host 返回非 ok
  h = buildHelper({ fetchProjection: async () => ({ state: "package-mismatch", error: "pkg" }) });
  r = await h.fn();
  assert.equal(r.state, "package-mismatch");
  assert.equal(r.cognition, undefined);
  // ok 但缺 character
  h = buildHelper({ fetchProjection: async () => ({ state: "ok", projection: {} }) });
  r = await h.fn();
  assert.equal(r.state, "ok"); // 注意：state 字段透传原值——但 cognition 必须缺失 ⇒ 调用方按 !cognition 处理
  assert.equal(r.cognition, undefined, "缺 character 不得产出 cognition（无静默降级）");
});

/* ---------------- 引用点封闭（单一 owner，无第二套 builder） ---------------- */

test("fetchFormalCognition 引用点恰好 2：UI handleAskInner 与 External /chat task；fetchProjection 直调仅在 helper 内", () => {
  const calls = (mainSource.match(/await fetchFormalCognition\(\)/g) || []).length;
  assert.equal(calls, 2, "两个 chat 入口共用同一 helper，got " + calls);
  // 全 main.js 中 fetchProjection() 的直接调用只出现在 helper 定义内（1294 的 projection 读取是 memory-control 检查路径，不同用途）
  const direct = [...mainSource.matchAll(/formalProjection[^\n]*fetchProjection\(\)/g)];
  assert.ok(direct.length >= 1);
  const helperBlock = sourceBlock("async function fetchFormalCognition()", "async function handleAsk(", "helper");
  // chat 两入口块内不得出现 fetchProjection 直调（必须经 helper）
  const agentBlock = sourceBlock("agentTaskQueue.enqueue(async", "if (enq.busy)", "agent task");
  const uiBlock = sourceBlock("if (wmEnabled && mode === \"chat\")", "const formalInstanceId", "ui formal block");
  assert.ok(!/fetchProjection\(\)/.test(agentBlock), "External /chat 块零 fetchProjection 直调（必须经 helper）");
  assert.ok(!/fetchProjection\(\)/.test(uiBlock), "UI formal 块零 fetchProjection 直调（必须经 helper）");
  // helper 本体恰一处 fetchProjection 直调；其余直调只允许非 chat 用途（memory-control inspect / 启动检查）
  const helperStart = mainSource.indexOf(helperBlock);
  const inHelper = direct.filter((m) => m.index >= helperStart && m.index < helperStart + helperBlock.length).length;
  assert.equal(inHelper, 1, "helper 内恰一处 fetchProjection 直调");
});

/* ---------------- External /chat 组装合同（真实代码块） ---------------- */

test("External /chat formal 组装：persona(formal)/history instance 过滤/cognition/suppressions 透传/写回带归属", () => {
  const block = sourceBlock("agentTaskQueue.enqueue(async", "} catch (e) {\n        // ownership 互斥拒绝", "agent /chat");
  assert.match(block, /const wmOn = \(\(config\.getConfig\(\)\.whitemoonRuntime \|\| \{\}\)\.enabled\) === true;/, "运行时读开关（与 UI 同口径，非请求期快照）");
  assert.match(block, /persona: buildChatPersona\(!!agentCognition\)/, "formal ⇒ 纯呈现人设（与 UI 一致）");
  assert.match(block, /_recent\.filter\(\(r\) => r\.whitemoonInstance === agentCognition\.instanceId\)/, "history instance 过滤（与 UI 同式）");
  assert.match(block, /cognition: agentCognition,\s*suppressions: agentSuppressions,/, "cognition+suppressions 进入 chatClient.chat");
  assert.match(block, /err\.code = "FORMAL_PROJECTION_UNAVAILABLE"/, "读取失败 ⇒ 显式失败（不降级、不调 provider）");
  // 写回合同（enq.done 后）：formal 行携带 instance 归属；vector 仅 legacy 模式入库
  const tail = sourceBlock("if (history.generation() === genAtAsk) {\n          if (!agentCognition", "maybeWorkflowComment", "agent writeback");
  assert.match(tail, /whitemoonInstance: agentCognition\.instanceId/, "formal 写回行带 instance 归属");
  assert.match(tail, /if \(!agentCognition && \(config\.getConfig\(\)\.features \|\| \{\}\)\.vectorMemory\)/, "formal ⇒ 不注入 legacy 向量（双重记忆抑制，与 UI 一致）");
  // 503 显式失败响应 + 不写 COGNITION 真相层
  assert.match(mainSource, /if \(e && e\.code === "FORMAL_PROJECTION_UNAVAILABLE"\) \{\s*send\(503, \{ ok: false, error: e\.message, code: e\.code, meta: \{ projectionState: e\.projectionState \|\| "unknown" \} \}\);/,
    "HTTP 503 honest failure（meta 携带 projectionState）");
});

/* ---------------- /speak 与 legacy 模式隔离 ---------------- */

test("/speak 不被 cognition 化：speak 路径零 fetchFormalCognition/cognition 引用", () => {
  const speakBlock = sourceBlock("if (url.pathname === \"/speak\")", "// ---------- M2：通用动作协议", "/speak");
  assert.ok(!/fetchFormalCognition|cognition/.test(speakBlock), "/speak 保持外部命令直显语义（§11）");
});

test("legacy 模式零变化：wmOn=false 时 External /chat 组装与基线同形（persona 无参/history 无过滤/无 cognition）", () => {
  const block = sourceBlock("agentTaskQueue.enqueue(async", "if (enq.busy)", "agent task");
  // wmOn=false ⇒ agentCognition 保持 null ⇒ buildChatPersona(!!null)=无参语义、filter 分支不启用、cognition:null
  assert.match(block, /agentCognition = null;\s*if \(wmOn\) \{/, "disabled ⇒ cognition 恒 null（零流量，legacy 逐字不变）");
  assert.match(block, /history: agentCognition\s*\?\s*_recent\.filter[^\n]*\n\s*: _recent,/, "legacy ⇒ 原始 history（无过滤）");
});

/* ---------------- P1-U2 / Chibi 不回归 ---------------- */

test("本阶段不触碰 P1-U2 policy 与 Chibi 网关：proactivePolicy 引用点仍封闭为 4", () => {
  const refs = (mainSource.match(/proactivePolicy\./g) || []).length;
  assert.equal(refs, 4, "proactivePolicy 调用点不变（sendProactive/sendScheduleDue×2/get-state）");
});
