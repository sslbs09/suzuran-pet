"use strict";

/** 日志诊断纯函数单测（log-diag）：分级、脱敏、导出组装、readLogTail 尾部截取 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const logDiag = require("../src/log-diag");

test("classifyLine：报错/警告/常规分级", () => {
  assert.strictEqual(logDiag.classifyLine("2026-09-04T00:00:00Z [render] 渲染进程异常退出 reason=killed"), "error");
  assert.strictEqual(logDiag.classifyLine("... [render] 回退系统语音 ..."), "error");
  assert.strictEqual(logDiag.classifyLine("... [walk] 瞬态守卫: gotoPerch 超时10s，强制回地面"), "error");
  assert.strictEqual(logDiag.classifyLine("... [ja] 翻译预热 timeout，稍后重试"), "warn");
  assert.strictEqual(logDiag.classifyLine("... [anim] 相位对账 ... reason=停帧"), "warn");
  assert.strictEqual(logDiag.classifyLine("... [ja] 预热✓: あいさつ"), "info");
  assert.strictEqual(logDiag.classifyLine("... [walk] 状态 true|true|true ..."), "info");
});

test("sanitizeLine：密钥/URL query/用户路径/标题/坐标/PID/邮箱", () => {
  const out = logDiag.sanitizeLine('跳上窗口 {"x":234,"y":768,title:"Weixin - 聊天"} pid=1234');
  assert.ok(!out.includes("Weixin"), "窗口标题必须打码");
  assert.ok(out.includes('"x":230') || out.includes('"x": 230'), "坐标 10px 模糊保留十位");
  assert.ok(out.includes("<masked>"), "pid 走 masked");
  assert.ok(logDiag.sanitizeLine("key=sk-abcdef123456").includes("<masked>"));
  assert.ok(!logDiag.sanitizeLine("key=sk-abcdef123456").includes("sk-abcdef"));
  const u = logDiag.sanitizeLine("file=C:\\Users\\xsx\\AppData\\secret.txt https://api.x.com/v1?token=abc&x=1 a@b.com");
  assert.ok(u.includes("C:\\Users\\<user>"), "用户名打码、路径结构保留");
  assert.ok(u.includes("?<q>"), "URL query 打码");
  assert.ok(u.includes("<email>"));
});

test("sanitizeLine：用户称呼替换", () => {
  const out = logDiag.sanitizeLine("晴天适合散步呢，doctor陪我走走", { userNames: ["doctor"] });
  assert.ok(!out.includes("doctor"));
  assert.ok(out.includes("<name>"));
});

test("buildExport：头部元信息 + 统计 + 全文脱敏", () => {
  const r = { ok: true, lines: ["... 回退系统语音 ...", "... timeout 重试 ...", "... 预热✓ ..."] };
  const e = logDiag.buildExport(r, { appVersion: "2.5.28", userNames: ["doctor"] });
  assert.ok(e.text.includes("应用版本: 2.5.28"));
  assert.ok(e.text.includes("错误 1 / 警告 1 / 常规 1"));
  assert.strictEqual(e.stats.error, 1);
});

test("readLogTail：合并两文件、尾部截取、缺失文件容错", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logdiag-"));
  try {
    fs.writeFileSync(path.join(dir, "tts.log.1"), Array.from({ length: 30 }, (_, i) => "old-" + i).join("\n") + "\n");
    fs.writeFileSync(path.join(dir, "tts.log"), Array.from({ length: 10 }, (_, i) => "new-" + i).join("\n") + "\n");
    const r = logDiag.readLogTail(dir, 20);
    assert.ok(r.ok);
    assert.strictEqual(r.lines.length, 20);
    assert.strictEqual(r.lines[0], "old-20");
    assert.strictEqual(r.lines[r.lines.length - 1], "new-9");
    const empty = logDiag.readLogTail(path.join(dir, "no-such-dir"), 10);
    assert.strictEqual(empty.ok, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("collectUserNames：从配置挑称呼并去重", () => {
  const names = logDiag.collectUserNames({ name: "doctor", nickname: "doctor", userName: "" });
  assert.deepStrictEqual(names, ["doctor"]);
});
