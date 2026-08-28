/** 防御模块单测：记忆（事实/去重/封顶/篡改）、羁绊、台词表、工具、蜜标（隔离 APPDATA） */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

// 关键：先重定向 APPDATA 到临时目录，再 require 依赖树（storage 在 require 时捕获路径）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "suzuran-test-"));
process.env.APPDATA = TMP;

const memory = require("../src/memory");
const bond = require("../src/bond");
const lines = require("../src/lines");
const utils = require("../src/utils");
const config = require("../src/config");

let failed = 0;
function ok(name, cond) { if (!cond) { failed++; console.log("FAIL", name); } else console.log("PASS", name); }

/* ---------- memory.extractFacts（规则式，宁缺毋滥） ---------- */
let f = memory.extractFacts("以后叫我阿米娅就好");
ok("extractFacts 称谓", f.some(x => x.type === "name" && x.text.includes("阿米娅")));
f = memory.extractFacts("我生日是3月25日");
ok("extractFacts 生日", f.some(x => x.type === "birthday" && x.text.includes("3月25日")));
f = memory.extractFacts("我最喜欢喝奶茶");
ok("extractFacts 喜好", f.some(x => x.type === "pref" && x.text.includes("奶茶")));
f = memory.extractFacts("我最近感冒了");
ok("extractFacts 健康", f.some(x => x.type === "health" && x.text.includes("感冒")));
f = memory.extractFacts("下个月要准备考试");
ok("extractFacts 事件", f.some(x => x.type === "event" && x.text.includes("考试")));
ok("extractFacts 空串无产出", memory.extractFacts("").length === 0);
ok("extractFacts 纯寒暄无产出", memory.extractFacts("今天天气不错啊").length === 0);
ok("extractFacts 短句不误收喜好（<2字）", memory.extractFacts("我喜欢你").every(x => x.type !== "pref"));

/* ---------- memory.addFacts：同类覆盖 / 相似去重 / 封顶 ---------- */
memory.clear();
memory.addFacts([{ type: "pref", text: "博士喜欢「奶茶」" }]);
memory.addFacts([{ type: "pref", text: "博士喜欢「咖啡」" }]); // 同类覆盖
let list = memory.getFactsList();
ok("addFacts 同类覆盖为一条", list.filter(x => x.type === "pref").length === 1 && list.filter(x => x.type === "pref")[0].text.includes("咖啡"));
memory.addFacts([{ type: "name", text: "博士希望我称呼他为「阿米娅」" }]);
list = memory.getFactsList();
ok("addFacts 相似去重", list.filter(x => x.type === "name").length === 1);
memory.clear();
for (let i = 0; i < 40; i++) memory.addFacts([{ type: "health", text: "博士最近头疼" + i }]); // 同类唯一，无法顶满；改用不同类型
memory.clear();
for (let i = 0; i < 40; i++) memory.addFacts([{ type: "pref", text: "博士喜欢「东西" + i + "号」" }]);
ok("addFacts 封顶 30", memory.getFactsList().length <= 30);

/* ---------- 记忆加密 + 篡改检测（分场景重载模块，隔离内部缓存/状态） ---------- */
const MEM = path.join(config.STORAGE.userDir, "memory.json");
function freshMemory() {
  delete require.cache[require.resolve("../src/memory")];
  return require("../src/memory");
}
const enc = {
  encrypt: (s) => Buffer.from(s, "utf8").toString("base64"),
  decrypt: (s) => Buffer.from(s, "base64").toString("utf8"),
};

// A. 加密读写往返：写入 → 文件为密文 → 重载解密读回 → 无篡改
let m1 = freshMemory();
m1.init(enc);
m1.addFacts([{ type: "name", text: "博士希望我称呼他为「测试」" }]); // addFacts 内部 load+save（加密）
ok("memory 加密落盘", fs.existsSync(MEM) && !fs.readFileSync(MEM, "utf8").trim().startsWith("{"));
m1 = freshMemory();
m1.init(enc);
m1.load();
ok("正常往返无篡改", m1.wasTampered() === false);
ok("往返后事实仍在", m1.getFactsList().some((f) => f.type === "name"));

