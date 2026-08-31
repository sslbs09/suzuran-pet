/**
 * vector-memory.js — 向量记忆 v1（§14 追加 102，纯逻辑可单测）
 * SillyTavern「Vector Storage」思想的零依赖轻量版：
 * - 本地哈希向量（字符 unigram + bigram → 512 维计数向量，L2 归一），无外部模型/依赖；
 * - 按语义相似度检索历史对话片段，回引任意细节（"上次她说感冒了"类）；
 * - 存储 userData/memory-vector.json，可注入加密器（与 memory.js 同款 safeStorage/DPAPI）；
 * - 相似去重 + 条数封顶（只留最近）+ 检索余弦 top-k。
 * 与规则事实（memory.js）互补：规则覆盖结构化事实，向量覆盖自由文本细节。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const config = require("./config");

const VEC_PATH = path.join(config.STORAGE.userDir, "memory-vector.json");
const DIM = 512;          // 向量维度
const MAX_ENTRIES = 300;  // 条目封顶（最近优先）
const DEDUP_MIN = 0.82;   // 余弦 ≥ 此值视为重复，不重复入库
const MIN_TEXT = 6;       // 短于该长度的消息不记忆（避免噪音）
const MAX_SAVE_TEXT = 120; // 单条存储文本上限

let cache = null;   // { entries: [{text, vec, ts}] }
let enc = null;     // { encrypt(str)->str, decrypt(str)->str }，由 main.js 注入

function init(crypto) {
  if (crypto && typeof crypto.encrypt === "function" && typeof crypto.decrypt === "function") enc = crypto;
}

function djb2(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

/** 文本 → 512 维计数向量（unigram 字 + bigram 相邻二字），L2 归一；空文本返回空向量 */
function hashEmbed(text) {
  const v = new Float64Array(DIM);
  const chars = [...String(text || "").toLowerCase()].filter((c) => !/\s/.test(c));
  if (!chars.length) return v;
  for (let i = 0; i < chars.length; i++) {
    v[djb2(chars[i]) % DIM] += 1;
    if (i + 1 < chars.length) v[djb2(chars[i] + chars[i + 1]) % DIM] += 2;
  }
  let norm = 0;
  for (let i = 0; i < DIM; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < DIM; i++) v[i] /= norm;
  return v;
}

function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < DIM; i++) dot += a[i] * b[i];
  return dot;
}

function load() {
  if (cache) return cache;
  cache = { entries: [] };
  try {
    let raw = fs.readFileSync(VEC_PATH, "utf8").replace(/^﻿/, "").trim();
    let obj = null;
    if (!raw) { /* 空文件 */ }
    else if (raw.startsWith("{")) obj = JSON.parse(raw);
    else if (enc) obj = JSON.parse(enc.decrypt(raw));
    else throw new Error("vector-memory: 加密不可用且文件非明文");
    if (obj && Array.isArray(obj.entries)) {
      cache.entries = obj.entries
        .filter((e) => e && typeof e.text === "string" && Array.isArray(e.vec) && e.vec.length === DIM)
        .slice(-MAX_ENTRIES);
      if (raw.startsWith("{") && enc) save(); // 明文迁移为加密
    }
  } catch { cache = { entries: [] }; } // 损坏/解密失败 → 空库（不影响主流程）
  return cache;
}

function save() {
  try {
    fs.mkdirSync(path.dirname(VEC_PATH), { recursive: true });
    const data = JSON.stringify({ entries: cache.entries });
    fs.writeFileSync(VEC_PATH, enc ? enc.encrypt(data) : data, "utf8");
  } catch { /* 记忆写失败不影响主流程 */ }
}

/** 入库一条文本（语义去重 + 封顶）；文本过短跳过；返回是否新增 */
function add(text) {
  const t = String(text || "").trim();
  if (t.length < MIN_TEXT) return false;
  const mem = load();
  const vec = hashEmbed(t);
  if (mem.entries.some((e) => cosine(e.vec, vec) >= DEDUP_MIN)) return false;
  mem.entries.push({ text: t.slice(0, MAX_SAVE_TEXT), vec: Array.from(vec), ts: Date.now() });
  if (mem.entries.length > MAX_ENTRIES) mem.entries = mem.entries.slice(-MAX_ENTRIES);
  save();
  return true;
}

/** 检索与 query 最相似的 k 条历史片段（score 降序；库空返回空数组） */
function search(query, k = 3) {
  const mem = load();
  if (!mem.entries.length) return [];
  const q = hashEmbed(query);
  const scored = mem.entries
    .map((e) => ({ text: e.text, score: cosine(e.vec, q), ts: e.ts }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, k));
  // 低相似度（<0.10）视为无关，不回引。v1 哈希 embedding 对"换说法"泛化弱
  // （实测：直接词重叠 0.30、换说法 0.06-0.13、无关 0.05）——v2.5.22 收紧 0.06→0.10：
  // 原 0.06 与无关 0.05 几乎贴边，弱相关片段被塞进 prompt；0.10 保留真实换说法、滤掉无关。
  return scored.filter((s) => s.score >= 0.10);
}

function getCount() { return load().entries.length; }

function clear() {
  cache = { entries: [] };
  save();
}

module.exports = { init, hashEmbed, cosine, add, search, getCount, clear, DIM, MAX_ENTRIES, DEDUP_MIN };