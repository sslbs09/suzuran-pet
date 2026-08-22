/**
 * 苏苏洛设置窗口逻辑
 * - 读取/保存 config（IPC pet:get-settings / pet:save-settings）
 * - 人设编辑保存 / 恢复默认（pet:save-persona / pet:reset-persona）
 * - 测试连接（pet:test-chat）
 * - 界面语言切换（pet:set-ui-lang，中/英/日）
 */
"use strict";

const $ = (id) => document.getElementById(id);
const L = (key) => (window.I18N && I18N.t(key)) || key; // 国际化动态文案

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
    L("set.keyStatus") + (S.keySource || L("set.unknown"));

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
  $("genie-speak-ja").checked = !!genie.speakJa;
  $("greeting-on-start").checked = S.greetingOnStart !== false;
  // 语音方案推断
  let plan = "system";
  if (genie.enabled) plan = "genie";
  else if (S.ttsCosy && S.ttsCosy.enabled) plan = "cosy";
  else if (S.ttsCloud && S.ttsCloud.enabled) plan = "edge";
  $("tts-plan").value = plan;
  toggleGenieFields();

  $("ui-lang").value = S.uiLang || "zh";
  $("hotkey").value = S.hotkey || "Alt+Shift+S";
  $("start-hidden").value = String(!!S.startHidden);
  $("pet-scale").value = String(S.scale || 1);
  const aa = S.agentApi || {};
  $("agent-enabled").value = String(aa.enabled !== false);
  $("agent-port").value = aa.port || 8765;
  $("agent-word").value = aa.invokeWord || "";

  // 功能开关
  const f = S.features || {};
  $("feat-clipboard").checked = !!f.clipboardWatch;
  $("feat-sysmon").checked = !!f.systemMonitor;
  $("feat-memory").checked = f.longTermMemory !== false;
  $("feat-emotional").checked = f.emotionalVoice !== false;
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
  setResult($("test-result"), L("set.testing"));
  const r = await window.petAPI.testChat(c);
  setResult($("test-result"), r.message, r.ok);
});

/* ---------- 自动读取模型列表 ---------- */
$("btn-list-models").addEventListener("click", async () => {
  const c = readChat().chat;
  setResult($("model-result"), L("set.testing"));
  const r = await window.petAPI.listModels(c);
  if (!r.ok) {
    setResult($("model-result"), L("set.modelFail") + r.message, false);
    return;
  }
  const pick = $("model-pick");
  pick.innerHTML = r.models.map((m) => `<option value="${m.replace(/"/g, "&quot;")}">${m}</option>`).join("");
  $("model-pick-row").style.display = "flex";
  pick.value = r.models.includes(c.model) ? c.model : (r.models[0] || "");
  setResult($("model-result"), L("set.modelOkPrefix") + r.count + L("set.modelOkSuffix"), true);
});

$("model-pick").addEventListener("change", () => {
  const v = $("model-pick").value;
  if (v) {
    $("model").value = v;
    setResult($("model-result"), L("set.modelPicked") + v, true);
  }
});

$("btn-save-api").addEventListener("click", async () => {
  const patch = readChat();
  const r = await window.petAPI.saveSettings(patch);
  if (r === true) { setResult($("test-result"), L("set.apiSaved"), true); }
  else { setResult($("test-result"), L("set.saveFailed") + (r && r.message || L("set.unknown")), false); }
});

/* ---------- 人设 ---------- */
$("btn-save-persona").addEventListener("click", async () => {
  const ok = await window.petAPI.savePersona($("persona").value);
  setResult($("persona-result"), ok ? L("set.personaSaved") : L("set.personaSaveFail"), ok);
});

$("btn-reset-persona").addEventListener("click", async () => {
  if (!confirm(L("set.confirmReset"))) return;
  const r = await window.petAPI.resetPersona();
  if (r.ok) {
    $("persona").value = r.persona;
    setResult($("persona-result"), L("set.personaReset"), true);
  } else {
    setResult($("persona-result"), "❌ " + (r.message || L("set.personaResetFail")), false);
  }
});

