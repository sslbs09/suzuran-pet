/**
 * renderer-observer.js — 渲染层 Shadow 证据观察器（双端纯模块：Node 单测 require /
 * 渲染层 <script> 挂 window.RuntimeShadowObs，与 seat-fit.js 同先例）。
 *
 * FREEZE PHASE 4E + Blocker Closure：
 * - 激活纪律（strict OFF）：pet.js 惰性创建 observer——只在收到携带 shadow meta 的 walk broadcast
 *   后才创建/激活（main gate ON 才附 meta）。gate OFF：无 observer 实例、零 IPC、零开销。
 *   本模块自身只定义工厂（无全局状态、无 listener、无 observer 实例）——静态 <script> 标签
 *   必须存在（本渲染层无条件 loader；与 seat-fit.js/animation-watch.js 同先例），但 OFF 时
 *   工厂不被调用，报告里已说明该 API surface 为何无法字面不存在。
 * - noteSafely：渲染层故障边界——payload 工厂在 try 内惰性构造，任何异常不进入生产动画逻辑；
 *   fault 有界聚合（count/suppressed），诊断自身不再抛。
 * - causeRef：v0.1 无可证明「具体 command → 事件」因果（arm-on-recent-broadcast 属猜测）→ 恒 null。
 *   宁缺因果，不伪造链条。
 * - sampledAt：渲染层采样时刻 + 明确 clock domain（renderer-dateNow-ms）。
 */
/* global window */
"use strict";

function createRendererShadowObserver({ send, nowMs } = {}) {
  let armed = false;
  let seq = 0;
  const sendFn = typeof send === "function" ? send : null;
  const now = () => { try { return nowMs ? nowMs() : Date.now(); } catch { return 0; } };
  const faults = { count: 0, suppressed: 0, lastMessage: null };

  const obs = {
    get active() { return armed; },
    get faults() { return { count: faults.count, suppressed: faults.suppressed, lastMessage: faults.lastMessage }; },
    /** main gate ON 的 walk broadcast 附带 meta → 创建后激活（pet.js 保证只在此时调用） */
    arm() {
      armed = true;
    },
    /** 无 meta broadcast → 停用（gate OFF / 引擎停止路径） */
    disarm() {
      armed = false;
    },
    /**
     * 原始 note：构造并上行一条证据。armed=false 时零动作。
     * causeRef 恒 null（v0.1 无可证明因果）。
     */
    note(kind, payload) {
      if (!armed || !sendFn || !kind) return null;
      seq += 1;
      const ev = {
        v: 2,
        seq,                                   // 生产者分配的 sourceSeq（main 原样保留）
        kind: String(kind),
        payload: payload && typeof payload === "object" ? payload : {},
        docEpoch: payload && payload.docEpoch !== null && payload.docEpoch !== undefined ? payload.docEpoch : null,
        sampledAt: { clock: "renderer-dateNow-ms", value: now() }, // 采样时刻 + clock domain
        causeRef: null                          // 宁缺因果，不伪造
      };
      try { sendFn(ev); } catch { /* 诊断发送失败不影响渲染 */ }
      return ev;
    },
    /**
     * 故障边界 note（渲染层 hook 应使用本方法）：payload 工厂在 try 内惰性构造——
     * 构造抛错（访问奇异 getter 等）绝不打断生产动画逻辑；fault 有界聚合。
     */
    noteSafely(kind, makePayload) {
      if (!armed || !sendFn || !kind) return null;
      try {
        const payload = typeof makePayload === "function" ? makePayload() : makePayload;
        return this.note(kind, payload);
      } catch (e) {
        faults.count += 1;
        const msg = String((e && (e.message || e)) || "unknown").slice(0, 120);
        if (msg === faults.lastMessage) faults.suppressed += 1;
        else { faults.lastMessage = msg; }
        return null;
      }
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
