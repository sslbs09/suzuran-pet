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
let personaDirty = false; // 人设输入框是否有未保存改动（v2.5.18 未保存条用）

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
  // 版本号：单一来源 package.json（app.getVersion），比硬编码文本更可信（P1-5）
  const verEl = document.getElementById("version");
  if (verEl && window.petAPI.appVersion) {
    verEl.textContent = "苏苏洛桌宠 · v" + window.petAPI.appVersion;
  }
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
  const smp0 = (S.chat && S.chat.sampling) || {};
  $("smp-topp").value = smp0.topP ?? 0.9;
  $("smp-minp").value = smp0.minP ?? 0.05;
  $("smp-reppen").value = smp0.repeatPenalty ?? 1.1;
  $("smp-presence").value = smp0.presencePenalty ?? 0.1;
  $("smp-frequency").value = smp0.frequencyPenalty ?? 0.1;
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
    $("perch-pct").value = String(wt.perchPct != null ? wt.perchPct : 8);
    $("perch-pct-val").textContent = (wt.perchPct != null ? wt.perchPct : 8) + " %";
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
  $("agent-status-enabled").checked = aa.statusEnabled !== false;
  renderAgentClients(aa.clients || []);

  // 功能开关
  const f = S.features || {};
  $("feat-clipboard").checked = !!f.clipboardWatch;
  $("feat-sysmon").checked = !!f.systemMonitor;
  $("focus-mode").checked = f.focusMode !== false;
  $("feat-memory").checked = f.longTermMemory !== false;
  $("feat-emotional").checked = f.emotionalVoice !== false;
  $("feat-desktop-icons").checked = !!f.desktopIcons;
  const _ww = f.workspaceWatch || {};
  $("ws-watch").checked = !!_ww.enabled;
  $("ws-watch-dirs").value = Array.isArray(_ww.dirs) ? _ww.dirs.join("; ") : "";
  $("auto-launch").checked = !!S.autoLaunch;
  // 2.5D 角色开关（v2.2）
  $("rig-switch").checked = !!S.rigSkinId;
  // 2.5D 角色大小
  const rs = Number(S.rigScale) > 0 ? Number(S.rigScale) : 1;
  $("rig-scale").value = String(rs);
  $("rig-scale-val").textContent = Math.round(rs * 100) + "%";
  $("rig-scale").addEventListener("input", () => {
    const v = Number($("rig-scale").value);
    $("rig-scale-val").textContent = Math.round(v * 100) + "%";
    window.petAPI.setRigScale(v); // 实时生效
  });
  // 2.5D 头部/眼睛跟随鼠标（v2.2.1 实验性）
  $("rig-mouse").checked = S.rigMouseFollow !== false;
  $("rig-mouse").addEventListener("change", () => window.petAPI.setRigMouseFollow($("rig-mouse").checked));
  // 全局鼠标跟踪（v2.2.1 实验性，需显式许可默认关）
  $("rig-mouse-global").checked = !!S.mouseTrackGlobal;
  $("rig-mouse-global").addEventListener("change", () => window.petAPI.setMouseTrackGlobal($("rig-mouse-global").checked));
  // 逗猫棒（v2.2.1 实验性，需显式许可默认关）
  $("cat-toy").checked = !!S.catToy;
  $("cat-toy").addEventListener("change", () => window.petAPI.setCatToy($("cat-toy").checked));
  // 桌面全域行走（实验，默认关）：边界配置即时生效（walkTick 每帧读）
  $("walk-global").checked = !!S.walkGlobal;
  $("walk-global").addEventListener("change", () => window.petAPI.setWalkGlobal($("walk-global").checked));
  // 软件渲染（默认关，重启生效）：无独显/驱动异常环境兜底
  $("soft-render").checked = !!S.softRender;
  $("soft-render").addEventListener("change", () => window.petAPI.setSoftRender($("soft-render").checked));
  // 蜜标监控（默认关）
  $("file-guard").checked = !!S.fileGuard;
  $("file-guard").addEventListener("change", () => window.petAPI.setFileGuard($("file-guard").checked));
  // 主动搭话 / 人格化（v2.3，单独开关默认开）
  $("proactive-chat").checked = S.proactiveChat !== false;
  $("proactive-chat").addEventListener("change", () => window.petAPI.setProactiveChat($("proactive-chat").checked));
  $("personify").checked = S.personify !== false;
  $("personify").addEventListener("change", () => window.petAPI.setPersonify($("personify").checked));
  // 角色扮演模式（RP，单独开关默认开）：关=助手模式优先服从指令
  $("rp-mode").checked = S.rpMode !== false;
  $("rp-mode").addEventListener("change", () => window.petAPI.setRpMode($("rp-mode").checked));
  // 感知工作区活动（默认关）：开关/目录即时生效（主进程保存并启停监听）
  const parseWatchDirs = () => String($("ws-watch-dirs").value || "").split(/[;,，]/).map((s) => s.trim()).filter(Boolean);
  $("ws-watch").addEventListener("change", () => window.petAPI.setWorkspaceWatch($("ws-watch").checked, parseWatchDirs()));
  $("ws-watch-dirs").addEventListener("change", () => window.petAPI.setWorkspaceWatch($("ws-watch").checked, parseWatchDirs()));
  // Live2D 模型列表（v2.5.1）：点选即切换（主进程保存并广播重载）
  async function loadLive2dSkins() {
    try {
      const skins = await window.petAPI.live2dList();
      const box = $("live2d-skins-list");
      if (!box) return;
      if (!skins || !skins.length) { box.textContent = "（暂无模型）"; return; }
      box.textContent = "";
      skins.forEach((s) => {
        const label = document.createElement("label");
        label.style.display = "block";
        const radio = document.createElement("input");
        radio.type = "radio";
        radio.name = "live2d-skin";
        radio.checked = s.id === (S.live2dSkinId || "") || (!S.live2dSkinId && s.id.startsWith("builtin/"));
        label.appendChild(radio);
        label.appendChild(document.createTextNode(" " + s.name));
        radio.addEventListener("change", () => { if (radio.checked) window.petAPI.live2dSelect(s.id); });
        box.appendChild(label);
      });
    } catch { const b = $("live2d-skins-list"); if (b) b.textContent = "加载失败"; }
  }
  const ls = Number(S.live2dScale) > 0 ? Number(S.live2dScale) : 1;
  const lsel = $("live2d-scale");
  if (lsel) {
    lsel.value = String(ls);
    $("live2d-scale-val").textContent = Math.round(ls * 100) + "%";
    lsel.addEventListener("input", () => {
      const v = Number(lsel.value);
      $("live2d-scale-val").textContent = Math.round(v * 100) + "%";
      window.petAPI.setLive2dScale(v); // 实时生效
    });
  }
  loadLive2dSkins();
  if (window.petAPI.onLive2dChanged) window.petAPI.onLive2dChanged(() => loadLive2dSkins());

  // 2.5D 已导入皮肤列表（§14 追加 96：每项可删除，删除当前皮肤自动退出 2.5D 模式）
  async function loadRigSkins() {
    try {
      const skins = await window.petAPI.rigSkins();
      const box = $("rig-skins-list");
      if (!skins || !skins.length) { box.textContent = "（暂无，去 PSD 工具导入）"; return; }
      box.innerHTML = "";
      skins.forEach((s) => {
        const row = document.createElement("div");
        row.style.cssText = "display:flex;align-items:center;gap:6px;padding:2px 0;";
        const radio = document.createElement("input");
        radio.type = "radio";
        radio.name = "rig-skin";
        radio.checked = s.id.toLowerCase() === (S.rigSkinId || "").toLowerCase();
        radio.addEventListener("change", () => { if (radio.checked) window.petAPI.rigSet(s.id); });
        const label = document.createElement("span");
        label.textContent = s.id + ((s.id.toLowerCase() === (S.rigSkinId || "").toLowerCase()) ? "（当前）" : "");
        label.style.fontSize = "12px";
        const del = document.createElement("button");
        del.textContent = "🗑";
        del.title = "删除此皮肤";
        del.style.cssText = "font-size:11px;padding:0 4px;cursor:pointer;margin-left:auto;";
        del.addEventListener("click", async () => {
          if (!window.confirm("删除已导入的皮肤「" + s.id + "」？此操作不可恢复")) return;
          const r = await window.petAPI.rigDelete(s.id);
          if (!r || !r.ok) { window.alert((r && r.message) || "删除失败"); return; }
          if (r.clearedCurrent) { S.rigSkinId = ""; $("rig-switch").checked = false; }
          loadRigSkins(); // 局部刷新列表，不重载整页（不丢其他未保存设置）
        });
        row.appendChild(radio); row.appendChild(label); row.appendChild(del);
        box.appendChild(row);
      });
    } catch { $("rig-skins-list").textContent = "加载失败"; }
  }
  loadRigSkins();

  // 渲染模式与桌面行走
  $("render-mode").value = S.renderMode === "spine" ? "spine" : S.renderMode === "rig" ? "rig" : S.renderMode === "live2d" ? "live2d" : "gif";
  $("walking-opt").checked = !!S.walking;
  applyRenderModeUI($("render-mode").value);
  $("render-mode").addEventListener("change", () => applyRenderModeUI($("render-mode").value));
  // 渲染模式即时保存（v2.5.1）：选中即生效，不用滚到页底找保存
  $("render-mode").addEventListener("change", async () => {
    const v = $("render-mode").value;
    const r = await window.petAPI.saveSettings({ renderMode: v }).catch(() => null);
    const hint = $("rm-hint");
    if (hint && r && r.ok !== false) hint.textContent = "已切换并保存 ✓";
  });
  // 主题颜色（v2.5.1）：切换即时保存并全窗生效（auto=19 点-6 点深色）
  const themeSel = $("theme-select");
  if (themeSel) {
    themeSel.value = S.theme === "dark" || S.theme === "light" ? S.theme : "auto";
    applyThemeToPage(themeSel.value);
    themeSel.addEventListener("change", () => {
      applyThemeToPage(themeSel.value); // 本页即时预览
      window.petAPI.setTheme(themeSel.value);
    });
    if (window.petAPI.onThemeChanged) window.petAPI.onThemeChanged((th) => { applyThemeToPage(th); themeSel.value = th === "dark" || th === "light" ? th : "auto"; });
  }
  function applyThemeToPage(theme) { // 规则唯一来源 renderer/theme.js（v2.5.26 收敛）
    window.petTheme.apply(theme);
  }

  renderKeyStatuses();
  maybeShowCredNotice();
})();

