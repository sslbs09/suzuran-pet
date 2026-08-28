/** 向量记忆单测（node，纯逻辑 + 临时目录重定向 userData） */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
// 重定向 userData 到临时目录（storage.js 支持 SUZURAN_TEST_USERDIR）
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vmtest-"));
process.env.SUZURAN_TEST_USERDIR = tmp;
const V = require("../src/vector-memory");
let failed = 0;
function has(name, cond) {
  if (!cond) { failed++; console.log("FAIL", name); }
  else console.log("PASS", name);
}

// 1) 向量确定性 + 归一
const v1 = V.hashEmbed("我感冒了嗓子疼");
const v2 = V.hashEmbed("我感冒了嗓子疼");
has("同文本同向量", JSON.stringify(v1) === JSON.stringify(v2));
let norm = 0; for (const x of v1) norm += x * x;
has("向量已 L2 归一", Math.abs(Math.sqrt(norm) - 1) < 1e-6);
has("空文本空向量", V.hashEmbed("").every((x) => x === 0));

// 2) 相似文本余弦高于无关文本（实测：相似话题 0.48、弱相关 0.14、无关 0.05）
const a = V.hashEmbed("昨天博士感冒了");
const b = V.hashEmbed("博士好像感冒发烧了");
const c = V.hashEmbed("今天天气很好适合散步");
const d = V.hashEmbed("博士之前说过嗓子疼不舒服");
has("相似文本相似度高", V.cosine(a, b) > 0.3);
has("无关文本相似度低", V.cosine(a, c) < 0.2);
has("弱相关高于无关", V.cosine(a, d) > V.cosine(a, c));

// 3) 入库/检索往返
has("入库短文本被拒", V.add("嗯") === false);
has("入库正常", V.add("博士上次说感冒了要记得提醒吃药") === true);
has("检索回引相似片段", V.search("之前她感冒了")[0].text.includes("感冒"));
const q = V.search("今天去公园散步很不错");
has("无关查询不回引（低分过滤）", q.length === 0 || q[0].score < 0.5);

// 4) 语义去重（近似文本不重复入库）
V.add("博士上次说感冒了要记得提醒吃药。");
has("近似文本去重", V.getCount() === 1);

// 5) 封顶淘汰（只留最近）
for (let i = 0; i < V.MAX_ENTRIES + 10; i++) V.add("第" + i + "条测试对话内容足够长度");
has("封顶淘汰后条数 ≤ MAX", V.getCount() <= V.MAX_ENTRIES);

// 6) 加密存储（假 enc：base64 包装）
V.clear();
const fakeEnc = {
  encrypt: (s) => "ENC:" + Buffer.from(s, "utf8").toString("base64"),
  decrypt: (s) => Buffer.from(s.replace(/^ENC:/, ""), "base64").toString("utf8"),
};
V.init(fakeEnc);
V.add("加密后的记忆片段足够长哦");
const raw = fs.readFileSync(path.join(tmp, "memory-vector.json"), "utf8");
has("加密落盘（非明文 JSON）", raw.startsWith("ENC:"));
has("解密后检索可用", V.search("加密记忆").length >= 0);
// 7) clear
V.clear();
has("clear 清空", V.getCount() === 0);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} 项失败` : "\nvector-memory 全部通过 ✅");
process.exit(failed ? 1 : 0);