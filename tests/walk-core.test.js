/** walk-core 单测：状态对象 + 相位行为决策（纯函数） */
"use strict";
const W = require("../src/walk-core");
let failed = 0;
function ok(name, cond) { if (!cond) { failed++; console.log("FAIL", name); } else console.log("PASS", name); }

// 状态对象完整性
const s = W.createWalkState();
ok("createWalkState 返回关键字段", s.active === false && s.resting === true && s.seated === false && s.face === 1 && s.dir === 1);
ok("createWalkState 每次全新", W.createWalkState() !== s && W.createWalkState().flight === null);
s.seated = true; // 可变性：主进程原地改
ok("状态可原地修改", W.createWalkState().seated === false);

// 行为决策（random 注入）
const r0 = () => 0;        // 始终命中 idle
const r0_49 = () => 0.4999; // < idle0.45? 0.4999 > 0.45 → 到 walk 区? 0.4999*0.93=0.4649 >0.45 → walk
const r50 = () => 0.5;     // 0.5*0.93=0.465 → walk
const r90 = () => 0.95;    // 0.95*0.93=0.8835 → perch
ok("behavior：r=0 → idle", W.behaviorOf({ now: 0, random: r0 }) === "idle");
ok("behavior：r≈0.5 → walk", W.behaviorOf({ now: 100000, lastPerchEnd: 0, random: r50 }) === "walk");
ok("behavior：r≈0.95 → perch", W.behaviorOf({ now: 100000, lastPerchEnd: 0, random: r90 }) === "perch");
// 跳窗冷却 60s：刚跳完 perch 权重清零 → r90 也到 walk
ok("behavior：冷却期内 r0.95 → walk（perch 冻结）", W.behaviorOf({ now: 1000, lastPerchEnd: 0, random: r90 }) === "walk");
ok("behavior：冷却期外恢复 perch", W.behaviorOf({ now: 61000, lastPerchEnd: 0, random: r90 }) === "perch");
// 权重注入
ok("behavior：自定义权重全 idle", W.behaviorOf({ now: 0, random: () => 0.9, weights: { idle: 1, walk: 0, perch: 0 } }) === "idle");
ok("behavior：总权重 0 → 兜底 walk", W.behaviorOf({ now: 0, random: r50, weights: { idle: 0, walk: 0, perch: 0 } }) === "walk");
// —— 边界补充（2026-08-27 测试补位）——
ok("边界：冷却恰 60s 整点恢复 perch", W.behaviorOf({ now: 60000, lastPerchEnd: 0, random: r90 }) === "perch"); // (now-lastPerchEnd < 60000) 不含等号
ok("边界：random=0 命中 idle 起点", W.behaviorOf({ now: 0, random: r0 }) === "idle");
ok("边界：random 极小值也归 idle（r<0.45）", W.behaviorOf({ now: 0, random: () => 0.01 }) === "idle");
ok("边界：walk 上界下方 ε → walk", W.behaviorOf({ now: 100000, lastPerchEnd: 0, random: () => (0.85 - 1e-7) / 0.93 }) === "walk");
ok("边界：walk 上界上方 ε → perch", W.behaviorOf({ now: 100000, lastPerchEnd: 0, random: () => (0.85 + 1e-7) / 0.93 }) === "perch");
ok("边界：perch 权重跨冷却动态占比", W.behaviorOf({ now: 61000, lastPerchEnd: 0, random: () => 1.0 }) === "perch"); // r=total → 最后落入 perch
ok("边界：idle=0 时 r 直归 walk", W.behaviorOf({ now: 0, random: r50, weights: { idle: 0, walk: 1, perch: 0 } }) === "walk");

console.log(failed ? `\n${failed} 项失败` : "\nwalk-core 全部通过 ✅");
process.exit(failed ? 1 : 0);