// 渲染模式联动：先选模式，仅显示该模式支持的选项（data-rm="gif|spine|rig" 标记，支持空格分隔多模式）
function applyRenderModeUI(mode) {
  document.querySelectorAll("[data-rm]").forEach((el) => {
    const modes = String(el.dataset.rm || "").split(/\s+/).filter(Boolean);
    el.style.display = modes.includes(mode) ? "" : "none";
  });
  const hint = $("rm-hint");
  if (hint) {
    hint.textContent = mode === "spine" ? "Spine 模式：下方显示行走/模型相关选项（人物皮肤、桌面行走、动作试演等）。"
      : mode === "rig" ? "2.5D 模式：下方显示角色相关选项（皮肤、大小、跟随鼠标、全局跟踪）。"
      : mode === "live2d" ? "Live2D 模式：选择模型目录（把 .model3.json 所在文件夹放进 userData/assets/live2d/ 即可出现）。"
      : "GIF 模式：经典表情，无行走与模型选项。";
  }
  syncNavVisibility(); // v2.5.18：分区被渲染模式隐藏时，左侧导航项同步隐藏
}

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
      sampling: {
        topP: parseFloat($("smp-topp").value) || 0.9,
        minP: parseFloat($("smp-minp").value) || 0.05,
        repeatPenalty: parseFloat($("smp-reppen").value) || 1.1,
        presencePenalty: parseFloat($("smp-presence").value) || 0.1,
        frequencyPenalty: parseFloat($("smp-frequency").value) || 0.1
      },
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

