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
  $("api-key").value = "";
  const ck = S.secretStatus && S.secretStatus.chatApiKey;
  $("api-key").placeholder =
    ck && ck.unreadable ? "已保存的密钥不可读取；输入新值可替换" :
    ck && ck.saved ? "密钥已安全保存；输入新值可替换" : "sk-…（Ollama 本地可留空）";
  $("pet-name").value = (S.pet && S.pet.name) || "苏苏洛";
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
  try {
    const ss = await window.petAPI.getSeatSink();
    $("seat-sink").value = String(ss.value);
    $("seat-sink-val").textContent = ss.value + " px · " + seatTierLabel(ss.tier);
    const wt = await window.petAPI.getWalkTiming();
    $("sit-max").value = String(wt.sitMaxSec);
    $("sit-max-val").textContent = wt.sitMaxSec + " s";
    $("walk-max").value = String(wt.walkMaxSec);
    $("walk-max-val").textContent = wt.walkMaxSec + " s";
    const ap = await window.petAPI.getAppearance();
    fillChatFontOptions(ap.customFonts);
    $("chat-font").value = ap.fontFamily || "";
    const fz = Number(ap.fontSize) > 0 ? Number(ap.fontSize) : 11;
    $("chat-font-size").value = String(fz);
    $("chat-font-size-val").textContent = fz + " px";
    const bw = Number(ap.bubbleWidth) > 0 ? Number(ap.bubbleWidth) : 0;
    $("bubble-width").value = String(bw);
    $("bubble-width-val").textContent = bw > 0 ? bw + " px" : "自适应";
  } catch { /* 滑杆保持默认值 */ }
  const aa = S.agentApi || {};
  $("agent-enabled").value = String(aa.enabled !== false);
  $("agent-port").value = aa.port || 8765;
  $("agent-word").value = aa.invokeWord || "";
  $("agent-token").value = "";
  const at = S.secretStatus && S.secretStatus.agentBearerToken;
  $("agent-token").placeholder =
    at && at.unreadable ? "已保存的 Token 不可读取；输入新值可替换" :
    at && at.saved ? "Token 已安全保存；输入新值可替换" : "未启用认证";
  $("agent-max-body").value = Math.round((Number(aa.maxBodyBytes) || 65536) / 1024);

  // 功能开关
  const f = S.features || {};
  $("feat-clipboard").checked = !!f.clipboardWatch;
  $("feat-sysmon").checked = !!f.systemMonitor;
  $("feat-memory").checked = f.longTermMemory !== false;
  $("feat-emotional").checked = f.emotionalVoice !== false;
  $("feat-desktop-icons").checked = !!f.desktopIcons;

  // 渲染模式与桌面行走
  $("render-mode").value = S.renderMode === "spine" ? "spine" : "gif";
  $("walking-opt").checked = !!S.walking;

  renderKeyStatuses();
  maybeShowCredNotice();
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
  const typedKey = $("api-key").value.trim();
  return {
    chat: {
      apiType: $("api-type").value,
      baseUrl: $("base-url").value.trim(),
      model: $("model").value.trim(),
      userName: $("user-name").value.trim() || "主人",
      temperature: parseFloat($("temperature").value) || 0.85,
      maxTokens: parseInt($("max-tokens").value, 10) || 800,
      maxHistoryTurns: parseInt($("max-history").value, 10) || 20
    },
    pet: { name: $("pet-name").value },
    secrets: typedKey ? { chatApiKey: { action: "replace", value: typedKey } } : {}
  };
}

$("btn-toggle-key").addEventListener("click", () => {
  const el = $("api-key");
  el.type = el.type === "password" ? "text" : "password";
});

