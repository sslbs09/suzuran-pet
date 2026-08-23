/**
 * SuzuranPet 渲染层逻辑（GIF 表情版）
 * - 心情 → GIF 映射（user/ 目录，可换肤）
 * - 拖拽（手动指针拖拽 + IPC 移动窗口，区分点击）
 * - 气泡打字机、思考动画、输入栏、停止
 * - 闲置 5 分钟自动睡觉，互动唤醒
 */
"use strict";

const petEl = document.getElementById("pet");
const spriteEl = document.getElementById("sprite");
const bubbleEl = document.getElementById("bubble");
const bubbleText = document.getElementById("bubble-text");
const thinkingDots = document.getElementById("thinking-dots");
const inputBar = document.getElementById("input-bar");
const inputEl = document.getElementById("input");
const btnSend = document.getElementById("btn-send");
const btnStop = document.getElementById("btn-stop");
const modeChip = document.getElementById("mode-chip");

/* ---------- 情绪 → GIF 映射（动态：来自 config moods，可自定义增删） ---------- */
let MOODS = []; // [{name,label,emotion,custom,exists}]

const SPRITE_BASE = "sprites/user/";

/* ---------- Spine 渲染系统（可切换 GIF/Spine；支持桌面行走） ---------- */
let spineApp = null;         // PixiJS Application
let spineObj = null;         // PIXI Spine 对象
let renderMode = "gif";      // "gif" | "spine"
const SPINE_BASE = "spine/sussurro/";
let spinePaths = {           // 默认内置模型；spine/user/ 有用户模型时由主进程探测替换（懒人换模型）
  atlas: SPINE_BASE + "build_char_298_susuro.atlas",
  skel: SPINE_BASE + "build_char_298_susuro.skel"
};
let spineBaseScaleX = 1;     // 初始缩放；朝向翻转时取反
// 桌面行走状态（主进程广播驱动；明日方舟基建语义：Move=走动 Relax=放松 Sit=坐窗顶 Sleep=睡觉 Interact=点击互动）
let walkState = { active: false, resting: true, perched: false, seated: false, face: 1 };

function spineHas(name) { return !!spineObj && !!spineObj.spineData.animations.find((a) => a.name === name); }

/** 播放新动画后测量姿势包围盒并自适应（坐姿/睡姿超出画布任意一边都会被裁掉） */
let spineFitTimers = [];
function scheduleFitSpine() {
  spineFitTimers.forEach(clearTimeout);
  spineFitTimers = [150, 500, 1000].map((ms) => setTimeout(fitSpinePose, ms)); // 动画过渡期多次校准
}
function fitSpinePose() {
  try {
    if (!spineObj || !spineApp || renderMode !== "spine") return;
    const W = spineApp.screen.width, H = spineApp.screen.height;
    spineObj.updateTransform();
    let b = spineObj.getBounds();
    if (!(b.width > 0) || !(b.height > 0)) return;
    let mag = Math.abs(spineBaseScaleX);
    // 宽或高任一超出画布（如躺姿变宽、坐姿变矮高）→ 整体微缩到完全放得下
    const k = Math.min(1, (W - 6) / b.width, (H - 6) / b.height);
    if (k < 1) mag *= k;
    spineObj.scale.set(mag * (walkState.face === -1 ? -1 : 1), mag);
    spineObj.updateTransform();
    b = spineObj.getBounds();
    // 底边贴地、水平居中：保证耳朵/手脚不被四边裁剪
    spineObj.x += (W - b.width) / 2 - b.x;
    spineObj.y += H - (b.y + b.height);
  } catch { /* 测量失败不影响渲染 */ }
  reportGroundGap();
}

/** 上报角色脚底到窗口底边的空隙（宠物元素悬浮在输入栏上方导致），
 *  主进程贴地吸附时用它把窗口下探相应距离，让脚真正踩在任务栏/图标上 */
function reportGroundGap() {
  try {
    const r = petEl.getBoundingClientRect();
    const gap = Math.max(0, Math.min(80, Math.round(window.innerHeight - r.bottom)));
    window.petAPI.setGroundGap(gap);
    window.petAPI.setCharInset && window.petAPI.setCharInset(Math.max(0, Math.round(r.left))); // 同一测量顺便上报：行走左边界补偿用
  } catch { /* 忽略 */ }
}

/** 行走朝向：face=-1 时镜像翻转（假设模型原始朝右；若实际相反改此处符号即可） */
function spineFaceDir(face) {
  if (!spineObj) return;
  const sx = Math.abs(spineBaseScaleX) * (face === -1 ? -1 : 1);
  if (spineObj.scale.x !== sx) spineObj.scale.x = sx;
}

/** 当前应播放的移动相位动画：窗顶→Sit，地面放松→待机（Relax），走动→Move */
function spinePhaseAnim() {
  if (!walkState.active) return null;
  if (walkState.perched && spineHas("Sit")) return "Sit";
  if (walkState.paused) return spineAnimForMood("idle"); // 暂停中（单击互动/拖拽）：站立待机，不挂走路动画
  if (!walkState.resting && spineHas("Move")) return "Move";
  return spineAnimForMood("idle");
}

// 情绪 → Spine 动画名映射（Spine 模型中的动画名可能不同于 GIF 名）
function spineAnimForMood(mood) {
  // 尝试精确匹配
  if (spineObj && spineObj.spineData.animations.find(a => a.name === mood)) return mood;
  // 常见映射（明日方舟基建模型只有 Relax/Move/Interact，情绪统一回退 Relax）
  const map = {
    idle: ["Relax", "Idle", "idle", "animation", "stand"],
    happy: ["happy", "Happy", "Relax"],
    think: ["think", "Think", "Sit", "Relax"],
    sleep: ["Sleep", "sleep", "Sit", "Relax"],
    wave: ["wave", "Wave", "Interact"],
    angry: ["angry", "Angry", "Relax"],
    surprised: ["surprise", "Surprised", "Interact"],
  };
  const candidates = map[mood] || [mood];
  for (const c of candidates) {
    if (spineObj && spineObj.spineData.animations.find(a => a.name === c)) return c;
  }
  // 回退到第一个可用动画
  if (spineObj && spineObj.spineData.animations.length > 0) {
    return spineObj.spineData.animations[0].name;
  }
  return null;
}

