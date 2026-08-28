/**
 * message-buffer.js — 消息生成防抖缓冲（v2.6 从 main.js 提取，纯逻辑可单测）
 * - 生成/合成中（busy）再来消息：只保留最新一条（合并窗口由调用方定时器控制）
 * - 回合结束后 take() 取走最新一条补发；主动停止 clear() 丢弃（用户要静默，不是补发）
 */
"use strict";

function createDebounceBuffer() {
  let pending = null;
  return {
    /** 覆盖式缓冲最新一条，返回被缓冲的条目 */
    push(item) { pending = item; return pending; },
    /** 取走最新一条并清空（补发后调用）；无缓冲返回 null */
    take() { const p = pending; pending = null; return p; },
    /** 主动丢弃缓冲（停止/静默） */
    clear() { pending = null; },
    has() { return pending !== null; },
    peek() { return pending; },
  };
}

module.exports = { createDebounceBuffer };