/**
 * router.js — 混合路由（分享版）
 *  - zcode 任务模式默认关闭（config.json 的 zcodeEnabled=true 时启用）
 *  - /zcode /任务 /task 前缀（大小写不敏感）→ ZCode CLI 任务
 *  - 其余 → 日常聊天
 */
"use strict";

const config = require("./config");

const TASK_PREFIXES = ["zcode", "task", "zc", "任务"];

function route(text) {
  const t = (text || "").trim();
  if (!config.getConfig().zcodeEnabled) {
    return { mode: "chat", task: t }; // 任务模式未启用 → 一律聊天
  }
  const body = t.replace(/^\/+/, ""); // 去掉前导 /
  const lower = body.toLowerCase();
  for (const p of TASK_PREFIXES) {
    if (lower.startsWith(p)) {
      return { mode: "zcode", task: body.slice(p.length).trim() || body };
    }
  }
  return { mode: "chat", task: t };
}

// CLI 冒烟测试：node src/router.js --test
if (process.argv.includes("--test")) {
  const cases = [
    ["/zcode 帮我整理桌面文件", "chat"], // 分享版默认无任务模式
    ["你好，苏苏洛", "chat"],
    ["今天天气怎么样", "chat"],
    ["", "chat"]
  ];
  let fail = 0;
  for (const [text, expect] of cases) {
    const r = route(text);
    const ok = r.mode === expect;
    if (!ok) fail++;
    console.log(`${ok ? "✓" : "✗"} "${text}" → ${r.mode}${ok ? "" : `（期望 ${expect}）`}`);
  }
  console.log(fail ? `❌ ${fail} 个用例失败` : "✅ 全部通过");
  process.exit(fail ? 1 : 0);
}

module.exports = { route };