async function initSpine() {
  try {
    if (spineApp) return true; // 已初始化

    // 懒人换肤：主进程扫描 spine/user/ 下所有皮肤，返回当前选中的那套
    try {
      const res = await window.petAPI.getSpineModels();
      if (res && Array.isArray(res.list) && res.list.length) {
        const cur = res.list.find((m) => m.id === (res.current || "builtin")) || res.list[0];
        spinePaths = { atlas: cur.atlas, skel: cur.skel };
        if (cur.id !== "builtin") console.log("[Spine] 使用自定义皮肤:", cur.atlas);
      }
    } catch { /* 探测失败用内置 */ }

    // 创建 PixiJS 应用
    const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2)); // 高DPI 屏按物理像素渲染，避免整体发糊
    spineApp = new PIXI.Application({
      width: petEl.clientWidth || 260,
      height: petEl.clientHeight || 200,
      backgroundAlpha: 0, // 透明背景
      autoStart: true,
      antialias: true,
      resolution: dpr,
      autoDensity: true // 画布物理分辨率提升但 CSS 尺寸保持不变
    });
    spineApp.view.id = "spine-canvas";
    spineApp.view.classList.add("spine-canvas");

    // 替换 GIF img 为 Spine canvas
    spriteEl.style.display = "none";
    petEl.insertBefore(spineApp.view, spriteEl);

    // 加载 Spine 资源（先图集后骨架；.skel 二进制与 .json 均由 pixi-spine 解析器处理）
    const atlasRes = await PIXI.Assets.load(spinePaths.atlas, (p) => {
      console.log("Spine 图集加载:", Math.round((p || 0) * 100) + "%");
    });
    // 模型会被明显缩小显示：开启 mipmap 减少缩小发虚
    try {
      for (const page of (atlasRes && atlasRes.pages) || []) {
        if (page && page.baseTexture) {
          page.baseTexture.autoGenerateMipmaps = true;
          page.baseTexture.mipmap = PIXI.MIPMAP_MODES?.ON ?? 1;
          page.baseTexture.update();
        }
      }
    } catch { /* mipmap 失败不影响渲染 */ }
    const skelRes = await PIXI.Assets.load(spinePaths.skel, (p) => {
      console.log("Spine 骨架加载:", Math.round((p || 0) * 100) + "%");
    });
    // pixi-spine v4：类挂在 PIXI.spine 命名空间；解析结果含 spineData
    const SpineCtor = (PIXI.spine && PIXI.spine.Spine) || PIXI.Spine;
    const spineData = skelRes && skelRes.spineData ? skelRes.spineData : skelRes;
    spineObj = new SpineCtor(spineData);
    spineApp.stage.addChild(spineObj);

    // 居中并缩放到合适大小
    spineObj.x = spineApp.screen.width / 2;
    spineObj.y = spineApp.screen.height;
    const scale = Math.min(
      spineApp.screen.width / (spineObj.width || 300),
      spineApp.screen.height / (spineObj.height || 400)
    ) * 0.9;
    // 部分模型图集包围盒偏大（含空白/特效区），自适应后显得偏小：按目录名加缩放修正
    const boostTable = { "4179_monstr": 1.7, "391_rosmon_sale_16": 1.5 };
    let boost = 1;
    try {
      const segs = decodeURIComponent((spinePaths.skel || "")).split("/");
      const dirName = segs.find((p) => /^\d{3,4}_/.test(p)) || ""; // 定位 spine/user/<目录>/... 中的目录段
      boost = boostTable[dirName] || 1;
    } catch { boost = 1; }
    spineBaseScaleX = scale * boost;
    spineObj.scale.set(scale * boost);

    // 播放默认动画
    const animName = spineAnimForMood("idle");
    if (animName) {
      spineObj.state.setAnimation(0, animName, true);
      scheduleFitSpine();
    }

    console.log("[Spine] 初始化完成, 可用动画:",
      spineObj.spineData.animations.map(a => a.name));
    return true;
  } catch (e) {
    console.error("[Spine] 初始化失败:", e);
    // TODO 诊断埋点（临时）：把真实加载错误写进 tts.log，定位后移除
    try {
      window.petAPI.playback && window.petAPI.playback(
        "[spine] 初始化失败: " + (e && e.message || e) +
        " | atlas=" + (spinePaths && spinePaths.atlas || "?") +
        " skel=" + (spinePaths && spinePaths.skel || "?")
      );
    } catch { /* 忽略 */ }
    // 失败则回退到 GIF 模式
    renderMode = "gif";
    if (spineApp && spineApp.view.parentNode) {
      spineApp.view.style.display = "none";
    }
    spriteEl.style.display = "";
    return false;
  }
}

/** 在 Spine/GIF 模式间切换 */
async function setRenderMode(mode) {
  if (mode === renderMode) return;
  renderMode = mode;

  if (mode === "spine") {
    const ok = await initSpine();
    if (ok) {
      spriteEl.style.display = "none";
      if (spineApp && spineApp.view) spineApp.view.style.display = "";
    } else {
      renderMode = "gif"; // Spine 初始化失败回退 GIF
    }
  } else {
    // 切回 GIF
    spriteEl.style.display = "";
    if (spineApp && spineApp.view) spineApp.view.style.display = "none";
  }
}

