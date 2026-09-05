"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn, exec, execFile } = require("child_process");
const config = require("./config");
const { logTts } = require("./logger");
const { safeFetch } = require("./safe-url");
const fixedLineCache = require("./fixed-line-cache");
const FIXED_ONLY_MISS = "__SUZURAN_FIXED_ONLY_MISS__";
const { translateToJa, lookupCachedJa } = require("./ja-translate");
const { runPowerShell, stripStage } = require("./utils");

/**
 * TTS 语音链路（模块化第四步）：本地 Genie（克隆音色）→ GPT-SoVITS 日语 → CosyVoice → edge-tts → 空（渲染层回退系统语音）。
 * 含引擎服务器拉起/单飞/自愈（劣化重启/杀进程/预热）、合成串行队列、日语翻译调用。
 * 依赖：config/logger/ja-translate/子进程；无 Electron 状态（广播由 main.js 的 IPC 层处理）。
 */

let ttsQueue = Promise.resolve(); // 合成串行队列：GSV/Genie 单模型串行处理，并发施压是毛刺诱因之一

const gsvBreaker = { failures: 0, openedAt: 0, cooldownMs: 60000 };

let partSender = null;
let jaFallbackCb = null; // 日语翻译降级回调（一次性，提示检查配额）
function setJaFallbackCb(fn) { jaFallbackCb = typeof fn === "function" ? fn : null; } // v2.5.5 逐句流式：main 注入 sendToRenderer 包装，合成完成一句即推给渲染层
function setPartSender(fn) { partSender = typeof fn === "function" ? fn : null; }
let genieServerChecked = false;

let genieServerUp = false;

let genieEnsurePromise = null;

let gsvServerChecked = false;

let gsvServerUp = false;

let gsvEnsurePromise = null; // 拉起流程单飞：进行中的拉起由后续调用共享等待

let gsvWarmupPromise = null;

let gsvAutoRestarting = false; // 自动重启进行中（防嵌套）

let gsvWarmingUp = false;      // 预热进行中（防重入）

let gsvDeviceCache = null; // 检测结果缓存（null=未检测）

let gsvCrashRecoveryAt = 0;    // 上次崩溃自愈时刻（60s 节流，防连环重启）

/** 重置 Genie 服务器状态标志（不杀进程）：下次 ensureGenieServer 会重新探活/拉起 */
function resetGenieServer() {
  genieServerChecked = false;
  genieServerUp = false;
}
function shutdownGenieServer() {
  genieServerChecked = false;
  genieServerUp = false;
  // 返回 Promise：等待 taskkill 完成（供退出前阻塞清理；其他调用方 fire-and-forget 也兼容）
  return new Promise((resolve) => {
    try {
      // 注意：服务器跑在 pythonw.exe（无控制台），必须匹配 python% 而非 python.exe
      const ps = spawn("powershell", ["-NoProfile", "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name like 'python%'\" | Where-Object { $_.CommandLine -like '*genie_tts_server*' } | ForEach-Object { & taskkill /PID $_.ProcessId /T /F 2>&1 | Out-Null }"],
        { windowsHide: true });
      ps.on("error", () => resolve());
      ps.on("exit", () => resolve());
      ps.on("close", () => resolve());
      setTimeout(resolve, 8000); // 兜底：最多等 8s，避免退出卡住
      logTts("genie", "语音关闭 → 停止本地服务器");
    } catch { resolve(); }
  });
}

function gsvAvailableNow() {
  if (!gsvBreaker.openedAt) return true;
  if (Date.now() - gsvBreaker.openedAt >= gsvBreaker.cooldownMs) {
    logTts("gsv", "冷却结束，允许一次恢复探测");
    gsvBreaker.openedAt = 0;
    return true;
  }
  return false;
}

function recordGsvResult(ok) {
  if (ok) { gsvBreaker.failures = 0; return; }
  gsvBreaker.failures += 1;
  if (gsvBreaker.failures >= 2) {
    gsvBreaker.openedAt = Date.now();
    logTts("gsv", "连续失败 " + gsvBreaker.failures + " 次，进入 60 秒冷却并回退中文语音");
  }
}

