"use strict";
const assert = require("assert");
const { createLineGate, normalizeLine } = require("../src/line-gate");

assert.strictEqual(normalizeLine("（歪头）博士，好好休息～"), "博士好好休息");
const gate = createLineGate({ minIntervalMs: 30000, recentLimit: 2 });
assert.strictEqual(gate.admit("第一句", { now: 100000 }).accepted, true);
assert.deepStrictEqual(gate.admit("第二句", { now: 110000 }), { accepted: false, reason: "global-cooldown" });
assert.strictEqual(gate.admit("第二句", { now: 130000 }).accepted, true);
assert.strictEqual(gate.admit("（动作）第二句！", { now: 170000 }).reason, "duplicate");
assert.strictEqual(gate.admit("紧急提醒", { now: 170000, force: true }).accepted, true);
assert.strictEqual(gate.admit("紧急提醒", { now: 170001, force: true }).reason, "duplicate");
gate.reset();
assert.strictEqual(gate.admit("重置后", { now: 1 }).accepted, true);
console.log("line-gate 全部通过 ✅");
