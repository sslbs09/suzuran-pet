/**
 * motion-ownership.js — Shadow Slice v0.1 Motion ownership 预测（纯函数）。
 *
 * FREEZE PHASE 9：Shadow 不获得权限，只计算 who SHOULD own motion。
 * 本 slice 范围：StandUp / Move / EnterSit / external takeover；
 * 明确预测 hold / translate / anchor-update 三种动词关系。
 * Shadow 只观察 V1 实际 writer/effect（rect-write 事件的 via 标签），
 * 不拦截任何生产写入。
 */
"use strict";

const OWNERS = {
  V1_MAIN: "v1-main",
  EXTERNAL: "external",
  NONE: "none"
};

/**
 * 预测当前相位应有的 motion 所有权。
 * @param phase "stable-sit"|"stand-up"|"move"|"enter-sit"|null
 * @param ctx {takeoverKind: string|null, standBeatEnabled: boolean}
 *   takeoverKind 非空 → external 接管预测优先（drag/chat/zoom/sleep/headpat）。
 */
function predictMotionOwnership(phase, ctx = {}) {
  if (ctx.takeoverKind) {
    return {
      owner: OWNERS.EXTERNAL,
      verbs: { hold: true, translate: false, anchorUpdate: false },
      basis: "takeover:" + ctx.takeoverKind,
      allowedWriters: [] // 接管期间 V1 常规 writer 不得推进位移
    };
  }
  switch (phase) {
    case "stable-sit":
      return {
        owner: OWNERS.V1_MAIN,
        verbs: { hold: true, translate: false, anchorUpdate: true },   // 坐姿冻结位移；仅几何/能力事件触发重锚
        basis: "seated-frozen",
        allowedWriters: ["seat", "engine", "set-scale", "guard", "v2-enter-sit"]
      };
    case "stand-up":
      return {
        owner: OWNERS.V1_MAIN,
        verbs: { hold: true, translate: false, anchorUpdate: true },   // stand-beat 冻结 X，仅 Y 过渡推进
        basis: "stand-beat-y-only",
        allowedWriters: ["seat", "seat-exit-y", "engine", "set-scale", "guard", "v2-standup-y"]
      };
    case "move":
      return {
        owner: OWNERS.V1_MAIN,
        verbs: { hold: false, translate: true, anchorUpdate: true },   // walkTick 平移 + ground line 贴地
        basis: "walk-translate",
        allowedWriters: ["walkTick", "seat", "seat-exit-y", "engine", "set-scale", "guard", "v2-move"]
      };
    case "enter-sit":
      return {
        owner: OWNERS.V1_MAIN,
        verbs: { hold: true, translate: false, anchorUpdate: true },   // 下沉锚定
        basis: "seat-sink-anchor",
        allowedWriters: ["seat", "seat-exit-y", "engine", "set-scale", "guard", "v2-enter-sit"]
      };
    default:
      return {
        owner: OWNERS.NONE,
        verbs: { hold: false, translate: false, anchorUpdate: false },
        basis: "out-of-scope",
        allowedWriters: null
      };
  }
}

/**
 * 实际 writer 归类（rect-write 事件的 via/where 标签 → 动词）。
 * via 来源：walkSetPosition 的 where 参数（walkTick/walk-approach/jump-ease/cat-toy/…）+
 * 观测桥补充的 seat / seat-exit-y 标签。
 */
function classifyWriter(via) {
  const v = String(via || "");
  switch (v) {
    case "walkTick":
    case "walk-approach":
    case "cat-toy":
      return { verb: "translate", translate: true };
    case "jump-ease":
    case "jump-perch-sink":
      return { verb: "translate", translate: true };   // 缓动跳跃＝位移类写入
    case "v2-move":
      return { verb: "translate", translate: true }; // V2 locomotion 位移（cutover 后唯一 move writer）
    case "v2-standup-y":
    case "v2-enter-sit":
    case "seat":
      return { verb: "anchorUpdate", anchorUpdate: true };
    case "seat-exit-y":
      return { verb: "anchorUpdate", anchorUpdate: true };
    case "set-scale":
      return { verb: "anchorUpdate", anchorUpdate: true };
    case "outOfScreenGuard":
    case "clamp":
      return { verb: "anchorUpdate", anchorUpdate: true };
    default:
      return { verb: "unknown", translate: false, anchorUpdate: false };
  }
}

/**
 * 所有权检查（PHASE 11 RESOURCE_OWNERSHIP_DIVERGENCE / PREMATURE_MOTION 的判定核心）。
 * @param prediction predictMotionOwnership 结果
 * @param write {via, translate} 实际写入观察
 * @returns null=一致（或无法判定）| {type:"RESOURCE_OWNERSHIP_DIVERGENCE"|"PREMATURE_MOTION", reason}
 */
function ownershipViolation(prediction, write) {
  if (!prediction || !write) return null;
  const w = classifyWriter(write.via);
  if (w.verb === "unknown") return null; // 无法归类的写入不妄判
  // 位移类写入出现在 translate:false 的预测下：
  // - external 接管期 → 所有权分歧（V1 writer 越过接管者）
  // - V1 自己冻结期（stable-sit/stand-up/enter-sit）→ 过早运动
  if (w.translate && !prediction.verbs.translate) {
    if (prediction.owner === OWNERS.EXTERNAL) {
      return { type: "RESOURCE_OWNERSHIP_DIVERGENCE", reason: "translate-during-takeover:" + prediction.basis };
    }
    if (prediction.owner === OWNERS.V1_MAIN) {
      return { type: "PREMATURE_MOTION", reason: "translate-while-hold:" + prediction.basis };
    }
  }
  // writer 不在允许清单（V1 自有相位内的越权写入）
  if (prediction.owner === OWNERS.V1_MAIN && Array.isArray(prediction.allowedWriters) &&
      !prediction.allowedWriters.includes(String(write.via)) && w.verb !== "unknown") {
    return { type: "RESOURCE_OWNERSHIP_DIVERGENCE", reason: "writer-not-allowed:" + write.via + "@" + prediction.basis };
  }
  return null;
}

module.exports = { OWNERS, predictMotionOwnership, classifyWriter, ownershipViolation };