$("btn-save-api").addEventListener("click", async () => { await doSaveApi(); });

/* 提取为具名函数（v2.5.18）：顶部「保存全部」需要按顺序复用各分区保存逻辑 */
async function doSaveApi() {
  const patch = readChat();
  const r = await window.petAPI.saveSettings(patch);
  if (r === true) { setResult($("test-result"), L("set.apiSaved"), true); }
  else { setResult($("test-result"), L("set.saveFailed") + (r && r.message || L("set.unknown")), false); }
}

/* ---------- 人设 ---------- */
$("btn-save-persona").addEventListener("click", async () => { await doSavePersona(); });

async function doSavePersona() {
  const ok = await window.petAPI.savePersona($("persona").value);
  personaDirty = false;
  setResult($("persona-result"), ok ? L("set.personaSaved") : L("set.personaSaveFail"), ok);
}

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

/* ---------- 日语预热进度（v2.5.26）：语音区显示「已缓存 x/N 句」，5s 轻轮询 ---------- */
const jaPrewarmEl = $("ja-prewarm-progress");
if (jaPrewarmEl && window.petAPI.jaPrewarmStatus) {
  const tickJaPrewarm = async () => {
    try {
      const p = await window.petAPI.jaPrewarmStatus();
      if (!p || !p.total) { jaPrewarmEl.textContent = ""; return; }
      const tpl = p.done >= p.total && !p.running ? L("set.prewarmDone") : L("set.prewarmRun");
      jaPrewarmEl.textContent = tpl.replace("{d}", p.done).replace("{n}", p.total);
    } catch { /* 忽略 */ }
  };
  tickJaPrewarm();
  setInterval(tickJaPrewarm, 5000);
}

