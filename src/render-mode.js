/**
 * render-mode.js — 渲染模式（纯逻辑，2026-08-27 从 main.js 拆出，可单测）
 * - 渲染模式归一化：gif / spine / rig / live2d 四态，未知值回落 gif
 * - 模式切换贴地坐标：窗口底边对齐工作区底（+groundGap），水平钳回工作区范围
 *   （main.js「模式切换贴地」逻辑；与 walkGeo.groundLine 同族，正常窗口下等价）
 */
"use strict";

const RENDER_MODES = ["gif", "spine", "rig", "live2d"];

/** 渲染模式归一化：合法三态原样返回，其余（含未配置/未知值）回落 gif */
function renderModeOf(value) {
  return RENDER_MODES.includes(value) ? value : "gif";
}

/**
 * 校验 renderer 回传的 render-mode outcome。
 * seq 是 main-side identity；renderer generation 不应跨 IPC 参与判定。
 */
function renderModeOutcomeDecision({ currentSeq, expectedRequestedMode, outcome } = {}) {
  const msg = outcome && typeof outcome === "object" ? outcome : null;
  if (!Number.isSafeInteger(currentSeq) || !msg || !Number.isSafeInteger(msg.seq) || msg.seq !== currentSeq) {
    return { accepted: false, reason: "stale" };
  }
  if (!RENDER_MODES.includes(msg.requestedMode) || !RENDER_MODES.includes(msg.committedMode)) {
    return { accepted: false, reason: "invalid-mode" };
  }
  if (expectedRequestedMode && msg.requestedMode !== expectedRequestedMode) {
    return { accepted: false, reason: "unexpected-requested-mode" };
  }
  return {
    accepted: true,
    seq: msg.seq,
    ok: msg.ok === true && msg.requestedMode === msg.committedMode,
    requestedMode: msg.requestedMode,
    committedMode: msg.committedMode,
    error: msg.error
  };
}

/**
 * 校验 renderer 内部 reskin 触发的 GIF correction。
 * correction 不是 formal outcome，也不能直接改变持久化配置；它只允许
 * 当前 formal intent 把 renderer 已完成的 GIF fallback 重新纳入正式协议。
 */
function renderModeCorrectionDecision({ currentSeq, currentSourceMode, correction } = {}) {
  const msg = correction && typeof correction === "object" ? correction : null;
  if (!Number.isSafeInteger(currentSeq) || !msg || !Number.isSafeInteger(msg.baseSeq) || msg.baseSeq !== currentSeq) {
    return { accepted: false, reason: "stale" };
  }
  if (!RENDER_MODES.includes(currentSourceMode) || currentSourceMode === "gif" ||
      !RENDER_MODES.includes(msg.sourceMode) || msg.sourceMode === "gif" ||
      msg.sourceMode !== currentSourceMode) {
    return { accepted: false, reason: "unexpected-source-mode" };
  }
  if (msg.committedMode !== "gif") {
    return { accepted: false, reason: "invalid-committed-mode" };
  }
  return {
    accepted: true,
    baseSeq: msg.baseSeq,
    sourceMode: msg.sourceMode,
    committedMode: "gif",
    error: msg.error
  };
}

/** sender identity 是引用身份，不能用 seq 代替。 */
function isCurrentRenderSender(sender, currentSender) {
  return !!sender && !!currentSender && sender === currentSender;
}

/**
 * 模式切换贴地坐标：窗口底边与工作区底对齐、水平钳回工作区。
 * 与原 main.js 公式逐位一致（不额外加 Math.max(wa.y,…) 保护，避免行为漂移）。
 * @param {Object} bounds 窗口 {x,y,width,height}
 * @param {Object} wa 工作区 {x,y,width,height}
 * @param {number} groundGap 贴地间隙
 * @returns {{x:number, y:number}} 已四舍五入的目标窗口坐标
 */
function groundAlign(bounds, wa, groundGap) {
  const gy = wa.y + wa.height + (groundGap || 0) - bounds.height;
  const gx = Math.min(Math.max(bounds.x, wa.x), Math.max(wa.x, wa.x + wa.width - bounds.width));
  return { x: Math.round(gx), y: Math.round(gy) };
}

/** 当前模式真正参与地面定位的 gap；Spine/GIF 几何数据必须分开保存。 */
function effectiveGroundGap(mode, spineGroundGap, gifVisualGroundGap = 0) {
  const value = mode === "spine" ? spineGroundGap : mode === "gif" ? gifVisualGroundGap : 0;
  const v = Number(value);
  return Number.isFinite(v) ? Math.max(0, Math.min(80, v)) : 0;
}

/**
 * 在窗口 resize 前判断旧窗口是否保持在地面/底边锚点附近。
 * seatSink 只对 Spine 坐姿有效；非 Spine 即使残留 seated 状态也不消费它。
 */
function wasGroundAnchored({ mode, bounds, wa, groundGap, gifGroundGap = 0, seated = false, seatSink = 0, tolerance = 8 }) {
  const expectedBottom = wa.y + wa.height + effectiveGroundGap(mode, groundGap, gifGroundGap) +
    (mode === "spine" && seated ? (Number(seatSink) || 0) : 0);
  return Math.abs((bounds.y + bounds.height) - expectedBottom) <= tolerance;
}

