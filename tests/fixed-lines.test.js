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
// 记忆化：同 vars 返回同一数组（引用相等），不同 vars 重建
assert.strictEqual(fixed.buildManifest({ name: "小苏", user: "阿明" }), manifest);
assert.notStrictEqual(fixed.buildManifest({ name: "别人", user: "阿明" }), manifest);
// findItem：按展开文本+情绪反查稳定 id（lineId 透传链路）
const sample = manifest.find((i) => i.emotion === "idle");
assert.ok(sample);
assert.strictEqual(fixed.findItem({ name: "小苏", user: "阿明" }, sample.text, "idle").id, sample.id);
assert.strictEqual(fixed.findItem({ name: "小苏", user: "阿明" }, "不存在的台词", "idle"), null);
// findItemText：文本兜底反查（2026-09-03 修 lineId 情绪不匹配 60/358 句命中不了缓存）——
// 调用方情绪（LINE_MOODS 事件映射/天气"温柔"）与池默认不一致时 findItem miss、findItemText 命中
const anyLine = manifest.find((i) => i.emotion !== "idle");
assert.ok(anyLine);
assert.strictEqual(fixed.findItem({ name: "小苏", user: "阿明" }, anyLine.text, "绝不匹配的情绪"), null);
assert.strictEqual(fixed.findItemText({ name: "小苏", user: "阿明" }, anyLine.text).id, anyLine.id);
assert.strictEqual(fixed.findItemText({ name: "小苏", user: "阿明" }, "不存在的台词"), null);
console.log("fixed-lines 全部通过 ✅");
