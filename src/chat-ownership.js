"use strict";

/**
 * chat-ownership.js — 「角色进入聊天交互」的 ownership 单一权威（纯逻辑，无 I/O / 无 Electron）。
 *
 * 存在的理由：此前 chat 有多条入口（UI pet:ask、HTTP Agent API /chat、未来的 MCP/DSH/Codex…），
 * 每条各自决定要不要拿 chat pause lease。结果外部入口完全不拿 lease——角色在"正在对话"，
 * 但 locomotion 不冻结、state-core 无感知，且两个入口并发时会把彼此的 lease 互相清掉。
 *
 * 本模块是唯一对外的 canonical API：`run(exec, meta)`。
 *   Ingress 只提供 exec + meta（内容、来源、关联 id、自己的响应传输），
 *   **不决定**是否 acquire、lease 生命周期、busy owner 生命周期、state ownership。
 *
 * 三条顺序不变量（写错会泄漏或误清新 owner）：
 *   ① exit() 必须先于 conversation.finish()——反过来会让下一个 owner 醒来后
 *      被上一个 owner 的陈旧 release 误清（pause 永久泄漏）。
 *   ② 陈旧 token 的 exit() 被拒且**不动 held 槽**——否则真 owner 的 release 会变 noop。
 *   ③ 排队/缓冲期间不持有 ownership——等的是 conversation 空闲，不是 lease。
 *
 * 纯 Node 可单测；pauseWalk 语义由调用方（生产 = main.chatPauseWalk）提供。
 */

/** 等待 conversation/ownership 空出的上限：只覆盖 UI 回合"conversation 已放、lease 未放"的微任务窗口。 */
const DEFAULT_WAIT_MS = 120;
const DEFAULT_STEP_MS = 5;

function busyError(reason, detail) {
  const err = new Error("chat-busy: " + reason);
  err.code = "BUSY";
  err.reason = reason;
  if (detail) err.detail = detail;
  return err;
}

/**
 * @param {Object} deps
 *  - conversation  既有会话单写者（conversation-service 实例）。提供它即获得跨入口互斥。
 *  - pauseWalk     (boolean) => void  进入/退出 chat pause 的唯一入口。生产实现是 main.chatPauseWalk。
 *  - now           注入时钟（可测）
 *  - waitMs/stepMs 排队等待上限与步长
 */
function createChatOwnership({ conversation = null, pauseWalk, now = Date.now, waitMs = DEFAULT_WAIT_MS, stepMs = DEFAULT_STEP_MS } = {}) {
  if (typeof pauseWalk !== "function") throw new TypeError("chat-ownership: pauseWalk 必填");

  let seq = 0;
  let held = null; // { token, source, at }

  /** 当前 ownership 快照（外部只读）。 */
  function current() {
    return held === null ? null : { token: held.token, source: held.source, at: held.at };
  }
  function isHeld() { return held !== null; }

  /** 直接拿 ownership。已有 owner → 拒绝（不抢占、不改槽）。 */
  function enter(source) {
    if (held !== null) return { ok: false, reason: "already-held", owner: current() };
    seq += 1;
    held = { token: seq, source: String(source || "unknown"), at: now(), pauseHandle: pauseWalk(true) };
    return { ok: true, token: held.token, source: held.source };
  }

  /**
   * 放掉 ownership。token 与当前 owner 不符 → **拒绝且绝不清槽**：
   * 这是「旧 generation / 陈旧回调不得释放当前 owner」的唯一实现点。
   */
  function exit(token) {
    if (held === null) return { ok: false, noop: true };
    if (token === undefined || token === null) {
      return { ok: false, reason: "missing-release-token", owner: current() };
    }
    if (token !== held.token) {
      return { ok: false, reason: "stale-release", owner: current() };
    }
    const released = held.token;
    const pauseHandle = held.pauseHandle;
    held = null;
    pauseWalk(false, pauseHandle);
    return { ok: true, token: released };
  }

  /** 等到既有 owner 放掉为止（bounded）。等的是 ownership，不是 conversation。 */
  async function enterWhenFree(source) {
    const startedAt = now();
    for (;;) {
      const claim = enter(source);
      if (claim.ok) return claim;
      if (now() - startedAt >= waitMs) return claim;
      await new Promise((resolve) => setTimeout(resolve, stepMs));
    }
  }

  /**
   * canonical 入口：持有 ownership 执行 exec。
   *
   * 成功 / 抛错 / 被取消 / 调用方断线，都走同一条 finally，且顺序恒为
   * 「先 exit（放 lease）→ 后 conversation.finish（放单写者）」。
   *
   * @param {Function} exec           实际执行体（通常是 chatClient.chat）
   * @param {Object}  meta            { source, meta }——source 是入口名，仅诊断用
   * @param {AbortSignal} [meta.signal] 预取消：已取消则不进入执行
   */
  async function run(exec, meta = {}) {
    const source = meta.source || "unknown";
    if (typeof exec !== "function") throw new TypeError("chat-ownership: exec 必填");

    if (meta.signal && meta.signal.aborted) throw busyError("pre-aborted", { source });

    // ① 跨入口互斥：先跟既有会话单写者协商。拿不到就 BUSY——ingress 不自行决定排队策略。
    let task = null;
    if (conversation) {
      task = conversation.start({ kind: "chat", meta: { source } });
      if (!task.ok) throw busyError(task.code || "BUSY", { source, currentId: task.currentId });
    }

    // ② ownership lease。可能需要极短等待（UI 回合尾部：conversation 已放、lease 未放的微任务窗口）。
    const claim = await enterWhenFree(source);
    if (!claim.ok) {
      if (task) conversation.finish(task.id);
      throw busyError("ownership-busy", { source, owner: claim.owner });
    }

    // ③ 执行 + 恒定 finally。
    try {
      return await exec(claim);
    } finally {
      exit(claim.token);              // 不变量①：先放 lease
      if (task) conversation.finish(task.id);  // 不变量①：再放单写者
    }
  }

  return { run, enter, exit, enterWhenFree, current, isHeld };
}

module.exports = { createChatOwnership, busyError, DEFAULT_WAIT_MS, DEFAULT_STEP_MS };
