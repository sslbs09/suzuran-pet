"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const storage = require("./storage");

/**
 * 蜜标 + 文件防御监控（honeytoken + tamper/worm/ransom 检测）。
 * 普通权限下无法拿"进程名"（ETW 需管理员），但可检测：被读取/被修改/异常新文件/批量变化。
 * 功能：
 *  1. 蜜标文件 atime+mtime 监控（stealer 窃密 / ransom 加密触发）
 *  2. config/secrets 哈希校验（tamper 篡改触发——config.js saveConfig 时通知豁免自写）
 *  3. userData 目录异常新文件监控（worm 复制触发，fs.watch）
 *  4. 批量敏感文件变化检测（ransom 批量加密触发）
 */
const HONEY_FILES = ["_honeytoken_credentials.json", "_honeytoken_config_backup.json"];
const WATCH_DIRS = ["", "config", "assets"]; // userData 子目录（"" = 根）
const SUSPICIOUS_EXT = [".py", ".exe", ".dll", ".enc", ".bat", ".vbs", ".ps1", ".js", ".scr", ".jar", ".hta", ".lnk"];
const WATCH_JSON = ["config.json", "secrets.v1.json", "schedules.json"];

let timer = null;
let dirWatchers = [];
let enabled = false;
let onAlert = null; // (type, fileName, detail) => void
let lastAtime = {};
let configHash = null;     // 桌宠已知的 config 哈希（saveConfig 后更新）
let fileMtime = {};        // 敏感文件 mtime 基线（批量变化检测）
let changeWindow = [];     // 短时间变化时间戳

