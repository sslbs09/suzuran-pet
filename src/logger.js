"use strict";
const fs = require("fs");
const path = require("path");
const config = require("./config");

/**
 * 运行日志：写 userData/logs/tts.log，2 MiB 轮转为 .1。
 * 事件前缀约定：[walk]/[render]/[ja]/[genie]/[gsv]/[security]/[startup]/[settings] 等。
 * 中文在 PowerShell 控制台读会乱码是 shell 编码问题，文件本身 UTF-8 无损。
 */
function logTts(event, msg) {
  try {
    const file = path.join(config.STORAGE.logs, "tts.log");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > 2 * 1024 * 1024) {
      const prev = file + ".1";
      try { fs.unlinkSync(prev); } catch { /* 忽略 */ }
      fs.renameSync(file, prev);
    }
    fs.appendFileSync(file, new Date().toISOString() + " [" + event + "] " + msg + "\n");
  } catch { /* 日志失败不影响主流程 */ }
}

module.exports = { logTts };
