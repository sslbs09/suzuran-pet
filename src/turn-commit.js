/**
 * turn-commit.js — P0-B2 COGNITION TURN COMMIT BOUNDARY（§12/§13/§14）
 *
 * 冻结语义：
 *   PROVIDER SUCCESS 才允许提交成功语义的持久化 mutation（assistant history、
 *   user history、bond 成功增量、auto facts、vector 条目、success-derived summary）。
 *   PROVIDER FAILURE / CANCELLED / LATE RESULT AFTER CANCEL ⇒ 一次都不提交。
 *
 * 这是一个刻意最小的 staged-effect 对象，不是通用事务引擎：
 *   stage(name, effect)   把「本轮成功才应发生的持久化 mutation」登记进边界；
 *   commit()              通过全部栅栏（ownership 栅栏 isCurrent + 清史代次栅栏
 *                         generationValid）后恰好执行一次全部 effect；
 *   discard(reason)       显式丢弃（迟到结果被 fence 时留下可审计记录）。
 *
 * 边界本身不 import 任何存储——它只拥有栅栏判定与「恰好一次」纪律，
 * mutation 本体仍由既有模块（history/bond/memory/vector）的 API 执行（§14）。
 */
"use strict";

/**
 * @param {object} opts
 *  - isCurrent       () => boolean   现有 chat ownership 栅栏（conversation task / §18/§20：
 *                                    不得新建第二套 ownership，这里复用调用方传入的判定）
 *  - generationValid () => boolean   F-03 清史代次栅栏（复用现有 history.generation() 语义）
 *  - log             (msg) => void   可审计旁路（失败不影响判定）
 */
function createTurnCommitBoundary({ isCurrent, generationValid, log = () => {} } = {}) {
  if (typeof isCurrent !== "function") throw new TypeError("turn-commit: isCurrent is required");
  if (typeof generationValid !== "function") throw new TypeError("turn-commit: generationValid is required");
  const effects = [];
  let settled = null; // { committed: boolean, reason: string, count: number } —— 终局只能有一个

  function stage(name, effect) {
    if (settled) throw new Error("turn-commit: cannot stage after settle (" + settled.reason + ")");
    if (typeof name !== "string" || !name) throw new TypeError("turn-commit: stage requires a name");
    if (typeof effect !== "function") throw new TypeError("turn-commit: stage requires an effect function");
    effects.push({ name, effect });
    return effects.length;
  }

  /**
   * 提交本轮成功语义。返回值：
   *   { committed: true,  reason: "success", count }            —— 全部栅栏通过，effect 恰好执行一次
   *   { committed: false, reason: "cancelled", count: 0 }        —— ownership 已失效（cancel / 迟到结果）
   *   { committed: false, reason: "stale-generation", count: 0 } —— 期间发生过 clear-history（§F-03 一致性：
   *        本轮成功 observation 仍是真的（cognition 可标 AVAILABLE），但其持久化行不得复活清前对话）
   */
  function commit() {
    if (settled) return settled;
    if (!isCurrent()) {
      settled = { committed: false, reason: "cancelled", count: 0, dropped: effects.map((e) => e.name) };
      try { log("turn-commit fenced late result: cancelled, dropped=[" + settled.dropped.join(",") + "]"); } catch { /* 旁路 */ }
      return settled;
    }
    if (!generationValid()) {
      settled = { committed: false, reason: "stale-generation", count: 0, dropped: effects.map((e) => e.name) };
      try { log("turn-commit fenced persistence: stale-generation, dropped=[" + settled.dropped.join(",") + "]"); } catch { /* 旁路 */ }
      return settled;
    }
    // 单个持久化 effect 失败（磁盘满等）不回滚其余——与既有各模块 try/catch 语义一致；
    // 但边界仍形成唯一终局，绝不因重试而二次执行已提交的 effect（「最多一次」纪律）。
    const failed = [];
    for (const e of effects) {
      try { e.effect(); } catch (err) { failed.push(e.name); try { log("turn-commit effect failed: " + e.name + " — " + String((err && err.message) || err)); } catch { /* 旁路 */ } }
    }
    settled = { committed: true, reason: "success", count: effects.length, failed };
    try { log("turn-commit committed " + (effects.length - failed.length) + "/" + effects.length + " effects"); } catch { /* 旁路 */ }
    return settled;
  }

  /** 显式丢弃（provider 失败 / abort 路径）：不执行任何 effect，但同样形成唯一终局。 */
  function discard(reason) {
    if (settled) return settled;
    settled = { committed: false, reason: String(reason || "discarded"), count: 0, dropped: effects.map((e) => e.name) };
    try { log("turn-commit discarded: " + settled.reason + " [" + settled.dropped.join(",") + "]"); } catch { /* 旁路 */ }
    return settled;
  }

  return { stage, commit, discard, pendingCount: () => effects.length, settlement: () => settled };
}

module.exports = { createTurnCommitBoundary };