/** 主进程广播行走状态：切 Move/Relax/Sit 动画并同步朝向 */
let animDemoUntil = 0; // 动作试演期间不被行走相位打断
function applyWalkState(s) {
  const wasActive = walkState.active;
  walkState = s || walkState;
  if (!spineObj || renderMode !== "spine") return;
  if (isSleeping) return;                 // 睡觉中：不被行走动画打断
  spineFaceDir(walkState.face);
  if (Date.now() < animDemoUntil) return; // 演示中，不打断
  // 坐下（任务栏上沿/桌面图标顶/窗顶）：Sit 循环，优先级高于行走相位
  if (walkState.seated || walkState.perched) {
    const sit = ["Sit", "sit"].find((n) => spineHas(n));
    const target = sit || spinePhaseAnim();
    if (target && spineObj.state.getCurrent(0)?.animation?.name !== target) {
      spineObj.state.setAnimation(0, target, true);
      scheduleFitSpine();
    }
    return;
  }
  if (!walkState.active) {
    // 行走刚停止 → 恢复正常待机动画（否则会一直保持最后姿势）
    if (wasActive && !busy) {
      const idle = spineAnimForMood("idle");
      if (idle && spineObj.state.getCurrent(0)?.animation?.name !== idle) {
        spineObj.state.setAnimation(0, idle, true);
        scheduleFitSpine();
      }
    }
    return;
  }
  if (busy) return;                       // 聊天表情优先，不打断
  const target = spinePhaseAnim();
  if (target && spineObj.state.getCurrent(0)?.animation?.name !== target) {
    spineObj.state.setAnimation(0, target, true);
    scheduleFitSpine();
  }
}

/** 单击互动：播一次 Interact 后接回当前相位动画（还原游戏内点击基建干员的反应） */
function playSpineInteract() {
  if (!spineObj || renderMode !== "spine" || busy) return;
  const inter = ["Interact", "interact"].find((n) => spineHas(n));
  if (!inter) return;
  const next = spinePhaseAnim();
  if (!next) return;
  spineObj.state.clearTrack(0);
  spineObj.state.setAnimation(0, inter, false);
  spineObj.state.addAnimation(0, next, true, 0);
  scheduleFitSpine();
}

/** 在 Spine 模式下播放对应情绪的动画 */
function setSpineMood(mood) {
  if (!spineObj || renderMode !== "spine") return;
  if (Date.now() < animDemoUntil) return; // 动作试演中，不被情绪切换打断
  // 坐下状态：待机回落/轮换保持坐姿，不被顶回站姿（聊天情绪仍可短暂覆盖）
  if (walkState.seated && (mood === "idle" || mood === undefined)) {
    const sit = ["Sit", "sit"].find((n) => spineHas(n));
    if (sit && spineObj.state.getCurrent(0)?.animation?.name !== sit) {
      spineObj.state.setAnimation(0, sit, true);
      scheduleFitSpine();
    }
    return;
  }
  // 行走相位中回落待机 → 保持走路动画不中断（非 idle 情绪照常显示）
  if (walkState.active && !walkState.resting && !busy && mood === "idle" && spineHas("Move")) {
    spineFaceDir(walkState.face);
    if (spineObj.state.getCurrent(0)?.animation?.name !== "Move") {
      spineObj.state.setAnimation(0, "Move", true);
      scheduleFitSpine();
    }
    return;
  }
  const animName = spineAnimForMood(mood === "idle" ? "idle" : mood);
  if (animName && spineObj.state.getCurrent(0)?.animation?.name !== animName) {
    spineObj.state.setAnimation(0, animName, true);
    scheduleFitSpine();
  }
}

function moodNames() { return MOODS.map((m) => m.name); }
function labelToName(label) {
  const m = MOODS.find((x) => x.label === label);
  return m ? m.name : "";
}
function idleNames() { return MOODS.filter((m) => !m.emotion).map((m) => m.name); }

let busy = false;
let currentMode = "chat";
let forcedMode = "auto";
let zcodeEnabled = false; // 任务模式是否可用（默认关闭）
let agreed = true;        // 是否已同意使用条款
let replyBuffer = "";
let revealTimer = null;
let typing = false;
let lastMood = "idle";
let moodTimer = null;      // 心情自动回落定时器
let sleepTimer = null;     // 闲置睡觉定时器
let awake = true;
let isSleeping = false;    // 睡觉状态（同步给行走引擎暂停移动）
let idleIdx = 0;

function setMood(mood) {
  // mood = 内部状态名（happy/think/sleep/…或自定义情绪名）；"idle"/未知 → 从待机池轮换
  const names = moodNames();
  const idles = idleNames();
  let pool;
  if (mood === "idle" || !names.includes(mood)) pool = idles;
  else pool = [mood];
  if (!pool.length) return;
  const file = pool.length > 1 ? pool[++idleIdx % pool.length] : pool[0];
  lastMood = mood;

  // 睡觉/醒来同步行走引擎（睡着后不再移动）
  if (mood === "sleep" && !isSleeping) { isSleeping = true; window.petAPI.setSleeping(true); }
  else if (mood !== "sleep" && isSleeping) { isSleeping = false; window.petAPI.setSleeping(false); }

  // Spine 模式：切换 Spine 动画而非 GIF
  if (renderMode === "spine") { setSpineMood(mood); petEl.dataset.mood = mood; return; }

  // GIF 模式
  if (spriteEl.src.endsWith(file + ".gif")) return;
  spriteEl.src = SPRITE_BASE + encodeURI(file) + ".gif?t=" + Date.now();
  petEl.dataset.mood = mood;
  if (mood === "sleep") awake = false;
  scheduleMoodReset(mood);
}

/** 心情在指定时间后回落到 idle；持续心情（sleep/work 等）不自动回落 */
function scheduleMoodReset(mood) {
  if (moodTimer) clearTimeout(moodTimer);
  moodTimer = setTimeout(() => {
    if (!busy && mood !== "sleep" && mood !== "work") setMood("idle");
  }, 3000);
}

