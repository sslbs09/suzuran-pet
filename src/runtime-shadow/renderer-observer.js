/**
 * renderer-observer.js — 渲染层 Shadow 证据观察器（双端纯模块：Node 单测 require /
 * 渲染层 <script> 挂 window.RuntimeShadowObs，与 seat-fit.js 同先例）。
 *
 * FREEZE PHASE 4E：body 证据上行——document/body generation、requested/applied 动画、
 * track identity、mixing state、local Y / fit handoff、Sit capability、已有测量。
 *
 * 激活纪律（gate OFF 零开销）：
 * - pet.js 侧所有 hook 以 `if (shadowObs && shadowObs.active)` 守卫；
 * - active 只在收到携带 shadow meta 的 walk broadcast 后为真（main gate ON 才附 meta）；
 * - 收到无 meta 的 broadcast → disarm（引擎停/门关）。
 * - causeRef：仅在能证明因果（该 applied 由对应 broadcast 驱动）时携带，否则 null。
 */
/* global window */
"use strict";

function createRendererShadowObserver({ send, nowMs } = {}) {
  let armed = false;
  let seq = 0;
  let causeRef = null;
  let meta = null;
  const sendFn = typeof send === "function" ? send : null;
  const now = () => { try { return nowMs ? nowMs() : Date.now(); } catch { return 0; } };

  const obs = {
    get active() { return armed; },
    /** main gate ON 的 walk broadcast 附带 meta → 激活（并记录当前 cause） */
    arm(m) {
      armed = true;
      meta = m && typeof m === "object" ? { runId: m.runId || null, episodeId: m.episodeId || null, seq: Number.isFinite(Number(m.seq)) ? Number(m.seq) : null } : null;
      if (meta && meta.seq !== null) causeRef = { source: "main", sourceSeq: meta.seq };
    },
    /** 无 meta broadcast → 停用（gate OFF / 引擎停止路径） */
    disarm() {
      armed = false;
      causeRef = null;
      meta = null;
    },
    setCause(ref) {
      causeRef = ref && typeof ref === "object" && Number.isSafeInteger(ref.sourceSeq)
        ? { source: ref.source || "main", sourceSeq: ref.sourceSeq } : null;
    },
    /** 取走当前 cause（证明不了的帧保持 null） */
    takeCause() {
      const c = causeRef;
      causeRef = null;
      return c;
    },
    /**
     * 记录一条 body 证据并发往主进程（IPC pet:shadow-evidence）。
     * armed=false 时零动作（gate OFF 零开销）。
     * causeRef 只对 anim-applied 可证明（由对应 broadcast 驱动）；其余 kind 一律 null——
     * 不能证明因果时保持 null，绝不猜（PHASE 3 合同）。
     */
    note(kind, payload) {
      if (!armed || !sendFn || !kind) return null;
      seq += 1;
      const ev = {
        v: 1,
        seq,
        kind: String(kind),
        payload: payload && typeof payload === "object" ? payload : {},
        docEpoch: payload && Number.isFinite(Number(payload.docEpoch)) ? Number(payload.docEpoch) : null,
        causeRef: kind === "anim-applied" ? this.takeCause() : null,
        dateNow: now()
      };
      try { sendFn(ev); } catch { /* 诊断发送失败不影响渲染 */ }
      return ev;
    }
  };
  return obs;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { createRendererShadowObserver };
}
if (typeof window !== "undefined") {
  window.RuntimeShadowObs = { createRendererShadowObserver };
}
