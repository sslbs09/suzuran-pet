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
  ...Object.entries(lines.PROACTIVE_BY_STATE || {}).map(([name, pool]) => ["state." + name, pool, "idle"]),
  ...Object.entries(lines.WEATHER_LINES || {}).map(([name, pool]) => ["weather." + name, pool, "idle"]),
  ["long-idle", lines.LONG_IDLE_LINES, "idle"],
  ...Object.entries(lines.STAGE_LINES).map(([name, pool]) => ["stage." + name, pool, "love"]),
  ["early-morning", lines.EARLY_MORNING_LINES, "idle"]
];

// 行首【情绪】细标（v2.5.26 台词级音色分档）：与 sendProactive 的剥离规则一致——
// 缓存文本存剥离后的正文、emotion 存标签值，运行时 speak 才会命中同一缓存键
const MOOD_TAG_RE = /^【(撒娇|傲娇|惊讶|开心|温柔)】/;

function expand(text, vars = {}) {
  return String(text || "")
    .replace(/\{\{\s*name\s*\}\}/gi, vars.name || "苏苏洛")
    .replace(/\{\{\s*user\s*\}\}/gi, vars.user || "博士");
}

function normalize(text) {
  return String(text || "")
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/\*[^*]+\*/g, "")
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .toLowerCase();
}

let _manifestCache = { key: "", list: null };
function buildManifest(vars = {}) {
  const key = JSON.stringify([vars.name || "", vars.user || ""]);
  if (_manifestCache.key === key && _manifestCache.list) return _manifestCache.list;
  const seen = new Set();
  const manifest = [];
  for (const [pool, items, emotion] of POOLS) {
    (Array.isArray(items) ? items : []).forEach((raw, index) => {
      let text = expand(raw, vars);
      let emo = emotion;
      const tag = text.match(MOOD_TAG_RE); // 剥离行首情绪标签，与运行时 sendProactive 行为一致
      if (tag) { emo = tag[1]; text = text.slice(tag[0].length); }
      const key2 = normalize(text);
      if (!key2 || seen.has(key2)) return;
      seen.add(key2);
      manifest.push({ id: `${pool}.${String(index + 1).padStart(2, "0")}`, pool, index, text, emotion: emo });
    });
  }
  _manifestCache = { key, list: manifest };
  return manifest;
}

/** 按展开文本+情绪查固定台词条目（播放命中缓存/lineId 反查用） */
function findItem(vars, text, emotion) {
  const t = String(text || "");
  const emo = String(emotion || "idle");
  return buildManifest(vars).find((item) => item.text === t && item.emotion === emo) || null;
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

module.exports = { POOLS, expand, normalize, buildManifest, findItem, voiceFingerprint, cacheKey, summarize };
