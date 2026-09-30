/**
 * drag-session.js — 一次真实 Drag 的 identity 与 ownership 交接（纯模块，无 I/O）。
 *
 * 不是第二套 authority（复用 MotionAuthority 的 EXTERNAL_DRAG），也不是 drag commit manager
 * （位移写入走 window-commit.commitExternal）。本模块只保存「这次拖拽是谁、何时开始、占用了哪个
 * ownership token、起始 rect、属于哪个 renderer 文档纪元」，并把 begin/move/end/invalidate 编排成
 * 明确的交接顺序：
 *
 *   V2_LOCOMOTION ──(interrupt+release，由 main 先做)──▶ LEGACY
 *     ──begin()──▶ EXTERNAL_DRAG(token)  ──move()──▶ commitExternal(每次校验 token 仍有效)
 *     ──end()/invalidate()──▶ LEGACY(token 失效，旧会话的迟到 move 一律被 commit 拒绝)
 *
 * renderer replacement：docEpoch 变化 → 旧 dragSession 立即失效（不 durable resume，不恢复旧 pointer）。
 */
"use strict";

let SESSION_SEQ = 0;

function createDragSession({ authority, commit, deps } = {}) {
  let session = null; // {id, token, kind, docEpoch, startRect, startedAt, moves, lastMoveOutcome}

  function active() { return !!session; }

  function begin(kind, meta = {}) {
    const acq = authority.externalAcquire(kind || "drag");
    if (!acq.ok) return { ok: false, reason: acq.reason };
    if (acq.idempotent && session) return { ok: true, sessionId: session.id, token: session.token, idempotent: true };
    SESSION_SEQ += 1;
    session = {
      id: "drag-" + SESSION_SEQ + "-" + (typeof deps.now === "function" ? deps.now() : 0),
      token: acq.token,
      kind: kind || "drag",
      docEpoch: Number.isSafeInteger(meta.docEpoch) ? meta.docEpoch : null, // renderer 文档纪元（当前 renderModeSeq）
      senderId: meta.senderId != null ? meta.senderId : null,             // pointer/input identity（webContents id）
      startRect: typeof deps.currentRect === "function" ? deps.currentRect() : null,
      startedAt: typeof deps.now === "function" ? deps.now() : null,
      moves: 0,
      lastMoveOutcome: null
    };
    return { ok: true, sessionId: session.id, token: session.token, from: acq.from };
  }

  /**
   * 拖拽位移：绝对坐标由调用方从当前窗口位置 + delta 传入（renderer 契约是增量）。
   * 无活动会话 / 已 release / reload（docEpoch 变了）→ 一律被拒（不写窗口）。
   */
  function commitMove(absX, absY, meta = {}) {
    if (!session) return { ok: false, reason: "no-drag-session" };
    // renderer 换代：旧会话即刻失效（迟到的旧 pointer 事件不得继续 commit）
    if (session.docEpoch !== null && Number.isSafeInteger(meta.docEpoch) && meta.docEpoch !== session.docEpoch) {
      end("doc-epoch-changed");
      return { ok: false, reason: "stale-renderer-doc" };
    }
    const res = commit.commitExternal({
      externalToken: session.token, kind: "drag-move",
      x: absX, y: absY, sessionId: session.id
    });
    session.moves += 1;
    session.lastMoveOutcome = res.outcome;
    return res;
  }

  function end(reason) {
    if (!session) return { ok: false, noop: true };
    const id = session.id;
    const rel = authority.externalRelease(reason || "end");
    session = null;
    return { ok: true, sessionId: id, released: rel, observedRect: typeof deps.currentRect === "function" ? deps.currentRect() : null };
  }

  function snapshot() {
    return session ? Object.assign({}, session) : null;
  }

  return {
    active, begin, commitMove, end, snapshot,
    isCurrentExternalToken(token) { return !!session && authority.isExternalCurrent(token); }
  };
}

module.exports = { createDragSession };
