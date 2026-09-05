/**
 * SuzuranPet 配置模块（分享版）
 * - 读取/合并 config.json（默认值 + 用户覆盖）
 * - 支持任意 OpenAI 兼容 / Anthropic API
 * - zcode 任务模式默认关闭（可选手动开启）
 * - 人设/规则里的 {{petName}} / {{userName}} 占位符统一替换
 */
"use strict";

const fs = require("fs");
const path = require("path");

const storage = require("./storage");
const secrets = require("./secrets");
const { sanitizeClients } = require("./agent-auth");
const APP_DIR = storage.APP_DIR; // 只读程序资源目录
const STORAGE = storage.initializeStorage();
const CONFIG_PATH = STORAGE.config;
const PERSONA_PATH = STORAGE.persona;
const PERSONA_DEFAULT_PATH = STORAGE.personaDefault;
const os = require("os");
const DEFAULT_WORKSPACE = path.join(os.homedir(), ".zcode", "workspace", "default");

const DEFAULT_MOODS = [
  { name: "idle1", label: "待机1", emotion: false },
  { name: "idle2", label: "待机2", emotion: false },
  { name: "idle3", label: "发呆", emotion: true },
  { name: "idle4", label: "喝饮料", emotion: true },
  { name: "idle5", label: "送花", emotion: true },
  { name: "idle6", label: "手工", emotion: true },
  { name: "idle7", label: "展示", emotion: true },
  { name: "happy", label: "开心", emotion: true },
  { name: "wow", label: "惊喜", emotion: true },
  { name: "think", label: "思考", emotion: true },
  { name: "wave", label: "挥手", emotion: true },
  { name: "angry", label: "生气", emotion: true },
  { name: "cry", label: "委屈", emotion: true },
  { name: "sleep", label: "睡觉", emotion: true },
  { name: "kiss", label: "飞吻", emotion: true },
  { name: "work", label: "工作", emotion: true },
  { name: "tsundere", label: "傲娇", emotion: true },
  { name: "coquetry", label: "撒娇", emotion: true },
  { name: "gentle", label: "温柔", emotion: true },
  { name: "surprised", label: "惊讶", emotion: true },
  { name: "dizzy", label: "晕", emotion: true }
];

