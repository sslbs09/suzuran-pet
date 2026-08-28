/** quick-commands 单测：提醒 / 番茄钟 / 系统状态（fake features，不碰真实调度） */
"use strict";
const Q = require("../src/quick-commands");
let failed = 0;
function ok(n, c) { if (!c) { failed++; console.log("FAIL", n); } else console.log("PASS", n); }

function fakeFeatures(overrides = {}) {
  const f = {
    parseTime: () => Date.now() + 3600000,
    extractReminder: () => "",
    setReminder: () => { f.__reminder = arguments; return true; },
    startPomodoro: () => {}, stopPomodoro: () => {},
    getPomodoroStatus: () => null,
    getSystemStats: () => null, systemStatsToSpeech: () => "",
    ...overrides,
  };
  return f;
}
let notified = 0;
const notify = () => { notified++; };

(async () => {
  // 1) 提醒
  let savedRemind = null;
  const f1 = fakeFeatures({ extractReminder: () => "喝药", setReminder: (t, at, cb) => { savedRemind = { t, at }; return true; } });
  const r1 = await Promise.resolve(Q.tryQuickCommand("下午3点提醒我喝药", { features: f1, notify }));
  ok("提醒：回执含 已记住+喝药", r1 && r1.reply.includes("喝药") && r1.reply.includes("记住了"));
  ok("提醒：parseTime 被用（at 有效）", savedRemind && savedRemind.at > 0);

  // 2) 番茄钟
  let started = 0, stopped = 0;
  const f2 = fakeFeatures({ startPomodoro: () => started++, stopPomodoro: () => stopped++ });
  const r2 = await Promise.resolve(Q.tryQuickCommand("开始番茄钟", { features: f2, notify }));
  ok("番茄钟：启动回执", r2 && r2.reply.includes("🍅") && started === 1);
  const r3 = await Promise.resolve(Q.tryQuickCommand("停止番茄钟", { features: f2, notify }));
  ok("番茄钟：停止回执", r3 && r3.reply.includes("已停止") && stopped === 1);
  const f2b = fakeFeatures({ getPomodoroStatus: () => ({ phase: "工作", remaining: "12分", count: 2 }) });
  const r4 = await Promise.resolve(Q.tryQuickCommand("番茄钟", { features: f2b, notify }));
  ok("番茄钟：状态回执", r4 && r4.reply.includes("当前番茄钟") && r4.reply.includes("12分"));

  // 3) 系统状态（异步）
  const f3 = fakeFeatures({
    getSystemStats: () => Promise.resolve({ cpu: 50, ramUsed: 60, ramFree: 8, ramTotal: 16 }),
    systemStatsToSpeech: () => "一切正常",
  });
  const r5 = await Promise.resolve(Q.tryQuickCommand("查看系统状态", { features: f3, notify }));
  ok("系统状态：回执含数据+点评", r5 && r5.reply.includes("CPU: 50%") && r5.reply.includes("一切正常"));

  // 4) 普通聊天不拦截
  const r6 = await Promise.resolve(Q.tryQuickCommand("今天天气不错", { features: fakeFeatures(), notify }));
  ok("普通聊天不拦截", r6 === null);
  ok("提醒类但无时间/文本 → 不拦截", (await Promise.resolve(Q.tryQuickCommand("记得带伞", { features: fakeFeatures({ parseTime: () => null, extractReminder: () => "" }), notify }))) === null);

  console.log(failed ? "\n" + failed + " 项失败" : "\nquick-commands 全部通过 ✅");
  process.exit(failed ? 1 : 0);
})();