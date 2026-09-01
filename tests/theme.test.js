/** theme 单测（node）——验证主题判定唯一来源 renderer/theme.js：dark/light/auto 边界（v2.5.26 收敛） */
"use strict";
const { isDark } = require("../renderer/theme");
let failed = 0;
function assert(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failed++; console.log("FAIL", name, "got", JSON.stringify(got), "want", JSON.stringify(want)); }
  else console.log("PASS", name);
}

const h = (hour) => new Date(2026, 8, 1, hour, 30); // 固定小时数

// 1) 显式主题直通
assert("dark 恒深", isDark("dark", h(12)), true);
assert("light 恒浅", isDark("light", h(23)), false);

// 2) auto 边界：19 点-6 点深色
assert("auto 白天浅", isDark("auto", h(12)), false);
assert("auto 18 点浅", isDark("auto", h(18)), false);
assert("auto 19 点深", isDark("auto", h(19)), true);
assert("auto 23 点深", isDark("auto", h(23)), true);
assert("auto 5 点深", isDark("auto", h(5)), true);
assert("auto 6 点浅", isDark("auto", h(6)), false);

// 3) system 在 node 无 window：安全回退不抛错
assert("system 无 window 不抛错", typeof isDark("system", h(12)), "boolean");

process.exit(failed ? 1 : 0);