function wake() {
  if (!awake) {
    awake = true;
    if (!busy) setMood("surprised"); // 被叫醒
  }
  resetSleepTimer();
}
function resetSleepTimer() {
  if (sleepTimer) clearTimeout(sleepTimer);
  sleepTimer = setTimeout(() => { if (!busy) setMood("sleep"); }, 5 * 60 * 1000);
}

/* ---------- 气泡 ---------- */
function showBubble() {
  bubbleEl.classList.remove("hidden");
  bubbleEl.classList.remove("error", "task");
}
function setBubbleMode(mode) {
  bubbleEl.classList.toggle("task", mode === "zcode");
}
function hideBubble() {
  bubbleEl.classList.add("hidden");
  stopReveal();
}
function stopReveal() {
  if (revealTimer) { clearInterval(revealTimer); revealTimer = null; }
  typing = false;
}

function startReveal(full, offset) {
  stopReveal();
  typing = true;
  revealTimer = setInterval(() => {
    offset = Math.min(full.length, offset + 3);
    bubbleText.textContent = full.slice(0, offset);
    if (offset >= full.length) stopReveal();
  }, 14);
}

function showThinking() {
  showBubble();
  bubbleText.textContent = "";
  thinkingDots.classList.remove("hidden");
  setMood("think");
}
function hideThinking() {
  thinkingDots.classList.add("hidden");
}

/* ---------- 发送 / 流式回传 ---------- */
async function send() {
  const text = inputEl.value.trim();
  if (!text || busy) return;
  if (!agreed) {
    toast(I18N.t("pet.termsToast"));
    return;
  }
  inputEl.value = "";
  replyBuffer = "";
  wake();
  // 问候语 → 挥手
  if (/^(早安|早上好|下午好|晚上好|你好|嗨|hi|hello|哈喽)/i.test(text)) {
    setMood("wave");
  } else {
    setMood("happy");
  }
  showBubble();
  hideThinking();
  bubbleText.textContent = "…";
  showThinking();
  try {
    await window.petAPI.ask(text);
  } catch (e) {
    showError(String(e));
  }
}

function showError(msg) {
  hideThinking();
  setMood("cry");
  showBubble();
  bubbleEl.classList.add("error");
  bubbleText.textContent = "苏苏洛委屈地撇撇嘴：" + msg;
  busy = false;
  updateControls();
  setTimeout(() => { bubbleEl.classList.remove("error"); }, 6000);
}

function toast(msg) {
  showBubble();
  hideThinking();
  bubbleText.textContent = msg;
  setTimeout(() => hideBubble(), 2600);
}

/* ---------- TTS 语音 ---------- */
let ttsConfig = { enabled: true, voice: "", rate: 0.95, pitch: 1.1 };
let zhVoice = null;
let ttsCloudOn = true; // 云端语音开关（来自 config，失败自动回退系统语音）

function initTts() {
  const pick = () => {
    const voices = speechSynthesis.getVoices();
    if (!voices.length) return;
    zhVoice =
      (ttsConfig.voice && voices.find((v) => v.name.toLowerCase().includes(ttsConfig.voice.toLowerCase()))) ||
      voices.find((v) => /xiaoxiao|huihui|yaoyao|kangkang|xiaoyi|yunxi|yunyang/i.test(v.name)) ||
      voices.find((v) => v.lang && v.lang.toLowerCase().startsWith("zh")) ||
      voices[0];
  };
  pick();
  speechSynthesis.onvoiceschanged = pick;
}

