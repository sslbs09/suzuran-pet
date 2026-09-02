/** updater 纯函数单测（node）——版本比较/更新计划（v2.5.26 ③） */
"use strict";
const { compareSemver, buildUpdatePlan } = require("../src/updater");
let failed = 0;
function assert(name, cond, extra) {
  if (!cond) { failed++; console.log("FAIL", name, extra || ""); }
  else console.log("PASS", name);
}

assert("2.5.26>2.5.25", compareSemver("v2.5.26", "2.5.25") === 1);
assert("2.5.25<2.5.26", compareSemver("2.5.25", "v2.5.26") === -1);
assert("相等", compareSemver("2.5.26", "v2.5.26") === 0);
assert("主版本比较", compareSemver("3.0.0", "2.9.9") === 1);

const assets = [
  { name: "app.asar", browser_download_url: "https://x/app.asar", size: 100 },
  { name: "app.asar.version", browser_download_url: "https://x/v" },
];
assert("有新版+有资产→计划", buildUpdatePlan({ current: "2.5.25", latestTag: "v2.5.26", assets }).version === "v2.5.26");
assert("同版本→null", buildUpdatePlan({ current: "2.5.26", latestTag: "v2.5.26", assets }) === null);
assert("无 asar 资产→null", buildUpdatePlan({ current: "2.5.25", latestTag: "v2.5.26", assets: [] }) === null);

process.exit(failed ? 1 : 0);
