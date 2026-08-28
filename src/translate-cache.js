"use strict";
/**
 * 翻译磁盘缓存（2026-08-27 新增，降费）：罐头台词（摸头/时段/由头等固定句子）
 * 跨会话复用译文，7 天 TTL、上限 500 条。纯函数，可单测。
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DEFAULT_TTL_MS = 7 * 86400000; // 7 天
const MAX = 500;

function cachePathFor(userDir) {
  return path.join(userDir, "translate-cache.json");
}
function hashKey(text) {
  return crypto.createHash("sha1").update(String(text || "")).digest("hex");
}
function load(userDir) {
  try { return JSON.parse(fs.readFileSync(cachePathFor(userDir), "utf8")); } catch { return {}; }
}
function save(userDir, map) {
  try {
    fs.mkdirSync(path.dirname(cachePathFor(userDir)), { recursive: true });
    fs.writeFileSync(cachePathFor(userDir), JSON.stringify(map));
  } catch { /* 缓存写失败不影响翻译 */ }
}
function get(map, text, now = Date.now(), ttlMs = DEFAULT_TTL_MS) {
  const e = map[hashKey(text)];
  if (e && Number.isFinite(e.t) && now - e.t < ttlMs) return e.ja;
  if (e) delete map[hashKey(text)]; // 过期条目懒惰清除
  return undefined;
}
function set(map, text, ja, now = Date.now()) {
  map[hashKey(text)] = { ja, t: now };
  const keys = Object.keys(map);
  if (keys.length > MAX) {
    // 淘汰最旧，保留最新 MAX 条
    keys.sort((a, b) => (map[a].t || 0) - (map[b].t || 0));
    for (const k of keys.slice(0, keys.length - MAX)) delete map[k];
  }
}
function size(map) { return Object.keys(map).length; }

module.exports = { cachePathFor, hashKey, load, save, get, set, size, DEFAULT_TTL_MS, MAX };