"use strict";

/**
 * body-state/shadow.js — BodyStateAuthority 的影子比对器（ADR-009 migration rule 第 1 步）。
 *
 * 目的：在**不改变任何行为**的前提下，先取得「BodyStateAuthority 推导结果 vs legacy walk
 * 当前真值」的分歧证据，为后续逐函数迁移提供退出条件。
 *
 * 约束（全部硬性）：
 *   · gate 默认 OFF；OFF 时 observe() 首行短路，零构造、零闭包
 *   · 只读：从不写 legacy walk、从不触碰 renderer、从不获得 position authority
 *   · 有界台账（默认 16 条，FIFO 淘汰），不无限增长
 *   · 异常绝不外抛（影子观测不得影响生产路径）
 *   · 不推导 resting → posture（resting 是策略/动画轴，见 ADR-009 明确排除）
 *
 * 本模块**未接入 main.js**：迁移第 1 步只交付 observer + 单测，接线属后续阶段。
 */

const { SUPPORT_KINDS } = require("./index");

/** 与 posture-support.js 同源的领域知识：坐下 = 任务栏支撑。 */
const SUPPORT_FOR_SEATED = "taskbar";
/** 窗顶 / 图标两栖坐下。 */
const SUPPORT_FOR_PERCHED = "window-top";
const SUPPORT_FOR_PERCHED_ICON = "icon";
const SUPPORT_FOR_NONE = "none";

/**
 * 纯函数投影：legacy walk 形状 → BodyStateAuthority 应有的姿态与支撑。
 * **只读输入，不产生副作用。**
 *
 * @param {Object} walk  legacy walk 对象（只需 posture 相关字段可读）
 * @returns {{posture: string, support: string}} expected read model
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

/** 比对单个维度，返回不一致字段名数组。入参必须是**扁平**形态。 */
function diffExpected(expected, flatActual) {
  const out = [];
  const a = flatActual || {};
  if (expected.posture !== a.posture) out.push("posture");
  if (expected.support !== a.support) out.push("support");
  return out;
}

/** 把 authority snapshot 压成扁平的 {posture, support}——snapshot.posture 是对象，直接比较会恒误报。 */
function flattenSnapshot(snapshot) {
  const s = snapshot || {};
  const posture = s.posture && typeof s.posture === "object" ? s.posture.value : s.posture;
  const support = s.support && typeof s.support === "object" ? s.support.kind : s.support;
  return { posture: posture === undefined ? "unknown" : posture, support: support === undefined ? "unknown" : support };
}

function createBodyStateShadow({ bodyState = null, enabled = false, ledgerMax = 16, now = Date.now } = {}) {
  if (typeof ledgerMax !== "number" || ledgerMax < 1) throw new TypeError("body-state/shadow: ledgerMax 必须是 >=1 的数字");
  const ledger = [];
  let observations = 0;
  let divergences = 0;

  return {
    /** gate OFF 时首行短路：零构造、零比较、零记录。 */
    isEnabled() { return enabled === true && bodyState !== null; },

    projectLegacyWalk,

    /**
     * 观察一次 legacy walk 快照。gate OFF → 立即返回 null。
     * 绝不 throw：影子观测失败不得影响生产路径。
     */
    observe(walk, meta) {
      if (!this.isEnabled()) return null;
      // 脏输入直接忽略：把 null/非对象投影成 standing 会**污染迁移退出条件的分歧信号**。
      if (!walk || typeof walk !== "object") return null;
      try {
        // 投影先于计数：投影失败即视为「未观测」，不得污染退出条件的统计口径。
        const expected = projectLegacyWalk(walk);
        observations += 1;
        const actual = flattenSnapshot(bodyState.snapshot());
        const fields = diffExpected(expected, actual);
        if (fields.length === 0) return null;
        divergences += 1;
        const entry = {
          fields: fields.slice(),
          expected: expected,
          actual: actual,
          at: meta && meta.now !== undefined ? meta.now : now(),
          reason: (meta && meta.reason) || null
        };
        ledger.push(entry);
        if (ledger.length > ledgerMax) ledger.shift();
        return entry;
      } catch {
        return null; // 影子永不外抛
      }
    },

    snapshot() {
      return {
        enabled: this.isEnabled(),
        observations: observations,
        divergences: divergences,
        ledger: ledger.slice(),
        ledgerMax: ledgerMax
      };
    },

    /** 供测试与迁移检查使用：有分歧即视为尚不可进入下一迁移阶段。 */
    hasDivergence() { return divergences > 0; }
  };
}

module.exports = {
  createBodyStateShadow,
  projectLegacyWalk,
  SUPPORT_KINDS
};