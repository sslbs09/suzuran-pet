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
  secrets: path.join(USER_DIR, "secrets.v1.json"),
  marker: path.join(USER_DIR, ".storage-migration-v1.json")
};

function copyIfMissing(from, to, migrated) {
  if (!fs.existsSync(from) || fs.existsSync(to)) return;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true, force: false, dereference: false });
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
  return PATHS;
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, file);
}

module.exports = { APP_DIR, PATHS, initializeStorage, atomicWrite };
