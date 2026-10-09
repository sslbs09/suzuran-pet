/**
 * p0-b1-request-assembly.test.js — REQUEST ASSEMBLY BOUNDARY 单测（§16/§17/§18/§20）
 * node --test 纯函数测试：builder 输入 → { messages, diagnostics }。
 *  - legacy 排版与既有 chat-client 逐位一致（T6 结构兼容）
 *  - formal 排版按 §18 冻结优先级（T1–T3、T14）
 *  - current user turn 恰好一次（T11；§20 最小修复的行为合同）
 *  - provenance 可区分（T13）；diagnostics 无凭据（T12）
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const { buildChatRequest, PRECEDENCE, stableJson } = require("../src/request-assembly");

const RULES = "【桌宠行为规则】\n- 你是 苏苏洛";
const FORMAT = "【必须遵守的输出格式】";
const COG = {
  instanceId: "sussurro-A",
  packageId: "sussurro",
  displayName: "Sussurro",
  projectionSemanticsVersion: 2,
  state: { sharedMilestones: { exam: { status: "completed", sourceExperienceId: "exp-1" } } },
  relationship: { sharedHistory: { meaningfulExperienceCount: 1, lastMeaningfulExperienceId: "exp-1" } }
};

test("legacy layout is byte-compatible with the pre-P0-B1 chat-client assembly", () => {
  const { messages } = buildChatRequest({
    personaText: "PER", rulesText: RULES, formatText: FORMAT,
    stateNote: "下午（14:00），在桌面上散步", worldBlock: "W1\n\nW2",
    vectorBlock: "【回忆片段】这些是博士之前提过的相关内容，自然回引（若有契合点）：\n- seg1",
    history: [{ role: "user", content: "h1" }, { role: "assistant", content: "a1" }],
    text: "current",
    provider: { model: "m", apiType: "openai" }
  });
  assert.deepEqual(messages, [
    { role: "system", content: "PER" + "\n\n" + RULES },
    { role: "system", content: FORMAT },
    { role: "system", content: "【此刻状态】下午（14:00），在桌面上散步\n（顺着这个状态自然回应即可）" },
    { role: "system", content: "【当前情境】\nW1\n\nW2\n（顺着情境自然地回应，不要复述本条）" },
    { role: "system", content: "【回忆片段】这些是博士之前提过的相关内容，自然回引（若有契合点）：\n- seg1" },
    { role: "user", content: "h1" },
    { role: "assistant", content: "a1" },
    { role: "user", content: "current" }
  ]);
});

test("§20 CONFIRMED: the pre-P0-B1 assembly (append-to-history then pass recent+text) duplicated the current user turn", () => {
  // 复现基线 679cb84 的真实调用顺序：UI handler 先把当前 user 文本写入 history，
  // 再把 history.recent(含该行) + 同一 text 交给旧 chat-client。旧组装无去重：
  const oldAssemble = (historyRows, text) => {
    const messages = [];
    for (const h of historyRows) messages.push({ role: h.role, content: h.content });
    messages.push({ role: "user", content: text });
    return messages;
  };
  const text = "今晚月色真美";
  const rows = [{ role: "user", content: "上一句" }, { role: "assistant", content: "回复" }, { role: "user", content: text }];
  const dup = oldAssemble(rows, text).filter((m) => m.role === "user" && m.content === text);
  assert.equal(dup.length, 2, "baseline reproduces the duplicate (bug is real, per P0-B1 inventory §2)");

  // 最小修复后：同一输入经 assembly 边界 + currentInHistory 声明 ⇒ 恰好一次
  const fixed = buildChatRequest({ personaText: "P", rulesText: RULES, formatText: FORMAT, history: rows, text, currentInHistory: true }).messages;
  assert.equal(fixed.filter((m) => m.role === "user" && m.content === text).length, 1);
});

test("T11: current user turn appears exactly once when caller pre-wrote it to history", () => {
  const hist = [{ role: "user", content: "previous" }, { role: "assistant", content: "reply" }, { role: "user", content: "current" }];
  const { messages, diagnostics } = buildChatRequest({
    personaText: "PER", rulesText: RULES, formatText: FORMAT, history: hist, text: "current", currentInHistory: true
  });
  const userMsgs = messages.filter((m) => m.role === "user");
  assert.equal(userMsgs.filter((m) => m.content === "current").length, 1);
  assert.equal(userMsgs.length, 2); // "previous" 保留（它不是当前 turn）
  assert.equal(diagnostics.currentInHistoryDeduped, true);
});

test("dedupe only removes the trailing equal user row and only when declared", () => {
  const hist = [{ role: "user", content: "current" }];
  // 未声明 pre-append（Agent /chat 路径）：不裁剪（那里尾行本就不同源）
  const a = buildChatRequest({ rulesText: RULES, formatText: FORMAT, history: hist, text: "current", currentInHistory: false });
  assert.equal(a.messages.filter((m) => m.content === "current").length, 2); // history 行 + 当前追加行
  // 尾行是 assistant：不动
  const b = buildChatRequest({ rulesText: RULES, formatText: FORMAT, history: [{ role: "assistant", content: "x" }], text: "current", currentInHistory: true });
  assert.equal(b.messages.length, 4);
  // 尾行文本不同：不动
  const c = buildChatRequest({ rulesText: RULES, formatText: FORMAT, history: [{ role: "user", content: "different" }], text: "current", currentInHistory: true });
  assert.equal(c.messages.filter((m) => m.role === "user").length, 2);
});

test("T1/T2/T3 formal layout carries all three canonical categories above every legacy block", () => {
  const { messages, diagnostics } = buildChatRequest({
    personaText: "旧版人设文本", rulesText: RULES, formatText: FORMAT,
    stateNote: "晚上（21:00）", cognition: COG, history: [], text: "hi"
  });
  assert.equal(messages[0].content, RULES); // 1. safety/pet rules（无 persona 身份断言）
  assert.equal(messages[1].content, FORMAT);
  const canonical = messages[2].content;
  assert.ok(canonical.includes("CANONICAL_IDENTITY"));
  assert.ok(canonical.includes("sussurro-A") && canonical.includes("Sussurro"));
  assert.ok(canonical.includes("CANONICAL_STATE") && canonical.includes("sharedMilestones"));
  assert.ok(canonical.includes("CANONICAL_RELATIONSHIP") && canonical.includes("meaningfulExperienceCount"));
  const personaIdx = messages.findIndex((m) => m.role === "system" && m.content.includes("旧版人设文本"));
  assert.ok(personaIdx > 2, "legacy persona must be positioned after the canonical block");
  assert.ok(messages[personaIdx].content.includes("LEGACY_PERSONA"));
  assert.ok(messages[personaIdx].content.includes("不得覆盖"));
  assert.equal(diagnostics.formal, true);
  assert.equal(diagnostics.instance, "sussurro-A");
  assert.equal(diagnostics.categories.canonicalIdentity.present, true);
  assert.equal(diagnostics.categories.canonicalState.present, true);
  assert.equal(diagnostics.categories.canonicalRelationship.present, true);
  assert.equal(diagnostics.categories.legacyPersona.present, true);
});

test("T14 canonical precedence is recorded and legacy memory categories are suppressed in formal mode", () => {
  const suppressions = [
    { category: "LEGACY_BOND", reason: "INSTANCE_PROVENANCE_UNKNOWN" },
    { category: "LEGACY_FACT", reason: "INSTANCE_PROVENANCE_UNKNOWN" },
    { category: "LEGACY_SUMMARY", reason: "INSTANCE_PROVENANCE_UNKNOWN" },
    { category: "LEGACY_VECTOR_RECALL", reason: "INSTANCE_PROVENANCE_UNKNOWN" },
    { category: "EXPLICIT_USER_PREFERENCE", reason: "INSTANCE_PROVENANCE_UNKNOWN" }
  ];
  const { messages, diagnostics } = buildChatRequest({
    personaText: "她是我的恋人，我们已婚（legacy 声明）", rulesText: RULES, formatText: FORMAT,
    cognition: COG, history: [], text: "hi", suppressions
  });
  const text = JSON.stringify(messages);
  assert.equal(diagnostics.precedence, PRECEDENCE);
  assert.equal(diagnostics.categories.legacyFacts.present, false);
  assert.equal(diagnostics.categories.legacySummary.present, false);
  assert.equal(diagnostics.categories.legacyBond.present, false);
  assert.equal(diagnostics.categories.legacyVectorRecall.present, false);
  assert.equal(diagnostics.categories.explicitUserPreferences.present, false);
  assert.deepEqual(diagnostics.suppressions, suppressions);
  assert.ok(!text.includes("【回忆片段】"));
  assert.ok(!text.includes("她今天的心情基调")); // bond 派生的 mood 基调在 formal mode 不进 prompt（OWNER MATRIX §2）
});

test("legacy diagnostics expose facts/summary/bond/manual-fact flags for audit (T13)", () => {
  const { diagnostics } = buildChatRequest({
    personaText: "PER with facts and summary and bond", rulesText: RULES, formatText: FORMAT,
    history: [{ role: "user", content: "h" }], text: "t",
    legacyFlags: { facts: true, summary: true, bond: true, manualFacts: true }
  });
  assert.equal(diagnostics.formal, false);
  assert.equal(diagnostics.categories.legacyFacts.provenance, "LEGACY_FACT");
  assert.equal(diagnostics.categories.legacyFacts.present, true);
  assert.equal(diagnostics.categories.legacySummary.present, true);
  assert.equal(diagnostics.categories.legacyBond.present, true);
  assert.equal(diagnostics.categories.explicitUserPreferences.present, true);
  assert.equal(diagnostics.categories.conversationHistory.entries, 1);
});

test("T12 diagnostics contain provider params but can never carry credentials", () => {
  const { diagnostics } = buildChatRequest({
    personaText: "PER", rulesText: RULES, formatText: FORMAT, history: [], text: "hi",
    cognition: COG,
    provider: { model: "test-model", apiType: "openai", temperature: 0.7, maxTokens: 512, stream: true }
  });
  assert.equal(diagnostics.model, "test-model");
  assert.deepEqual(Object.keys(diagnostics.providerParams).sort(), ["maxTokens", "model", "stream", "temperature"]);
  const dump = JSON.stringify(diagnostics);
  for (const banned of ["apiKey", "api_key", "Authorization", "Bearer", "token", "sk-"]) {
    assert.ok(!dump.includes(banned), "diagnostics leaked: " + banned);
  }
});

test("stableJson makes projections byte-stable across key order (T8 restart comparison)", () => {
  assert.equal(stableJson({ b: 1, a: { d: 2, c: 3 } }), stableJson({ a: { c: 3, d: 2 }, b: 1 }));
});

test("empty canonical projections are served honestly, not hidden", () => {
  const { messages, diagnostics } = buildChatRequest({
    rulesText: RULES, formatText: FORMAT,
    cognition: { ...COG, state: {}, relationship: {} }, history: [], text: "hi"
  });
  assert.equal(diagnostics.categories.canonicalState.present, true);
  assert.ok(messages[2].content.includes("（当前无正式状态条目）"));
  assert.ok(messages[2].content.includes("（当前无正式关系条目）"));
});
