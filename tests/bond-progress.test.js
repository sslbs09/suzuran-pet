/** bond.getProgress 单测（node，只读）——进度条数据形状与取值范围（v2.5.26） */
"use strict";
const bond = require("../src/bond");
let failed = 0;
function assert(name, cond, extra) {
  if (!cond) { failed++; console.log("FAIL", name, extra || ""); }
  else console.log("PASS", name);
}

const p = bond.getProgress();
assert("返回形状完整", ["exp", "level", "cur", "next", "pct", "max", "days"].every((k) => k in p), JSON.stringify(p));
assert("等级 1-10", p.level >= 1 && p.level <= 10, p.level);
assert("百分比 0-100", p.pct >= 0 && p.pct <= 100, p.pct);
assert("MAX 时百分比=100", !p.max || p.pct === 100);
assert("非 MAX 时 next>cur", p.max || p.next > p.cur);
assert("exp 落在 [cur,next)", p.max || (p.exp >= p.cur && p.exp < p.next), JSON.stringify([p.exp, p.cur, p.next]));

process.exit(failed ? 1 : 0);
