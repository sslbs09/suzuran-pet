/**
 * request-assembly.js — P0-B1 REQUEST ASSEMBLY BOUNDARY（纯 builder / 可检查 IR）
 *
 * 职责（任务 §16）：把"一轮 provider 请求的全部输入"收敛成单一可测试边界——
 * 输入 → { messages, diagnostics }。chat-client 只做序列化与发送；main 只做
 * 供给。测试可以在这里看到 model / roles / 每个 cognition 类别是否进入 /
 * provenance / provider params；diagnostics 永远不包含 apiKey、Authorization、
 * Bearer、token 值（§16 红线 + T12）。
 *
 * 两条排版（OWNER-MATRIX-v0.1 冻结）：
 *  - legacy（无 cognition）：与既有 chat-client 的 system 组装逐位兼容
 *    （persona+rules 合并块 → format → 此刻状态 → 情境 → 回忆 → history → user），
 *    仅额外做 §20 最小修复：caller 声明"当前 user 行已先写入 history"时，
 *    组装去除 history 尾部的同文重复行，current user turn 恰好一次（T11）。
 *  - formal（携带 Host Character Projection）：按 §18 冻结优先级排版
 *    1. Safety / 桌宠行为规则 + 强格式指令
 *    2–4. CANONICAL_IDENTITY / CANONICAL_STATE / CANONICAL_RELATIONSHIP（投影块）
 *    6. LEGACY_PERSONA（旧版呈现人设，标注兼容风格 + 服从条款）
 *    7. RUNTIME_CONTEXT（此刻状态 / 世界书情境）→ CONVERSATION_HISTORY → user
 *    legacy bond/facts/summary/vector/explicit prefs 不在此排版中：它们无
 *    instance 归属，formal mode 抑制（§23），由 main 通过 suppressions 记录。
 */
"use strict";

/** §17 冻结的 provenance 类别（内部标签，不是公共 API）。 */
const PROVENANCE = Object.freeze({
  SAFETY_RULES: "SAFETY_RULES",
  CANONICAL_IDENTITY: "CANONICAL_IDENTITY",
  CANONICAL_STATE: "CANONICAL_STATE",
  CANONICAL_RELATIONSHIP: "CANONICAL_RELATIONSHIP",
  EXPLICIT_USER_PREFERENCE: "EXPLICIT_USER_PREFERENCE",
  LEGACY_PERSONA: "LEGACY_PERSONA",
  LEGACY_FACT: "LEGACY_FACT",
  LEGACY_SUMMARY: "LEGACY_SUMMARY",
  LEGACY_VECTOR_RECALL: "LEGACY_VECTOR_RECALL",
  CONVERSATION_HISTORY: "CONVERSATION_HISTORY",
  RUNTIME_CONTEXT: "RUNTIME_CONTEXT"
});

/** §18 冻结的最小 cognition precedence（记录在 diagnostics，供审计）。 */
const PRECEDENCE = Object.freeze([
  "safety/system execution constraints",
  "canonical character identity",
  "canonical character state",
  "canonical relationship",
  "explicit user preferences",
  "legacy compatibility persona/memory",
  "conversation history / recall context"
]);

/** 确定性 JSON（key 排序）：同一投影字节稳定，restart/对比测试可用。 */
function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableJson(value[k])).join(",") + "}";
}

function hasEntries(obj) {
  return obj && typeof obj === "object" && Object.keys(obj).length > 0;
}

/** formal 投影块：三小节各带 provenance 标记。空投影是诚实的"当前无条目"，
 *  类别仍算 present（canonical truth 已接入），不伪造不隐藏。 */
