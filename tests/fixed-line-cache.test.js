"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suzuran-fixed-lines-"));
process.env.SUZURAN_TEST_USERDIR = dir;
const cache = require("../src/fixed-line-cache");
const fixed = require("../src/fixed-lines");
const profile = { engine: "edge", language: "zh", voice: "test", rate: "+0%", pitch: "+0Hz" };
const item = fixed.buildManifest({ name: "小苏", user: "阿明" })[0];
let status = cache.load(profile, { name: "小苏", user: "阿明" });
assert.strictEqual(status.summary.ready, 0);
cache.saveItem(profile, item, Buffer.from("RIFF-test-audio"));
status = cache.load(profile, { name: "小苏", user: "阿明" });
assert.strictEqual(status.summary.ready, 1);
assert.strictEqual(cache.readAudio(profile, item).toString(), "RIFF-test-audio");
assert.strictEqual(cache.readAudioById(profile, item.id).toString(), "RIFF-test-audio"); // lineId 直查
assert.strictEqual(cache.readAudioById(profile, "pat.99"), null);
assert.strictEqual(cache.readAudioById(profile, "../evil"), null); // 非法 id 拒绝
assert.ok(cache.CACHE_TTL_MS >= 30 * 24 * 60 * 60 * 1000);
// 旧版本缓存清理：伪造一个旧指纹目录，clearOld 应删除它并保留当前方案
const fakeFp = "0123456789abcdef";
fs.mkdirSync(path.join(cache.ROOT, fakeFp), { recursive: true });
fs.writeFileSync(path.join(cache.ROOT, fakeFp, "manifest.json"), "{}");
const kept = cache.pathsFor(profile).fingerprint;
const removed = cache.clearOldFingerprints(kept);
assert.ok(removed >= 1);
assert.ok(!fs.existsSync(path.join(cache.ROOT, fakeFp)));
assert.ok(fs.existsSync(path.join(cache.ROOT, kept)));
cache.markFailed(profile, status.items[1], "MOCK_FAILURE");
status = cache.load(profile, { name: "小苏", user: "阿明" });
assert.strictEqual(status.summary.failed, 1);
cache.clear(profile);
assert.strictEqual(cache.load(profile, { name: "小苏", user: "阿明" }).summary.ready, 0);
fs.rmSync(dir, { recursive: true, force: true });
console.log("fixed-line-cache 全部通过 ✅");