/**
 * 尺寸提交后的窗口定位决策：
 * - 瞬态姿态/飞行/拖拽中不主动改位置；
 * - Spine 坐姿交给 main.js 现有 applySeatPosition（保留 seatSink）；
 * - 只有 render-mode commit 的稳定落地状态按最新 bounds 贴当前显示器工作区；
 *   ordinary resize 保留用户位置。
 *
 * 这里只做纯决策，避免把窗口副作用和模式切换生命周期耦合起来。
 */
function resizeRepositionDecision({ mode, bounds, wa, groundGap, gifGroundGap = 0, seated, perched, dragPaused, flight, jump, transient, renderModeCommit, wasGroundAnchored: grounded = false }) {
  if (perched || dragPaused || flight || jump || transient) return { type: "skip" };
  if (mode === "spine" && seated) return { type: "seat" };
  if (!renderModeCommit && !grounded) return { type: "skip" };
  return { type: "ground", position: groundAlign(bounds, wa, effectiveGroundGap(mode, groundGap, gifGroundGap)) };
}

/** 主进程尺寸回调的最小 revision guard；不承载窗口/姿态状态。 */
function createResizeRevision() {
  let current = 0;
  return {
    next() { current += 1; return current; },
    isCurrent(value) { return value === current; }
  };
}

/**
 * 校验并归类 renderer 的 ground-gap report。
 * GIF report 需要自己的 visual gap 与单调 identity；不能写入 Spine groundGap。
 * F6：docEpoch = 该 renderer 文档启动时刻的 main renderModeSeq（文档身份；与文档内部的
 * renderGeneration / geometryRevision 是三个不同概念，互不混用）。
 *  - epoch < epochFloor：文档重新生成（crash reload/自愈 reload/新窗）后的旧文档晚到包 → 拒；
 *  - epoch > lastReport.epoch：新文档首包 → 无条件接受并换代（旧文档的高 gen/rev 不再误拒它）；
 *  - epoch 相同：维持原 revision/generation 单调防乱序语义；
 *  - 全部参数缺省（0）时行为与旧版逐分支一致（向后兼容既有调用/测试）。
 */
function groundGapReportDecision({
  mode,
  sourceMode,
  current,
  gifCurrent = 0,
  px,
  standSinkOffset = 0,
  geometryRevision,
  renderGeneration,
  docEpoch = 0,
  epochFloor = 0,
  lastReport = null
}) {
  if (sourceMode !== mode || (mode !== "spine" && mode !== "gif")) {
    return { accepted: false, value: mode === "gif" ? gifCurrent : current, target: mode };
  }
  const v = Number(px);
  if (!Number.isFinite(v)) {
    return { accepted: false, value: mode === "gif" ? gifCurrent : current, target: mode };
  }
  if (!Number.isFinite(Number(renderGeneration))) {
    return { accepted: false, value: mode === "gif" ? gifCurrent : current, target: mode };
  }
  const epoch = Number(docEpoch) || 0;
  if (epoch < (Number(epochFloor) || 0)) {
    return { accepted: false, value: mode === "gif" ? gifCurrent : current, target: mode, stale: true, staleDoc: true };
  }
  if (mode === "gif") {
    if (!Number.isFinite(Number(geometryRevision))) {
      return { accepted: false, value: gifCurrent, target: "gif" };
    }
    if (lastReport) {
      const lastEpoch = Number(lastReport.docEpoch) || 0;
      if (epoch < lastEpoch) {
        return { accepted: false, value: gifCurrent, target: "gif", stale: true };
      }
      if (epoch === lastEpoch && (
        Number(geometryRevision) <= Number(lastReport.geometryRevision) ||
        Number(renderGeneration) < Number(lastReport.renderGeneration)
      )) {
        return { accepted: false, value: gifCurrent, target: "gif", stale: true };
      }
      // epoch > lastEpoch：新文档首包，换代接受（旧桶的 gen/rev 基准作废）
    }
    const raw = Math.max(0, Math.min(80, v));
    const next = Math.round(raw * 100) / 100;
    return {
      accepted: true,
      changed: next !== Number(gifCurrent),
      value: next,
      target: "gif",
      identity: { geometryRevision: Number(geometryRevision), renderGeneration: Number(renderGeneration), docEpoch: epoch }
    };
  }
  if (lastReport) {
    const lastEpoch = Number(lastReport.docEpoch) || 0;
    if (epoch < lastEpoch) {
      return { accepted: false, value: current, target: "spine", stale: true };
    }
    if (epoch === lastEpoch && Number(renderGeneration) < Number(lastReport.renderGeneration)) {
      return { accepted: false, value: current, target: "spine", stale: true };
    }
    // epoch > lastEpoch：新文档首包，换代接受
  }
  const raw = Math.max(0, Math.min(80, Math.round(v)));
  const next = Math.max(0, Math.min(80, raw + standSinkOffset));
  return {
    accepted: true,
    changed: next !== Number(current),
    value: next,
    target: "spine",
    identity: { renderGeneration: Number(renderGeneration), docEpoch: epoch }
  };
}

module.exports = {
  RENDER_MODES,
  renderModeOf,
  renderModeOutcomeDecision,
  renderModeCorrectionDecision,
  isCurrentRenderSender,
  groundAlign,
  effectiveGroundGap,
  wasGroundAnchored,
  resizeRepositionDecision,
  createResizeRevision,
  groundGapReportDecision
};
