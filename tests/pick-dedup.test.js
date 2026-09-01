/** pick 去重机制单测（node）——RECENT_K 自适应 + 跨轮 banned + 空池回退 + track 回填（v2.5.26 重复感修复） */
"use strict";
const { pick, pickTpl } = require("../src/lines");
let failed = 0;
function assert(name, cond, extra) {
  if (!cond) { failed++; console.log("FAIL", name, extra || ""); }
  else console.log("PASS", name);
}

// 1) 池内去重：12 条池连抽 60 次，同句两次出现间隔必须 > 4（recentK=4 排除最近 4 条）
{
  const pool = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"];
  const lastSeen = {};
  let ok = true, detail = "";
  for (let n = 0; n < 60; n++) {
    const s = pick(pool);
    if (lastSeen[s] !== undefined && n - lastSeen[s] <= 4) { ok = false; detail = s + " 间隔 " + (n - lastSeen[s]); break; }
    lastSeen[s] = n;
  }
  assert("池内去重间隔>4", ok, detail);
}

// 2) 小池（4 条）recentK=3：连抽 20 次同句间隔 > 3
{
  const pool = ["w", "x", "y", "z"];
  const lastSeen = {};
  let ok = true, detail = "";
  for (let n = 0; n < 20; n++) {
    const s = pick(pool);
    if (lastSeen[s] !== undefined && n - lastSeen[s] <= 3) { ok = false; detail = s; break; }
    lastSeen[s] = n;
  }
  assert("小池去重间隔>3", ok, detail);
}

// 3) banned 跨轮禁选生效
{
  const pool = ["a", "b", "c", "d", "e", "f"];
  const banned = new Set(["a", "b"]);
  let ok = true;
  for (let n = 0; n < 30; n++) if (banned.has(pick(pool, banned))) { ok = false; break; }
  assert("banned 禁选生效", ok);
}

// 4) banned 排空池 → 回退池内去重，不返回空
{
  const pool = ["x", "y"];
  const banned = new Set(["x", "y"]);
  let ok = true;
  for (let n = 0; n < 10; n++) { const s = pick(pool, banned); if (!s) { ok = false; break; } }
  assert("banned 排空回退不空串", ok);
}

// 5) pickTpl track 回填原文 + 占位替换
{
  const track = {};
  const out = pickTpl(["hello {{user}}"], { user: "博士" }, track);
  assert("pickTpl 替换", out === "hello 博士");
  assert("track 回填原文", track.raw === "hello {{user}}");
}

// 6) banned 与 pickTpl 联动：禁选原文后不命中
{
  const pool = ["one {{user}}", "two {{user}}"];
  const banned = new Set(["one {{user}}"]);
  let ok = true;
  for (let n = 0; n < 10; n++) { const t = {}; pickTpl(pool, { user: "博士" }, t, banned); if (t.raw === "one {{user}}") { ok = false; break; } }
  assert("pickTpl banned 联动", ok);
}

process.exit(failed ? 1 : 0);