/* ---------- v2.5.4 音频缓存：重复台词（摸头/主动搭话/人格化等高度重复）秒回 ---------- */
const AUDIO_CACHE_MAX = 20;
const AUDIO_CACHE_TTL = 5 * 60 * 1000; // 5 分钟
const audioCache = new Map();
function audioCacheKey(text, opts) {
  const speakJa = !!(config.getConfig().ttsGenie || {}).speakJa;
  return String(text || "").slice(0, 150) + "|" + (opts && (opts.emotion || opts.emo) || "") + "|" + (speakJa ? "ja" : "zh");
}
async function ttsCloneImpl(text, opts, jobId) {
  // 命中缓存：跳过翻译+合成，整句秒回（同一句台词反复触发时收益最大）
  const isStale = () => jobId !== undefined && jobId !== ttsJobSeq;
  if (isStale()) return ""; // 已经来了新消息，旧任务让位
  const akey = audioCacheKey(text, opts);
  const ahit = audioCache.get(akey);
  if (ahit && Date.now() - ahit.t < AUDIO_CACHE_TTL) {
    logTts("route", "音频缓存命中: " + String(text || "").slice(0, 24));
    return ahit.b64;
  }
  let effectiveFixedLine = !!(opts && opts.fixedLine);
  if (!(opts && opts.fixedLinePreload)) {
    const profile = fixedLineCache.profileFromConfig(config.getConfig());
    const vars = {
      name: (config.getConfig().pet || {}).name,
      user: (config.getConfig().chat || {}).userName
    };
    const fixedText = String(opts && opts.fixedText || "");
    const normalizedText = stripSpeechTail(stripStage(fixedText || text));
    let fixedItem = null;
    try {
      fixedItem = fixedLineCache.findItemText(vars, fixedText) ||
        fixedLineCache.findItemNormalized(vars, fixedText || normalizedText) ||
        fixedLineCache.findItemNormalized(vars, normalizedText) ||
        fixedLineCache.findItemNormalized(vars, stripStage(stripSpeechTail(text)));
    } catch { /* 固定池反查失败仍允许动态语音继续 */ }
    let diskHit = (opts && opts.lineId)
      ? fixedLineCache.readAudioById(profile, opts.lineId)
      : null;
    if ((!diskHit || !diskHit.length) && fixedItem) {
      diskHit = fixedLineCache.readAudioById(profile, fixedItem.id);
    }
    // lineId 是首选，但旧缓存/重建期间可能暂时不一致；再用展开文本+情绪兜底，避免离线模式误判为未缓存。
    if (!diskHit || !diskHit.length) {
      diskHit = fixedLineCache.findCachedAudio(profile, fixedText || text, opts && (opts.emotion || opts.emo), vars);
    }
    effectiveFixedLine = effectiveFixedLine || !!fixedItem;
    logTts("route", "固定台词缓存检查 fp=" + fixedLineCache.pathsFor(profile).fingerprint +
      " lineId=" + String(opts && opts.lineId || (fixedItem && fixedItem.id) || "-") + " fixed=" + effectiveFixedLine +
      " hit=" + !!(diskHit && diskHit.length) + " text=" + String(fixedText || text || "").slice(0, 24));
    if (diskHit && diskHit.length) {
      logTts("route", "固定台词磁盘缓存命中" + (opts && opts.lineId ? "（lineId）" : ""));
      return diskHit.toString("base64");
    }
  }
  if ((config.getConfig().tts || {}).fixedOnly && !(opts && opts.fixedLinePreload)) {
    if (effectiveFixedLine) {
      logTts("route", "固定台词离线模式：无缓存，跳过引擎合成（省显存；不回退系统语音）");
      return FIXED_ONLY_MISS;
    }
    logTts("route", "离线模式：动态文本无固定缓存，回退系统语音");
    return "";
  }
  const b64 = await ttsCloneImplInner(text, opts, jobId);
  if (b64 && !isStale()) {
    audioCache.set(akey, { t: Date.now(), b64 });
    if (audioCache.size > AUDIO_CACHE_MAX) audioCache.delete(audioCache.keys().next().value);
  }
  return isStale() ? "" : b64;
}
async function ttsCloneImplInner(text, opts, jobId) {
  // 语音链路：本地 Genie（ttsGenie，主，克隆音色）→ 百炼 CosyVoice（ttsCosy，默认停用）→ edge-tts（ttsCloud）→ 空（渲染层回退系统语音）
  const isStale = () => jobId !== undefined && jobId !== ttsJobSeq;
  applyBundledVoice(); // 随包声音源回填（首启即生效，幂等）
  try {
    const dumpWav = (b64) => { // 调试转储：保存最终交付的音频，便于排查播放端问题
      try {
        fs.mkdirSync(config.STORAGE.audio, { recursive: true });
        fs.writeFileSync(path.join(config.STORAGE.audio, "tts_last.wav"), Buffer.from(b64, "base64"));
      } catch { /* 转储失败不影响主流程 */ }
    };
    const cfg = config.getConfig();
    const _stripped = stripStage(String(text || "")); // 剥（动作）后截断：舞台指示只显示不念（v2.5.26）
    const clean = (_stripped || String(text || "")).slice(0, 400); // 纯动作文本剥完为空 → 回退原文（防御外部直调）
    // 游戏习惯称呼：中文朗读用“刀客塔”；日语翻译仍用原文“博士”（让翻译器输出ドクター）
    const cleanZh = clean.replace(/博士/g, "刀客塔");
    const q = cfg.ttsGenie || {};
    // 日语语音模式（speakJa）：先把中文翻译成日语，再用 GPT-SoVITS（ttsGsv）日语微调音色说话；文字/聊天保持中文
    let ttsText = cleanZh;
    let jaText = "";
    if (q.speakJa) {
      // 2026-09-03 修「日语预热✓却系统音/逐句跳过」②：渲染层会给情绪台词追加句尾语气词
      // （EMOTION_SPEECH：呀！/哼！/嘛～等），翻译键与预热键（stripStage(展开台词)）不一致 →
      // 每次播放都现场调翻译 API，超时即整句静音回退系统音。先剥已知语气词按规范键直查缓存
      // （零 API），未命中再按原文（含语气词）现场翻译，保持既有语气朗读行为不变。
      const canon = stripSpeechTail(clean);
      let ja = (canon && canon !== clean) ? lookupCachedJa(canon) : "";
      if (ja) { jaText = ja; ttsText = ja; logTts("ja", "翻译(预热缓存): " + clean.slice(0, 18) + " → " + ja.slice(0, 18)); }
      else {
        ja = await translateToJa(clean);
        if (ja) { jaText = ja; ttsText = ja; logTts("ja", "翻译: " + clean + " → " + ja); }
        else {
          logTts("ja", "翻译失败，静音（日语模式不退回中文引擎）");
          if (jaFallbackCb) { const _cb = jaFallbackCb; jaFallbackCb = null; try { _cb(); } catch { /* 通知失败不影响合成 */ } }
          return ""; // v2.5.17：日语模式任何失败一律静音，不消耗中文/云引擎（省内存）
        }
      }
    }
    if (jaText) {
      // 日语模式：优先本地 GPT-SoVITS 日语合成（苏苏洛音色）。
      // 微调模型一次只能生成一句，因此按句切分逐句合成后拼接，保证完整读完回复。
      const g = cfg.ttsGsv || {};
      if (g.enabled && gsvAvailableNow()) {
        const up = await ensureGsvServer(g);
        if (up) {
          const sents = splitJaSentences(sanitizeJaText(stripStage(jaText))); // 旧译文缓存可能仍带（动作），出口再剥一次
          const parts = [];
          let skipped = 0;
          const emoRef = emotionGsvRef(opts && (opts.emotion || opts.emo)); // 仅情绪命中才带参考音频（兼容 emo/emotion 键名）
          for (const s of sents) {
            if (isStale()) { logTts("gsv", "合成中途有新消息，本句让位"); return ""; } // 逐句合成期间又来新消息：立即作废，避免旧回复语音拖尾
            const b64 = await gsvTtsJa(g, s, emoRef);
            if (b64) {
              parts.push(b64);
              if (partSender && !isStale()) { try { partSender({ b64, session: opts && opts.session }); } catch { /* 推送失败不影响合成 */ } } // 流式：先到先播（带渲染层会话号，新会话丢弃旧 part）
              continue;
            }
            skipped += 1;
            logTts("gsv", `单句失败跳过（${skipped}/${sents.length}）: ${String(s).slice(0, 24)}`);
          }
          if (parts.length && !isStale()) { // 部分成功也交付（失败句跳过），避免一句毛刺整段变中文
            const merged = mergeWavBase64(parts);
            if (merged && !isStale()) {
              recordGsvResult(true);
              logTts("route", skipped
                ? `gsv-ja 部分成功 ${parts.length}/${sents.length}句（跳过${skipped}）len=${merged.length}`
                : `gsv-ja ok ${parts.length}/${sents.length}句 len=${merged.length}`);
              dumpWav(merged);
              return merged;
            }
          }
          recordGsvResult(false);
          logTts("route", "gsv-ja 无可用句 → 静音（日语模式不退回中文）");
        } else {
          recordGsvResult(false);
          logTts("route", "gsv-ja 服务不可用 → 静音（日语模式不退回中文）");
        }
      } else if (g.enabled) {
        logTts("route", "gsv-ja 冷却中 → 静音（日语模式不退回中文）");
      }
      return ""; // v2.5.17：日语模式合成失败一律静音，不消耗 Genie/cosy/edge（省内存 + 失败不折腾）
    }
    if (q.enabled) {
      const up = await ensureGenieServer(q);
      if (up) {
        const b64 = await genieTts(q, ttsText);
        if (b64 && !isStale()) { logTts("route", "genie ok len=" + b64.length); return b64; }
        logTts("route", "genie 返回空 → 走 cosy/edge 回退");
      } else {
        logTts("route", "genie 服务不可用 → 走 cosy/edge 回退");
      }
    } else {
      logTts("route", "genie 未启用");
    }
    const cosy = cfg.ttsCosy || {};
    if (cosy.enabled && cosy.voice && cosy.apiKey) {
      let b64 = await cosyTts(cosy, ttsText);
      if (!b64) { // 偶发网络/服务抖动时重试一次
        logTts("route", "cosy 首次失败，重试一次");
        await new Promise((r) => setTimeout(r, 800));
        b64 = await cosyTts(cosy, ttsText);
      }
      if (b64 && !isStale()) { logTts("route", "cosy ok len=" + b64.length); return b64; }
      logTts("route", "cosy 仍失败 → 走 edge 回退");
    } else {
      logTts("route", "cosy 未启用/缺voice/缺key: " + JSON.stringify({ e: cosy.enabled, v: !!cosy.voice, k: !!cosy.apiKey }));
    }
    const c = cfg.ttsCloud || {};
    if (c.enabled) {
      const b64 = await edgeTts(c, cleanZh);
      if (b64 && !isStale()) { logTts("route", "edge ok len=" + b64.length); return b64; }
      logTts("route", "edge 返回空 → 回退系统语音");
    }
    return "";
  } catch (e) {
    console.error("[SuzuranPet] 语音合成失败:", e.message);
    return "";
  }
}