/* ---------- 清空日语翻译缓存（v2.5.26） ---------- */
$("btn-clear-trcache").addEventListener("click", async () => {
  const out = $("gsv-result");
  try {
    const r = await window.petAPI.clearTranslateCache();
    setResult(out, r.ok ? "✅ 翻译缓存已清空（预热会重新翻译）" : "❌ " + (r.error || "failed"));
  } catch { setResult(out, "❌ failed"); }
});

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
    disabled: L("set.gsvDisabled"),
    nopath: L("set.gsvNoPath")
  };
  setResult(out, msgs[r && r.code] || L("set.gsvTimeout"), !!(r && r.ok));
});

$("btn-save-voice").addEventListener("click", async () => { await doSaveVoice(); });

async function doSaveVoice() {
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
}

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
$("perch-pct").addEventListener("input", () => {
  $("perch-pct-val").textContent = $("perch-pct").value + " %";
});
$("perch-pct").addEventListener("change", async () => {
  const r = await window.petAPI.setWalkTiming({ perchPct: Number($("perch-pct").value) });
  $("perch-pct").value = String(r.perchPct);
  $("perch-pct-val").textContent = r.perchPct + " %";
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
$("btn-save-other").addEventListener("click", async () => { await doSaveOther(); });

async function doSaveOther() {
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
      focusMode: $("focus-mode").checked,
      longTermMemory: $("feat-memory").checked,
      emotionalVoice: $("feat-emotional").checked,
      desktopIcons: $("feat-desktop-icons").checked
    },
    autoLaunch: $("auto-launch").checked, // 开机自启（系统级，主进程单独处理）
    agentApi: {
      enabled: $("agent-enabled").value === "true",
      port: parseInt($("agent-port").value, 10) || 8765,
      invokeWord: $("agent-word").value.trim(),
      bearerToken: $("agent-token").value.trim(),
      maxBodyBytes: Math.max(1024, Math.min(1024 * 1024, (parseInt($("agent-max-body").value, 10) || 64) * 1024)),
      statusEnabled: $("agent-status-enabled").checked
    },
    renderMode: $("render-mode").value,
    walking: $("walking-opt").checked,
    rigScale: Number($("rig-scale").value) || 1.0, // 2.5D 角色大小
    rigMouseFollow: $("rig-mouse").checked !== false, // 2.5D 头部/眼睛跟随鼠标
    mouseTrackGlobal: $("rig-mouse-global").checked, // 全局鼠标跟踪（需显式许可）
    catToy: $("cat-toy").checked, // 逗猫棒（需显式许可）
    fileGuard: $("file-guard").checked, // 蜜标监控
    proactiveChat: $("proactive-chat").checked, // 主动搭话（v2.3 单独开关）
    personify: $("personify").checked, // 人格化（v2.3 单独开关）
    rpMode: $("rp-mode").checked // 角色扮演模式（关=助手模式优先服从指令）
  });
  // 渲染模式联动：选「2.5D」需有皮肤；选 gif/spine 则关闭 2.5D
  const rm = $("render-mode").value;
  if (rm === "rig") {
    const skins = await window.petAPI.rigSkins();
    if (!skins || !skins.length) { setResult($("other-result"), "请先在「🧩 PSD 角色工具」导入 PSD 皮肤", false); return; }
    await window.petAPI.rigSet(S.rigSkinId || skins[0].id);
    $("rig-switch").checked = true;
  } else if (S.rigSkinId) {
    await window.petAPI.rigSet("");
    $("rig-switch").checked = false;
  }
  // 立即应用桌宠大小（不等重启）
  if (r === true) await window.petAPI.setScale(scale);
  // 2.5D 角色开关（v2.2）：勾选状态变化才处理
  const wantRig = $("rig-switch").checked;
  const hadRig = !!S.rigSkinId;
  if (wantRig !== hadRig) {
    if (wantRig) {
      const skins = await window.petAPI.rigSkins();
      if (skins && skins.length) await window.petAPI.rigSet(skins[0].id);
      else { $("rig-switch").checked = false; setResult($("other-result"), "没有 PSD 皮肤，请先在「🧩 PSD 角色工具」导入", false); return; }
    } else {
      await window.petAPI.rigSet("");
    }
  }
  setResult($("other-result"), r === true ? L("set.saved") : L("set.saveFailed"), r === true);
}

