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

const APP_DIR = path.dirname(__dirname); // 分享版应用目录
const CONFIG_PATH = path.join(APP_DIR, "config.json");
const PERSONA_PATH = path.join(APP_DIR, "persona.md");
const PERSONA_DEFAULT_PATH = path.join(APP_DIR, "persona.default.md");
const ZCODE_V2_CONFIG = path.join(process.env.USERPROFILE || "C:\\Users\\xsbil", ".zcode", "v2", "config.json");
const DEFAULT_WORKSPACE = path.join(process.env.USERPROFILE || "C:\\Users\\xsbil", ".zcode", "workspace", "default");

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
  { name: "surprised", label: "惊讶", emotion: true },
  { name: "dizzy", label: "晕", emotion: true }
];

const DEFAULTS = {
  pet: { name: "苏苏洛" },                  // 桌宠名字（人设占位符 {{petName}}）
  agreed: false,                            // 是否已同意《使用条款与隐私政策》（不同意无法使用）
  moods: DEFAULT_MOODS,                     // 情绪表：name=文件名，label=情绪词（≤5字，模型按它选），emotion=true 才会进模型情绪词表
  agentApi: {                               // 本地 Agent 调用接口（仅 127.0.0.1）
    enabled: true,
    port: 8765,
    invokeWord: ""                          // 自定义调用词：非空时 /chat 要求消息以该词开头
  },
  zcodeCli: "",                             // 空 → 自动探测（分享版默认关闭）
  workspace: DEFAULT_WORKSPACE,
  zcodeEnabled: false,                      // 任务模式开关（分享版默认关）
  chat: {
    apiType: "openai",                      // openai（OpenAI 兼容，含 DeepSeek/Kimi/GLM/Ollama 等）| anthropic
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    apiKey: "",                             // 朋友自己填（localhost 可留空，如 Ollama）
    userName: "主人",                        // 桌宠对你的称呼（人设占位符 {{userName}}）
    temperature: 0.85,
    maxTokens: 800,
    maxHistoryTurns: 20
  },
  window: { x: null, y: null, width: 260, height: 200, scale: 1.0 }, // scale：桌宠显示大小（0.6~2.0）
  firstRun: true,                           // 首次启动自动弹设置引导
  tts: { enabled: false, voice: "", rate: 0.9, pitch: 1.1 }, // 语音总开关（默认关）；rate=语速（<1 慢 >1 快）
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
    python: "",          // 如 E:\GenieTTS\venv\Scripts\pythonw.exe
    serverScript: "",    // 如 E:\GenieTTS\genie_tts_server.py
    refAudio: "",        // 克隆参考音频（空 = 服务器默认）
    refText: "",         // 参考音频的原文
    speakJa: false,      // 日语语音模式：界面文字保持中文，说话时先翻译成日语（配合本地日语微调音色）
    startTimeout: 240000
  },
  ttsGsv: { // 日语语音引擎（GPT-SoVITS v2ProPlus 本地推理，配合 speakJa 日语模式；无日语 G2P 的 Genie 说不了日语）
    enabled: true,
    server: "http://127.0.0.1:9880",
    python: "",          // 如 D:\GPT-SoVITS\runtime\python.exe
    serverScript: "",    // 如 D:\GPT-SoVITS\api.py
    sovitsPath: "",      // 训练好的 SoVITS 模型 .pth
    gptPath: "",         // 训练好的 GPT 模型 .ckpt
    refAudio: "",        // 日语参考音频（3~10s 干净人声）
    refText: "",         // 参考音频的日语原文
    startTimeout: 240000
  },
  hotkey: "Alt+Shift+S",
  startHidden: false,
  greetingOnStart: true, // 启动时自动问候（气泡 + 语音），可在设置里关闭,
  uiLang: "zh" // 界面语言：zh=中文 | en=English | ja=日本語（聊天内容始终为中文）
};

let cache = null;

function loadPetConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
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