function resolveTtsEndpoint(engine, fallbackPort) {
  try {
    const url = new URL(String(engine.server || `http://127.0.0.1:${fallbackPort}`));
    if (url.username || url.password || url.hash || !["http:", "https:"].includes(url.protocol)) return null;
    const host = url.hostname.toLowerCase();
    const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
    if (!loopback && (!engine.allowRemote || url.protocol !== "https:")) return null;
    url.pathname = url.pathname.replace(/\/+$/, "");
    return { base: url.toString().replace(/\/$/, ""), loopback, autoStart: loopback && engine.autoStart !== false };
  } catch { return null; }
}

/** 语音引擎本地拉起前置探测（§14 追加 94）：python/serverScript 不存在时给出明确原因，
 *  不再裸 spawn ENOENT（Genie 路径无 error 监听时会冒泡到 uncaughtException）。返回缺失描述或 null */
function missingEnginePath(eng) {
  const miss = [];
  if (eng && eng.python && !fs.existsSync(eng.python)) miss.push("python=" + eng.python);
  if (eng && eng.serverScript && !fs.existsSync(eng.serverScript)) miss.push("serverScript=" + eng.serverScript);
  return miss.length ? miss.join("; ") : null;
}

/* §109 随包引擎与声音源（engines/ 目录，随发布包分发）：探测 exe 旁的引擎与苏苏洛模型，
 * 缺失时回填 config（python/serverScript/模型路径全部指向包内，新用户开箱即用）。
 * 基准 = process.execPath 所在目录（正式版根目录）；dev 下探测失败自然跳过，不影响旧配置。 */
function bundleVoice() {
  try {
    const exeDir = path.dirname(process.execPath || "");
    const engDir = path.join(exeDir, "engines");
    const out = {};
    // GSV（日语，GPT-SoVITS v2Pro）引擎随包：engines/gsv/
    const gsvPy = path.join(engDir, "gsv", "runtime", "python.exe");
    const gsvApi = path.join(engDir, "gsv", "api.py");
    const gsvPth = path.join(engDir, "gsv", "sussurro_e50_s1050.pth");
    const gsvCkpt = path.join(engDir, "gsv", "sussurro_v2proplus-e20.ckpt");
    const gsvRef = path.join(engDir, "gsv", "ref_ja.wav");
    if (fs.existsSync(gsvPy) && fs.existsSync(gsvApi) && fs.existsSync(gsvPth) && fs.existsSync(gsvCkpt) && fs.existsSync(gsvRef)) {
      out.gsv = { python: gsvPy, serverScript: gsvApi, sovitsPath: gsvPth, gptPath: gsvCkpt, refAudio: gsvRef, refText: "ドクター、そろそろ休憩の時間だよ" };
    }
    // Genie（中文，克隆音色）引擎随包：engines/genie/
    const geniePy = path.join(engDir, "genie", "venv", "Scripts", "pythonw.exe");
    const genieApi = path.join(engDir, "genie", "genie_tts_server.py");
    const genieRef = path.join(engDir, "genie", "ref", "ref_sussurro.wav");
    const genieOnnx = path.join(engDir, "genie", "my_model", "sussurro_v2proplus", "onnx", "t2s_shared_fp16.bin");
    if (fs.existsSync(geniePy) && fs.existsSync(genieApi) && fs.existsSync(genieRef) && fs.existsSync(genieOnnx)) {
      out.genie = { python: geniePy, serverScript: genieApi, refAudio: genieRef, refText: "你好呀，新手星，我是苏苏洛，罗德岛的医疗干员。今天也要好好休息哦。", modelDir: path.dirname(genieOnnx) };
    }
    return Object.keys(out).length ? out : null;
  } catch { return null; }
}

/** Genie venv 的 pyvenv.cfg home 指向包内 base-python（venv 本身绑定宿主绝对路径，新机器上失效） */
function fixBundledGenieVenv() {
  try {
    const exeDir = path.dirname(process.execPath || "");
    const cfgPath = path.join(exeDir, "engines", "genie", "venv", "pyvenv.cfg");
    const basePy = path.join(exeDir, "engines", "genie", "base-python");
    if (!fs.existsSync(cfgPath) || !fs.existsSync(path.join(basePy, "python.exe"))) return;
    const txt = fs.readFileSync(cfgPath, "utf8");
    const m = txt.match(/^home\s*=\s*(.+)$/m);
    if (!m) return;
    if (fs.existsSync(path.join(m[1].trim(), "python.exe"))) return; // 当前 home 仍有效，不动
    const newCfg = txt.replace(/^home\s*=.*$/m, "home = " + basePy.replace(/\\/g, "\\\\"));
    fs.writeFileSync(cfgPath, newCfg, "utf8");
    logTts("voice", "Genie venv home 已指向包内 base-python");
  } catch (e) { logTts("voice", "Genie venv 修复失败: " + (e && e.message || e)); }
}

/** 引擎/模型路径缺失时用随包内容回填 config（只写缺失项，不覆盖用户已配置路径） */
function applyBundledVoice() {
  try {
    fixBundledGenieVenv();
    const bv = bundleVoice();
    if (!bv) return;
    const cfg = config.getConfig();
    const g = cfg.ttsGsv || {};
    const ge = cfg.ttsGenie || {};
    const patch = {};
    if (bv.gsv && ((!g.python || !fs.existsSync(g.python)) || (!g.sovitsPath || !fs.existsSync(g.sovitsPath)))) {
      patch.ttsGsv = { ...g, python: bv.gsv.python, serverScript: bv.gsv.serverScript, sovitsPath: bv.gsv.sovitsPath, gptPath: bv.gsv.gptPath, refAudio: bv.gsv.refAudio, refText: bv.gsv.refText };
    }
    if (bv.genie && ((!ge.python || !fs.existsSync(ge.python)) || (!ge.refAudio || !fs.existsSync(ge.refAudio)))) {
      patch.ttsGenie = { ...ge, python: bv.genie.python, serverScript: bv.genie.serverScript, refAudio: bv.genie.refAudio, refText: bv.genie.refText };
    }
    if (patch.ttsGsv || patch.ttsGenie) {
      config.saveConfig(patch);
      logTts("voice", "已回填随包引擎与苏苏洛声音源（engines/，开箱即用）");
    }
  } catch (e) { logTts("voice", "随包引擎回填失败: " + (e && e.message || e)); }
}

