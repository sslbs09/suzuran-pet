/* ============================================================
 * 羁绊/好感度（v2.5.13，RP 优化重点项目 B 第二弹）
 * 相处越久、互动越多，她越亲近。数据本地存储 bond.json，不联网。
 * - 聊天/摸头 +1 经验；每日首次互动 +2（连续陪伴天数）
 * - 等级随累计经验提升（1~10），注入人设影响亲密程度
 * - 升级时返回一次性标记，主进程可 toast/说句贴心话
 * ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");
const config = require("./config");

const BOND_PATH = path.join(config.STORAGE.userDir, "bond.json");
// 等级所需累计经验：Lv1=0, Lv2=5, Lv3=15, Lv4=30, Lv5=50, Lv6=80, Lv7=120, Lv8=170, Lv9=230, Lv10=300
const LEVEL_EXP = [0, 5, 15, 30, 50, 80, 120, 170, 230, 300];
const MAX_LEVEL = 10;

let cache = null;
let levelUpFlag = 0; // 本次会话是否刚升级（供调用方提示）

function load() {
  if (cache) return cache;
  cache = { exp: 0, days: 0, lastDay: "", firstDay: "", interactions: 0 };
  try {
    const raw = JSON.parse(fs.readFileSync(BOND_PATH, "utf8"));
    if (Number.isFinite(raw.exp)) cache.exp = Math.max(0, Math.round(raw.exp));
    if (Number.isFinite(raw.days)) cache.days = Math.max(0, Math.round(raw.days));
    if (typeof raw.lastDay === "string") cache.lastDay = raw.lastDay;
    if (typeof raw.firstDay === "string") cache.firstDay = raw.firstDay;
    if (Number.isFinite(raw.interactions)) cache.interactions = Math.max(0, Math.round(raw.interactions));
  } catch { /* 首次使用：空羁绊 */ }
  return cache;
}

function save() {
  try {
    fs.mkdirSync(path.dirname(BOND_PATH), { recursive: true });
    fs.writeFileSync(BOND_PATH, JSON.stringify(cache, null, 1), "utf8");
  } catch { /* 写失败不影响主流程 */ }
}

function todayStr() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

function levelOf(exp) {
  let lv = 1;
  for (let i = 0; i < LEVEL_EXP.length; i++) if (exp >= LEVEL_EXP[i]) lv = i + 1;
  return Math.min(MAX_LEVEL, lv);
}

/** 增加经验：聊天/摸头 +1；每日首次互动额外 +2（连续陪伴天数+1）。返回 { level, leveledUp } */
function addExp(n = 1) {
  const mem = load();
  const before = levelOf(mem.exp);
  mem.exp += Math.max(1, Math.round(n || 1));
  mem.interactions += 1;
  const today = todayStr();
  if (mem.lastDay !== today) {
    mem.lastDay = today;
    if (!mem.firstDay) mem.firstDay = today;
    if (mem.days === 0) mem.days = 1;
    else mem.days += 1;
    mem.exp += 2; // 每日陪伴奖励
  }
  if (mem.exp > 9999) mem.exp = 9999;
  const after = levelOf(mem.exp);
  if (after > before) levelUpFlag = after;
  save();
  return { level: after, leveledUp: after > before };
}

/** 一次性升级标记（主进程读取后清除，用于 toast/贴心话） */
function consumeLevelUp() {
  const v = levelUpFlag;
  levelUpFlag = 0;
  return v;
}

function getLevel() { return levelOf(load().exp); }
function getDays() { return load().days; }

/** 羁绊进度（v2.5.26 设置页进度条）：当前级起点/下一级阈值/百分比 */
function getProgress() {
  const mem = load();
  const lv = levelOf(mem.exp);
  const cur = LEVEL_EXP[lv - 1] || 0;
  const maxed = lv >= MAX_LEVEL;
  const next = maxed ? cur : LEVEL_EXP[lv];
  const pct = maxed ? 100 : Math.max(0, Math.min(100, Math.round(((mem.exp - cur) / Math.max(1, next - cur)) * 100)));
  return { exp: mem.exp, level: lv, cur, next, pct, max: maxed, days: mem.days };
}

/** 注入人设的羁绊描述（随等级变亲密） */
/** 关系阶段：1-3 陌生 / 4-6 熟悉 / 7-9 信赖 / 10+ 誓约 */
function getStage() {
  const lv = getLevel();
  if (lv <= 3) return { key: "ms", name: "陌生" };
  if (lv <= 6) return { key: "fd", name: "熟悉" };
  if (lv <= 9) return { key: "xl", name: "信赖" };
  return { key: "sy", name: "誓约" };
}
function getText() {
  const mem = load();
  const lv = levelOf(mem.exp);
  const days = mem.days;
  let warmth = "";
  if (lv <= 1) warmth = "刚认识不久，还带着干员的职业矜持，但已经愿意多看你几眼";
  else if (lv <= 3) warmth = "慢慢熟悉起来，偶尔会主动关心你，也开始跟你开小玩笑";
  else if (lv <= 5) warmth = "很信任你了，在你面前放松了许多，会撒娇也会小小地闹别扭";
  else if (lv <= 7) warmth = "已经非常依赖你，目光总忍不住跟着你，占有欲也藏不住了";
  else if (lv <= 9) warmth = "你是她最特别的存在，她会在你面前毫无保留地露出软软的一面";
  else warmth = "她认定你了：心里满满都是你，愿意为你做任何事，也只想黏在你身边";
  return `羁绊等级 Lv.${lv}（已陪伴 ${days} 天 · 关系：${getStage().name}）：${warmth}`;
}

module.exports = { addExp, consumeLevelUp, getLevel, getDays, getStage, getText, getProgress, load, save };