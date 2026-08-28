/** 由头信号源单测（node，纯函数） */
"use strict";
const { signalTopic } = require("../src/proactive-topic");
let failed = 0;
function has(name, cond) {
  if (!cond) { failed++; console.log("FAIL", name); }
  else console.log("PASS", name);
}
const work = (rem, min = 0) => ({ phase: "工作中", remaining: `${min}:${String(rem).padStart(2, "0")}`, count: 1 });

// ① 无信号 → null（不打扰）
has("无信号返回 null", signalTopic({}) === null);
has("无番茄钟/无日程 → null", signalTopic({ pomodoro: null, reminders: [] }) === null);

// ② 番茄钟：工作态 ≤2min 优先 / ≤8min 常规 / >8min 不打扰
const u2 = signalTopic({ pomodoro: work(30, 1) });
has("番茄钟剩 1:30 → urgent 文案", !!u2 && u2.urgent === true && /番茄钟/.test(u2.text));
const n5 = signalTopic({ pomodoro: work(10, 5) });
has("番茄钟剩 5:10 → 常规文案", !!n5 && n5.urgent === false && /还剩 5:10/.test(n5.text));
has("番茄钟剩 20min → null", signalTopic({ pomodoro: work(0, 20) }) === null);
const rest = signalTopic({ pomodoro: { phase: "休息中", remaining: "3:00", count: 2 } });
has("番茄钟休息态 → 活动文案", !!rest && /休息|活动|喝口水/.test(rest.text));

// ③ 日程：≤30min 关切 / ≤10min 优先 / ≤2min 不插嘴（防与 ⏰ 提醒叠音）/ >30min 不打扰
const r15 = signalTopic({ reminders: [{ text: "去开会", remaining: 15 * 60000 }] });
has("日程剩 15min → 关切文案", !!r15 && r15.urgent === false && /去开会/.test(r15.text) && /15 分钟/.test(r15.text));
const r5 = signalTopic({ reminders: [{ text: "吃药", remaining: 5 * 60000 }] });
has("日程剩 5min → urgent", !!r5 && r5.urgent === true);
has("日程剩 2min → null（避免叠音）", signalTopic({ reminders: [{ text: "吃药", remaining: 2 * 60000 }] }) === null);
has("日程剩 40min → null", signalTopic({ reminders: [{ text: "会议", remaining: 40 * 60000 }] }) === null);
const multi = signalTopic({ reminders: [{ text: "远的事", remaining: 45 * 60000 }, { text: "近的事", remaining: 12 * 60000 }] });
has("多日程取最近一条", !!multi && /近的事/.test(multi.text));

// ④ 优先级：番茄钟紧急 > 日程 | 番茄钟常规 + 日程常规 → 番茄钟优先
const both = signalTopic({ pomodoro: work(30, 1), reminders: [{ text: "开会", remaining: 15 * 60000 }] });
has("番茄钟紧急优先于日程", !!both && both.urgent === true && /番茄钟/.test(both.text));

console.log(failed ? `\n${failed} 项失败` : "\nproactive-topic 全部通过 ✅");
process.exit(failed ? 1 : 0);