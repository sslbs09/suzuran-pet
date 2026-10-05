"use strict";

/**
 * Phase 7-F0 — MEMORY SIMILARITY CORRECTNESS REGRESSION
 *
 * 缺陷：memory.similar() 在 a.length === b.length 时把 s 与 l 同时解析成 a，
 * 于是「自己和自己比」，ratio 恒为 1 ⇒ 任何两条等长文本都被判为重复。
 * addFacts() 的跨 type 去重因此会静默丢弃与已存事实完全无关的 fact；
 * 更严重的是，真实用户记忆里只要存在一条与 PLAN 文本恰好等长的事实，
 * 「博士近期有「考试」的安排」这条 PLAN 就永远写不进去。
 *
 * 纪律：
 *  - 全部断言打在**真实 addFacts 路径**上，不复制 similar() 到测试里自测。
 *  - 修复前本文件必须 FAIL（等长异内容用例），修复后必须全绿。
 *  - 阈值语义、same-type overwrite 语义、substring 去重语义一律不变。
 *  - 存储隔离：SUZURAN_TEST_USERDIR + mkdtemp，全程零真实 memory.json 接触。
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "suzuran-p7f0-"));
process.env.SUZURAN_TEST_USERDIR = TMP; // 必须在 require config/memory 之前

const memory = require("../src/memory");

function reset() { memory.clear(); }
function types() { return memory.getFactsList().map((f) => f.type); }
function hasType(t) { return types().includes(t); }
/** 跨 type 写入：type 互不相同 ⇒ 一定会走到 similar() 去重分支 */
function addCrossType(type, text) { memory.addFacts([{ type, text }]); }

/* ============ A. 等长异内容：必须同时存储（修复前 FAIL） ============ */

test("A1 等长异内容的两条事实必须共存（不同 type）", () => {
  reset();
  addCrossType("alpha", "AAAAAAAAAAAA"); // 12
  addCrossType("beta", "ZZZZZZZZZZZZ");  // 12，内容完全无关
  assert.ok(hasType("alpha"), "第一条必须存在");
  assert.ok(hasType("beta"), "等长异内容绝不能被 similar() 静默丢弃");
  assert.equal(memory.getFactsList().length, 2);
});

test("A2 等长异内容的中文事实必须共存（真实语义无关）", () => {
  reset();
  addCrossType("pref", "博士喜欢「猫猫」");   // 9 字
  addCrossType("avoid", "博士不吃「猫猫」"); // 9 字
  assert.ok(hasType("pref"));
  assert.ok(hasType("avoid"), "pref/avoid 同长度不同内容不得互相吞掉");
});

/* ============ B. 真实语义无关但等长：PLAN 仍必须写入 ============ */

test("B1 存在等长无关事实时，PLAN（event）必须仍能写入", () => {
  reset();
  const planText = "博士近期有「考试」的安排";
  const unrelated = "博士不吃/不能吃「香菜」"; // 与 PLAN 同为 12 字
  assert.equal(planText.length, unrelated.length, "fixture 必须等长，否则本用例失去意义");

  addCrossType("avoid", unrelated);
  assert.ok(hasType("avoid"), "前置无关事实已入库");
  addCrossType("event", planText);
  assert.ok(hasType("event"), "等长无关事实不得阻止 PLAN 写入");
});

test("B2 多条等长无关事实并存后，PLAN 依然写入", () => {
  reset();
  addCrossType("avoid", "博士不吃/不能吃「香菜」"); // 12
  addCrossType("job", "博士的职业是「工程师」");     // 12
  addCrossType("event", "博士近期有「考试」的安排"); // 12
  assert.ok(hasType("event"), "连续等长无关事实仍不得阻止 PLAN 写入");
});

/* ============ C. 真正的 substring similarity：仍应去重 ============ */

test("C1 短串是长串连续子串且 ratio > 0.6 ⇒ 仍去重", () => {
  reset();
  const short = "XXXXXXXXXXXX";          // 12
  const long = "YYYY" + "XXXXXXXXXXXX";  // 16；ratio = 12/16 = 0.75 > 0.6
  addCrossType("alpha", long);
  addCrossType("beta", short);
  assert.ok(hasType("alpha"));
  assert.equal(hasType("beta"), false, "真实 substring 相似必须继续去重");
});

test("C2 完全相同的文本（不同 type）⇒ 仍去重", () => {
  reset();
  addCrossType("alpha", "同一条记忆文本");
  addCrossType("beta", "同一条记忆文本");
  assert.ok(hasType("alpha"));
  assert.equal(hasType("beta"), false, "完全相同文本必须继续去重");
});

/* ============ D. ratio 边界：0.6 不去重（严格大于） ============ */

test("D1 ratio 恰好 0.6 ⇒ 不去重（阈值语义不变，严格 > 0.6）", () => {
  reset();
  const short = "XXXXXX";          // 6
  const long = "YYYY" + "XXXXXX";  // 10；ratio = 6/10 = 0.6，不 > 0.6
  addCrossType("alpha", long);
  addCrossType("beta", short);
  assert.ok(hasType("beta"), "0.6 必须不入去重（既有阈值语义保持不变）");
});

/* ============ E. 不同长度且无 substring：不去重 ============ */

test("E1 不同长度且无 substring ⇒ 不去重", () => {
  reset();
  addCrossType("alpha", "这是第一条完全不同的记忆文本内容");
  addCrossType("beta", "短"); // 长度差很大且非子串
  assert.equal(memory.getFactsList().length, 2);
});

/* ============ F. same-type overwrite 语义不变 ============ */

test("F1 同 type 仍走覆盖分支：保留 id、只留一条", () => {
  reset();
  addCrossType("pref", "博士喜欢「奶茶」");
  const before = memory.getFactsList().find((f) => f.type === "pref");
  addCrossType("pref", "博士喜欢「咖啡」");
  const list = memory.getFactsList().filter((f) => f.type === "pref");
  assert.equal(list.length, 1, "same-type 仍是一条");
  assert.equal(list[0].text, "博士喜欢「咖啡」", "文本仍被最新表述覆盖");
  assert.equal(list[0].id, before.id, "id 必须保留（type identity 语义不变）");
});

test("F2 same-type 覆盖不受本次修复影响（跨 type 去重不参与）", () => {
  reset();
  addCrossType("event", "博士近期有「考试」的安排"); // 12
  const first = memory.getFactsList().find((f) => f.type === "event");
  addCrossType("event", "博士近期有「面试」的安排"); // 12，等长但同 type
  const list = memory.getFactsList().filter((f) => f.type === "event");
  assert.equal(list.length, 1, "同 type 覆盖路径不受 similar() 影响");
  assert.equal(list[0].id, first.id, "覆盖保留原 id");
  assert.equal(list[0].text, "博士近期有「面试」的安排");
});

/* ============ G. 空值守卫不变 ============ */

test("G1 空文本仍不产生事实", () => {
  reset();
  addCrossType("alpha", "");
  assert.equal(memory.getFactsList().length, 0);
});
