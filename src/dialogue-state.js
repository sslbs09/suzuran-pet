"use strict";

function transitionSleep(previous, next) {
  const before = !!previous;
  const after = !!next;
  if (before === after) return null;
  return after ? "sleep" : "wake";
}

function createWorkflowSignalState(cooldownMs = 8 * 60 * 1000) {
  return { cooldownMs, pending: false, sources: new Set(), lastConsumedAt: 0, lastSignalAt: 0 };
}

function recordWorkflowSignal(state, source, now = Date.now()) {
  state.pending = true;
  state.lastSignalAt = now;
  if (source) state.sources.add(String(source));
  return state;
}

function consumeWorkflowSignal(state, now = Date.now(), { busy = false, sleeping = false } = {}) {
  if (!state.pending) return { accepted: false, reason: "empty" };
  if (busy) return { accepted: false, reason: "busy" };
  if (sleeping) return { accepted: false, reason: "sleeping" };
  if (state.lastConsumedAt && now - state.lastConsumedAt < state.cooldownMs) {
    return { accepted: false, reason: "cooldown" };
  }
  const sources = [...state.sources];
  state.pending = false;
  state.sources.clear();
  state.lastConsumedAt = now;
  return { accepted: true, sources };
}

function requeueWorkflowSignal(state, sources = []) {
  state.pending = true;
  for (const source of sources) if (source) state.sources.add(String(source));
  state.lastConsumedAt = 0;
  return state;
}

module.exports = { transitionSleep, createWorkflowSignalState, recordWorkflowSignal, consumeWorkflowSignal, requeueWorkflowSignal };
