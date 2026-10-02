/**
 * locale.js — 唯一的 locale 规范化 / 准入实现（双端纯函数，无 I/O）。
 *
 * ownership 契约（Runtime Foundation / i18n substrate v1）：
 *   config.uiLang = canonical persisted locale（main 权威，持久值只允许 ADMITTED_LOCALES）
 *   main = locale authority + catalog source
 *   renderer = 经 IPC 投影的 effective locale/dictionary 消费者（不持久化语言、不 import locale 文件）
 *
 * normalizeLocale：宽输入 → canonical ID（zh/en/ja/ko）；ko 仅为 Phase 6 预备，
 *   本阶段 config admission（isAdmittedLocale）不接受 ko，也不接受任何未知/区域变体。
 * 隐式 system-locale 行为不做（跟随系统未来以显式 canonical 值 "system" 立项，见 Phase 0 报告）。
 */
"use strict";

const DEFAULT_LOCALE = "zh";

/** normalizeLocale 可识别并归一到的全部 canonical ID（含尚未开放的 ko）。 */
const KNOWN_LOCALES = ["zh", "en", "ja", "ko"];

/** config 持久化准入白名单：与产品实际提供的语言一致（Phase 6 加入 ko）。 */
const ADMITTED_LOCALES = ["zh", "en", "ja"];

/** language-family 前缀 → canonical ID（按最长特异前缀无歧义前缀匹配）。 */
const FAMILY_RULES = [
  ["zh", /^zh/],
  ["en", /^en/],
  ["ja", /^ja/],
  ["ko", /^ko/]
];

/**
 * 任意输入 → canonical locale ID。
 * zh/zh-CN/zh-SG/zh-TW/zh-HK → zh；en/en-US/en-GB → en；ja/ja-JP → ja；
 * ko/ko-KR → ko；unknown/null/undefined/空 → DEFAULT_LOCALE。
 * 大小写不敏感，下划线（如 en_US）视同连字符。
 */
function normalizeLocale(value) {
  const s = String(value === null || value === undefined ? "" : value).trim().toLowerCase().replace(/_/g, "-");
  if (!s) return DEFAULT_LOCALE;
  if (KNOWN_LOCALES.includes(s)) return s;
  for (const [id, re] of FAMILY_RULES) if (re.test(s)) return id;
  return DEFAULT_LOCALE;
}

/** config admission：仅白名单内 canonical ID 可持久化（ko/unknown 一律拒绝）。 */
function isAdmittedLocale(value) {
  return ADMITTED_LOCALES.includes(String(value));
}

module.exports = { DEFAULT_LOCALE, KNOWN_LOCALES, ADMITTED_LOCALES, normalizeLocale, isAdmittedLocale };