$("btn-agent-token").addEventListener("click", async () => {
  const token = await window.petAPI.generateAgentToken();
  $("agent-token").value = token || "";
  if (window.__setMarkDirty) window.__setMarkDirty(); // Token 需点「保存全部/系统与高级的保存」才落盘（程序赋值不触发 input 事件）
  try { await navigator.clipboard.writeText(token); setResult($("other-result"), "已生成并复制 Token；保存并重启后生效", true); }
  catch { setResult($("other-result"), "已生成 Token；保存并重启后生效", true); }
});

/* ---------- Agent 接入管理（接入名单：显示授权了谁、在线状态、可主动断开） ---------- */
const AGENT_CLIENT_LABEL = (c) => {
  const now = Date.now();
  const online = c.lastSeen && now - c.lastSeen < 5 * 60 * 1000;
  const granted = c.grantedAt ? new Date(c.grantedAt).toLocaleDateString() : "—";
  const seen = c.lastSeen ? new Date(c.lastSeen).toLocaleString() : "从未接入";
  return { online, granted, seen };
};
function renderAgentClients(clients) {
  const box = document.getElementById("agent-clients");
  if (!box) return;
  box.innerHTML = "";
  if (!clients || !clients.length) {
    const empty = document.createElement("div");
    empty.style.cssText = "color:var(--ui-muted);font-size:12px;padding:6px 2px;";
    empty.textContent = "暂无已授权接入方——点下方「新增接入」给其他 agent 生成独立 Token";
    box.appendChild(empty);
    return;
  }
  clients.forEach((c) => {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:8px;padding:5px 0;font-size:13px;border-bottom:1px dashed var(--ui-line);";
    const info = document.createElement("span");
    info.style.cssText = "flex:1;min-width:0;";
    const { online, granted, seen } = AGENT_CLIENT_LABEL(c);
    info.textContent = (online ? "🟢 " : "⚪ ") + c.name + "　授权于 " + granted + "　最近 " + seen;
    info.title = "Token 只在本机使用";
    const tok = document.createElement("button");
    tok.textContent = "👁";
    tok.title = "查看 Token";
    tok.style.cssText = "border:none;background:transparent;cursor:pointer;color:#7d939a;font-size:13px;padding:0 4px;";
    tok.addEventListener("click", () => {
      window.alert(c.name + " 的接入 Token（仅本机 127.0.0.1 使用）：\n\n" + c.token + "\n\n请复制给该接入方。");
    });
    const del = document.createElement("button");
    del.textContent = "断开";
    del.title = "移除该接入方，其 token 立即失效";
    del.style.cssText = "border:1px solid var(--ui-line-strong);background:transparent;cursor:pointer;color:var(--ui-danger);font-size:12px;padding:2px 8px;border-radius:6px;";
    del.addEventListener("click", async () => {
      if (!confirm("断开接入方「" + c.name + "」？其 token 将立即失效。")) return;
      await window.petAPI.removeAgentClient(c.name);
      const aa = (await window.petAPI.getSettings()).agentApi || {};
      renderAgentClients(aa.clients || []);
    });
    row.appendChild(info);
    row.appendChild(tok);
    row.appendChild(del);
    box.appendChild(row);
  });
}
$("btn-agent-client-add").addEventListener("click", async () => {
  const input = document.getElementById("agent-client-name");
  const name = (input && input.value.trim()) || "";
  if (!name) { window.alert("请先填写接入方名称"); return; }
  const r = await window.petAPI.addAgentClient(name);
  if (!r || !r.ok) { window.alert((r && r.message) || "新增失败"); return; }
  if (input) input.value = "";
  window.alert("已授权接入方「" + r.name + "」。\n\nToken：" + r.token + "\n\n请复制给该接入方（仅本机 127.0.0.1 接口使用）。");
  const aa = (await window.petAPI.getSettings()).agentApi || {};
  renderAgentClients(aa.clients || []);
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

/* ---------- 记忆管理（v2.5.2）：查看/删除/清空 ---------- */
(async () => {
  const statsEl = document.getElementById("mem-stats");
  const listEl = document.getElementById("mem-list");
  const btnClear = document.getElementById("mem-clear");
  if (!statsEl || !listEl || !btnClear) return;
  const refresh = async () => {
    // 羁绊进度条（v2.5.26）：等级+经验进度可视化
    const renderBondBar = (b) => {
      const bar = $("bond-bar"), lab = $("bond-bar-label");
      if (!b || b.pct == null) { if (bar) bar.style.width = "0%"; if (lab) lab.textContent = ""; return; }
      bar.style.width = b.pct + "%";
      lab.textContent = b.max
        ? `🥰 羁绊 Lv.${b.level}（MAX）· 已陪伴 ${b.days} 天`
        : `🥰 羁绊 Lv.${b.level} · 距 Lv.${b.level + 1} 还差 ${b.next - b.exp} 经验（已陪伴 ${b.days} 天）`;
    };
    const failText = "记忆读取失败，点击此处重试";
    const showFail = () => {
      statsEl.textContent = failText;
      statsEl.style.cursor = "pointer";
      statsEl.onclick = () => { statsEl.style.cursor = ""; statsEl.onclick = null; refresh(); };
    };
    try {
      // 超时兜底：getMemory 偶发挂起时不再永远停在「加载中…」（6s 未返回即视为异常）
      const r = await Promise.race([
        window.petAPI.getMemory(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("读取超时")), 6000))
      ]);
      if (!r || !Array.isArray(r.facts) || !r.facts.length) {
        statsEl.textContent = "暂无已记住的信息——聊天中提到的称谓/喜好/生日/健康/安排会自动记住（本地加密）";
        listEl.innerHTML = "";
        renderBondBar(r && r.bond);
        return;
      }
      renderBondBar(r.bond);
      statsEl.textContent = "已记住 " + r.facts.length + " 条" + (r.summary ? "（含对话摘要）" : "");
      listEl.innerHTML = "";
      r.facts.forEach((f) => {
        const row = document.createElement("div");
        row.style.cssText = "display:flex;align-items:center;gap:8px;padding:3px 0;font-size:13px;";
        const label = document.createElement("span");
        label.style.cssText = "flex:1;";
        const anchorLbl = ({ PLAN: "计划", PREFERENCE: "偏好", TABOO: "禁忌", EVENT: "重要日子", EMOTION: "情绪状态", RELATION: "关系身份" })[f.anchor] || "";
        label.textContent = (anchorLbl ? "【" + anchorLbl + "】" : "") + "· " + f.text;
        const edit = document.createElement("button");
        edit.textContent = "✎";
        edit.title = "编辑这条";
        edit.style.cssText = "border:none;background:transparent;cursor:pointer;color:#2980b9;font-size:14px;padding:0 4px;";
        // Electron 不支持 window.prompt()（直接返回 null），编辑改用行内输入框
        edit.addEventListener("click", () => {
          const input = document.createElement("input");
          input.type = "text";
          input.value = f.text;
          input.style.cssText = "flex:1;min-width:0;padding:3px 6px;border:1px solid var(--ui-line);border-radius:4px;background:var(--ui-surface);color:inherit;font-size:13px;";
          const save = document.createElement("button");
          save.textContent = "✓";
          save.title = "保存";
          save.style.cssText = "border:none;background:transparent;cursor:pointer;color:#27ae60;font-size:14px;padding:0 4px;";
          const cancel = document.createElement("button");
          cancel.textContent = "✕";
          cancel.title = "取消";
          cancel.style.cssText = "border:none;background:transparent;cursor:pointer;color:#7f8c8d;font-size:14px;padding:0 4px;";
          row.replaceChildren(input, save, cancel);
          input.focus();
          input.select();
          const commit = async (doSave) => {
            if (doSave) {
              const nt = input.value.trim();
              if (nt && nt !== f.text) {
                const r = await window.petAPI.updateMemoryFact(f.id, nt);
                if (!r || !r.ok) { window.alert((r && r.message) || "编辑失败"); return; }
              }
            }
            refresh();
          };
          save.addEventListener("click", () => commit(true));
          cancel.addEventListener("click", () => commit(false));
          input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") commit(true);
            if (e.key === "Escape") commit(false);
          });
        });
        const del = document.createElement("button");
        del.textContent = "✕";
        del.title = "删除这条";
        del.style.cssText = "border:none;background:transparent;cursor:pointer;color:#c0392b;font-size:14px;padding:0 4px;";
        del.addEventListener("click", async () => {
          await window.petAPI.deleteMemoryFact(f.id);
          refresh();
        });
        row.appendChild(label);
        row.appendChild(edit);
        row.appendChild(del);
        listEl.appendChild(row);
      });
    } catch { showFail(); }
  };
  btnClear.addEventListener("click", async () => {
    if (!confirm("确定清空全部记忆吗？她会忘记所有记得的事。")) return;
    await window.petAPI.clearMemory();
    refresh();
  });
  // 手动添加记忆（v2.5.3）：不用等聊天自动提取，直接输入一条
  const addInput = document.getElementById("mem-add-input");
  const addBtn = document.getElementById("mem-add-btn");
  if (addInput && addBtn) {
    const doAdd = async () => {
      const v = addInput.value.trim();
      if (!v) return;
      const r = await window.petAPI.addMemoryFact(v);
      if (r && r.ok) { addInput.value = ""; refresh(); }
      else window.alert((r && r.message) || "添加失败");
    };
    addBtn.addEventListener("click", doAdd);
    addInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doAdd(); });
  }
  refresh();
})();

