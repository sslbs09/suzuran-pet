"use strict";
const assert = require("assert");
const lines = require("../src/lines");

function at(hour, minute = 0) {
  const d = new Date(2026, 0, 1, hour, minute, 0, 0);
  return d;
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
assert.ok(lines.PERSONIFY_LINES.sleepNight.includes(night));
assert.ok(lines.PERSONIFY_LINES.sleepDay.includes(day));
assert.ok(lines.PERSONIFY_LINES.sleepDay.includes(late));
const expand = (item) => item.replace(/\{\{user\}\}/g, vars.user).replace(/\{\{name\}\}/g, vars.name);
assert.ok(lines.PERSONIFY_LINES.sleepNight.map(expand).includes(bedtime));
assert.match(lines.pickTpl(["{{user}} / {{name}}"], vars, () => 0), /阿明 \/ 小苏/);
assert.match(lines.pickTpl(["{{user}} / {{name}}"], {}, () => 0), /主人 \/ 苏苏洛/);

const pool = ["a", "b", "c", "d"];
const values = [0, 0.3, 0.6, 0.9].map((value) => lines.pick(pool, () => value));
assert.strictEqual(new Set(values).size, 4);
assert.ok(lines.PAT_LINES.length >= 10);
assert.ok(Object.values(lines.PROACTIVE_BY_PERIOD).every((pool) => pool.length >= 2));
console.log("lines 全部通过 ✅");