const DEFAULTS = {
  pet: { name: "苏苏洛" },                  // 桌宠名字（人设占位符 {{petName}}）
  agreed: false,                            // 是否已同意《使用条款与隐私政策》（不同意无法使用）
  moods: DEFAULT_MOODS,                     // 情绪表：name=文件名，label=情绪词（≤5字，模型按它选），emotion=true 才会进模型情绪词表
  agentApi: {                               // 本地 Agent 调用接口（仅 127.0.0.1）
    enabled: false,
    port: 8765,
    invokeWord: "",                         // 自定义调用词：非空时 /chat 要求消息以该词开头
    bearerToken: "",                        // 主 Token：空=兼容旧脚本不认证（仍校验 clients）；设置后所有路由都需 Bearer token
    maxBodyBytes: 65536,
    statusEnabled: true,                    // 任务状态展示（反幻觉）+ 向已授权 Agent 开放 GET /status
    clients: []                             // 已授权接入的 agent：{name, token, grantedAt, lastSeen}
  },
  zcodeCli: "",                             // 空 → 自动探测（分享版默认关闭）
  workspace: DEFAULT_WORKSPACE,
  zcodeEnabled: false,                      // 任务模式开关（分享版默认关）
  firstRunAt: null,                         // 首次启动时间戳（陪伴时间统计）
  chat: {
    apiType: "openai",                      // openai（OpenAI 兼容，含 DeepSeek/Kimi/GLM/Ollama 等）| anthropic
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    apiKey: "",                             // 朋友自己填（localhost 可留空，如 Ollama）
    userName: "博士",                        // 桌宠对你的称呼（人设占位符 {{userName}}；v2.5.26 默认与 IP 设定/硬编码台词统一，可在设置改）
    temperature: 0.85,
    maxTokens: 800,
    maxHistoryTurns: 20,
    sampling: { // v2.5.13 RP 采样参数（默认值按本地小模型配方；设置页可调）
      topP: 0.9,
      minP: 0.05,
      repeatPenalty: 1.1,
      presencePenalty: 0.1,
      frequencyPenalty: 0.1
    }
  },
  window: { x: null, y: null, width: 260, height: 200, scale: 1.0 }, // scale：桌宠显示大小（0.6~2.0）
  renderMode: "gif",                        // 渲染模式：gif=经典表情包 | spine=Spine 小人模型（支持桌面行走）
  layer: "top",                             // 显示层级：top=置顶（在所有窗口眼前）| desktop=桌面层级（可被其他窗口遮挡）
  spineSkinId: "",                          // Spine 皮肤 id（""=内置苏苏洛；spine/user/ 子文件夹名+文件基名）
  rigSkinId: "",                            // PSD 2.5D 角色皮肤 id（""=未启用；rig/user/ 下的 .psd 文件名）
  rigScale: 1.0,                            // PSD 2.5D 角色显示大小（0.5~1.5，设置页滑杆）
  rigMouseFollow: true,                     // PSD 2.5D 头部/眼睛跟随鼠标（v2.2.1 实验性）
  mouseTrackGlobal: false,                  // 全局鼠标跟踪（v2.2.1 实验性，需显式许可默认关）：读取屏幕鼠标位置，角色始终看向鼠标
  catToy: false,                            // 逗猫棒（需显式许可默认关）：读取鼠标位置，角色追着鼠标走
  walkGlobal: false,                        // 桌面全域行走（实验，默认关）：走到整个虚拟桌面（多显示器连屏），地面仍随所在显示器
  softRender: false,                        // 软件渲染（默认关，重启生效）：无独显/驱动异常环境用 CPU 渲染兜底（WebGL 走 SwiftShader）
  fileGuard: false,                          // 蜜标监控（默认关）：检测其他程序访问桌宠敏感配置区域
  proactiveChat: true,                       // 主动搭话（默认开，设置页单独开关）：闲置后主动开口
  personify: true,                           // 人格化（默认开，设置页单独开关）：被抛掷/睡醒/坐窗等事件时小声嘀咕
  rpMode: true,                              // 角色扮演模式（默认开=现有 RP 深度；关=助手模式：优先服从指令、回复直接简洁）
  walking: false,                           // 桌面行走开关（仅 spine 模式生效；GIF 模式下强制无效）
  walkTiming: { sitMaxSec: 30, walkMaxSec: 20 }, // 行走节奏：单次坐下/散步的最长秒数（保底随机），设置页可调
  appearance: { fontFamily: "", fontSize: 0, bubbleWidth: 0, customFonts: [] }, // 聊天外观：字体（""=默认雅黑/"custom:文件名"）、字号px(0=默认11)、气泡宽度px(0=自适应)、已导入本地字体
  firstRun: true,                           // 首次启动自动弹设置引导
  tts: { enabled: false, voice: "", rate: 0.9, pitch: 1.1, fixedOnly: false }, // 语音总开关（默认关）；rate=语速（<1 慢 >1 快）；fixedOnly=固定台词离线模式（引擎可关省显存，只播已缓存音频）
  ttsCloud: { // edge-tts 云端语音（需安装 Python + edge-tts；失败自动回退系统语音）
    enabled: false,
    voice: "zh-CN-XiaoxiaoNeural",
    rate: "+8%",
    pitch: "+0Hz"
  },
  ttsCosy: { // 百炼 CosyVoice 复刻音色（需 API Key；失败自动回退 edge-tts）
    enabled: false,
    apiKey: "",
    model: "cosyvoice-v3.5-plus",
    voice: "",
    rate: 1.0,
    pitch: 1.0,
    volume: 100
  },
  ttsGenie: { // 本地 Genie (GPT-SoVITS) 克隆音色（需按「语音部署与训练指南」部署）
    enabled: false,
    server: "http://127.0.0.1:9881",
    allowRemote: false,
    autoStart: true,
    python: "",          // 如 D:\GenieTTS\venv\Scripts\pythonw.exe
    serverScript: "",    // 如 D:\GenieTTS\genie_tts_server.py
    refAudio: "",        // 克隆参考音频（空 = 服务器默认）
    refText: "",         // 参考音频的原文
    speakJa: false,      // 日语语音模式：界面文字保持中文，说话时先翻译成日语（配合本地日语微调音色）
    startTimeout: 240000
  },
  ttsGsv: { // 日语语音引擎（GPT-SoVITS v2ProPlus 本地推理，配合 speakJa 日语模式；无日语 G2P 的 Genie 说不了日语）
    enabled: true,
    server: "http://127.0.0.1:9880",
    allowRemote: false,
    autoStart: true,
    python: "",          // 如 D:\GenieTTS\venv\Scripts\pythonw.exe
    serverScript: "",    // 如 D:\GenieTTS\genie_tts_server.py
    sovitsPath: "",      // 训练好的 SoVITS 模型 .pth
    gptPath: "",         // 训练好的 GPT 模型 .ckpt
    refAudio: "",        // 日语参考音频（3~10s 干净人声）
    refText: "",         // 参考音频的日语原文
    device: "",          // 推理设备：空=引擎自动（GPU）| "cpu"=强制 CPU（显存被其他程序挤占时稳定但慢）
    startTimeout: 240000
  },
  hotkey: "Alt+Shift+S",
  startHidden: false,
  greetingOnStart: true, // 启动时自动问候（气泡 + 语音），可在设置里关闭,
  uiLang: "zh", // 界面语言：zh=中文 | en=English | ja=日本語（聊天内容始终为中文）
  security: { externalCredNoticeSeen: false }, // 曾隐式读取外部凭据的非阻塞提示：用户点“知道了”后不再显示
  features: { // 功能开关（每个敏感权限单独授权，默认关闭）
    clipboardWatch: false,    // 剪贴板感知：读取系统剪贴板内容并反应
    workspaceWatch: { enabled: false, dirs: [], cooldownMin: 5 }, // 感知工作区活动：只读监听文件变化，她会在你改代码时小声嘀咕（dirs 空 = 默认监听 ZCode workspace）
    systemMonitor: false,     // 系统监控播报：CPU/内存异常时角色语音提醒
    screenAwareness: false,   // 屏幕感知：定期截屏分析（需配置视觉模型）
    desktopIcons: false,      // 桌面图标感知：只读图标位置坐标（仅本机、不上传），让她走到图标上站/坐（需桌面层级模式）
    longTermMemory: true,     // 长期记忆摘要：自动记住重要对话内容
    vectorMemory: true,       // 向量记忆（§14 追加 102）：语义检索历史对话片段回引细节（本地哈希向量，零依赖）
    emotionalVoice: true,     // 情绪语音：根据情绪调整语速/音调
    pomodoro: true,           // 番茄钟伴侣
    proactiveInterval: 8      // 主动搭话间隔（分钟）
  }
};

