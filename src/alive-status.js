/**
 * alive-status.js — P0-B2 MINIMUM ALIVE STATUS（最小真相模型，纯逻辑可单测）
 *
 * 职责（任务 §6/§7/§8/§30）：把「角色在不在」与「她现在能不能正常思考」拆成
 * 四个互不掩盖的层，每一层只记录自己能证明的事实：
 *   BODY               桌面身体：READY / DEGRADED（renderer 生命周期事件）
 *   FORMAL CHARACTER   正式 Character Runtime：OK / UNAVAILABLE / PACKAGE_MISMATCH / DISABLED
 *                      （每轮实际 projection 读取结果；config 存在 ≠ healthy）
 *   COGNITION          模型认知：IDLE / WORKING / AVAILABLE / UNAVAILABLE / CANCELLED
 *                      （只由实际成功 turn / 实际失败 observation 更新；从未尝试=IDLE）
 *   VOICE              语音：AVAILABLE / DEGRADED / DISABLED / UNKNOWN
 *                      （renderer 真实播报结果上报；失败不得改写文字认知成功）
 *
 * 硬规则：
 *  - 禁止单一总 healthy=true 掩盖分层区别（§6）。
 *  - API key / baseUrl 存在不得标 COGNITION AVAILABLE（§8）。
 *  - 每个字段必须带 source + lastObservedAt（§30）；从未观察 ⇒ NEVER_OBSERVED/null。
 *  - 本模块不探测、不轮询、不建服务注册表——状态只由调用方在真实事件上喂入（§31）。
 */
"use strict";

const BODY_STATES = Object.freeze(["READY", "DEGRADED"]);
const FORMAL_STATES = Object.freeze(["OK", "UNAVAILABLE", "PACKAGE_MISMATCH", "DISABLED"]);
const COGNITION_STATES = Object.freeze(["IDLE", "WORKING", "AVAILABLE", "UNAVAILABLE", "CANCELLED"]);
const VOICE_STATES = Object.freeze(["AVAILABLE", "DEGRADED", "DISABLED", "UNKNOWN"]);

/** §30 要求的来源枚举：状态必须说清它是从哪种事实观察来的。 */
const SOURCES = Object.freeze({
  NEVER_OBSERVED: "never-observed",        // 诚实初值：没有任何运行时证据
  LIFECYCLE_EVENT: "lifecycle-event",      // renderer ready/crash 等本机生命周期事实
  PROJECTION_RESPONSE: "projection-response", // 本轮实际 GET /character-projection 结果
  CURRENT_TURN: "current-turn",            // 正在进行的 turn（WORKING）
  OBSERVED_SUCCESS: "observed-success",    // 实际成功 turn（唯一可标 AVAILABLE 的来源）
  OBSERVED_FAILURE: "observed-failure",    // 实际失败 observation
  OBSERVED_CANCEL: "observed-cancel",      // 用户取消（fenced 的迟到结果同样按取消记账）
  RENDERER_REPORT: "renderer-report",      // renderer 真实播报结果
  CONFIG_DISABLED: "config-disabled"       // 功能开关关闭（不是故障，也不是健康）
});

const LAYERS = Object.freeze({
  body: BODY_STATES,
  formal: FORMAL_STATES,
  cognition: COGNITION_STATES,
  voice: VOICE_STATES
});

/**
 * Host projection 结果 → FORMAL CHARACTER 层状态（纯映射，供测试与 main 复用）。
 * 未知/送达失败/超时一律 UNAVAILABLE：绝不把「没读到」伪装成 OK，也绝不伪装成 COGNITION 故障。
 */
function formalFromProjectionState(state) {
  switch (state) {
    case "ok": return "OK";
    case "package_mismatch": return "PACKAGE_MISMATCH";
    case "disabled": return "DISABLED";
    default: return "UNAVAILABLE"; // host_not_ready / instance_unavailable / unauthorized / unavailable / unknown / failed
  }
}

