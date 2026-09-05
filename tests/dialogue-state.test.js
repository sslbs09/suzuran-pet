"use strict";
const assert = require("assert");
const { transitionSleep, createWorkflowSignalState, recordWorkflowSignal, consumeWorkflowSignal } = require("../src/dialogue-state");

assert.strictEqual(transitionSleep(false, false), null);
assert.strictEqual(transitionSleep(true, true), null);
assert.strictEqual(transitionSleep(false, true), "sleep");
assert.strictEqual(transitionSleep(true, false), "wake");

const state = createWorkflowSignalState(1000);
recordWorkflowSignal(state, "agent", 100);
recordWorkflowSignal(state, "workspace", 200);
assert.deepStrictEqual(consumeWorkflowSignal(state, 300, { busy: true }), { accepted: false, reason: "busy" });
assert.deepStrictEqual(consumeWorkflowSignal(state, 300, { sleeping: true }), { accepted: false, reason: "sleeping" });
assert.deepStrictEqual(consumeWorkflowSignal(state, 300), { accepted: true, sources: ["agent", "workspace"] });
assert.deepStrictEqual(consumeWorkflowSignal(state, 500), { accepted: false, reason: "empty" });
recordWorkflowSignal(state, "workspace", 600);
assert.deepStrictEqual(consumeWorkflowSignal(state, 900), { accepted: false, reason: "cooldown" });
assert.deepStrictEqual(consumeWorkflowSignal(state, 1400), { accepted: true, sources: ["workspace"] });
console.log("dialogue-state 全部通过 ✅");
