"use strict";
const assert = require("assert");
const lines = require("../src/lines");

function at(hour, minute = 0) {
  return new Date(2026, 0, 1, hour, minute, 0, 0);
}

assert.strictEqual(lines.periodOf(at(4, 59)), "night");
assert.strictEqual(lines.periodOf(at(5)), "morning");
assert.strictEqual(lines.periodOf(at(10, 59)), "morning");
assert.strictEqual(lines.periodOf(at(11)), "noon");
assert.strictEqual(lines.periodOf(at(13, 59)), "noon");
assert.strictEqual(lines.periodOf(at(14)), "afternoon");
assert.strictEqual(lines.periodOf(at(17, 59)), "afternoon");
assert.strictEqual(lines.periodOf(at(18)), "evening");
assert.strictEqual(lines.periodOf(at(22, 59)), "evening");
assert.strictEqual(lines.periodOf(at(23)), "night");

const vars = { name: "小苏", user: "阿明" };
const night = lines.pickSleepLine(vars, at(4, 59), () => 0);
const day = lines.pickSleepLine(vars, at(5), () => 0);
const late = lines.pickSleepLine(vars, at(21, 59), () => 0);
const bedtime = lines.pickSleepLine(vars, at(22), () => 0);
const expand = (item) => item.replace(/\{\{user\}\}/g, vars.user).replace(/\{\{name\}\}/g, vars.name).replace(/^【(撒娇|傲娇|惊讶|开心|温柔)】/, "");
assert.ok(lines.PERSONIFY_LINES.sleepNight.map(expand).includes(night));
assert.ok(lines.PERSONIFY_LINES.sleepDay.map(expand).includes(day));
assert.ok(lines.PERSONIFY_LINES.sleepDay.map(expand).includes(late));
assert.ok(lines.PERSONIFY_LINES.sleepNight.map(expand).includes(bedtime));
assert.match(lines.pickTpl(["{{user}} / {{name}}"], vars, null, null, () => 0), /阿明 \/ 小苏/);
assert.match(lines.pickTpl(["{{user}} / {{name}}"], {}, null, null, () => 0), /博士 \/ 苏苏洛/); // v2.5.26 默认称呼统一为「博士」

// 池内最近 K 条排重 + banned 跨轮禁选（v2.5.26/2.5.27 合并语义）
const pool = ["a", "b", "c", "d", "e"];
const values = [0, 0.3, 0.6, 0.9].map((value) => lines.pick(pool, null, () => value));
assert.strictEqual(new Set(values).size, 4);
assert.ok(!["a", "b", "c"].includes(lines.pick(pool, new Set(["a", "b", "c"]), () => 0)));
assert.ok(lines.PAT_LINES.length >= 10);
assert.ok(Object.values(lines.PROACTIVE_BY_PERIOD).every((pool) => pool.length >= 2));
console.log("lines 全部通过 ✅");