function createAliveStatus({ now = () => Date.now(), maxDetail = 160 } = {}) {
  const fields = {
    body: { state: "DEGRADED", source: SOURCES.NEVER_OBSERVED, lastObservedAt: null, detail: "" },
    formal: { state: "UNAVAILABLE", source: SOURCES.NEVER_OBSERVED, lastObservedAt: null, detail: "" },
    cognition: { state: "IDLE", source: SOURCES.NEVER_OBSERVED, lastObservedAt: null, detail: "" },
    voice: { state: "UNKNOWN", source: SOURCES.NEVER_OBSERVED, lastObservedAt: null, detail: "" }
  };
  const listeners = new Set();

  function setLayer(layer, state, { source = SOURCES.OBSERVED_FAILURE, detail = "" } = {}) {
    const allowed = LAYERS[layer];
    if (!allowed) throw new Error("alive-status: unknown layer " + layer);
    if (!allowed.includes(state)) throw new Error("alive-status: " + layer + " state must be one of " + allowed.join("/") + " (got " + state + ")");
    if (!Object.values(SOURCES).includes(source)) throw new Error("alive-status: unknown source " + source);
    const f = fields[layer];
    const before = f.state;
    f.state = state;
    f.source = source;
    f.lastObservedAt = now();
    f.detail = String(detail || "").slice(0, maxDetail);
    // 事件驱动（§31）：仅在状态真正迁移时通知；同状态刷新只更新 lastObservedAt，不打扰 UI。
    if (before !== state) for (const fn of listeners) { try { fn(snapshot(), layer); } catch { /* 订阅方失败不影响事实记录 */ } }
    return f;
  }

  function snapshot() {
    const out = { observedAt: now() };
    for (const layer of Object.keys(fields)) {
      out[layer] = {
        state: fields[layer].state,
        source: fields[layer].source,
        lastObservedAt: fields[layer].lastObservedAt,
        detail: fields[layer].detail
      };
    }
    return out;
  }

  function subscribe(fn) {
    if (typeof fn !== "function") throw new Error("alive-status: subscribe requires a function");
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  /** 供 main 的每轮 observation 便捷入口（§8：只有真实结果才能改变真相层）。 */
  function noteProjection(projectionState, detail) {
    return setLayer("formal", formalFromProjectionState(projectionState), {
      source: SOURCES.PROJECTION_RESPONSE, detail
    });
  }
  function noteTurnStarted() {
    return setLayer("cognition", "WORKING", { source: SOURCES.CURRENT_TURN });
  }
  function noteTurnSucceeded() {
    return setLayer("cognition", "AVAILABLE", { source: SOURCES.OBSERVED_SUCCESS });
  }
  function noteTurnFailed(detail) {
    return setLayer("cognition", "UNAVAILABLE", { source: SOURCES.OBSERVED_FAILURE, detail });
  }
  function noteTurnCancelled(detail) {
    return setLayer("cognition", "CANCELLED", { source: SOURCES.OBSERVED_CANCEL, detail });
  }
  function noteVoice(state, detail) {
    return setLayer("voice", state, { source: SOURCES.RENDERER_REPORT, detail });
  }
  function noteBody(state, detail) {
    return setLayer("body", state, { source: SOURCES.LIFECYCLE_EVENT, detail });
  }
  function noteFormalDisabled() {
    return setLayer("formal", "DISABLED", { source: SOURCES.CONFIG_DISABLED });
  }

  return {
    snapshot, subscribe, setLayer, formalFromProjectionState,
    noteProjection, noteTurnStarted, noteTurnSucceeded, noteTurnFailed,
    noteTurnCancelled, noteVoice, noteBody, noteFormalDisabled,
    BODY_STATES, FORMAL_STATES, COGNITION_STATES, VOICE_STATES, SOURCES
  };
}

module.exports = { createAliveStatus, formalFromProjectionState, SOURCES, LAYERS };
