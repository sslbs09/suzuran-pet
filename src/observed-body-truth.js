"use strict";

const { BODY_IMPLEMENTATION_ID, PROTOCOL_VERSION } = require("./body-capabilities");

const REQUEST_TIMEOUT_MS = 750;
const MAX_PENDING_REQUESTS = 16;

function sameIdentity(a, b) {
  return !!(a && b && a.docEpoch === b.docEpoch && a.bodyGeneration === b.bodyGeneration);
}

function coherentOwner(context) {
  return !!(context && context.ready && Number.isSafeInteger(context.renderModeSeq)
    && context.renderModeSeq === context.acceptedRenderModeSeq
    && typeof context.mode === "string" && context.mode.length > 0);
}

function sameOwner(a, b) {
  return !!(coherentOwner(a) && coherentOwner(b) && a.window === b.window
    && sameIdentity(a.identity, b.identity) && a.renderModeSeq === b.renderModeSeq && a.mode === b.mode);
}

function boundedName(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f]/.test(value);
}

function nonnegativeFinite(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function cloneAnimation(raw, context, requestedAt, observedAt) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.mode !== context.mode) return null;
  if (raw.status === "unknown" || raw.status === "unsupported") {
    if (raw.clip !== null || raw.sampledAt !== null || (raw.status === "unsupported" && context.mode === "spine")) return null;
    return { status: raw.status, mode: context.mode, clip: null, sampledAt: null };
  }
  if (raw.status !== "observed" || context.mode !== "spine" || !boundedName(raw.clip)
    || raw.track !== 0 || typeof raw.loop !== "boolean"
    || !nonnegativeFinite(raw.trackTime) || !nonnegativeFinite(raw.mixTime) || !nonnegativeFinite(raw.mixDuration)
    || (raw.mixingFrom !== null && !boundedName(raw.mixingFrom))
    || !nonnegativeFinite(raw.sampledAt) || raw.sampledAt < requestedAt || raw.sampledAt > observedAt) return null;
  return {
    status: "observed", mode: "spine", clip: raw.clip, track: 0, loop: raw.loop,
    trackTime: raw.trackTime, mixingFrom: raw.mixingFrom, mixTime: raw.mixTime,
    mixDuration: raw.mixDuration, sampledAt: raw.sampledAt
  };
}

/** Request-scoped observation only. M1 supplies identity and admission; no truth is retained. */
function createObservedBodyTruth({ getCurrent, readPosture, sendRequest, newRequestId, now, setTimer, clearTimer }) {
  const pending = new Map();

  function settle(requestId, animation) {
    const request = pending.get(requestId);
    if (!request) return false;
    pending.delete(requestId);
    clearTimer(request.timer);
    request.resolve(animation);
    return true;
  }

  function invalidate() {
    for (const requestId of [...pending.keys()]) settle(requestId, null);
  }

  function accept(payload) {
    if (!payload || typeof payload !== "object" || typeof payload.requestId !== "string") return false;
    const request = pending.get(payload.requestId);
    const current = getCurrent();
    if (!request || !sameOwner(request.context, current)
      || !Number.isSafeInteger(payload.renderModeSeq) || payload.renderModeSeq !== current.renderModeSeq
      || payload.committedMode !== current.mode) return false;
    const animation = cloneAnimation(payload.animation, current, request.requestedAt, now());
    return animation ? settle(payload.requestId, animation) : false;
  }

  async function read(deliver) {
    const publish = (snapshot) => {
      if (typeof deliver === "function") deliver(snapshot);
      return snapshot;
    };
    const requested = getCurrent();
    if (!requested) return publish({ ok: false, reason: "unavailable" });
    let animation = null;
    if (coherentOwner(requested) && pending.size < MAX_PENDING_REQUESTS) {
      animation = await new Promise((resolve) => {
        const requestId = newRequestId();
        const request = { context: requested, requestedAt: now(), resolve, timer: null };
        pending.set(requestId, request);
        request.timer = setTimer(() => settle(requestId, null), REQUEST_TIMEOUT_MS);
        try { sendRequest(requested.window, requestId); } catch { settle(requestId, null); }
      });
    }
    // Lifecycle invalidation may run through multiple synchronous main steps.
    // Read current identity and native bounds after the renderer request settles.
    const current = getCurrent();
    if (!current) return publish({ ok: false, reason: "unavailable" });
    let bounds;
    try { bounds = current.window.getBounds(); } catch { return publish({ ok: false, reason: "unavailable" }); }
    if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every((value) => typeof value === "number" && Number.isFinite(value))
      || bounds.width <= 0 || bounds.height <= 0) return publish({ ok: false, reason: "unavailable" });
    const posture = readPosture();
    return publish({
      ok: true, protocolVersion: PROTOCOL_VERSION, bodyImplementationId: BODY_IMPLEMENTATION_ID,
      generation: { docEpoch: current.identity.docEpoch, bodyGeneration: current.identity.bodyGeneration },
      posture: { visual: "unknown", sleeping: posture.sleeping === true, dragging: posture.dragging === true },
      animation: animation && sameOwner(requested, current) ? animation
        : { status: "unknown", mode: current.mode, clip: null, sampledAt: null },
      geometry: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
      observedAt: now()
    });
  }

  return { read, accept, invalidate };
}

module.exports = { createObservedBodyTruth };
