/**
 * history.js — 会话历史：滚动窗口 + JSONL 持久化
 */
"use strict";

const fs = require("fs");
const path = require("path");
const storage = require("./storage");
const config = require("./config");

const HISTORY_FILE = storage.PATHS.history;
const DATA_DIR = path.dirname(HISTORY_FILE);

function load() {
  const rows = [];
  try {
    for (const line of fs.readFileSync(HISTORY_FILE, "utf8").split("\n")) {
      if (line.trim()) { try { rows.push(JSON.parse(line)); } catch {} }
    }
  } catch { /* 首次运行 */ }
  return rows;
}

function append(entry) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(HISTORY_FILE, JSON.stringify(entry) + "\n", "utf8");
  } catch { /* 持久化失败不影响使用 */ }
}

/** 取最近 N 轮的对话（按 mode 过滤） */
function recent(mode, maxTurns) {
  const rows = load();
  const filtered = rows.filter((r) => r.mode === mode && r.role);
  return filtered.slice(-(maxTurns * 2)); // N 轮 = N 条 user + N 条 assistant
}

/** 更新最后一条匹配的会话消息（Swipes：多版本切换/重新生成）；fn(entry) 原地修改，返回该条或 null。
 *  JSONL 是追加式，本函数做全量重写（会话量级几百 KB，可接受）；调用方负责节流。 */
function updateLast(mode, role, fn) {
  const rows = load();
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.mode === mode && r.role === role) {
      fn(r);
      try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        const tmp = HISTORY_FILE + ".tmp";
        fs.writeFileSync(tmp, rows.map((x) => JSON.stringify(x)).join("\n") + "\n", "utf8");
        fs.renameSync(tmp, HISTORY_FILE);
      } catch { return null; }
      return r;
    }
  }
  return null;
}

module.exports = { load, append, recent, updateLast };