$("btn-test").addEventListener("click", async () => {
  const patch = readChat();
  const c = { ...patch.chat };
  if (patch.secrets.chatApiKey) c.apiKey = patch.secrets.chatApiKey.value;
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
  pick.replaceChildren();
  for (const modelName of r.models) {
    const option = document.createElement("option");
    option.value = modelName;
    option.textContent = modelName;
    pick.appendChild(option);
  }
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

/* ---------- 坐姿下沉量（按当前尺寸档位读写，拖动即生效） ---------- */
function seatTierLabel(t) {
  return L("set.seatTier." + t) === "set.seatTier." + t ? t : L("set.seatTier." + t);
}
$("seat-sink").addEventListener("input", () => {
  $("seat-sink-val").textContent = $("seat-sink").value + " px";
});
$("seat-sink").addEventListener("change", async () => {
  const r = await window.petAPI.setSeatSink(Number($("seat-sink").value));
  $("seat-sink").value = String(r.value);
  $("seat-sink-val").textContent = r.value + " px · " + seatTierLabel(r.tier);
});

/* ---------- 行走节奏（单次坐下/散步最长时间，松手即生效） ---------- */
$("sit-max").addEventListener("input", () => {
  $("sit-max-val").textContent = $("sit-max").value + " s";
});
$("sit-max").addEventListener("change", async () => {
  const r = await window.petAPI.setWalkTiming({ sitMaxSec: Number($("sit-max").value) });
  $("sit-max").value = String(r.sitMaxSec);
  $("sit-max-val").textContent = r.sitMaxSec + " s";
});
$("walk-max").addEventListener("input", () => {
  $("walk-max-val").textContent = $("walk-max").value + " s";
});
$("walk-max").addEventListener("change", async () => {
  const r = await window.petAPI.setWalkTiming({ walkMaxSec: Number($("walk-max").value) });
  $("walk-max").value = String(r.walkMaxSec);
  $("walk-max-val").textContent = r.walkMaxSec + " s";
});

/* ---------- 聊天外观（字体/字号/气泡宽度，松手即生效） ---------- */
function fillChatFontOptions(customFonts) { // 已导入的本地字体追加到下拉末尾
  const sel = $("chat-font");
  sel.querySelectorAll("option[data-custom]").forEach((o) => o.remove());
  (customFonts || []).forEach((f) => {
    const o = document.createElement("option");
    o.value = "custom:" + f;
    o.textContent = "自定义·" + f.replace(/\.(ttf|otf|woff2?)$/i, "");
    o.setAttribute("data-custom", "1");
    sel.appendChild(o);
  });
}
$("chat-font").addEventListener("change", async () => {
  await window.petAPI.setAppearance({ fontFamily: $("chat-font").value });
});
$("chat-font-size").addEventListener("input", () => {
  $("chat-font-size-val").textContent = $("chat-font-size").value + " px";
});
$("chat-font-size").addEventListener("change", async () => {
  const r = await window.petAPI.setAppearance({ fontSize: Number($("chat-font-size").value) });
  const fz = Number(r.fontSize) > 0 ? Number(r.fontSize) : 11;
  $("chat-font-size").value = String(fz);
  $("chat-font-size-val").textContent = fz + " px";
});
$("bubble-width").addEventListener("input", () => {
  const v = Number($("bubble-width").value);
  $("bubble-width-val").textContent = v > 0 ? v + " px" : "自适应";
});
$("bubble-width").addEventListener("change", async () => {
  const r = await window.petAPI.setAppearance({ bubbleWidth: Number($("bubble-width").value) });
  const bw = Number(r.bubbleWidth) > 0 ? Number(r.bubbleWidth) : 0;
  $("bubble-width").value = String(bw);
  $("bubble-width-val").textContent = bw > 0 ? bw + " px" : "自适应";
});
$("btn-open-schedule").addEventListener("click", () => window.petAPI.openSchedule());
$("btn-import-font").addEventListener("click", async () => {
  const r = await window.petAPI.importFont();
  if (r && r.customFonts && r.customFonts.length) {
    fillChatFontOptions(r.customFonts);
    const last = r.customFonts[r.customFonts.length - 1];
    $("chat-font").value = "custom:" + last;
    await window.petAPI.setAppearance({ fontFamily: $("chat-font").value }); // 导入后自动应用
  }
});

/* ---------- 其他 ---------- */
$("btn-save-other").addEventListener("click", async () => {
  const scale = parseFloat($("pet-scale").value) || 1;
  const r = await window.petAPI.saveSettings({
    uiLang: $("ui-lang").value,
    hotkey: $("hotkey").value.trim() || "Alt+Shift+S",
    startHidden: $("start-hidden").value === "true",
    window: { scale },
    pet: { name: $("pet-name").value },
    features: {
      clipboardWatch: $("feat-clipboard").checked,
      systemMonitor: $("feat-sysmon").checked,
      longTermMemory: $("feat-memory").checked,
      emotionalVoice: $("feat-emotional").checked,
      desktopIcons: $("feat-desktop-icons").checked
    },
    agentApi: {
      enabled: $("agent-enabled").value === "true",
      port: parseInt($("agent-port").value, 10) || 8765,
      invokeWord: $("agent-word").value.trim(),
      bearerToken: $("agent-token").value.trim(),
      maxBodyBytes: Math.max(1024, Math.min(1024 * 1024, (parseInt($("agent-max-body").value, 10) || 64) * 1024))
    },
    renderMode: $("render-mode").value === "spine" ? "spine" : "gif",
    walking: $("walking-opt").checked
  });
  // 立即应用桌宠大小（不等重启）
  if (r === true) await window.petAPI.setScale(scale);
  setResult($("other-result"), r === true ? L("set.saved") : L("set.saveFailed"), r === true);
});

$("btn-agent-token").addEventListener("click", async () => {
  const token = await window.petAPI.generateAgentToken();
  $("agent-token").value = token || "";
  try { await navigator.clipboard.writeText(token); setResult($("other-result"), "已生成并复制 Token；保存并重启后生效", true); }
  catch { setResult($("other-result"), "已生成 Token；保存并重启后生效", true); }
});

$("btn-open-terms").addEventListener("click", () => window.petAPI.openTerms());

$("btn-open-config").addEventListener("click", () => window.petAPI.openConfig());

$("btn-clear-history").addEventListener("click", async () => {
  if (!confirm(L("set.confirmClear"))) return;
  const ok = await window.petAPI.clearHistory();
  setResult($("other-result"), ok ? L("set.saved") : L("set.saveFailed"), ok);
});

/* ---------- ⑤ 密钥与凭据安全 ---------- */
function keyStateText(st) {
  if (!st || !st.available) return { text: "安全存储不可用（Windows DPAPI）", cls: "err" };
  if (st.unreadable) return { text: "已保存但不可读取（更换 Windows 用户或 DPAPI 失效）", cls: "warn" };
  if (st.saved) return { text: "已保存（DPAPI 加密）", cls: "ok" };
  return { text: "未保存", cls: "" };
}

function renderKeyStatuses() {
  const ss = S.secretStatus || {};
  const slots = [
    ["status-chat-key", ss.chatApiKey],
    ["status-cosy-key", ss.ttsCosyApiKey],
    ["status-agent-token", ss.agentBearerToken]
  ];
  for (const [id, st] of slots) {
    const el = $(id);
    if (!el) continue;
    const k = keyStateText(st);
    el.textContent = k.text;
    el.className = "cred-status" + (k.cls ? " " + k.cls : "");
  }
}

function maybeShowCredNotice() {
  const seen = !!(S.security && S.security.externalCredNoticeSeen);
  $("cred-notice").style.display = seen ? "none" : "flex";
}

$("btn-dismiss-notice").addEventListener("click", async () => {
  $("cred-notice").style.display = "none";
  await window.petAPI.saveSettings({ security: { externalCredNoticeSeen: true } });
});

/* 扫描本机可导入凭据（返回值只含来源/指纹，绝无完整密钥） */
let SCAN = null;
$("btn-scan-creds").addEventListener("click", async () => {
  setResult($("import-result"), "扫描中…");
  SCAN = await window.petAPI.scanCredentials();
  if (!SCAN || !SCAN.ok) {
    setResult($("import-result"), (SCAN && SCAN.message) || "扫描失败", false);
    return;
  }
  const sel = $("cred-source");
  sel.replaceChildren();
  let n = 0;
  for (const p of SCAN.chat || []) {
    const o = document.createElement("option");
    o.value = "chat|" + p.providerId;
    o.textContent = "[ZCode] " + p.name + " · " + (p.baseURL || "（无地址）") + " · " + p.fingerprint;
    sel.appendChild(o);
    n++;
  }
  for (const c of SCAN.cosy || []) {
    const o = document.createElement("option");
    o.value = "cosy|";
    o.textContent = "[DashScope] DASHSCOPE_API_KEY · " + (c.endpoint || "（默认端点）") + " · " + c.fingerprint;
    sel.appendChild(o);
    n++;
  }
  if (!n) {
    const o = document.createElement("option");
    o.value = "";
    o.textContent = "（未发现可导入凭据）";
    sel.appendChild(o);
    $("btn-import-cred").disabled = true;
    setResult($("import-result"), "本机未发现可导入的外部凭据（ZCode / DashScope 来源）", false);
    return;
  }
  $("btn-import-cred").disabled = false;
  // 默认选中与当前用途匹配的第一项
  syncSourceToSlot();
  setResult($("import-result"), "发现 " + n + " 条可导入凭据；确认后点击「导入所选凭据」", true);
});

function syncSourceToSlot() {
  const want = $("cred-slot").value === "ttsCosy" ? "cosy" : "chat";
  const opts = Array.from($("cred-source").options);
  const hit = opts.find((o) => o.value.startsWith(want + "|"));
  if (hit) $("cred-source").value = hit.value;
}

$("cred-slot").addEventListener("change", () => {
  if (!SCAN) return;
  syncSourceToSlot();
});

$("btn-import-cred").addEventListener("click", async () => {
  const v = String($("cred-source").value || "");
  if (!v || !v.includes("|")) return;
  const [kind, providerId] = v.split("|");
  const slot = kind === "cosy" ? "ttsCosy" : "chat";
  if (slot === "chat" && !providerId) return;
  const purpose = slot === "chat" ? "聊天 API Key" : "CosyVoice Key";
  const ok = confirm(
    "确认导入？\n\n" +
    "将从指定的本地来源复制该凭据到本应用的 Windows DPAPI 加密存储，作为「" + purpose + "」在对应服务调用时使用。\n" +
    "原值不会被显示、修改或上传；外部来源文件保持不变。"
  );
  if (!ok) return;
  setResult($("import-result"), "导入中…");
  const r = await window.petAPI.importCredential({ slot, providerId });
  if (r && r.ok) {
    S = await window.petAPI.getSettings(); // 刷新状态快照（不刷新输入框已填内容）
    renderKeyStatuses();
    maybeShowCredNotice();
    const ck2 = S.secretStatus && S.secretStatus.chatApiKey;
    $("api-key").placeholder =
      ck2 && ck2.saved ? "密钥已安全保存；输入新值可替换" : "sk-…（Ollama 本地可留空）";
    document.getElementById("key-source").textContent = L("set.keyStatus") + (S.keySource || L("set.unknown"));
    setResult($("import-result"), "✅ 已加密保存（" + r.fingerprint + "）" + (r.note ? "。" + r.note : ""), true);
  } else {
    setResult($("import-result"), "❌ " + ((r && r.message) || "导入失败"), false);
  }
});

/* 显式清除已保存密钥 */
async function clearSecretFlow(slot, label) {
  const tips = {
    chat: "确认清除已保存的聊天 API Key？\n\n清除后聊天将无法调用云端 API（本地 Ollama 不受影响），需重新填写或导入。",
    ttsCosy: "确认清除已保存的 CosyVoice Key？\n\n清除后 CosyVoice 克隆音色不可用，会自动回退其他语音方案。",
    agent: "确认清除 Agent Bearer Token？\n\n重启桌宠后，Agent API 将回到「空 token 兼容模式」（仅监听 127.0.0.1 的旧脚本无需认证即可调用）。"
  };
  if (!confirm(tips[slot] || ("确认清除" + label + "？"))) return;
  setResult($("clear-result"), "清除中…");
  const r = await window.petAPI.clearSecret(slot);
  S = await window.petAPI.getSettings();
  renderKeyStatuses();
  if (r && r.ok) setResult($("clear-result"), "✅ 已清除" + (slot === "agent" ? "；重启后生效" : ""), true);
  else setResult($("clear-result"), "❌ " + ((r && r.message) || "清除失败"), false);
}
$("btn-clear-chat-key").addEventListener("click", () => clearSecretFlow("chat", "聊天 Key"));
$("btn-clear-cosy-key").addEventListener("click", () => clearSecretFlow("ttsCosy", "Cosy Key"));
$("btn-clear-agent-token").addEventListener("click", () => clearSecretFlow("agent", "Agent Token"));