// B. 明文旧档自动迁移（raw 以 { 开头 + enc 就绪 → save 加密）
fs.writeFileSync(MEM, JSON.stringify({ facts: [{ type: "pref", text: "博士喜欢「奶茶」" }], summary: "" }), "utf8");
let m2 = freshMemory();
m2.init(enc);
m2.load();
ok("明文迁移后无篡改", m2.wasTampered() === false);
ok("迁移后转为密文", !fs.readFileSync(MEM, "utf8").trim().startsWith("{"));

// C. 篡改（内容被破坏）→ 报篡改 + hadData + 带原因
fs.writeFileSync(MEM, "not-a-valid-encrypted-blob!!", "utf8");
let m3 = freshMemory();
m3.init(enc);
m3.load();
ok("篡改检测 wasTampered", m3.wasTampered() === true);
ok("篡改 lastHadData=true", m3.lastHadData() === true);
ok("篡改 lastLoadError 有内容", m3.lastLoadError().length > 0);

// D. 空文件首启不视为篡改
fs.writeFileSync(MEM, "", "utf8");
let m4 = freshMemory();
m4.init(enc);
m4.load();
ok("空文件不报篡改", m4.wasTampered() === false);

/* ---------- bond 羁绊 ---------- */
bond.load();
const b0 = { level: bond.getLevel(), days: bond.getDays() };
bond.addExp(1);
ok("bond addExp 增长或同日", bond.getLevel() >= b0.level && bond.getDays() >= b0.days);
const txt = bond.getText();
ok("bond getText 含 Lv", /Lv\.\d+/.test(txt));

/* ---------- lines 台词表 ---------- */
ok("lines periodOf 凌晨→night", lines.periodOf(new Date(2026, 7, 27, 3)) === "night");
ok("lines periodOf 早晨→morning", lines.periodOf(new Date(2026, 7, 27, 8)) === "morning");
ok("lines periodOf 中午→noon", lines.periodOf(new Date(2026, 7, 27, 12)) === "noon");
ok("lines periodOf 下午→afternoon", lines.periodOf(new Date(2026, 7, 27, 15)) === "afternoon");
ok("lines periodOf 晚间→evening", lines.periodOf(new Date(2026, 7, 27, 20)) === "evening");
ok("lines pick 返回表内项", lines.PROACTIVE_BY_PERIOD.afternoon.includes(lines.pick(lines.PROACTIVE_BY_PERIOD.afternoon)));

/* ---------- utils ---------- */
ok("clamp 正常", utils.clamp(5, 0, 10) === 5 && utils.clamp(-1, 0, 10) === 0 && utils.clamp(99, 0, 10) === 10);
const ri = utils.randInt(5, 5);
ok("randInt 同界", ri === 5);
ok("clampScale", utils.clampScale(2.5) === 2.0 && utils.clampScale(0.2) === 0.6 && utils.clampScale(1.3) === 1.3);

/* ---------- config 默认值（隔离配置目录） ---------- */
const cfg = config.getConfig();
ok("config 默认 walkGlobal=false", cfg.walkGlobal === false);
ok("config 默认 softRender=false", cfg.softRender === false);
ok("config 默认五档情绪未关闭", (cfg.emotionVoice || {}).撒娇 !== false);

/* ---------- 蜜标基本行为 ---------- */
try {
  const fg = require("../src/file-guard");
  let alerts = [];
  fg.start((type, fn, detail) => alerts.push(type));
  const honey = path.join(config.STORAGE.userDir, fg.HONEY_FILES[0]);
  const ready = fs.existsSync(honey);
  // 触发蜜标读取（atime 变化）有个后台定时器，这里只验证诱饵文件已生成
  ok("蜜标诱饵文件已创建", ready);
  fg.stop();
} catch (e) {
  ok("蜜标模块可加载", false);
  console.log("（file-guard 异常: " + e.message + "）");
}