/* ---------- 情绪音色试听（v2.6）：走真实 GSV 日语链路 + 参考音频，含实时播放参数模拟 ---------- */
(function () {
  if (!window.petAPI || !window.petAPI.emotionAudition) return;
  // 按钮 → 情绪键（voice-refs.json 的键名）与播放速率（基础语速 × 情绪倍率，钳到 [0.9,1.1]，与渲染层一致）
  const AUD = {
    "btn-aud-default":   { key: "__default__", rateMul: 1.0 },
    "btn-aud-coquetry":  { key: "撒娇", rateMul: 1.10 },
    "btn-aud-tsundere":  { key: "傲娇", rateMul: 1.06 },
    "btn-aud-surprised": { key: "惊讶", rateMul: 1.0 },
    "btn-aud-gentle":    { key: "温柔", rateMul: 0.94 },
    "btn-aud-happy":     { key: "开心", rateMul: 1.12 },
  };
  let audAudio = null;
  for (const [id, cfg] of Object.entries(AUD)) {
    const btn = document.getElementById(id);
    if (!btn) continue;
    btn.addEventListener("click", async () => {
      const res = document.getElementById("aud-result");
      if (!res) return;
      if (audAudio) { try { audAudio.pause(); } catch { /* 忽略 */ } audAudio = null; }
      res.textContent = "合成中…";
      try {
        const r = await window.petAPI.emotionAudition(cfg.key);
        if (!r || !r.ok) { res.textContent = (r && r.message) || "合成失败"; return; }
        const base = Number((document.getElementById("tts-rate") || {}).value) || 0.95;
        const audio = new Audio("data:audio/wav;base64," + r.b64);
        audio.playbackRate = Math.max(0.9, Math.min(1.1, base * cfg.rateMul));
        audAudio = audio;
        res.textContent = "播放中…";
        audio.onended = () => { res.textContent = "播放完成"; };
        audio.onerror = () => { res.textContent = "播放失败"; };
        await audio.play().catch(() => { res.textContent = "播放失败（请检查 GSV 服务）"; });
      } catch (e) {
        res.textContent = "合成失败：" + (e && e.message || e);
      }
    });
  }
})();

