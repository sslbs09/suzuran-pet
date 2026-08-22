/**
 * SuzuranPet 功能模块 — 语音输入 / 主动搭话 / 日程提醒 / 情绪语音
 * / 系统监控 / 剪贴板感知 / 番茄钟 / 梦境模式
 */
"use strict";

const { spawn, exec } = require("child_process");
const path = require("path");
const fs = require("fs");

const config = require("./config");

/* ============================================================
 * 1. 语音输入（麦克风 → whisper → 文字）
 * ============================================================ */
const STT_SCRIPT = path.join(config.APP_DIR, "scripts", "stt_whisper.py");

/** 用 GSV runtime 的 faster-whisper 做语音转文字 */
async function speechToText(audioPath, lang = "ja") {
  // 自动探测 GSV runtime Python
  const gsvCandidates = [
    "E:\\GSV-training\\GPT-SoVITS-v2pro-20250604\\runtime\\python.exe",
    "D:\\GPT-SoVITS\\runtime\\python.exe",
    "C:\\GPT-SoVITS\\runtime\\python.exe",
  ];
  const gsvPy = gsvCandidates.find((p) => fs.existsSync(p));
  if (!gsvPy) return { ok: false, text: "", error: "未找到 GSV 运行时（请安装 GPT-SoVITS）" };
  if (!fs.existsSync(STT_SCRIPT)) return { ok: false, text: "", error: "stt_whisper.py 不存在" };

  const gsvKit = path.dirname(path.dirname(gsvPy));
  return new Promise((resolve) => {
    const proc = spawn(gsvPy, [STT_SCRIPT, audioPath, lang], {
      env: { ...process.env, GSV_KIT: gsvKit },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "", err = "";
    proc.stdout.on("data", (d) => out += d);
    proc.stderr.on("data", (d) => err += d);
    proc.on("close", (code) => {
      if (code === 0 && out.trim()) {
        resolve({ ok: true, text: out.trim() });
      } else {
        resolve({ ok: false, text: "", error: (err || out || "转写失败").slice(0, 200) });
      }
    });
    proc.on("error", (e) => resolve({ ok: false, text: "", error: e.message }));
  });
}

/* ============================================================
 * 2. 主动搭话（闲置后主动开口）
 * ============================================================ */
let proactiveTimer = null;
let lastChatTs = Date.now();

const PROACTIVE_PROMPTS = [
  "博士，好安静呀……在忙什么呢？",
  "（偷偷看了一眼）博士是不是忘记休息了？",
  "我泡了药茶，博士要喝一杯吗？",
  "（尾巴轻轻晃了晃）博士，聊聊天嘛～",
  "工作再忙也要喝水哦，博士！",
  "（凑近看了看）博士的脸色好像不太好……",
  "嗯……我在想，博士今天的心情怎么样呢？",
  "博士，要不要我给你做个例行检查？",
  "（歪着头）刚才那个话题，然后呢？",
  "坐太久了哦，站起来活动一下吧，博士～",
  "今天的天气好像不错呢，博士要不要休息一下？",
  "（小声）博士……我能再靠近一点吗？",
];

function touchChat() {
  lastChatTs = Date.now();
}

function startProactive(sendFn, intervalMin = 8) {
  stopProactive();
  const intervalMs = intervalMin * 60 * 1000;
  proactiveTimer = setInterval(() => {
    const idle = Date.now() - lastChatTs;
    if (idle < intervalMs) return;
    // 30% 概率触发（避免太频繁）
    if (Math.random() > 0.3) return;
    const prompt = PROACTIVE_PROMPTS[Math.floor(Math.random() * PROACTIVE_PROMPTS.length)];
    lastChatTs = Date.now();
    sendFn(prompt);
  }, 60 * 1000); // 每分钟检查一次
}

function stopProactive() {
  if (proactiveTimer) clearInterval(proactiveTimer);
  proactiveTimer = null;
}

/* ============================================================
 * 3. 日程提醒（"下午3点提醒我…" → 到点语音提醒）
 * ============================================================ */
const reminders = []; // { text, at, timer }

/** 解析中文时间表达式，返回毫秒时间戳或 null */
function parseTime(text) {
  const now = new Date();
  let h = null, m = 0;

  // "X点Y分" / "X点" / "X:Y"
  let m1 = text.match(/(\d{1,2})[点时:：](\d{1,2})?[分]?/);
  if (m1) {
    h = parseInt(m1[1]);
    m = m1[2] ? parseInt(m1[2]) : 0;
  }

  // "上午/下午/晚上" 修饰
  if (h !== null) {
    if (/下午|晚上|傍晚/.test(text) && h < 12) h += 12;
    if (/凌晨|早上|上午/.test(text) && h === 12) h = 0;
  }

  // "X分钟后" / "X小时后"
  let m2 = text.match(/(\d+)[个]?分钟[后之]/);
  if (m2) return now.getTime() + parseInt(m2[1]) * 60000;
  let m3 = text.match(/(\d+)[个]?小时[后之]/);
  if (m3) return now.getTime() + parseInt(m3[1]) * 3600000;
  let m4 = text.match(/(\d+)[个]?秒[后之]/);
  if (m4) return now.getTime() + parseInt(m4[1]) * 1000;

  // 绝对时间
  if (h !== null && h >= 0 && h <= 23 && m >= 0 && m <= 59) {
    const target = new Date(now);
    target.setHours(h, m, 0, 0);
    if (target <= now) target.setDate(target.getDate() + 1); // 已过则明天
    return target.getTime();
  }

  return null;
}

/** 从用户消息中提取提醒意图 */
function extractReminder(text) {
  // "提醒我..." / "记得..." / "别忘..."
  const patterns = [
    /(?:提醒我|记得|别忘[了要])\s*(.{2,50})/,
    /(.{2,50})\s*(?:的)?(?:时间到了|该做了|别忘了)/,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1].trim();
  }

  // "X点/X分钟 提醒/做..."
  const timeMatch = text.match(/(?:在)?(?:下午|上午|晚上|早上|凌晨)?\s*(?:\d{1,2}[点时:：]\d{0,2}[分]?|\d+[个]?[分钟小时]+[后之])\s*(?:提醒我?|记得|叫我|帮我)?\s*(.{2,50})/);
  if (timeMatch) return timeMatch[1].trim();

  return null;
}

/** 设置提醒 */
function setReminder(text, at, sendFn) {
  const delay = at - Date.now();
  if (delay < 0 || delay > 24 * 3600000) return false;

  const timer = setTimeout(() => {
    sendFn(`⏰ 时间到了！${text}`);
    // 从列表中移除
    const idx = reminders.findIndex((r) => r.timer === timer);
    if (idx >= 0) reminders.splice(idx, 1);
  }, delay);

  reminders.push({ text, at, timer });
  return true;
}

function getReminders() {
  return reminders.map((r) => ({
    text: r.text,
    at: new Date(r.at).toLocaleString("zh-CN"),
    remaining: Math.max(0, r.at - Date.now()),
  }));
}

function cancelReminder(index) {
  if (reminders[index]) {
    clearTimeout(reminders[index].timer);
    reminders.splice(index, 1);
    return true;
  }
  return false;
}

/* ============================================================
 * 4. 情绪语音（根据情绪调整语速/音调）
 * ============================================================ */
const EMOTION_VOICE_MAP = {
  "开心": { rate: 1.15, pitch: 1.15 },
  "惊喜": { rate: 1.20, pitch: 1.20 },
  "生气": { rate: 0.85, pitch: 0.80 },
  "委屈": { rate: 0.75, pitch: 0.90 },
  "思考": { rate: 0.90, pitch: 0.95 },
  "睡觉": { rate: 0.60, pitch: 0.80 },
  "傲娇": { rate: 1.05, pitch: 1.10 },
};

function getVoiceParams(emotion) {
  return EMOTION_VOICE_MAP[emotion] || { rate: 1.0, pitch: 1.0 };
}

/* ============================================================
 * 5. 系统监控（CPU/内存 → 角色语音）
 * ============================================================ */
function getSystemStats() {
  return new Promise((resolve) => {
    exec(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Processor | Select-Object -ExpandProperty LoadPercentage; [math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1MB,1); [math]::Round((Get-CimInstance Win32_OperatingSystem).TotalVisibleMemorySize/1MB,1)"`,
      { encoding: "utf8", timeout: 5000 },
      (err, stdout) => {
        if (err) { resolve(null); return; }
        try {
          const output = stdout.trim().split("\n");
          resolve({
            cpu: parseInt(output[0]) || 0,
            ramFree: parseFloat(output[1]) || 0,
            ramTotal: parseFloat(output[2]) || 0,
            ramUsed: Math.round((1 - parseFloat(output[1]) / parseFloat(output[2])) * 100),
          });
        } catch { resolve(null); }
      }
    );
  });
}

function systemStatsToSpeech(stats) {
  if (!stats) return null;
  const { cpu, ramUsed } = stats;

  if (cpu > 85) return `博士！CPU 已经 ${cpu}% 了，是不是开了太多东西？让我帮你检查一下……`;
  if (ramUsed > 85) return `内存用到 ${ramUsed}% 了哦，博士要不要关掉一些程序？`;
  if (cpu < 15 && ramUsed < 50) return `现在电脑很轻松呢～CPU ${cpu}%，内存 ${ramUsed}%。博士也一样轻松就好了～`;
  return null;
}

/* ============================================================
 * 6. 剪贴板感知
 * ============================================================ */
const { clipboard } = require("electron");
let lastClipboard = "";
let clipboardTimer = null;

function startClipboardWatch(sendFn, intervalMs = 3000) {
  stopClipboardWatch();
  clipboardTimer = setInterval(() => {
    const text = clipboard.readText().trim();
    if (!text || text === lastClipboard || text.length < 10) return;
    lastClipboard = text;

    // 判断内容类型
    if (/^https?:\/\//.test(text)) {
      // URL
      sendFn(`📋 检测到链接：${text.slice(0, 60)}${text.length > 60 ? "…" : ""}`);
    } else if (/\d{10,}/.test(text)) {
      // 可能是电话/订单号
      sendFn(`📋 检测到长数字，需要我帮忙记一下吗？`);
    } else if (text.length > 100) {
      // 长文本
      sendFn(`📋 检测到一段长文本（${text.length}字），博士在整理资料吗？`);
    }
  }, intervalMs);
}

function stopClipboardWatch() {
  if (clipboardTimer) { clearInterval(clipboardTimer); clipboardTimer = null; }
}

/* ============================================================
 * 7. 番茄钟
 * ============================================================ */
let pomodoroTimer = null;
let pomodoroState = { phase: null, remaining: 0, count: 0 };

function startPomodoro(sendFn, workMin = 25, restMin = 5) {
  stopPomodoro();
  pomodoroState = { phase: "work", remaining: workMin * 60, count: 0 };

  pomodoroTimer = setInterval(() => {
    pomodoroState.remaining--;

    if (pomodoroState.remaining <= 0) {
      if (pomodoroState.phase === "work") {
        pomodoroState.count++;
        sendFn(`🍅 工作时间到！已经完成了 ${pomodoroState.count} 个番茄钟。休息 ${restMin} 分钟吧，博士～`);
        pomodoroState.phase = "rest";
        pomodoroState.remaining = restMin * 60;
      } else {
        sendFn(`✅ 休息结束！开始第 ${pomodoroState.count + 1} 个番茄钟吧，加油博士！`);
        pomodoroState.phase = "work";
        pomodoroState.remaining = workMin * 60;
      }
    }
  }, 1000);
}

function stopPomodoro() {
  if (pomodoroTimer) clearInterval(pomodoroTimer);
  pomodoroTimer = null;
  pomodoroState = { phase: null, remaining: 0, count: 0 };
}

function getPomodoroStatus() {
  if (!pomodoroState.phase) return null;
  const min = Math.floor(pomodoroState.remaining / 60);
  const sec = pomodoroState.remaining % 60;
  return {
    phase: pomodoroState.phase === "work" ? "工作中" : "休息中",
    remaining: `${min}:${sec.toString().padStart(2, "0")}`,
    count: pomodoroState.count,
  };
}

/* ============================================================
 * 8. 梦境模式（闲置时生成梦境故事）
 * ============================================================ */
const DREAM_PROMPTS = [
  "我做了一个梦……梦里博士带我去了一个很大的游乐园，我们坐了旋转木马……",
  "梦见我在一片花田里睡着了，醒来发现博士在旁边守着我……好安心……",
  "梦到博士变成了小狐狸，我追着跑了好久……好奇怪的梦……",
  "梦里我在给博士做体检，但是博士一直笑，我都无法集中精神了……",
  "梦见天空下着糖果雨，我接了好多给博士吃……博士说很甜……",
];

function getRandomDream() {
  return DREAM_PROMPTS[Math.floor(Math.random() * DREAM_PROMPTS.length)];
}

/* ============================================================
 * 10. 长期记忆摘要（对话历史 → LLM 压缩 → 人设记忆）
 * ============================================================ */
/** 用 LLM 把最近对话压缩成简短的"苏苏洛的记忆"摘要 */
async function generateMemorySummary(chatClient, recentLines) {
  if (!recentLines || recentLines.length < 4) return null;
  try {
    const dialogText = recentLines
      .map((l) => `${l.role === "user" ? "博士" : "苏苏洛"}: ${String(l.content || "").slice(0, 100)}`)
      .join("\n");
    const r = await chatClient.chat({
      persona: "你是一个记忆整理器。把下面的对话浓缩成 2~3 句第三人称描述，格式如「博士提到了…；苏苏洛回应了…」。只输出摘要本身。",
      history: [],
      text: dialogText.slice(0, 2000),
      onChunk: () => {},
    });
    const summary = String(r.text || "").trim();
    return summary && summary.length > 5 && summary.length < 500 ? summary : null;
  } catch { return null; }
}

/* ============================================================
 * 导出
 * ============================================================ */
module.exports = {
  // 语音输入
  speechToText,

  // 主动搭话
  touchChat,
  startProactive,
  stopProactive,

  // 日程提醒
  parseTime,
  extractReminder,
  setReminder,
  getReminders,
  cancelReminder,

  // 情绪语音
  getVoiceParams,

  // 系统监控
  getSystemStats,
  systemStatsToSpeech,

  // 剪贴板
  startClipboardWatch,
  stopClipboardWatch,

  // 番茄钟
  startPomodoro,
  stopPomodoro,
  getPomodoroStatus,

  // 梦境
  getRandomDream,

  // 记忆摘要
  generateMemorySummary,
};