async function ensureGenieServer(q) {
  if ((config.getConfig().tts || {}).fixedOnly) {
    logTts("genie", "固定台词离线模式：阻止 Genie 启动");
    return false;
  }
  applyBundledVoice();
  if (genieServerChecked) return genieServerUp;
  if (genieEnsurePromise) return genieEnsurePromise;
  genieEnsurePromise = (async () => {
  genieServerChecked = true;
  const endpoint = resolveTtsEndpoint(q, 9881);
  if (!endpoint) { logTts("genie", "拒绝非 loopback 或未授权的远端端点"); return false; }
  const base = endpoint.base;
  const health = async () => {
    try {
      const r = await safeFetch(base + "/health", { signal: AbortSignal.timeout(2000) }, { allowLoopback: endpoint.loopback });
      return r.ok && (await r.text()) === "ok";
    } catch { return false; }
  };
  if (await health()) { genieServerUp = true; logTts("genie", "服务器已在运行"); return true; }
  if (!endpoint.autoStart) {
    logTts("genie", "远端端点未响应，跳过本地拉起");
    return false;
  }
  if (!q.python || !q.serverScript) {
    logTts("genie", "配置不完整（python/serverScript）");
    return false;
  }
  const gMiss = missingEnginePath(q);
  if (gMiss) {
    logTts("genie", "引擎路径不存在（首次安装未配置，请到语音设置页配置）: " + gMiss);
    return false;
  }
  logTts("genie", "服务器未运行，尝试拉起...");
  try {
    const args = [q.serverScript, "--port", String(new URL(base).port || 9881)];
    const bv = bundleVoice();
    if (bv && bv.genie && bv.genie.modelDir) args.push("--model-dir", bv.genie.modelDir); // 随包苏苏洛模型 engines/genie/my_model/.../onnx
    const child = spawn(q.python, args, {
      detached: true, windowsHide: true, stdio: "ignore"
    });
    child.on("error", (e) => logTts("genie", "拉起进程错误: " + (e && e.message || e)));
    child.unref();
  } catch (e) {
    logTts("genie", "拉起失败: " + (e && e.message || e));
    return false;
  }
  const deadline = Date.now() + (q.startTimeout || 240000); // 模型加载最长 ~4 分钟
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    if (await health()) { genieServerUp = true; logTts("genie", "服务器就绪"); return true; }
  }
  logTts("genie", "等待超时（150s 未就绪）");
  return false;
  })();
  try {
    return await genieEnsurePromise;
  } finally {
    genieEnsurePromise = null;
    if (!genieServerUp) {
      // 启动失败自愈：60s 后清缓存允许重新拉起（避免一次失败导致整会话没声音、一直系统音兜底）
      setTimeout(() => { if (!genieServerUp) resetGenieServer(); }, 60000);
    }
  }
}

async function genieTts(q, clean) {
  const base = String(q.server || "").replace(/\/+$/, "");
  const callOnce = async () => {
    const endpoint = resolveTtsEndpoint(q, 9881);
    if (!endpoint) return null;
    const resp = await safeFetch(base + "/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: clean,
        ref_audio: q.refAudio || "",
        ref_text: q.refText || ""
      }),
      signal: AbortSignal.timeout(120000)
    }, { allowLoopback: endpoint.loopback });
    if (!resp.ok) {
      const t = (await resp.text()).slice(0, 200);
      logTts("genie", "HTTP " + resp.status + ": " + t);
      return null;
    }
    return Buffer.from(await resp.arrayBuffer());
  };
  try {
    let buf = await callOnce();
    if (buf === null) return "";
    // 劣化自愈：文本不短但音频极小（<60KB）→ 重启 Genie 服务后重试一次
    if (buf.length < 60000 && clean.length > 6) {
      logTts("genie", `疑似引擎劣化（${buf.length}B / 文本${clean.length}字）→ 重启服务重试`);
      shutdownGenieServer();
      const up = await ensureGenieServer(q);
      if (!up) return "";
      buf = await callOnce();
      if (buf === null) return "";
    }
    if (buf.length < 100) { logTts("genie", "返回过短"); return ""; }
    return buf.toString("base64");
  } catch (e) {
    logTts("genie", "请求失败: " + (e && e.message || e));
    return "";
  }
}

function ensureGsvServer(g) {
  if ((config.getConfig().tts || {}).fixedOnly) {
    logTts("gsv", "固定台词离线模式：阻止 GSV 启动");
    return Promise.resolve(false);
  }
  if (gsvEnsurePromise) return gsvEnsurePromise;
  applyBundledVoice();
  gsvEnsurePromise = ensureGsvServerImpl(config.getConfig().ttsGsv || {}).finally(() => { gsvEnsurePromise = null; });
  return gsvEnsurePromise;
}

async function ensureGsvServerImpl(g) {
  if (gsvServerChecked) return gsvServerUp;
  gsvServerChecked = true;
  const endpoint = resolveTtsEndpoint(g, 9880);
  if (!endpoint) { logTts("gsv", "拒绝非 loopback 或未授权的远端端点"); return false; }
  const base = endpoint.base;
  const alive = async () => {
    try {
      const r = await safeFetch(base + "/set_model", { signal: AbortSignal.timeout(2000) }, { allowLoopback: endpoint.loopback });
      return r.status === 400 || r.ok; // 服务器在线即返回 400/200
    } catch { return false; }
  };
  if (await alive()) {
    gsvServerUp = true;
    logTts("gsv", "服务器已在运行");
    await warmupGsv(g);
    return true;
  }
  if (!endpoint.autoStart) {
    logTts("gsv", "远端端点未响应，跳过本地拉起");
    return false;
  }
  if (!g.python || !g.serverScript) {
    logTts("gsv", "配置不完整（python/serverScript）");
    return false;
  }
  const gMiss = missingEnginePath(g);
  if (gMiss) {
    logTts("gsv", "引擎路径不存在（首次安装未配置，请到语音设置页配置）: " + gMiss);
    return false;
  }
  logTts("gsv", "服务器未运行，尝试拉起...");
  try {
    const args = [
      g.serverScript,
      "-s", g.sovitsPath,
      "-g", g.gptPath,
      "-dr", g.refAudio,
      "-dt", g.refText,
      "-dl", "ja",
      "-a", "127.0.0.1",
      "-p", String(new URL(base).port || 9880)
      // 不传 -hp（半精度 fp16）：此环境偶发数值不稳定，输出破碎电音/极短碎片且随机分布；
      // 全精度略慢更稳（4060 8GB 显存充足）。若确认需要半精度可在此手动加回 "-hp"
    ];
    let device = String(g.device || "").trim();
    if (!device) device = await detectGsvDevice(); // 未配置时自动检测：有 N 卡用 CUDA，否则 CPU
    if (device) args.push("-d", device); // 显存紧张时可配 "cpu"（慢但稳定）
    // api.py 必须以 GPT-SoVITS 根目录为工作目录启动（否则 ModuleNotFoundError: text）
    const child = spawn(g.python, args, {
      detached: true, windowsHide: true, stdio: "ignore",
      cwd: path.dirname(String(g.serverScript || ""))
    });
    child.on("error", (e) => logTts("gsv", "拉起进程错误: " + (e && e.message || e)));
    child.unref();
  } catch (e) {
    logTts("gsv", "拉起失败: " + (e && e.message || e));
    return false;
  }
  const deadline = Date.now() + (g.startTimeout || 240000);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    if (await alive()) {
      gsvServerUp = true;
      logTts("gsv", "服务器就绪");
      await warmupGsv(g);
      return true;
    }
  }
  logTts("gsv", "等待超时");
  return false;
}

