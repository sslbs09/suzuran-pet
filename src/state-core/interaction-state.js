/**
 * interaction-state.js — State Core 的输入候选 / 已接受 interaction 生命周期（纯模块，双端可用）。
 *
 * 承接 Q-bounce 调查的真实证据：pointerdown candidate ≠ admitted drag session。
 *   pointerdown ──▶ candidate（renderer 本地，零 IPC）
 *   位移 > 阈值 ──▶ admit DRAG interaction（恰一次；调用方据此 acquire Pause lease + Motion token）
 *   pointerup 未过阈值 ──▶ end：tap/headpat body-local interaction（不 acquire Motion）
 *   renderer reload / document replacement ──▶ invalidate（旧 candidate / 旧 interactionId 立即失效）
 *
 * 位移语义与 V1 逐字一致：单事件位移（相对上次锚点）超过阈值才算 crossed；
 * crossed 时重设锚点；未 crossed 不重设（慢拖不误判，锚点保持在指针下方）。
 *
 * 本模块不接触窗口、不持有 Motion/Pause 权威——admit/end 通过 onAdmit/onEnd 钩子交给组合层，
 * 由组合层按「先 Pause lease 后 Motion token」的顺序执行（顺序合同见测试 T-11）。
 * 双端：Node require + 渲染层 window.StateCoreInteraction（与 seat-fit.js 同先例）。
 */
/* global window */
"use strict";

let INTERACTION_SEQ = 0;

function createInteractionState({ threshold = 3, onAdmit, onEnd, now } = {}) {
  let candidate = null; // {id, pointerId, anchorX, anchorY, moved, admitted, interactionId, startedAt}

  function snap() {
    return candidate ? {
      candidateId: candidate.id, admitted: candidate.admitted,
      interactionId: candidate.interactionId || null, moved: candidate.moved, startedAt: candidate.startedAt
    } : null;
  }

  return {
    /** pointerdown：进入候选。已有候选（异常重复 pointerdown）→ 原候选作废重建（单指针契约）。 */
    begin(meta = {}) {
      const prev = candidate;
      INTERACTION_SEQ += 1;
      candidate = {
        id: "cand-" + INTERACTION_SEQ,
        pointerId: meta.pointerId !== undefined ? meta.pointerId : null,
        anchorX: Number.isFinite(Number(meta.x)) ? Number(meta.x) : 0,
        anchorY: Number.isFinite(Number(meta.y)) ? Number(meta.y) : 0,
        moved: false, admitted: false, interactionId: null,
        startedAt: typeof now === "function" ? now() : null,
        invalidated: false
      };
      if (prev && prev.admitted) { // 前一个已 admit 的会话未被 end 显式关闭 → 视为被新输入接管
        try { if (typeof onEnd === "function") onEnd({ interactionId: prev.interactionId, kind: "drag", superseded: true }); } catch { /* 钩子故障不阻断 */ }
      }
      return { ok: true, candidateId: candidate.id, superseded: !!(prev && prev.admitted) };
    },
    /**
     * pointermove（绝对屏幕坐标）。返回：
     *   { crossed:false }                      未过阈值（不产生任何 IPC/写）
     *   { crossed:true, justAdmitted, interactionId, dx, dy }
     * justAdmitted=true：本次 crossing 恰好完成 DRAG admission（调用方此刻 acquire pause+motion）。
     * dx/dy = 相对当前锚点的位移（crossed 时才有效，调用方用于 moveWindow）。
     */
    move(x, y) {
      if (!candidate) return { crossed: false, moved: false };
      if (candidate.invalidated) return { crossed: false, moved: false, invalidated: true };
      const ax = Number(candidate.anchorX), ay = Number(candidate.anchorY);
      const dx = Number(x) - ax, dy = Number(y) - ay;
      const crossed = Math.abs(dx) > threshold || Math.abs(dy) > threshold;
      if (!crossed) return { crossed: false, moved: candidate.moved };
      const justAdmitted = !candidate.admitted;
      if (justAdmitted) {
        candidate.admitted = true;
        INTERACTION_SEQ += 1;
        candidate.interactionId = "drag-" + INTERACTION_SEQ;
        try { if (typeof onAdmit === "function") onAdmit({ interactionId: candidate.interactionId, kind: "drag" }); } catch { /* 钩子故障不阻断 admission */ }
      }
      candidate.moved = true;
      candidate.anchorX = Number(x);
      candidate.anchorY = Number(y);
      return { crossed: true, moved: true, justAdmitted, interactionId: candidate.interactionId, dx, dy };
    },
    /**
     * pointerup / 异常取消。wasDrag=已 admit 的真 drag；tap（未 admit）kind="tap"，
     * interactionId=null —— body-local feedback 路径，不携带任何 Motion/Pause 身份。
     */
    end() {
      if (!candidate) return { wasDrag: false, interactionId: null, noop: true };
      const wasDrag = candidate.admitted;
      const interactionId = candidate.interactionId || null;
      const kind = wasDrag ? "drag" : "tap";
      candidate = null;
      try { if (typeof onEnd === "function") onEnd({ interactionId, kind, wasDrag }); } catch { /* 钩子故障不阻断 */ }
      return { wasDrag, interactionId, kind };
    },
    /** renderer reload / document replacement：候选与已 admit 会话立即失效（不 durable resume）。 */
    invalidate(reason) {
      if (!candidate) return { ok: false, noop: true };
      const had = { interactionId: candidate.interactionId || null, admitted: candidate.admitted };
      candidate = null;
      return { ok: true, invalidated: had, reason: reason || null };
    },
    active() { return !!candidate; },
    snapshot: snap
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { createInteractionState };
}
if (typeof window !== "undefined") {
  window.StateCoreInteraction = { createInteractionState };
}
