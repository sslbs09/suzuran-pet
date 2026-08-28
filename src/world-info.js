/**
 * world-info.js — 世界书 / 情境按需注入（§14 追加 102，纯逻辑可单测）
 * SillyTavern 系"world info"的轻量版：按用户消息命中关键词才激活对应情境块，
 * 注入 system 引导回复贴合情境——相比全量注入省 token 且更贴切。
 * 条目内容与 persona 保持一致（情境引导，不新增设定），v0 内置，留扩展位。
 */
"use strict";

/** 内置世界书条目（keywords 命中任一即激活该条；最多激活 2 条） */
const BOOKS = [
  {
    name: "办公忙碌",
    keywords: ["工作", "加班", "代码", "程序", "项目", "会议", "报告", "写稿", "写方案", "开会", "搬砖", "码代码"],
    content: "博士正在忙正事（写代码/项目/开会），你在旁边安静陪伴：可以轻轻关心、送上一句" +
             "鼓励或提醒休息，但不要拉着他聊天、不要要求他分心陪你。",
  },
  {
    name: "身体不适",
    keywords: ["感冒", "发烧", "吃药", "药", "不舒服", "生病", "嗓子疼", "咳嗽", "头痛", "头疼", "胃疼", "失眠", "过敏", "难受"],
    content: "博士身体不舒服，你作为医疗干员要认真履行职责：温柔关心症状、叮嘱吃药休息，" +
             "适当拿出医师的专业感，但别啰嗦说教。",
  },
  {
    name: "深夜守候",
    keywords: ["晚上", "夜深", "晚安", "睡不着", "失眠了", "熬夜", "凌晨", "睡觉"],
    content: "现在是深夜，博士还醒着或准备休息：你轻声守着他，语气放软，劝他早点休息，" +
             "带着陪伴感而不是催促感。",
  },
  {
    name: "用餐时间",
    keywords: ["吃饭", "午饭", "晚饭", "夜宵", "外卖", "吃什么", "早餐", "吃了没", "好饿", "奶茶", "咖啡"],
    content: "到了吃饭/点餐的语境：自然关心博士吃了没、推荐或调侃吃点什么，语气轻快。",
  },
  {
    name: "低落安慰",
    keywords: ["难过", "焦虑", "压力", "很烦", "好烦", "累", "好累", "emo", "想哭", "委屈", "没精神", "撑不住"],
    content: "博士心情低落/压力大：先共情接住他的情绪，再温柔宽慰，给一点点安全感，" +
             "不要讲大道理、不要强行逗他开心。",
  },
];

/**
 * 按文本激活世界书条目。
 * @param {string} text 用户消息
 * @param {Array} books 可注入条目列表（默认内置）
 * @param {number} max 最多激活条数
 * @returns {Array<string>} 激活条目的 content（无命中返回空数组）
 */
function activeWorldInfos(text, books = BOOKS, max = 2) {
  const t = String(text || "");
  if (!t.trim()) return [];
  const hit = [];
  for (const b of books) {
    if (!b || !Array.isArray(b.keywords) || !b.content) continue;
    if (b.keywords.some((k) => k && t.includes(k))) hit.push(b.content);
    if (hit.length >= max) break;
  }
  return hit;
}

module.exports = { BOOKS, activeWorldInfos };