function wavDurationMs(buf) {
  try {
    if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF") return -1;
    let off = 12, sr = 32000, ch = 1, bits = 16, dataSize = 0;
    while (off + 8 <= buf.length) {
      const id = buf.toString("ascii", off, off + 4);
      const size = Math.min(buf.readUInt32LE(off + 4), buf.length - off - 8);
      if (id === "fmt " && size >= 16) { ch = buf.readUInt16LE(off + 10); sr = buf.readUInt32LE(off + 12); bits = buf.readUInt16LE(off + 22); }
      if (id === "data") { dataSize = size; break; }
      off += 8 + size + (size % 2);
    }
    if (!dataSize || !sr) return -1;
    return dataSize / (sr * ch * (bits / 8)) * 1000;
  } catch { return -1; }
}

async function gsvTtsJa(g, text, emoRef) {
  const clean = sanitizeJaText(text); // ～ —— 引号等符号会让引擎输出碎片，先清洗
  const base = String(g.server || "").replace(/\/+$/, "");
  const params = new URLSearchParams({ text: clean.slice(0, 300), text_language: "ja" });
  // 情绪参考音频（v2.5.4）：仅检测到特定情绪（撒娇/傲娇/惊讶）且素材存在时切换；默认绝不动
  if (emoRef && emoRef.file && fs.existsSync(emoRef.file)) {
    params.set("ref_audio_path", emoRef.file);
    if (emoRef.text) params.set("prompt_text", String(emoRef.text).slice(0, 200));
    logTts("gsv", "情绪参考音频: " + path.basename(String(emoRef.file)));
  }
  // 质量门：只查时长碎片（引擎偶发输出 1s 碎片）。
  // 注：不做高频频谱质检——日语摩擦音天然高频，误判率过高（曾导致大量跳句）。
  // 阈值 0.5（2026-09-03 修「播放不完整」③）：原 0.75 会误杀语速偏快的正常句
  // （实测 1900ms<<预期2610ms=0.73 的完整句被重试 3 次+引擎重启后跳句 → 整段缺一句）；
  // 毛刺碎片实测 ≤0.4，0.5 仍能拦截。重试后仍不过门 → 交付最优尝试而非跳句（宁短勿缺）。
  const expectMs = Math.max(400, clean.length * 90);
  const durOk = (b) => {
    const d = wavDurationMs(b);
    return !(d > 0 && clean.length > 6 && d < expectMs * 0.5);
  };
  const endpoint = resolveTtsEndpoint(g, 9880);
  if (!endpoint) return "";
  try {
    const resp = await safeFetch(base + "/?" + params.toString(), { signal: AbortSignal.timeout(60000) }, { allowLoopback: endpoint.loopback });
    if (!resp.ok) {
      logTts("gsv", "HTTP " + resp.status);
      return "";
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length < 100) { logTts("gsv", "返回过短"); return ""; }
    let best = buf;
    if (durOk(buf)) return best.toString("base64");
    const maxAtt = clean.length > 60 ? 2 : 3; // 长句推理本就慢，避免质量门重试 3 次叠加到 12s+
    for (let att = 2; att <= maxAtt; att++) {
      const d0 = wavDurationMs(buf);
      logTts("gsv", `疑似引擎毛刺（时长${Math.round(d0)}ms << 预期${expectMs}ms）→ 第${att}/3次重试`);
      await new Promise((r) => setTimeout(r, 800 * att)); // 退避重试：引擎坏状态连发更容易连环失败
      const resp2 = await safeFetch(base + "/?" + params.toString(), { signal: AbortSignal.timeout(60000) }, { allowLoopback: endpoint.loopback });
      if (!resp2.ok) continue;
      best = Buffer.from(await resp2.arrayBuffer());
      if (best.length >= 100 && durOk(best)) return best.toString("base64");
    }
    // 三连击仍碎片化：引擎整体劣化 → 自动重启一次再合成；防重入避免嵌套互杀
    if (gsvAutoRestarting || gsvWarmingUp) { logTts("gsv", "引擎自愈进行中，跳过该句: " + clean.slice(0, 24)); return ""; }
    gsvAutoRestarting = true;
    try {
      logTts("gsv", "连续3次碎片化 → 自动重启日语引擎...");
      if (gsvDeviceCache === "cuda") gpuMemoryLog(); // CUDA 模式下记录显存占用，辅助定位毛刺根因
      const g2 = config.getConfig().ttsGsv || {};
      const up = await restartGsvEngine(g2);
      if (up) {
        const resp3 = await safeFetch(base + "/?" + params.toString(), { signal: AbortSignal.timeout(180000) }, { allowLoopback: endpoint.loopback });
        if (resp3.ok) {
          const b3 = Buffer.from(await resp3.arrayBuffer());
          if (b3.length >= 100 && durOk(b3)) { logTts("gsv", "引擎重启后恢复正常输出"); return b3.toString("base64"); }
        }
      }
    } catch (e2) {
      logTts("gsv", "自动重启失败: " + (e2 && e2.message || e2));
    } finally {
      gsvAutoRestarting = false;
    }
    // 终败兜底（2026-09-03 修「播放不完整」③）：手里有可用音频就交付最优尝试，
    // 不再跳句——跳句=整段回复缺一句，正是"不能完全播出来"的直接来源。
    if (best && best.length >= 100) {
      logTts("gsv", "质量门未过，交付最优尝试（dur=" + Math.round(wavDurationMs(best)) + "ms/预期" + expectMs + "ms）: " + clean.slice(0, 24));
      return best.toString("base64");
    }
    logTts("gsv", "跳过该句: " + clean.slice(0, 24));
    return "";
  } catch (e) {
    const msg = String(e && e.message || e);
    logTts("gsv", "请求失败: " + msg);
    if (!/fetch failed|ECONNREFUSED|aborted|timeout/i.test(msg)) return ""; // 非连接类错误不走重启
    // 连接被拒/超时：服务器很可能已死或挂死——若只重置缓存等下一句，本句会丢失/变中文音色。
    // 改为当场杀进程→重拉→预热→重试本句一次；60s 节流防止连环崩溃时反复重启。
    if (gsvAutoRestarting || gsvWarmingUp) return "";
    const now = Date.now();
    if (now - gsvCrashRecoveryAt < 60000) {
      logTts("gsv", "引擎崩掉（60s内已自愈过），跳过本句回退中文");
      return "";
    }
    gsvCrashRecoveryAt = now;
    gsvAutoRestarting = true;
    try {
      logTts("gsv", "引擎崩掉 → 当场自动重启并重试本句...");
      const g2 = config.getConfig().ttsGsv || {};
      const up = await restartGsvEngine(g2);
      if (up) {
        const resp2 = await safeFetch(base + "/?" + params.toString(), { signal: AbortSignal.timeout(180000) }, { allowLoopback: endpoint.loopback });
        if (resp2.ok) {
          const b2 = Buffer.from(await resp2.arrayBuffer());
          if (b2.length >= 100 && durOk(b2)) { logTts("gsv", "引擎重启后本句恢复合成"); return b2.toString("base64"); }
        }
      }
    } catch (e2) {
      logTts("gsv", "崩溃自愈失败: " + (e2 && e2.message || e2));
    } finally {
      gsvAutoRestarting = false;
    }
    return "";
  }
}

async function restartGsvEngine(g) {
  const g2 = g || config.getConfig().ttsGsv || {};
  const base = String(g2.server || "").replace(/\/+$/, "");
  let port = 9880;
  try { port = Number(new URL(base).port) || 9880; } catch { /* 默认 */ }
  await killGsvProcesses(g2);
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 700));
    if (!(await portAlive(base))) break;
    if (i >= 3) await killPortListener(port, g2.serverScript); // 迟迟不退则按端口强杀残留（P1-7：杀前校验身份）
  }
  gsvServerChecked = false;
  gsvServerUp = false;
  const up = await ensureGsvServer(g2);
  if (up) await warmupGsv(g2); // 烧机吸收冷启动毛刺
  return up;
}

