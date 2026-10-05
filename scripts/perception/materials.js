"use strict";

/*
 * materials.js — Phase 9-B 中性呈现与评分工具（researcher-only tooling）。
 *
 * 纪律：
 *   - observer 素材只出现 Instance X / Instance Y，绝不出现
 *     CONTINUITY / CONTROL / history branch / mediator 等条件信息；
 *   - ground-truth manifest 含 condition，但放在 researcher-only 目录，观察者不可见；
 *   - 所有 scoring / coding 产物强制标记 DRY-RUN / NON-DATA。
 */

const FORBIDDEN_LABELS = [
  "continuity", "control", "history:", "history branch", "historybranch",
  "ablation", "mediator", "memory on", "memory off", "记忆开", "记忆关",
  "实验组", "对照组", "条件a", "条件b"
];

/** observer 素材安全扫描：命中即拒绝发布。 */
function scanNoConditionLabels(text) {
  const lower = String(text).toLowerCase();
  const hits = FORBIDDEN_LABELS.filter((w) => lower.includes(w));
  return { clean: hits.length === 0, hits };
}

/** ground-truth manifest（researcher-only；每 replay trial 一份）。 */
function buildGroundTruthManifest(input) {
  return {
    schema: "phase9b-ground-truth-manifest/1",
    condition: input.condition,            // "continuity" | "control"（sealed 值，observer 不可见）
    instanceLabel: input.instanceLabel,    // "X" | "Y"
    snapshotId: input.snapshotId,
    restartPerformed: input.restartPerformed === true,
    targetFactPresent: input.targetFactPresent === true,
    targetFactType: input.targetFactType,
    totalOpportunities: input.totalOpportunities,
    deliveredCount: input.deliveredCount,
    historySignalCount: input.historySignalCount,
    targetPromptTimestamps: input.targetPromptTimestamps || [],
    seed: input.seed,
    decisionSchedule: input.decisionSchedule,
    randomSync: input.randomSync,          // "ok" | "BLOCKER"
    snapshotImmutableDuringReplay: input.snapshotImmutableDuringReplay === true,
    notes: input.notes || ""
  };
}

/** 中性 observer 素材：只展示 Instance X/Y 的行为序列（DRY-RUN 素材，非正式问卷）。 */
function buildObserverMaterial(instanceLabel, opportunities, uptoSlot) {
  const lines = [];
  lines.push("# 感知评估材料（DRY-RUN / NON-DATA）");
  lines.push("");
  lines.push("以下是一个桌面角色实例在若干行为机会点上的后续言行记录（受控回放）。");
  lines.push("两个实例（Instance X 与 Instance Y）来自相同的起点，请分别阅读。");
  lines.push("");
  lines.push("## Instance " + instanceLabel);
  lines.push("");
  const shown = opportunities.slice(0, uptoSlot + 1);
  for (const op of shown) {
    if (!op.delivered) {
      lines.push("- 机会 " + op.opportunityId + "：（本轮没有开口）");
    } else {
      lines.push("- 机会 " + op.opportunityId + "：");
      lines.push("  > " + String(op.prompt).replace(/\n/g, " "));
    }
  }
  lines.push("");
  lines.push("（材料结束。本材料仅用于流程演练，不是研究数据。）");
  const text = lines.join("\n");
  const scan = scanNoConditionLabels(text);
  if (!scan.clean) throw new Error("observer 素材含条件信息泄漏: " + scan.hits.join(","));
  return text;
}

/** 评分表模板（Phase 9-B 只验证流程；正式问卷包禁止在本次产出）。 */
function buildScoringSheet() {
  return [
    "# 研究者评分表（DRY-RUN / NON-DATA — 禁止写入研究数据 CSV）",
    "",
    "评分者：________________    日期：________________",
    "",
    "## 1. OPEN-ENDED",
    "两个实例的后续行为有什么不同？（自由文本，不少于 1 句）",
    "",
    "_______________________________________________",
    "",
    "## 2. FORCED CHOICE",
    "哪个实例之后的行为更像由前面的互动自然延续而来？（单选）",
    "",
    "[ ] Instance X        [ ] Instance Y",
    "",
    "## 3. CONFIDENCE（1–4）",
    "1=完全猜测  2=不太确定  3=比较确定  4=非常确定",
    "",
    "你的选择：____",
    ""
  ].join("\n");
}

/** 归因编码模板（研究者手工编码；禁止自动 LLM 编码）。 */
function buildCodingTemplate() {
  return [
    "# 归因编码模板（researcher 手工编码；DRY-RUN / NON-DATA）",
    "",
    "对每份 OPEN-ENDED 回答，按下述类别编码（可多选，但须逐条标注证据句）：",
    "",
    "1. explicit event attribution —— 回答明确提到某件具体往事被引用/延续；",
    "2. memory / previous-interaction attribution —— 回答提到“记得/之前的互动”而不指名具体事件；",
    "3. generic continuity —— 只说“感觉更连贯”，无具体归因；",
    "4. non-continuity reason —— 给出与连续性无关的解释。",
    "",
    "规则：仅当编码含 1 或 2 时，continuity attribution = yes。",
    "",
    "| 回答 | 编码 | 证据句 | continuity attribution |",
    "| --- | --- | --- | --- |",
    "| （DRY-RUN 示例行，禁止填写真实数据） | | | |",
    ""
  ].join("\n");
}

/** 从 replay 输出构建两臂 manifest 所需字段。 */
function manifestFieldsFromReplay(replay, condition, meta) {
  const signals = replay.opportunities.filter((o) => o.isHistorySignal);
  return buildGroundTruthManifest({
    condition,
    instanceLabel: replay.arm,
    snapshotId: meta.snapshotId,
    restartPerformed: meta.restartPerformed,
    targetFactPresent: replay.hasHistoryFact,
    targetFactType: meta.targetFactType,
    totalOpportunities: replay.totalOpportunities,
    deliveredCount: replay.deliveredCount,
    historySignalCount: replay.historySignalCount,
    targetPromptTimestamps: signals.map((o) => o.clockIso),
    seed: replay.seed,
    decisionSchedule: replay.decisionSchedule,
    randomSync: "ok",
    snapshotImmutableDuringReplay: meta.snapshotImmutableDuringReplay === true,
    notes: meta.notes || ""
  });
}

module.exports = {
  FORBIDDEN_LABELS,
  scanNoConditionLabels,
  buildGroundTruthManifest,
  buildObserverMaterial,
  buildScoringSheet,
  buildCodingTemplate,
  manifestFieldsFromReplay
};