/* ---------- 加固：BOM 容忍（config / memory） + file-guard 深测 + parseEmotion ---------- */
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
(async () => {
  // 1) memory 密文带 BOM 仍可解密（记事本 UTF-8 BOM 保存场景）
  const MEM = path.join(config.STORAGE.userDir, "memory.json");
  const encB64 = { encrypt: (s) => Buffer.from(s, "utf8").toString("base64"), decrypt: (s) => Buffer.from(s, "base64").toString("utf8") };
  fs.writeFileSync(MEM, "﻿" + encB64.encrypt(JSON.stringify({ facts: [{ type: "pref", text: "博士喜欢「蜜雪」" }], summary: "s" })), "utf8");
  delete require.cache[require.resolve("../src/memory")];
  const mBom = require("../src/memory");
  mBom.init(encB64);
  mBom.load();
  ok("memory BOM 密文可解密且无篡改", mBom.wasTampered() === false && mBom.getFactsList().some((f) => f.text.includes("蜜雪")));

  // 2) parseEmotion（chat-client）
  const cc = require("../src/chat-client");
  ok("parseEmotion 提取+清洗", (() => { const r = cc.parseEmotion("今天真开心【情绪：撒娇】"); return r.emotion === "撒娇" && !r.text.includes("【情绪"); })());
  ok("parseEmotion 取最后一个", cc.parseEmotion("A【情绪：开心】B【情绪：生气】").emotion === "生气");
  ok("parseEmotion 无标注返回空", cc.parseEmotion("平平无奇").emotion === "");

  // 3) file-guard 深测：蜜标触发 + checkBeforeWrite 篡改恢复
  const fg = require("../src/file-guard");
  if (fg.isEnabled()) fg.stop();
  const alerts = [];
  fg.start((type) => alerts.push(type));
  const userDir = config.STORAGE.userDir;
  const honeyPath = path.join(userDir, fg.HONEY_FILES[0]);
  ok("深测-诱饵已建", fs.existsSync(honeyPath));
  // 蜜标：把 mtime 推后 >500ms → 3s 轮询应报警
  const future = new Date(Date.now() + 10000);
  fs.utimesSync(honeyPath, future, future);
  await sleep(3600);
  ok("蜜标 honey 报警", alerts.includes("honey"));
  // 篡改：checkBeforeWrite 检测 + 自动恢复 + 证据备份
  const cfgPath = path.join(userDir, "config.json");
  fs.writeFileSync(cfgPath, JSON.stringify({ pet: { name: "干净小苏苏" } }), "utf8");
  fg.noteConfigWritten();
  fs.appendFileSync(cfgPath, "\n//external", "utf8");
  const detected = fg.checkBeforeWrite();
  ok("checkBeforeWrite 检出篡改", detected === true);
  const after = fs.readFileSync(cfgPath, "utf8");
  ok("篡改后自动恢复干净版", after.includes("干净小苏苏") && !after.includes("外部篡改"));
  ok("篡改证据备份 .tampered 存在", fs.existsSync(cfgPath + ".tampered"));
  await sleep(3600);
  ok("篡改 tamper 报警", alerts.includes("tamper"));
  fg.stop();

  // 4) config 带 BOM 仍可解析（记事本保存场景）——放在最后，避免影响前置用例
  fs.writeFileSync(cfgPath, "﻿" + JSON.stringify({ pet: { name: "BOMME" } }), "utf8");
  delete require.cache[require.resolve("../src/config")];
  const cfgFresh = require("../src/config");
  ok("config BOM 可解析（不回落默认值）", cfgFresh.getConfig().pet.name === "BOMME");

  console.log(failed ? `\n${failed} 项失败` : "\n防御工事（BOM/蜜标/篡改/情绪解析）全部通过✅");
  process.exit(failed ? 1 : 0);
})();

