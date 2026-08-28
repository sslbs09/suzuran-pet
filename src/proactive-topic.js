/**
 * proactive-topic.js — 主动搭话「由头」第二信号源（B-3，纯函数可单测）
 * 第一信号源=记忆事实（称谓/生日/健康/近期安排，已在 features.startProactive）。
 * 本模块把轻量运行信号（番茄钟 / 日程倒计时）转成具体由头文案；
 * 无信号返回 null（不打扰）。刻意克制：只在临近时间点开口，避免变成闹钟式催促。
 */
"use strict";

const POMODORO_URGENT_MIN = 2;   // 番茄钟剩 ≤2min：优先想（与到点提醒拉开间隔）
const POMODORO_NORMAL_MIN = 8;   // 剩 ≤8min：常规关切
const REMIND_URGENT_MIN = 10;    // 日程剩 ≤10min：优先想
const REMIND_NORMAL_MIN = 30;    // 剩 ≤30min：常规关切

/**
 * @param {Object} s
 *   - pomodoro: getPomodoroStatus() 的返回值或 null（{phase:"工作中|休息中", remaining:"m:ss", count}）
 *   - reminders: Array<{text, remaining}>（remaining=毫秒，0 表示已到期）
 * @returns {{text:string, urgent:boolean} | null}
 */
function signalTopic({ pomodoro, reminders } = {}) {
  // ① 番茄钟：工作态临近结束 → 打气；休息态 → 提醒活动
  if (pomodoro && pomodoro.phase) {
    const [mm, ss] = String(pomodoro.remaining || "0:00").split(":").map(Number);
    const minLeft = (Number.isFinite(mm) ? mm : 0) + (Number.isFinite(ss) && ss > 0 ? 1 : 0);
    if (pomodoro.phase === "工作中") {
      if (minLeft <= POMODORO_URGENT_MIN) return { text: `（看了看番茄钟）马上就到啦，还剩 ${pomodoro.remaining}，博士再加把劲！`, urgent: true };
      if (minLeft <= POMODORO_NORMAL_MIN) return { text: `🍅 番茄钟还剩 ${pomodoro.remaining}，博士专注的样子真好看～`, urgent: false };
    } else if (pomodoro.phase === "休息中") {
      return { text: "☕ 休息时间到～博士起来走走、喝口水吧", urgent: false };
    }
  }
  // ② 日程倒计时：临近（≤30min）提前关切；≤10min 优先；剩 1-2min 不插嘴（到点有 ⏰ 提醒，避免叠音）
  if (Array.isArray(reminders) && reminders.length) {
    const soon = reminders
      .filter((r) => r && Number.isFinite(r.remaining) && r.remaining > 0)
      .map((r) => ({ ...r, min: Math.floor(r.remaining / 60000) }))
      .filter((r) => r.min <= REMIND_NORMAL_MIN && r.min > POMODORO_URGENT_MIN)
      .sort((a, b) => a.min - b.min);
    const top = soon[0];
    if (top) {
      const what = String(top.text || "那件事").slice(0, 20);
      const urgent = top.min <= REMIND_URGENT_MIN;
      return {
        text: `博士，好像快到「${what}」的时间了（还有 ${top.min} 分钟）～别忘了哦`,
        urgent,
      };
    }
  }
  return null;
}

module.exports = { signalTopic };