function buildCanonicalBlock(cog) {
  const lines = [];
  lines.push("【正式 Character 投影（WhiteMoon Core · 最高优先）】");
  lines.push("以下内容为该 Character Instance 的正式（canonical）事实。若与其后的旧版人设/兼容文本冲突，一律以本节为准；旧版文本仅作风格参考，不得覆盖本节内容。");
  lines.push("");
  lines.push("◆ CANONICAL_IDENTITY（身份 · 唯一正式身份来源）");
  lines.push("instance: " + cog.instanceId);
  lines.push("package: " + cog.packageId + " (" + (cog.displayName || cog.packageId) + ")");
  lines.push("projectionSemanticsVersion: " + cog.projectionSemanticsVersion);
  lines.push("");
  lines.push("◆ CANONICAL_STATE（角色状态投影）");
  lines.push(hasEntries(cog.state) ? stableJson(cog.state) : "（当前无正式状态条目）");
  lines.push("");
  lines.push("◆ CANONICAL_RELATIONSHIP（正式关系投影 · 非旧版 bond 分值）");
  lines.push(hasEntries(cog.relationship) ? stableJson(cog.relationship) : "（当前无正式关系条目）");
  if (cog.currentMemory) {
    lines.push("");
    lines.push("◆ CANONICAL_CURRENT_MEMORY（当前有效经历 / 用户纠正）");
    lines.push("仅以下记录当前有效。用户纠正是当前的用户声明，不代表旧事件发生过；它覆盖被纠正的内容。没有列出的旧记录不得当成当前事实。");
    for (const entry of cog.currentMemory.entries || []) lines.push(entry.id + " · " + entry.type + "：" + entry.summary);
    if (!(cog.currentMemory.entries || []).length) lines.push("（当前无有效经历内容）");
  }
  return lines.join("\n");
}

/** §20 最小修复：caller 声明 UI 入口已把当前文本先写入 history 时，
 *  去除 history 尾部与当前文本重复的 user 行（仅尾行、仅等值），
 *  保证 current user turn 在最终 provider messages 中恰好出现一次。
 *  不改写持久层：只影响本次组装。 */
function dedupeCurrent(history, text, currentInHistory) {
  if (!currentInHistory || !Array.isArray(history) || history.length === 0) return history;
  const last = history[history.length - 1];
  if (last && last.role === "user" && String(last.content) === String(text)) {
    return history.slice(0, -1);
  }
  return history;
}

/**
 * @param {object} opts
 *  - personaText   已 fillTokens 的 legacy persona（可空）
 *  - rulesText     已 fillTokens 的桌宠行为规则
 *  - formatText    强格式指令
 *  - stateNote     「此刻状态」注（Body 本地运行时上下文，可空）
 *  - worldBlock    世界书命中块（可空）
 *  - vectorBlock   向量回忆块（可空；formal mode 由 caller 置空）
 *  - cognition     Host 投影 { instanceId, packageId, displayName, projectionSemanticsVersion, state, relationship }；null=legacy 排版
 *  - history       recent("chat") 行（formal mode 由 caller 按 instance 过滤后传入）
 *  - text          当前用户消息
 *  - currentInHistory  caller 声明当前文本已先写入 history（UI 入口 true；§20 去重条件）
 *  - legacyFlags   { facts, manualFacts, summary, bond } 布尔（diagnostics 用）
 *  - suppressions  [{ category, reason }] formal mode 抑制记录（main 供给）
 *  - provider      { model, apiType, temperature, maxTokens, stream } 仅参数形状，无凭据
 * @returns {{messages: Array, diagnostics: object}}
 */
