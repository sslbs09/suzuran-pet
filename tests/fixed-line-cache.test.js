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
assert.strictEqual(cache.CACHE_TTL_MS, 0); // 2026-09-03 起缓存长期保存（不设时间上限），空间由预算+LRU 管理
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

// TD-3：总容量预算 + LRU 目录清理（当前方案永不删，从最旧目录开始清到预算内）
cache.saveItem(profile, item, Buffer.alloc(1100, 7)); // 重建当前方案目录（音频+manifest 约 1.4KB）
const keepFp = cache.pathsFor(profile).fingerprint;
const mkFake = (fp, bytes) => {
  fs.mkdirSync(path.join(cache.ROOT, fp), { recursive: true });
  fs.writeFileSync(path.join(cache.ROOT, fp, "a.audio"), Buffer.alloc(bytes, 3));
};
mkFake("000000000000000a", 2000);
mkFake("000000000000000b", 2000);
const t = Date.now() / 1000;
fs.utimesSync(path.join(cache.ROOT, "000000000000000a"), t - 1000, t - 1000); // 最旧
fs.utimesSync(path.join(cache.ROOT, "000000000000000b"), t - 500, t - 500);
const budget = cache.enforceCacheBudget(keepFp, 3 * 1024);
assert.strictEqual(budget.removed, 2);
assert.ok(!fs.existsSync(path.join(cache.ROOT, "000000000000000a")));
assert.ok(!fs.existsSync(path.join(cache.ROOT, "000000000000000b")));
assert.ok(fs.existsSync(path.join(cache.ROOT, keepFp))); // 当前方案永不删
assert.ok(budget.totalBytes <= 3 * 1024);
assert.ok(cache.dirSizeBytes(cache.ROOT) <= 3 * 1024);

// 长期缓存：updatedAt 很旧的记录也命中（不再按 30 天过期）
cache.saveItem(profile, item, Buffer.from("RIFF-old-audio"));
const pathsKeep = cache.pathsFor(profile);
const disk = JSON.parse(fs.readFileSync(pathsKeep.manifest, "utf8"));
const key0 = Object.keys(disk.items)[0];
disk.items[key0].updatedAt = Date.now() - 90 * 24 * 60 * 60 * 1000; // 90 天前
fs.writeFileSync(pathsKeep.manifest, JSON.stringify(disk));
assert.strictEqual(cache.readAudio(profile, item).toString(), "RIFF-old-audio"); // 旧时间戳仍命中

fs.rmSync(dir, { recursive: true, force: true });
console.log("fixed-line-cache 全部通过 ✅");
