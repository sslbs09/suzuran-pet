/**
 * SuzuranPet 界面国际化 substrate（中文 / English / 日本語；韩语于 Phase 6 接入）
 *
 * ownership（与 src/locale.js 契约一致）：
 *   - config.uiLang 是唯一持久语言值（main 权威，经 normalizeLocale/admission 收口）
 *   - main native surfaces（托盘/对话框/通知）直接 require 本模块翻译
 *   - 渲染层经 IPC pet:get-i18n 领取 { lang, dict: effectiveDict }，用 window.I18N.t()/apply() 消费；
 *     renderer 不 import locale 文件、不持久化语言
 *   - 聊天内容 / 角色台词（src/lines.js、persona*、ja-translate.js、voice-refs.json）属于
 *     CHARACTER CONTENT 独立层，不进入本 catalog；本模块也不 import 角色内容模块
 *
 * catalog：src/locales/{zh,en,ja}.json（2026-10-03 自旧内联 DICT 机械搬迁，逐键等价验证）。
 * effective dictionary：zh base + selected overlay —— selected 缺 key 时 renderer 收到的
 *   effective dict 已回落 zh，保证"缺键绝不跨语言泄漏"。
 */
"use strict";

const { DEFAULT_LOCALE, normalizeLocale } = require("./locale");

const DICT = {
  zh: require("./locales/zh.json"),
  en: require("./locales/en.json"),
  ja: require("./locales/ja.json")
};

const effectiveCache = new Map(); // canonical locale → effective dict（zh base + overlay，进程级缓存）

/** 进程内 catalog 被替换/修补后重建 effective 缓存（Phase 6 语言热接入复用；生产常规路径无需调用）。 */
function resetEffectiveCache() {
  effectiveCache.clear();
}

function getDict(lang) {
  const id = normalizeLocale(lang);
  return DICT[id] || DICT[DEFAULT_LOCALE];
}

/**
 * 有效词典：{...zh, ...selected}。selected 为 zh 时即 zh 本身（同一引用）；
 * selected 缺 key → zh 值透出（缺键回落唯一指向 default，绝不指向相邻语言）。
 */
function getEffectiveDict(lang) {
  const id = normalizeLocale(lang);
  const sel = DICT[id] ? id : DEFAULT_LOCALE;
  if (sel === DEFAULT_LOCALE) return DICT[DEFAULT_LOCALE];
  let eff = effectiveCache.get(sel);
  if (!eff) {
    eff = Object.assign({}, DICT[DEFAULT_LOCALE], DICT[sel]);
    effectiveCache.set(sel, eff);
  }
  return eff;
}

/** {name}/{level} 占位符替换；未提供的参数保留原样占位（不吞不炸）。 */
function fillParams(str, params) {
  if (!params || typeof params !== "object") return str;
  return String(str).replace(/\{(\w+)\}/g, (m, k) => (params[k] !== undefined ? String(params[k]) : m));
}

/**
 * 翻译：normalize → effective dict（zh base + selected overlay：selected 优先、缺键 zh 兜底）
 *   → key fail-safe（不 throw）。
 * 第三参兼容两种形态：object = {name:...} 插值参数；string = 旧式 fallback 文案。
 * 正常 parity 下不应命中 fail-safe；命中即记 warning（INTERNAL 级，供开发期发现）。
 */
function t(lang, key, fallbackOrParams) {
  const d = getEffectiveDict(lang);
  const hit = d[key] !== undefined;
  if (!hit) console.warn("[i18n] missing key:", key, "lang:", normalizeLocale(lang));
  const raw = hit ? d[key] : (typeof fallbackOrParams === "string" ? fallbackOrParams : key);
  return fillParams(raw, typeof fallbackOrParams === "object" && fallbackOrParams !== null ? fallbackOrParams : null);
}

module.exports = { DICT, getDict, getEffectiveDict, resetEffectiveCache, t };