function buildChatRequest(opts) {
  const {
    personaText = "", rulesText = "", formatText = "",
    stateNote = "", worldBlock = "", vectorBlock = "",
    cognition = null, history = [], text, currentInHistory = false,
    legacyFlags = {}, suppressions = [], provider = {}
  } = opts || {};

  const messages = [];
  const formal = !!cognition;

  if (formal) {
    // §18：safety 层先在场，但不携带 legacy persona 的身份断言。
    messages.push({ role: "system", content: rulesText });
    messages.push({ role: "system", content: formatText });
    messages.push({ role: "system", content: buildCanonicalBlock(cognition) });
    if (personaText) {
      messages.push({
        role: "system",
        content: "【旧版呈现人设 · 兼容风格（LEGACY_PERSONA）】以下 persona 仅作呈现风格参考，" +
          "优先级低于上方正式 Character 投影，不得覆盖其中的身份/状态/关系事实：\n" + personaText
      });
    }
  } else {
    // 与既有 buildSystemMessage 逐位一致：persona 为空也保留 "\n\n" 拼接。
    messages.push({ role: "system", content: personaText + "\n\n" + rulesText });
    messages.push({ role: "system", content: formatText });
  }
  if (stateNote) messages.push({ role: "system", content: "【此刻状态】" + stateNote + "\n（顺着这个状态自然回应即可）" });
  if (worldBlock) messages.push({ role: "system", content: "【当前情境】\n" + worldBlock + "\n（顺着情境自然地回应，不要复述本条）" });
  if (vectorBlock) messages.push({ role: "system", content: vectorBlock });

  const revision = formal && cognition.currentMemory ? cognition.currentMemory.revision : 0;
  const eligibleHistory = revision > 0
    ? history.filter((row) => (row.whitemoonMemoryRevision || 0) >= revision)
    : history;
  const hist = dedupeCurrent(eligibleHistory, text, currentInHistory);
  for (const h of hist) messages.push({ role: h.role, content: h.content });
  messages.push({ role: "user", content: text });

  const countRole = (r) => messages.filter((m) => m.role === r).length;
  const diagCategory = (present, provenance, extra = {}) => Object.assign(
    { present: !!present, provenance },
    present ? {} : { presentEvidence: false },
    extra
  );

  const diagnostics = {
    formal,
    instance: formal ? cognition.instanceId : null,
    model: provider.model || "",
    apiType: provider.apiType || "openai",
    roles: { system: countRole("system"), user: countRole("user"), assistant: countRole("assistant") },
    categories: {
      safetyRules: diagCategory(!!rulesText, PROVENANCE.SAFETY_RULES),
      canonicalIdentity: diagCategory(formal, PROVENANCE.CANONICAL_IDENTITY),
      canonicalState: diagCategory(formal, PROVENANCE.CANONICAL_STATE),
      canonicalRelationship: diagCategory(formal, PROVENANCE.CANONICAL_RELATIONSHIP),
      explicitUserPreferences: formal
        ? { present: false, provenance: PROVENANCE.EXPLICIT_USER_PREFERENCE, suppressionReason: "INSTANCE_PROVENANCE_UNKNOWN" }
        : diagCategory(!!legacyFlags.manualFacts, PROVENANCE.EXPLICIT_USER_PREFERENCE),
      legacyPersona: diagCategory(!formal && !!personaText || formal && !!personaText, PROVENANCE.LEGACY_PERSONA),
      legacyFacts: formal
        ? { present: false, provenance: PROVENANCE.LEGACY_FACT, suppressionReason: "INSTANCE_PROVENANCE_UNKNOWN" }
        : diagCategory(!!legacyFlags.facts, PROVENANCE.LEGACY_FACT),
      legacySummary: formal
        ? { present: false, provenance: PROVENANCE.LEGACY_SUMMARY, suppressionReason: "INSTANCE_PROVENANCE_UNKNOWN" }
        : diagCategory(!!legacyFlags.summary, PROVENANCE.LEGACY_SUMMARY),
      legacyBond: formal
        ? { present: false, provenance: PROVENANCE.LEGACY_FACT, suppressionReason: "INSTANCE_PROVENANCE_UNKNOWN_NOT_FORMAL_RELATIONSHIP" }
        : diagCategory(!!legacyFlags.bond, PROVENANCE.LEGACY_FACT),
      legacyVectorRecall: formal
        ? { present: false, provenance: PROVENANCE.LEGACY_VECTOR_RECALL, suppressionReason: "INSTANCE_PROVENANCE_UNKNOWN" }
        : diagCategory(!!vectorBlock, PROVENANCE.LEGACY_VECTOR_RECALL),
      conversationHistory: diagCategory(hist.length > 0, PROVENANCE.CONVERSATION_HISTORY, { entries: hist.length }),
      runtimeContext: diagCategory(!!(stateNote || worldBlock), PROVENANCE.RUNTIME_CONTEXT)
    },
    currentInHistoryDeduped: hist.length !== (Array.isArray(history) ? history.length : 0),
    suppressions: formal ? suppressions : [],
    precedence: PRECEDENCE,
    providerParams: {
      model: provider.model || "",
      temperature: provider.temperature,
      maxTokens: provider.maxTokens,
      stream: provider.stream !== false
    }
    // 红线（§16/T12）：此处不出现 apiKey / Authorization / Bearer / token / baseUrl 之外
    // 的任何凭据字段；builder 从未接收它们，结构上不可能泄露。
  };
  return { messages, diagnostics };
}

module.exports = { buildChatRequest, PROVENANCE, PRECEDENCE, stableJson };
