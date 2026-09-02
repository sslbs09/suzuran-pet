/** LINE_MOODS / 情绪细标 单测（node）——池级情绪与【标记】必须落在五档音色键内（v2.5.26） */
"use strict";
const L = require("../src/lines");
let failed = 0;
function assert(name, cond, extra) {
  if (!cond) { failed++; console.log("FAIL", name, extra || ""); }
  else console.log("PASS", name);
}

const KEYS = ["撒娇", "傲娇", "惊讶", "开心", "温柔"];

// 1) 池级映射值都在五档内
for (const [k, v] of Object.entries(L.LINE_MOODS)) {
  assert(`LINE_MOODS.${k}=${v} 在五档内`, KEYS.includes(v));
}

// 2) 所有池里带【x】细标的，x 必须在五档内
const pools = [
  L.PAT_LINES, L.WORKFLOW_LINES, L.LONG_IDLE_LINES, L.EARLY_MORNING_LINES,
  ...Object.values(L.PERSONIFY_LINES),
  ...Object.values(L.PROACTIVE_BY_PERIOD),
  ...Object.values(L.PROACTIVE_BY_STATE),
  ...Object.values(L.STAGE_LINES),
];
let marked = 0, badMark = [];
for (const pool of pools) for (const s of pool) {
  const m = String(s).match(/^【([^】]+)】/);
  if (m) { marked++; if (!KEYS.includes(m[1])) badMark.push(s.slice(0, 12)); }
}
assert("细标全部合法（" + marked + " 条带标）", badMark.length === 0, badMark.join(","));

// 3) 每个池非空且 pick 可取
for (const [name, pool] of Object.entries({ pat: L.PAT_LINES, walk: L.PROACTIVE_BY_STATE.walking, seat: L.PROACTIVE_BY_STATE.seated })) {
  assert(`池 ${name} 非空可取`, Array.isArray(pool) && pool.length > 0 && !!L.pick(pool));
}

process.exit(failed ? 1 : 0);