/* ---------- 情绪音色分档开关（v2.6）：停用档用默认音色/默认语气 ---------- */
(function () {
  const TONES = ["撒娇", "傲娇", "惊讶", "温柔", "开心"];
  if (!window.petAPI || !window.petAPI.setEmotionVoice) return;
  const apply = () => {
    for (const k of TONES) {
      const el = document.getElementById("tone-" + k);
      if (!el) continue;
      el.checked = (S && S.emotionVoice && S.emotionVoice[k] !== undefined) ? !!S.emotionVoice[k] : true;
    }
  };
  let tries = 0;
  const wait = setInterval(() => {
    tries++;
    if (S && S.emotionVoice) { apply(); clearInterval(wait); }
    else if (tries > 12) { apply(); clearInterval(wait); }
  }, 300);
  for (const k of TONES) {
    const el = document.getElementById("tone-" + k);
    if (el) el.addEventListener("change", () => window.petAPI.setEmotionVoice(k, el.checked));
  }
})();

/* ---------- 左侧导航 / 搜索 / 未保存提示条（v2.5.18） ---------- */
/* 背景：9 个分区 4~5 屏单列盲滚 + 右下角悬浮保存只保存"通用设置"（作用域陷阱）。
   现在：左栏锚点 + scroll-spy 高亮 + 搜索过滤；任何需显式保存的改动触发顶部提示条，
   「保存全部」按 API → 人设 → 语音 → 系统高级 顺序依次走各自既有的保存函数。 */