function hashFile(p) {
  try { return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"); } catch { return null; }
}

function statTimes(p) {
  try { const s = fs.statSync(p); return { at: s.atimeMs, mt: s.mtimeMs }; } catch { return null; }
}

function ensureHoneyFiles() {
  try {
    for (const name of HONEY_FILES) {
      const p = path.join(storage.PATHS.userDir, name);
      if (!fs.existsSync(p)) {
        const fake = name.includes("credentials")
          ? { version: 1, chatApiKey: "honeytoken-dummy-key-do-not-use", ttsCosyApiKey: "hk-cosy-dummy", agentBearerToken: "hk-agent-dummy" }
          : { chat: { baseUrl: "https://example.invalid/v1", model: "dummy" }, note: "honeytoken" };
        fs.writeFileSync(p, JSON.stringify(fake, null, 2));
      }
      lastAtime[name] = statTimes(p);
    }
  } catch { /* 忽略 */ }
}

let lastCleanConfig = null; // 桌宠最近一次保存的干净 config 内容（用于篡改后自动恢复）
/** config.js saveConfig 后调用：记录桌宠自写状态，避免误报篡改 */
function noteConfigWritten() {
  const p = path.join(storage.PATHS.userDir, "config.json");
  configHash = hashFile(p);
  try { lastCleanConfig = fs.readFileSync(p, "utf8"); } catch { /* 忽略 */ }
}

const lastAlertAt = {};
function alert(type, fileName, detail) {
  const now = Date.now();
  changeWindow.push(now);
  // 限频：30s 内同类型只报一次（fs.watch 事件可能多次触发，避免噪音）
  if (now - (lastAlertAt[type] || 0) < 30000) return;
  lastAlertAt[type] = now;
  if (onAlert) onAlert(type, fileName, detail);
}

function check() {
  if (!enabled) return;

  // 1. 蜜标 atime/mtime 监控（读或改都触发）
  for (const name of HONEY_FILES) {
    const p = path.join(storage.PATHS.userDir, name);
    const t = statTimes(p);
    const base = lastAtime[name];
    if (base && t && (t.at > base.at + 500 || t.mt > base.mt + 500)) {
      lastAtime[name] = t;
      alert("honey", name, "被其他程序访问（读取或修改）");
    } else if (!base) lastAtime[name] = t;
  }

  // 2. config 哈希校验（外部篡改——3s 轮询立即阻断恢复，不等保存）
  const cfgPath = path.join(storage.PATHS.userDir, "config.json");
  const now = hashFile(cfgPath);
  if (configHash && now && now !== configHash) {
    const restored = restoreCleanConfig(cfgPath);
    alert("tamper", "config.json", restored
      ? "检测到配置被外部程序篡改，已自动恢复干净版本（篡改内容备份为 config.json.tampered，请检查）"
      : "检测到配置被外部程序篡改（已备份为 config.json.tampered，无法自动恢复）");
  }

  // 3. 敏感文件批量变化（勒索特征：30s 内 ≥5 次变化）
  if (changeWindow.length > 8 && Date.now() - changeWindow[0] < 30000) {
    changeWindow = [];
    alert("ransom", "userData", "检测到异常批量文件操作（疑似勒索加密）");
  }
}

function onDirEvent(dir, event, fileName) {
  if (!enabled || !fileName) return;
  // 符号链接/目录联接检测（重定向攻击：junction/symlink 无需管理员即可创建）
  try {
    const full = path.join(storage.PATHS.userDir, String(fileName));
    const st = fs.lstatSync(full);
    if (st.isSymbolicLink()) {
      alert("worm", String(fileName), "发现可疑符号链接/目录联接（可能为重定向攻击）");
      return;
    }
  } catch { /* 不存在则跳过 */ }
  const ext = path.extname(String(fileName)).toLowerCase();
  if (SUSPICIOUS_EXT.includes(ext)) {
    alert("worm", fileName, "用户数据目录出现可疑新文件（可能为恶意程序）");
  }
  // 敏感 json 被改（非桌宠写入路径）
  const base = path.basename(String(fileName));
  if (WATCH_JSON.includes(base) && dir === "") {
    // config 走哈希校验；secrets/schedules 走 mtime 基线
    const p = path.join(storage.PATHS.userDir, base);
    const mt = statTimes(p);
    const prev = fileMtime[base];
    if (prev && mt && mt.mt > prev.mt + 800) {
      fileMtime[base] = mt;
      if (base === "secrets.v1.json") alert("tamper", base, "密钥存储文件被外部修改");
      else if (base === "schedules.json") alert("tamper", base, "日程数据被外部修改");
    } else if (!prev) fileMtime[base] = mt;
  }
}

function start(cb) {
  if (enabled) return;
  enabled = true;
  onAlert = cb || onAlert;
  ensureHoneyFiles();
  const cfgP = path.join(storage.PATHS.userDir, "config.json");
  configHash = hashFile(cfgP);
  try { lastCleanConfig = fs.readFileSync(cfgP, "utf8"); } catch { /* 忽略 */ } // 启动时的 config 作为干净基线（阻断恢复用）
  for (const f of WATCH_JSON) fileMtime[f] = statTimes(path.join(storage.PATHS.userDir, f));
  // userData 目录 fs.watch（异常新文件）
  try {
    const root = storage.PATHS.userDir;
    const w = fs.watch(root, { recursive: true }, (ev, fn) => onDirEvent("", ev, fn));
    dirWatchers.push(w);
  } catch { /* recursive 不可用则跳过 */ }
  if (timer) clearInterval(timer);
  timer = setInterval(check, 3000);
  check();
}

function stop() {
  enabled = false;
  if (timer) { clearInterval(timer); timer = null; }
  for (const w of dirWatchers) { try { w.close(); } catch { /* 忽略 */ } }
  dirWatchers = [];
}

/** 阻断：备份篡改证据 + 自动恢复桌宠上次保存的干净配置；返回是否恢复成功 */
function restoreCleanConfig(p) {
  try { fs.copyFileSync(p, p + ".tampered"); } catch { /* 忽略 */ }
  let restored = false;
  if (lastCleanConfig) {
    try { fs.writeFileSync(p, lastCleanConfig); restored = true; } catch { /* 忽略 */ }
  }
  configHash = hashFile(p);
  return restored;
}

/** config.js saveConfig 写回前调用：检测磁盘 config 是否被外部程序改过（避免桌宠自身保存掩盖篡改） */
function checkBeforeWrite() {
  if (!enabled) return false;
  const p = path.join(storage.PATHS.userDir, "config.json");
  const now = hashFile(p);
  if (configHash && now && now !== configHash) {
    const restored = restoreCleanConfig(p);
    alert("tamper", "config.json", restored
      ? "检测到配置被外部程序篡改，已自动恢复干净版本（篡改内容备份为 config.json.tampered，请检查）"
      : "检测到配置被外部程序篡改（已备份为 config.json.tampered，无法自动恢复）");
    return true;
  }
  return false;
}

module.exports = { start, stop, noteConfigWritten, checkBeforeWrite, isEnabled: () => enabled, HONEY_FILES };
