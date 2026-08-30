/* ============================================================
 * 长期记忆（v2.5 RP 优化）
 * 让苏苏洛"记得"博士：称谓/喜好/生日/健康/近期状态 + 每 20 轮 LLM 摘要。
 * 数据仅存本地 userData/memory.json，不联网上传；受设置项 features.longTermMemory 控制。
 * 设计约束（避免记忆污染）：
 * - 只提取规则明确、表达清晰的陈述，宁缺毋滥；
 * - 事实去重（同类型文本重叠 >60% 丢弃）、总数封顶、只保留最近的；
 * - 注入文本短小（<400 字），不影响主提示词权重。
 * ============================================================ */
"use strict";

const fs = require("fs");
const path = require("path");
const config = require("./config");

const MEMORY_PATH = path.join(config.STORAGE.userDir, "memory.json");
const MAX_FACTS = 30;       // 事实条数封顶
const MAX_FACTS_INJECT = 12; // 注入条数
const MAX_SUMMARY_LEN = 300; // 摘要长度封顶
const MAX_TEXT_LEN = 120;    // 单条事实文本封顶

/* 记忆锚点分类（借鉴 RhodesLink）：把事实归入结构化锚点，注入时分组带标签，模型更易正确使用 */
const ANCHOR_LABEL = { PLAN: "计划", PREFERENCE: "偏好", TABOO: "禁忌", EVENT: "重要日子", EMOTION: "情绪状态", RELATION: "关系身份" };
function anchorOf(type) {
  const map = { name: "RELATION", birthday: "EVENT", pref: "PREFERENCE", health: "EMOTION", event: "PLAN", avoid: "TABOO", pet: "PREFERENCE", job: "RELATION" };
  return map[type] || "PREFERENCE";
}

let cache = null;
let enc = null;      // { encrypt(str)->str, decrypt(str)->str }，由 main.js 注入 safeStorage/DPAPI
let tamperFlag = false; // 上次加载是否发现损坏/被篡改（解密失败或格式异常）
let lastLoadError = "";   // 上次加载失败的底层原因（供诊断：区分空文件与真损坏）
let lastHadData = false;  // 加载失败时文件是否有内容（空文件首启不视为篡改）

/** v2.5.2：由主进程注入加密器（safeStorage/DPAPI）。未注入时降级明文（仅开发/测试环境）。 */
function init(crypto) {
  if (crypto && typeof crypto.encrypt === "function" && typeof crypto.decrypt === "function") enc = crypto;
}

function load() {
  if (cache) return cache;
  cache = { facts: [], summary: "" };
  let raw = "";
  try {
    raw = fs.readFileSync(MEMORY_PATH, "utf8").replace(/^﻿/, "").trim(); // 容忍 BOM
    let obj = null;
    if (!raw) { /* 空文件：全新记忆 */ }
    else if (raw.startsWith("{")) obj = JSON.parse(raw); // 旧版明文（迁移）
    else if (enc) obj = JSON.parse(enc.decrypt(raw));    // v2.5.2 加密存储
    else throw new Error("memory: 加密不可用且文件非明文");
    if (obj) {
      if (Array.isArray(obj.facts)) cache.facts = obj.facts.filter((f) => f && f.text);
      if (typeof obj.summary === "string") cache.summary = obj.summary;
      if (raw.startsWith("{") && enc) save(); // 旧版明文 → 立即迁移为加密存储
    }
  } catch (e) {
    // 解密失败/JSON 损坏：视为被篡改或损坏 → 重置为空，交由调用方提示
    cache = { facts: [], summary: "" };
    tamperFlag = true;
    lastLoadError = String((e && e.message) || e);
    lastHadData = raw.length > 0; // 文件原本有内容才是真异常；纯首启空文件不计
  }
  return cache;
}

function save() {
  try {
    fs.mkdirSync(path.dirname(MEMORY_PATH), { recursive: true });
    const data = JSON.stringify({ facts: cache.facts, summary: cache.summary });
    const out = enc ? enc.encrypt(data) : data;
    fs.writeFileSync(MEMORY_PATH, out, "utf8");
  } catch { /* 记忆写失败不影响主流程（内存态仍可用） */ }
}

