"use strict";
const config = require("./config");
const { logTts } = require("./logger");

// 翻译缓存（简单 LRU）：相同文本不重复调 API——减少上游限流(429)压力，也加快重复句响应。
// 统一 90s TTL：成功译文 90s 内复用；失败（含空串）90s 后失效重试，避免限流恢复后一直卡中文。
const CACHE_MAX = 200;
const CACHE_TTL = 600000; // cost-cut reuse 10min
const cache = new Map();
function cacheGet(text) {
  const hit = cache.get(text);
  if (hit) {
    if (Date.now() - hit.t > CACHE_TTL) { cache.delete(text); return undefined; }
    cache.delete(text); cache.set(text, hit); return hit.ja; // 命中后移到队尾（LRU）
  }
  return undefined;
}
function cacheSet(text, ja) {
  if (cache.has(text)) cache.delete(text);
  cache.set(text, { ja, t: Date.now() });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

/**
 * 中日翻译（日语语音模式）：把中文翻译成自然口语的日语；失败/空结果自动重试一次；
 * 全部失败返回空串（调用方回退中文合成）。
 * 限流(429)按服务端 retryAfterSeconds 等待（上限 90s，覆盖常见 60s 限流窗口）。
 */
let trDisk = null;
function ensureTrDisk() {
  if (!trDisk) {
    const tc = require("./translate-cache");
    trDisk = { userDir: config.STORAGE.userDir, map: tc.load(config.STORAGE.userDir) };
  }
  return trDisk;
}
async function translateToJa(text) {
  const cfg = config.getConfig();
  const c = cfg.chat || {};
  if (!c.apiKey || !c.baseUrl) return "";
  const cached = cacheGet(String(text || ""));
  if (cached !== undefined) return cached; // 命中缓存直接返回（含空串=上次失败，90s 后失效重试）
  // cost-cut: disk cache (cross-session) reuse
  const tc = require("./translate-cache");
  {
    const d = ensureTrDisk();
    const dja = tc.get(d.map, text);
    if (dja !== undefined) return dja;
  }
  const base = String(c.baseUrl || "").replace(/\/+$/, "");
  const sys = "你是中日翻译器。把用户输入的中文翻译成自然流畅、口语化的日语。只输出译文本身，不要任何解释、引号或多余内容。强制术语：任何‘博士’一律输出为日语片假名 ドクター（玩家称呼，发音 do-ku-tā，对应游戏里的“刀客塔”），不得输出日语汉字‘博士’，也不得输出英文 doctor。";
  const isAnthropic = String(c.apiType || "openai") === "anthropic"; // v2.5.2：兼容 anthropic 协议（聚合站常配 anthropic 通道）
  for (let attempt = 1; attempt <= 2; attempt++) {
    let retryWaitMs = 1200;
    try {
      const url = isAnthropic
        ? (base + "/v1/messages")
        : (base + "/chat/completions");
      const headers = isAnthropic
        ? { "Content-Type": "application/json", "x-api-key": c.apiKey, "anthropic-version": "2023-06-01" }
        : { "Content-Type": "application/json", "Authorization": "Bearer " + c.apiKey };
      const body = isAnthropic
        ? JSON.stringify({
            model: (c.translateApi && c.translateApi.model) || c.model || "claude-3-5-sonnet-20241022",
            system: sys,
            messages: [{ role: "user", content: String(text || "").slice(0, 200) }],
            temperature: 0.3,
            max_tokens: 640
          })
        : JSON.stringify({
            model: (c.translateApi && c.translateApi.model) || c.model || "deepseek-chat",
            messages: [
              { role: "system", content: sys },
              { role: "user", content: String(text || "").slice(0, 200) }
            ],
            temperature: 0.3,
            max_tokens: 640, // 推理模型（如 deepseek-v4-flash）先消耗思考 token，太小会截断到 content 为空
            stream: false
          });
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(45000)
      });
      if (!resp.ok) {
        const raw = await resp.text();
        const t = raw.slice(0, 120);
        if (resp.status === 429) { // 限流：按服务端 retryAfterSeconds 等待（上限 90s），否则 1.2s 后重试必再 429
          try {
            const j = JSON.parse(raw); // 完整 body 解析（slice 截断会导致解析失败退回 1.2s）
            const ra = Number(j && j.data && j.data.retryAfterSeconds);
            if (Number.isFinite(ra) && ra > 0) retryWaitMs = Math.min(90000, Math.max(1000, Math.round(ra * 1000)));
          } catch { /* 忽略 */ }
        }
        logTts("ja", "翻译 HTTP " + resp.status + (attempt < 2 ? "，" + retryWaitMs + "ms 后重试" : "") + ": " + t);
      } else {
        const j = await resp.json();
        const out = isAnthropic
          ? String((j && j.content && j.content[0] && j.content[0].text) || "").trim()
          : String((j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "").trim();
        const forced = out.replace(/博士/g, "ドクター").replace(/\b[Dd]octor\b/g, "ドクター");
        if (forced && forced.length > 0 && forced.length < 400) {
          cacheSet(String(text || ""), forced);
          const d = ensureTrDisk();
          tc.set(d.map, text, forced);
          tc.save(d.userDir, d.map);
          return forced;
        }
        logTts("ja", "翻译返回为空" + (attempt < 2 ? "，重试" : ""));
      }
    } catch (e) {
      logTts("ja", "翻译异常(" + attempt + "): " + (e && e.message || e));
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, retryWaitMs));
  }
  cacheSet(String(text || ""), ""); // 失败也缓存（90s TTL）：限流窗口内不反复撞，恢复后自动重试
  return "";
}

module.exports = { translateToJa };