/** 朗读前清洗：去 emoji / 舞台动作括号 / 记号 */
function stripForSpeech(text) {
  return String(text || "")
    .replace(/（[^）]*）/g, "")            // 去（舞台动作）
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, "") // 去 emoji
    .replace(/[*_`#>【】"'""]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function speakSystem(clean, rateOverride, pitchOverride) {
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(clean);
    if (zhVoice) u.voice = zhVoice;
    u.lang = (zhVoice && zhVoice.lang) || "zh-CN";
    u.rate = rateOverride || ttsConfig.rate || 0.95;
    u.pitch = pitchOverride || ttsConfig.pitch || 1.1;
    u.volume = 1;
    speechSynthesis.speak(u);
  } catch (e) {
    console.error("系统语音失败:", e);
  }
}

// 气泡隐藏控制：等待语音播放完毕后再隐藏
let isSpeakingAudio = false;
let bubbleHideTimer = null;
// 防重复保险
let lastSpoken = { text: "", ts: 0 };

// 情绪 → 语音参数映射
const EMOTION_VOICE = {
  "开心": { rate: 1.12, pitch: 1.12 },
  "惊喜": { rate: 1.18, pitch: 1.18 },
  "生气": { rate: 0.88, pitch: 0.82 },
  "委屈": { rate: 0.78, pitch: 0.92 },
  "思考": { rate: 0.92, pitch: 0.96 },
  "睡觉": { rate: 0.62, pitch: 0.80 },
  "傲娇": { rate: 1.06, pitch: 1.08 },
};

function scheduleBubbleHide(delayMs = 5000) {
  if (bubbleHideTimer) clearTimeout(bubbleHideTimer);
  const check = () => {
    if (isSpeakingAudio) {
      // 还在说话，1秒后再检查
      setTimeout(() => { if (!busy) hideBubble(); }, 1000);
    } else {
      hideBubble();
    }
  };
  bubbleHideTimer = setTimeout(check, delayMs);
}

let cloneAudio = null; // 当前正在播放的克隆音频（新语音打断旧语音，消除叠播）

async function speak(text, emotion) {
  if (!ttsConfig.enabled) return;
  const clean = stripForSpeech(text);
  if (!clean) return;
  const now = Date.now();
  if (clean === lastSpoken.text && now - lastSpoken.ts < 10000) {
    window.petAPI.playback("重复文本已跳过: " + clean.slice(0, 30));
    return;
  }
  lastSpoken = { text: clean, ts: now };

  // 情绪语音参数
  const ev = EMOTION_VOICE[emotion] || {};
  const speakRate = (ttsConfig.rate || 0.9) * (ev.rate || 1.0);
  const speakPitch = (ttsConfig.pitch || 1.1) * (ev.pitch || 1.0);

  // 优先云端语音（百炼克隆 / edge-tts）
  if (ttsCloudOn) {
    try {
      const b64 = await window.petAPI.speakClone(clean);
      if (b64) {
        // MIME 按实际格式给（GSV/Genie 返回 WAV，cosy 返回 MP3）；错标会导致部分环境解码异常
        const isWav = b64.slice(0, 8) === "UklGRg=="; // "RIFF" 的 base64 前缀
        const audio = new Audio("data:" + (isWav ? "audio/wav" : "audio/mpeg") + ";base64," + b64);
        audio.volume = 1;
        // 克隆音色本身语速自然：变速比限制在 ±10% 且关闭时间拉伸，
        // 避免 Chromium preservesPitch 在大偏差下产生金属感/气泡音伪影（杂音来源）
        const rate = Math.max(0.9, Math.min(1.1, speakRate));
        audio.playbackRate = rate;
        if (cloneAudio && cloneAudio !== audio) { try { cloneAudio.pause(); } catch { /* 忽略 */ } } // 新语音打断上一段，消除叠播
        cloneAudio = audio;
        isSpeakingAudio = true;
        audio.onended = () => { isSpeakingAudio = false; if (cloneAudio === audio) cloneAudio = null; };
        await audio.play();
        // 等待音频播放完毕
        await new Promise((resolve) => {
          audio.onended = () => { isSpeakingAudio = false; if (cloneAudio === audio) cloneAudio = null; resolve(); };
        });
        isSpeakingAudio = false;
        window.petAPI.playback("云端音频播放成功 len=" + b64.length);
        return;
      }
      window.petAPI.playback("speakClone 返回空");
    } catch (e) {
      console.error("云端语音播放失败:", e);
      window.petAPI.playback("播放失败: " + (e && e.message || e));
    }
    // 失败 → 回退系统语音
  }
  window.petAPI.playback("回退系统语音");
  speakSystem(clean, speakRate, speakPitch);
}

/* ---------- 对话框：放大/还原 + 尺寸记忆 ---------- */
const zoomBtn = document.getElementById("btn-zoom");
const btnClose = document.getElementById("btn-close");
if (btnClose) btnClose.addEventListener("click", () => {
  hideBubble(); // 仅收起气泡画面；正在播放的语音不受影响，会继续播完
});
let winSize = { width: 170, height: 260 };
let enlarged = false;

function clampBubbleToWindow() {
  const maxW = Math.max(60, document.documentElement.clientWidth - 10);
  const maxH = Math.max(24, document.documentElement.clientHeight - 24);
  const curW = parseFloat(bubbleEl.style.width) || 0;
  const curH = parseFloat(bubbleEl.style.height) || 0;
  if (curW > maxW || curH > maxH) {
    bubbleEl.style.width = Math.min(curW, maxW) + "px";
    bubbleEl.style.height = Math.min(curH, maxH) + "px";
  }
}

function applyBubbleSize() {
  try {
    const w = parseFloat(localStorage.getItem("suzuran.bubbleW"));
    const h = parseFloat(localStorage.getItem("suzuran.bubbleH"));
    if (Number.isFinite(w) && Number.isFinite(h) && w >= 60 && h >= 24) {
      bubbleEl.style.width = Math.min(w, document.documentElement.clientWidth - 10) + "px";
      bubbleEl.style.height = Math.min(h, document.documentElement.clientHeight - 24) + "px";
    } else {
      // 非法/超限值：清掉，恢复自适应
      localStorage.removeItem("suzuran.bubbleW");
      localStorage.removeItem("suzuran.bubbleH");
      bubbleEl.style.width = "";
      bubbleEl.style.height = "";
    }
  } catch { /* 忽略 */ }
}

zoomBtn.addEventListener("click", () => {
  enlarged = !enlarged;
  document.body.classList.toggle("enlarged", enlarged);
  window.petAPI.setSize(enlarged ? 480 : winSize.width, enlarged ? 640 : winSize.height);
  zoomBtn.textContent = enlarged ? "⤡" : "⤢";
  if (enlarged) showBubble(); // 放大时把气泡亮出来
  // 窗口切换后：清掉记忆的固定尺寸，让气泡按新窗口自动缩放显示（超限由 clamp 收拢）
  if (enlarged) { bubbleEl.style.width = ""; bubbleEl.style.height = ""; }
  setTimeout(clampBubbleToWindow, 80); // 窗口切换后收拢超限气泡
  if (!enlarged && appearanceCfg) setTimeout(() => applyAppearance(appearanceCfg), 120); // 还原时恢复设置的气泡宽度/窗口宽
});

// 用户拖拽气泡右下角调整大小后记住（下次打开保持；超窗尺寸自动截断）
if (typeof ResizeObserver !== "undefined") {
  new ResizeObserver(() => {
    if (bubbleEl.style.width && bubbleEl.style.height) {
      const r = bubbleEl.getBoundingClientRect();
      try {
        localStorage.setItem("suzuran.bubbleW", String(Math.round(Math.min(r.width, document.documentElement.clientWidth - 10))));
        localStorage.setItem("suzuran.bubbleH", String(Math.round(Math.min(r.height, document.documentElement.clientHeight - 24))));
      } catch { /* 忽略 */ }
    }
  }).observe(bubbleEl);
}

/* ---------- 聊天外观（设置页即时下发：字号/字体/气泡宽度，含本地导入字体） ---------- */
let appearanceCfg = null;

function injectFontFace(file) { // 导入的字体文件位于 renderer/fonts/user/，按需注册 @font-face
  const id = "cffont-" + file;
  if (document.getElementById(id)) return;
  const st = document.createElement("style");
  st.id = id;
  st.textContent = `@font-face{font-family:"cf-${file}";src:url("fonts/user/${encodeURIComponent(file)}");}`;
  document.head.appendChild(st);
}

/** 气泡需要更宽窗口时自动加宽（宽度=气泡+角色条带余量，按 zoom 换算成窗口 DIP） */
function ensureWindowWidthFor(bubbleW) {
  const zoom = parseFloat(document.body.style.zoom) || 1;
  const need = Math.ceil((bubbleW + 140) * zoom);
  window.petAPI.setSize(Math.max(winSize.width, need), winSize.height);
}

function applyAppearance(a) {
  appearanceCfg = a || {};
  const root = document.documentElement.style;
  root.setProperty("--chat-fz", (Number(a.fontSize) > 0 ? Number(a.fontSize) : 11) + "px");
  let ff = "";
  if (a.fontFamily && a.fontFamily.startsWith("custom:")) {
    const f = a.fontFamily.slice(7);
    injectFontFace(f);
    ff = `"cf-${f}"`;
  } else if (a.fontFamily) {
    ff = `"${a.fontFamily}", "Microsoft YaHei"`;
  }
  bubbleEl.style.fontFamily = ff;
  const inputBar = document.getElementById("input-bar");
  if (inputBar) inputBar.style.fontFamily = ff; // 输入框与气泡同字体
  if (Number(a.bubbleWidth) > 0) {              // 固定宽度：高度恢复内容自适应
    bubbleEl.style.width = Number(a.bubbleWidth) + "px";
    bubbleEl.style.height = "";
    if (!enlarged) ensureWindowWidthFor(Number(a.bubbleWidth));
  } else {
    applyBubbleSize();                          // 恢复自适应/拖拽记忆尺寸
  }
}
if (window.petAPI.onAppearanceChanged) window.petAPI.onAppearanceChanged(applyAppearance);

/* 事件绑定 */
window.petAPI.onThinking(({ mode }) => {
  busy = true;
  currentMode = mode;
  setBubbleMode(mode);
  updateControls();
  showThinking();
  replyBuffer = "";
  // 任务模式 → 打字工作表情；聊天 → 思考
  setMood(mode === "zcode" ? "work" : "think");
});

window.petAPI.onChunk(({ id, mode, text }) => {
  if (!busy) { busy = true; setBubbleMode(mode); updateControls(); }
  hideThinking();
  replyBuffer += text;
  if (mode !== "zcode") {
    // 情绪标注（【情绪：xx】）不显示在气泡里，到结尾处截掉
    const mi = replyBuffer.indexOf("【情绪");
    if (mi >= 0) replyBuffer = replyBuffer.slice(0, mi);
  }
  if (mode === "zcode") {
    bubbleText.textContent = replyBuffer.slice(-4000);
  } else {
    startReveal(replyBuffer, bubbleText.textContent.length);
  }
});

window.petAPI.onDone(({ mode, full, emotion }) => {
  hideThinking();
  busy = false;
  const emoLabel = emotion ? String(emotion).trim() : "";
  if (mode === "zcode") {
    const result = (full || replyBuffer).slice(-4000);
    bubbleText.textContent = result;
    speak(result.length > 60 ? result.slice(0, 60) + "…" : result, emoLabel);
  } else {
    replyBuffer = full || replyBuffer;
    stopReveal();
    bubbleText.textContent = replyBuffer;
    speak(replyBuffer, emoLabel);
  }
  // 模型理解出的情绪 → 对应 GIF（没有匹配就用开心）
  const nm = emotion ? labelToName(String(emotion).trim()) : "";
  setMood(nm || "happy");
  setTimeout(() => { if (!busy) setMood("idle"); }, 2600);
  setTimeout(() => { if (!busy && !isSpeakingAudio) hideBubble(); }, 90000);
  updateControls();
  resetSleepTimer();
});

window.petAPI.onError(({ message }) => {
  showError(message);
  speak("唔……出错了。");
});

window.petAPI.onModeChanged((m) => {
  forcedMode = m;
  updateChip();
});

window.petAPI.onToggleInput(() => toggleInputBar());

window.petAPI.onToast((msg) => toast(msg));

/* ---------- 桌面行走 / 渲染模式切换（主进程 → 渲染层） ---------- */
if (window.petAPI.onWalking) {
  window.petAPI.onWalking((s) => applyWalkState(s));
}
if (window.petAPI.onEdgeLeft) {
  window.petAPI.onEdgeLeft((v) => bubbleEl.classList.toggle("top", !!v)); // 探出屏幕左侧：气泡挪到头顶
}
if (window.petAPI.onRenderModeChanged) {
  window.petAPI.onRenderModeChanged(async (m) => {
    await setRenderMode(m === "spine" ? "spine" : "gif");
    setMood(lastMood || "idle"); // 切换后恢复当前情绪
  });
}

/** 换肤：销毁旧模型与画布，重新探测皮肤并完整初始化 */
async function rebuildSpine() {
  try {
    if (spineObj) { try { spineObj.destroy(); } catch { /* 忽略 */ } spineObj = null; }
    if (spineApp) {
      const view = spineApp.view;
      if (view && view.parentNode) view.parentNode.removeChild(view);
      try { spineApp.destroy(false, { children: true, texture: false, baseTexture: false }); } catch { /* 忽略 */ }
      spineApp = null; // 共享纹理缓存保留（Assets 缓存按 URL 复用）
    }
    renderMode = "gif"; // 强制 setRenderMode("spine") 走一遍完整初始化
    spriteEl.style.display = "";
    await setRenderMode("spine");
    if (walkState.active) applyWalkState(walkState);
    reportGroundGap();
  } catch (e) {
    console.error("[Spine] 换肤重建失败:", e);
  }
}
if (window.petAPI.onSpineSkinChanged) {
  window.petAPI.onSpineSkinChanged(() => rebuildSpine().then(() => setMood(lastMood || "idle")));
}
if (window.petAPI.onPlayAnim) {
  window.petAPI.onPlayAnim((name) => { // 托盘「动作试演」点播
    if (!spineObj || renderMode !== "spine" || !spineHas(name)) return;
    animDemoUntil = Date.now() + 15000; // 播 15 秒，期间行走相位不抢动画
    spineObj.state.setAnimation(0, name, true);
    scheduleFitSpine();
  });
}

// 表情被替换/情绪增删后：重建情绪表并刷新当前显示的 GIF
window.petAPI.onSpritesChanged(({ name, moods }) => {
  if (Array.isArray(moods)) MOODS = moods;
  if (spriteEl.src) {
    spriteEl.src = spriteEl.src.split("?")[0] + "?t=" + Date.now();
  }
});

/* ---------- 输入栏 ---------- */
function toggleInputBar() {
  wake();
  inputBar.classList.toggle("hidden");
  clampBubbleToWindow();
  if (!inputBar.classList.contains("hidden")) {
    inputEl.focus();
    setMood("idle");
  }
}

function updateControls() {
  btnStop.classList.toggle("hidden", !busy);
  btnSend.disabled = busy;
}

function updateChip() {
  if (!zcodeEnabled) {
    modeChip.textContent = "💬";
    modeChip.className = "mode-chip";
    modeChip.title = "日常聊天";
    return;
  }
  if (forcedMode === "zcode") {
    modeChip.textContent = "⚡";
    modeChip.className = "mode-chip zcode";
    modeChip.title = "强制任务模式：点此恢复自动";
  } else if (forcedMode === "chat") {
    modeChip.textContent = "💬";
    modeChip.className = "mode-chip";
    modeChip.title = "强制聊天模式：点此恢复自动";
  } else {
    modeChip.textContent = "💬";
    modeChip.className = "mode-chip";
    modeChip.title = "自动路由：/zcode 或 /任务 开头自动执行任务";
  }
}

btnSend.addEventListener("click", send);
btnStop.addEventListener("click", () => { window.petAPI.stop(); });
inputEl.addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
modeChip.addEventListener("click", () => {
  if (!zcodeEnabled) { window.petAPI.setMode("auto"); return; } // 任务模式未启用 → 保持自动
  const next = forcedMode === "auto" ? "chat" : forcedMode === "chat" ? "zcode" : "auto";
  window.petAPI.setMode(next);
});
btnSend.disabled = false;

/* ---------- 语音输入（麦克风录音 → whisper 转写 → 填入输入框） ---------- */
const btnMic = document.getElementById("btn-mic");
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;

if (btnMic) {
  btnMic.addEventListener("mousedown", startRecording);
  btnMic.addEventListener("mouseup", stopRecording);
  btnMic.addEventListener("mouseleave", () => { if (isRecording) stopRecording(); });
}

async function startRecording() {
  if (isRecording || busy) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
    audioChunks = [];
    isRecording = true;
    btnMic.textContent = "⏺";
    btnMic.classList.add("recording");
    inputEl.placeholder = I18N.t("ui.micRecording");
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };
    mediaRecorder.start();
  } catch (e) {
    console.error("无法访问麦克风:", e);
    toast("无法访问麦克风，请检查权限设置");
    isRecording = false;
  }
}

async function stopRecording() {
  if (!isRecording || !mediaRecorder) return;
  isRecording = false;
  btnMic.textContent = "🎤";
  btnMic.classList.remove("recording");
  inputEl.placeholder = I18N.t("ui.placeholder");

  mediaRecorder.onstop = async () => {
    try {
      const blob = new Blob(audioChunks, { type: "audio/webm" });
      if (blob.size < 1000) return; // 太短，忽略

      // 转为 base64 发给主进程（用 FileReader，渲染层无 Buffer）
      const b64 = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const dataUrl = String(reader.result || "");
          resolve(dataUrl.split(",")[1] || "");
        };
        reader.readAsDataURL(blob);
      });
      if (!b64) return;

      // 通过新的 IPC 通道发送 base64 音频
      const result = await window.petAPI.voiceSttB64(b64, "ja");
      if (result && result.ok && result.text) {
        inputEl.value = result.text;
        inputEl.focus();
        toast(`🎤 识别：${result.text.slice(0, 30)}${result.text.length > 30 ? "…" : ""}`);
      } else {
        toast("语音识别失败，请重试");
      }
    } catch (e) {
      console.error("语音处理失败:", e);
    }
  };
  mediaRecorder.stop();
  if (mediaRecorder.stream) {
    mediaRecorder.stream.getTracks().forEach((t) => t.stop());
  }
}

/* ---------- 主动搭话（主进程发送 → 显示气泡 + 语音） ---------- */
if (window.petAPI && window.petAPI.onProactive) {
  window.petAPI.onProactive(({ text, emotion }) => {
    if (!text) return;
    showBubble();
    bubbleText.textContent = text;
    setMood(emotion || "idle");
    speak(text);
    setTimeout(() => { if (!busy) hideBubble(); }, 15000);
  });
}

/* ---------- TTS 开关按钮 ---------- */
const btnTts = document.getElementById("btn-tts");
function updateTtsButton() {
  if (!btnTts) return;
  btnTts.textContent = ttsConfig.enabled ? "🔊" : "🔇";
  btnTts.classList.toggle("off", !ttsConfig.enabled);
  btnTts.title = ttsConfig.enabled ? "语音：开（点此关闭）" : "语音：关（点此开启）";
}
if (btnTts) {
  btnTts.addEventListener("click", () => {
    const next = !ttsConfig.enabled;
    ttsConfig.enabled = next;
    updateTtsButton();
    if (!next) speechSynthesis.cancel();
    window.petAPI.setTts(next);
  });
}
window.petAPI.onTtsChanged((v) => {
  ttsConfig.enabled = !!v;
  updateTtsButton();
});
window.petAPI.onRateChanged((v) => {
  ttsConfig.rate = v;
});

// 桌宠大小缩放（CSS zoom 整体缩放，窗口由主进程同步调整）
function applyScale(s) {
  const v = Math.max(0.6, Math.min(2.0, parseFloat(s) || 1.0));
  document.body.style.zoom = String(v);
}
window.petAPI.onScaleChanged((v) => applyScale(v));

// 条款未同意：提示气泡并保持不可用
window.petAPI.onTermsPending(() => {
  agreed = false;
  showBubble();
  bubbleEl.classList.add("error");
  bubbleText.textContent = "初次使用请先阅读并同意《使用条款与隐私政策》（已弹出窗口），同意后才能开始聊天哦 🩺";
});
window.petAPI.onTermsAgreed(() => {
  agreed = true;
  hideBubble();
});

/* ---------- 拖拽（手动，区分点击） ---------- */
let dragState = null;
let pokeResumeTimer = null; // 戳一戳后的原地站立计时
petEl.addEventListener("mousedown", (e) => {
  wake();
  if (e.button !== 0) return;
  clearTimeout(pokeResumeTimer);
  dragState = { sx: e.screenX, sy: e.screenY, moved: false, active: true };
  window.petAPI.walkingPause(true); // 拖拽中暂停桌面行走，松手恢复
});
// 右键宠物 → 隐藏到托盘
petEl.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  window.petAPI.hideWindow();
});
window.addEventListener("mousemove", (e) => {
  if (!dragState || !dragState.active) return;
  const dx = e.screenX - dragState.sx;
  const dy = e.screenY - dragState.sy;
  if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
    dragState.moved = true;
    petEl.classList.add("dragging");
    window.petAPI.moveWindow(dx, dy);
    dragState.sx = e.screenX;
    dragState.sy = e.screenY;
  }
});
window.addEventListener("mouseup", () => {
  if (!dragState) return;
  const wasDrag = dragState.moved;
  dragState = null;
  petEl.classList.remove("dragging");
  if (!wasDrag) {
    toggleInputBar();
    playSpineInteract(); // 单击互动：还原基建里点一下干员的反应动作
    // 戳一戳时原地站定：等互动动作播完再继续散步
    clearTimeout(pokeResumeTimer);
    pokeResumeTimer = setTimeout(() => { if (!dragState) window.petAPI.walkingPause(false); }, 2600);
  } else {
    window.petAPI.walkingPause(false);
  }
});

/* ---------- 点击穿透：透明区域不挡下层应用 ----------
   只有鼠标在 桌宠/气泡/输入栏 上时才放行鼠标事件，其余穿透给下层应用；
   拖拽中强制放行（否则 mouseup 被穿透吞掉会导致拖拽卡死） */
function isPetUI(el) {
  return !!el && (el.closest("#pet") || el.closest("#bubble") || el.closest("#input-bar"));
}
document.addEventListener("mousemove", (e) => {
  const el = document.elementFromPoint(e.clientX, e.clientY);
  window.petAPI.setClickable(isPetUI(el) || (dragState && dragState.active));
});

/* ---------- 初始化 ---------- */
(async function init() {
  const state = await window.petAPI.getState();
  forcedMode = state.forcedMode || "auto";
  zcodeEnabled = !!state.zcodeEnabled;
  if (typeof state.agreed === "boolean") agreed = state.agreed;
  if (Array.isArray(state.moods) && state.moods.length) MOODS = state.moods;
  if (state.scale) applyScale(state.scale);
  if (state.tts) ttsConfig = { ...ttsConfig, ...state.tts };
  if (state.ttsCloud) ttsCloudOn = !!state.ttsCloud.enabled;
  if (state.winSize) winSize = state.winSize;
  applyBubbleSize();
  reportGroundGap(); // 上报角色脚底与窗口底边空隙，供主进程贴地补偿
  try { const ap = await window.petAPI.getAppearance(); if (ap) applyAppearance(ap); } catch { /* 默认外观 */ }
  updateChip();
  updateTtsButton();
  initTts();

  // Spine 小人模式（支持桌面行走）；加载失败自动回退 GIF
  if (state.renderMode === "spine") {
    await setRenderMode("spine");
    if (state.walking) applyWalkState({ active: true, resting: true, perched: false, seated: false, face: 1 });
  }

  if (!agreed) {
    showBubble();
    bubbleEl.classList.add("error");
    bubbleText.textContent = "初次使用请先阅读并同意《使用条款与隐私政策》（已弹出窗口），同意后才能开始聊天哦 🩺";
    return;
  }

  if (!state.keyReady) {
    showBubble();
    bubbleEl.classList.add("error");
    bubbleText.textContent = "还没有配置 API Key 哦。右键托盘图标 →「⚙️ 设置」，填好 API 后再回来找我吧（" + (state.keySource || "") + "）。";
    return;
  }

  setMood("idle");
  resetSleepTimer();

  // 开场白（气泡 + 语音；可在设置里关闭「启动问候」；隐藏启动时静默待命不打扰）
  if (state.greetingOnStart !== false && state.personaOpening && !state.hiddenAtStart) {
    showBubble();
    bubbleText.textContent = state.personaOpening;
    speak(state.personaOpening);
    setTimeout(() => { if (!busy) hideBubble(); }, 20000);
  }
})();