async function killGsvProcesses(g) {
  let port = "";
  try { port = String(new URL(String(g.server || "")).port || ""); } catch { /* 保持空 */ }
  const conds = [];
  const pat = String(g.serverScript || "").replace(/'/g, "''");
  if (pat) conds.push("$_.CommandLine -like '*" + pat + "*'");
  const script = String(g.serverScript || "").toLowerCase();
  if (port && script.endsWith("api.py")) {
    conds.push("($_.CommandLine -like '*api.py*' -and $_.CommandLine -like '*-p " + port + "*')");
  }
  if (!conds.length) return;
  const out = await runPowerShell(
    "Get-CimInstance Win32_Process -Filter \"Name='python.exe' or Name='pythonw.exe'\" | " +
    "Where-Object { " + conds.join(" -or ") + " } | " +
    "ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Output $_.ProcessId }");
  if (out) logTts("gsv", "已结束旧进程 PID: " + out.replace(/\s+/g, ","));
}

/**
 * 强杀监听指定端口的残留进程（GSV 重启兜底）——v2.5.23 修复（P1-7）：
 * 杀前校验进程身份——进程名必须 python 系（GSV 语音服务）且命令行含 serverScript
 * 特征（默认 api.py），杜绝误杀同端口被其他程序占用（9880/9881 常被别的服务占用）。
 * hint = serverScript 路径特征（可选）。
 */
function killPortListener(port, hint) {
  return new Promise((resolve) => {
    exec("netstat -ano -p tcp", { windowsHide: true, timeout: 10000 }, (err, stdout) => {
      if (err) return resolve(false);
      const pids = [];
      for (const ln of String(stdout || "").split(/\r?\n/)) {
        const m = ln.match(new RegExp(":" + port + "\\s+\\S+\\s+LISTENING\\s+(\\d+)"));
        if (m && Number(m[1]) > 0) pids.push(Number(m[1]));
      }
      if (!pids.length) return resolve(false);
      const pat = String(hint || "api.py").replace(/'/g, "''");
      const conds = pids.map((pid) => "$_.ProcessId -eq " + pid).join(" -or ");
      runPowerShell(
        "Get-CimInstance Win32_Process -Filter \"Name='python.exe' or Name='pythonw.exe'\" | " +
        "Where-Object { (" + conds + ") -and $_.CommandLine -like '*" + pat + "*' } | " +
        "ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Output $_.ProcessId }"
      ).then((out) => {
        if (out) logTts("gsv", "强杀残留 PID: " + out.replace(/\s+/g, ","));
        resolve(!!out);
      });
    });
  });
}

async function portAlive(base) {
  try {
    const endpoint = resolveTtsEndpoint({ server: base, allowRemote: true, autoStart: false }, 9880);
    if (!endpoint) return false;
    const r = await safeFetch(base + "/set_model", { signal: AbortSignal.timeout(1500) }, { allowLoopback: endpoint.loopback });
    return r.status === 400 || r.ok; // 与 ensureGsvServer 相同的在线判定
  } catch { return false; }
}

function gpuMemoryLog() {
  execFile("nvidia-smi", ["--query-gpu=memory.used,memory.total", "--format=csv,noheader,nounits"],
    { windowsHide: true, timeout: 5000 },
    (err, stdout) => {
      if (err) return;
      const [u, t] = String(stdout || "").split(",").map((s) => parseInt(s, 10));
      if (Number.isFinite(u) && Number.isFinite(t)) {
        const free = t - u;
        logTts("gsv", `显卡显存: ${u}/${t} MiB 已用` +
          (free < 1500 ? "（空闲不足 1.5GB——显存紧张可能引发输出毛刺，建议关闭占显存的程序）" : ""));
      }
    });
}

async function detectGsvDevice() { // 用户未配置 device 时自动选择：有 NVIDIA 卡→CUDA，否则 CPU
  if (gsvDeviceCache) return gsvDeviceCache;
  const has = await new Promise((resolve) => {
    execFile("nvidia-smi", ["-L"], { windowsHide: true, timeout: 5000 },
      (err, stdout) => resolve(!err && /GPU/i.test(String(stdout || ""))));
  });
  gsvDeviceCache = has ? "cuda" : "cpu";
  if (has) {
    logTts("gsv", "检测到 NVIDIA 显卡 → 引擎使用 CUDA");
    gpuMemoryLog();
  } else {
    logTts("gsv", "未检测到 NVIDIA 显卡 → 引擎使用 CPU");
  }
  return gsvDeviceCache;
}

function warmupGsv(g) {
  if (gsvWarmupPromise) return gsvWarmupPromise;
  if (gsvAutoRestarting) return Promise.resolve(false);
  gsvWarmingUp = true;
  gsvWarmupPromise = (async () => {
    try {
      const b64 = await gsvTtsJa(g, "テスト、おはようございます");
      logTts("gsv", b64 ? "预热完成" : "预热输出异常，暂时回退中文语音");
      return !!b64;
    } finally {
      gsvWarmingUp = false;
    }
  })().finally(() => { gsvWarmupPromise = null; });
  return gsvWarmupPromise;
}

function sanitizeJaText(t) {
  return String(t || "")
    .replace(/[～〜]/g, "ー")
    .replace(/[-—]{2,}/g, "、")
    .replace(/[“”„«»「」『』【】（）()【】]/g, "")
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 剥渲染层 emotionizeText 注入的句尾情绪语气词（renderer EMOTION_SPEECH 值集合）——
 *  剥后才能与日语预热键对齐命中磁盘翻译缓存。只剥句尾一处，正文里的同形字不动。 */
const SPEECH_TAIL_RE = /[呀哇哼呜嗯嘛](?:[！!。．…~～\s]*)$/;
function stripSpeechTail(t) {
  return String(t || "").replace(SPEECH_TAIL_RE, "").trim();
}

function splitJaSentences(text) {
  const speakable = (s) => /[\u3040-\u30FF\u4E00-\u9FFFa-zA-Z0-9]/.test(s);
  const parts = String(text || "").split(/(?<=[。！？…\n])/).map((s) => s.trim()).filter(speakable);
  if (!parts.length) parts.push(String(text || "").trim());
  if (parts.length <= 10) return parts;
  const head = parts.slice(0, 9);
  head.push(parts.slice(9).join(""));
  return head;
}

function mergeWavBase64(list) {
  try {
    const datas = [];
    let fmt = null;
    let sampleRate = 32000, channels = 1;
    for (const b64 of list) {
      const buf = Buffer.from(b64, "base64");
      if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF") continue;
      let off = 12;
      while (off + 8 <= buf.length) {
        const id = buf.toString("ascii", off, off + 4);
        const size = Math.min(buf.readUInt32LE(off + 4), buf.length - off - 8);
        if (id === "fmt " && !fmt) {
          fmt = Buffer.from(buf.subarray(off + 8, off + 8 + size));
          if (fmt.length >= 16) { channels = fmt.readUInt16LE(2) || 1; sampleRate = fmt.readUInt32LE(4) || 32000; }
        }
        if (id === "data") { datas.push(buf.subarray(off + 8, off + 8 + size)); break; }
        off += 8 + size + (size % 2);
      }
    }
    if (!datas.length || !fmt || fmt.length < 16) return null;
    // 段间插入随机停顿（自然换句感），最后一段后不加
    const trimmed = [];
    datas.forEach((d, i) => {
      const seg = Buffer.from(trimPcmSilence(d, sampleRate, channels, 16)); // 拷贝为可写
      // 裁剪切口不在零交叉点会产生咔哒爆音：段首尾各做 10ms 淡入淡出消除
      const frame = channels * 2;
      const fade = Math.max(1, Math.min(Math.ceil((sampleRate * 0.01)), Math.floor(seg.length / frame / 2)));
      for (let i = 0; i < fade; i++) {
        const g = i / fade;
        for (let c = 0; c < channels; c++) {
          const oh = i * frame + c * 2;
          seg.writeInt16LE(Math.round(seg.readInt16LE(oh) * g), oh);
          const ot = seg.length - (i + 1) * frame + c * 2;
          seg.writeInt16LE(Math.round(seg.readInt16LE(ot) * g), ot);
        }
      }
      trimmed.push(seg);
      if (i < datas.length - 1) {
        // 句间停顿长度必须按 16bit 采样帧（frame 字节）取整：若为奇数字节，
        // 其后所有样本高低字节错位 → 从该句起整段电音杂讯（单句不插停顿故从无杂音）
        const silFrames = Math.ceil(sampleRate * (0.22 + Math.random() * 0.08)); // 句间停顿 220~300ms（断句更清晰）
        trimmed.push(Buffer.alloc(silFrames * frame));
      }
    });
    const pcm = Buffer.concat(trimmed);
    // 抑制引擎偶发的 sr/4（32k 时即 8kHz）窄带啸叫：双二阶陷波滤波器，Q=6 只挖 7.5~8.5kHz，
    // 语音基元与摩擦音几乎不受影响；无啸叫时该频段本就近似无声，处理无副作用
    if (sampleRate >= 16000) {
      const w0 = 2 * Math.PI * (sampleRate / 4) / sampleRate;
      const alpha = Math.sin(w0) / (2 * 6);
      const a0 = 1 + alpha;
      const b0n = 1 / a0, b1n = (-2 * Math.cos(w0)) / a0, b2n = 1 / a0;
      const a1n = (-2 * Math.cos(w0)) / a0, a2n = (1 - alpha) / a0;
      const frameN = channels * 2;
      const total = Math.floor(pcm.length / frameN);
      const x1 = new Float64Array(channels), x2 = new Float64Array(channels);
      const y1 = new Float64Array(channels), y2 = new Float64Array(channels);
      for (let i = 0; i < total; i++) {
        for (let c = 0; c < channels; c++) {
          const o = i * frameN + c * 2;
          const x0 = pcm.readInt16LE(o);
          const y0 = b0n * x0 + b1n * x1[c] + b2n * x2[c] - a1n * y1[c] - a2n * y2[c];
          x2[c] = x1[c]; x1[c] = x0;
          y2[c] = y1[c]; y1[c] = y0;
          pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(y0))), o);
        }
      }
    }
    const out = Buffer.alloc(44 + pcm.length);
    out.write("RIFF", 0, "ascii"); out.write("WAVE", 8, "ascii");
    out.writeUInt32LE(36 + pcm.length, 4);
    out.write("fmt ", 12, "ascii"); out.writeUInt32LE(16, 16);
    fmt.copy(out, 20, 0, 16);
    out.write("data", 36, "ascii"); out.writeUInt32LE(pcm.length, 40);
    pcm.copy(out, 44);
    return out.toString("base64");
  } catch (e) {
    logTts("gsv", "合并失败: " + (e && e.message || e));
    return null;
  }
}

