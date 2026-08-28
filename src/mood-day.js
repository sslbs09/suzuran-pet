"use strict";
/** 今日心情（确定性）：按日期哈希 + 羁绊天数加权；同一天稳定、羁绊越久越偏温暖 */
const MOODS = ["温暖", "元气", "平静", "软萌", "慵懒"];
function hashStr(s) {
  let h = 0;
  for (const c of String(s || "")) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}
function moodOfTheDay(dateStr, bondDays) {
  const warm = Math.min(2, Math.floor(Math.max(0, Number(bondDays) || 0) / 30));
  return MOODS[(hashStr(dateStr) + warm * 37) % MOODS.length];
}
module.exports = { moodOfTheDay, MOODS };
