"use strict";
const { execFile } = require("child_process");

/** 通用纯函数工具（模块化第三步）：无依赖、无状态，可独立测试。 */
const randInt = (a, b) => Math.floor(a + Math.random() * (b - a + 1));

/** 运行 PowerShell 命令并返回 stdout（失败返回空串）。桌面图标枚举/GSV 进程清理共用。 */
function runPowerShell(ps) {
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-Command", ps],
      { windowsHide: true, timeout: 15000 },
      (err, stdout) => resolve(err ? "" : String(stdout || "").trim()));
  });
}

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

/** 快进-停留-快退 冲击曲线（ottopet effects 启发）：冲出→滞空→落地，单调 0→1，用于跳跃/惊吓类 */
function easeImpact(t) {
  t = Math.max(0, Math.min(1, Number(t) || 0));
  if (t < 0.25) { const u = t / 0.25; return 0.9 * (1 - (1 - u) * (1 - u)); }
  if (t < 0.6) return 0.9;
  const u = (t - 0.6) / 0.4;
  return 0.9 + 0.1 * u * u;
}
function easeOutCubic(t) {
  const n = Math.max(0, Math.min(1, t));
  return 1 - Math.pow(1 - n, 3);
}

/** 桌宠窗口缩放档位：0.6~2.0（设置页/托盘共用） */
function clampScale(s) {
  return Math.max(0.6, Math.min(2.0, parseFloat(s) || 1.0));
}

/** 剥离台词里的（动作/舞台指示）——气泡显示保留，TTS 念白不读（v2.5.26：
 *  此前 sanitizeJaText 只删括号不删内容，「（眯起眼睛）摸头」会被念成「眯起眼睛摸头」）。
 *  同时剥行首【情绪】细标（v2.5.26b）：标记只给主进程选音色用，念白/翻译都不该带。 */
function stripStage(t) {
  return String(t || "")
    .replace(/^【(撒娇|傲娇|惊讶|开心|温柔)】/, "")
    .replace(/[（(][^（）()]*[）)]/g, "")
    .replace(/^[、。．，,!！?？…~～\s]+/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

module.exports = { randInt, clamp, easeOutCubic, easeImpact, clampScale, stripStage, runPowerShell };
