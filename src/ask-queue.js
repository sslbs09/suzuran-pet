/**
 * ask-queue.js — /chat 串行化并发锁（v2.6 从 main.js 提取，纯逻辑可单测）
 * - 并发请求依次执行：历史不乱序、不多花 API 费
 * - 队列深度超限返回 busy：HTTP 层据此 429 兜底（防并发轰炸拖垮服务）
 * - 任务失败不断链：吞掉错误继续后续排队任务
 */
"use strict";

function createAskQueue(maxSize) {
  const limit = Number.isFinite(maxSize) && maxSize > 0 ? Math.floor(maxSize) : 3;
  let chain = Promise.resolve();
  let queued = 0;
  return {
    /** 入队执行。队列满返回 { busy:true }；否则 { busy:false, done }（done 含任务返回值或抛出） */
    enqueue(run) {
      if (queued >= limit) return { busy: true };
      queued++;
      const done = chain.then(() => run());
      chain = done.then(() => undefined, () => undefined); // 失败不断链
      done.finally(() => { queued--; }).catch(() => { /* 已由调用方处理 */ });
      return { busy: false, done };
    },
    /** 排队中（含执行中）的任务数 */
    size() { return queued; },
  };
}

module.exports = { createAskQueue };