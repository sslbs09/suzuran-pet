/**
 * Request-scoped Spine facts after a natural screen draw. This observes an
 * applied TrackEntry; it never advances animation or infers physical posture.
 */
"use strict";

function createObservedBodySampler({ getCurrent, reply, now, setTimeout: startTimer, clearTimeout: stopTimer } = {}) {
  const pending = new Map();
  const schedule = startTimer || setTimeout;
  const cancel = stopTimer || clearTimeout;
  const sampleTime = now || Date.now;
  let destroyed = false;

  function current() {
    try { return typeof getCurrent === "function" ? getCurrent() : null; } catch { return null; }
  }

  function modeOf(state) {
    return state && typeof state.mode === "string" ? state.mode : null;
  }

  function unknown(state, status = "unknown") {
    return { status, mode: modeOf(state), clip: null, sampledAt: null };
  }

  function send(requestId, animation, state) {
    try {
      if (typeof reply === "function") reply({
        requestId,
        renderModeSeq: state && Number.isSafeInteger(state.renderModeSeq) ? state.renderModeSeq : null,
        committedMode: modeOf(state),
        animation
      });
    } catch { /* Observation delivery must not affect the renderer. */ }
  }

  function usable(state) {
    return !!(state && state.ready === true && state.mode === "spine"
      && state.visible === true && state.bootstrapPending !== true
      && Number.isSafeInteger(state.generation) && state.generation > 0
      && state.owner && state.app && state.obj && state.owner.app === state.app
      && state.owner.obj === state.obj && state.owner.context
      && state.owner.context.generation === state.generation
      && state.obj.parent === state.app.stage
      && state.app.renderer && typeof state.app.renderer.on === "function"
      && typeof state.app.renderer.off === "function");
  }

  function stillCurrent(captured, state) {
    return usable(state) && state.owner === captured.owner && state.app === captured.app
      && state.obj === captured.obj && state.generation === captured.generation
      && state.renderModeSeq === captured.renderModeSeq;
  }

  function finish(request, animation, state) {
    if (pending.get(request.id) !== request) return;
    pending.delete(request.id);
    try { request.renderer.off("postrender", request.onFrame); } catch { /* Destroyed renderer. */ }
    try { if (request.timer !== null) cancel(request.timer); } catch { /* Timer already removed. */ }
    send(request.id, animation, state);
  }

  function readAnimation(state) {
    const entry = state.obj.state.getCurrent(0);
    if (!entry || entry.nextTrackLast === -1 || !Number.isFinite(entry.nextTrackLast)
      || !entry.animation || typeof entry.animation.name !== "string" || !entry.animation.name
      || typeof entry.loop !== "boolean" || !Number.isFinite(entry.trackTime)
      || !Number.isFinite(entry.mixTime) || !Number.isFinite(entry.mixDuration)) return unknown(state);
    const from = entry.mixingFrom;
    if (from && (!from.animation || typeof from.animation.name !== "string" || !from.animation.name)) return unknown(state);
    const sampledAt = sampleTime();
    if (!Number.isFinite(sampledAt)) return unknown(state);
    return {
      status: "observed", mode: "spine", clip: entry.animation.name, track: 0,
      loop: entry.loop, trackTime: entry.trackTime, mixingFrom: from ? from.animation.name : null,
      mixTime: entry.mixTime, mixDuration: entry.mixDuration, sampledAt
    };
  }

  function request(requestId) {
    if (typeof requestId !== "string" || !requestId || pending.has(requestId)) return;
    const state = current();
    if (destroyed || !state || state.ready !== true || !modeOf(state)) {
      send(requestId, unknown(state), state);
      return;
    }
    if (state.mode !== "spine") {
      send(requestId, unknown(state, "unsupported"), state);
      return;
    }
    if (!usable(state) || pending.size >= 16) {
      send(requestId, unknown(state), state);
      return;
    }
    const captured = { ...state };
    const waiting = { id: requestId, renderer: state.app.renderer, timer: null, onFrame: null };
    waiting.onFrame = () => {
      let live = current();
      try {
        if (!stillCurrent(captured, live)) { finish(waiting, unknown(live), live); return; }
        // Fit/measurement renders also emit postrender; they cannot consume this request.
        if (waiting.renderer.renderingToScreen !== true || waiting.renderer.lastObjectRendered !== captured.app.stage) return;
        const animation = readAnimation(live);
        live = current();
        finish(waiting, stillCurrent(captured, live) ? animation : unknown(live), live);
      } catch { finish(waiting, unknown(live), live); }
    };
    pending.set(requestId, waiting);
    try {
      waiting.renderer.on("postrender", waiting.onFrame);
      waiting.timer = schedule(() => {
        const live = current();
        finish(waiting, unknown(live), live);
      }, 500);
    } catch { finish(waiting, unknown(state), state); }
  }

  function invalidate() {
    const state = current();
    for (const waiting of [...pending.values()]) finish(waiting, unknown(state), state);
  }

  return {
    request,
    invalidate,
    destroy() { destroyed = true; invalidate(); }
  };
}

if (typeof module !== "undefined" && module.exports) module.exports = { createObservedBodySampler };
if (typeof window !== "undefined") window.ObservedBodySampler = { createObservedBodySampler };
