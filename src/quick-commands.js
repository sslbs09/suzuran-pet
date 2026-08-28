"use strict";
/**
 * 快捷命令（2026-08-27 从 main.js handleAskInner 拆出）：日程提醒 / 番茄钟 / 系统状态。
 * 纯文本规则 + 注入依赖（features、notify 通知回调），可单测、不碰 Electron。
 *
 * 用法：
 *   const r = tryQuickCommand(clean, { features, notify: (msg) => sendProactive(msg, "happy", { force: true }) });
 *   if (r) { sender.send("pet:done", { id, mode: "chat", full: r.reply, emotion: r.emotion }); return; }
 */
function tryQuickCommand(text, deps) {
  const { features, notify } = deps || {};
  if (!features) return null;
  const clean = String(text || "").trim();
  const say = (msg) => { if (typeof notify === "function") notify(msg); };

  // === 日程提醒 ===
  if (/提醒|记得|别忘/.test(clean)) {
    const at = features.parseTime(clean);
    const reminderText = features.extractReminder(clean);
    if (at && reminderText) {
      const ok = features.setReminder(reminderText, at, (msg) => say(msg));
      if (ok) {
        const timeStr = new Date(at).toLocaleString("zh-CN", { hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" });
        return { reply: `好的博士，我已经记住了！${timeStr}会提醒你：${reminderText} ⏰`, emotion: "happy" };
      }
    }
  }

  // === 番茄钟控制 ===
  if (/番茄钟|pomodoro/i.test(clean)) {
    if (/开始|启动|start/i.test(clean)) {
      features.startPomodoro((msg) => say(msg));
      return { reply: "好的博士！🍅 番茄钟已启动（25分钟工作 + 5分钟休息），到时间我会提醒你的～", emotion: "happy" };
    }
    if (/停止|取消|stop/i.test(clean)) {
      features.stopPomodoro();
      return { reply: "番茄钟已停止。博士辛苦了～", emotion: "happy" };
    }
    const st = features.getPomodoroStatus();
    if (st) {
      return { reply: `当前番茄钟：${st.phase}，剩余 ${st.remaining}，已完成 ${st.count} 个 ⏱`, emotion: "think" };
    }
  }

  // === 系统状态查询（精确匹配，避免拦截普通聊天中的 CPU/内存话题） ===
  if (/^(电脑|系统|CPU|内存)状态$|^(查看|看看|检查).*(电脑|系统)状态|^CPU$|^内存$|^cpu使用率$|^内存使用率$/i.test(clean)) {
    return new Promise((resolve) => {
      Promise.resolve(features.getSystemStats()).then((stats) => {
        if (stats) {
          const comment = features.systemStatsToSpeech(stats) || "";
          resolve({ reply: `📊 CPU: ${stats.cpu}% | 内存: ${stats.ramUsed}% (${stats.ramFree}/${stats.ramTotal}GB)\n${comment}`, emotion: "think" });
        } else {
          resolve(null);
        }
      }).catch(() => resolve(null));
    });
  }

  return null;
}

module.exports = { tryQuickCommand };