function runPythonWithTimeout(args, options, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const child = spawn("python", args, { windowsHide: true, ...options });
    child.on("error", (e) => finish(reject, new Error(label + " 启动失败: " + (e && e.message || e))));
    let settled = false, err = "";
    const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); fn(value); };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 忽略 */ }
      finish(reject, new Error(label + " 超时"));
    }, timeoutMs);
    child.stderr?.on("data", (d) => { err += d; });
    child.on("error", (e) => finish(reject, e));
    child.on("close", (code) => code === 0 ? finish(resolve) : finish(reject, new Error(label + " 退出 " + code + ": " + err.slice(-300))));
  });
}

/** 临时文件路径守卫（Mimosa 高危：路径穿越）：与 fixed-line-cache.insideRoot 同款——
 *  resolve 后必须仍落在目标目录内，越界直接抛错。 */
function insideDir(dir, name) {
  const root = path.resolve(dir);
  const target = path.resolve(root, name);
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error("临时文件路径越界");
  return target;
}

async function cosyTts(cosy, clean) {
  // 临时文件名：crypto 随机 + 正则白名单校验（Mimosa 高危：路径穿越），不合法直接拒绝
  const tag = Date.now() + "-" + crypto.randomBytes(6).toString("hex");
  if (!/^[0-9a-z-]{5,40}$/.test(tag)) throw new Error("cosyTts: 非法临时文件名");
  fs.mkdirSync(config.STORAGE.audio, { recursive: true });
  const reqFile = insideDir(config.STORAGE.audio, "tts_cosy_req_" + tag + ".json");
  const outFile = insideDir(config.STORAGE.audio, "tts_cosy_" + tag + ".mp3");
  try {
    fs.writeFileSync(reqFile, JSON.stringify({
      model: cosy.model || "cosyvoice-v3.5-plus",
      voice: cosy.voice,
      text: clean,
      out: outFile,
      rate: cosy.rate,
      pitch: cosy.pitch,
      volume: cosy.volume
    }));
    await runPythonWithTimeout([path.join(config.APP_DIR, "scripts", "cosy_tts.py"), reqFile], { env: { ...process.env, DASHSCOPE_API_KEY: cosy.apiKey } }, 120000, "CosyVoice");
    const buf = fs.readFileSync(outFile);
    return buf.length >= 100 ? buf.toString("base64") : "";
  } catch (e) {
    logTts("cosy", "fail: " + (e && e.message || e));
    return "";
  } finally {
    try { fs.unlinkSync(reqFile); } catch { /* 忽略 */ }
    try { fs.unlinkSync(outFile); } catch { /* 忽略 */ }
  }
}

async function edgeTts(c, clean) {
  fs.mkdirSync(config.STORAGE.audio, { recursive: true });
  const tmp = path.join(config.STORAGE.audio, "tts_edge_" + Date.now() + "-" + Math.random().toString(36).slice(2, 8) + ".mp3");
  try {
    const args = ["-m", "edge_tts", "--voice", c.voice || "zh-CN-XiaoxiaoNeural",
                  "--text", clean, "--write-media", tmp];
    if (c.rate) args.push("--rate=" + c.rate);
    if (c.pitch) args.push("--pitch=" + c.pitch);
    await runPythonWithTimeout(args, {}, 120000, "edge-tts");
    const buf = fs.readFileSync(tmp);
    return buf.length >= 100 ? buf.toString("base64") : "";
  } catch (e) {
    logTts("edge", "fail: " + (e && e.message || e));
    return "";
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }
  }
}

