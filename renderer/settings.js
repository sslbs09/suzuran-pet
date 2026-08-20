/**
 * 苏苏洛设置窗口逻辑
 * - 读取/保存 config（IPC pet:get-settings / pet:save-settings）
 * - 人设编辑保存 / 恢复默认（pet:save-persona / pet:reset-persona）
 * - 测试连接（pet:test-chat）
 */
"use strict";

const $ = (id) => document.getElementById(id);

const PRESETS = {
  deepseek:     { apiType: "openai",    baseUrl: "https://api.deepseek.com/v1",                model: "deepseek-chat" },
  openai:       { apiType: "openai",    baseUrl: "https://api.openai.com/v1",                  model: "gpt-4o-mini" },
  kimi:         { apiType: "openai",    baseUrl: "https://api.moonshot.cn/v1",                 model: "moonshot-v1-8k" },
  glm:          { apiType: "openai",    baseUrl: "https://open.bigmodel.cn/api/paas/v4",       model: "glm-4-flash" },
  qwen:         { apiType: "openai",    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
  siliconflow:  { apiType: "openai",    baseUrl: "https://api.siliconflow.cn/v1",              model: "deepseek-ai/DeepSeek-V3" },
  ollama:       { apiType: "openai",    baseUrl: "http://localhost:11434/v1",                  model: "qwen2.5:7b" },
  anthropic:    { apiType: "anthropic", baseUrl: "https://api.anthropic.com",                  model: "claude-3-5-haiku-20241022" },
  custom:       null
};

let S = {}; // 当前配置快照

function setResult(el, text, ok) {
  el.textContent = text || "";
  el.className = "result" + (ok ? " ok" : ok === false ? " err" : "");
}

async function toast(msg) {
  console.log("[设置]", msg);
}

/* ---------- 初始化 ---------- */
(async function init() {
  S = await window.petAPI.getSettings();
  document.getElementById("key-source").textContent =
    "API Key 状态：" + (S.keySource || "未知");

  $("api-type").value = S.chat.apiType || "openai";
  $("base-url").value = S.chat.baseUrl || "";
  $("model").value = S.chat.model || "";
  $("api-key").value = S.chat.apiKey || "";
  $("user-name").value = S.chat.userName || "主人";
  $("temperature").value = S.chat.temperature ?? 0.85;
  $("max-tokens").value = S.chat.maxTokens ?? 800;
  $("max-history").value = S.chat.maxHistoryTurns ?? 20;

  $("persona").value = S.persona || "";

  $("tts-enabled").value = String(!!(S.tts && S.tts.enabled));
  $("tts-rate").value = (S.tts && S.tts.rate) || 0.9;
  const genie = S.ttsGenie || {};
  $("genie-python").value = genie.python || "";
  $("genie-script").value = genie.serverScript || "";
  $("genie-ref-audio").value = genie.refAudio || "";
  $("genie-ref-text").value = genie.refText || "";
  // 语音方案推断
  let plan = "system";
  if (genie.enabled) plan = "genie";
  else if (S.ttsCosy && S.ttsCosy.enabled) plan = "cosy";
  else if (S.ttsCloud && S.ttsCloud.enabled) plan = "edge";
  $("tts-plan").value = plan;
  toggleGenieFields();

  $("hotkey").value = S.hotkey || "Alt+Shift+S";
  $("start-hidden").value = String(!!S.startHidden);
})();

/* ---------- 预设 ---------- */
$("preset").addEventListener("change", () => {
  const p = PRESETS[$("preset").value];
  if (!p) return;
  $("api-type").value = p.apiType;
  $("base-url").value = p.baseUrl;
  $("model").value = p.model;
  setResult($("test-result"), "");
});

/* ---------- API ---------- */
function readChat() {
  return {
    chat: {
      apiType: $("api-type").value,
      baseUrl: $("base-url").value.trim(),
      model: $("model").value.trim(),
      apiKey: $("api-key").value.trim(),
      userName: $("user-name").value.trim() || "主人",
      temperature: parseFloat($("temperature").value) || 0.85,
      maxTokens: parseInt($("max-tokens").value, 10) || 800,
      maxHistoryTurns: parseInt($("max-history").value, 10) || 20
    }
  };
}

$("btn-toggle-key").addEventListener("click", () => {
  const el = $("api-key");
  el.type = el.type === "password" ? "text" : "password";
});

$("btn-test").addEventListener("click", async () => {
  const c = readChat().chat;
  setResult($("test-result"), "测试中…");
  const r = await window.petAPI.testChat(c);
  setResult($("test-result"), r.message, r.ok);
});

/* ---------- 自动读取模型列表 ---------- */
$("btn-list-models").addEventListener("click", async () => {
  const c = readChat().chat;
  setResult($("model-result"), "读取中…");
  const r = await window.petAPI.listModels(c);
  if (!r.ok) {
    setResult($("model-result"), "获取失败：" + r.message, false);
    return;
  }
  const pick = $("model-pick");
  pick.innerHTML = r.models.map((m) => `<option value="${m.replace(/"/g, "&quot;")}">${m}</option>`).join("");
  $("model-pick-row").style.display = "flex";
  pick.value = r.models.includes(c.model) ? c.model : (r.models[0] || "");
  setResult($("model-result"), `✅ 已读取 ${r.count} 个模型，选一个填入`, true);
});

$("model-pick").addEventListener("change", () => {
  const v = $("model-pick").value;
  if (v) {
    $("model").value = v;
    setResult($("model-result"), `已选择：${v}`, true);
  }
});

$("btn-save-api").addEventListener("click", async () => {
  const patch = readChat();
  const r = await window.petAPI.saveSettings(patch);
  if (r === true) { setResult($("test-result"), "✅ API 设置已保存", true); }
  else { setResult($("test-result"), "保存失败: " + (r && r.message || "未知错误"), false); }
});

/* ---------- 人设 ---------- */
$("btn-save-persona").addEventListener("click", async () => {
  const ok = await window.petAPI.savePersona($("persona").value);
  setResult($("persona-result"), ok ? "✅ 人设已保存并生效" : "❌ 保存失败", ok);
});

$("btn-reset-persona").addEventListener("click", async () => {
  if (!confirm("确定恢复默认人设？当前编辑内容会被覆盖。")) return;
  const r = await window.petAPI.resetPersona();
  if (r.ok) {
    $("persona").value = r.persona;
    setResult($("persona-result"), "✅ 已恢复默认人设", true);
  } else {
    setResult($("persona-result"), "❌ " + (r.message || "恢复失败"), false);
  }
});

/* ---------- 语音 ---------- */
function toggleGenieFields() {
  $("genie-fields").classList.toggle("show", $("tts-plan").value === "genie");
}
$("tts-plan").addEventListener("change", toggleGenieFields);

$("btn-save-voice").addEventListener("click", async () => {
  const enabled = $("tts-enabled").value === "true";
  const plan = $("tts-plan").value;
  const patch = {
    tts: { enabled, rate: parseFloat($("tts-rate").value) || 0.9 },
    ttsGenie: {
      enabled: plan === "genie",
      python: $("genie-python").value.trim(),
      serverScript: $("genie-script").value.trim(),
      refAudio: $("genie-ref-audio").value.trim(),
      refText: $("genie-ref-text").value.trim()
    },
    ttsCloud: { enabled: plan === "edge" },
    ttsCosy: { enabled: plan === "cosy" }
  };
  const r = await window.petAPI.saveSettings(patch);
  setResult($("voice-result"), r === true ? "✅ 语音设置已保存" : "❌ 保存失败", r === true);
});

$("btn-open-guide").addEventListener("click", () => window.petAPI.openTtsGuide());

$("btn-open-studio").addEventListener("click", () => window.petAPI.openVoiceStudio());

/* ---------- 其他 ---------- */
$("btn-save-other").addEventListener("click", async () => {
  const r = await window.petAPI.saveSettings({
    hotkey: $("hotkey").value.trim() || "Alt+Shift+S",
    startHidden: $("start-hidden").value === "true"
  });
  setResult($("other-result"), r === true ? "✅ 已保存（热键重启后生效）" : "❌ 保存失败", r === true);
});

$("btn-open-config").addEventListener("click", () => window.petAPI.openConfig());

$("btn-clear-history").addEventListener("click", async () => {
  if (!confirm("确定清除全部聊天记忆？")) return;
  const ok = await window.petAPI.clearHistory();
  setResult($("other-result"), ok ? "✅ 聊天记录已清除" : "❌ 清除失败", ok);
});
