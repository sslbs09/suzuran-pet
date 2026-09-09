"use strict";

const assert = require("assert");
const { normalizeConfigShape, mergeConfigPatch } = require("../src/config-shape");

const DEFAULTS = {
  chat: {
    model: "default-model",
    sampling: { topP: 0.9, minP: 0.05 }
  },
  window: { width: 260, height: 200 },
  agentApi: { enabled: false, clients: [] },
  ttsCosy: { enabled: false, voice: "" },
  enabled: false,
  count: 3,
  moods: [{ name: "idle", label: "待机" }]
};

function normalize(userConfig) {
  return normalizeConfigShape(DEFAULTS, userConfig);
}

// 1-4) Four representative object-shaped nodes recover independently.
for (const [name, userConfig, path] of [
  ["chat:null", { chat: null }, "chat"],
  ["window:null", { window: null }, "window"],
  ["agentApi:string", { agentApi: "bad" }, "agentApi"],
  ["ttsCosy:array", { ttsCosy: [] }, "ttsCosy"]
]) {
  const result = normalize(userConfig);
  assert.strictEqual(result.recoveredPaths.includes(path), true, name + " reports recovery");
  assert.deepStrictEqual(result.value[path], DEFAULTS[path], name + " uses the default object");
}

// 5-8) Top-level non-objects never become numeric-key config objects.
for (const value of [null, [], [1], "bad", 123, true]) {
  const result = normalize(value);
  assert.strictEqual(result.topLevelInvalid, true, "top-level invalid: " + String(value));
  assert.deepStrictEqual(result.value, DEFAULTS, "top-level falls back to defaults");
  assert.strictEqual(Object.prototype.hasOwnProperty.call(result.value, "0"), false, "no array index field");
}

// 9-12) Legal overrides, partial recovery, deep recovery, and unknown fields.
const legal = normalize({ chat: { model: "abc", sampling: { topP: 0.7 } }, unknown: { keep: true } });
assert.strictEqual(legal.value.chat.model, "abc", "legal scalar override is kept");
assert.strictEqual(legal.value.chat.sampling.topP, 0.7, "legal deep override is kept");
assert.strictEqual(legal.value.chat.sampling.minP, 0.05, "missing deep default is filled");
assert.deepStrictEqual(legal.value.unknown, { keep: true }, "unknown field is kept");

const partial = normalize({ chat: { model: "abc", sampling: null }, window: { width: 500 } });
assert.strictEqual(partial.value.chat.model, "abc", "valid sibling survives recovery");
assert.deepStrictEqual(partial.value.chat.sampling, DEFAULTS.chat.sampling, "invalid deep object recovers only itself");
assert.strictEqual(partial.value.window.width, 500, "other valid object survives recovery");
assert.strictEqual(partial.recoveredPaths.includes("chat.sampling"), true, "deep path is reported");

// 13-15) Neither input nor defaults are mutated, and returned values are independent.
const defaultsBefore = JSON.parse(JSON.stringify(DEFAULTS));
const userConfig = { chat: { sampling: { topP: 0.2 } }, custom: { value: 1 } };
const userBefore = JSON.parse(JSON.stringify(userConfig));
const first = normalize(userConfig);
assert.deepStrictEqual(DEFAULTS, defaultsBefore, "defaults are not mutated");
assert.deepStrictEqual(userConfig, userBefore, "user config is not mutated");
first.value.chat.sampling.topP = 0;
first.value.moods[0].label = "changed";
first.value.custom.value = 2;
const second = normalize(userConfig);
assert.strictEqual(second.value.chat.sampling.topP, 0.2, "returned object does not share nested values");
assert.strictEqual(second.value.moods[0].label, "待机", "returned arrays do not share defaults");
assert.strictEqual(second.value.custom.value, 1, "returned unknown objects do not share user values");

// Save patches use the same DEFAULTS shape while preserving the live object on invalid nodes.
const live = normalize({ chat: { model: "custom-model" } }).value;
const patched = mergeConfigPatch(DEFAULTS, live, { chat: null, window: { width: 500 } });
assert.strictEqual(patched.value.chat.model, "custom-model", "invalid save patch preserves live object");
assert.strictEqual(patched.value.window.width, 500, "valid save patch still applies");
assert.strictEqual(patched.recoveredPaths.includes("chat"), true, "invalid save patch is diagnosed");

console.log("config-shape 全部通过 ✅");
