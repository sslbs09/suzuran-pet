"use strict";

const crypto = require("crypto");
const lines = require("./lines");

const POOLS = [
  ["pat", lines.PAT_LINES, "happy"],
  ...Object.entries(lines.PERSONIFY_LINES)
    .filter(([name]) => name !== "sleepDay" && name !== "sleepNight")
    .map(([name, pool]) => ["personify." + name, pool, "happy"]),
  ["personify.sleepDay", lines.PERSONIFY_LINES.sleepDay, "sleep"],
  ["personify.sleepNight", lines.PERSONIFY_LINES.sleepNight, "sleep"],
  ["workflow", lines.WORKFLOW_LINES, "idle"],
  ...Object.entries(lines.PROACTIVE_BY_PERIOD).map(([name, pool]) => ["proactive." + name, pool, "idle"]),
  ["long-idle", lines.LONG_IDLE_LINES, "idle"],
  ...Object.entries(lines.STAGE_LINES).map(([name, pool]) => ["stage." + name, pool, "love"]),
  ["early-morning", lines.EARLY_MORNING_LINES, "idle"]
];

function expand(text, vars = {}) {
  return String(text || "")
    .replace(/\{\{\s*name\s*\}\}/gi, vars.name || "苏苏洛")
    .replace(/\{\{\s*user\s*\}\}/gi, vars.user || "主人");
}

function normalize(text) {
  return String(text || "")
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/\*[^*]+\*/g, "")
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .toLowerCase();
}

function buildManifest(vars = {}) {
  const seen = new Set();
  const manifest = [];
  for (const [pool, items, emotion] of POOLS) {
    (Array.isArray(items) ? items : []).forEach((raw, index) => {
      const text = expand(raw, vars);
      const key = normalize(text);
      if (!key || seen.has(key)) return;
      seen.add(key);
      manifest.push({ id: `${pool}.${String(index + 1).padStart(2, "0")}`, pool, index, text, emotion });
    });
  }
  return manifest;
}

function voiceFingerprint(profile = {}) {
  const stable = {
    engine: profile.engine || "system",
    language: profile.language || "zh",
    voice: profile.voice || "",
    referenceAudio: profile.referenceAudio || "",
    referenceText: profile.referenceText || "",
    rate: profile.rate || "",
    pitch: profile.pitch || ""
  };
  return crypto.createHash("sha256").update(JSON.stringify(stable), "utf8").digest("hex").slice(0, 16);
}

function cacheKey(item, profile = {}) {
  return `${voiceFingerprint(profile)}:${item.id}`;
}

function summarize(items = []) {
  const list = Array.isArray(items) ? items : [];
  const summary = { total: list.length, pending: 0, loading: 0, ready: 0, failed: 0, cancelled: 0, bytes: 0 };
  for (const item of list) {
    const state = item.state || "pending";
    if (Object.prototype.hasOwnProperty.call(summary, state)) summary[state]++;
    summary.bytes += Number(item.bytes) || 0;
  }
  return summary;
}

module.exports = { POOLS, expand, normalize, buildManifest, voiceFingerprint, cacheKey, summarize };
