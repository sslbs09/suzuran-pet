/** translate-cache 单测：磁盘缓存 TTL/淘汰/哈希（纯函数） */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const TC = require("../src/translate-cache");

let failed = 0;
function ok(n, c) { if (!c) { failed++; console.log("FAIL", n); } else console.log("PASS", n); }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-"));
const map = {};

ok("hash 稳定", TC.hashKey("你好呀") === TC.hashKey("你好呀") && TC.hashKey("你好呀") !== TC.hashKey("你好吗"));
ok("空缓存 miss", TC.get(map, "你好呀") === undefined);

TC.set(map, "你好呀", "こんにちは");
ok("写后命中", TC.get(map, "你好呀") === "こんにちは");
ok("不同 key 不串", TC.get(map, "你好吗") === undefined);

// 过期：TTL 极短
const m2 = {};
TC.set(m2, "早", "おはよう", 1000);
ok("短 TTL 命中", TC.get(m2, "早", 1500, 60000) === "おはよう");
ok("TTL 过期 miss", TC.get(m2, "早", 200000, 60000) === undefined);
ok("过期条目被懒清除", Object.keys(m2).length === 0);

// 淘汰：超过 MAX 保留最新
const m3 = {};
const now0 = Date.now();
for (let i = 0; i < TC.MAX + 20; i++) TC.set(m3, "line" + i, "ja" + i, now0 + i);
ok("淘汰后 ≤ MAX", TC.size(m3) <= TC.MAX);
ok("保留最新", TC.get(m3, "line" + (TC.MAX + 19), now0 + TC.MAX + 19 + 10, 600000) === "ja" + (TC.MAX + 19));

// 文件往返
const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "tc2-"));
const mc = {};
TC.set(mc, "午安", "こんにちは（昼）", Date.now());
TC.save(dir2, mc);
const loaded = TC.load(dir2);
ok("落盘再读一致", TC.get(loaded, "午安") === "こんにちは（昼）");
ok("无文件兜底", JSON.stringify(TC.load(path.join(dir2, "nope"))) === "{}");

console.log(failed ? "\n" + failed + " 项失败" : "\ntranslate-cache 全部通过 ✅");
process.exit(failed ? 1 : 0);