let cache = null;

function loadPetConfig() {
  try {
    // 容忍 BOM（记事本等以 UTF-8 BOM 保存会导致 JSON.parse 失败 → 误回收默认值）
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8").replace(/^﻿/, ""));
  } catch {
    return {};
  }
}

function deepMerge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    if (v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object") {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

/** 探测 zcode.cjs 位置：先看配置文件，再探测常见路径 */
function detectZcodeCli() {
  const candidates = [
    process.env.ZCODE_CLI,
    "C:\\ZCODE\\resources\\glm\\zcode.cjs",
    "E:\\ZCODE\\resources\\glm\\zcode.cjs"
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return "";
}

/** v2.5.22 清理：detectApiKeyFromZcode / detectDashScopeKey 已删除（无外部调用，且与 README"不读取其他密钥"承诺存在误解空间） */

function getConfig(force = false) {
  if (cache && !force) return cache;
  const pet = loadPetConfig();
  const cfg = deepMerge(DEFAULTS, pet);

  cfg.chat.apiKey = secrets.get("chatApiKey") || cfg.chat.apiKey || "";
  cfg.ttsCosy.apiKey = secrets.get("ttsCosyApiKey") || cfg.ttsCosy.apiKey || "";
  cfg.agentApi.bearerToken = secrets.get("agentBearerToken") || cfg.agentApi.bearerToken || "";
  if (!cfg.zcodeCli) cfg.zcodeCli = detectZcodeCli();
  cfg._keySource = cfg.chat.apiKey ? (secrets.status("chatApiKey").saved ? "安全本地存储" : "config.json") : "未配置（请在设置中填写或显式导入 API Key）";
  cfg._configPath = CONFIG_PATH;
  cache = cfg;
  return cfg;
}

function initializeSecretStorage(safeStorage) {
  const raw = loadPetConfig();
  const info = secrets.initialize(safeStorage);
  if (!info.chatApiKey.available) return info;
  const migrated = secrets.migratePlaintext(raw);
  if (migrated.migrated) {
    if (raw.chat) delete raw.chat.apiKey;
    if (raw.ttsCosy) delete raw.ttsCosy.apiKey;
    if (raw.agentApi) delete raw.agentApi.bearerToken;
    storage.atomicWrite(CONFIG_PATH, JSON.stringify(raw, null, 2));
  }
  cache = null;
  return secrets.status();
}
function secretStatus() { return secrets.status(); }
function replaceSecrets(values) { const out = secrets.replace(values); cache = null; return out; }

/**
 * 设置页快照（pet:get-settings 的返回体）。
 * 密钥槽位一律不回传原值：chat.apiKey / ttsCosy.apiKey / agentApi.bearerToken 置为 undefined，
 * renderer 只能拿到 secretStatus() 的 saved/unreadable/available 布尔状态。
 */
function buildSettingsView() {
  const cfg = getConfig();
  return {
    pet: cfg.pet,
    chat: {
      apiType: cfg.chat.apiType,
      baseUrl: cfg.chat.baseUrl,
      model: cfg.chat.model,
      userName: cfg.chat.userName,
      temperature: cfg.chat.temperature,
      maxTokens: cfg.chat.maxTokens,
      maxHistoryTurns: cfg.chat.maxHistoryTurns
    },
    tts: cfg.tts,
    ttsCloud: cfg.ttsCloud,
    ttsCosy: { ...cfg.ttsCosy, apiKey: undefined },
    ttsGenie: cfg.ttsGenie,
    emotionVoice: cfg.emotionVoice || {}, // 情绪音色分档开关（v2.6）
    zcodeEnabled: !!cfg.zcodeEnabled,
    zcodeCli: cfg.zcodeCli,
    agreed: !!cfg.agreed,
    scale: cfg.window.scale || 1.0,
    agentApi: {
      ...cfg.agentApi,
      bearerToken: undefined,
      clients: sanitizeClients(cfg.agentApi && cfg.agentApi.clients).map(({ tokenHash, ...client }) => ({
        ...client,
        hasToken: !!tokenHash
      }))
    }, // 不向 renderer 回传接入方 token 原值或 hash
    secretStatus: secrets.status(),
    security: cfg.security || { externalCredNoticeSeen: false },
    hotkey: cfg.hotkey,
    startHidden: !!cfg.startHidden,
    uiLang: cfg.uiLang || "zh",
    renderMode: cfg.renderMode === "spine" ? "spine" : cfg.renderMode === "rig" ? "rig" : "gif",
    rigSkinId: cfg.rigSkinId || "", // PSD 2.5D 皮肤（v2.2）
    rigScale: Number(cfg.rigScale) > 0 ? Number(cfg.rigScale) : 1.0,
    rigMouseFollow: cfg.rigMouseFollow !== false, // 2.5D 头部/眼睛跟随鼠标（v2.2.1 实验性）
    mouseTrackGlobal: !!cfg.mouseTrackGlobal, // 全局鼠标跟踪（v2.2.1 实验性，需显式许可默认关）
    catToy: !!cfg.catToy, // 逗猫棒（需显式许可默认关）
    proactiveChat: cfg.proactiveChat !== false, // 主动搭话（设置页单独开关）
    personify: cfg.personify !== false, // 人格化（设置页单独开关）
    features: cfg.features || {}, // 功能开关快照（剪贴板/系统监控/工作区感知等）
    rpMode: cfg.rpMode !== false, // 角色扮演模式（设置页单独开关）：关=助手模式优先服从指令
    // v2.5.28 修复：设置页回显缺字段——theme 缺失导致主题下拉每次打开都显示"自动随时间"
    // （用户选了深色、config 也存了，仅回显丢失）；softRender/live2d* 同批补齐
    theme: cfg.theme || "auto",
    softRender: !!cfg.softRender,
    live2dSkinId: cfg.live2dSkinId || "",
    live2dScale: Number(cfg.live2dScale) > 0 ? Number(cfg.live2dScale) : 1.0,
    walking: !!cfg.walking,
    persona: getPersonaText(),
    hasPersonaDefault: fs.existsSync(PERSONA_DEFAULT_PATH),
    keySource: cfg._keySource
  };
}

function normalizePetName(value) {
  const name = String(value || "").trim().replace(/\s+/g, " ");
  return name ? name.slice(0, 24) : "苏苏洛";
}

function saveConfig(patch) {
  if (patch?.pet && Object.prototype.hasOwnProperty.call(patch.pet, "name")) {
    patch = { ...patch, pet: { ...patch.pet, name: normalizePetName(patch.pet.name) } };
  }
  try { require("./file-guard").checkBeforeWrite(); } catch { /* 蜜标监控未启用 */ }
  const cfg = getConfig(true);
  const merged = deepMerge(cfg, patch);
  const clean = JSON.parse(JSON.stringify(merged));
  delete clean._keySource;
  delete clean._configPath;
  // 运行时解密的值绝不可因普通设置保存重新写回 config.json。
  delete clean.chat.apiKey;
  delete clean.ttsCosy.apiKey;
  delete clean.agentApi.bearerToken;
  clean.agentApi.clients = sanitizeClients(clean.agentApi.clients);
  if (!patch?.zcodeCli && !loadPetConfig()?.zcodeCli) clean.zcodeCli = "";
  storage.atomicWrite(CONFIG_PATH, JSON.stringify(clean, null, 2));
  cache = null;
  try { require("./file-guard").noteConfigWritten(); } catch { /* 蜜标监控未启用 */ }
}

/** 把人设/规则文本里的 {{petName}}、{{userName}} 替换成实际称呼 */
function fillTokens(text) {
  const cfg = getConfig();
  const petName = normalizePetName(cfg.pet && cfg.pet.name);
  const userName = (cfg.chat && cfg.chat.userName) || "博士";
  return String(text || "")
    .replace(/\{\{\s*petName\s*\}\}/g, petName)
    .replace(/\{\{\s*userName\s*\}\}/g, userName)
    .replace(/\{\{\s*用户\s*\}\}/g, userName);
}

function getPersonaText() {
  try {
    return fs.readFileSync(PERSONA_PATH, "utf8");
  } catch {
    return "";
  }
}

function savePersonaText(text) {
  fs.writeFileSync(PERSONA_PATH, String(text || ""), "utf8");
}

function resetPersona() {
  const def = fs.readFileSync(PERSONA_DEFAULT_PATH, "utf8");
  fs.writeFileSync(PERSONA_PATH, def, "utf8");
  return def;
}

module.exports = {
  APP_DIR, STORAGE, CONFIG_PATH, PERSONA_PATH, PERSONA_DEFAULT_PATH,
  getConfig, saveConfig, getPersonaText, savePersonaText, resetPersona,
  initializeSecretStorage, secretStatus, replaceSecrets, buildSettingsView,
  fillTokens, detectZcodeCli
};

// CLI 冒烟测试：node src/config.js --test
if (process.argv.includes("--test")) {
  const cfg = getConfig(true);
  console.log("pet.name:", cfg.pet.name);
  console.log("zcodeEnabled:", cfg.zcodeEnabled);
  console.log("chat.baseUrl:", cfg.chat.baseUrl);
  console.log("chat.model:", cfg.chat.model);
  console.log("chat.apiType:", cfg.chat.apiType);
  console.log("chat.userName:", cfg.chat.userName);
  console.log("apiKey:", cfg.chat.apiKey ? `✓ 已配置 (${cfg.chat.apiKey.slice(0, 6)}...)` : "❌ 未配置");
  console.log("keySource:", cfg._keySource);
  console.log("tts.enabled:", cfg.tts.enabled);
  console.log("fillTokens:", fillTokens("我是{{petName}}，{{userName}}好"));
}
