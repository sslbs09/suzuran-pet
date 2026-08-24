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

module.exports = { load, append, recent };
