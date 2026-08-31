/**
 * history.js — 会话历史：滚动窗口 + JSONL 持久化
 * v2.5.23（P1-5）：内存滚动窗口——首次 load 后常驻，append/updateLast 同步维护，
 * 消除每次 recent() 全量 readFileSync+逐行 parse（长聊延迟恶化）；文件上限 MAX_ROWS
 * 条，超限裁掉最旧并重写（recent("chat",999) 全量计数改走 count()）。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const storage = require("./storage");
const config = require("./config");

const HISTORY_FILE = storage.PATHS.history;
const DATA_DIR = path.dirname(HISTORY_FILE);
const MAX_ROWS = 4000;     // 滚动窗口上限（≈2000 轮对话，足够长聊）
const TRIM_TO = 3000;      // 超限后保留条数（留 1000 条余量，避免每轮都重写文件）

let cache = null; // { rows: [], loaded: false } 内存滚动窗口

function loadFromDisk() {
  const rows = [];
  try {
    for (const line of fs.readFileSync(HISTORY_FILE, "utf8").split("\n")) {
      if (line.trim()) { try { rows.push(JSON.parse(line)); } catch {} }
    }
  } catch { /* 首次运行 */ }
  return rows;
}

function ensureLoaded() {
  if (!cache) cache = { rows: loadFromDisk(), loaded: true };
  return cache;
}

function load() { return ensureLoaded().rows.slice(); }

function rewrite(rows) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = HISTORY_FILE + ".tmp";
    fs.writeFileSync(tmp, rows.map((x) => JSON.stringify(x)).join("\n") + "\n", "utf8");
    fs.renameSync(tmp, HISTORY_FILE);
  } catch { /* 重写失败下次再试（内存窗口不受影响） */ }
}

/** 超限截断：内存窗口 > MAX_ROWS 时裁掉最旧至 TRIM_TO 并同步重写文件 */
function trim(c) {
  if (c.rows.length <= MAX_ROWS) return;
  c.rows.splice(0, c.rows.length - TRIM_TO);
  rewrite(c.rows);
}

function append(entry) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(HISTORY_FILE, JSON.stringify(entry) + "\n", "utf8");
    const c = ensureLoaded();
    c.rows.push(entry);
    trim(c);
  } catch { /* 持久化失败不影响使用 */ }
}

/** 取最近 N 轮的对话（按 mode 过滤，内存过滤替代全量读盘） */
function recent(mode, maxTurns) {
  const rows = ensureLoaded().rows;
  const filtered = rows.filter((r) => r.mode === mode && r.role);
  return filtered.slice(-(maxTurns * 2)); // N 轮 = N 条 user + N 条 assistant
}

/** 按 mode 计数（仅 role 消息）——替代 recent("chat",999).length 的全量读盘计数 */
function count(mode) {
  let n = 0;
  for (const r of ensureLoaded().rows) if (r.mode === mode && r.role) n++;
  return n;
}

/** 更新最后一条匹配的会话消息（Swipes：多版本切换/重新生成）；fn(entry) 原地修改，返回该条或 null。
 *  JSONL 是追加式，本函数做全量重写（会话量级几百 KB，可接受）；调用方负责节流。 */
function updateLast(mode, role, fn) {
  const c = ensureLoaded();
  const rows = c.rows;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.mode === mode && r.role === role) {
      fn(r);
      rewrite(rows);
      trim(c);
      return r;
    }
  }
  return null;
}

module.exports = { load, append, recent, count, updateLast };
