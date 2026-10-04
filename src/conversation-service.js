"use strict";

/**
 * conversation-service.js — 会话单写者服务（TD-4，2026-09-03 抽取）
 * 统一此前散落在 main.js 的多套会话状态（GUI 聊天 activeReq / regenerate 游离 / Agent 队列）：
 *  1. 单写者：同一时刻只允许一个"生成中"会话任务（聊天/重新生成共用；Agent 批量任务
 *     仍走 task-queue 批处理——那是并发 by design，作为舱壁与单写者并存）；
 *  2. 统一 task ID/生命周期：start → running → finish/cancel，AbortController 随任务下发；
 *  3. 统一取消与错误码：cancelCurrent 一次取消当前任务；classifyError 把异常归类为
 *     统一 code，渲染层 pet:error 自带 code 字段。
 * Phase 5-C：错误码词表与分类统一由 src/error-facts.js 提供（单一事实来源）；
 * 本模块的 classifyError 保留为兼容入口——旧的无 code Error 仍按历史文案兜底，
 * 但新抛点应直接产出 ErrorWithCode，不再依赖解析 message 文本。
 * 纯 Node 可单测；Electron 无关——sender 等运行时对象经 meta 不透明字段携带。
 */
const { randomUUID } = require("crypto");
const errorFacts = require("./error-facts");

/** 统一错误码（直接复用 error-facts 的 11 码词表，杜绝两处词表漂移） */
const ERROR_CODES = errorFacts.ERROR_CODES;

/** 把各类异常归类为统一错误码（渲染层据此做差异化提示，不再解析 message 文本）。
 *  事实优先（code / errno / status），仅在旧的无 code Error 上回落到历史文案兼容。 */
function classifyError(err) {
  return errorFacts.classifyError(err);
}

function createConversationService({ now = Date.now, taskId = () => randomUUID() } = {}) {
  let current = null; // { id, kind, meta, startedAt, controller, cancelled }

  function isCurrent(id) {
    return !!current && current.id === id && !current.cancelled;
  }

  /** 启动一个会话任务；已有任务在跑 → {ok:false, code:BUSY}（单写者保证） */
  function start({ kind = "chat", meta = null, id = taskId() } = {}) {
    if (current) return { ok: false, code: ERROR_CODES.BUSY, currentId: current.id };
    const controller = new AbortController();
    current = { id, kind, meta, startedAt: now(), controller, cancelled: false };
    return {
      ok: true,
      id,
      kind,
      controller,
      signal: controller.signal,
      isCurrent: () => isCurrent(id)
    };
  }

  /** 取消当前任务（可指定 id 校验）；取消后 abort 生效、isCurrent 变 false */
  function cancel(id) {
    if (!current) return false;
    if (id && current.id !== id) return false;
    current.cancelled = true;
    try { current.controller.abort(); } catch { /* 已 abort */ }
    return true;
  }

  /** 任务收尾（finally 里调用）：仅当 id 匹配当前任务才清空，防误清新任务 */
  function finish(id) {
    if (current && (!id || current.id === id)) current = null;
  }

  function snapshot() {
    return current
      ? { id: current.id, kind: current.kind, meta: current.meta, startedAt: current.startedAt, cancelled: current.cancelled }
      : null;
  }

  return {
    ERROR_CODES,
    isBusy: () => !!current,
    canStart: () => !current,
    start,
    isCurrent,
    cancel,
    cancelCurrent: () => cancel(),
    finish,
    snapshot
  };
}

module.exports = { createConversationService, classifyError, ERROR_CODES };
