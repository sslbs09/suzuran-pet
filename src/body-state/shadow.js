"use strict";

/**
 * body-state/shadow.js — BodyStateAuthority 影子比对器（ADR-009 migration 第 1 步：M1）。
 *
 * 目的：在**不改变任何行为**的前提下，取得 BodyState 模型与 legacy 真值之间的分歧证据，
 * 为 M2（逐函数切换）提供退出条件。
 *
 * 硬性约束：
 *   · gate 默认 OFF；OFF 时 observe() 首行短路，零构造、零闭包、零计数
 *   · 只读：从不写 legacy walk、从不触碰 renderer、从不获得 position authority
 *   · 有界台账（FIFO），不无限增长
 *   · **fail-open**：任何异常都不得影响 production（永不 throw）
 *   · 不推导 resting → posture（resting 是策略/动画轴，ADR-009 明确排除）
 *   · capability 未知时**只标记不裁决**，绝不默认 canSit=true/false 制造假分歧
 *   · 只存本机诊断，**不上传任何网络**，不记录对话内容
 *
 * 未接入生产切换路径：M1 仅在 walkBroadcast 旁挂一个 gated、只读、fail-open 的观察点。
 */

const { SUPPORT_KINDS, BODY_POSTURES } = require("./index");

/** 能力未知的显式标记——沿用 main.js:3364 的 "UNKNOWN" 约定，绝不用默认值猜测。 */
const CAPABILITY_UNKNOWN = "UNKNOWN";

const SUPPORT_FOR_SEATED = "taskbar";
const SUPPORT_FOR_PERCHED = "window-top";
const SUPPORT_FOR_PERCHED_ICON = "icon";
const SUPPORT_FOR_NONE = "none";

/** 覆盖信号：posture/support 取值集合是闭合且极小的，用固定计数器即可，无需新系统。 */
function emptyCoverage() {
  return {
    postures: {},
    supports: {},
    capability: { "can-sit": 0, "cannot-sit": 0, unknown: 0 },
    capabilityUnknownSkips: 0
  };
}

/**
 * 覆盖计数：只接受闭合枚举内的取值（因此天然有界，不会被脏输入撑大），
 * 键的存在即"观测到过"，值即次数。
 */
function bump(map, key, allowed) {
  if (allowed.indexOf(key) === -1) return;
  map[key] = (map[key] || 0) + 1;
}

/**
 * 纯函数投影：legacy walk 形状 → BodyState 应有的姿态与支撑。
 * **只读输入，不产生副作用；不使用 capability**（legacy 真值直接给出姿态）。
 */
function projectLegacyWalk(walk) {
  const w = walk && typeof walk === "object" ? walk : {};
  const perched = w.perched === true || w.iconRest === true;
  if (perched) {
    const kind = w.iconTarget === true || w.iconRest === true ? SUPPORT_FOR_PERCHED_ICON : SUPPORT_FOR_PERCHED;
    return { posture: "perched", support: kind };
  }
  if (w.seated === true) return { posture: "seated", support: SUPPORT_FOR_SEATED };
  return { posture: "standing", support: SUPPORT_FOR_NONE };
}

/** 把 authority snapshot 压成扁平 {posture, support}——snapshot.posture 是对象，直接比较会恒误报。 */
function flattenSnapshot(snapshot) {
  const s = snapshot || {};
  const posture = s.posture && typeof s.posture === "object" ? s.posture.value : s.posture;
  const support = s.support && typeof s.support === "object" ? s.support.kind : s.support;
  return { posture: posture === undefined ? "unknown" : posture, support: support === undefined ? "unknown" : support };
}

/** capability 归一化：只接受布尔或显式 UNKNOWN；其他一律 UNKNOWN，绝不猜测。 */
function normalizeCapability(raw) {
  if (raw === true || raw === false) return raw;
  return CAPABILITY_UNKNOWN;
}

/**
 * @param {Object} deps
 *  - bodyState      BodyStateAuthority 实例。**可为 null**——M1 阶段生产 authority 尚未被驱动，
 *                   此时只做「能力裁决 + 覆盖统计」，不做姿态比对（见 observe 注释）。
 *  - enabled        gate，默认 false
 *  - ledgerMax      台账上限，默认 16
 */