function syncNavVisibility() {
  document.querySelectorAll(".set-nav a").forEach((a) => {
    const sec = document.querySelector(a.getAttribute("href"));
    a.style.display = (!sec || sec.style.display === "none") ? "none" : "";
  });
}

(function setupSettingsNav() {
  const links = [...document.querySelectorAll(".set-nav a")];
  if (!links.length) return;

  // scroll-spy：滚动时高亮当前分区对应的导航项
  if ("IntersectionObserver" in window) {
    const byId = new Map(links.map((a) => [a.getAttribute("href").slice(1), a]));
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (!en.isIntersecting) return;
        links.forEach((l) => l.classList.remove("active"));
        const a = byId.get(en.target.id);
        if (a) a.classList.add("active");
      });
    }, { rootMargin: "-8% 0px -75% 0px", threshold: 0 });
    links.forEach((a) => { const s = document.querySelector(a.getAttribute("href")); if (s) io.observe(s); });
  }
  if (links[0]) links[0].classList.add("active");

  // 搜索过滤：按文本内容显示/隐藏分区（优先于渲染模式过滤；清空后恢复渲染模式过滤）
  const searchInput = $("set-search");
  if (searchInput) {
    searchInput.addEventListener("input", () => {
      const q = searchInput.value.trim().toLowerCase();
      const sections = document.querySelectorAll(".set-main > section");
      if (!q) {
        applyRenderModeUI($("render-mode").value);
      } else {
        sections.forEach((s) => {
          const hit = (s.textContent || "").toLowerCase().includes(q);
          s.style.display = hit ? "" : "none";
        });
      }
      syncNavVisibility();
    });
  }

  // 未保存改动跟踪：只盯"需要显式保存"的控件；即时生效类（INSTANT_IDS）与情绪分档（tone-*）不触发
  const INSTANT_IDS = new Set(["render-mode", "theme-select", "ui-lang", "rig-scale", "rig-mouse",
    "rig-mouse-global", "cat-toy", "walk-global", "soft-render", "file-guard", "proactive-chat",
    "personify", "rp-mode", "ws-watch", "ws-watch-dirs", "seat-sink", "sit-max", "walk-max",
    "chat-font", "chat-font-size", "bubble-width", "live2d-scale", "mem-add-input",
    "agent-client-name", "cred-source", "cred-slot"]);
  let dirtyOn = false;
  const bar = $("set-dirty");
  function markDirty() { if (!dirtyOn && bar) { dirtyOn = true; bar.hidden = false; } }
  function hideBarSoon() {
    setTimeout(() => {
      if (!dirtyOn && bar) {
        bar.hidden = true;
        const res = $("set-dirty-result");
        if (res) setResult(res, "");
      }
    }, 2000);
  }
  const setMain = document.querySelector(".set-main");
  if (setMain) {
    const onEdit = (e) => {
      const t = e.target;
      if (!t || !t.id || INSTANT_IDS.has(t.id) || String(t.id).startsWith("tone-")) return;
      if (t.id === "persona") personaDirty = true;
      markDirty();
    };
    setMain.addEventListener("input", onEdit, true);
    setMain.addEventListener("change", onEdit, true);
  }

  const btnAll = $("set-save-all");
  if (btnAll) btnAll.addEventListener("click", async () => {
    const res = $("set-dirty-result");
    if (res) setResult(res, "");
    try { await doSaveApi(); } catch { /* 失败提示见「聊天 API」分区 result */ }
    if (personaDirty) { try { await doSavePersona(); } catch { /* 见「人设」分区 */ } }
    try { await doSaveVoice(); } catch { /* 见「语音」分区 */ }
    try { await doSaveOther(); } catch { /* 见「系统与高级」分区 */ }
    const otherErr = $("other-result") && $("other-result").classList.contains("err");
    if (otherErr) { if (res) setResult(res, L("set.dirtyPartial"), false); return; } // 保持提示条可见
    dirtyOn = false;
    if (res) setResult(res, L("set.allSaved"), true);
    hideBarSoon();
  });
  const btnDiscard = $("set-discard");
  if (btnDiscard) btnDiscard.addEventListener("click", () => {
    if (!confirm("放弃所有未保存的改动？页面将重新加载，已填内容会恢复为上次保存的值。")) return;
    location.reload();
  });

  // 供外部调用：生成 Agent Token 后 .value 是程序赋值不触发 input 事件，需手动标记
  window.__setMarkDirty = markDirty;
})();