/** 读取并返回是否发现过损坏/篡改（一次性标记，读取后清除） */
function wasTampered() {
  const f = tamperFlag;
  tamperFlag = false;
  return f;
}

function newFactId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/** 简单去重：新事实与已有事实文本重叠比例 */
function similar(a, b) {
  if (!a || !b) return false;
  const s = a.length <= b.length ? a : b;
  const l = a.length >= b.length ? a : b;
  if (!l) return false;
  let hit = 0;
  for (let i = 0; i + s.length <= l.length; i++) if (l.slice(i, i + s.length) === s) { hit = s.length; break; }
  return hit / l.length > 0.6;
}

/** 规则式事实提取（保守，宁缺毋滥；返回 {type,text}[]） */
function extractFacts(text) {
  const t = String(text || "").slice(0, 200);
  if (t.length < 2) return [];
  const facts = [];
  let m;
  // 称谓：叫我X（X 后必须紧跟 就好/就行/吧/啊/标点/句末，避免吞入后缀词）
  m = t.match(/叫我([\u4e00-\u9fa5A-Za-z0-9]{1,6}?)(?:就好|就行|吧|啊|，|,|。|\.|$)/);
  if (m) facts.push({ type: "name", text: "博士希望我称呼他为「" + m[1] + "」" });
  // 生日：X月X日（含"我生日"）
  m = t.match(/(?:生日|生日是|生日在)(?:是|在)?(\d{1,2})月(\d{1,2})日/);
  if (m) facts.push({ type: "birthday", text: "博士的生日是" + Number(m[1]) + "月" + Number(m[2]) + "日" });
  // 喜好：我喜欢/最爱 X（动词不收入；X 至少 2 字）
  m = t.match(/(?:我|人家)(?:最)?(?:喜欢|爱)(?:喝|吃|玩|看|听|学)?([\u4e00-\u9fa5A-Za-z0-9]{2,12})/);
  if (m && !/^(生日|这|那|你|我)/.test(m[1])) facts.push({ type: "pref", text: "博士喜欢「" + m[1] + "」" });
  // 健康状态（临时关心点）
  m = t.match(/(?:我)?(感冒|发烧|头疼|头痛|腰疼|胃疼|胃痛|失眠|不舒服|嗓子疼|咳嗽|过敏|扭到|熬夜|压力大|很累)/);
  if (m) facts.push({ type: "health", text: "博士最近" + m[1] + "（要记得关心）" });
  // 近期安排（只记安排类型，不猜上下文）：要/准备/正在 + 考试|面试|答辩|出差|加班|手术|旅行|汇报
  m = t.match(/(?:要|准备|正在|将)(?:去|参加|做|写|复习|准备)?(?:一个|一场|一次)?(考试|面试|答辩|出差|加班|手术|旅行|汇报|竞标|论文)/);
  if (m) facts.push({ type: "event", text: "博士近期有「" + m[1] + "」的安排" });
  // 忌口：不吃/不能吃/忌口 X（X 至少 2 字；"不吃了"结尾词不误收）
  m = t.match(/(?:我)?(?:不能|不吃|忌口|讨厌)(?:吃|喝)?([一-龥A-Za-z0-9]{2,8})/);
  if (m) facts.push({ type: "avoid", text: "博士不吃/不能吃「" + m[1] + "」" });
  // 宠物：养了/有只/家里有 + 常见宠物名
  m = t.match(/(?:我)?(?:养了|有只?|家里有)(?:一?只?)?((?:猫|狗|兔|龟|鸟|鱼|仓鼠|龙猫|刺猬)[一-龥A-Za-z0-9]{0,4})/);
  if (m) facts.push({ type: "pet", text: "博士养了「" + m[1] + "」" });
  // 工作/职业（保守：后缀限定）
  m = t.match(/(?:我是|我在|我从事|我的工作是)([一-龥A-Za-z0-9]{2,12}?(?:工程师|设计师|程序员|老师|教师|医生|护士|会计|运营|产品经理|销售|学生|开发|测试|运维|管理|研究员))/);
  if (m) facts.push({ type: "job", text: "博士的职业是「" + m[1] + "」" });
  return facts;
}

