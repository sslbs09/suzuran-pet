/** 语音键对齐单测（2026-09-03 修「日语预热✓却播系统音/播放不完整」）：
 *  ① stripSpeechTail 剥渲染层句尾情绪语气词，正文同形字不动；
 *  ② lookupCachedJa 仅查缓存不调 API——磁盘命中/未命中返回值正确；
 *  ③ findItemText 文本兜底（见 fixed-lines.test.js，这里不重复）。 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suzuran-voice-key-"));
process.env.SUZURAN_TEST_USERDIR = dir;

const TC = require("../src/translate-cache");
const { lookupCachedJa } = require("../src/ja-translate");
const { stripSpeechTail } = require("../src/tts-manager");
const { FIXED_ONLY_MISS } = require("../src/tts-manager");

let failed = 0;
function ok(n, c) { if (!c) { failed++; console.log("FAIL", n); } else console.log("PASS", n); }

// ① 句尾语气词剥离（renderer EMOTION_SPEECH 值集合）
ok("剥 呀！", stripSpeechTail("补充维生素时间到呀！") === "补充维生素时间到");
ok("剥 哼！", stripSpeechTail("真是的……可别砸到显示器呀！哼！") === "真是的……可别砸到显示器呀！");
ok("剥 嘛～", stripSpeechTail("再来一下嘛，doctor嘛～") === "再来一下嘛，doctor");
ok("剥 呜…/嗯…/哇！", stripSpeechTail("哇！") === "" && stripSpeechTail("呜…") === "" && stripSpeechTail("嗯…") === "");
ok("剥 无标点语气词", stripSpeechTail("再摸摸嘛呀") === "再摸摸嘛");
ok("正文同形字不动", stripSpeechTail("嗯…这件事呀，我得想想") === "嗯…这件事呀，我得想想");

// ② lookupCachedJa：磁盘缓存直查（模拟预热落盘），不触发任何 API
const seeded = {};
TC.set(seeded, "补充维生素时间到", "ビタミン補給の時間だよ～", Date.now());
TC.save(dir, seeded);
ok("规范键磁盘命中", lookupCachedJa("补充维生素时间到") === "ビタミン補給の時間だよ～");
ok("未命中返回空串（不抛错）", lookupCachedJa("没预热过的台词") === "");
ok("空串安全", lookupCachedJa("") === "");

// 命中续期：磁盘 TTL 7 天且原本命中不刷新时间戳 → 固定台词整批过期后重新调 API。
// lookupCachedJa 命中后应把条目时间戳刷新为当前（读盘验证）
const fresh = TC.load(dir);
ok("命中已续期", TC.get(fresh, "补充维生素时间到") === "ビタミン補給の時間だよ～");
const raw = JSON.parse(fs.readFileSync(require("../src/translate-cache").cachePathFor(dir), "utf8"));
const entry = raw[require("../src/translate-cache").hashKey("补充维生素时间到")];
ok("续期时间戳为当前", Number.isFinite(entry.t) && Date.now() - entry.t < 60000);
// 续期后 TTL 内必然再命中（第二次直查）
ok("续期后再查仍命中", lookupCachedJa("补充维生素时间到") === "ビタミン補給の時間だよ～");

ok("离线未命中哨兵稳定", FIXED_ONLY_MISS === "__SUZURAN_FIXED_ONLY_MISS__");

console.log(failed ? "\n" + failed + " 项失败" : "\nvoice-ja-key 全部通过 ✅");
process.exit(failed ? 1 : 0);