function createBodyStateShadow({ bodyState = null, enabled = false, ledgerMax = 16, now = Date.now, log = null, reportEveryMs = 300000 } = {}) {
  if (typeof ledgerMax !== "number" || ledgerMax < 1) throw new TypeError("body-state/shadow: ledgerMax 必须是 >=1 的数字");
  const ledger = [];
  const coverage = emptyCoverage();
  let observations = 0;
  let divergences = 0;
  let lastReportAt = null;

  /**
   * 限速摘要输出（真机观测用）。沿用 runtime-shadow 的 `[TAG] {json}` 日志惯例，
   * **不逐次记录**——避免观测本身成为日志噪音源。gate OFF 时永不触发。
   */
  function maybeReport() {
    if (!enabled || typeof log !== "function") return;
    const t = now();
    if (lastReportAt !== null && t - lastReportAt < reportEveryMs) return;
    lastReportAt = t;
    try {
      log("bodyshadow", JSON.stringify(diagnostics()));
    } catch { /* 日志不可用不得影响 runtime */ }
  }

  /** 完整诊断快照：只含本机 runtime 数据，无任何对话内容。 */
  function diagnostics() {
    const s = this.snapshot();
    return {
      gate: "SUSSURRO_BODYSTATE_SHADOW",
      comparesAuthority: s.comparesAuthority,
      observations: s.observations,
      divergences: s.divergences,
      recentDivergences: s.ledger.slice(-5),
      coverage: s.coverage,
      coverageSummary: this.coverageSummary()
    };
  }

  return {
    isEnabled() { return enabled === true; },

    /** 是否已接入 authority 比对（M2 之前为 false）。 */
    comparesAgainstAuthority() { return enabled === true && bodyState !== null; },

    projectLegacyWalk,

    /**
     * 观察一次 legacy walk 快照。gate OFF 或脏输入 → 立即返回 null。
     *
     * 两类裁决：
     *   ① capability 裁决——legacy 声称的物理姿态是否在该身体能力下可达成。
     *      capability 未知时**只标记不裁决**（capabilityUnknownSkips++）。
     *   ② 姿态/支撑比对——仅当接入了 authority 才做；未接入时跳过（否则恒分歧，无信息量）。
     */
    observe(walk, meta) {
      if (!this.isEnabled()) return null;
      if (!walk || typeof walk !== "object") return null; // 脏输入忽略，不污染退出条件信号
      try {
        const expected = projectLegacyWalk(walk);
        const capability = normalizeCapability(meta && meta.capability);
        observations += 1;
        bump(coverage.postures, expected.posture, BODY_POSTURES);
        bump(coverage.supports, expected.support, SUPPORT_KINDS);
        if (capability === true) coverage.capability["can-sit"] += 1;
        else if (capability === false) coverage.capability["cannot-sit"] += 1;
        else coverage.capability.unknown += 1;

        const fields = [];
        // ① capability 裁决：身体坐不了却声称 seated，是真实不一致。
        let capabilityViolation = null;
        if (capability === CAPABILITY_UNKNOWN) {
          coverage.capabilityUnknownSkips += 1; // 不猜、不裁决
        } else if (expected.posture === "seated" && capability === false) {
          fields.push("capability");
          capabilityViolation = "body-cannot-sit-but-legacy-seated";
        }

        // ② 姿态/支撑比对：仅在 authority 已接入时进行。
        let actual = null;
        if (this.comparesAgainstAuthority()) {
          actual = flattenSnapshot(bodyState.snapshot());
          if (expected.posture !== actual.posture) fields.push("posture");
          if (expected.support !== actual.support) fields.push("support");
        }

        if (fields.length === 0) { maybeReport(); return null; }

        divergences += 1;
        const entry = {
          fields: fields.slice(),
          expected: expected,
          actual: actual,
          capability: capability,
          capabilityViolation: capabilityViolation,
          at: meta && meta.now !== undefined ? meta.now : now(),
          reason: (meta && meta.reason) || null
        };
        ledger.push(entry);
        if (ledger.length > ledgerMax) ledger.shift();
        maybeReport();
        return entry;
      } catch {
        return null; // fail-open：影子永不外抛
      }
    },

    snapshot() {
      return {
        enabled: this.isEnabled(),
        comparesAuthority: this.comparesAgainstAuthority(),
        observations: observations,
        divergences: divergences,
        coverage: {
          postures: Object.assign({}, coverage.postures),
          supports: Object.assign({}, coverage.supports),
          capability: Object.assign({}, coverage.capability),
          capabilityUnknownSkips: coverage.capabilityUnknownSkips
        },
        ledger: ledger.map((e) => Object.assign({}, e)),
        ledgerMax: ledgerMax
      };
    },

    /** 完整诊断快照（真机观测导出用）：只含本机 runtime 数据，无任何对话内容。 */
    diagnostics,

    /**
     * 「0 分歧、1000 次、多状态覆盖」区分开——两者不得等价。
     */
    coverageSummary() {
      const postures = Object.keys(coverage.postures);
      const supports = Object.keys(coverage.supports);
      return {
        postureStates: postures.slice(),
        supportKinds: supports.slice(),
        distinctPostures: postures.length,
        distinctSupports: supports.length,
        observations: observations,
        /** true 表示覆盖不足：观察次数少或姿态覆盖不全，不足以作为 M2 退出条件。 */
        insufficientCoverage: observations < 50 || postures.length < 2
      };
    },

    hasDivergence() { return divergences > 0; }
  };
}

module.exports = {
  createBodyStateShadow,
  projectLegacyWalk,
  CAPABILITY_UNKNOWN,
  BODY_POSTURES,
  SUPPORT_KINDS
};