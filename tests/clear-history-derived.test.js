/** clear-history 派生态删除语义单测（审计 K-EXP-13 F-03）——
 *  目标语义：Clear History 成功后，被清除对话不得再经已知派生检索路径被召回：
 *  ① 向量记忆（memory-vector.json + 内存 cache + 重启重载） ② LLM 摘要 + 自动提取事实
 *  ③ 历史滚动窗口 + clearGen 竞态护栏 ④ 清除后存储仍可用（新内容正常入库）。 */
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "suzuran-f03-"));
process.env.SUZURAN_TEST_USERDIR = tmp;

const history = require("../src/history");
const memory = require("../src/memory");
const vectorMemory = require("../src/vector-memory");

let failures = 0;
function ok(name, cond) {
  if (cond) console.log("PASS", name);
  else { failures++; console.log("FAIL", name); }
}

const VEC_FILE = path.join(tmp, "memory-vector.json");
const MEMORY_FILE = path.join(tmp, "memory.json");
const HISTORY_FILE = path.join(tmp, "history", "history.jsonl");

function vecFileEntries() {
  try {
    const obj = JSON.parse(fs.readFileSync(VEC_FILE, "utf8"));
    return Array.isArray(obj.entries) ? obj.entries.length : -1;
  } catch { return -1; }
}

/* ---- ① 向量记忆：clear 覆盖 内存态 + 磁盘文件 + 检索路径 ---- */
vectorMemory.add("博士昨天说他感冒了嗓子疼，很难受"); // ≥MIN_TEXT，必然入库
assert.strictEqual(vectorMemory.getCount(), 1);
ok("清除前 search 能召回", vectorMemory.search("感冒 嗓子疼", 3).length === 1);

const vecOk = vectorMemory.clear();
ok("vectorMemory.clear() 返回 true（失败语义可观测）", vecOk === true);
ok("内存 cache 已清", vectorMemory.getCount() === 0);
ok("检索路径已断：search 返回空", vectorMemory.search("感冒 嗓子疼", 3).length === 0);
ok("磁盘文件已清（重启重载源）", vecFileEntries() === 0);

/* 重启重载路径：丢弃模块缓存重新 require，新实例从磁盘 load */
const vmPath = require.resolve("../src/vector-memory");
delete require.cache[vmPath];
const V2 = require("../src/vector-memory");
ok("重启重载后向量库为空", V2.getCount() === 0);
ok("重启重载后检索仍为空", V2.search("感冒 嗓子疼", 3).length === 0);
ok("清除后存储可用：新内容正常入库", (() => { V2.add("清除之后的新话题：周末想去爬山"); return V2.getCount() === 1; })());

/* ---- ③ 历史滚动窗口 + clearGen 竞态护栏 ---- */
const genBefore = history.generation();
history.append({ ts: Date.now(), mode: "chat", role: "user", content: "清前消息甲" });
history.append({ ts: Date.now(), mode: "chat", role: "assistant", content: "清前回复乙" });
const histOk = history.clear();
ok("history.clear() 返回 true", histOk === true);
ok("内存滚动窗口已清", history.load().length === 0 && history.recent("chat", 20).length === 0);
ok("磁盘 history.jsonl 已清", fs.readFileSync(HISTORY_FILE, "utf8") === "");
ok("clearGen 递增（在途写回护栏依据）", history.generation() === genBefore + 1);

/* ---- ② 摘要 + 自动事实派生态：clearDerived 清派生、留手动 ---- */
memory.addFacts([
  { type: "pref", text: "博士喜欢「芒果」" },      // 自动提取类（extractFacts 同款 type）
  { type: "health", text: "博士最近感冒（要记得关心）" },
  { type: "manual", text: "博士特意让我记住：「周五交周报」" } // 显式「记住X」指令
]);
memory.updateSummary("博士最近感冒了，喜欢芒果，下周有考试安排。"); // LLM 摘要（20 轮一存）
const memOk = memory.clearDerived();
ok("memory.clearDerived() 返回 true", memOk === true);
ok("LLM 摘要已清（getText 不再注入）", memory.getSummary() === "" && !memory.getText().includes("芒果"));
ok("自动提取事实已清", !memory.getText().includes("感冒"));
ok("手动「记住X」事实保留（用户显式保留意图）", memory.getText().includes("周五交周报"));
ok("磁盘 memory.json 与内存一致（重启重载源）", (() => {
  const mp = require.resolve("../src/memory");
  delete require.cache[mp];
  const M2 = require("../src/memory");
  const keep = M2.getFactsList().length === 1 && M2.getFactsList()[0].type === "manual" && M2.getSummary() === "";
  require.cache[mp] = { exports: memory, loaded: true, id: mp }; // 恢复原实例，保持后续断言同源
  return keep;
})());

/* ---- 失败语义：原语返回 boolean，聚合方（IPC handler）据此 fail closed ---- */
ok("三个清除原语均返回布尔", [histOk, vecOk, memOk].every((v) => typeof v === "boolean"));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} 项失败` : "\nclear-history 派生态删除语义全部通过 ✅");
process.exit(failures ? 1 : 0);
