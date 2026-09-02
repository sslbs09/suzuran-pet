"use strict";
const assert = require("assert");
const fixed = require("../src/fixed-lines");

const manifest = fixed.buildManifest({ name: "小苏", user: "阿明" });
assert.ok(manifest.length >= 200); // v2.5.26 天气/状态/扩池后固定台词超 200 条
assert.strictEqual(new Set(manifest.map((item) => item.id)).size, manifest.length);
assert.ok(manifest.some((item) => item.text.includes("阿明")));
assert.ok(manifest.every((item) => !/\{\{.*\}\}/.test(item.text)));
assert.ok(manifest.every((item) => !/^【/.test(item.text))); // 情绪标签已剥离
assert.ok(manifest.some((item) => item.pool.startsWith("weather.")));
assert.ok(manifest.some((item) => item.emotion === "撒娇" || item.emotion === "傲娇" || item.emotion === "温柔"));
assert.strictEqual(fixed.voiceFingerprint({ engine: "genie", language: "zh", referenceAudio: "a.wav" }), fixed.voiceFingerprint({ engine: "genie", language: "zh", referenceAudio: "a.wav" }));
assert.notStrictEqual(fixed.voiceFingerprint({ engine: "genie", language: "zh", referenceAudio: "a.wav" }), fixed.voiceFingerprint({ engine: "genie", language: "ja", referenceAudio: "a.wav" }));
assert.deepStrictEqual(fixed.summarize([{ state: "ready", bytes: 10 }, { state: "pending", bytes: 0 }, { state: "failed", bytes: 5 }]), { total: 3, pending: 1, loading: 0, ready: 1, failed: 1, cancelled: 0, bytes: 15 });
console.log("fixed-lines 全部通过 ✅");