/** 新增事实（去重 + 封顶；同一 type 覆盖最近的同类旧事实） */
function addFacts(newFacts) {
  if (!Array.isArray(newFacts) || !newFacts.length) return;
  const mem = load();
  let changed = false;
  for (const f of newFacts) {
    if (!f || !f.text || f.text.length > MAX_TEXT_LEN) continue;
    const text = f.text;
    // 同类已有 → 更新（保持 id 与最新表述；便于设置页删除定位）
    const sameType = mem.facts.findIndex((x) => x.type === f.type);
    if (sameType >= 0) {
      if (mem.facts[sameType].text !== text) {
        mem.facts[sameType] = { id: mem.facts[sameType].id || newFactId(), type: f.type, text, ts: Date.now(), anchor: f.anchor || anchorOf(f.type) };
        changed = true;
      }
      continue;
    }
    if (mem.facts.some((x) => similar(x.text, text))) continue;
    mem.facts.push({ id: newFactId(), type: f.type, text, ts: Date.now(), anchor: f.anchor || anchorOf(f.type) });
    changed = true;
  }
  if (mem.facts.length > MAX_FACTS) mem.facts = mem.facts.slice(-MAX_FACTS);
  if (changed) save();
}

/** 删除单条事实（设置页管理） */
function deleteFact(id) {
  const mem = load();
  const before = mem.facts.length;
  mem.facts = mem.facts.filter((f) => String(f.id || "") !== String(id || ""));
  if (mem.facts.length !== before) save();
}

/** 编辑单条事实（设置页管理，§14 追加 103）：校验长度、更新文本与时间戳；不存在返回 false */
function updateFact(id, text) {
  const t = String(text || "").trim();
  if (!t || t.length > MAX_TEXT_LEN) return false;
  const mem = load();
  const hit = mem.facts.find((f) => String(f.id || "") === String(id || ""));
  if (!hit) return false;
  if (hit.text === t) return true; // 无变化视为成功
  hit.text = t;
  hit.ts = Date.now();
  save();
  return true;
}

/** 清空全部记忆（事实 + 摘要） */
function clear() {
  const mem = load();
  mem.facts = [];
  mem.summary = "";
  save();
}

/** 设置页列表：{id,type,text,anchor}[] */
function getFactsList() {
  return load().facts.map((f) => ({ id: f.id || "", type: f.type || "", text: f.text, anchor: (f.anchor || anchorOf(f.type || "")) }));
}

function getSummary() {
  return load().summary || "";
}

/** 更新第 20 轮 LLM 摘要 */
function updateSummary(summary) {
  const s = String(summary || "").trim();
  if (!s || s.length < 5) return;
  const mem = load();
  mem.summary = s.slice(0, MAX_SUMMARY_LEN);
  save();
}

function hasHealthFact() {
  return load().facts.some((f) => f.type === "health");
}

/** 注入文本：返回可拼到 system prompt 的短记忆块（<400 字） */
function getText() {
  const mem = load();
  const lines = [];
  // 锚点分组（借鉴 RhodesLink）：按【计划/偏好/禁忌/重要日子/情绪状态/关系身份】归类注入，模型更易正确使用
  const byAnchor = new Map();
  for (const f of mem.facts.slice(-MAX_FACTS_INJECT)) {
    const a = f.anchor || anchorOf(f.type || "");
    if (!byAnchor.has(a)) byAnchor.set(a, []);
    byAnchor.get(a).push(f);
  }
  for (const [a, fs] of byAnchor) {
    lines.push("【" + (ANCHOR_LABEL[a] || a) + "】");
    for (const f of fs) {
      const old = f.ts && Date.now() - f.ts > 90 * 86400000;
      lines.push((old ? "（以前提过）" : "") + "- " + f.text);
    }
  }
  const sum = mem.summary.trim();
  if (sum) lines.push("（最近印象：" + sum.slice(0, MAX_SUMMARY_LEN) + "）");
  return lines.length ? "【苏苏洛记得的事】\n" + lines.join("\n") : "";
}

module.exports = { load, save, init, wasTampered, extractFacts, addFacts, deleteFact, updateFact, clear, getFactsList, getSummary, updateSummary, getText, hasHealthFact, anchorOf, ANCHOR_LABEL,
  lastLoadError: () => lastLoadError, lastHadData: () => lastHadData };