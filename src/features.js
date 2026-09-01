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
  // 自动探测 GSV runtime Python（优先随包 engines/gsv，其次常见安装位置）
  const gsvCandidates = [
    path.join(path.dirname(process.execPath || ""), "engines", "gsv", "runtime", "python.exe"),
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
 * 2. 主动搭话（闲置后主动开口，v2.3 增强：时段台词 + 设置开关）
 * ============================================================ */
let proactiveTimer = null;
let lastChatTs = Date.now();
let proactiveEnabled = true; // 设置页「主动搭话」开关（pet:set-proactive-chat）
let proactiveCfg = { sendFn: null, intervalMin: 8 };
let lastMilestoneSaid = 0; // 陪伴里程碑已说过的天数（v2.5.25 去重：每个里程碑值只开口一次，避免停在里程碑日反复刷屏）

function touchChat() {
  lastChatTs = Date.now();
}

/** 开关（设置页切换）：关闭即停表，开启按上次参数重开 */
function setProactiveEnabled(on) {
  proactiveEnabled = !!on;
  if (on) {
    if (proactiveCfg.sendFn) startProactive(proactiveCfg.sendFn, proactiveCfg.intervalMin, proactiveCfg.stateFn);
  } else {
    stopProactive();
  }
}

function startProactive(sendFn, intervalMin = 8, stateFn = null) {
  proactiveCfg = { sendFn, intervalMin, stateFn };
  stopProactive();
  const intervalMs = intervalMin * 60 * 1000;
  proactiveTimer = setInterval(() => {
    if (!proactiveEnabled || !proactiveCfg.sendFn) return;
    const idle = Date.now() - lastChatTs;
    if (idle < intervalMs) return;
    // 35% 概率触发（避免太频繁）
    if (Math.random() > 0.35) return;
    const lines = require("./lines");
    let prompt;
    // v2.6 由头化扩展：记忆里有称谓/生日/健康/近期安排事实时，主动开口有"由头"（而非纯随机）
    try {
      const mem = require("./memory");
      const facts = mem.getFactsList() || [];
      if (facts.length) {
        // ① 生日：今天正好是 → 一定开口（优先级最高）
        const now = new Date();
        const bd = facts.find((f) => f.type === "birthday" && (f.text.match(/(\d{1,2})月(\d{1,2})日/) || []).slice(1).join("|") === (now.getMonth() + 1) + "|" + now.getDate());
        if (bd) {
          prompt = "（咦，今天好像是博士的生日？）生日快乐呀博士！要好好犒劳一下自己哦～";
        } else if (mem.hasHealthFact() && Math.random() < 0.3) {
          prompt = "（想起你之前说不太舒服）……博士，身体还好吗？别忘了多喝热水，不舒服要跟我说。";
        } else {
          // ② 近期安排：考试/面试/答辩/加班… → 助威系
          const ev = facts.filter((f) => f.type === "event").pop();
          if (ev && Math.random() < 0.25) {
            const what = (ev.text.match(/「(.+?)」/) || [])[1] || "那件重要的事";
            prompt = "（记得你最近有" + what + "的安排）博士加油呀～我会在旁边给你打气的！";
          } else {
            // ③ 称谓：博士希望被这样称呼时偶尔用
            const nm = facts.find((f) => f.type === "name");
            const name = nm && (nm.text.match(/「(.+?)」/) || [])[1];
            if (name && Math.random() < 0.2) {
              prompt = "（今天也记得要这样叫博士）" + name + "～有没有按时喝水呀？";
            }
          }
        }
      }
    } catch { /* 记忆不可用则走常规台词 */ }
    // B-3 由头第二信号源：番茄钟快结束 / 日程临近（轻量运行信号；无信号返回 null 不打扰）
    if (!prompt) {
      try {
        const { signalTopic } = require("./proactive-topic");
        const st = signalTopic({
          pomodoro: getPomodoroStatus(),
          reminders: getReminders().map((r) => ({ text: r.text, remaining: r.remaining })),
        });
        if (st) prompt = st.text;
      } catch { /* 信号不可用则走常规台词 */ }
    }
    if (!prompt) {
      const cfg = config.getConfig();
      const vars = { name: (cfg.pet && cfg.pet.name) || "苏苏洛", user: (cfg.chat && cfg.chat.userName) || "博士" };
      const h = new Date().getHours();
      // 清晨专属（5-8 点）
      if (h >= 5 && h < 8 && Math.random() < 0.25) prompt = lines.pickTpl(lines.EARLY_MORNING_LINES, vars);
      // 关系阶段台词（熟悉起 18% 概率）
      if (!prompt) {
        try {
          const st = require("./bond").getStage();
          if ((st.key === "fd" || st.key === "xl" || st.key === "sy") && Math.random() < 0.18) {
            prompt = lines.pickTpl(lines.STAGE_LINES[st.key] || [], vars);
          }
        } catch { /* 羁绊不可用则跳过 */ }
      }
      // 里程碑由头：陪伴 7/30/100/整百 天（v2.5.25 去重：每个里程碑值只开口一次——
      // days 停在里程碑日时会反复触发 20% 概率，改为首次到达该值才说）
      if (!prompt) {
        try {
          const days = require("./bond").getDays();
          const isMilestone = days === 7 || days === 30 || days === 100 || (days > 0 && days % 100 === 0);
          if (isMilestone && days > lastMilestoneSaid && Math.random() < 0.2) {
            lastMilestoneSaid = days;
            prompt = "已经陪博士 " + days + " 天了……感觉像家人一样了呢";
          }
        } catch { /* 忽略 */ }
      }
      // 状态分流（v2.5.25）：散步/坐着时优先说贴合当下处境的话（用户反馈想多点坐/闲逛的句子）
      if (!prompt) {
        try {
          const st = (proactiveCfg.stateFn && proactiveCfg.stateFn()) || "";
          if (st === "walking" || st === "seated") {
            const pool = lines.PROACTIVE_BY_STATE[st];
            if (pool && pool.length) prompt = lines.pickTpl(pool, vars);
          }
        } catch { /* 状态不可用则走时段台词 */ }
      }
      if (!prompt) {
        if (idle > 45 * 60 * 1000 && Math.random() < 0.4) {
          prompt = lines.pickTpl(lines.LONG_IDLE_LINES, vars); // 超长闲置：想念系
        } else {
          prompt = lines.pickTpl(lines.PROACTIVE_BY_PERIOD[lines.periodOf()] || lines.PROACTIVE_BY_PERIOD.afternoon, vars);
        }
      }
    }
    if (!prompt) return;
    lastChatTs = Date.now();
    proactiveCfg.sendFn(prompt);
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

let sysMonitorTimer = null;
let lastSysStatsAt = 0;
const SYS_STATS_MIN_GAP = 30 * 1000; // 两次播报至少间隔 30s（避免 CPU 持续高占用时连续唠叨）

/** 系统监控播报（v2.5.15 补：此前 main.js 调用但本函数缺失 → 勾选后下次启动抛 TypeError 中断初始化）
 *  定时轮询 CPU/内存，经 systemStatsToSpeech 转台词，仅在有值得说的情况时 sendFn。
 *  签名对齐 main.js 调用：startSystemMonitor(getStatsFn, sendFn, intervalSec) */
function startSystemMonitor(getStatsFn, sendFn, intervalSec = 15) {
  stopSystemMonitor();
  const statsFn = (typeof getStatsFn === "function") ? getStatsFn : () => getSystemStats();
  sysMonitorTimer = setInterval(async () => {
    let stats;
    try { stats = await statsFn(); } catch { return; }
    const msg = systemStatsToSpeech(stats);
    if (!msg) return;
    const now = Date.now();
    if (now - lastSysStatsAt < SYS_STATS_MIN_GAP) return;
    lastSysStatsAt = now;
    try { sendFn(msg); } catch { /* 渲染层不可用时忽略 */ }
  }, Math.max(5, Number(intervalSec) || 15) * 1000);
}

function stopSystemMonitor() {
  if (sysMonitorTimer) { clearInterval(sysMonitorTimer); sysMonitorTimer = null; }
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
    let text;
    try {
      text = clipboard.readText().trim();
    } catch { return; } // 剪贴板被占用/锁定：跳过本轮，不中断监视
    if (!text || text === lastClipboard || text.length < 10) return;
    lastClipboard = text;

    // 判断内容类型：URL（含无协议头）→ 长数字（整段数字）→ 长文本
    if (/^(https?:\/\/)?([\w-]+\.)+[a-z]{2,}(\/\S*)?$/i.test(text)) {
      // URL（http/https 或裸域名）
      sendFn(`📋 检测到链接：${text.slice(0, 60)}${text.length > 60 ? "…" : ""}`);
    } else if (/^\d{10,}$/.test(text)) {
      // 整段是长数字（电话/订单号），而非长文本中夹带数字
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
 * 8. 日语翻译预热（v2.5.20）：固定台词提前翻译进磁盘缓存
 * 台词池里不含人称占位符（{{user}}/{{name}}）的句子是固定的，
 * 提前翻译后即使翻译 API 挂了也能查缓存说出日语（"说不出来"根治）。
 * 空闲批次执行（每次 3 句 + 间隔），不阻塞主流程；翻译成功自动落盘
 * （复用 translate-cache），下次任何时刻直接命中。
 * ============================================================ */
let jaPrewarmTimer = null;
let jaPrewarmIdx = 0;
function jaPrewarmableLines() {
  try {
    const lines = require("./lines");
    const pools = [
      lines.PAT_LINES,
      lines.PERSONIFY_LINES.thrown, lines.PERSONIFY_LINES.grabbed,
      lines.PERSONIFY_LINES.wake, lines.PERSONIFY_LINES.sleepDay,
      lines.PERSONIFY_LINES.sleepNight, lines.PERSONIFY_LINES.perch,
      lines.WORKFLOW_LINES,
      ...Object.values(lines.PROACTIVE_BY_PERIOD),
      lines.LONG_IDLE_LINES,
      ...Object.values(lines.STAGE_LINES),
      lines.EARLY_MORNING_LINES,
    ];
    // 去重 + 只留不含人称占位符的固定句
    const seen = new Set();
    const out = [];
    for (const pool of pools) {
      for (const s of pool) {
        if (s.includes("{{") || seen.has(s)) continue;
        seen.add(s);
        out.push(s);
      }
    }
    return out;
  } catch { return []; }
}

/** 启动日语翻译预热（仅在 speakJa 开启且有 key 时生效；幂等，可重复调用） */
function startJaPrewarm() {
  stopJaPrewarm();
  const cfg = config.getConfig();
  if (!(cfg.ttsGenie || {}).speakJa) return; // 非日语模式不预热
  if (!(cfg.chat || {}).apiKey) return;      // 无 key 无法翻译
  const list = jaPrewarmableLines();
  if (!list.length) return;
  jaPrewarmIdx = 0;
  logJaPrewarm(`日语翻译预热启动（${list.length} 句固定台词，空闲批次翻译）`);
  const BATCH = 3, GAP = 15000; // 每批 3 句，间隔 15 秒（v2.5.20 调快：165 句约 15 分钟跑完；避免限流）
  jaPrewarmTimer = setInterval(async () => {
    if (jaPrewarmIdx >= list.length) { stopJaPrewarm(); return; }
    const batch = list.slice(jaPrewarmIdx, jaPrewarmIdx + BATCH);
    jaPrewarmIdx += BATCH;
    try {
      const { translateToJa } = require("./ja-translate");
      for (const s of batch) {
        const ja = await translateToJa(s);
        if (ja) logJaPrewarm(`预热✓: ${s.slice(0, 18)} → ${ja.slice(0, 18)}`);
      }
    } catch { /* 单批失败下轮重试 */ }
  }, GAP);
}

function stopJaPrewarm() {
  if (jaPrewarmTimer) { clearInterval(jaPrewarmTimer); jaPrewarmTimer = null; }
}

function logJaPrewarm(msg) {
  try { require("./logger").logTts("ja", msg); } catch { /* 日志失败忽略 */ }
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
  setProactiveEnabled,

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
  startSystemMonitor,
  stopSystemMonitor,

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

  // 日语翻译预热（v2.5.20）
  startJaPrewarm,
  stopJaPrewarm,
  jaPrewarmableLines,
};