/* ---------- 语音 ---------- */
function toggleGenieFields() {
  $("genie-fields").classList.toggle("show", $("tts-plan").value === "genie");
}
$("tts-plan").addEventListener("change", toggleGenieFields);

/* ---------- 一键重启日语 TTS ---------- */
$("btn-restart-gsv").addEventListener("click", async () => {
  const btn = $("btn-restart-gsv");
  const out = $("gsv-result");
  btn.disabled = true;
  setResult(out, L("set.gsvRestarting"));
  let r;
  try { r = await window.petAPI.restartGsv(); } catch { r = { ok: false, code: "timeout" }; }
  btn.disabled = false;
  const msgs = {
    success: L("set.gsvOk"),
    timeout: L("set.gsvTimeout"),
    synth: L("set.gsvSynthFail"),
    disabled: L("set.gsvDisabled")
  };
  setResult(out, msgs[r && r.code] || L("set.gsvTimeout"), !!(r && r.ok));
});

$("btn-save-voice").addEventListener("click", async () => {
  const enabled = $("tts-enabled").value === "true";
  const plan = $("tts-plan").value;
  const patch = {
    greetingOnStart: $("greeting-on-start").checked,
    tts: { enabled, rate: parseFloat($("tts-rate").value) || 0.9 },
    ttsGenie: {
      enabled: plan === "genie",
      python: $("genie-python").value.trim(),
      serverScript: $("genie-script").value.trim(),
      refAudio: $("genie-ref-audio").value.trim(),
      refText: $("genie-ref-text").value.trim(),
      speakJa: $("genie-speak-ja").checked
    },
    ttsCloud: { enabled: plan === "edge" },
    ttsCosy: { enabled: plan === "cosy" }
  };
  const r = await window.petAPI.saveSettings(patch);
  setResult($("voice-result"), r === true ? L("set.voiceSaved") : L("set.voiceSaveFail"), r === true);
});

$("btn-open-guide").addEventListener("click", () => window.petAPI.openTtsGuide());

$("btn-open-studio").addEventListener("click", () => window.petAPI.openVoiceStudio());

/* ---------- 界面语言（即时切换） ---------- */
$("ui-lang").addEventListener("change", () => {
  window.petAPI.setUiLang($("ui-lang").value);
});

/* ---------- 其他 ---------- */
$("btn-save-other").addEventListener("click", async () => {
  const scale = parseFloat($("pet-scale").value) || 1;
  const r = await window.petAPI.saveSettings({
    uiLang: $("ui-lang").value,
    hotkey: $("hotkey").value.trim() || "Alt+Shift+S",
    startHidden: $("start-hidden").value === "true",
    window: { scale },
    features: {
      clipboardWatch: $("feat-clipboard").checked,
      systemMonitor: $("feat-sysmon").checked,
      longTermMemory: $("feat-memory").checked,
      emotionalVoice: $("feat-emotional").checked
    },
    agentApi: {
      enabled: $("agent-enabled").value === "true",
      port: parseInt($("agent-port").value, 10) || 8765,
      invokeWord: $("agent-word").value.trim()
    }
  });
  // 立即应用桌宠大小（不等重启）
  if (r === true) await window.petAPI.setScale(scale);
  setResult($("other-result"), r === true ? L("set.saved") : L("set.saveFailed"), r === true);
});

$("btn-open-terms").addEventListener("click", () => window.petAPI.openTerms());

$("btn-open-config").addEventListener("click", () => window.petAPI.openConfig());

$("btn-clear-history").addEventListener("click", async () => {
  if (!confirm(L("set.confirmClear"))) return;
  const ok = await window.petAPI.clearHistory();
  setResult($("other-result"), ok ? L("set.saved") : L("set.saveFailed"), ok);
});