let ttsJobSeq = 0;      // 合成任务代号：新消息到来→旧任务失效（消息生成防抖，避免合成堆叠吃不消）
function queueTts(text, opts) {
  const myId = ++ttsJobSeq;
  const task = ttsQueue.then(async () => {
    if (myId !== ttsJobSeq) { // 排队期间已被更新的消息让位：不再合成（渲染层会丢弃其会话结果）
      logTts("route", "合成任务让位新消息（防抖）: " + String(text || "").slice(0, 20));
      return "";
    }
    return ttsCloneImpl(text, opts, myId);
  });
  ttsQueue = task.then(() => {}, () => {}); // 单次失败不中断后续排队
  return task;
}

/** 情绪参考音频表（APP_DIR/voice-refs.json）：{ "撒娇": {"file":"voice-ref/xx.wav","text":"日语原文"} }
 *  红线（v2.5.4）：默认合成绝不带参考音频；仅当渲染层标记了情绪且该情绪有参考时才切换（检测到才用，否则不动）。 */
let voiceRefsCache = null;
function voiceRefs() {
  if (voiceRefsCache) return voiceRefsCache;
  voiceRefsCache = {};
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(config.APP_DIR, "voice-refs.json"), "utf8"));
    for (const k of Object.keys(raw)) {
      const e = raw[k];
      if (e && e.file) voiceRefsCache[k] = {
        file: path.isAbsolute(e.file) ? e.file : path.join(config.APP_DIR, e.file),
        text: String(e.text || "")
      };
    }
  } catch { /* 无情绪参考表 → 全部默认不带参考 */ }
  return voiceRefsCache;
}
/** 情绪词归一化 → 参考音频键（v2.6）：模型情绪词可能是 label（傲娇）或 name（tsundere/surprised）或近义词（惊喜/震惊），统一映射到各档。 */
const EMO_REF_ALIAS = {
  "撒娇": "撒娇", "娇": "撒娇", "娇羞": "撒娇", "coquetry": "撒娇", "coquette": "撒娇",
  "傲娇": "傲娇", "tsundere": "傲娇", "别扭": "傲娇",
  "惊讶": "惊讶", "surprised": "惊讶",
  "开心": "开心", "高兴": "开心", "快乐": "开心", "喜悦": "开心", "雀跃": "开心", "happy": "开心", "joy": "开心", "glad": "开心",
  "温柔": "温柔", "温和": "温柔", "轻柔": "温柔", "温软": "温柔", "tender": "温柔", "gentle": "温柔", "soft": "温柔",
};
function normEmotion(emotion) {
  const s = String(emotion || "").trim().toLowerCase();
  if (!s) return "";
  if (EMO_REF_ALIAS[s]) return EMO_REF_ALIAS[s];
  if (s.includes("撒娇") || s.includes("coquetry")) return "撒娇";
  if (s.includes("傲娇") || s.includes("tsundere")) return "傲娇";
  if (s.includes("惊讶") || s.includes("吃惊") || s.includes("震惊") || s.includes("惊喜")
      || s.includes("surprised") || s.includes("surprise") || s.includes("wow")) return "惊讶";
  if (s.includes("开心") || s.includes("高兴") || s.includes("快乐") || s.includes("喜悦")
      || s.includes("happy") || s.includes("joy") || s.includes("glad")) return "开心";
  if (s.includes("温柔") || s.includes("温和") || s.includes("轻柔") || s.includes("tender")
      || s.includes("gentle") || s.includes("soft")) return "温柔";
  return "";
}
function emotionGsvRef(emotion) {
  const key = normEmotion(emotion);
  if (!key) return null;
  if ((config.getConfig().emotionVoice || {})[key] === false) return null; // 分档停用（设置页开关）：该档音色用默认
  const r = voiceRefs()[key];
  if (!r || !fs.existsSync(r.file)) return null;
  return r;
}

function trimPcmSilence(pcm, sampleRate, channels, bits, headPadMs = 90, tailPadMs = 260) {
  try {
    if (bits !== 16 || !sampleRate || !channels) return pcm;
    const frame = channels * 2;
    const n = Math.floor(pcm.length / frame);
    if (n < 1) return pcm;
    // 按人声电平回溯裁剪：引擎偶发在句尾输出白噪嘶声（广播调频感），其电平
    // 高于普通静音阈值会被误保留。从两端向内找最后一个「明显人声」帧
    // （窗口 RMS ≥ -31dB），之外的全部丢弃——无论残余噪声多响。
    const hop = Math.max(1, Math.floor(sampleRate * 0.01));
    const win = Math.max(hop, Math.floor(sampleRate * 0.02));
    const VOICE = 900; // 窗口 RMS ≈ -31dB，明确的人声电平
    let firstVoice = -1, lastVoice = -1;
    for (let i = 0; i + win <= n; i += hop) {
      let s = 0;
      for (let j = 0; j < win; j++) {
        for (let c = 0; c < channels; c++) { const v = pcm.readInt16LE((i + j) * frame + c * 2); s += v * v; }
      }
      const rms = Math.sqrt(s / (win * channels));
      if (rms >= VOICE) { if (firstVoice < 0) firstVoice = i; lastVoice = i + win - 1; }
    }
    if (firstVoice < 0) return pcm.subarray(0, Math.min(pcm.length, frame * win)); // 全程无人声：只留开头防空音频
    const start = Math.max(0, firstVoice - Math.ceil((headPadMs / 1000) * sampleRate));
    const end = Math.min(n - 1, lastVoice + Math.ceil((tailPadMs / 1000) * sampleRate));
    return pcm.subarray(start * frame, (end + 1) * frame);
  } catch { return pcm; }
}

/** 情绪音色试听（v2.6）：按情绪键合成一段参考台词（真实 GSV 日语链路 + 参考音频），供设置页试听选型 */
async function emotionAudition(key) {
  applyBundledVoice();
  const g = config.getConfig().ttsGsv || {};
  if (!g.enabled) return { ok: false, message: "GSV 日语语音未启用（语音设置里开启日语模式并保存）" };
  if (!(config.getConfig().ttsGenie || {}).speakJa) return { ok: false, message: "日语语音模式（speakJa）未开启" };
  const up = await ensureGsvServer(g);
  if (!up) return { ok: false, message: "GSV 服务器不可用（可稍后重试，或在语音设置重启日语语音服务）" };
  let ref = null;
  let text = "";
  if (key === "__default__") {
    text = "博士、ちょっと話があるんだけど、いい？"; // 默认音色对照句
  } else {
    ref = emotionGsvRef(key);
    if (!ref) return { ok: false, message: "该情绪没有参考音频：\"" + key + "\"" };
    text = ref.text;
  }
  const sents = splitJaSentences(sanitizeJaText(text));
  const parts = [];
  for (const s of sents) {
    const b64 = await gsvTtsJa(g, s, ref);
    if (b64) parts.push(b64);
  }
  if (!parts.length) return { ok: false, message: "合成失败（GSV 服务输出为空）" };
  const merged = mergeWavBase64(parts);
  if (!merged) return { ok: false, message: "合成结果合并失败" };
  return { ok: true, b64: merged };
}

applyBundledVoice(); // 模块加载即回填随包声音源（首启生效；引擎 python/serverScript 仍由用户配置）

module.exports = {
  setPartSender, setJaFallbackCb,
  ttsCloneImpl, queueTts, ensureGenieServer, ensureGsvServer, restartGsvEngine,
  shutdownGenieServer, genieTts, gsvTtsJa, warmupGsv, resetGenieServer, killGsvProcesses, portAlive, killPortListener,
  emotionAudition, missingEnginePath, stripSpeechTail, FIXED_ONLY_MISS
};
