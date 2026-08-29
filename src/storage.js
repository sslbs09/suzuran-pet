"use strict";

const fs = require("fs");
const path = require("path");
const { app } = require("electron");

const APP_DIR = path.dirname(__dirname);
// SUZURAN_TEST_USERDIR：仅供自动化测试重定向 userData；正常运行永远走 Electron userData
const USER_DIR = process.env.SUZURAN_TEST_USERDIR ||
  (app ? app.getPath("userData") : path.join(process.env.APPDATA || APP_DIR, "SuzuranPet"));
const PATHS = {
  userDir: USER_DIR,
  config: path.join(USER_DIR, "config.json"),
  persona: path.join(USER_DIR, "persona.md"),
  personaDefault: path.join(APP_DIR, "persona.default.md"),
  history: path.join(USER_DIR, "history", "history.jsonl"),
  logs: path.join(USER_DIR, "logs"),
  audio: path.join(USER_DIR, "audio"),
  spritesUser: path.join(USER_DIR, "assets", "sprites", "user"),
  spritesDefault: path.join(USER_DIR, "assets", "sprites", "default"),
  fontsUser: path.join(USER_DIR, "assets", "fonts", "user"),
  spineUser: path.join(USER_DIR, "assets", "spine", "user"),
  psdExport: path.join(USER_DIR, "assets", "psd-export"), // PSD 角色工具导出目录（v2.1）
  rigUser: path.join(USER_DIR, "assets", "rig", "user"), // PSD 2.5D 角色皮肤目录（v2.2）
  secrets: path.join(USER_DIR, "secrets.v1.json"),
  marker: path.join(USER_DIR, ".storage-migration-v1.json")
};

function copyDirRecursive(src, dst) { // asar 兼容递归复制：fs.cpSync 对 asar 源静默失败（§14 追加 112），手写用被补丁覆盖的 API
  fs.mkdirSync(dst, { recursive: true });
  for (const item of fs.readdirSync(src)) {
    const s = path.join(src, item), d = path.join(dst, item);
    if (fs.statSync(s).isDirectory()) copyDirRecursive(s, d);
    else fs.copyFileSync(s, d);
  }
}
function copyIfMissing(from, to, migrated) {
  if (!fs.existsSync(from) || fs.existsSync(to)) return;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    copyDirRecursive(from, to);
  } catch (e) {
    if (fs.existsSync(from) && !fs.existsSync(to)) throw e; // 真失败才上抛
  }
  migrated.push(path.relative(APP_DIR, from));
}

function initializeStorage() {
  fs.mkdirSync(PATHS.userDir, { recursive: true });
  if (fs.existsSync(PATHS.marker)) return PATHS;
  const migrated = [], failed = [];
  const pairs = [
    [path.join(APP_DIR, "config.json"), PATHS.config],
    [path.join(APP_DIR, "persona.md"), PATHS.persona],
    [path.join(APP_DIR, "data", "history.jsonl"), PATHS.history],
    [path.join(APP_DIR, "data", "tts.log"), path.join(PATHS.logs, "tts.log")],
    [path.join(APP_DIR, "data", "tts_last.wav"), path.join(PATHS.audio, "tts_last.wav")],
    [path.join(APP_DIR, "renderer", "sprites", "user"), PATHS.spritesUser],
    [path.join(APP_DIR, "renderer", "sprites", "default"), PATHS.spritesDefault],
    [path.join(APP_DIR, "renderer", "fonts", "user"), PATHS.fontsUser],
    [path.join(APP_DIR, "renderer", "spine", "user"), PATHS.spineUser]
  ];
  for (const [from, to] of pairs) {
    try { copyIfMissing(from, to, migrated); } catch (e) { failed.push({ from, message: e.message }); }
  }
  fs.writeFileSync(PATHS.marker, JSON.stringify({ version: 1, at: new Date().toISOString(), migrated, failed }, null, 2), "utf8");
  // §14 追加 94：首启迁移强制 agreed=false——安装根 config.json 模板常携带开发者/曾使用者的
  // 同意状态（宿主已同意过），全新用户不能因此跳过《使用条款》弹窗（合规）。迁移标记已写，
  // 仅本次生效；已存在的用户（标记在）不受影响。
  try {
    const cfgPath = PATHS.config;
    if (cfgPath && fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      if (cfg && cfg.agreed) {
        cfg.agreed = false;
        fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), "utf8"); // Node utf8 写回无 BOM
      }
    }
  } catch { /* 迁移期配置修正失败不影响启动 */ }
  return PATHS;
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, file);
}

module.exports = { APP_DIR, PATHS, initializeStorage, atomicWrite };
