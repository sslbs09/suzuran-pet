/**
 * settings-patch.js — pet:save-settings 渲染层 patch 白名单过滤（v2.5.23 抽取，复审架构建议）
 * 纯函数：不依赖 Electron，可单测（tests/settings-patch.test.js）。
 * 行为与 v2.5.22 白名单一致，修复复审新-1：secrets 放行——secrets 走 DPAPI 通道
 * 不入 config.json，且提取只认三个已知槽位的 replace action，放行无 RCE 风险。
 */
"use strict";

/** 设置页实际可改的键。ttsGenie/ttsGsv 的 python/serverScript 是设置页语音部署区的
 *  合法配置（用户主动填的引擎路径，保留）；secrets 走 DPAPI 不落 config，放行安全。 */
const ALLOWED_TOP = new Set([
  "pet", "chat", "window", "features", "agentApi", "uiLang", "hotkey", "startHidden",
  "renderMode", "walking", "walkSeatSink", "walkTiming", "rigScale", "rigMouseFollow",
  "mouseTrackGlobal", "catToy", "fileGuard", "proactiveChat", "personify", "rpMode",
  "dimMode", "greetingOnStart", "security", "spineSkinId", "tts", "ttsCloud", "ttsCosy",
  "ttsGenie", "ttsGsv", "moods", "emotionalVoice", "emotionVoice", "live2dScale",
  "autoLaunch", "walkGlobal", "walkSpeed", "proactiveMin", "agentClients",
  "secrets"
]);

/** 渲染层从不提交、仅 config.json 直改的键：禁止经 IPC 写入（P0-1 RCE 链封堵） */
const BLOCKED_TOP = new Set(["zcodeCli", "workspace", "zcodeEnabled", "translateApi"]);

/**
 * 过滤 + 提取：
 * @param {Object} patch 渲染层原始 patch
 * @returns {{patch:Object, secrets:Object, autoLaunch:(boolean|undefined),
 *            blocked:string[], unknown:string[]}}
 *  - patch：白名单过滤后可安全写 config.json 的部分（secrets/autoLaunch 已移除）
 *  - secrets：三个已知槽位的 replace action 提取值（供 replaceSecrets；空串=清除）
 *  - autoLaunch：patch 带 autoLaunch 时为布尔值（系统级不入 config），否则 undefined
 *  - blocked：被黑名单拦截的键；unknown：不在白名单被丢弃的键（均用于日志留痕）
 */
function filterSettingsPatch(patch) {
  const src = patch && typeof patch === "object" ? patch : {};
  const out = { ...src };
  const blocked = [];
  const unknown = [];
  for (const key of Object.keys(out)) {
    if (BLOCKED_TOP.has(key)) { delete out[key]; blocked.push(key); }
    else if (!ALLOWED_TOP.has(key)) { delete out[key]; unknown.push(key); }
  }
  // secrets 提取：只认三个已知槽位 + replace action，其余忽略（不落盘不入 config）
  const secretPatch = out.secrets && typeof out.secrets === "object" ? out.secrets : {};
  delete out.secrets;
  const secrets = {};
  if (secretPatch.chatApiKey && secretPatch.chatApiKey.action === "replace") secrets.chatApiKey = String(secretPatch.chatApiKey.value || "");
  if (secretPatch.ttsCosyApiKey && secretPatch.ttsCosyApiKey.action === "replace") secrets.ttsCosyApiKey = String(secretPatch.ttsCosyApiKey.value || "");
  if (secretPatch.agentBearerToken && secretPatch.agentBearerToken.action === "replace") secrets.agentBearerToken = String(secretPatch.agentBearerToken.value || "");
  // 兼容：chat.apiKey / ttsCosy.apiKey / agentApi.bearerToken 顶层写法也挪进 secrets
  if (out.chat && Object.prototype.hasOwnProperty.call(out.chat, "apiKey")) {
    secrets.chatApiKey = String(out.chat.apiKey || "");
    delete out.chat.apiKey;
  }
  if (out.ttsCosy && Object.prototype.hasOwnProperty.call(out.ttsCosy, "apiKey")) {
    secrets.ttsCosyApiKey = String(out.ttsCosy.apiKey || "");
    delete out.ttsCosy.apiKey;
  }
  if (out.agentApi && String(out.agentApi.bearerToken || "").trim()) {
    secrets.agentBearerToken = String(out.agentApi.bearerToken);
    delete out.agentApi.bearerToken;
  }
  let autoLaunch;
  if (Object.prototype.hasOwnProperty.call(out, "autoLaunch")) {
    autoLaunch = !!out.autoLaunch;
    delete out.autoLaunch;
  }
  return { patch: out, secrets, autoLaunch, blocked, unknown };
}

module.exports = { filterSettingsPatch, ALLOWED_TOP, BLOCKED_TOP };