/** 从 ZCode v2 配置中提取第一个带 API Key 的 provider（本机没有就返回空） */
function detectApiKeyFromZcode() {
  try {
    const raw = JSON.parse(fs.readFileSync(ZCODE_V2_CONFIG, "utf8"));
    const providers = raw.provider || {};
    const entries = Object.entries(providers).filter(([, p]) => p);
    const hasKey = (p) => !!((p.options && p.options.apiKey) || p.apiKey);
    const getKey = (p) => (p.options && p.options.apiKey) || p.apiKey;
    const pick = entries.find(([, p]) => /deepseek/i.test(String(p.name || "")) && hasKey(p)) ||
                 entries.find(([, p]) => hasKey(p));
    if (pick) {
      return { apiKey: getKey(pick[1]), providerId: pick[1].id || pick[1].name || pick[0], baseURL: pick[1].options?.baseURL || pick[1].baseURL };
    }
  } catch { /* 无配置则返回空 */ }
  return { apiKey: "", providerId: "", baseURL: "" };
}

/** 从 vision 技能 .env 读取 DashScope（百炼）API Key */
function detectDashScopeKey() {
  try {
    const p = path.join(process.env.USERPROFILE || "C:\\Users\\xsbil", ".zcode", "skills", "vision", ".env");
    if (!fs.existsSync(p)) return "";
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*DASHSCOPE_API_KEY\s*=\s*(.+?)\s*$/);
      if (m && m[1]) return m[1].trim().replace(/^["']|["']$/g, "");
    }
  } catch { /* 无配置则返回空 */ }
  return "";
}

function getConfig(force = false) {
  if (cache && !force) return cache;
  const pet = loadPetConfig();
  const cfg = deepMerge(DEFAULTS, pet);

  if (!cfg.zcodeCli) cfg.zcodeCli = detectZcodeCli();
  if (!cfg.chat.apiKey) {
    const { apiKey, providerId, baseURL } = detectApiKeyFromZcode();
    if (apiKey) {
      cfg.chat.apiKey = apiKey;
      cfg._keySource = providerId ? `自动复用 ZCode 配置 (${providerId})` : "自动复用 ZCode 配置";
      if (/deepseek/i.test(String(providerId))) {
        cfg.chat.baseUrl = "https://api.deepseek.com/v1";
      } else if (baseURL && /anthropic/i.test(String(baseURL))) {
        cfg.chat.baseUrl = baseURL.replace(/\/anthropic\/?$/i, "") + "/v1";
      }
    } else {
      cfg._keySource = "未配置（请在设置中填写 API Key）";
    }
  } else {
    cfg._keySource = "config.json";
  }
  if (!cfg.ttsCosy.apiKey) cfg.ttsCosy.apiKey = detectDashScopeKey();
  cfg._configPath = CONFIG_PATH;
  cache = cfg;
  return cfg;
}

function saveConfig(patch) {
  const cfg = getConfig(true);
  const merged = deepMerge(cfg, patch);
  const clean = JSON.parse(JSON.stringify(merged));
  delete clean._keySource;
  delete clean._configPath;
  // 关键：不要把「自动探测/复用的 Key」写进配置文件（只在运行时生效，避免泄露本机其他软件的密钥）
  // 只有用户显式填写的 Key（patch 里带 chat.apiKey / ttsCosy.apiKey）才允许落盘
  const user = loadPetConfig();
  if (!patch?.chat?.apiKey && !user?.chat?.apiKey) clean.chat.apiKey = "";
  if (!patch?.ttsCosy?.apiKey && !user?.ttsCosy?.apiKey) clean.ttsCosy.apiKey = "";
  if (!patch?.zcodeCli && !user?.zcodeCli) clean.zcodeCli = ""; // 自动探测的 CLI 路径也不落盘
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(clean, null, 2), "utf8");
  cache = null;
}

/** 把人设/规则文本里的 {{petName}}、{{userName}} 替换成实际称呼 */
function fillTokens(text) {
  const cfg = getConfig();
  const petName = (cfg.pet && cfg.pet.name) || "苏苏洛";
  const userName = (cfg.chat && cfg.chat.userName) || "主人";
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
  APP_DIR, CONFIG_PATH, PERSONA_PATH, PERSONA_DEFAULT_PATH,
  getConfig, saveConfig, getPersonaText, savePersonaText, resetPersona,
  fillTokens, detectZcodeCli, detectApiKeyFromZcode
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
