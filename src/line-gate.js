"use strict";

const DEFAULT_MIN_INTERVAL_MS = 30000;
const DEFAULT_RECENT_LIMIT = 5;

function normalizeLine(text) {
  return String(text || "")
    .replace(/\{\{\s*(?:user|name)\s*\}\}/gi, "")
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/\*[^*]+\*/g, "")
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .toLowerCase();
}

function createLineGate({ minIntervalMs = DEFAULT_MIN_INTERVAL_MS, recentLimit = DEFAULT_RECENT_LIMIT } = {}) {
  const recent = [];
  let lastShownAt = null;

  function admit(text, { now = Date.now(), force = false } = {}) {
    const normalized = normalizeLine(text);
    if (!normalized) return { accepted: false, reason: "empty" };
    if (recent.includes(normalized)) return { accepted: false, reason: "duplicate" };
    if (!force && lastShownAt !== null && now - lastShownAt < minIntervalMs) {
      return { accepted: false, reason: "global-cooldown" };
    }
    recent.push(normalized);
    while (recent.length > recentLimit) recent.shift();
    lastShownAt = now;
    return { accepted: true, reason: "accepted", text };
  }

  function reset() {
    recent.length = 0;
    lastShownAt = null;
  }

  return { admit, reset, normalize: normalizeLine };
}

module.exports = { DEFAULT_MIN_INTERVAL_MS, normalizeLine, createLineGate };
